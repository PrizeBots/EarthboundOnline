/**
 * GameHost — the single source of truth for multiplayer host logic.
 *
 * Both the standalone deploy server (server/index.js) and the Vite-embedded dev
 * server (vite.config.ts) used to carry their own copy of this switch, and the
 * two had already DRIFTED apart (the standalone server was missing progression,
 * PSI, and the awardXp wiring). This class is the de-duplicated host: each
 * transport just constructs a GameHost, calls start(), and hands every new
 * socket to handleConnection(ws). The socket only has to look like a `ws`
 * WebSocket — `.send(str)`, `.readyState`, `.on('message')`, `.on('close')` —
 * which is true for both the standalone `WebSocketServer({ server })` and the
 * Vite `noServer` upgrade path.
 *
 * Server-authoritative by construction: the client only ever ASKS (use/buy/sell/
 * equip/attack), and every effect is validated here against GOODS/STORES and the
 * player's tracked state, so a client can't grant itself HP, money, or reach.
 */
const fs = require('fs');
const path = require('path');
const { createNpcSim } = require('./npcSim');
const { loadShops } = require('./shops');

const POSES = ['walk', 'climb', 'attack', 'hurt'];
const PLAYER_MAX_HP = 60;
const MAX_SLOTS = 14; // EarthBound's Goods menu holds 14 items per character
const STARTING_MONEY = 1000; // every player joins with $1000
const EQUIP_SLOTS = ['weapon', 'body', 'arms', 'other'];

// PSI abilities (server-authoritative). `pp` is the cost; `heal` restores HP.
// Lifeup α heal amount is a placeholder — set it to the exact EarthBound value
// when confirmed.
const PSI = {
  lifeup: { name: 'Lifeup α', pp: 3, heal: 30 },
};

// --- Player progression (server-authoritative; full stat growth) ---
// Level-1 baseline mirrors StatusModal's defaults so the client's display
// matches before the first server stats arrive. No persistence yet, so every
// join starts at level 1 (a save system is a separate TODO).
const BASE_STATS = {
  level: 1, hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, pp: 7, ppMax: 7, exp: 0,
  offense: 7, defense: 3, speed: 8, guts: 7, vitality: 6, iq: 9, luck: 9,
};
// Per-level stat gains (tunable). HP/maxHp, offense and defense are wired into
// combat today; speed/guts/vitality/iq/luck grow and show on the Status screen
// but aren't mechanically hooked up yet.
const GROWTH = {
  maxHp: 8, ppMax: 2, offense: 2, defense: 1, speed: 1, guts: 1, vitality: 1, iq: 1, luck: 1,
};
// EXP to go from `level` to `level+1` (geometric ramp: 30, 45, 67, 101, …).
const expCost = (level) => Math.floor(30 * Math.pow(1.5, level - 1));
// Total EXP needed to REACH `level` from level 1.
const expToReach = (level) => {
  let s = 0;
  for (let i = 1; i < level; i++) s += expCost(i);
  return s;
};

function newProgression() {
  const p = { ...BASE_STATS };
  p.expToNext = expCost(1); // EXP remaining to next level (display)
  return p;
}

function levelUp(p) {
  p.level++;
  for (const k of Object.keys(GROWTH)) p[k] += GROWTH[k];
  p.hp = p.maxHp; // a level-up fully heals
  p.pp = p.ppMax;
}

// StatusModal-shaped payload (field names match PlayerStats: hpMax/ppMax).
function statsPayload(p) {
  return {
    level: p.level, hp: p.hp, hpMax: p.maxHp, pp: p.pp, ppMax: p.ppMax,
    exp: p.exp, expToNext: p.expToNext,
    offense: p.offense, defense: p.defense, speed: p.speed, guts: p.guts,
    vitality: p.vitality, iq: p.iq, luck: p.luck,
  };
}

