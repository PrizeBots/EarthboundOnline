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
const { sanitizeAlloc, deriveCombatStats, STAT_KEYS, defaultAlloc } = require('./charStats');
const status = require('./status'); // EB status-condition engine (shared with npcSim)
const buffs = require('./buffs'); // temporary timed stat boosts (consumables / future PSI)

const POSES = ['walk', 'climb', 'attack', 'hurt'];
const MAX_SLOTS = 14; // EarthBound's Goods menu holds 14 items per character
// Present boxes: each ROM gift's Event Flag maps to a PRIVATE per-player flag at
// this base, so every player can open each gift exactly once. KEEP IN SYNC with
// src/engine/Gifts.ts GIFT_FLAG_BASE.
const GIFT_FLAG_BASE = 910000;
// Ness's mom (sprite 145) cooks the player's favorite food on request: heals a
// fixed amount, then won't cook again until the wall-clock cooldown elapses. The
// ready-at timestamp persists in the save, so relogging can't reset the timer.
const MOM_FOOD_HEAL = 50; // HP restored per home-cooked meal
const MOM_FOOD_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between meals
// Quick-select hotbar: 6 slots (keys 1-6), each holding a weapon, a usable item,
// or a PSI move tagged 'psi:<id>'. Persisted per character so an assigned PSI
// (which, unlike a weapon, can't be re-derived from the equip set) survives a
// relog. KEEP IN SYNC with the client (menu/layout HOTBAR_SLOTS + PSI_TAG). An
// old save's shorter array is padded with nulls on load (sanitize fixes length).
const HOTBAR_SLOTS = 6;
const HOTBAR_PSI_TAG = 'psi:';
const BAG_FULL_NOTICE_MS = 2500; // min gap between "bag full" popups (anti-spam)
const STARTING_MONEY = 1000; // every player joins with $1000
const DEATH_CASH_PCT = 0.5; // fraction of ON-HAND cash dropped on death (bank is safe)
// KO/downed window: HP→0 lays the player out for this long instead of dying. During
// it, allies can revive them; the cash-drop penalty is DEFERRED to true death, so a
// revived player loses nothing. Elapsing it (or "giving up the ghost") = true death.
const DOWNED_MS = 30000;
// How close (px) an ally must be to a downed friend to revive them (item or PSI).
const REVIVE_RANGE = 44;
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
// How often the host ticks player status conditions (DoT + expiry). 4Hz — fine
// for ~1s damage-over-time cadence and snappy enough for status wear-off.
const STATUS_TICK_MS = 250;
// Accuracy penalties from status: a Crying attacker whiffs this often, a
// Nauseous one fumbles this often (rolled per swing; either ends the swing).
const CRY_MISS_CHANCE = 0.4;
const FUMBLE_CHANCE = 0.3;
// PK enable-lock: once a player turns PK on they're committed for this much
// IN-GAME (connected) time before they can turn it off. Stored as remaining ms
// (pkLockMs) that only counts down while the player is online — the lock PAUSES
// when they're offline, so logging out can't wait it out, and relogging can't
// escape it (pkLockMs is persisted).
const PK_LOCK_MS = 5 * 60 * 1000;

// PSI abilities (server-authoritative). `pp` = cost; `heal` restores the caster's
// HP; `damage` strikes the nearest enemy within `range` px (offense PSI); `anim`
// is the PsiAnim catalog id whose authored frames play on cast. Heal/damage
// amounts are placeholders pending the canon effect values.
const PSI = {
  // heal / cure (self)
  lifeup: { name: 'Lifeup α', pp: 3, heal: 30, anim: 'lifeup_alpha' },
  healing: { name: 'Healing α', pp: 4, cures: true, anim: 'healing_alpha' }, // clears the caster's statuses
  // offense (strikes the nearest enemy)
  // multi: ROM target "row"/"all" — the bolt penetrates and hits EVERY enemy in range.
  fire: { name: 'PSI Fire α', pp: 5, damage: 14, range: 240, anim: 'psi_fire_alpha', multi: true },
  // ailment (status on the nearest enemy; chances are element-scaled by its resist)
  hypnosis: {
    name: 'Hypnosis α',
    pp: 4,
    range: 240,
    anim: 'hypnosis_alpha',
    inflict: [{ type: 'sleep', chance: 90 }],
  },
  paralysis: {
    name: 'Paralysis α',
    pp: 5,
    range: 240,
    anim: 'paralysis_alpha',
    inflict: [{ type: 'paralysis', chance: 90 }],
  },
  brainshock: {
    name: 'Brainshock α',
    pp: 6,
    range: 240,
    anim: 'brainshock_alpha',
    inflict: [
      { type: 'strange', chance: 80 },
      { type: 'noPsi', chance: 80 },
    ],
  },
  // more offense families (strike the nearest enemy)
  freeze: { name: 'PSI Freeze α', pp: 4, damage: 12, range: 240, anim: 'psi_freeze_alpha' },
  thunder: {
    name: 'PSI Thunder α',
    pp: 3,
    damage: 16,
    range: 280,
    anim: 'psi_thunder_alpha',
    multi: true,
  },
  flash: {
    name: 'PSI Flash α',
    pp: 8,
    damage: 10,
    range: 240,
    anim: 'psi_flash_alpha',
    inflict: [{ type: 'paralysis', chance: 40 }], // Flash's signature random-ish stun
    multi: true,
  },
  starstorm: {
    name: 'PSI Starstorm α',
    pp: 24,
    damage: 30,
    range: 340,
    anim: 'psi_starstorm_alpha',
    multi: true,
  },
  rockin: { name: 'PSI Rockin α', pp: 6, damage: 18, range: 240, anim: 'psi_alpha', multi: true },
  // assist / utility — DEV: castable for testing; effects (buffs/teleport/magnet)
  // aren't wired yet, so these just play their animation + spend PP.
  shield: { name: 'Shield α', pp: 6, anim: 'shield_alpha' },
  psishield: { name: 'PSI Shield α', pp: 8, anim: 'psi_shield_alpha' },
  offenseup: { name: 'Offense up α', pp: 10, anim: 'offense_up_alpha' },
  defensedown: { name: 'Defense down α', pp: 6, anim: 'defense_down_alpha' },
  magnet: { name: 'PSI Magnet α', pp: 1, anim: 'psi_magnet_alpha' },
  teleport: { name: 'Teleport α', pp: 2, anim: 'teleport_alpha' },
};
// Unit facing vectors by Direction (S,N,W,E,NW,SW,SE,NE) — where an offense PSI
// fizzles toward when no enemy is in range (so the projectile still reads).
const PSI_DIR = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
  [-0.7, -0.7],
  [-0.7, 0.7],
  [0.7, 0.7],
  [0.7, -0.7],
];

// --- Player progression (server-authoritative; full stat growth) ---
// Every player's level-1 combat baseline is DERIVED from a creation allocation
// (progressionFromAlloc below); anonymous/dev sessions use defaultAlloc(). One
// stat model for everyone means banked skill points only ever ADD to a build
// (no baseline that a spend would silently re-derive away from).
// Per-level stat gains (tunable). HP/maxHp, offense and defense feed combat;
// SPEED now drives both dodge (dodgeChanceFromSpeed) AND the player's walk speed
// (client Player.moveSpeedFor) — so leveling visibly quickens your legs. guts/
// vitality/iq/luck grow and show on the Status screen but aren't hooked up yet.
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

