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
const { sanitizeAlloc, deriveCombatStats, STAT_KEYS } = require('./charStats');

const POSES = ['walk', 'climb', 'attack', 'hurt'];
const PLAYER_MAX_HP = 60;
const MAX_SLOTS = 14; // EarthBound's Goods menu holds 14 items per character
const STARTING_MONEY = 1000; // every player joins with $1000
const EQUIP_SLOTS = ['weapon', 'body', 'arms', 'other'];
// Skill points granted per level-up (banked until spent on the pentagon) and the
// per-stat cap a spend can raise an allocation to. Both server-authoritative.
const POINTS_PER_LEVEL = 1;
const STAT_SPEND_MAX = 99;
// Crit (SMAAAASH!) chance as a percentage, derived from the attacker's Luck.
// Tunable in one place; ~1%/Luck so a fresh hero (Luck 9) crits ~9% of landed
// hits, capped so a maxed build can't crit on (nearly) every swing.
const CRIT_PER_LUCK = 1;
const CRIT_CHANCE_CAP = 50;
const critChanceFromLuck = (luck) =>
  Math.min(CRIT_CHANCE_CAP, Math.max(0, (luck | 0) * CRIT_PER_LUCK));
// Chance to dodge an incoming enemy swing, from the defender's Speed. ~0.5%/
// Speed (a fresh hero at Speed 8 dodges ~4% of hits), capped so no build is
// untouchable. npcSim rolls this against the enemy's swing (see resolveMelee).
const DODGE_PER_SPEED = 0.5;
const DODGE_CHANCE_CAP = 30;
const dodgeChanceFromSpeed = (speed) =>
  Math.min(DODGE_CHANCE_CAP, Math.max(0, (speed | 0) * DODGE_PER_SPEED));
// Max lifetime of the door-transition damage shield (see player.warping). A
// door fade + interior asset load is well under this; the cap only guards
// against a dropped 'warp' end signal leaving a player permanently invulnerable.
const WARP_SHIELD_MAX_MS = 8000;
// Move validation: a single non-warp position update bigger than this is a
// teleport / speed hack and gets clamped to this step. Matches npcSim's
// WARP_DELTA (the sim already treats bigger one-tick jumps as door warps), and
// honest walking is ~6px per send, far below it — so this never touches legit
// movement; door warps are exempt while the warp shield is up.
const MAX_MOVE_STEP = 96;
// Graceful disconnect: live clients send a move every ~3 frames (~50ms), so a
// player silent this long is a dead/zombie socket — close it (the close handler
// saves + cleans up). Generous, so only true zombies are reaped.
const IDLE_TIMEOUT_MS = 30000;
const HEARTBEAT_MS = 5000;

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
  level: 1,
  hp: PLAYER_MAX_HP,
  maxHp: PLAYER_MAX_HP,
  pp: 7,
  ppMax: 7,
  exp: 0,
  offense: 7,
  defense: 3,
  speed: 8,
  guts: 7,
  vitality: 6,
  iq: 9,
  luck: 9,
};
// Per-level stat gains (tunable). HP/maxHp, offense and defense are wired into
// combat today; speed/guts/vitality/iq/luck grow and show on the Status screen
// but aren't mechanically hooked up yet.
const GROWTH = {
  maxHp: 8,
  ppMax: 2,
  offense: 2,
  defense: 1,
  speed: 1,
  guts: 1,
  vitality: 1,
  iq: 1,
  luck: 1,
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

// Build a full progression block from a creation allocation. The 5 creation
// stats set the LEVEL-1 combat baseline (deriveCombatStats); per-level GROWTH is
// then replayed up to `level`, and `exp` is restored. Combat stats are always
// derived from `alloc` — never trusted from the client save — so a tampered save
// can't grant stats it didn't earn.
function progressionFromAlloc(alloc, level = 1, exp = 0) {
  const d = deriveCombatStats(alloc);
  const p = {
    level: 1,
    hp: d.maxHp,
    maxHp: d.maxHp,
    pp: d.ppMax,
    ppMax: d.ppMax,
    exp: 0,
    offense: d.offense,
    defense: d.defense,
    speed: d.speed,
    guts: d.guts,
    vitality: d.vitality,
    iq: d.iq,
    luck: d.luck,
  };
  while (p.level < level) levelUp(p); // replay growth (also tops up hp/pp)
  p.exp = exp;
  p.expToNext = expToReach(p.level + 1) - p.exp;
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
    level: p.level,
    hp: p.hp,
    hpMax: p.maxHp,
    pp: p.pp,
    ppMax: p.ppMax,
    exp: p.exp,
    expToNext: p.expToNext,
    offense: p.offense,
    defense: p.defense,
    speed: p.speed,
    guts: p.guts,
    vitality: p.vitality,
    iq: p.iq,
    luck: p.luck,
  };
}