class GameHost {
  /** @param {string} assetsDir absolute path to public/assets */
  constructor(assetsDir) {
    this.players = new Map(); // id -> player record incl. _ws
    this.nextId = 1;

    // Server-authoritative goods registry + shop catalog (shared loader in
    // server/shops.js). Each player's inventory is an array of numeric-string
    // item ids (EarthBound-style slots); effects/transactions resolve here.
    const { goods, storeHas, startingInventory } = loadShops(assetsDir);
    this.GOODS = goods;
    this.storeHas = storeHas;
    this.STARTING_INVENTORY = startingInventory;

    // Spawn point: editor override (public/overrides/spawn.json) wins over the
    // src/spawn.json default the client also uses. Read once at startup.
    const root = path.resolve(assetsDir, '..', '..');
    this.SPAWN = GameHost._readSpawn(root);

    // Server-authoritative NPC simulation: same world for every client.
    this.npcSim = createNpcSim(assetsDir);
  }

  static _readSpawn(root) {
    for (const rel of ['public/overrides/spawn.json', 'src/spawn.json']) {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
      } catch {
        /* try next */
      }
    }
    return { x: 1296, y: 1168, dir: 0 };
  }

  /** Start the NPC simulation. Call once after construction. */
  start() {
    this.npcSim.start(
      () => [...this.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, level: p.level, hp: p.hp })),
      (data) => this.broadcastAll(data),
      (playerId, dmg) => this.damagePlayer(playerId, dmg),
      (playerId, xp) => this.awardXp(playerId, xp)
    );
  }

  // Project an inventory (array of ids) to the wire shape the client renders:
  // [{ id, name }]. Unknown ids are dropped rather than sent nameless.
  inventoryView(inventory) {
    return inventory.filter((id) => this.GOODS[id]).map((id) => ({ id, name: this.GOODS[id].name }));
  }

  broadcastAll(data) {
    const msg = JSON.stringify(data);
    for (const [, entry] of this.players) {
      if (entry._ws.readyState === 1) entry._ws.send(msg);
    }
  }

  // Broadcast to everyone except one player (their own client handles it locally).
  broadcastExcept(data, exceptId) {
    const msg = JSON.stringify(data);
    for (const [id, entry] of this.players) {
      if (id !== exceptId && entry._ws.readyState === 1) entry._ws.send(msg);
    }
  }

  // Recompute the combat bonuses from a player's equipped gear: weapon offense
  // (added to attack damage) and total armor defense (subtracted from hits). The
  // held-item sprite is always the equipped weapon.
  recomputeEquipStats(entry) {
    const w = entry.equipped.weapon;
    const we = w ? this.GOODS[w] && this.GOODS[w].equip : null;
    entry.weaponOffense = we && we.slot === 'weapon' ? (we.offense | 0) : 0;
    let def = 0;
    for (const s of ['body', 'arms', 'other']) {
      const id = entry.equipped[s];
      const e = id ? this.GOODS[id] && this.GOODS[id].equip : null;
      if (e && e.slot === s) def += (e.defense | 0);
    }
    entry.armorDefense = def;
    entry.itemId = entry.equipped.weapon; // held sprite = weapon
  }

  // Apply an enemy's landed hit to a player (server-authoritative HP). Broadcast
  // the new HP so every client updates that player's bar; the victim's own
  // client plays the hurt pose. At 0 HP the player respawns at the spawn point.
  damagePlayer(playerId, dmg) {
    const p = this.players.get(playerId);
    if (!p || p.hp <= 0) return;
    // Defense softens incoming hits (stat defense + equipped armor); always at
    // least 1 so leveling/gear never makes a player untouchable.
    const eff = Math.max(1, dmg - Math.floor(((p.defense || 0) + (p.armorDefense || 0)) / 2));
    p.hp = Math.max(0, p.hp - eff);
    this.broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: eff });
    if (p.hp <= 0) {
      p.hp = p.maxHp;
      p.x = this.SPAWN.x;
      p.y = this.SPAWN.y;
      p.direction = this.SPAWN.dir || 0;
      p.frame = 0;
      p.pose = 'walk';
      this.npcSim.noteRespawn(playerId); // exempt this teleport from enemy door-warp follow
      this.broadcastAll({ type: 'player_respawn', id: playerId, x: p.x, y: p.y, dir: p.direction });
      this.broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
    }
  }

  // Award a kill's EXP, apply any level-ups, then push the new stats to that
  // player's client (server is authoritative). A level-up heals, so re-broadcast HP.
  awardXp(playerId, xp) {
    const p = this.players.get(playerId);
    if (!p || xp <= 0) return;
    p.exp += xp;
    let leveled = false;
    while (p.exp >= expToReach(p.level + 1)) { levelUp(p); leveled = true; }
    p.expToNext = expToReach(p.level + 1) - p.exp;
    this.broadcastAll({ type: 'player_stats', id: playerId, stats: statsPayload(p), leveled, gained: xp });
    if (leveled) this.broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
  }

  /**
   * Wire up a freshly connected socket. The socket must look like a `ws`
   * WebSocket (.send/.readyState/.on). Owns the player's lifecycle: assigns an
   * id, handles every message, and removes the player on close.
   */
  handleConnection(ws) {
    const playerId = String(this.nextId++);
    console.log(`Player ${playerId} connected`);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this._handleMessage(playerId, ws, msg);
    });

    ws.on('close', () => {
      console.log(`Player ${playerId} disconnected`);
      this.players.delete(playerId);
      this.broadcastAll({ type: 'player_leave', id: playerId });
    });
  }

  _handleMessage(playerId, ws, msg) {
    const { GOODS } = this;
    switch (msg.type) {
      case 'join': {
        const playerData = {
          id: playerId,
          name: msg.name || `Player${playerId}`,
          spriteGroupId: msg.spriteGroupId || 1,
          // Pixel-edited sheet as a PNG data URL (~1-3KB); cap so a hostile
          // client can't make every join broadcast megabytes.
          appearance:
            typeof msg.appearance === 'string' && msg.appearance.length <= 65536
              ? msg.appearance
              : null,
          x: this.SPAWN.x, y: this.SPAWN.y,
          direction: this.SPAWN.dir || 0, frame: 0,
          pose: 'walk',
          itemId: null, // held item (equipped weapon's sprite), set by 'equip'
          // EarthBound equip slots. Server-authoritative; offense/defense from
          // these apply to combat (see recomputeEquipStats).
          equipped: { weapon: null, body: null, arms: null, other: null },
          weaponOffense: 0, // offense from the equipped weapon
          armorDefense: 0,  // total defense from equipped body/arms/other
          inventory: [...this.STARTING_INVENTORY], // Goods slots, mutated by 'use_item'
          money: STARTING_MONEY, // starting cash, shown in the menu
          // PK (player-kill) flag — see npcSim canHurt. All players start
          // non-PK; a per-player toggle is backlogged (TODO). A PK player can
          // hurt anyone; anyone can hurt a PK player.
          pk: false,
          // Full server-authoritative progression (level/hp/exp/stats).
          ...newProgression(),
        };
        this.players.set(playerId, { ...playerData, _ws: ws });

        // The new player gets their id, the current roster, and their own state.
        const otherPlayers = [];
        for (const [id, p] of this.players) {
          if (id !== playerId) {
            const { _ws, ...data } = p;
            otherPlayers.push(data);
          }
        }
        ws.send(JSON.stringify({
          type: 'welcome',
          playerId,
          players: otherPlayers,
          npcs: this.npcSim.snapshot(),
          npcHps: this.npcSim.hpSnapshot(),
          inventory: this.inventoryView(playerData.inventory), // own Goods
          money: playerData.money,                             // own balance
        }));

        // Tell everyone else about the new player.
        const { _ws, ...publicData } = this.players.get(playerId);
        this.broadcastExcept({ type: 'player_join', player: publicData }, playerId);
        break;
      }

      case 'move': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.x = msg.x;
        entry.y = msg.y;
        entry.direction = msg.direction;
        entry.frame = msg.frame;
        entry.pose = POSES.includes(msg.pose) ? msg.pose : 'walk';
        this.broadcastExcept({
          type: 'player_move', id: playerId,
          x: msg.x, y: msg.y, direction: msg.direction, frame: msg.frame, pose: entry.pose,
        }, playerId);
        break;
      }

      case 'attack': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // Server-authoritative: resolve from the tracked position so reach can't
        // be spoofed. Damage scales with the player's Offense stat + weapon.
        this.npcSim.handleAttack(
          entry.x, entry.y, msg.dir | 0, playerId,
          entry.offense + (entry.weaponOffense || 0), entry.pk
        );
        break;
      }

      case 'equip': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // Per-slot equip: { slot, itemId|null }. Authoritative — equipping
        // requires owning the item and it fitting that slot (no spoofing); null
        // unequips. Offense/defense recompute from the whole set.
        const slot = typeof msg.slot === 'string' ? msg.slot : null;
        const itemId =
          typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
        if (!slot || !EQUIP_SLOTS.includes(slot)) break;
        if (itemId !== null) {
          const eq = GOODS[itemId] && GOODS[itemId].equip;
          if (!eq || eq.slot !== slot || !entry.inventory.includes(itemId)) break;
        }
        entry.equipped[slot] = itemId;
        this.recomputeEquipStats(entry);
        // The owner gets their authoritative equipped set...
        entry._ws.send(JSON.stringify({ type: 'equipped', slots: entry.equipped }));
        // ...everyone else just needs the held-weapon sprite.
        this.broadcastExcept({ type: 'equip', id: playerId, itemId: entry.itemId }, playerId);
        break;
      }

      case 'use_item': {
        const entry = this.players.get(playerId);
        if (!entry || entry.hp <= 0) break;
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
        const def = itemId ? GOODS[itemId] : null;
        const slot = entry.inventory.indexOf(itemId);
        // Must actually own a slot of a known item to consume it.
        if (!def || slot === -1) break;
        // Equippable gear is NOT a consumable — "using" a weapon/armor must
        // never destroy it. It's equipped via the 'equip' path instead.
        if (def.equip) break;

        // Cookie (and any future `heal` good) restores HP up to the cap;
        // broadcast so every client redraws the bar, tagging `heal` so the
        // owner's client pops a green number.
        if (def.heal) {
          const healed = Math.min(entry.maxHp, entry.hp + def.heal) - entry.hp;
          entry.hp += healed;
          this.broadcastAll({
            type: 'player_hp', id: playerId,
            hp: entry.hp, maxHp: entry.maxHp, dmg: 0, heal: healed,
          });
        }

        entry.inventory.splice(slot, 1);
        entry._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) }));
        break;
      }

      case 'buy': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const store = msg.store | 0;
        const itemId = String(msg.item);
        const def = GOODS[itemId];
        // Real item, stocked by that store, affordable, room in the bag. Price is
        // the catalog's, never the client's.
        if (!def || !this.storeHas(store, itemId)) break;
        if (entry.inventory.length >= MAX_SLOTS) break;
        if (entry.money < def.cost) break;
        entry.money -= def.cost;
        entry.inventory.push(itemId);
        entry._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) }));
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        break;
      }

      case 'sell': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const itemId = String(msg.item);
        const def = GOODS[itemId];
        const slot = entry.inventory.indexOf(itemId);
        if (!def || slot === -1) break; // must own a slot of a known item
        entry.inventory.splice(slot, 1);
        entry.money += Math.floor(def.cost / 2); // EB buys back at half price
        entry._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) }));
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        break;
      }

      case 'use_psi': {
        const entry = this.players.get(playerId);
        if (!entry || entry.hp <= 0) break;
        const psiId = typeof msg.psiId === 'string' ? msg.psiId : null;
        const def = psiId ? PSI[psiId] : null;
        if (!def || entry.pp < def.pp) break; // unknown ability or not enough PP
        entry.pp -= def.pp;
        if (def.heal) {
          const healed = Math.min(entry.maxHp, entry.hp + def.heal) - entry.hp;
          entry.hp += healed;
          this.broadcastAll({
            type: 'player_hp', id: playerId,
            hp: entry.hp, maxHp: entry.maxHp, dmg: 0, heal: healed,
          });
        }
        // PP changed — push updated stats so the caster's PSI bar redraws.
        this.broadcastAll({
          type: 'player_stats', id: playerId,
          stats: statsPayload(entry), leveled: false, gained: 0,
        });
        break;
      }

      case 'chat': {
        if (!this.players.has(playerId)) break;
        const text = String(msg.text || '').slice(0, 100).trim();
        if (!text) break;
        // Broadcast to everyone else; the sender shows its own bubble locally.
        this.broadcastExcept({ type: 'chat', id: playerId, text }, playerId);
        break;
      }
    }
  }
}

module.exports = { GameHost };