// StatusModal-shaped payload (field names match PlayerStats: hpMax/ppMax). The
// combat stats are EFFECTIVE values — base progression + any active timed buffs
// (buffs.js) — so the status screen and combat agree on what the player has now.
function statsPayload(p) {
  const now = Date.now();
  const bb = (stat) => buffs.buffBonus(p, stat, now);
  return {
    level: p.level,
    hp: p.hp,
    hpMax: p.maxHp,
    pp: p.pp,
    ppMax: p.ppMax,
    exp: p.exp,
    expToNext: p.expToNext,
    offense: p.offense + bb('offense'),
    defense: p.defense + bb('defense'),
    speed: p.speed + bb('speed'),
    guts: p.guts + bb('guts'),
    vitality: p.vitality + bb('vitality'),
    iq: p.iq + bb('iq'),
    luck: p.luck + bb('luck'),
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
    // Per-character save serialization: characterId -> tail Promise of its write
    // chain. The store may be async (Supabase), so back-to-back saves of the SAME
    // character are queued to land in order — a later snapshot can never be
    // overwritten by an earlier one that resolved late. See _persistCharacterSave.
    this._saveChains = new Map();
    // Per-player quest/progress flags (PlayerFlags): playerId -> Set<number>.
    // Kept OUT of the player record too — flags are PRIVATE, never broadcast to
    // other clients. Persisted in the character save for signed-in players;
    // ephemeral (session-only) for anonymous dev/char-select joins.
    this.flags = new Map();
    // Per-player skill points + creation-stat allocation (drives the level-up
    // icon + spend pentagon): playerId -> {alloc, unspentPoints}. Like flags,
    // kept OUT of the player record (PRIVATE, never broadcast). Lives here for
    // EVERY player — anonymous/dev sessions bank + spend ephemerally (reset on
    // reload); signed-in players also persist it via the character save.
    this.points = new Map();

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

    // Present box catalog: placement key -> { romFlag, item }. ROM-derived
    // (assets/map/gifts.json) with authored contents + new boxes layered on
    // (overrides/gifts.json). Drives the one-time 'open_gift' grant. Paths kept
    // so start() can hot-reload it when the Gift Manager saves (dev).
    this._assetsDir = assetsDir;
    this._root = root;
    this.GIFTS = GameHost._loadGifts(assetsDir, root);

    // Server-authoritative NPC simulation: same world for every client.
    this.npcSim = createNpcSim(assetsDir);
    // World pixel bounds for move validation (clamp players onto the map).
    this.WORLD = this.npcSim.bounds();

    // Idle-connection sweep handle (set in start()).
    this._heartbeat = null;
    // Player status-condition tick handle (DoT + expiry; set in start()).
    this._statusTimer = null;
    // Gift-override file watcher handle (set in start()).
    this._giftsWatchPath = null;
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

  /**
   * Load the present-box catalog: placement key -> { romFlag, item }. ROM base
   * (assets/map/gifts.json) with authored contents (overrides/gifts.json edits)
   * layered on. Missing files -> empty catalog (gifts simply won't open).
   */
  static _loadGifts(assetsDir, root) {
    const gifts = new Map();
    let base;
    try {
      base = JSON.parse(fs.readFileSync(path.join(assetsDir, 'map', 'gifts.json'), 'utf8'));
    } catch {
      return gifts; // not extracted yet
    }
    for (const g of base) {
      if (g && typeof g.k === 'string') gifts.set(g.k, { romFlag: g.romFlag, item: g.item });
    }
    try {
      const ov = JSON.parse(
        fs.readFileSync(path.join(root, 'public', 'overrides', 'gifts.json'), 'utf8')
      );
      for (const [k, e] of Object.entries(ov?.edits || {})) {
        const g = gifts.get(k);
        if (g && e && e.item !== undefined) g.item = e.item;
      }
      // Admin-placed gift boxes (Gift Manager additions).
      for (const a of ov?.additions || []) {
        if (a && typeof a.k === 'string') gifts.set(a.k, { romFlag: a.romFlag, item: a.item });
      }
    } catch {
      /* no authored overrides yet */
    }
    return gifts;
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
          // Speed buffs (e.g. Skip sandwich) raise the effective dodge while active.
          dodge: dodgeChanceFromSpeed(p.speed + buffs.buffBonus(p, 'speed', Date.now())),
          // PK flag, so npcSim's canHurt can gate PvP (and NPC aggro on PKers).
          pk: !!p.pk,
        })),
      (data) => this.broadcastAll(data),
      // `inflict` = status procs the hit carries (e.g. paralysis), applied to the
      // victim's status set by damagePlayer; `knock` = the knockback landing spot.
      (playerId, dmg, _enemy, knock, inflict) => this.damagePlayer(playerId, dmg, knock, inflict),
      (playerId, xp, _enemy, loot) => this.awardKill(playerId, xp, loot),
      // PvP: a player's swing landed on another player — apply it to the victim's
      // server-authoritative HP (same path as an enemy hit).
      (targetId, dmg, _byId, knock, inflict) => this.damagePlayer(targetId, dmg, knock, inflict),
      // Ground-drop claim: the sim found a player on a drop; we own inventory/cash
      // and decide if they can take it (bag room). Return true to consume it.
      (playerId, drop) => this.tryPickup(playerId, drop),
      // Vehicle nudge: a friendly player got clipped by a plowing vehicle — shove
      // them clear of the lane with NO damage (the sim already clamped the spot).
      (playerId, spot) => this.shovePlayer(playerId, spot)
    );
    // Graceful disconnects: reap dead/zombie sockets that stopped sending. A live
    // client sends a move every ~3 frames, so silence past IDLE_TIMEOUT_MS means
    // the connection is gone; close it so the close handler saves + cleans up.
    this._heartbeat = setInterval(() => this._reapIdle(), HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref(); // don't keep tests alive
    // Status conditions tick (DoT + expiry) for players. npcSim ticks its own
    // actors; players live here, so the host drives their poison/etc + clears
    // worn-off statuses (re-broadcasting the set). 4Hz is plenty for ~1s DoT.
    this._statusTimer = setInterval(() => this._tickPlayerStatuses(), STATUS_TICK_MS);
    if (this._statusTimer.unref) this._statusTimer.unref();

    // Hot-reload the gift catalog when the Gift Manager saves overrides/gifts.json
    // (dev), so newly-placed boxes are openable without a server restart. Polling
    // watcher (cross-platform); harmless if the file never appears.
    this._giftsWatchPath = path.join(this._root, 'public', 'overrides', 'gifts.json');
    try {
      fs.watchFile(this._giftsWatchPath, { interval: 1500 }, () => {
        this.GIFTS = GameHost._loadGifts(this._assetsDir, this._root);
      });
    } catch {
      /* watch unavailable — gifts still load at startup */
    }
  }

  // Per-tick player status upkeep: apply due DoT, drop worn-off statuses, and
  // re-broadcast the set when it changes. Skips clean/editor/dead players.
  _tickPlayerStatuses() {
    const now = Date.now();
    for (const [id, p] of this.players) {
      // Downed players: tick the KO window; when it elapses they truly die.
      if (p.downed) {
        if (now >= p.downedUntil) this._trueDeath(id);
        continue;
      }
      if (p.editor || p.hp <= 0) continue;
      // Expire timed stat buffs; when one wears off, re-push stats so the client's
      // status screen drops the bonus back down (effective offense/defense/speed).
      if (p.buffs && p.buffs.length && buffs.tickBuffs(p, now).changed) {
        this.broadcastAll({
          type: 'player_stats',
          id,
          stats: statsPayload(p),
          leveled: false,
          gained: 0,
        });
        this._sendPlayerBuffs(p); // a buff wore off — refresh the owner's HUD
      }
      if (!p.statuses || Object.keys(p.statuses).length === 0) continue;
      const r = status.tickStatuses(p, now);
      for (const d of r.dot) {
        this.damagePlayer(id, Math.max(1, Math.floor(p.maxHp * d.pct)), null, null);
        if (p.hp <= 0) break; // death cleared everything + respawned
      }
      if (r.changed && p.hp > 0) this._broadcastPlayerStatus(p);
    }
  }

  // A player's status vulnerability % for an element (100 = no resist). EB grants
  // status protection via EQUIPMENT (e.g. items that "protect from paralysis"),
  // not level — wiring that needs the item-flag data (community source; the ROM
  // decompile doesn't expose it). Until then players are fully susceptible.
  _playerVuln(_p, _element) {
    return 100;
  }

  /** Broadcast a player's current active status-id set (drives client icons + lock). */
  _broadcastPlayerStatus(p) {
    this.broadcastAll({
      type: 'player_status',
      id: p.id,
      statuses: status.activeStatuses(p, Date.now()),
    });
  }

  /** Send a player their active timed buffs (owner-only — it drives their personal
   *  buff HUD). Each entry carries REMAINING ms (not an absolute time) so the
   *  client counts down locally regardless of clock skew, the same trick as the PK
   *  lock. Call whenever the buff set changes (apply / expire / death / revive). */
  _sendPlayerBuffs(p) {
    if (!p || !p._ws) return;
    const now = Date.now();
    const list = buffs.activeBuffs(p, now).map((b) => ({
      stat: b.stat,
      amount: b.amount,
      ms: Math.max(0, b.until - now),
    }));
    p._ws.send(JSON.stringify({ type: 'player_buffs', buffs: list }));
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

  /** Stop the heartbeat + status tick (tests / shutdown). */
  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = null;
    if (this._giftsWatchPath) fs.unwatchFile(this._giftsWatchPath);
    this._giftsWatchPath = null;
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
    // Swing-rate multiplier from the equipped weapon (1 = bare-handed baseline).
    // Drives the server's per-player attack cooldown AND the client's swing-pose
    // duration (sent in the equipped payload), so a fast weapon both resolves and
    // animates quicker. Future haste items would multiply in here too.
    entry.attackSpeed = we && we.slot === 'weapon' && we.attackSpeed > 0 ? we.attackSpeed : 1;
    // Status-inflict spec the equipped weapon carries ([{type, chance}], sanitized).
    // null = nothing authored → npcSim applies the baseline paralysis proc, so
    // unauthored weapons / bare hands behave exactly as before. An authored spec
    // overrides it (e.g. a weapon that procs sleep instead of paralysis).
    const wInf = status.normalizeInflict(we && we.slot === 'weapon' ? we.inflict : null);
    entry.weaponInflict = wInf.length ? wInf : null;
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
      progression: progressionFromAlloc(defaultAlloc(), 1, 0),
      inventory: [...this.STARTING_INVENTORY],
      money: STARTING_MONEY, // on-hand cash (shops spend this)
      bank: 0, // ATM balance — kill money lands here; withdraw to spend
      // Running tallies for Dad's phone report: money banked from kills and cash
      // spent at shops since the last time the player called Dad (reset on call).
      earnedSinceCall: 0,
      spentSinceCall: 0,
      equipped: { weapon: null, body: null, arms: null, other: null },
      hotbar: new Array(HOTBAR_SLOTS).fill(null),
      x: this.SPAWN.x,
      y: this.SPAWN.y,
      direction: this.SPAWN.dir || 0,
      characterId: null,
      alloc: defaultAlloc(),
      unspentPoints: 0,
      flags: [],
      pk: false,
      pkLockMs: 0,
      // EB naming flavor (anon players never set these); mom's food cooldown.
      favoriteThing: '',
      favoriteFood: '',
      momFoodReadyAt: 0,
    };
  }

  // Signed-in join: validate the session, load the character it owns, and rebuild
  // its world state from the save. Returns null if the token/character is invalid
  // or not owned by the session's account. Combat stats are RE-DERIVED from the
  // saved alloc (never trusted as raw numbers); inventory/equip are re-validated
  // against the live catalog.
  async _loadCharacterInit(token, characterId) {
    const session = await this.store.getSession(token, Date.now());
    if (!session) return null;
    const character = await this.store.getCharacter(Number(characterId));
    if (!character || character.accountId !== session.accountId) return null;

    const save = character.save && typeof character.save === 'object' ? character.save : {};
    const alloc = sanitizeAlloc(save.alloc);
    const level = Number.isInteger(save.level) && save.level >= 1 ? save.level : 1;
    const exp = Number.isInteger(save.exp) && save.exp >= 0 ? save.exp : 0;

    const inventory = Array.isArray(save.inventory)
      ? save.inventory.filter((id) => this.GOODS[id])
      : [...this.STARTING_INVENTORY];
    const money = Number.isInteger(save.money) ? save.money : STARTING_MONEY;
    const bank = Number.isInteger(save.bank) && save.bank >= 0 ? save.bank : 0;
    // Dad's-report tallies survive relogging so a reconnect doesn't make Dad
    // forget what he banked / you spent since the last call.
    const earnedSinceCall =
      Number.isInteger(save.earnedSinceCall) && save.earnedSinceCall >= 0
        ? save.earnedSinceCall
        : 0;
    const spentSinceCall =
      Number.isInteger(save.spentSinceCall) && save.spentSinceCall >= 0 ? save.spentSinceCall : 0;

    // Worn gear is stored SEPARATELY from Goods now, so validate it by item
    // type + slot (not by inventory membership), then pull any equipped id back
    // OUT of the loaded Goods — which also migrates old saves that kept a worn
    // item in both places (it would otherwise show in the bag while equipped).
    const equipped = { weapon: null, body: null, arms: null, other: null };
    if (save.equipped && typeof save.equipped === 'object') {
      for (const s of ['weapon', 'body', 'arms', 'other']) {
        const id = save.equipped[s];
        const eq = id && this.GOODS[id] && this.GOODS[id].equip;
        if (eq && eq.slot === s) {
          equipped[s] = id;
          const i = inventory.indexOf(id);
          if (i !== -1) inventory.splice(i, 1);
        }
      }
    }

    return {
      hotbar: this._sanitizeHotbar(save.hotbar),
      name: character.name,
      spriteGroupId: character.spriteGroupId,
      appearance: this._validAppearance(character.appearance),
      progression: progressionFromAlloc(alloc, level, exp),
      inventory,
      money,
      bank,
      earnedSinceCall,
      spentSinceCall,
      equipped,
      x: Number.isFinite(save.x) ? save.x : this.SPAWN.x,
      y: Number.isFinite(save.y) ? save.y : this.SPAWN.y,
      direction: Number.isInteger(save.direction) ? save.direction : this.SPAWN.dir || 0,
      characterId: character.id,
      alloc,
      unspentPoints:
        Number.isInteger(save.unspentPoints) && save.unspentPoints >= 0 ? save.unspentPoints : 0,
      flags: Array.isArray(save.flags) ? save.flags.filter((n) => Number.isInteger(n)) : [],
      // PK mode + its enable-lock survive relogging (you can't escape PK by
      // disconnecting). pkLockMs is REMAINING in-game ms — it only counts down
      // while online, so it resumes (paused) right where it left off.
      pk: !!save.pk,
      pkLockMs: Number.isFinite(save.pkLockMs) ? save.pkLockMs : 0,
      // EB naming prompts (set at creation) + mom's food cooldown (epoch ms),
      // persisted so the timer can't be reset by relogging.
      favoriteThing: typeof save.favoriteThing === 'string' ? save.favoriteThing : '',
      favoriteFood: typeof save.favoriteFood === 'string' ? save.favoriteFood : '',
      momFoodReadyAt: Number.isFinite(save.momFoodReadyAt) ? save.momFoodReadyAt : 0,
    };
  }

  // Validate a saved/echoed hotbar into a fixed-length array of: null, a known
  // GOODS id (weapon or usable item — never armor), or a 'psi:<id>' tag for a
  // known PSI move. Lenient on inventory membership (a PSI isn't an inventory
  // item, and an equipped weapon is re-synced client-side), strict on the id
  // existing so a tampered/garbage hotbar never persists.
  _sanitizeHotbar(arr) {
    const out = new Array(HOTBAR_SLOTS).fill(null);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const id = arr[i];
      if (typeof id !== 'string' || id.length > 32) continue;
      if (id.startsWith(HOTBAR_PSI_TAG)) {
        if (PSI[id.slice(HOTBAR_PSI_TAG.length)]) out[i] = id;
      } else {
        const good = this.GOODS[id];
        const armor = good && good.equip && good.equip.slot !== 'weapon';
        if (good && !armor) out[i] = id;
      }
    }
    return out;
  }

  // Decrement a player's PK lock by the IN-GAME time elapsed since the last tick.
  // Only ever called while the player is connected, so the wall-clock delta IS
  // in-game time; the lock pauses while offline because pkTickAt is reset to now
  // on (re)join. Idempotent — safe to call before any read of pkLockMs.
  _tickPkLock(entry) {
    if (!entry) return;
    const now = Date.now();
    if (entry.pkLockMs > 0) {
      entry.pkLockMs = Math.max(0, entry.pkLockMs - (now - (entry.pkTickAt || now)));
    }
    entry.pkTickAt = now;
  }

  // Write a signed-in player's mutable state back to its character row. No-op for
  // anonymous players (no handle in this.saves) or when there's no store.
  _saveCharacter(playerId) {
    const handle = this.saves.get(playerId);
    const p = this.players.get(playerId);
    if (!handle || !p || !this.store) return;
    this._tickPkLock(p); // bank the in-game time served so the saved lock is current
    const prog = this.points.get(playerId);
    // Snapshot ALL state synchronously — the caller may delete the player right
    // after (disconnect), and the actual write is deferred/queued below.
    const save = {
      alloc: prog ? prog.alloc : handle.alloc,
      level: p.level,
      exp: p.exp,
      unspentPoints: prog ? prog.unspentPoints || 0 : 0,
      inventory: [...p.inventory],
      money: p.money,
      bank: p.bank,
      earnedSinceCall: p.earnedSinceCall | 0,
      spentSinceCall: p.spentSinceCall | 0,
      equipped: { ...p.equipped },
      hotbar: Array.isArray(p.hotbar) ? [...p.hotbar] : new Array(HOTBAR_SLOTS).fill(null),
      x: p.x,
      y: p.y,
      direction: p.direction,
      flags: [...(this.flags.get(playerId) || [])],
      pk: !!p.pk,
      pkLockMs: p.pkLockMs || 0,
      // Preserve the EB naming flavor + advance mom's food cooldown.
      favoriteThing: p.favoriteThing || '',
      favoriteFood: p.favoriteFood || '',
      momFoodReadyAt: p.momFoodReadyAt || 0,
    };
    return this._persistCharacterSave(handle.characterId, save);
  }

  // Queue a character's save behind any in-flight save for the SAME character, so
  // writes land in submission order even with an async store. Errors are caught
  // (a failed save must never crash the host or break the chain). Returns the
  // tail promise so flushSaves()/tests can await durability.
  _persistCharacterSave(characterId, save) {
    const prev = this._saveChains.get(characterId) || Promise.resolve();
    const next = prev
      .catch(() => {}) // a prior failure must not poison later saves
      .then(() => this.store.updateCharacterSave(characterId, save, Date.now()))
      .catch((e) => console.error('[save] failed for character', characterId, e));
    this._saveChains.set(characterId, next);
    // Drop the chain entry once it's the settled tail, so the map doesn't grow.
    next.finally(() => {
      if (this._saveChains.get(characterId) === next) this._saveChains.delete(characterId);
    });
    return next;
  }

  // Await every outstanding character save. Call before process exit (SIGTERM)
  // so a disconnect/level-up write isn't dropped mid-flight; tests use it to read
  // a save back deterministically.
  async flushSaves() {
    await Promise.allSettled([...this._saveChains.values()]);
  }

  // Send a message to a single player's socket (private state like skill points).
  sendTo(playerId, data) {
    const entry = this.players.get(playerId);
    if (entry && entry._ws.readyState === 1) entry._ws.send(JSON.stringify(data));
  }

  // Push a player their authoritative banked points + current alloc (drives the
  // level-up icon + the spend pentagon). Private to the owner; works for anon too.
  _sendPoints(playerId) {
    const prog = this.points.get(playerId);
    if (!prog) return;
    this.sendTo(playerId, {
      type: 'points_update',
      points: prog.unspentPoints || 0,
      alloc: prog.alloc,
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
  // Push a player to a sim-computed spot with NO damage (a vehicle clipping a
  // friendly out of its lane). Same client-honored hint as a knockback move.
  shovePlayer(playerId, spot) {
    const p = this.players.get(playerId);
    if (!p || p.hp <= 0 || p.editor || !spot) return;
    if (p.warping && Date.now() < p.warpUntil) return;
    p.x = spot.x;
    p.y = spot.y;
    this.broadcastAll({ type: 'player_push', id: playerId, x: p.x, y: p.y });
  }

  damagePlayer(playerId, dmg, knock, inflict) {
    const p = this.players.get(playerId);
    if (!p || p.hp <= 0) return;
    if (p.editor) return; // out of the world in the dev editor — untargetable
    // Shielded mid door-transition: the player is a frozen ghost at the doorway
    // and can't move or defend, so enemy swings whiff (see player.warping).
    if (p.warping && Date.now() < p.warpUntil) return;
    // Defense softens incoming hits (stat defense + equipped armor + any active
    // defense buff); always at least 1 so leveling/gear never makes a player
    // untouchable.
    const defBuff = buffs.buffBonus(p, 'defense', Date.now());
    const eff = Math.max(
      1,
      dmg - Math.floor(((p.defense || 0) + (p.armorDefense || 0) + defBuff) / 2)
    );
    p.hp = Math.max(0, p.hp - eff);
    this.broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: eff });
    if (p.hp > 0) this._applyHitStatuses(p, inflict); // break sleep + roll any inflicts
    if (p.hp > 0 && knock) {
      // Knocked back (and lived): the sim already collision-clamped the landing
      // spot. Move our authoritative record and broadcast a push — the victim's
      // client snaps itself there (and reports from there), others snap the
      // remote copy. Player movement is client-authoritative, so this is a hint
      // the client honors, same trust model as ordinary moves.
      p.x = knock.x;
      p.y = knock.y;
      this.broadcastAll({ type: 'player_push', id: playerId, x: p.x, y: p.y });
    }
    // Killing blow → enter the downed/KO state (30s) instead of dying outright.
    // Drops + respawn are deferred to true death so a revive loses nothing.
    if (p.hp <= 0 && !p.downed) this._enterDowned(playerId, p);
  }

  /** HP hit 0 → lay the player out (KO) for DOWNED_MS instead of dying. Clears
   *  DoT/buffs (they're unconscious) and tells everyone: remotes draw the laying
   *  pose, the owner gets the countdown + closing vignette. The cash-drop penalty
   *  is DEFERRED to _trueDeath, so an ally revive within the window costs nothing. */
  _enterDowned(playerId, p) {
    p.hp = 0;
    p.downed = true;
    p.downedUntil = Date.now() + DOWNED_MS;
    p.pose = 'walk';
    p.frame = 0;
    status.clearAll(p);
    buffs.clearBuffs(p);
    this._broadcastPlayerStatus(p);
    this._sendPlayerBuffs(p);
    this.broadcastAll({ type: 'player_downed', id: playerId, ms: DOWNED_MS });
  }

  /** Resolve a downed player into TRUE death: apply the cash-drop penalty, then
   *  full-heal + respawn at the spawn point. Fired when the 30s window elapses or
   *  the player gives up the ghost. No-op if they're not (still) downed. */
  _trueDeath(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.downed) return;
    p.downed = false;
    p.downedUntil = 0;
    // Death penalty: drop half on-hand cash where they fell (bank is safe), as a
    // first-touch pickup. Spawn it before the respawn teleport moves p.
    const dropped = Math.floor((p.money | 0) * DEATH_CASH_PCT);
    if (dropped > 0) {
      p.money -= dropped;
      if (p._ws) p._ws.send(JSON.stringify({ type: 'money', money: p.money }));
      this.npcSim.spawnMoneyDrop(p.x, p.y, dropped);
    }
    p.hp = p.maxHp;
    p.x = this.SPAWN.x;
    p.y = this.SPAWN.y;
    p.direction = this.SPAWN.dir || 0;
    p.frame = 0;
    p.pose = 'walk';
    status.clearAll(p);
    buffs.clearBuffs(p);
    this._sendPlayerBuffs(p);
    this.npcSim.noteRespawn(playerId); // exempt this teleport from enemy door-warp follow
    this.broadcastAll({ type: 'player_respawn', id: playerId, x: p.x, y: p.y, dir: p.direction });
    this.broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
    this._broadcastPlayerStatus(p);
    this._saveCharacter(playerId);
  }

  /** Revive a downed player IN PLACE to `hp` HP (clamped ≥1). Cancels the KO; every
   *  client stands them back up (player_revived) and the owner's vignette lifts. */
  _reviveDowned(p, hp) {
    if (!p || !p.downed) return;
    p.downed = false;
    p.downedUntil = 0;
    p.hp = Math.min(p.maxHp, Math.max(1, hp | 0));
    p.pose = 'walk';
    p.frame = 0;
    this.broadcastAll({ type: 'player_revived', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
    this.broadcastAll({
      type: 'player_hp',
      id: p.id,
      hp: p.hp,
      maxHp: p.maxHp,
      dmg: 0,
      heal: p.hp,
    });
    this._broadcastPlayerStatus(p);
    this._saveCharacter(p.id);
  }

  /** Find the downed player nearest to (x,y) within REVIVE_RANGE, or null. Used to
   *  resolve a proximity revive (and to validate a clicked target's range). */
  _nearestDownedWithin(x, y, range = REVIVE_RANGE) {
    let best = null;
    let bestD2 = range * range;
    for (const q of this.players.values()) {
      if (!q.downed) continue;
      const dx = q.x - x;
      const dy = q.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = q;
      }
    }
    return best;
  }

  // Apply a landed hit's status side-effects to a player: any "breaks on hit"
  // status (Sleep) clears, then each `inflict` {type, chance} is rolled against
  // the status engine (immunity-gated). On a successful proc, broadcast a
  // `status_applied` (drives the floating battle-text + SFX + the local input
  // lock); re-broadcast the active set whenever it changed. `inflict` may be
  // null (a plain hit) — Sleep still breaks. Per-element vulnerability/resist
  // (ROM table) is a TODO; for now `chance` is the attack's flat proc odds.
  _applyHitStatuses(p, inflict) {
    const now = Date.now();
    const before = status.activeStatuses(p, now).join(',');
    status.breakOnHit(p, now); // a hit wakes a sleeper
    for (const inf of inflict || []) {
      // Element-scale by the player's resist for the status' element. Players
      // have no vuln table yet (EB resistance is gear-based, not level-based —
      // a TODO needing community item data), so this is 100% for now.
      const eff = inf.chance * (this._playerVuln(p, status.elementOf(inf.type)) / 100);
      if (status.tryInflict(p, inf.type, eff, now, Math.random)) {
        const def = status.defOf(inf.type) || {};
        this.broadcastAll({
          type: 'status_applied',
          id: p.id,
          x: Math.round(p.x),
          y: Math.round(p.y),
          status: inf.type,
          text: def.text || '',
          ms: def.durationMs || 0, // local input-lock deadline for blocking statuses
          blocks: !!def.blocksAction,
        });
      }
    }
    if (status.activeStatuses(p, now).join(',') !== before) this._broadcastPlayerStatus(p);
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
      // Grant skill points for each level gained and push the new banked total to
      // the owner — they alone decide where to spend it. Banked for everyone
      // (anon sessions too); signed-in players persist it in _saveCharacter.
      const prog = this.points.get(playerId);
      if (prog) {
        prog.unspentPoints = (prog.unspentPoints || 0) + POINTS_PER_LEVEL * (p.level - fromLevel);
        this._sendPoints(playerId);
      }
    }
    this._saveCharacter(playerId); // persist new exp/level/points (signed-in only)
  }

  // A player killed an enemy: award EXP + the kill money. Money goes to the BANK
  // (EarthBound's model — it's wired to your ATM account, not your pocket), so you
  // must visit an ATM to withdraw spendable cash. Items spawn as first-touch GROUND
  // DROPS at the death spot and are claimed via tryPickup.
  awardKill(playerId, xp, loot) {
    this.awardXp(playerId, xp); // also persists; broadcasts player_stats
    const p = this.players.get(playerId);
    if (!p || !loot) return;
    if (loot.money > 0) {
      p.bank = (p.bank | 0) + loot.money;
      p.earnedSinceCall = (p.earnedSinceCall | 0) + loot.money; // for Dad's report
      p._ws.send(JSON.stringify({ type: 'bank', bank: p.bank }));
      this._saveCharacter(playerId);
    }
  }

  // Claim a ground drop for a player (npcSim found them standing on it). We own
  // inventory/cash, so the grant decision lives here. Returns true if the drop was
  // consumed (remove it from the world), false to leave it lying there.
  //   - money: always taken, merged into on-hand cash (→ bank split in Phase E).
  //   - item:  taken only if it's a real good AND the bag has room; a full bag
  //            leaves the drop and (Phase D) notifies the player why.
  tryPickup(playerId, drop) {
    const p = this.players.get(playerId);
    if (!p || !drop) return false;
    if (drop.kind === 'money') {
      const amount = drop.amount | 0;
      if (amount <= 0) return true; // nothing to give; still consume it
      p.money += amount;
      p._ws.send(JSON.stringify({ type: 'money', money: p.money }));
      p._ws.send(JSON.stringify({ type: 'loot', money: amount }));
      this._saveCharacter(playerId);
      return true;
    }
    // item drop
    const itemId = String(drop.item);
    if (!this.GOODS[itemId]) return true; // unknown id — consume so it can't linger
    if (p.inventory.length >= MAX_SLOTS) {
      // Bag full: leave the drop so they can return after making room, and tell
      // them why — debounced, since the sim re-offers the drop every tick while
      // they stand on it (one popup per BAG_FULL_NOTICE_MS, not 60/second).
      const now = Date.now();
      if (now - (p._bagFullAt || 0) >= BAG_FULL_NOTICE_MS) {
        p._bagFullAt = now;
        p._ws.send(JSON.stringify({ type: 'notice', code: 'bag_full', text: 'Your bag is full!' }));
      }
      return false;
    }
    p.inventory.push(itemId);
    p._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(p.inventory) }));
    p._ws.send(JSON.stringify({ type: 'loot', item: itemId, name: this.GOODS[itemId].name || '' }));
    this._saveCharacter(playerId);
    return true;
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
      // _handleMessage is async (the join path awaits the store). It's
      // fire-and-forget for real sockets; the returned promise (rejection logged,
      // never thrown) lets tests await a message that touches the store.
      return Promise.resolve(this._handleMessage(playerId, ws, msg)).catch((e) =>
        console.error('[msg] handler failed', e)
      );
    });

    ws.on('close', () => {
      console.log(`Player ${playerId} disconnected`);
      this._saveCharacter(playerId); // persist final state (signed-in only)
      this.saves.delete(playerId);
      this.flags.delete(playerId);
      this.points.delete(playerId);
      this.players.delete(playerId);
      this.broadcastAll({ type: 'player_leave', id: playerId });
    });
  }

  async _handleMessage(playerId, ws, msg) {
    const { GOODS } = this;
    switch (msg.type) {
      case 'join': {
        // Two paths: a signed-in character (sessionToken + characterId, loaded
        // from the store and saved back), or an anonymous ephemeral player (the
        // dev char-select flow + tests). An invalid auth attempt errors cleanly
        // rather than silently falling back to a fresh player.
        let init;
        if (this.store && msg.sessionToken && msg.characterId != null) {
          init = await this._loadCharacterInit(msg.sessionToken, msg.characterId);
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
          // Active status conditions (see server/status.js): paralysis, poison, …
          // Transient (not persisted); cleared on death/respawn.
          statuses: {},
          itemId: null, // set by recomputeEquipStats (held = equipped weapon)
          // EarthBound equip slots (loaded from the save or empty). Server-
          // authoritative; offense/defense from these apply to combat.
          equipped: init.equipped,
          // Quick-select hotbar (keys 1/2): weapon / usable item / 'psi:<id>'.
          // Persisted so an assigned PSI survives a relog (a weapon would be
          // re-derived from the equip set, but a PSI move has no other anchor).
          hotbar: Array.isArray(init.hotbar) ? init.hotbar : new Array(HOTBAR_SLOTS).fill(null),
          weaponOffense: 0,
          armorDefense: 0,
          attackSpeed: 1, // weapon swing-rate multiplier; set by recomputeEquipStats
          weaponInflict: null, // weapon status-inflict spec; set by recomputeEquipStats
          inventory: init.inventory, // Goods slots, mutated by use/buy/sell
          money: init.money, // on-hand cash
          bank: init.bank | 0, // ATM balance
          // Dad's-report tallies (kills banked / cash spent since last call).
          earnedSinceCall: init.earnedSinceCall | 0,
          spentSinceCall: init.spentSinceCall | 0,
          // PK (player-kill) flag + remaining enable-lock (in-game ms) — see
          // npcSim canHurt and the set_pk handler. Loaded from the save (anon:
          // off). pkTickAt is reset to now so the lock resumes from join, paused
          // for the whole time the player was offline.
          pk: init.pk,
          pkLockMs: init.pkLockMs,
          pkTickAt: Date.now(),
          // EB naming flavor + Ness's-mom food cooldown (epoch ms; 0 = ready).
          favoriteThing: init.favoriteThing ?? '',
          favoriteFood: init.favoriteFood ?? '',
          momFoodReadyAt: init.momFoodReadyAt | 0,
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

        // Skill points + alloc (private). Banked for EVERY player so the
        // level-up icon + spend pentagon work in anonymous/dev sessions too;
        // signed-in players also persist it (see _saveCharacter).
        this.points.set(playerId, {
          alloc: init.alloc ? { ...init.alloc } : defaultAlloc(),
          unspentPoints: init.unspentPoints || 0,
        });

        // Remember the persistence handle (signed-in only) for save-back +
        // skill-point banking. `alloc` MUST be the SAME object `this.points`
        // holds (the copy above) — spend_points mutates that one, and both
        // _saveCharacter and tests read it back through this handle. (Pointing it
        // at the raw `init.alloc` instead decoupled them, so a valid spend didn't
        // show up here.)
        if (init.characterId != null) {
          this.saves.set(playerId, {
            characterId: init.characterId,
            alloc: this.points.get(playerId).alloc,
            unspentPoints: init.unspentPoints || 0,
          });
        }

        // The new player gets their id, the current roster, and their own state.
        const otherPlayers = [];
        for (const [id, p] of this.players) {
          if (id !== playerId) {
            const { _ws, ...data } = p;
            // Send the active-status ARRAY (not the internal {} map) so the
            // client can iterate pips — matches _broadcastPlayerStatus.
            data.statuses = status.activeStatuses(p, Date.now());
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
            npcEquips: this.npcSim.equipSnapshot(), // townsfolk holding looted weapons
            drops: this.npcSim.dropsSnapshot(), // ground loot already lying around
            inventory: this.inventoryView(entry.inventory), // own Goods
            money: entry.money, // own on-hand cash
            bank: entry.bank | 0, // own ATM balance
            // Signed-in characters restore their saved spawn + stats + gear; the
            // anonymous client ignores these (it spawns from its own spawn.json).
            self: { x: entry.x, y: entry.y, direction: entry.direction },
            stats: statsPayload(entry),
            equipped: entry.equipped,
            hotbar: entry.hotbar, // restore quick-select slots (incl. assigned PSI)
            attackSpeed: entry.attackSpeed, // weapon swing-rate mult (scales client swing pose)
            // Saved quest/progress flags (PlayerFlags) — private to this player.
            flags: [...this.flags.get(playerId)],
            // Restore PK state + remaining lock (a player who logged out PK
            // stays PK; the lock resumes paused-from-logout). lockMs is the
            // remaining in-game ms — the client renders its own countdown.
            pk: entry.pk,
            lockMs: entry.pkLockMs,
          })
        );

        // Tell everyone else about the new player.
        const { _ws, ...publicData } = this.players.get(playerId);
        publicData.statuses = status.activeStatuses(this.players.get(playerId), Date.now());
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
        // The dev editor reports its free-camera center as `move` so the sim
        // anchors on what the admin is observing — that legitimately leaps far
        // each pan, so exempt it from the speed-hack clamp (same as a warp).
        const warping = (entry.warping && Date.now() < entry.warpUntil) || entry.editor;
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
        // Status accuracy penalties: Crying lowers your hit rate, Nausea makes
        // you fumble — either can whiff the swing outright (broadcast a MISS).
        const nowA = Date.now();
        if (
          (status.isCrying(entry, nowA) && Math.random() < CRY_MISS_CHANCE) ||
          (status.hasFlag(entry, nowA, 'fumble') && Math.random() < FUMBLE_CHANCE)
        ) {
          this.broadcastAll({
            type: 'combat',
            evt: 'miss',
            x: Math.round(entry.x),
            y: Math.round(entry.y),
            byPlayer: playerId,
            targetPlayer: null,
          });
          break;
        }
        // Server-authoritative: resolve from the tracked position so reach can't
        // be spoofed. Damage scales with the player's Offense stat + weapon; crit
        // chance comes from Luck (SMAAAASH! → 2× damage, broadcast to all).
        this.npcSim.handleAttack(
          entry.x,
          entry.y,
          msg.dir | 0,
          playerId,
          entry.offense +
            (entry.weaponOffense || 0) +
            buffs.buffBonus(entry, 'offense', Date.now()),
          entry.pk,
          critChanceFromLuck(entry.luck),
          entry.attackSpeed || 1,
          entry.weaponInflict
        );
        break;
      }

      case 'equip': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // Per-slot equip: { slot, itemId|null }. Authoritative; null unequips.
        // Worn gear is moved OUT of Goods and the worn piece returns to Goods on
        // unequip (so the bag count reflects only what you're carrying, not what
        // you're wearing). Offense/defense recompute from the whole set.
        const slot = typeof msg.slot === 'string' ? msg.slot : null;
        const itemId =
          typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
        if (!slot || !EQUIP_SLOTS.includes(slot)) break;
        const prev = entry.equipped[slot]; // the piece currently worn here (or null)
        if (itemId !== null) {
          // EQUIP: must own it (in Goods) and it must fit the slot. Take it out
          // of Goods; a swap returns the old piece, so the count never overflows.
          const eq = GOODS[itemId] && GOODS[itemId].equip;
          const idx = entry.inventory.indexOf(itemId);
          if (!eq || eq.slot !== slot || idx === -1) break;
          entry.inventory.splice(idx, 1);
          if (prev) entry.inventory.push(prev);
          entry.equipped[slot] = itemId;
        } else {
          // UNEQUIP: the worn piece goes back into Goods — refuse if the bag is
          // full (it would have nowhere to land), and tell the player why. Resend
          // the unchanged equipped set so the client reverts its optimistic take-off.
          if (!prev) break; // nothing worn here
          if (entry.inventory.length >= MAX_SLOTS) {
            entry._ws.send(
              JSON.stringify({
                type: 'notice',
                code: 'bag_full',
                text: 'Your bag is full — make room before taking that off.',
              })
            );
            entry._ws.send(
              JSON.stringify({
                type: 'equipped',
                slots: entry.equipped,
                attackSpeed: entry.attackSpeed,
              })
            );
            break;
          }
          entry.inventory.push(prev);
          entry.equipped[slot] = null;
        }
        this.recomputeEquipStats(entry);
        // The owner gets their authoritative equipped set + the updated Goods...
        entry._ws.send(
          JSON.stringify({
            type: 'equipped',
            slots: entry.equipped,
            attackSpeed: entry.attackSpeed,
          })
        );
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        // ...everyone else just needs the held-weapon sprite.
        this.broadcastExcept({ type: 'equip', id: playerId, itemId: entry.itemId }, playerId);
        this._saveCharacter(playerId);
        break;
      }

      case 'hotbar': {
        // The client owns hotbar layout (assign by drag); it echoes the full
        // 2-slot array here so the server can persist it with the character. We
        // re-validate every entry (null / known good / known PSI) so a tampered
        // payload can't store junk, then save — same trust model as 'equip'.
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.hotbar = this._sanitizeHotbar(msg.hotbar);
        this._saveCharacter(playerId);
        break;
      }

      case 'use_item': {
        const entry = this.players.get(playerId);
        if (!entry || entry.hp <= 0) break;
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
        const def = itemId ? GOODS[itemId] : null;
        if (!def) break; // unknown id — ignore
        const slot = entry.inventory.indexOf(itemId);
        // Stock ran out but a hotbar slot still points at it — tell the player
        // instead of a silent no-op (the assignment intentionally lingers).
        if (slot === -1) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: `You're out of ${def.name}.` }));
          break;
        }
        // Equippable gear is NOT a consumable — "using" a weapon/armor must
        // never destroy it. It's equipped via the 'equip' path instead.
        if (def.equip) break;
        // Revive items (Horn of life / Secret herb / Cup of Lifenoodles) act on a
        // DOWNED ally, never the user (a downed player can't act). Resolve the
        // target: an explicit clicked targetId (must be downed AND within range),
        // else the nearest downed ally in range. No valid target → refuse WITHOUT
        // consuming, so a misclick or out-of-range press never wastes the item.
        if (def.revive > 0) {
          let target = null;
          const tid = typeof msg.targetId === 'string' ? msg.targetId : null;
          if (tid) {
            const t = this.players.get(tid);
            if (t && t.downed) {
              const dx = t.x - entry.x;
              const dy = t.y - entry.y;
              if (dx * dx + dy * dy <= REVIVE_RANGE * REVIVE_RANGE) target = t;
            }
          } else {
            target = this._nearestDownedWithin(entry.x, entry.y);
          }
          if (!target) {
            entry._ws.send(
              JSON.stringify({ type: 'notice', text: 'No downed ally in range to revive.' })
            );
            break;
          }
          this._reviveDowned(target, def.revive);
          entry.inventory.splice(slot, 1);
          entry._ws.send(
            JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
          );
          entry._ws.send(
            JSON.stringify({ type: 'notice', text: `You revived ${target.name} with ${def.name}!` })
          );
          this.broadcastExcept(
            {
              type: 'item_use',
              id: playerId,
              item: itemId,
              x: Math.round(entry.x),
              y: Math.round(entry.y),
            },
            playerId
          );
          this._saveCharacter(playerId);
          break;
        }
        // What this item can actually DO for the player right now. A consumable
        // whose every effect is a no-op (bars full, nothing to cure) would just be
        // wasted, so we refuse + say so (EarthBound does the same) rather than
        // silently eat a hotbar press.
        const now = Date.now();
        const canHp = def.heal && entry.hp < entry.maxHp;
        const canPp = def.healPp && entry.pp < entry.ppMax;
        // Statuses this item lists that the player currently has (the cure targets).
        const curable = Array.isArray(def.cure)
          ? def.cure.filter((t) => status.defOf(t) && status.hasStatus(entry, t, now))
          : [];
        // Valid timed stat buffs this item grants (buffs always "do something").
        const buffList = Array.isArray(def.buffs)
          ? def.buffs.filter(
              (b) => b && buffs.BUFF_STATS.has(b.stat) && b.durationMs > 0 && Math.round(b.amount)
            )
          : [];
        const hasEffect =
          def.heal || def.healPp || (Array.isArray(def.cure) && def.cure.length) || buffList.length;
        const useful = canHp || canPp || curable.length || buffList.length;
        if (hasEffect && !useful) {
          // Tailor the message to the dud: full bars vs nothing to cure.
          let text = 'It would have no effect right now.';
          if ((def.heal || def.healPp) && !buffList.length && !(def.cure && def.cure.length)) {
            const full = def.heal && def.healPp ? 'HP and PP are' : def.healPp ? 'PP is' : 'HP is';
            text = `Your ${full} already full.`;
          } else if (def.cure && def.cure.length && !def.heal && !def.healPp && !buffList.length) {
            text = "You don't have anything to cure.";
          }
          entry._ws.send(JSON.stringify({ type: 'notice', text }));
          break;
        }

        // Cookie (and any future `heal` good) restores HP up to the cap;
        // broadcast so every client redraws the bar, tagging `heal` so the
        // owner's client pops a green number.
        if (canHp) {
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
        // PP-restoring consumables (e.g. PSI-recovery foods) refill the PP bar up
        // to the cap; player_stats pushes the new pp so the caster's bar redraws.
        if (canPp) {
          entry.pp = Math.min(entry.ppMax, entry.pp + def.healPp);
        }
        // Status-cure foods clear the listed conditions the player currently has;
        // re-broadcast the active set so the client drops the icons + input lock.
        if (curable.length) {
          for (const t of curable) status.clearStatus(entry, t);
          this._broadcastPlayerStatus(entry);
        }
        // Timed stat buffs (Skip/Luck sandwich, etc.). applyBuff records each onto
        // entry.buffs; the per-tick upkeep expires them (see _tickPlayerStatuses).
        for (const b of buffList) buffs.applyBuff(entry, b.stat, b.amount, b.durationMs, now);
        // PP refill and/or a new buff changed the effective stats — push once so the
        // status screen + PSI bar redraw.
        if (canPp || buffList.length) {
          this.broadcastAll({
            type: 'player_stats',
            id: playerId,
            stats: statsPayload(entry),
            leveled: false,
            gained: 0,
          });
        }
        // Refresh the owner's buff HUD with the new active set + timers.
        if (buffList.length) this._sendPlayerBuffs(entry);

        entry.inventory.splice(slot, 1);
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        // The item was actually consumed — let OTHER clients play its "use"
        // animation on this player (the user already spawned their own locally,
        // same model as psi_cast). Visual only.
        this.broadcastExcept(
          {
            type: 'item_use',
            id: playerId,
            item: itemId,
            x: Math.round(entry.x),
            y: Math.round(entry.y),
          },
          playerId
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
        entry.spentSinceCall = (entry.spentSinceCall | 0) + def.cost; // for Dad's report
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

      // ATM: move money between the bank balance and on-hand cash. The server is
      // the sole authority — it clamps the amount to what actually exists, so a
      // forged/negative/oversized request can never mint money or overdraw. (The
      // client only opens the ATM menu when standing on an ATM sprite; proximity
      // isn't re-checked here because you can only ever move your OWN money.)
      case 'atm_withdraw': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const want = Math.floor(Number(msg.amount));
        if (!Number.isFinite(want) || want <= 0) break;
        const amount = Math.min(want, entry.bank | 0);
        if (amount <= 0) break;
        entry.bank -= amount;
        entry.money += amount;
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        entry._ws.send(JSON.stringify({ type: 'bank', bank: entry.bank }));
        this._saveCharacter(playerId);
        break;
      }

      case 'atm_deposit': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const want = Math.floor(Number(msg.amount));
        if (!Number.isFinite(want) || want <= 0) break;
        const amount = Math.min(want, entry.money | 0);
        if (amount <= 0) break;
        entry.money -= amount;
        entry.bank += amount;
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        entry._ws.send(JSON.stringify({ type: 'bank', bank: entry.bank }));
        this._saveCharacter(playerId);
        break;
      }

      // Calling Dad: report the money banked from kills and cash spent at shops
      // since the LAST call (EarthBound flavor — "I put $X in your account…"),
      // then reset the tallies so the next call starts fresh. The money already
      // lives in the bank (kills credit it directly); these counters are just the
      // accounting Dad narrates. Server-authoritative — the client only displays.
      case 'dad_call': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const earned = entry.earnedSinceCall | 0;
        const spent = entry.spentSinceCall | 0;
        entry.earnedSinceCall = 0;
        entry.spentSinceCall = 0;
        entry._ws.send(JSON.stringify({ type: 'dad_report', earned, spent, bank: entry.bank | 0 }));
        this._saveCharacter(playerId);
        break;
      }

      case 'use_psi': {
        const entry = this.players.get(playerId);
        if (!entry || entry.hp <= 0) break;
        const psiId = typeof msg.psiId === 'string' ? msg.psiId : null;
        const def = psiId ? PSI[psiId] : null;
        if (!def || entry.pp < def.pp) break; // unknown ability or not enough PP
        // "Can't concentrate" (noPsi) blocks ALL PSI, even a cure — it must wear
        // off. The client also gates this; the server is the authority.
        if (status.isPsiBlocked(entry, Date.now())) break;
        entry.pp -= def.pp;

        // Effect target for the projectile animation: the caster's own spot for a
        // heal/self PSI; the struck enemy for an offense PSI (else it fizzles
        // forward so the bolt still reads).
        let tx = Math.round(entry.x);
        let ty = Math.round(entry.y);
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
        if (def.cures) {
          // Healing PSI clears the caster's status conditions (paralysis, sleep,
          // poison, …). Death/respawn already clears; this is the in-field cure.
          status.clearAll(entry);
          this._broadcastPlayerStatus(entry);
        }
        if (def.damage || def.inflict) {
          // Server picks the target(s) — it owns enemy positions. A single-target
          // PSI hits the nearest live enemy in range with line of sight; a multi
          // PSI (ROM "row"/"all": Fire, Thunder, Flash, Starstorm, Rockin) hits
          // EVERY enemy in range. Damage + knockback + the PSI's status inflict
          // (each element-scaled by the enemy's resist) resolve in the sim. The
          // returned spot is the nearest hit, used as the projectile anim target.
          const strike = def.multi ? this.npcSim.psiStrikeAll : this.npcSim.psiStrike;
          const hit = strike.call(
            this.npcSim,
            entry.x,
            entry.y,
            def.range || 240,
            def.damage || 0,
            playerId,
            def.inflict
          );
          if (hit) {
            tx = hit.x;
            ty = hit.y;
          } else {
            const v = PSI_DIR[entry.direction] || [0, 1];
            tx = Math.round(entry.x + v[0] * 96);
            ty = Math.round(entry.y + v[1] * 96);
          }
        }
        // PP changed — push updated stats so the caster's PSI bar redraws.
        this.broadcastAll({
          type: 'player_stats',
          id: playerId,
          stats: statsPayload(entry),
          leveled: false,
          gained: 0,
        });
        // Cast animation to EVERYONE (incl. caster): `id` is the PsiAnim catalog
        // id; (x,y)=caster, (tx,ty)=target so a projectile flies caster→target.
        this.broadcastAll({
          type: 'psi_cast',
          id: def.anim || psiId,
          caster: playerId,
          x: Math.round(entry.x),
          y: Math.round(entry.y),
          tx,
          ty,
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

      case 'give_up': {
        // "Give up the ghost" during the downed window → resolve to true death now
        // (the client gates this behind a 2s hold so it's deliberate).
        const p = this.players.get(playerId);
        if (p && p.downed) this._trueDeath(playerId);
        break;
      }

      case 'set_pk': {
        // Server-authoritative PK with a 5-minute enable-LOCK measured in IN-GAME
        // time (pkLockMs counts down only while online, persisted), so it can't be
        // waited out or escaped by logging off. Enabling (re)arms the lock;
        // disabling is refused until it expires. Broadcast so every client renders
        // the PK marker; npcSim reads pk live through the getPlayers snapshot for
        // PvP + NPC aggro gating.
        const entry = this.players.get(playerId);
        if (!entry) break;
        if (msg.on) {
          entry.pk = true;
          entry.pkLockMs = PK_LOCK_MS; // committed for 5 min of in-game time
          entry.pkTickAt = Date.now();
        } else {
          this._tickPkLock(entry); // bring the remaining lock up to date
          if (entry.pkLockMs > 0) {
            // Still locked — refuse, and re-assert the truth so the client snaps back.
            this.sendTo(playerId, {
              type: 'player_pk',
              id: playerId,
              pk: true,
              lockMs: entry.pkLockMs,
            });
            break;
          }
          entry.pk = false;
          entry.pkLockMs = 0;
        }
        this.broadcastAll({
          type: 'player_pk',
          id: playerId,
          pk: entry.pk,
          lockMs: entry.pkLockMs,
        });
        this._saveCharacter(playerId);
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

      case 'mom_food': {
        // Talk to Ness's mom (client gates this to sprite 145): she cooks the
        // player's favorite food, healing MOM_FOOD_HEAL once per cooldown. SERVER-
        // AUTHORITATIVE: we own the heal, the cooldown clock, and the food name.
        // The client renders the dialogue from the facts we return.
        const p = this.players.get(playerId);
        if (!p || p.hp <= 0) break;
        const now = Date.now();
        const food = p.favoriteFood && p.favoriteFood.trim() ? p.favoriteFood.trim() : '';
        const readyAt = p.momFoodReadyAt || 0;
        if (now < readyAt) {
          // Still cooling down — tell them how long until the next meal.
          this.sendTo(playerId, { type: 'mom_food', healed: 0, readyInMs: readyAt - now, food });
          break;
        }
        const healed = Math.min(p.maxHp, p.hp + MOM_FOOD_HEAL) - p.hp;
        if (healed <= 0) {
          // Already full — no meal served, no cooldown spent.
          this.sendTo(playerId, { type: 'mom_food', healed: 0, readyInMs: 0, food });
          break;
        }
        p.hp += healed;
        p.momFoodReadyAt = now + MOM_FOOD_COOLDOWN_MS;
        this.broadcastAll({
          type: 'player_hp',
          id: playerId,
          hp: p.hp,
          maxHp: p.maxHp,
          dmg: 0,
          heal: healed,
        });
        this._saveCharacter(playerId); // persist the cooldown (relog-proof)
        this.sendTo(playerId, { type: 'mom_food', healed, readyInMs: MOM_FOOD_COOLDOWN_MS, food });
        break;
      }

      case 'open_gift': {
        // Open a present box ONCE per player. SERVER-AUTHORITATIVE: we own the
        // per-player flag (already-opened guard), the bag-room check, and the
        // item grant — the client only asks by placement key.
        const p = this.players.get(playerId);
        const set = this.flags.get(playerId);
        const gift = typeof msg.k === 'string' ? this.GIFTS.get(msg.k) : null;
        if (!p || !set || !gift || !Number.isInteger(gift.romFlag)) break;
        const flagId = GIFT_FLAG_BASE + gift.romFlag;
        if (set.has(flagId)) break; // already opened by this player

        // A real item needs bag room; a "special" gift (item null/unknown) opens
        // with no grant. A full bag leaves the present closed so they can return.
        const itemId = gift.item != null ? String(gift.item) : null;
        const givable = itemId != null && this.GOODS[itemId];
        if (givable && p.inventory.length >= MAX_SLOTS) {
          const now = Date.now();
          if (now - (p._bagFullAt || 0) >= BAG_FULL_NOTICE_MS) {
            p._bagFullAt = now;
            p._ws.send(
              JSON.stringify({ type: 'notice', code: 'bag_full', text: 'Your bag is full!' })
            );
          }
          break;
        }

        set.add(flagId); // mark opened (persists below)
        if (givable) {
          p.inventory.push(itemId);
          p._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(p.inventory) }));
          p._ws.send(
            JSON.stringify({ type: 'loot', item: itemId, name: this.GOODS[itemId].name || '' })
          );
        }
        p._ws.send(JSON.stringify({ type: 'gift_opened', k: msg.k }));
        this._saveCharacter(playerId);
        break;
      }

      case 'spend_points': {
        // Spend banked skill points on the 5 creation stats. SERVER-AUTHORITATIVE:
        // the client only REQUESTS deltas; the server owns the point counter, the
        // alloc, and the derived stats. A request that asks for more than is banked,
        // for an unknown stat, for a negative/fractional amount, or that would blow
        // the cap is rejected wholesale — the client can't grant itself anything.
        const prog = this.points.get(playerId);
        const entry = this.players.get(playerId);
        if (!prog || !entry) break;
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
          if ((prog.alloc[k] || 0) + v > STAT_SPEND_MAX) {
            ok = false;
            break;
          }
          total += v;
        }
        if (!ok || total <= 0 || total > (prog.unspentPoints || 0)) break;

        // Apply on the server side, then re-derive + persist. `prog` (this.points)
        // is the live source of truth; mirror the spent count onto the save handle
        // so its in-memory view stays consistent (alloc is already the SAME object,
        // shared at join).
        for (const k of STAT_KEYS) prog.alloc[k] = (prog.alloc[k] || 0) + (add[k] || 0);
        prog.unspentPoints -= total;
        const spHandle = this.saves.get(playerId);
        if (spHandle) spHandle.unspentPoints = prog.unspentPoints;
        this.reapplyAlloc(entry, prog.alloc);
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