class GameHost {
  /**
   * @param {string} assetsDir absolute path to public/assets
   * @param {object} [store] persistence Store (server/store/) for signed-in
   *   characters. Optional: without it (tests / anonymous dev), join falls back
   *   to a fresh ephemeral player and nothing is saved.
   */
  constructor(assetsDir, store = null) {
    this.players = new Map(); // id -> player record incl. _ws
    this.nextId = 1;
    this.store = store;
    // Persistence handles for signed-in characters: playerId -> {characterId,alloc}.
    // Held OUT of the player record so the DB id never rides along in a broadcast.
    this.saves = new Map();
    // Per-player quest/progress flags (PlayerFlags): playerId -> Set<number>.
    // Kept OUT of the player record too — flags are PRIVATE, never broadcast to
    // other clients. Persisted in the character save for signed-in players;
    // ephemeral (session-only) for anonymous dev/char-select joins.
    this.flags = new Map();

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
    // World pixel bounds for move validation (clamp players onto the map).
    this.WORLD = this.npcSim.bounds();

    // Idle-connection sweep handle (set in start()).
    this._heartbeat = null;
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
      () =>
        [...this.players.values()].map((p) => ({
          // editor players stay in the list as a sim ANCHOR (the world keeps
          // living around the parked avatar), but carry `editor` so npcSim skips
          // them for targeting/collision/damage — see npcSim aggroTarget/hitsPlayer.
          id: p.id,
          x: p.x,
          y: p.y,
          level: p.level,
          hp: p.hp,
          editor: !!p.editor,
          // Speed-derived chance to dodge a swing (enemy OR PvP; npcSim resolves it).
          dodge: dodgeChanceFromSpeed(p.speed),
          // PK flag, so npcSim's canHurt can gate PvP (and NPC aggro on PKers).
          pk: !!p.pk,
        })),
      (data) => this.broadcastAll(data),
      (playerId, dmg) => this.damagePlayer(playerId, dmg),
      (playerId, xp, _enemy, loot) => this.awardKill(playerId, xp, loot),
      // PvP: a player's swing landed on another player — apply it to the victim's
      // server-authoritative HP (same path as an enemy hit).
      (targetId, dmg) => this.damagePlayer(targetId, dmg)
    );
    // Graceful disconnects: reap dead/zombie sockets that stopped sending. A live
    // client sends a move every ~3 frames, so silence past IDLE_TIMEOUT_MS means
    // the connection is gone; close it so the close handler saves + cleans up.
    this._heartbeat = setInterval(() => this._reapIdle(), HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref(); // don't keep tests alive
  }

  // Close any connection silent longer than IDLE_TIMEOUT_MS. Closing triggers the
  // ws 'close' handler (save-back + roster cleanup + player_leave broadcast).
  _reapIdle() {
    const now = Date.now();
    for (const [, entry] of this.players) {
      if (now - (entry.lastSeen || 0) <= IDLE_TIMEOUT_MS) continue;
      try {
        if (entry._ws.terminate) entry._ws.terminate();
        else entry._ws.close();
      } catch {
        /* socket already gone */
      }
    }
  }

  /** Stop the heartbeat (tests / shutdown). */
  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
  }

  // Project an inventory (array of ids) to the wire shape the client renders:
  // [{ id, name }]. Unknown ids are dropped rather than sent nameless.
  inventoryView(inventory) {
    return inventory
      .filter((id) => this.GOODS[id])
      .map((id) => ({ id, name: this.GOODS[id].name }));
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
    entry.weaponOffense = we && we.slot === 'weapon' ? we.offense | 0 : 0;
    let def = 0;
    for (const s of ['body', 'arms', 'other']) {
      const id = entry.equipped[s];
      const e = id ? this.GOODS[id] && this.GOODS[id].equip : null;
      if (e && e.slot === s) def += e.defense | 0;
    }
    entry.armorDefense = def;
    entry.itemId = entry.equipped.weapon; // held sprite = weapon
  }

  // A PNG data-URL sheet, capped so a hostile client can't make every join
  // broadcast megabytes. Returns the string or null.
  _validAppearance(a) {
    return typeof a === 'string' && a.length <= 65536 ? a : null;
  }

  // Anonymous / dev join: a fresh ephemeral player from the join message. This
  // is the existing char-select path (and what the tests drive) — nothing is
  // persisted, every join starts at level 1.
  _anonInit(playerId, msg) {
    return {
      name: msg.name || `Player${playerId}`,
      spriteGroupId: msg.spriteGroupId || 1,
      appearance: this._validAppearance(msg.appearance),
      progression: newProgression(),
      inventory: [...this.STARTING_INVENTORY],
      money: STARTING_MONEY,
      equipped: { weapon: null, body: null, arms: null, other: null },
      x: this.SPAWN.x,
      y: this.SPAWN.y,
      direction: this.SPAWN.dir || 0,
      characterId: null,
      alloc: null,
      flags: [],
    };
  }

  // Signed-in join: validate the session, load the character it owns, and rebuild
  // its world state from the save. Returns null if the token/character is invalid
  // or not owned by the session's account. Combat stats are RE-DERIVED from the
  // saved alloc (never trusted as raw numbers); inventory/equip are re-validated
  // against the live catalog.
  _loadCharacterInit(token, characterId) {
    const session = this.store.getSession(token, Date.now());
    if (!session) return null;
    const character = this.store.getCharacter(Number(characterId));
    if (!character || character.accountId !== session.accountId) return null;

    const save = character.save && typeof character.save === 'object' ? character.save : {};
    const alloc = sanitizeAlloc(save.alloc);
    const level = Number.isInteger(save.level) && save.level >= 1 ? save.level : 1;
    const exp = Number.isInteger(save.exp) && save.exp >= 0 ? save.exp : 0;

    const inventory = Array.isArray(save.inventory)
      ? save.inventory.filter((id) => this.GOODS[id])
      : [...this.STARTING_INVENTORY];
    const money = Number.isInteger(save.money) ? save.money : STARTING_MONEY;

    const equipped = { weapon: null, body: null, arms: null, other: null };
    if (save.equipped && typeof save.equipped === 'object') {
      for (const s of ['weapon', 'body', 'arms', 'other']) {
        const id = save.equipped[s];
        const eq = id && this.GOODS[id] && this.GOODS[id].equip;
        if (eq && eq.slot === s && inventory.includes(id)) equipped[s] = id;
      }
    }

    return {
      name: character.name,
      spriteGroupId: character.spriteGroupId,
      appearance: this._validAppearance(character.appearance),
      progression: progressionFromAlloc(alloc, level, exp),
      inventory,
      money,
      equipped,
      x: Number.isFinite(save.x) ? save.x : this.SPAWN.x,
      y: Number.isFinite(save.y) ? save.y : this.SPAWN.y,
      direction: Number.isInteger(save.direction) ? save.direction : this.SPAWN.dir || 0,
      characterId: character.id,
      alloc,
      unspentPoints:
        Number.isInteger(save.unspentPoints) && save.unspentPoints >= 0 ? save.unspentPoints : 0,
      flags: Array.isArray(save.flags) ? save.flags.filter((n) => Number.isInteger(n)) : [],
    };
  }

  // Write a signed-in player's mutable state back to its character row. No-op for
  // anonymous players (no handle in this.saves) or when there's no store.
  _saveCharacter(playerId) {
    const handle = this.saves.get(playerId);
    const p = this.players.get(playerId);
    if (!handle || !p || !this.store) return;
    try {
      this.store.updateCharacterSave(
        handle.characterId,
        {
          alloc: handle.alloc,
          level: p.level,
          exp: p.exp,
          unspentPoints: handle.unspentPoints || 0,
          inventory: [...p.inventory],
          money: p.money,
          equipped: { ...p.equipped },
          x: p.x,
          y: p.y,
          direction: p.direction,
          flags: [...(this.flags.get(playerId) || [])],
        },
        Date.now()
      );
    } catch (e) {
      console.error('[save] failed for character', handle.characterId, e);
    }
  }

  // Send a message to a single player's socket (private state like skill points).
  sendTo(playerId, data) {
    const entry = this.players.get(playerId);
    if (entry && entry._ws.readyState === 1) entry._ws.send(JSON.stringify(data));
  }

  // Push a signed-in player their authoritative banked points + current alloc
  // (drives the level-up icon + the spend pentagon). Private to the owner.
  _sendPoints(playerId) {
    const handle = this.saves.get(playerId);
    if (!handle) return;
    this.sendTo(playerId, {
      type: 'points_update',
      points: handle.unspentPoints || 0,
      alloc: handle.alloc,
    });
  }

  // Recompute a player's combat stats from a (server-side) allocation after a
  // spend, keeping their current level/exp and clamping live HP/PP to the new
  // caps (so spending a point doesn't full-heal). Authoritative.
  reapplyAlloc(p, alloc) {
    const block = progressionFromAlloc(alloc, p.level, p.exp);
    const hp = Math.min(p.hp, block.maxHp);
    const pp = Math.min(p.pp, block.ppMax);
    Object.assign(p, block);
    p.hp = hp;
    p.pp = pp;
    this.recomputeEquipStats(p);
  }

  // Apply an enemy's landed hit to a player (server-authoritative HP). Broadcast
  // the new HP so every client updates that player's bar; the victim's own
  // client plays the hurt pose. At 0 HP the player respawns at the spawn point.
  damagePlayer(playerId, dmg) {
    const p = this.players.get(playerId);
    if (!p || p.hp <= 0) return;
    if (p.editor) return; // out of the world in the dev editor — untargetable
    // Shielded mid door-transition: the player is a frozen ghost at the doorway
    // and can't move or defend, so enemy swings whiff (see player.warping).
    if (p.warping && Date.now() < p.warpUntil) return;
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
    const fromLevel = p.level;
    while (p.exp >= expToReach(p.level + 1)) {
      levelUp(p);
      leveled = true;
    }
    p.expToNext = expToReach(p.level + 1) - p.exp;
    this.broadcastAll({
      type: 'player_stats',
      id: playerId,
      stats: statsPayload(p),
      leveled,
      gained: xp,
    });
    if (leveled) {
      this.broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
      // Grant skill points for each level gained (signed-in only) and push the
      // new banked total to the owner — they alone decide where to spend it.
      const handle = this.saves.get(playerId);
      if (handle) {
        handle.unspentPoints =
          (handle.unspentPoints || 0) + POINTS_PER_LEVEL * (p.level - fromLevel);
        this._sendPoints(playerId);
      }
    }
    this._saveCharacter(playerId); // persist new exp/level/points (signed-in only)
  }

  // A player killed an enemy: award EXP, plus the ROM loot npcSim already rolled
  // (money always; the item only if it's a known good and the bag has room — drops
  // of items outside the goods registry are skipped until they're catalogued).
  awardKill(playerId, xp, loot) {
    this.awardXp(playerId, xp); // also persists; broadcasts player_stats
    const p = this.players.get(playerId);
    if (!p || !loot) return;
    let changed = false;
    if (loot.money > 0) {
      p.money += loot.money;
      p._ws.send(JSON.stringify({ type: 'money', money: p.money }));
      changed = true;
    }
    if (loot.item && loot.item.item != null) {
      const itemId = String(loot.item.item);
      if (this.GOODS[itemId] && p.inventory.length < MAX_SLOTS) {
        p.inventory.push(itemId);
        p._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(p.inventory) }));
        // Notify so the client can surface "Found <item>!" (unknown types ignored).
        p._ws.send(
          JSON.stringify({ type: 'loot', item: itemId, name: this.GOODS[itemId].name || '' })
        );
        changed = true;
      }
    }
    if (changed) this._saveCharacter(playerId);
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
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // Mark the connection alive for the idle-disconnect sweep (any message).
      const entry = this.players.get(playerId);
      if (entry) entry.lastSeen = Date.now();
      this._handleMessage(playerId, ws, msg);
    });

    ws.on('close', () => {
      console.log(`Player ${playerId} disconnected`);
      this._saveCharacter(playerId); // persist final state (signed-in only)
      this.saves.delete(playerId);
      this.flags.delete(playerId);
      this.players.delete(playerId);
      this.broadcastAll({ type: 'player_leave', id: playerId });
    });
  }

  _handleMessage(playerId, ws, msg) {
    const { GOODS } = this;
    switch (msg.type) {
      case 'join': {
        // Two paths: a signed-in character (sessionToken + characterId, loaded
        // from the store and saved back), or an anonymous ephemeral player (the
        // dev char-select flow + tests). An invalid auth attempt errors cleanly
        // rather than silently falling back to a fresh player.
        let init;
        if (this.store && msg.sessionToken && msg.characterId != null) {
          init = this._loadCharacterInit(msg.sessionToken, msg.characterId);
          if (!init) {
            ws.send(JSON.stringify({ type: 'join_error', error: 'invalid session or character' }));
            break;
          }
        } else {
          init = this._anonInit(playerId, msg);
        }

        const playerData = {
          id: playerId,
          name: init.name,
          spriteGroupId: init.spriteGroupId,
          appearance: init.appearance,
          x: init.x,
          y: init.y,
          direction: init.direction,
          frame: 0,
          pose: 'walk',
          itemId: null, // set by recomputeEquipStats (held = equipped weapon)
          // EarthBound equip slots (loaded from the save or empty). Server-
          // authoritative; offense/defense from these apply to combat.
          equipped: init.equipped,
          weaponOffense: 0,
          armorDefense: 0,
          inventory: init.inventory, // Goods slots, mutated by use/buy/sell
          money: init.money,
          // PK (player-kill) flag — see npcSim canHurt. All players start non-PK.
          pk: false,
          // Door-transition shield (see 'warp'): whiffs enemy swings on the
          // frozen ghost left at a doorway mid-fade.
          warping: false,
          warpUntil: 0,
          // Dev editor anchor flag (see 'editor').
          editor: false,
          // Last-message timestamp for the idle-disconnect sweep (_reapIdle).
          lastSeen: Date.now(),
          // Server-authoritative progression: fresh (anon) or rebuilt from the
          // saved alloc + level (signed-in).
          ...init.progression,
        };
        this.players.set(playerId, { ...playerData, _ws: ws });
        const entry = this.players.get(playerId);
        this.recomputeEquipStats(entry); // apply loaded gear + set held sprite

        // Quest flags: restore the saved set (empty for anonymous joins). Kept
        // private to this player — never broadcast.
        this.flags.set(playerId, new Set(init.flags));

        // Remember the persistence handle (signed-in only) for save-back +
        // skill-point banking.
        if (init.characterId != null) {
          this.saves.set(playerId, {
            characterId: init.characterId,
            alloc: init.alloc,
            unspentPoints: init.unspentPoints || 0,
          });
        }

        // The new player gets their id, the current roster, and their own state.
        const otherPlayers = [];
        for (const [id, p] of this.players) {
          if (id !== playerId) {
            const { _ws, ...data } = p;
            otherPlayers.push(data);
          }
        }
        ws.send(
          JSON.stringify({
            type: 'welcome',
            playerId,
            players: otherPlayers,
            npcs: this.npcSim.snapshot(),
            npcHps: this.npcSim.hpSnapshot(),
            inventory: this.inventoryView(entry.inventory), // own Goods
            money: entry.money, // own balance
            // Signed-in characters restore their saved spawn + stats + gear; the
            // anonymous client ignores these (it spawns from its own spawn.json).
            self: { x: entry.x, y: entry.y, direction: entry.direction },
            stats: statsPayload(entry),
            equipped: entry.equipped,
            // Saved quest/progress flags (PlayerFlags) — private to this player.
            flags: [...this.flags.get(playerId)],
          })
        );

        // Tell everyone else about the new player.
        const { _ws, ...publicData } = this.players.get(playerId);
        this.broadcastExcept({ type: 'player_join', player: publicData }, playerId);
        // Restore any banked skill points (shows the level-up icon on rejoin).
        this._sendPoints(playerId);
        break;
      }

      case 'warp': {
        // Client entered (warping:true) or finished (false) a door transition.
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.warping = !!msg.warping;
        entry.warpUntil = entry.warping ? Date.now() + WARP_SHIELD_MAX_MS : 0;
        break;
      }

      case 'editor': {
        // Dev editor opened (on:true) / closed (false). While on, this player is
        // pulled from the NPC sim so its parked avatar can't be aggroed, hit, or
        // killed (which would respawn-yank the admin's free camera).
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.editor = !!msg.on;
        // Leaving the editor: the avatar may have been teleported far while
        // parked, so exempt the rejoin jump from enemy door-warp follow (else
        // chasers teleport along with the admin).
        if (!entry.editor) this.npcSim.noteEditorExit(playerId);
        break;
      }

      case 'move': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // --- Server-side validation (anti-cheat; lenient so honest play is never
        // affected). Drop garbage, clamp into the map, cap implausible jumps. ---
        let nx = Number(msg.x);
        let ny = Number(msg.y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
        nx = Math.max(0, Math.min(this.WORLD.w, nx));
        ny = Math.max(0, Math.min(this.WORLD.h, ny));
        // Read the warp shield BEFORE clearing it: a real door warp is exactly
        // the big jump we'd otherwise clamp as a speed hack.
        const warping = entry.warping && Date.now() < entry.warpUntil;
        if (!warping) {
          const dx = nx - entry.x;
          const dy = ny - entry.y;
          const dist = Math.hypot(dx, dy);
          if (dist > MAX_MOVE_STEP) {
            const s = MAX_MOVE_STEP / dist; // clamp the step toward the request
            nx = Math.round(entry.x + dx * s);
            ny = Math.round(entry.y + dy * s);
          }
        }
        // A move means the client is live again — the fade is over, drop the
        // shield (fallback in case the 'warp' end signal was missed).
        entry.warping = false;
        const direction =
          Number.isInteger(msg.direction) && msg.direction >= 0 && msg.direction <= 7
            ? msg.direction
            : entry.direction;
        const frame = Number.isInteger(msg.frame) && msg.frame >= 0 ? msg.frame : 0;
        entry.x = nx;
        entry.y = ny;
        entry.direction = direction;
        entry.frame = frame;
        entry.pose = POSES.includes(msg.pose) ? msg.pose : 'walk';
        this.broadcastExcept(
          { type: 'player_move', id: playerId, x: nx, y: ny, direction, frame, pose: entry.pose },
          playerId
        );
        break;
      }

      case 'attack': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // Server-authoritative: resolve from the tracked position so reach can't
        // be spoofed. Damage scales with the player's Offense stat + weapon; crit
        // chance comes from Luck (SMAAAASH! → 2× damage, broadcast to all).
        this.npcSim.handleAttack(
          entry.x,
          entry.y,
          msg.dir | 0,
          playerId,
          entry.offense + (entry.weaponOffense || 0),
          entry.pk,
          critChanceFromLuck(entry.luck)
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
        this._saveCharacter(playerId);
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
            type: 'player_hp',
            id: playerId,
            hp: entry.hp,
            maxHp: entry.maxHp,
            dmg: 0,
            heal: healed,
          });
        }

        entry.inventory.splice(slot, 1);
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        this._saveCharacter(playerId);
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
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        this._saveCharacter(playerId);
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
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        this._saveCharacter(playerId);
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
            type: 'player_hp',
            id: playerId,
            hp: entry.hp,
            maxHp: entry.maxHp,
            dmg: 0,
            heal: healed,
          });
        }
        // PP changed — push updated stats so the caster's PSI bar redraws.
        this.broadcastAll({
          type: 'player_stats',
          id: playerId,
          stats: statsPayload(entry),
          leveled: false,
          gained: 0,
        });
        break;
      }

      case 'chat': {
        if (!this.players.has(playerId)) break;
        const text = String(msg.text || '')
          .slice(0, 100)
          .trim();
        if (!text) break;
        // Broadcast to everyone else; the sender shows its own bubble locally.
        this.broadcastExcept({ type: 'chat', id: playerId, text }, playerId);
        break;
      }

      case 'set_pk': {
        // A player flips their own PK (player-kill) flag. Runtime-only (never
        // persisted, so everyone rejoins non-PK — see all-non-PK-until-shipped).
        // Broadcast so every client can render the PK marker; npcSim reads it
        // live through the getPlayers snapshot for PvP + NPC aggro gating.
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.pk = !!msg.on;
        this.broadcastAll({ type: 'player_pk', id: playerId, pk: entry.pk });
        break;
      }

      case 'set_flag':
      case 'clear_flag': {
        // Persist a per-player quest flag change. Flags are PRIVATE (not
        // broadcast) and the server owns the stored copy in the character save.
        // NOTE: trigger validation (proving the player earned the flag) is a
        // later anti-cheat step — today the request is trusted and just stored.
        const set = this.flags.get(playerId);
        if (!set || !Number.isInteger(msg.id)) break;
        const changed = msg.type === 'set_flag' ? !set.has(msg.id) : set.has(msg.id);
        if (!changed) break;
        if (msg.type === 'set_flag') set.add(msg.id);
        else set.delete(msg.id);
        this._saveCharacter(playerId); // signed-in only; anon stays ephemeral
        break;
      }

      case 'clear_all_flags': {
        // Dev Flag Editor "reset progress": wipe this character's flags.
        const set = this.flags.get(playerId);
        if (!set || set.size === 0) break;
        set.clear();
        this._saveCharacter(playerId);
        break;
      }

      case 'spend_points': {
        // Spend banked skill points on the 5 creation stats. SERVER-AUTHORITATIVE:
        // the client only REQUESTS deltas; the server owns the point counter, the
        // alloc, and the derived stats. A request that asks for more than is banked,
        // for an unknown stat, for a negative/fractional amount, or that would blow
        // the cap is rejected wholesale — the client can't grant itself anything.
        const handle = this.saves.get(playerId); // signed-in only
        const entry = this.players.get(playerId);
        if (!handle || !entry) break;
        const add = msg.add && typeof msg.add === 'object' ? msg.add : null;
        if (!add) break;
        if (Object.keys(add).some((k) => !STAT_KEYS.includes(k))) break; // unknown stat
        let total = 0;
        let ok = true;
        for (const k of STAT_KEYS) {
          const v = add[k] ?? 0;
          if (!Number.isInteger(v) || v < 0) {
            ok = false;
            break;
          }
          if ((handle.alloc[k] || 0) + v > STAT_SPEND_MAX) {
            ok = false;
            break;
          }
          total += v;
        }
        if (!ok || total <= 0 || total > (handle.unspentPoints || 0)) break;

        // Apply on the server side, then re-derive + persist.
        for (const k of STAT_KEYS) handle.alloc[k] = (handle.alloc[k] || 0) + (add[k] || 0);
        handle.unspentPoints -= total;
        this.reapplyAlloc(entry, handle.alloc);
        this.broadcastAll({
          type: 'player_stats',
          id: playerId,
          stats: statsPayload(entry),
          leveled: false,
          gained: 0,
        });
        // maxHp may have grown — refresh every client's bar for this player.
        this.broadcastAll({
          type: 'player_hp',
          id: playerId,
          hp: entry.hp,
          maxHp: entry.maxHp,
          dmg: 0,
        });
        this._sendPoints(playerId); // echo the authoritative remaining points + alloc
        this._saveCharacter(playerId);
        break;
      }
    }
  }
}

module.exports = { GameHost };
