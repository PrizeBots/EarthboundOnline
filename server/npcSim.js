/**
 * npcSim — server-authoritative NPC simulation, shared by the standalone
 * server (server/index.js) and the Vite-embedded dev server (vite.config.ts).
 *
 * Loads the same npcs.json the clients load (array index = NPC id on the
 * wire) and hot-reloads it when extraction rewrites the file (clients still
 * refresh to pick up props), mirrors the engine's collision math
 * (Collision.ts) and the wander
 * AI that used to live client-side in NPC.ts: outdoor people amble short
 * collision-checked legs leashed to home; indoor people only glance (EB
 * marks counters/furniture walkable, so steps would climb the furniture).
 * Props never move and are never broadcast.
 *
 * Only NPCs within ACTIVE_RADIUS of a connected player simulate. Changes
 * are batched and broadcast at BROADCAST_HZ as:
 *     { type: 'npc_update', npcs: [[id, x, y, direction, frame], ...] }
 * New players get a full divergent-state snapshot via snapshot().
 *
 * Enemy NPCs will reuse this loop: spawn = push an entry with its own AI tag.
 */

const fs = require('fs');
const path = require('path');
const status = require('./status'); // EB status-condition engine (catalog + timer/DoT math)
const { loadShops } = require('./shops'); // item catalog (heal + equip data) so NPCs can USE loot

// --- Map constants (mirror src/types.ts) ---
const MINITILE = 8;
const TILE = 32;
const MAP_W_TILES = 256;
const MAP_H_TILES_BASE = 320; // base overworld height; actual height is data-driven (mapHTiles)
const MAP_W_SECTORS = 32;
const SEC_TX = 8;
const SEC_TY = 4;

// --- AI tuning (mirror the former client NPC.ts values) ---
const SPEED = 0.5;
const LEASH = 32;
const COL_W = 14;
const COL_H = 8;
const COL_OY = -8;

const TICK_HZ = 60;
// NPC/enemy position broadcast rate. Raised 10→20→30→60Hz to MATCH the player
// firehose: a 16ms packet interval gives the adaptive interp buffer ~4-5 packets of
// headroom at an 80ms floor, so enemies stay smooth on a real WAN link instead of
// underrunning (the "jumpy NPCs" report) — a 30Hz/60ms buffer was only ~1.8 packets.
// ~2x the 30Hz NPC firehose bytes — still small at current scale, and the AOI/binary
// overhaul (NETWORK_REMODEL.md) absorbs it as the world grows.
const BROADCAST_HZ = 60;
const ACTIVE_RADIUS = 512; // px from any player

const CARDINALS = [
  { dir: 0, dx: 0, dy: 1 }, // S
  { dir: 1, dx: 0, dy: -1 }, // N
  { dir: 2, dx: -1, dy: 0 }, // W
  { dir: 3, dx: 1, dy: 0 }, // E
];

// --- Combat tuning ---
// Facing unit vectors indexed by Direction (src/types.ts): S,N,W,E,NW,SW,SE,NE.
const DIAG = Math.SQRT1_2;
const DIR_VEC = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
  [-DIAG, -DIAG],
  [-DIAG, DIAG],
  [DIAG, DIAG],
  [DIAG, -DIAG],
];
const ATTACK_REACH = 18; // px the hitbox sits in front of the attacker's feet
const ATTACK_HALF = 12; // half-size of the (square) attack hitbox — widened for
// lag tolerance: you aim at the enemy's ~150ms-old displayed spot, so a bigger
// box catches a fleeing enemy that has moved on by the time the server resolves.
const HURT_W = 14; // enemy hurtbox, anchored on the feet (center-bottom)
const HURT_H = 18;
const HURT_OY = -18;
const ATTACK_DAMAGE = 6;
const CRIT_MULT = 2; // a crit (SMAAAASH!) deals double damage
const ATTACK_COOLDOWN_MS = 250; // baseline min time between a player's resolved attacks (bare-handed)
const ATTACK_COOLDOWN_FLOOR_MS = 120; // fastest a weapon can push the cooldown — anti-machinegun clamp
const HURT_MS = 300; // how long a struck enemy shows its flinch pose

// --- Knockback + stun (combat hit-reactions; server-authoritative) ---
// Every landed, non-miss hit shoves the victim away from the attacker by a
// distance that scales with the damage dealt (so a crit flings harder than a
// chip hit), collision-clamped so nobody is knocked through a wall. In-sim
// actors (enemies/townsfolk) are moved directly; players live on the host, so
// the sim computes the landing spot and hands it back through the hit callback.
// Knockback is PROPORTIONAL to damage — a chip hit barely nudges, a crusher
// flings. There's no flat floor (KB_MIN 0): the old 5px floor meant a 1-damage
// hit still shoved ~6px, so a swarm of weak enemies could push the player all
// over with chip damage. Now 1 dmg ≈ 2px (imperceptible) and it scales from
// there. (Per-entity knockback overrides — a "heavy" boss, a "light" gnat — are
// a future Entity Manager field; this is the global default.)
const KB_MIN = 0; // px — no minimum; a 0-damage (fully-blocked) hit doesn't shove
const KB_MAX = 44; // px — cap so a big/crit hit can't fling across the room
const KB_PER_DMG = 2; // px of knockback per point of damage dealt
const KB_STEP = 4; // px — collision sampling step while sliding the knockback (< MINITILE)
// Status conditions (Paralysis/Numb, Diamond, Sleep, Poison, …) are the EB-derived
// hit-reaction layer. The catalog + all the timer/immunity/DoT math live in
// server/status.js (shared with the host for players); npcSim just rolls procs and
// reads the action-block. Paralysis ("numb") is the old ad-hoc stun — a % proc that
// freezes the victim, capped by a post-effect immunity window so it can't chain into
// a perma-lock. v1 applies it only to in-sim actors (enemies/NPCs); player-side
// status enforcement needs a client input-lock (a follow-up) — players still get
// knocked back. Per-entity proc/resist from the ROM vulnerability table is a TODO.
const PLAYER_PARALYSIS_CHANCE = 12; // % a player's landed hit paralyzes its target (per-weapon: TODO)
const ENEMY_PARALYZE_CHANCE = 8; // % an enemy's landed hit paralyzes the player it struck (per-entity: TODO)

// Knockback distance for a hit that dealt `dmg` damage: linear in damage
// (KB_PER_DMG px each), clamped to [KB_MIN, KB_MAX]. e.g. 1→2px, 7→14px,
// 14 (crit)→28px, capped at 44.
function knockDist(dmg) {
  return Math.max(KB_MIN, Math.min(KB_MAX, dmg * KB_PER_DMG));
}

// --- Mass / weight class (level-driven push + knockback resistance) ---
// Every actor AND player carries a `mass` derived from its level: heavier things
// shove lighter ones aside on contact (walk-push) and resist being knocked back.
// EQUAL mass reproduces the old behavior exactly (50/50 separation, full
// knockback), so a fair same-level fight is unchanged — only a level GAP creates
// asymmetry. A per-entity `mass` override (Entity Manager field: TODO) wins over
// the curve, so a level-2 boss can still be authored heavy / a big gnat light.
const MASS_PER_LEVEL = 1; // mass = 1 + level*this; level 2 → 3, level 12 → 13
function massOf(a) {
  if (a && typeof a.mass === 'number' && a.mass > 0) return a.mass;
  const lvl = a && typeof a.level === 'number' ? a.level : 1;
  return 1 + Math.max(0, lvl) * MASS_PER_LEVEL;
}
// Knockback scale from the attacker/victim mass ratio. A hit from something your
// own weight shoves you the full (damage-proportional) distance; a much heavier
// attacker flings a lighter victim toward the cap, a much lighter attacker barely
// budges a heavy victim. Equal mass → 1 (UNCHANGED), so this never detunes a fair
// fight — only a lopsided one. Returns 1 when either mass is missing (vehicle /
// legacy / test callers) so their tuned knockback is untouched.
const KB_MASS_FLOOR = 0.15; // a featherweight attacker still nudges a heavy victim a little
const KB_MASS_CEIL = 2.0; // cap the bonus a heavyweight gets vs a gnat (final dist still ≤ KB_MAX)
function massKnockScale(attMass, vicMass) {
  if (!(attMass > 0) || !(vicMass > 0)) return 1;
  return Math.max(KB_MASS_FLOOR, Math.min(KB_MASS_CEIL, (2 * attMass) / (attMass + vicMass)));
}

// --- Enemy aggression (Heavy) ---
// Enemies have a level (set from the spawner / a default) and so do players, so
// a future EarthBound-style "flee if you out-level it" rule can hook in here.
// Aggro is conditional on the LEVEL GAP (EarthBound's "weak enemies flee you"):
// an enemy whose level a nearby player at least DOUBLES will not chase or attack
// that player — it FLEES, and a touch from that player is an instant win (full
// XP/loot, no fight). Otherwise aggro is unconditional: it chases and hits the
// nearest living player it can see. `outLevels(player, enemy)` is the gate.
const DEFAULT_ENEMY_LEVEL = 4;
const FLEE_LEVEL_RATIO = 2; // player.level >= ratio * enemy.level → enemy flees
const FLEE_TOUCH_RADIUS = 18; // px between feet — a scarer this close auto-wins
function outLevels(player, n) {
  return player && player.level != null && player.level >= FLEE_LEVEL_RATIO * (n.level || 1);
}
const DETECT_RANGE = 220; // px — default aggro radius; per-SPAWNER `detectRange` (Enemy Spawner tool) overrides it
// Once an enemy has LOCKED ON it does not give up at the detect radius — it
// pursues relentlessly (no home-distance leash) until the target gets this far
// away (or the enemy dies), then it turns back and paths home. Hysteresis:
// acquire at detectRange, drop only past this larger give-up distance. Per-SPAWNER
// `giveUpRange` (Enemy Spawner tool) overrides it; never smaller than detectRange.
const GIVE_UP_RANGE = 560; // px — chase breaks off when the target exceeds this
const ATTACK_RANGE = 24; // px — enemy must be this close to land a hit
const ENEMY_CHASE_SPEED = 1.3; // px/frame while pursuing. Tuned just UNDER a fresh
// player's baseline walk (~1.56 px/f at Speed 8, SPEED_BASE=1.0 in gameHost.js) so an
// unallocated character can just barely outrun a chaser, and points spent on Speed
// widen the lead. Re-tune together with the player SPEED_* constants — keep this below
// moveSpeedFor(BASE_STATS.speed) or fresh players can't escape.
const ENEMY_ATTACK_COOLDOWN_MS = 700; // min time between one enemy's swings
const ENEMY_ATTACK_POSE_MS = 250; // how long the swing pose shows
const ENEMY_DAMAGE = 7; // HP per landed hit
const DEFAULT_ENEMY_XP = 5; // EXP a kill grants the killer (spawners override)
// Default crit/dodge % when none is authored: 0 for ALL kinds. crit/dodge are
// honored when set on the entity (Entity Manager) or instance, but no unauthored
// actor silently gains them — preserves existing combat feel. KEEP IN SYNC with
// EntityStats.ts DEFAULT_ENTITY_STATS (crit/dodge).
const DEFAULT_ENEMY_CRIT = 0;
const DEFAULT_ENEMY_DODGE = 0;

// --- Pursuit steering (anti-clump + obstacle routing) ---
// Separation spreads pursuers around the target instead of stacking; angled
// steering lets a blocked enemy fan out around a wall/each other rather than
// stalling in a line. STEER_ANGLES (radians) are tried in order — straight
// first, then alternating left/right by widening angles.
const SEP_RADIUS = 24; // px — other actors within this push the enemy away
const SEP_WEIGHT = 0.8; // separation strength vs the (unit) pursue vector
const STEER_ANGLES = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4];

// --- Pursuit into buildings + regroup-at-spawn ---
// Player movement is client-reported (server/index.js just records msg.x/msg.y),
// and the client warps a player through a door by setting its own coords — so a
// door warp reaches us as a one-tick jump in the reported position. Enemies use
// that to follow a player they're chasing through the door, then once they lose
// the target they retrace their way out and head back to the spawn point.
const WARP_DELTA = 96; // a one-tick player jump bigger than this is a door warp (players move ~2px/tick)
const WARP_FOLLOW_RANGE = DETECT_RANGE; // an enemy this close to the door the player took follows it through
// A detected warp stays followable for this long, NOT just the one tick it
// fired on. The client freezes a player's reported position for the whole door
// fade, so a chasing enemy reaches the doorway and is usually mid-swing at the
// frozen player when the warp finally lands — a single-tick window dropped the
// follow ~1/3 of the time (the enemy was inside its attack/hurt pose, which
// early-returns tickEnemy). The window lets it take the follow once its pose
// clears, and outlasts a townsperson briefly stealing aggro at the doorway.
const WARP_FOLLOW_MS = 900;
const RETURN_ARRIVE = 24; // px from the spawn point / a retraced door counted as "arrived"
const RETURN_GIVEUP_MS = 8000; // can't path back in this long -> snap to spawn so the pack always regroups
// Enemies/NPCs use doors like players: instead of teleporting across the room
// the instant the player warps, a chaser walks to the doorway and warps through
// on contact. Once it commits to a door it heads there at its normal pace even
// after the player's warp record expires.
const DOOR_TRIGGER_REACH = 12; // px from the doorway feet-anchor that warps a chaser through
const DOOR_GIVEUP_MS = 6000; // can't reach the doorway in this long -> give up and regroup

// --- NPC self-defense (townsfolk fight back) ---
// Every 'person' can defend itself: it HOLDS GROUND (never chases) and swings at
// any living enemy within NPC_DETECT_RANGE — "defend on sight", no first hit
// required. Players ALWAYS take targeting priority for enemies, so an enemy only
// turns on townsfolk when no player is in range (see aggroTarget). A downed
// townsperson hides (hp 0) and revives at its home spot after a delay (backlog:
// a hospital / per-entity chosen respawn point + personality flags in the
// Entity Manager). Whether an NPC may damage an enemy still goes through canHurt.
const NPC_HP = 30; // townsfolk max HP (matches client Entity default)
const NPC_DAMAGE = 5; // HP an NPC's swing takes off an enemy
const NPC_DETECT_RANGE = 96; // px — an enemy this close makes an NPC defend
const NPC_ATTACK_RANGE = 24; // px — NPC must be this close to land a hit
const NPC_ATTACK_COOLDOWN_MS = 800; // min time between one townsperson's swings
const NPC_ATTACK_POSE_MS = 250; // how long the NPC's swing pose shows
const NPC_RESPAWN_MS = 12000; // a downed townsperson revives at home after this

// --- NPC combat personality (lifelike movement under threat) ---
// Townsfolk no longer freeze and trade blows in place. Each one has a combat
// personality (assigned per sprite group in the Entity Manager; unassigned ones
// get a stable seeded pick so a crowd reacts diversely):
//   brave      — close in and press the attack like a guard
//   skirmisher — dart in to swing, then back off / sidestep (hit-and-run)
//   coward     — run from the enemy; only swing when cornered
//   nervous    — keep swinging but shuffle restlessly in place
//   pursuer    — COP: lock on and chase the bad guy down (no home leash),
//                holding the chase out to giveUpRange before walking home
// KEEP IN SYNC with src/engine/EntityStats.ts CombatPersonality.
// SEEDED set = what an UNASSIGNED townsperson randomly gets (a varied crowd).
// 'pursuer' is deliberately excluded — a cop is opt-in per entity, never random.
const COMBAT_PERSONALITIES = ['brave', 'skirmisher', 'coward', 'nervous'];
// Every personality an entity may be AUTHORED as (the seeded set + opt-in pursuer).
const VALID_PERSONALITIES = [...COMBAT_PERSONALITIES, 'pursuer'];
const NPC_COMBAT_SPEED = 0.8; // px/tick while maneuvering in a fight (wander is 0.5)
const NPC_FLEE_SPEED = 1.1; // a fleeing coward moves with real urgency
const NPC_COMBAT_LEASH = 112; // px from home a fighter may range while engaged
const NPC_FLEE_LEASH = 220; // a coward may run further before the home leash bites
// When an NPC hits an enemy, the enemy remembers its attacker this long and (if
// no player is in range — players keep priority) turns to retaliate against it.
const ENEMY_AGGRO_MEMORY_MS = 4000;

// --- Vehicles (Entity Manager `vehicle` flag) ---
// A vehicle is a friendly, autonomous actor (kind 'person', so it carries HP +
// a health bar + is destructible). It roams like an NPC, but HUNTS foes (enemies
// + PKers), and instead of a melee swing it has ONE attack: it just collides.
// On body-contact it deals its damage with a much larger, *scattered* knockback
// (forward + sideways variance) that plows foes out of the way; friendlies take
// no damage but are nudged minimally aside so the plow never stalls. Vehicle
// movement is wall-only (it drives THROUGH the crowd), which is what sells it.
const VEHICLE_DAMAGE = 14; // HP per collide (heavy — the whole point of a car)
const VEHICLE_HIT_COOLDOWN_MS = 450; // min ms between collide-hits on the same victim
const VEHICLE_KB_MULT = 2.6; // plow knockback force vs a normal same-damage hit
const VEHICLE_KB_VARIANCE = 0.9; // ±rad (~50°) random spread so a pack scatters
const VEHICLE_FRIENDLY_KB = 6; // px gentle shove that clears a friendly from the lane
const VEHICLE_HP = 80; // default max HP if the Entity Manager set none

// Pose -> wire code, indexing POSES in src/types.ts: walk,climb,attack,hurt.
// Broadcast in npc_update rows so every client sees the same animation pose.
const POSE_CODE = { walk: 0, climb: 1, attack: 2, hurt: 3 };
function poseCode(n) {
  return POSE_CODE[n.pose] || 0;
}
const STATIC_RESPAWN_MS = 12000; // ROM-placed enemies revive at home after this
const ENEMY_SPEED = 0.6; // roamers move a touch faster than ambling townsfolk
// Chase speed scales with the spawner's wander speed by this ratio, so the
// per-spawner `speed` field controls both (chase stays proportionally faster).
const CHASE_RATIO = ENEMY_CHASE_SPEED / ENEMY_SPEED;
const ENEMY_FILE = 'map/enemy_spawns.json';

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// --- PK (player-kill) damage model — the single source of truth for "can A
// hurt B". Every combatant carries a `pk` flag: enemies are always pk:true,
// townsfolk NPCs pk:false, players pk:false for now (a per-player toggle is
// backlogged; see TODO). `isEnemy` distinguishes the AI mobs from people.
//
// Rules (attacker -> who it can damage):
//   - Enemies hurt every non-enemy (NPCs, players, PK players) but NEVER each
//     other.
//   - PK players hurt EVERYTHING, including other PKers and enemies.
//   - Non-PK players and NPCs hurt only PKers (PK players + enemies), so two
//     non-PKers can't friendly-fire each other.
// Pass plain {isEnemy, pk} shapes — players live on the host, not in npcSim, so
// the host builds an attacker shape from its own player record.
function canHurt(attacker, target) {
  if (!attacker || !target || attacker === target) return false;
  if (attacker.isEnemy) return !target.isEnemy; // enemies hurt all non-enemies
  if (attacker.pk) return true; // PK players hurt everything
  return !!target.pk; // others hurt only PKers
}

/**
 * Resolve one landed melee swing's outcome, independent of geometry (the caller
 * already confirmed the hitbox connects). Order matters: DODGE is rolled FIRST
 * (a dodge beats a would-be crit), then CRIT. `critChance`/`dodgeChance` are
 * percentages (0..100); `rng()` returns [0, 1). Pure + injectable-rng so combat
 * is deterministically testable (see combat.test.js).
 */
function resolveMelee(critChance, dodgeChance, base, rng) {
  if (rng() * 100 < dodgeChance) return { miss: true, crit: false, dmg: 0 };
  if (rng() * 100 < critChance) return { miss: false, crit: true, dmg: base * CRIT_MULT };
  return { miss: false, crit: false, dmg: base };
}

function createNpcSim(assetsDir, rngFn = Math.random) {
  // Injectable RNG: production uses Math.random; tests pass a fixed function so
  // crit/dodge rolls are deterministic.
  const rng = typeof rngFn === 'function' ? rngFn : Math.random;
  // The broadcast fn, captured in start() — handleAttack uses it to push crit/
  // miss events. Null until start() runs (combat.test.js drives handleAttack
  // without start(), so every use is guarded).
  let broadcastCb = null;
  const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(assetsDir, rel), 'utf8'));

  // Item catalog keyed by numeric-string id ({name, heal, equip:{slot,offense,
  // defense,…}|null}) — the SAME data gameHost validates player use/equip against.
  // Read-only here; lets townsfolk actually USE the loot they pick up (heal when
  // hurt, equip weapons/armor). Enemies never use items (see tickNpc caller).
  let GOODS = {};
  try {
    GOODS = loadShops(assetsDir).goods || {};
  } catch {
    GOODS = {}; // no shops.json (tests without a catalog) — NPCs just hoard + drop
  }
  const goodFor = (item) => GOODS[String(item)] || null;

  // Core world data (ROM-derived). In production these live on a mounted disk,
  // never in git (ROM-distribution policy; see ARCHITECTURE.md "Production data").
  // If they're absent — a code-only deploy before the data disk is attached —
  // DON'T crash the whole server: run as a RELAY-ONLY sim so multiplayer
  // (join/move/chat) still works, just with no NPC/enemy/collision simulation.
  let sectors, tiles, tilesetMapping;
  try {
    sectors = readJSON('map/sectors.json');
    tiles = readJSON('map/tiles.json');
    tilesetMapping = readJSON('map/tileset_mapping.json');
  } catch (e) {
    console.warn(
      `[npcSim] world data missing (${e.code || e.message}) — running RELAY-ONLY ` +
        '(no NPCs/enemies/collision). Attach the assets disk to enable the world.'
    );
    return {
      start() {},
      stop() {},
      bounds: () => ({ w: MAP_W_TILES * TILE, h: MAP_W_TILES * TILE }),
      snapshot: () => [],
      hpSnapshot: () => [],
      equipSnapshot: () => [],
      dropsSnapshot: () => [],
      handleAttack: () => {},
      psiStrike: () => null,
      psiStrikeAll: () => null,
      spawnMoneyDrop: () => {},
      spawnCashFountain: () => [],
      noteRespawn: () => {},
      noteEditorExit: () => {},
      noteTeleport: () => {},
      wallBetween: () => false,
      doorAt: () => null,
      stairAt: () => false,
    };
  }
  // The ROM overworld is the base; the Room Manager's custom rooms are stamped
  // into a BAND below it (bandY >= base height) — exactly like the client's
  // MapManager.buildCustomRoomBand. The server MUST mirror this or every enemy/
  // NPC placed in a custom room sits below the server's world, reads as
  // out-of-bounds solid (blocked), and freezes — it can neither sense players
  // (canSense) nor wander. Player movement is client-side, so the player walks
  // there fine while the server thinks it's void. KEEP IN SYNC with MapManager.
  const baseTiles = tiles; // never mutated — the band is re-stamped over a copy
  const baseSectors = sectors;
  const baseHTiles = Math.round(baseTiles.length / MAP_W_TILES);
  const baseHSectors = Math.round(baseSectors.length / MAP_W_SECTORS);
  // Map height is data-driven (grows with the stamped band). Width fixed at 256.
  let mapHTiles = baseHTiles;
  const DEFAULT_BAND_SECTOR = {
    tilesetId: 0,
    paletteId: 0,
    musicId: 0,
    indoor: false,
    dungeon: false,
  };
  // Composite-tile registry (id >= COMPOSITE_BASE → 16 packed minitile refs).
  // Custom rooms can author sub-tile detail; each composite cell's collision is
  // assembled from its source minitiles' own bytes. KEEP IN SYNC with
  // CompositeTiles.ts / CustomTiles.ts (the ref packing + base offsets).
  const COMPOSITE_BASE = 1_000_000;
  const CUSTOM_REF_BASE = 100_000_000;
  const composites = new Map();
  const unpackRef = (n) => {
    const mi = n % 16;
    let r = (n - mi) / 16;
    const arr = r % 1024;
    r = (r - arr) / 1024;
    const pal = r % 16;
    const ts = (r - pal) / 16;
    return { ts, pal, arr, mi };
  };
  const ROOMS_OV_PATH = path.join(assetsDir, '..', 'overrides', 'rooms.json');
  // Per-map-cell tile override (Room Builder "Edit map" → overrides/map_tiles.json).
  // Mirrors the client (MapManager.buildCustomRoomBand): replaces the arrangement
  // at specific cells of ANY room. Applied LAST in buildRoomBand so it wins over
  // the ROM base + band; blocked() reads tiles[] so collision follows for free.
  const MAP_TILES_OV_PATH = path.join(assetsDir, '..', 'overrides', 'map_tiles.json');
  // Re-stamp the custom-room band over a fresh copy of the ROM base (idempotent —
  // never double-stamps). Grows tiles/sectors to fit the lowest room, writes each
  // room's arrangement cells + sector style, and registers its composites.
  function buildRoomBand() {
    tiles = baseTiles.slice();
    sectors = baseSectors.slice();
    composites.clear();
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(ROOMS_OV_PATH, 'utf8'));
    } catch {
      doc = null; // no rooms authored — overworld only
    }
    const custom = (doc && doc.rooms) || [];
    let hSectors = baseHSectors;
    for (const r of custom) hSectors = Math.max(hSectors, Math.ceil((r.bandY + r.h) / SEC_TY));
    const hTiles = hSectors * SEC_TY;
    for (let i = tiles.length; i < hTiles * MAP_W_TILES; i++) tiles.push(0);
    for (let i = sectors.length; i < hSectors * MAP_W_SECTORS; i++)
      sectors.push({ ...DEFAULT_BAND_SECTOR });
    for (const r of custom) {
      for (let ly = 0; ly < r.h; ly++) {
        for (let lx = 0; lx < r.w; lx++) {
          tiles[(r.bandY + ly) * MAP_W_TILES + (r.bandX + lx)] =
            (r.tiles && r.tiles[ly * r.w + lx]) || 0;
        }
      }
      const s0x = Math.floor(r.bandX / SEC_TX);
      const s1x = Math.floor((r.bandX + r.w - 1) / SEC_TX);
      const s0y = Math.floor(r.bandY / SEC_TY);
      const s1y = Math.floor((r.bandY + r.h - 1) / SEC_TY);
      for (let sy = s0y; sy <= s1y; sy++) {
        for (let sx = s0x; sx <= s1x; sx++) sectors[sy * MAP_W_SECTORS + sx] = { ...r.sector };
      }
      for (const [id, refs] of Object.entries(r.composites || {})) composites.set(Number(id), refs);
    }
    // Per-map-cell tile override, applied last (wins over base + band).
    let mapOv = null;
    try {
      mapOv = JSON.parse(fs.readFileSync(MAP_TILES_OV_PATH, 'utf8'));
    } catch {
      mapOv = null;
    }
    if (mapOv && mapOv.cells) {
      for (const [k, arr] of Object.entries(mapOv.cells)) {
        const [tx, ty] = k.split(',').map(Number);
        const i = ty * MAP_W_TILES + tx;
        if (i >= 0 && i < tiles.length) tiles[i] = arr;
      }
    }
    if (mapOv && mapOv.composites) {
      for (const [id, refs] of Object.entries(mapOv.composites)) composites.set(Number(id), refs);
    }
    mapHTiles = hTiles;
  }
  buildRoomBand();
  // Collision byte of one minitile (idx 0-15) of a composite cell — assembled
  // from its source minitile's own tileset collision (mirrors Collision.ts
  // compositeRow). Empty/custom refs default to walkable (0).
  function compositeByte(arr, idx) {
    const refs = composites.get(arr);
    if (!refs) return 0;
    const n = refs[idx] ?? -1;
    if (n < 0 || n >= CUSTOM_REF_BASE) return 0;
    const ref = unpackRef(n);
    const c = collisionByDrawTs.get(tilesetMapping[ref.ts] ?? 0);
    if (c && ref.arr < c.length) return c[ref.arr][ref.mi] ?? 0;
    return 0;
  }
  const collisionByDrawTs = new Map();
  // Per-map-tile collision overrides (overrides/collision.json `cells`):
  // tileY*MAP_W_TILES+tileX -> { minitileIdx: byte }. Applied on top of the
  // arrangement byte in blocked(). KEEP IN SYNC with Collision.ts.
  const cellOv = new Map();

  // Collision = extracted base + editor overrides (public/overrides/
  // collision.json, per-arrangement "drawTs:arr" -> {minitileIdx: byte}).
  // KEEP IN SYNC with Collision.ts applyOverridesTo and the py room checker.
  // Re-run on override change so painted walls bind NPC wander too.
  const COLLISION_OV_PATH = path.join(assetsDir, '..', 'overrides', 'collision.json');
  function loadCollisionWithOverrides() {
    for (const drawTs of new Set(tilesetMapping)) {
      try {
        collisionByDrawTs.set(drawTs, readJSON(`tilesets/${drawTs}/collisions.json`));
      } catch {
        // No collision data extracted for this tileset — treated as solid.
      }
    }
    cellOv.clear();
    let ov = null;
    try {
      ov = JSON.parse(fs.readFileSync(COLLISION_OV_PATH, 'utf8'));
    } catch {
      return; // nothing authored yet
    }
    for (const [key, cells] of Object.entries((ov && ov.edits) || {})) {
      const [ts, arr] = key.split(':').map(Number);
      const data = collisionByDrawTs.get(ts);
      if (!data || arr >= data.length) continue;
      for (const [idx, byte] of Object.entries(cells)) data[arr][Number(idx)] = byte;
    }
    // Per-map-tile overrides win over the arrangement byte for that one cell.
    for (const [tk, idxMap] of Object.entries((ov && ov.cells) || {})) {
      const [tx, ty] = tk.split(',').map(Number);
      cellOv.set(ty * MAP_W_TILES + tx, idxMap);
    }
    console.log('[npcSim] applied collision overrides');
  }
  loadCollisionWithOverrides();
  fs.watchFile(COLLISION_OV_PATH, { interval: 2000 }, loadCollisionWithOverrides);

  function sectorForTile(tx, ty) {
    const sx = Math.floor(tx / SEC_TX);
    const sy = Math.floor(ty / SEC_TY);
    if (sx < 0 || sx >= MAP_W_SECTORS) return null;
    return sectors[sy * MAP_W_SECTORS + sx] || null;
  }

  // Mirror of Collision.ts checkCollision
  function blocked(x, y, w, h) {
    if (x < 0 || y < 0) return true;
    if (x + w >= MAP_W_TILES * TILE || y + h >= mapHTiles * TILE) return true;
    const x0 = Math.floor(x / MINITILE);
    const y0 = Math.floor(y / MINITILE);
    const x1 = Math.floor((x + w - 1) / MINITILE);
    const y1 = Math.floor((y + h - 1) / MINITILE);
    for (let my = y0; my <= y1; my++) {
      for (let mx = x0; mx <= x1; mx++) {
        const tx = Math.floor(mx / 4);
        const ty = Math.floor(my / 4);
        const sector = sectorForTile(tx, ty);
        if (!sector) return true;
        const arr = tiles[ty * MAP_W_TILES + tx] ?? 0;
        const idx = (my % 4) * 4 + (mx % 4);
        let byte;
        if (arr >= COMPOSITE_BASE) {
          // Custom-room composite cell: collision is per-source-minitile.
          byte = compositeByte(arr, idx);
        } else {
          const cols = collisionByDrawTs.get(tilesetMapping[sector.tilesetId] ?? 0);
          if (!cols) return true;
          byte = arr < cols.length ? cols[arr][idx] : 0;
        }
        const ov = cellOv.get(ty * MAP_W_TILES + tx);
        if (ov && ov[idx] !== undefined) byte = ov[idx]; // per-cell override wins
        if ((byte & 0x80) !== 0) return true;
      }
    }
    return false;
  }

  // True if a solid wall sits on the straight line between two actors' foot
  // positions. Melee can't reach through walls — this gates every swing
  // (player→enemy in handleAttack, enemy→player/NPC in tickEnemy, NPC→enemy in
  // tickNpcCombat). Samples the collision grid at sub-minitile steps so even a
  // one-tile-thick wall between the bodies blocks the hit. Endpoints are skipped:
  // an actor pressed flush against a wall must still be hittable from the open side.
  function wallBetween(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < MINITILE) return false; // adjacent — no wall can fit between them
    const steps = Math.ceil(dist / 4); // 4px < MINITILE(8): no wall slips through
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = x0 + dx * t;
      const py = y0 + dy * t + COL_OY; // sample at foot-box height, where walls block
      if (blocked(px, py, 1, 1)) return true;
    }
    return false;
  }

  // --- Door triggers (mirror src/engine/DoorManager.ts loadDoors) ---
  // So enemies/NPCs chase players THROUGH doors the way players use them: walk to
  // the doorway and warp on contact, never teleport across a room. We only need
  // each ACTIVE door's trigger position here — the warp destination comes from
  // the chased player's observed landing spot. KEEP IN SYNC with DoorManager:
  // trigger anchoring, flag gating, the zone-door skip, and the overrides layer.
  const DOOR_GRID_COLS = 32;
  const DOOR_AREA_PX = 256;
  const DOORS_FILE = 'map/doors.json';
  const DOORS_OV_PATH = path.join(assetsDir, '..', 'overrides', 'doors.json');
  // getDoorAt tests the player's MIDSECTION (feet - 12) against the anchor, so a
  // body's feet trigger a door at worldY + 12.
  const DOOR_FOOT_OFFSET = 12;
  let WORLD_SET_FLAGS = new Set();
  try {
    const wf = JSON.parse(
      fs.readFileSync(path.join(assetsDir, '..', '..', 'src', 'world_flags.json'), 'utf8')
    );
    WORLD_SET_FLAGS = new Set((wf.setFlags || []).map((f) => parseInt(f, 16)));
  } catch {
    /* no flag file — every flag-gated door is treated as usable */
  }
  // EB doors carry an event-flag condition: plain flag = usable while SET, the
  // 0x8000 bit = usable while UNSET (mirror of DoorManager.isDoorActive).
  function isDoorActive(flag) {
    if (!flag) return true;
    const needSet = (flag & 0x8000) === 0;
    return needSet === WORLD_SET_FLAGS.has(flag & 0x7fff);
  }
  let doorTriggers = []; // [{x, y}] feet positions that warp a body through
  let stairTriggers = []; // [{x, y}] escalator/stairway trigger centers (ride gate)

  function loadDoorTriggers() {
    let raw;
    try {
      raw = readJSON(DOORS_FILE);
    } catch {
      doorTriggers = [];
      return;
    }
    let ov = null;
    try {
      ov = JSON.parse(fs.readFileSync(DOORS_OV_PATH, 'utf8'));
    } catch {
      /* none authored */
    }
    const edits = (ov && ov.edits) || {};
    const additions = (ov && ov.additions) || [];
    const out = [];
    const stairs = [];
    raw.forEach((area, idx) => {
      const originX = (idx % DOOR_GRID_COLS) * DOOR_AREA_PX;
      const originY = Math.floor(idx / DOOR_GRID_COLS) * DOOR_AREA_PX;
      for (const d of area) {
        // Escalator/stairway trigger (incl. NOWHERE far-landing): record its
        // center so we can validate a player really is on an escalator before
        // honoring their client-driven ride warp (mirror DoorManager stair load).
        if (d.type === 'stair') {
          stairs.push({
            x: originX + d.x * MINITILE + MINITILE / 2,
            y: originY + d.y * MINITILE + MINITILE / 2,
          });
          continue;
        }
        if (d.type !== 'door') continue;
        if (!isDoorActive(d.flag || 0)) continue;
        const baseX = originX + d.x * MINITILE + MINITILE;
        const baseY = originY + d.y * MINITILE + 4;
        const destPx = (d.destX || 0) * MINITILE;
        const destPy = (d.destY || 0) * MINITILE;
        // style=0 short-range zone doors warp onto themselves unless an override
        // links them somewhere real — skip the unlinked ones (DoorManager does).
        const zone =
          (d.style || 0) === 0 &&
          Math.abs(destPx - (baseX - MINITILE)) + Math.abs(destPy - (baseY - 4)) < 128;
        const o = edits[`${baseX},${baseY}`];
        if (o === null) continue; // override-disabled door
        if (zone && !o) continue; // zone door with no authored link
        const wx = o && o.worldX != null ? o.worldX : baseX;
        const wy = o && o.worldY != null ? o.worldY : baseY;
        // Keep the DESTINATION too (override wins, mirroring DoorManager). Lets a
        // regrouping enemy that got lured into a building walk out the door under
        // its own power — see exitDoorToward — instead of waiting to retrace a
        // chase path it may not have (warpStack).
        const destX = o ? o.destX : destPx;
        const destY = o ? o.destY : destPy;
        out.push({ x: wx, y: wy + DOOR_FOOT_OFFSET, destX, destY });
      }
    });
    for (const a of additions)
      out.push({ x: a.worldX, y: a.worldY + DOOR_FOOT_OFFSET, destX: a.destX, destY: a.destY });
    doorTriggers = out;
    stairTriggers = stairs;
    console.log(`[npcSim] loaded ${out.length} door triggers, ${stairs.length} stair triggers`);
  }
  loadDoorTriggers();
  fs.watchFile(path.join(assetsDir, DOORS_FILE), { interval: 2000 }, loadDoorTriggers);
  fs.watchFile(DOORS_OV_PATH, { interval: 2000 }, loadDoorTriggers);

  // Nearest door trigger to (x,y) within DOOR_MATCH_RADIUS, or null. A warping
  // player's last pre-warp position sits on the trigger it stepped through, so
  // this tells a chaser which doorway to walk to and warp through.
  const DOOR_MATCH_RADIUS = 28;
  function resolveDoor(x, y) {
    let best = null;
    let bestD = DOOR_MATCH_RADIUS;
    for (const t of doorTriggers) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d <= bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // True if a DOORWAY sits between (x0,y0) and (x1,y1) — i.e. they're on opposite
  // sides of a room boundary whose gap has no solid wall (so wallBetween misses
  // it). Combat treats this like a wall: an enemy must come THROUGH the door
  // (where it's visible in your room) rather than reach across the seam — which
  // the client's room crop hides, reading as an "invisible attacker". Sampled on
  // the segment INTERIOR so merely standing on a door doesn't count; the radius
  // is tight so a same-room fight beside a door still lands.
  const DOOR_BARRIER_R = 16;
  function doorBetween(x0, y0, x1, y1) {
    if (!doorTriggers.length) return false;
    for (const t of [0.35, 0.5, 0.65]) {
      const sx = x0 + (x1 - x0) * t;
      const sy = y0 + (y1 - y0) * t;
      for (const d of doorTriggers) {
        if (Math.abs(d.x - sx) <= DOOR_BARRIER_R && Math.abs(d.y - sy) <= DOOR_BARRIER_R) {
          return true;
        }
      }
    }
    return false;
  }

  // True if (x,y) sits in an interior (indoor/dungeon) sector — the same flag
  // buildNpcs stamps an actor's `indoor` from. Used to tell when an enemy is
  // currently standing inside a room, vs out in the door-stitched overworld.
  function sectorIndoorAt(x, y) {
    const s = sectorForTile(Math.floor(x / TILE), Math.floor(y / TILE));
    return !!(s && s.indoor);
  }

  // Pick the door an enemy `n` should walk out of to head home: a real door
  // whose far side lands CLOSER to home than the enemy stands now (so we never
  // pick the door we came in through), preferring exits that empty into the
  // outdoors and, among those, the nearest doorway to actually walk to. Null if
  // nothing leads homeward (caller then just walks home / times out). The door's
  // stored destination (loadDoorTriggers) is what makes this possible without a
  // recorded chase path.
  function exitDoorToward(n) {
    const homeD = Math.hypot(n.x - n.homeX, n.y - n.homeY);
    let best = null;
    let bestScore = Infinity;
    for (const t of doorTriggers) {
      if (t.destX == null) continue;
      const destHomeD = Math.hypot(t.destX - n.homeX, t.destY - n.homeY);
      if (destHomeD >= homeD) continue; // doesn't take us nearer home — skip
      const indoorDest = sectorIndoorAt(t.destX, t.destY) ? 1 : 0;
      // Outdoor-landing doors first; then the nearest doorway we can walk to.
      const score = indoorDest * 1e6 + Math.hypot(n.x - t.x, n.y - t.y);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  // --- Enemy config (our own content — see public/assets/map/enemy_spawns.json) ---
  // The Enemy Spawner editor writes the WHOLE file to the overrides layer; it
  // wins over the committed default. KEEP IN SYNC with NPCManager.loadNPCs —
  // both build the same pool (disabled spawners skipped) so wire ids align.
  const ENEMY_OV_PATH = path.join(assetsDir, '..', 'overrides', 'enemy_spawns.json');
  function loadEnemyCfg() {
    try {
      return JSON.parse(fs.readFileSync(ENEMY_OV_PATH, 'utf8'));
    } catch {
      /* no override authored — fall back to the committed default */
    }
    try {
      return readJSON(ENEMY_FILE);
    } catch {
      return null; // no enemies if neither file is present
    }
  }

  // The UNIVERSAL entity master table (per sprite-group stats for EVERY kind —
  // person/prop/enemy/car), authored in the Entity Manager. It used to live
  // inside enemy_spawns.json under `entities`, but that file is really the
  // ENEMY-SPAWNER config (spawners + enemy classification); the entity table is
  // its own concern, so it now lives in overrides/entities.json. Back-compat:
  // fall back to enemy_spawns.json `entities` for saves made before the split.
  // KEEP IN SYNC with src/engine/NPCManager.ts (loadNPCs reads the same pair).
  const ENTITIES_OV_PATH = path.join(assetsDir, '..', 'overrides', 'entities.json');
  function loadEntities() {
    try {
      const d = JSON.parse(fs.readFileSync(ENTITIES_OV_PATH, 'utf8'));
      if (d && d.entities) return d.entities;
    } catch {
      /* no entities.json yet — fall through to the legacy location */
    }
    const cfg = loadEnemyCfg();
    return (cfg && cfg.entities) || {};
  }
  // ROM-derived enemy catalog (tools/extract_enemies.py -> assets/map/enemies.json):
  // the DEFAULTS layer of per-entity stats, keyed by sprite id. Merged UNDER the
  // authored enemy_spawns.json `entities`. Rarely changes (re-extracted from ROM),
  // so it's loaded once, not file-watched. KEEP merge order IN SYNC with
  // src/engine/NPCManager.ts: DEFAULT < catalog (ROM) < entities (authored).
  const ENEMY_CAT_PATH = path.join(assetsDir, 'map', 'enemies.json');
  function loadEnemyCatalog() {
    try {
      return JSON.parse(fs.readFileSync(ENEMY_CAT_PATH, 'utf8'));
    } catch {
      return null; // no catalog extracted — runtime falls back to authored/defaults
    }
  }
  const enemyCatalog = loadEnemyCatalog();

  // Effective per-entity stats = catalog (ROM defaults) overlaid by the authored
  // entity table. Rebuilt whenever entities.json changes (reloadEntities).
  function buildEntityDefs(entities) {
    const cat = (enemyCatalog && enemyCatalog.bySprite) || {};
    const file = entities || {};
    const out = {};
    for (const k of new Set([...Object.keys(cat), ...Object.keys(file)])) {
      out[k] = Object.assign({}, cat[k], file[k]);
    }
    return out;
  }

  // `let` so the file watch can swap them in live.
  let enemyCfg = loadEnemyCfg();
  let entityDefs = buildEntityDefs(loadEntities());
  // Sprites auto-classified as enemies regardless of placement kind (backward
  // compat with placements authored before 'enemy' was a first-class kind).
  // NOTE: intentionally NOT every catalog sprite — only the authored list — so
  // adding 77 ROM enemies to the catalog doesn't silently turn existing NPC
  // placements hostile. New enemies are placed via kind:'enemy' (PlacementTool).
  let ENEMY_SPRITES = new Set((enemyCfg && enemyCfg.enemySpriteGroups) || []);
  let SPAWNERS = ((enemyCfg && enemyCfg.spawners) || []).filter((s) => s.enabled !== false);
  let STATIC_ENEMY_HP = (SPAWNERS[0] && SPAWNERS[0].hp) || 24;

  // Item-container sprites (presents 195, trash cans 214, gift boxes 233, crates
  // 262, jars 322, baskets 33) double as some ROM ENEMY sprites — e.g. the
  // Worthless Protoplasm shares the present sprite 195, the jar collides too — so
  // those sprites can land in enemySpriteGroups. A bare placement with one of
  // these sprites is a GIFT container, NOT a foe: never auto-classify it hostile
  // by sprite alone (it would attack instead of opening). A genuine enemy that
  // reuses a container sprite must be placed EXPLICITLY as kind:'enemy'.
  // KEEP IN SYNC with src/engine/Gifts.ts CONTAINER_TYPE_NAMES.
  const CONTAINER_SPRITES = new Set([195, 214, 233, 262, 322, 33]);

  // True if a placement is an enemy: explicit kind, or a legacy enemy sprite
  // (excluding gift-container sprites, which are passive unless kind:'enemy').
  function isEnemyPlacement(r) {
    if (r.kind === 'enemy') return true;
    // Editor-authored placement: its explicit kind is authoritative. Since kind
    // isn't 'enemy' (checked above), a deliberate person/prop/car must NOT be
    // force-upgraded to enemy just because its sprite is an enemy sprite.
    if (r._authored) return false;
    if (CONTAINER_SPRITES.has(r.sprite)) return false;
    // Base ROM placements: the enemy-sprite heuristic surfaces enemies that the
    // base data stores as kind:'person' (e.g. roaming ROM enemies).
    return ENEMY_SPRITES.has(r.sprite);
  }
  // One effective per-entity stat (merged catalog+authored), or `def`.
  function entityStat(sprite, key, def) {
    const e = entityDefs[String(sprite)];
    return e && e[key] != null ? e[key] : def;
  }

  // Resolve the SHARED entity props for an actor through the cascade:
  //   kind default -> sprite-group entity table (enemies) -> instance override.
  // `over` is the instance-override layer: a placement's `r.props`, OR a spawner
  // object, OR undefined. Sparse — any absent field inherits the layer beneath,
  // and the instance layer WINS over the entity/kind layers. Returns resolved
  // actor fields (note: `attackCooldownMs` prop -> `attackCooldown` field, and
  // `chaseSpeed` is derived from speed). Cars are NOT resolved here — they have
  // disjoint defaults/fields and carry their own inline props (see buildCarPool).
  // KEEP IN SYNC with src/engine/NPCManager.ts resolveProps (order + defaults).
  function resolveProps(kind, sprite, over) {
    const o = over || {};
    const enemy = kind === 'enemy';
    const person = kind === 'person';
    const car = kind === 'car';
    // sprite-group (entity table) layer — UNIVERSAL: every kind inherits its
    // parent entity's stats, with the kind value below as the floor default. The
    // Entity Manager is the master for all entities; a placement/spawner's `o`
    // override still wins over both. KEEP IN SYNC with NPCManager.resolveProps.
    const ent = (key, def) => entityStat(sprite, key, def);
    // instance override wins over the (entity → kind) layers beneath it.
    const pick = (key, below) => (o[key] != null ? o[key] : below);
    // `speed` is per-kind by design (see EntityProps.speed): walkers (enemy/
    // person) read px/tick from the entity table; a car reads a route ×multiplier
    // (~1) and is not entity-driven (its motion model is different).
    const speed = pick('speed', car ? 1 : ent('speed', ENEMY_SPEED));
    return {
      // hp floor by kind (car heavy, enemy static-default, person NPC_HP, prop 0 —
      // props are inert); the entity table overrides it, the instance wins last.
      hp: pick('hp', ent('hp', car ? VEHICLE_HP : enemy ? STATIC_ENEMY_HP : person ? NPC_HP : 0)),
      level: pick('level', ent('level', enemy ? DEFAULT_ENEMY_LEVEL : 1)),
      xp: pick('xp', ent('xp', enemy ? DEFAULT_ENEMY_XP : 0)),
      // Per-kind combat FLOORS: a default townsperson keeps its gentler NPC_*
      // values, an enemy its ENEMY_* values; the entity table / instance override
      // either. This lets a Master-Roshi entity out-fight a level-1 civilian of
      // the same base kind purely by its authored stats.
      damage: pick(
        'damage',
        car ? VEHICLE_DAMAGE : ent('damage', person ? NPC_DAMAGE : ENEMY_DAMAGE)
      ),
      attackCooldown: pick(
        'attackCooldownMs',
        ent('attackCooldownMs', person ? NPC_ATTACK_COOLDOWN_MS : ENEMY_ATTACK_COOLDOWN_MS)
      ),
      speed,
      chaseSpeed: speed * CHASE_RATIO, // walkers only (cars route, never chase)
      attackRange: pick(
        'attackRange',
        ent('attackRange', person ? NPC_ATTACK_RANGE : ATTACK_RANGE)
      ),
      detectRange: pick(
        'detectRange',
        ent('detectRange', person ? NPC_DETECT_RANGE : DETECT_RANGE)
      ),
      giveUpRange: pick('giveUpRange', ent('giveUpRange', GIVE_UP_RANGE)),
      // null = no per-instance/entity roam radius; the tick then falls back to
      // the spawner's radius / 256 (entityStat returns null when unset).
      wanderRadius:
        o.wanderRadius != null ? o.wanderRadius : entityStat(sprite, 'wanderRadius', null),
      // crit/dodge % — enemies default to DEFAULT_ENEMY_*, townsfolk to 0 (they
      // didn't crit/dodge before). Honored by resolveMelee for BOTH now.
      crit: pick('crit', ent('crit', enemy ? DEFAULT_ENEMY_CRIT : 0)),
      dodge: pick('dodge', ent('dodge', enemy ? DEFAULT_ENEMY_DODGE : 0)),
      // Combat personality (townsfolk): per-INSTANCE override (Placement editor)
      // wins over the entity-level default; null → npcCombatPersonality seeds a
      // random pick by id. A string, so not run through pick()'s numeric path.
      combat: o.combat != null ? o.combat : entityStat(sprite, 'combat', null),
    };
  }

  // Per-element status vulnerability % for a sprite (100 = fully susceptible,
  // 0 = immune), straight from the ROM enemy catalog's `vuln` block. The status
  // engine scales each proc by this — a canon resist. Tolerates the legacy
  // "50%" string form as well as numeric. `def` for sprites with no catalog
  // entry (townsfolk): fully vulnerable.
  function entityVuln(sprite, key, def = 100) {
    const e = entityDefs[String(sprite)];
    const v = e && e.vuln ? e.vuln[key] : undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = /-?\d+/.exec(v);
      if (m) return +m[0];
    }
    return def;
  }

  // The status-inflict spec an enemy's swing carries ([{type, chance}]). Prefers
  // an authored general `inflict` array (Entity Manager / catalog), else the
  // single `paralysisChance` field, else the flat ENEMY_PARALYZE_CHANCE so an
  // unauthored enemy still procs paralysis as before. The same spec applies
  // whether it hits a player or a townsperson — the target's per-element resist
  // (entityVuln / _playerVuln) scales each proc when it lands.
  function enemyInflict(n) {
    const authored = status.normalizeInflict(entityStat(n.sprite, 'inflict', null));
    if (authored.length) return authored;
    const pc = entityStat(n.sprite, 'paralysisChance', ENEMY_PARALYZE_CHANCE);
    return pc > 0 ? [{ type: status.STATUS.PARALYSIS, chance: pc }] : [];
  }

  // Roll an enemy's loot on death from the merged catalog: money is always
  // granted; the item drops with probability `drop.rate` (ROM "Item Rarity",
  // e.g. 1/128). Returns {money, item:{item,itemName}|null} or null if neither.
  // gameHost decides whether the item is grantable (must be a known good).
  function rollLoot(sprite) {
    const e = entityDefs[String(sprite)] || {};
    const money = (e.money | 0) > 0 ? e.money | 0 : 0;
    // Drop table: prefer the authored `drops` list; fall back to the catalog's
    // single `drop`. Every entry rolls independently against its own `rate`.
    const table = Array.isArray(e.drops) && e.drops.length ? e.drops : e.drop ? [e.drop] : [];
    const items = [];
    for (const d of table) {
      if (!d || !d.item) continue;
      const rate = typeof d.rate === 'number' ? d.rate : 0;
      if (Math.random() < rate) items.push({ item: d.item, itemName: d.itemName || '' });
    }
    return money || items.length ? { money, items } : null;
  }

  // --- Traffic config (our own content — public/.../car_traffic.json) ---
  // The Traffic Editor writes the WHOLE file to the overrides layer; it wins
  // over the committed default. KEEP IN SYNC with NPCManager.activeVehicles —
  // both build the same car pool (same filter, file order) so wire ids align.
  const CAR_FILE = 'map/car_traffic.json';
  const CAR_OV_PATH = path.join(assetsDir, '..', 'overrides', 'car_traffic.json');
  function loadCarCfg() {
    try {
      return JSON.parse(fs.readFileSync(CAR_OV_PATH, 'utf8'));
    } catch {
      /* no override authored — fall back to the committed default */
    }
    try {
      return readJSON(CAR_FILE);
    } catch {
      return null;
    }
  }
  function activeVehicles(cfg) {
    // >=1 waypoint: a single point is a PARKED car (spawns, sits, attackable);
    // 2+ waypoints drive the route. tickCar no-ops a <2-waypoint car, so a parked
    // car just holds its spot + authored facing. KEEP IN SYNC with NPCManager.
    return ((cfg && cfg.vehicles) || []).filter(
      (v) => v.enabled !== false && Array.isArray(v.waypoints) && v.waypoints.length >= 1
    );
  }
  let carCfg = loadCarCfg();

  // Exact per-direction vehicle collision boxes (build artifact, see
  // tools/extract_vehicle_colboxes.py): spriteId -> dir(0-7) -> {w,h,offX,offY}.
  // KEEP IN SYNC with NPCManager (same file, same lookup). Loaded once; vehicle
  // art rarely changes (re-running the extractor needs a server restart).
  let COLBOXES = {};
  try {
    COLBOXES = readJSON('sprites/colboxes.json');
  } catch {
    COLBOXES = {};
  }

  // --- NPC state ---
  const NPCS_FILE = 'map/npcs.json';
  // Editor-authored placement overrides (public/overrides/npcs.json — sibling
  // of the assets dir). Absent until something is authored.
  const OVERRIDES_PATH = path.join(assetsDir, '..', 'overrides', 'npcs.json');
  const lastAttackAt = {}; // playerId -> ms, for the per-player attack cooldown
  const prevPlayerPos = new Map(); // playerId -> last {x,y}, to detect door warps
  // playerId -> {fromX,fromY,toX,toY,until} of a recently detected door warp.
  // Kept for WARP_FOLLOW_MS (not one tick) so a chasing enemy can still follow
  // through after a mid-swing pose clears. Pruned each tick.
  const recentWarps = new Map();
  // playerId -> ms until warp-detection is paused for that player after a
  // respawn. A respawn teleports a full-HP player to the spawn point, which
  // looks exactly like a door warp, so the host flags it (noteRespawn) and we
  // ignore jumps for a short window. A WINDOW, not a one-shot "next jump": the
  // dying client keeps sending its pre-death position for a beat (it hasn't
  // processed the respawn yet), so the real jump to spawn can land several
  // ticks later — a single-tick exemption was consumed early and chasers
  // teleported to the respawned player. KEEP > the worst-case client catch-up.
  const respawnGuard = new Map();
  const RESPAWN_GUARD_MS = 1500;
  let onEnemyKillCb = null; // set in start(): (playerId, xp, enemy, loot) => void
  let onPlayerHitCb = null; // set in start(): (targetPlayerId, dmg, byPlayerId) => void (PvP)
  let getPlayersCb = null; // set in start(): () => player snapshots (PvP targeting)
  let onPickupCb = null; // set in start(): (playerId, drop) => bool — host claims a ground drop
  let onPlayerShoveCb = null; // set in start(): (playerId, spot) => void — push a player, NO damage
  // Per-player cooldown so a vehicle plowing over a foe doesn't re-hit them every
  // tick (in-sim actors carry their own `lastVehicleHit`; players don't).
  const vehiclePlayerHitAt = Object.create(null);

  // --- Ground loot drops (first-touch FFA pickup; never despawn) -------------
  // A drop is a world entity at a fixed spot. The tick finds the first player
  // within DROP_PICKUP_RADIUS and offers it to the host (onPickupCb), which owns
  // inventory/cash and decides if the player can take it (bag room for items).
  // Accepted -> removed + broadcast; refused (bag full) -> stays for next time.
  const groundDrops = []; // {id, kind, x, y, item?, name?, amount?, fromX?, fromY?, pickableAt?}
  let nextDropId = 1;
  const DROP_PICKUP_RADIUS = 18; // px (anchor distance) to claim a drop
  // Loot ejection: a drop flies out of the corpse at a random angle and lands
  // EJECT_MIN..EJECT_MAX px away, so it never spawns under the killer's feet (no
  // instant grab) and reads as a physical pop-out. It's unclaimable until it lands.
  const EJECT_MIN = 14;
  const EJECT_MAX = 40;
  const EJECT_MS = 450; // flight time; pickup is locked until now + EJECT_MS

  // Pick a non-solid landing spot a random angle+distance from (ox,oy). Tries a
  // few angles so loot doesn't settle inside a wall; falls back to the origin.
  function ejectLanding(ox, oy) {
    for (let tries = 0; tries < 6; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = EJECT_MIN + Math.random() * (EJECT_MAX - EJECT_MIN);
      const x = ox + Math.cos(ang) * dist;
      const y = oy + Math.sin(ang) * dist;
      if (!blocked(x - 4, y - 4, 8, 8)) return { x, y };
    }
    return { x: ox, y: oy };
  }

  // Wire shape for a drop. Items carry their id (client renders the held sprite);
  // money carries an amount (client renders a coin). While a freshly ejected drop
  // is still in flight we include its origin + flight time so the client animates
  // the arc; once landed those are omitted (a late joiner just sees it at rest).
  function dropWire(d) {
    const base =
      d.kind === 'money'
        ? {
            id: d.id,
            kind: 'money',
            x: d.x,
            y: d.y,
            amount: d.amount | 0,
            // Death cash renders as the c001 "cash" item art; absent → coin glyph.
            ...(d.sprite ? { sprite: d.sprite } : {}),
          }
        : { id: d.id, kind: 'item', x: d.x, y: d.y, item: d.item, name: d.name || '' };
    if (d.fromX != null && d.pickableAt && Date.now() < d.pickableAt) {
      base.fromX = d.fromX;
      base.fromY = d.fromY;
      base.ejectMs = EJECT_MS;
    }
    return base;
  }

  // Spawn a drop. `landX/landY` is where it comes to rest; pass `origin` (the
  // corpse spot) to make it eject — it arcs out from there and can't be claimed
  // until it lands (now + EJECT_MS). `data` = {item,name} or {amount}.
  function spawnDrop(kind, landX, landY, data, origin) {
    const d = { id: `d${nextDropId++}`, kind, x: Math.round(landX), y: Math.round(landY), ...data };
    if (origin) {
      d.fromX = Math.round(origin.x);
      d.fromY = Math.round(origin.y);
      d.pickableAt = Date.now() + EJECT_MS;
    }
    groundDrops.push(d);
    if (broadcastCb) broadcastCb({ type: 'drop_spawn', drop: dropWire(d) });
    return d;
  }

  // --- Actor loot carrying ---------------------------------------------------
  // Enemies and townsfolk grab item drops they walk over (first-touch, same as
  // players) and hold up to ACTOR_CARRY_CAP. On death they eject their whole
  // haul back onto the ground, so a hoarder you kill gives the loot back. Carry
  // is purely positional — actors don't path toward loot, they just pick up
  // what lands near them. Vehicles/cars never carry (special behaviour).
  const ACTOR_CARRY_CAP = 2; // max ground items an enemy/townsperson holds at once
  function canCarry(n) {
    return !n.dead && (n.isEnemy || n.kind === 'person');
  }

  // Offer each unclaimed item drop to the first eligible actor within reach.
  // Runs AFTER the player pickup pass each tick, so players win contested drops.
  function pickupByActors(now) {
    if (!groundDrops.length) return;
    for (let i = groundDrops.length - 1; i >= 0; i--) {
      const d = groundDrops[i];
      if (d.kind !== 'item') continue; // actors grab items, not money
      if (d.pickableAt && now < d.pickableAt) continue; // still mid-flight
      const a = actors.find(
        (n) =>
          canCarry(n) &&
          n.carried.length < ACTOR_CARRY_CAP &&
          Math.abs(n.x - d.x) <= DROP_PICKUP_RADIUS &&
          Math.abs(n.y - d.y) <= DROP_PICKUP_RADIUS
      );
      if (a) {
        a.carried.push({ item: d.item, name: d.name || '' });
        groundDrops.splice(i, 1);
        if (broadcastCb) broadcastCb({ type: 'drop_remove', id: d.id });
      }
    }
  }

  // Eject everything an actor was holding — both its loose carry AND anything a
  // townsperson equipped off the ground — onto the ground at its death spot
  // (independent of its own drop table), then reset so a respawn comes back
  // clean. Applies to ANY death — killed by a player, an NPC, or poison.
  function ejectCarried(actor) {
    const haul = [...(actor.carried || []), ...(actor.equipped || [])];
    for (const c of haul) {
      const land = ejectLanding(actor.x, actor.y);
      spawnDrop(
        'item',
        land.x,
        land.y,
        { item: c.item, name: c.name || '' },
        { x: actor.x, y: actor.y }
      );
    }
    actor.carried = [];
    actor.equipped = [];
    actor.weaponBonus = 0;
    actor.armorBonus = 0;
    if (actor.itemId !== null) {
      actor.itemId = null;
      actor.equipDirty = true; // broadcast the cleared held item (so a respawn shows unarmed)
    }
  }

  // A townsperson USES the loot it's carrying (enemies never call this — see the
  // tickNpc caller). One action per call: heal first if hurt, otherwise equip a
  // weapon (more swing damage + held sprite) or armor (damage soak). Healing is
  // consumed; gear moves carried -> equipped (still drops on death). No-op when
  // there's no catalog (GOODS empty) — the actor just keeps hoarding.
  function npcUseCarried(n) {
    if (!n.carried.length) return;
    // 1) Heal when actually hurt and holding a heal item.
    if (n.hp < n.maxHp) {
      const i = n.carried.findIndex((c) => (goodFor(c.item)?.heal | 0) > 0);
      if (i >= 0) {
        n.hp = Math.min(n.maxHp, n.hp + goodFor(n.carried[i].item).heal);
        n.hpDirty = true;
        n.carried.splice(i, 1); // consumed
        return; // one action per call
      }
    }
    // 2) Otherwise equip a weapon or armor we can put to use.
    const ei = n.carried.findIndex((c) => goodFor(c.item)?.equip);
    if (ei < 0) return;
    const c = n.carried[ei];
    const eq = goodFor(c.item).equip;
    if (eq.slot === 'weapon') {
      if ((eq.offense | 0) <= n.weaponBonus) return; // only ever swap UP to a better weapon
      n.weaponBonus = eq.offense | 0;
      n.itemId = String(c.item); // held weapon sprite
      n.equipDirty = true; // broadcast the held-item change (npc_equip)
    } else {
      n.armorBonus += eq.defense | 0; // body/arms/other stack as flat damage soak
    }
    n.equipped.push(c);
    n.carried.splice(ei, 1);
  }

  function readOverrides() {
    try {
      return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    } catch {
      return null; // no overrides authored yet (or mid-write — watch retries)
    }
  }

  // KEEP IN SYNC with src/engine/NPCManager.ts mergeNpcOverrides — client and
  // server must produce identical arrays (array index = wire id). `edits[k]`
  // replaces a base entry; null deletes it (slot becomes a tombstone so ids
  // don't shift); `additions` append after the base list.
  function mergeNpcOverrides(base, ov) {
    // `_authored` tags editor edits + additions so isEnemyPlacement honors their
    // EXPLICIT kind (a deliberate person/prop isn't force-upgraded to enemy by the
    // enemy-sprite heuristic). Untouched base entries keep the heuristic.
    const merged = base.map((e) => {
      const o = e.k !== undefined && ov && ov.edits ? ov.edits[e.k] : undefined;
      if (o === null) return null;
      if (o) return Object.assign({}, o, { k: e.k, _authored: true });
      return e;
    });
    for (const a of (ov && ov.additions) || [])
      merged.push(Object.assign({}, a, { _authored: true }));
    return merged;
  }

  function loadMergedPlacements() {
    return mergeNpcOverrides(readJSON(NPCS_FILE), readOverrides());
  }

  function baseActor(fields) {
    return Object.assign(
      {
        frame: 0,
        life: 'idle',
        timer: rand(60, 300),
        walkDx: 0,
        walkDy: 0,
        animTimer: 0,
        dirty: false,
        // combat
        isEnemy: false,
        pk: false, // PK flag (see canHurt). Enemies set true in build*; people false.
        roam: false,
        lastVehicleHit: 0, // ms this actor was last struck by a vehicle (per-victim cd)
        hp: 0,
        maxHp: 0,
        level: 1,
        xp: 0, // EXP granted on death (enemies only; set in build*)
        // Per-enemy combat tuning (defaults; spawners override in buildPool).
        damage: ENEMY_DAMAGE,
        attackCooldown: ENEMY_ATTACK_COOLDOWN_MS,
        speed: ENEMY_SPEED,
        chaseSpeed: ENEMY_CHASE_SPEED,
        detectRange: DETECT_RANGE, // px the player must be within to aggro this enemy
        giveUpRange: GIVE_UP_RANGE, // px a locked-on chase breaks off past
        attackRange: ATTACK_RANGE, // px the enemy must be within to land a hit
        crit: 0, // % chance a swing crits (SMAAAASH); resolved per-entity in build*
        dodge: 0, // % chance to evade an incoming swing; resolved per-entity in build*
        combat: null, // townsfolk combat personality override (instance>entity);
        // null → npcCombatPersonality seeds a pick by id
        pursuing: false, // 'pursuer' (cop) townsfolk: currently locked onto a foe
        // (hysteresis — keeps the chase out to giveUpRange)
        wanderRadius: null, // per-instance roam radius; null -> spawner / 256 (see tickEnemy)
        dead: false,
        hpDirty: false,
        respawnAt: 0,
        lastSwing: 0, // ms of this enemy's last attack (per-enemy cooldown)
        poseStart: 0, // ms a transient pose (attack/hurt) began — drives frame anim
        aggressor: null, // the NPC that most recently hit this enemy (retaliation)
        aggroUntil: 0, // ms until that grudge expires
        spawner: null,
        // Pursuit / regroup state machine (enemies only):
        mode: 'patrol', // 'patrol' wander | 'chase' a target | 'door' walk-to-doorway | 'return' to spawn
        targetId: null, // id of the player being chased (for door-follow matching)
        warpStack: [], // doors warped through while chasing, retraced on return
        returnSince: 0, // ms the current regroup began (RETURN_GIVEUP_MS timer)
        pendingDoor: null, // {triggerX,triggerY,destX,destY} the chaser is walking to and will warp through
        doorSince: 0, // ms the walk-to-doorway began (DOOR_GIVEUP_MS timer)
        // NPC combat-maneuver state (townsfolk): a 'nervous' shuffle heading that
        // refreshes on a timer so the shuffle reads as restless, not twitchy.
        jitterAng: 0,
        jitterUntil: 0,
        // Active status conditions (see server/status.js): { [type]: {until,…} }.
        // Paralysis/numb, poison, etc. Empty = clean.
        statuses: {},
        // Ground item drops this actor has picked up (max ACTOR_CARRY_CAP).
        // Ejected back onto the ground on death; emptied on respawn.
        carried: [],
        // Loot a townsperson has EQUIPPED off the ground (weapon/armor {item,name}).
        // Stays equipped until death, then drops with `carried`. Enemies never equip.
        equipped: [],
        weaponBonus: 0, // extra swing damage from an equipped weapon
        armorBonus: 0, // incoming damage soaked by equipped armor (min 1 still lands)
        itemId: null, // held weapon sprite id (set on equip; cleared on death)
        equipDirty: false, // itemId changed → re-broadcast via npc_equip (mirror hpDirty)
      },
      fields
    );
  }

  // ROM placements (+ merged overrides). Sprite groups listed in
  // enemy_spawns.json are reclassified to kind 'enemy' (attackable) by sprite
  // — on BOTH client and server — so npcs.json itself need not carry any
  // enemy flag. Null entries are override-deleted placements: a tombstone
  // actor keeps the slot so wire ids stay aligned with the client.
  function buildNpcs(raw) {
    return raw.map((r, id) => {
      if (!r) {
        return baseActor({
          id,
          kind: 'deleted',
          sprite: 0,
          x: 0,
          y: 0,
          homeX: 0,
          homeY: 0,
          dir: 0,
          homeDir: 0,
          indoor: false,
          dead: true,
        });
      }
      const enemy = isEnemyPlacement(r);
      // ROM config id from the placement key "areaIdx:npcId:occ" (−1 for editor
      // additions / keyless). Drives server-side shop-clerk proximity (npcShops
      // maps this id → store); mirrors the client's npcIdFromKey.
      const npcConfigId = (() => {
        if (!r.k) return -1;
        const parts = String(r.k).split(':');
        return parts.length >= 2 ? parseInt(parts[1], 10) : -1;
      })();
      // One cascade: kind default -> sprite-group entity table -> this placement's
      // `props` override. Same resolver the spawner pool uses, so a placed enemy
      // and a spawned one of the same sprite match (minus any per-instance props).
      const p = resolveProps(enemy ? 'enemy' : r.kind, r.sprite, r.props);
      return baseActor({
        id,
        kind: enemy ? 'enemy' : r.kind,
        sprite: r.sprite,
        npcConfigId,
        x: r.x,
        y: r.y,
        homeX: r.x,
        homeY: r.y,
        dir: r.dir,
        homeDir: r.dir,
        indoor: !!(sectorForTile(Math.floor(r.x / TILE), Math.floor(r.y / TILE)) || {}).indoor,
        isEnemy: enemy,
        pk: enemy, // enemies are always PK; townsfolk/vehicles never are
        // Placed enemies roam, chase, and attack exactly like spawner-pooled
        // ones — `roam` is the tick dispatch flag that routes to tickEnemy
        // (full enemy AI) rather than tickNpc (townsfolk self-defense).
        roam: enemy,
        hp: p.hp,
        maxHp: p.hp,
        level: p.level,
        xp: p.xp,
        damage: p.damage,
        attackCooldown: p.attackCooldown,
        speed: p.speed,
        chaseSpeed: p.chaseSpeed,
        attackRange: p.attackRange,
        detectRange: p.detectRange,
        giveUpRange: p.giveUpRange,
        crit: p.crit,
        dodge: p.dodge,
        combat: p.combat,
        wanderRadius: p.wanderRadius, // null unless this placement overrides it
      });
    });
  }

  // Fixed enemy pool from the spawners, appended AFTER the ROM placements so
  // wire ids (array indexes) align with the client, which builds the same pool
  // from the same file. Slots start dead (hp 0 = hidden) until activated.
  // Combat stats resolve through resolveProps: kind default -> sprite-group
  // entity table (Entity Manager) -> the spawner's own fields (instance layer).
  function buildPool(startId) {
    const out = [];
    let id = startId;
    for (const sp of SPAWNERS) {
      // The SPAWNER is the instance-override layer for the enemies it prints:
      // kind default -> sprite-group entity table -> this spawner's own fields.
      // So two spawners of the same sprite can differ (hp/aggro/chase/roam/...).
      const p = resolveProps('enemy', sp.sprite, sp);
      for (let i = 0; i < (sp.poolSize || 0); i++) {
        out.push(
          baseActor({
            id: id++,
            kind: 'enemy',
            sprite: sp.sprite,
            x: sp.x,
            y: sp.y,
            homeX: sp.x,
            homeY: sp.y,
            dir: 1,
            homeDir: 1,
            // Whether this enemy LIVES indoors (its spawn sector). Outdoor enemies
            // that get lured into a building use this to know they must leave.
            indoor: !!(sectorForTile(Math.floor(sp.x / TILE), Math.floor(sp.y / TILE)) || {})
              .indoor,
            isEnemy: true,
            pk: true, // pooled enemies are PK
            roam: true,
            maxHp: p.hp,
            level: p.level,
            xp: p.xp,
            damage: p.damage,
            attackCooldown: p.attackCooldown,
            speed: p.speed,
            chaseSpeed: p.chaseSpeed,
            detectRange: p.detectRange,
            giveUpRange: p.giveUpRange,
            attackRange: p.attackRange,
            crit: p.crit,
            dodge: p.dodge,
            combat: p.combat,
            wanderRadius: p.wanderRadius, // per-spawner roam radius (else null -> 256)
            dead: true, // inactive until the spawner wakes it
            spawner: sp,
          })
        );
      }
    }
    return out;
  }

  // Traffic cars: one actor per active vehicle, appended AFTER the enemy pool
  // (file order) so wire ids match the client. Each starts at its first
  // waypoint; with 2+ waypoints it drives the route, with 1 it stays PARKED at
  // its authored facing (v.dir). w/h are the collision box.
  function buildCarPool(startId) {
    const out = [];
    let id = startId;
    for (const v of activeVehicles(carCfg)) {
      const [sx, sy] = v.waypoints[0];
      // A traffic car is a full combatant: it has HP (attackable — PK rules, see
      // handleAttack) and a collide damage it deals when it plows a foe (tickCar →
      // plow). The vehicle IS its own instance-override layer, so hp/damage/speed
      // resolve through the SAME cascade as every other entity (resolveProps); the
      // vehicle-only extras (waypoints/loop/box) are set alongside.
      const p = resolveProps('car', v.sprite, v);
      out.push(
        baseActor({
          id: id++,
          kind: 'car',
          sprite: v.sprite,
          x: sx,
          y: sy,
          homeX: sx,
          homeY: sy,
          dir: v.dir || 0, // parked cars hold this facing; driving cars re-face per segment
          homeDir: v.dir || 0,
          indoor: false,
          waypoints: v.waypoints,
          wpIndex: 1, // heading toward the second waypoint
          step: 1, // ping-pong direction for non-looping routes
          loop: v.loop !== false,
          speed: p.speed,
          carW: v.w || 40,
          carH: v.h || 28,
          hp: p.hp,
          maxHp: p.hp,
          damage: p.damage,
        })
      );
    }
    return out;
  }

  let staticNpcs = buildNpcs(loadMergedPlacements());
  let pool = buildPool(staticNpcs.length);
  let carPool = buildCarPool(staticNpcs.length + pool.length);
  let npcs = staticNpcs.concat(pool).concat(carPool);
  // Everything that ticks/broadcasts (townsfolk + enemies + cars); enemies subset.
  let actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy || n.kind === 'car');
  let enemies = npcs.filter((n) => n.isEnemy);
  // Vehicles (traffic cars — parked or routed) — the attackable, plowing actors.
  // handleAttack damages these in addition to enemies, gated by canHurt (PK
  // rules). KEEP IN SYNC with the actors/enemies rebuilds below.
  let vehicles = npcs.filter((n) => n.kind === 'car');

  // Hot-reload placements when extraction rewrites npcs.json — otherwise the
  // sim keeps broadcasting STALE home positions and clients see NPCs snap
  // back to pre-fix spots (see bugs.md, placement-anchor entry). Marking
  // every person dirty pushes the corrected rows to connected clients;
  // they still need a browser refresh for props (props are never broadcast).
  function reloadPlacements() {
    let raw;
    try {
      raw = loadMergedPlacements();
    } catch {
      return; // mid-write or malformed — the next watch tick retries
    }
    if (raw.length === staticNpcs.length) {
      raw.forEach((r, id) => {
        const n = staticNpcs[id];
        if (!r) {
          // Override-deleted: tombstone in place (never ticks or broadcasts).
          n.kind = 'deleted';
          n.dead = true;
          n.isEnemy = false;
          n.pk = false;
          n.roam = false;
          n.dirty = false;
          n.hpDirty = false;
          n.life = 'idle';
          return;
        }
        const enemy = isEnemyPlacement(r);
        // Same cascade as buildNpcs (kind -> entity table -> placement props).
        const p = resolveProps(enemy ? 'enemy' : r.kind, r.sprite, r.props);
        n.kind = enemy ? 'enemy' : r.kind;
        n.sprite = r.sprite;
        n.x = r.x;
        n.y = r.y;
        n.homeX = r.x;
        n.homeY = r.y;
        n.dir = r.dir;
        n.homeDir = r.dir;
        n.frame = 0;
        n.indoor = !!(sectorForTile(Math.floor(r.x / TILE), Math.floor(r.y / TILE)) || {}).indoor;
        n.life = 'idle';
        n.timer = rand(60, 300);
        n.isEnemy = enemy;
        n.pk = enemy;
        n.roam = enemy; // see buildNpcs: routes placed enemies to tickEnemy
        n.maxHp = p.hp;
        n.hp = p.hp;
        n.level = p.level;
        n.xp = p.xp;
        n.damage = p.damage;
        n.attackCooldown = p.attackCooldown;
        n.speed = p.speed;
        n.chaseSpeed = p.chaseSpeed;
        n.detectRange = p.detectRange;
        n.giveUpRange = p.giveUpRange;
        n.attackRange = p.attackRange;
        n.crit = p.crit;
        n.dodge = p.dodge;
        n.combat = p.combat;
        n.wanderRadius = p.wanderRadius; // null unless this placement overrides it
        n.dead = false;
        n.dirty = n.kind === 'person' || enemy;
        n.hpDirty = enemy;
      });
      npcs = staticNpcs.concat(pool).concat(carPool);
    } else {
      // Entry count changed: wire ids (array indexes) shifted — rebuild static
      // AND the appended pools so ids realign. Connected clients must refresh.
      staticNpcs = buildNpcs(raw);
      pool = buildPool(staticNpcs.length);
      carPool = buildCarPool(staticNpcs.length + pool.length);
      npcs = staticNpcs.concat(pool).concat(carPool);
      for (const n of npcs) if (n.kind === 'person' || n.isEnemy) n.dirty = true;
    }
    actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy || n.kind === 'car');
    enemies = npcs.filter((n) => n.isEnemy);
    vehicles = npcs.filter((n) => n.kind === 'car');
    console.log(
      `[npcSim] reloaded ${NPCS_FILE} (${actors.length} actors, ${enemies.length} enemies)`
    );
  }

  // Hot-reload enemy spawners when the Enemy Spawner editor saves
  // overrides/enemy_spawns.json. Static reclassification (by sprite) AND the
  // appended pool both depend on the enemy config, so rebuild both. A changed
  // live pool size shifts wire ids — connected clients must refresh (the
  // editing client re-runs loadNPCs on save); tuning-only edits (radius, rate,
  // hp, position) apply live without an id shift.
  // Rebuild the static placements + spawner/car pools and the derived actor
  // lists. Shared by every reload that changes resolved stats or counts.
  function rebuildPoolsAndActors() {
    staticNpcs = buildNpcs(loadMergedPlacements());
    pool = buildPool(staticNpcs.length);
    carPool = buildCarPool(staticNpcs.length + pool.length);
    npcs = staticNpcs.concat(pool).concat(carPool);
    for (const n of npcs) if (n.kind === 'person' || n.isEnemy) n.dirty = true;
    actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy || n.kind === 'car');
    enemies = npcs.filter((n) => n.isEnemy);
    vehicles = npcs.filter((n) => n.kind === 'car');
  }

  function reloadEnemies() {
    enemyCfg = loadEnemyCfg();
    entityDefs = buildEntityDefs(loadEntities());
    ENEMY_SPRITES = new Set((enemyCfg && enemyCfg.enemySpriteGroups) || []);
    SPAWNERS = ((enemyCfg && enemyCfg.spawners) || []).filter((s) => s.enabled !== false);
    STATIC_ENEMY_HP = (SPAWNERS[0] && SPAWNERS[0].hp) || 24;
    rebuildPoolsAndActors();
    console.log(
      `[npcSim] reloaded enemy spawners (${enemies.length} enemies, ${SPAWNERS.length} spawners)`
    );
  }

  // Hot-reload the entity master table (overrides/entities.json — Entity Manager).
  // Entity stats now feed EVERY kind, so re-resolve every placement AND the
  // spawner pool against the new defs (mirrors reloadEnemies minus the spawner
  // re-read). A stat-only edit keeps the same counts, so wire ids don't shift.
  function reloadEntities() {
    entityDefs = buildEntityDefs(loadEntities());
    rebuildPoolsAndActors();
    console.log(`[npcSim] reloaded entity stats (${Object.keys(entityDefs).length} sprite defs)`);
  }

  // Hot-reload traffic when the Traffic Editor saves overrides/car_traffic.json.
  // A changed active-vehicle count shifts wire ids (cars sit after the enemy
  // pool), so connected clients must refresh; the editing client re-runs
  // loadNPCs on save. Cars are marked dirty so the new layout broadcasts.
  function reloadTraffic() {
    carCfg = loadCarCfg();
    carPool = buildCarPool(staticNpcs.length + pool.length);
    npcs = staticNpcs.concat(pool).concat(carPool);
    for (const n of carPool) n.dirty = true;
    actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy || n.kind === 'car');
    enemies = npcs.filter((n) => n.isEnemy);
    vehicles = npcs.filter((n) => n.kind === 'car');
    console.log(`[npcSim] reloaded traffic (${carPool.length} cars)`);
  }

  // Hot-reload the custom-room band when the Room Manager saves overrides/
  // rooms.json: re-stamp the band (collision + sectors + height grow), then
  // rebuild placements so each actor's `indoor` flag and in-bounds status
  // re-derive against the new map. Without this, an enemy placed in a freshly
  // authored room would stay frozen until the server restarts.
  function reloadRooms() {
    buildRoomBand();
    reloadPlacements();
    console.log(`[npcSim] reloaded custom-room band (map now ${mapHTiles} tiles tall)`);
  }

  // fs.watchFile (polling) over fs.watch: reliable on Windows and across
  // editors/scripts that replace the file rather than write in place. Watch
  // BOTH the extracted base and the editor overrides.
  fs.watchFile(path.join(assetsDir, NPCS_FILE), { interval: 2000 }, reloadPlacements);
  fs.watchFile(OVERRIDES_PATH, { interval: 2000 }, reloadPlacements);
  fs.watchFile(ENEMY_OV_PATH, { interval: 2000 }, reloadEnemies);
  fs.watchFile(ENTITIES_OV_PATH, { interval: 2000 }, reloadEntities);
  fs.watchFile(CAR_OV_PATH, { interval: 2000 }, reloadTraffic);
  fs.watchFile(ROOMS_OV_PATH, { interval: 2000 }, reloadRooms);
  // Map-tile override edits re-stamp the band the same way (it's applied inside
  // buildRoomBand), so enemies/collision pick up moved/covered furniture.
  fs.watchFile(MAP_TILES_OV_PATH, { interval: 2000 }, reloadRooms);

  function stepAnimation(n) {
    if (++n.animTimer >= 8) {
      n.animTimer = 0;
      n.frame = n.frame === 0 ? 1 : 0;
      n.dirty = true;
    }
  }

  function startIdle(n) {
    n.life = 'idle';
    n.timer = rand(90, 360);
    if (n.frame !== 0) n.dirty = true;
    n.frame = 0;
    n.animTimer = 0;
  }

  // True if the foot box overlaps any connected player's foot box (same anchor
  // and box as the player uses client-side). Keeps collision mutual: without
  // it a wandering NPC would walk into and overlap a standing player, since the
  // client treats NPC positions as authoritative and can't push back.
  function hitsPlayer(x, y, w, h, ppos) {
    for (const p of ppos) {
      if (p.editor) continue; // editor avatar is non-solid — actors walk through it
      const px = p.x - COL_W / 2;
      const py = p.y + COL_OY;
      if (x < px + COL_W && x + w > px && y < py + COL_H && y + h > py) return true;
    }
    return false;
  }

  // Collision box [x,y,w,h] for an actor positioned at (x,y). A manual Entity
  // Manager override (entities[sprite].col) wins for anyone; else a car uses its
  // exact per-direction box (full sprite rect as fallback) and everyone else the
  // foot box. KEEP IN SYNC with NPCManager.blockedByNPC boxOf().
  function entityColOverride(sprite) {
    const e = enemyCfg && enemyCfg.entities && enemyCfg.entities[sprite];
    return e && e.col ? e.col : null;
  }
  function actorBox(o, x, y) {
    const m = entityColOverride(o.sprite);
    if (m) return [x + (m.offX || 0) - m.w / 2, y + (m.offY || 0) - m.h, m.w, m.h];
    if (o.kind === 'car') {
      const g = COLBOXES[o.sprite];
      const b = g && g[o.dir];
      if (b) return [x + (b.offX || 0) - b.w / 2, y + (b.offY || 0) - b.h, b.w, b.h];
      return [x - o.carW / 2, y - o.carH, o.carW, o.carH];
    }
    return [x - COL_W / 2, y + COL_OY, COL_W, COL_H];
  }

  // True if the foot box overlaps any OTHER live actor's box. Makes townsfolk
  // and enemies solid to each other (same box/anchor as the player), so a
  // chasing pack can't all stack on the same pixel — they jostle for position
  // instead. Dead/tombstoned slots are non-solid.
  function hitsActor(self, x, y, w, h) {
    for (const o of actors) {
      if (o === self || o.dead || o.kind === 'deleted') continue;
      const [ox, oy, ow, oh] = actorBox(o, o.x, o.y);
      if (x < ox + ow && x + w > ox && y < oy + oh && y + h > oy) return true;
    }
    return false;
  }

  // AUTHORITATIVE collision for a PLAYER's foot box at (px,py) — walls PLUS solid
  // actors (person/enemy/car), weight-class aware. EXACT mirror of the client's
  // Player.blocked → checkPlayerCollision + blockedByNPC, so server simulation and
  // client prediction agree (no reconciliation jitter). A heavier player (level >
  // the actor's) walks THROUGH a person/enemy (the walk-push plows it); cars never
  // yield. `cur*` is the player's box at the START of the step: an actor it ALREADY
  // overlaps doesn't block (so an embedded player can always walk out). Players do
  // NOT block each other here (matches the client; overlaps are resolved by the
  // push system), so PvP plowing stays consistent.
  function playerBlocked(px, py, level, curX, curY) {
    if (blocked(px, py, COL_W, COL_H)) return true; // walls / room edges
    const haveCur = curX !== undefined && curY !== undefined;
    for (const o of actors) {
      if (o.dead || o.kind === 'deleted') continue;
      if (o.kind !== 'person' && o.kind !== 'enemy' && o.kind !== 'car') continue;
      if (o.kind !== 'car' && level !== undefined && level > (o.level || 1)) continue; // plow lighter
      const [ox, oy, ow, oh] = actorBox(o, o.x, o.y);
      if (!aabb(px, py, COL_W, COL_H, ox, oy, ow, oh)) continue;
      if (haveCur && aabb(curX, curY, COL_W, COL_H, ox, oy, ow, oh)) continue; // already inside → let out
      return true;
    }
    return false;
  }

  // Cardinal+diagonal Direction (src/types.ts: S,N,W,E,NW,SW,SE,NE) for a
  // heading vector, so a car shows the sprite for the way it's driving.
  function dir8(dx, dy) {
    if (dx === 0 && dy === 0) return 0;
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
    // oct 0..7 = E,SE,S,SW,W,NW,N,NE  ->  Direction codes
    return [3, 6, 0, 5, 2, 4, 1, 7][oct];
  }

  // Next waypoint index for a car: looping routes wrap; one-shot routes
  // ping-pong (reverse at the ends) so the car never teleports back to start.
  function nextWp(c) {
    const n = c.waypoints.length;
    if (c.loop) return (c.wpIndex + 1) % n;
    let i = c.wpIndex + c.step;
    if (i >= n) {
      c.step = -1;
      i = n - 2;
    } else if (i < 0) {
      c.step = 1;
      i = 1;
    }
    return i;
  }

  // Drive a car toward its current waypoint; advance when reached. Faces the
  // travel direction. A car follows its HAND-AUTHORED route and is NOT wall-
  // blocked (routes are drawn on the streets; the author guarantees they're
  // drivable, and the body box is large enough that a wall check would falsely
  // stall it on tile edges). It plows whatever it runs over — foes (enemies +
  // PKers) take the collide-hit + scatter knockback, friendlies are nudged out
  // of the lane (no damage) — instead of yielding. Looping vs ping-pong is
  // resolved by nextWp.
  function tickCar(c, players, now) {
    const wps = c.waypoints;
    if (!wps || wps.length < 2) return;
    let tgt = wps[c.wpIndex];
    let dx = tgt[0] - c.x;
    let dy = tgt[1] - c.y;
    let dist = Math.hypot(dx, dy);
    // Skip any waypoints we're already sitting on (e.g. coincident points).
    let guard = 0;
    while (dist < 0.5 && guard++ < wps.length) {
      c.wpIndex = nextWp(c);
      tgt = wps[c.wpIndex];
      dx = tgt[0] - c.x;
      dy = tgt[1] - c.y;
      dist = Math.hypot(dx, dy);
    }
    if (dist < 0.5) return;
    const ux = dx / dist;
    const uy = dy / dist;
    const newDir = dir8(ux, uy);
    if (newDir !== c.dir) {
      c.dir = newDir;
      c.dirty = true;
    }
    const step = Math.min(c.speed, dist);
    const travelX = ux * step;
    const travelY = uy * step;
    c.x += travelX;
    c.y += travelY;
    c.dirty = true;
    stepAnimation(c); // cycle the 2 drive frames while actually moving
    plow(c, travelX, travelY, players, now);
    if (Math.hypot(tgt[0] - c.x, tgt[1] - c.y) < 0.5) c.wpIndex = nextWp(c);
  }

  // The combat personality for a townsperson: the Entity Manager assignment for
  // its sprite group (entities[sprite].combat), else a stable seeded pick by id
  // so an unconfigured crowd still reacts diversely. KEEP IN SYNC with
  // EntityStats.CombatPersonality / EntityManagerTool's dropdown.
  function npcCombatPersonality(n) {
    // n.combat is the RESOLVED override (per-instance placement > entity table),
    // set in build*/reload via resolveProps. null → seed a stable pick by id from
    // the non-pursuer set (so an unassigned crowd reacts diversely, never a cop).
    const c = n.combat;
    if (c && VALID_PERSONALITIES.includes(c)) return c;
    return COMBAT_PERSONALITIES[n.id % COMBAT_PERSONALITIES.length];
  }

  // Step away from (fx,fy): route to a point opposite the threat (moveToward
  // fans around walls/actors). Returns whether it actually moved.
  function fleeFrom(n, fx, fy, speed, players, leash) {
    const dx = n.x - fx;
    const dy = n.y - fy;
    const len = Math.hypot(dx, dy) || 1;
    return moveToward(n, n.x + (dx / len) * 40, n.y + (dy / len) * 40, speed, players, leash);
  }

  // Sidestep perpendicular to the threat (side seeded by id so a crowd splits
  // both ways instead of all sliding the same direction).
  function strafe(n, fx, fy, players, leash) {
    const dx = n.x - fx;
    const dy = n.y - fy;
    const len = Math.hypot(dx, dy) || 1;
    const side = n.id & 1 ? 1 : -1;
    return moveToward(
      n,
      n.x + (-dy / len) * side * 36,
      n.y + (dx / len) * side * 36,
      NPC_COMBAT_SPEED,
      players,
      leash
    );
  }

  // Restless shuffle: a short step along a heading that only re-rolls every few
  // hundred ms, so a 'nervous' NPC fidgets rather than vibrating every tick.
  function jitter(n, players, leash, now) {
    if (now >= n.jitterUntil) {
      n.jitterAng = Math.random() * Math.PI * 2;
      n.jitterUntil = now + rand(250, 600);
    }
    moveToward(
      n,
      n.x + Math.cos(n.jitterAng) * 20,
      n.y + Math.sin(n.jitterAng) * 20,
      NPC_COMBAT_SPEED,
      players,
      leash
    );
  }

  // Townsfolk combat: maneuver per personality instead of standing still, then
  // swing on cooldown when the enemy is in range. Damage is applied directly
  // (NPC self-defense isn't a hitbox), so facing is purely cosmetic — we point
  // at the threat (or away, when fleeing) for readability.
  function tickNpcCombat(n, foe, players, now) {
    const e = foe.enemy;
    const dist = foe.dist;
    n.life = 'idle'; // drop any leftover wander leg without resetting the anim timer

    // "Can't fight": an entity authored with no damage (e.g. a level-1 civilian)
    // never swings — it keeps its distance from the threat. Combat is a PROPERTY
    // of the entity now, not a reflex every townsperson has by default.
    if ((n.damage | 0) <= 0) {
      const fled = fleeFrom(n, e.x, e.y, NPC_FLEE_SPEED, players, NPC_FLEE_LEASH);
      n.dir = faceDir(fled ? n.x - e.x : e.x - n.x, fled ? n.y - e.y : e.y - n.y);
      return;
    }

    // All combat numbers come from the RESOLVED entity stats (Entity Manager /
    // per-instance override), with the NPC_* constants only as floors — so a
    // Master-Roshi townsperson genuinely out-fights a weaker one of the same kind.
    const range = n.attackRange || NPC_ATTACK_RANGE;
    const cooldown = n.attackCooldown || NPC_ATTACK_COOLDOWN_MS;
    const canSwing =
      dist <= range &&
      now - n.lastSwing >= cooldown &&
      n.pose !== 'hurt' &&
      !wallBetween(n.x, n.y, e.x, e.y);
    const swing = () => {
      n.dir = faceDir(e.x - n.x, e.y - n.y);
      n.lastSwing = now;
      n.pose = 'attack';
      n.poseStart = now;
      n.poseUntil = now + NPC_ATTACK_POSE_MS;
      n.frame = 0;
      n.dirty = true;
      // Entity damage + any equipped-weapon bonus, rolled through the SAME
      // crit/dodge resolver enemies use (n.crit vs the target's dodge).
      const base = (n.damage | 0) + (n.weaponBonus | 0);
      const res = resolveMelee(n.crit || 0, e.dodge || 0, base, rng);
      if (foe.isPlayer) {
        // Swing at a PK player: HP lives on the host, so apply it there.
        if (res.miss) emitCombat('miss', e.x, e.y, null, e.id);
        else {
          if (onPlayerHitCb)
            onPlayerHitCb(
              e.id,
              res.dmg,
              null,
              knockbackPlayerSpot(e.x, e.y, n.x, n.y, res.dmg, {
                amass: massOf(n),
                vmass: massOf(e),
              })
            );
          if (res.crit) emitCombat('crit', e.x, e.y, null, e.id);
        }
      } else if (res.miss) {
        emitCombat('miss', e.x, e.y, null, null); // whiffed at an enemy
      } else {
        // Townsfolk knock enemies back but don't paralyze them (a deliberate
        // deterrent, not a lockdown) — no status inflict.
        applyDamage(e, res.dmg, now, null, { x: n.x, y: n.y, amass: massOf(n), inflict: [] });
        if (res.crit) emitCombat('crit', e.x, e.y, null, null);
        e.aggressor = n; // the enemy remembers (and may turn on) whoever hit it
        e.aggroUntil = now + ENEMY_AGGRO_MEMORY_MS;
      }
    };

    n.dir = faceDir(e.x - n.x, e.y - n.y); // watch the threat by default

    switch (npcCombatPersonality(n)) {
      case 'pursuer':
        // COP: run the bad guy down — chase at full chase speed with NO home
        // leash (Infinity), swinging once in range. tickNpc's hysteresis holds
        // the lock out to giveUpRange; losing the foe drops `pursuing` and the
        // walk-home in tickNpc returns the cop to its beat.
        if (dist > range)
          moveToward(n, e.x, e.y, n.chaseSpeed || NPC_COMBAT_SPEED, players, Infinity);
        else if (canSwing) swing();
        break;

      case 'brave':
        // Press the attack: close the gap, stand and swing once adjacent.
        if (dist > range) moveToward(n, e.x, e.y, NPC_COMBAT_SPEED, players, NPC_COMBAT_LEASH);
        else if (canSwing) swing();
        break;

      case 'coward': {
        // Run; face the way we're fleeing. Swing only if cornered (can't move).
        const fled = fleeFrom(n, e.x, e.y, NPC_FLEE_SPEED, players, NPC_FLEE_LEASH);
        if (fled) n.dir = faceDir(n.x - e.x, n.y - e.y);
        else if (canSwing) swing();
        break;
      }

      case 'nervous':
        // Trade blows but never settle — shuffle restlessly between swings.
        if (canSwing) swing();
        else jitter(n, players, NPC_COMBAT_LEASH, now);
        break;

      case 'skirmisher':
      default:
        // Hit-and-run: close in, swing when ready, then peel off (back/strafe).
        if (dist > range) moveToward(n, e.x, e.y, NPC_COMBAT_SPEED, players, NPC_COMBAT_LEASH);
        else if (canSwing) swing();
        else if (!fleeFrom(n, e.x, e.y, NPC_COMBAT_SPEED, players, NPC_COMBAT_LEASH))
          strafe(n, e.x, e.y, players, NPC_COMBAT_LEASH);
        break;
    }
  }

  function tickNpc(n, ppos, now) {
    // Hold position while a swing or flinch is playing so its generated frames
    // show (movement would overwrite the frame via stepAnimation).
    if ((n.pose === 'attack' || n.pose === 'hurt') && now < n.poseUntil) return;

    // Self-defense (defend on sight): if a living foe is within NPC_DETECT_RANGE
    // the townsperson maneuvers per its combat personality (tickNpcCombat) and
    // swings when in range — no longer a frozen statue. Foes are enemies always,
    // plus PK players (canHurt-gated, so a peaceful player is never attacked).
    // Props/0-HP people can't fight.
    if (n.hp > 0) {
      // Put picked-up loot to use: heal if hurt, else equip a weapon/armor. Done
      // before combat so a fresh weapon's damage applies on this same swing.
      npcUseCarried(n);
      // Defend-on-sight radius is the entity's resolved detectRange (NPC_DETECT_RANGE
      // is just the floor) — a vigilant guard notices threats from farther off.
      // A 'pursuer' (cop) that's already locked on widens its acquisition to
      // giveUpRange so it doesn't lose the bad guy the instant he steps past
      // detect — true hysteresis, like an enemy chase.
      const pursuer = npcCombatPersonality(n) === 'pursuer';
      const acqRange =
        pursuer && n.pursuing ? n.giveUpRange || GIVE_UP_RANGE : n.detectRange || NPC_DETECT_RANGE;
      const foe = nearestFoeTo(n, acqRange, ppos);
      if (foe) {
        n.pursuing = pursuer; // lock on (only meaningful for cops)
        tickNpcCombat(n, foe, ppos, now);
        return; // combat owns this tick — skip the wander AI
      }
      n.pursuing = false; // no foe in range — drop the chase; walk-home pulls it back
    }

    // Wander/leash radius from home: the entity's RESOLVED wanderRadius (Entity
    // Manager default / per-placement override), else the LEASH floor. 0 = a
    // stationary NPC (a clerk/guard that holds its spot). KEEP IN SYNC with the
    // EntityProps wanderRadius semantics (`!= null` so 0 is honored, not OR'd away).
    const wr = n.wanderRadius != null ? n.wanderRadius : LEASH;

    // No threat, but a fight may have carried us off our home spot: walk back
    // before resuming the leashed wander (the wander itself can't path beyond
    // `wr`, so it would otherwise stay stranded out in the street).
    if (Math.hypot(n.x - n.homeX, n.y - n.homeY) > wr) {
      n.dir = faceDir(n.homeX - n.x, n.homeY - n.y);
      if (moveToward(n, n.homeX, n.homeY, SPEED, ppos, Infinity)) return;
      // Wedged on the way home — fall through to the normal AI and try again.
    }

    if (n.life === 'walk') {
      const nx = n.x + n.walkDx * SPEED;
      const ny = n.y + n.walkDy * SPEED;
      const stop =
        blocked(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H) ||
        hitsPlayer(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H, ppos) ||
        hitsActor(n, nx - COL_W / 2, ny + COL_OY, COL_W, COL_H) ||
        Math.abs(nx - n.homeX) > wr ||
        Math.abs(ny - n.homeY) > wr;
      if (!stop) {
        n.x = nx;
        n.y = ny;
        n.dirty = true;
        stepAnimation(n);
      }
      if (stop || --n.timer <= 0) startIdle(n);
      return;
    }

    if (--n.timer > 0) return;

    if (n.life === 'glance') {
      if (n.indoor && n.dir !== n.homeDir) {
        n.dir = n.homeDir;
        n.dirty = true;
      }
      startIdle(n);
      return;
    }

    const roll = Math.random();
    if (!n.indoor && roll < 0.6) {
      const c = CARDINALS[rand(0, CARDINALS.length - 1)];
      n.dir = c.dir;
      n.walkDx = c.dx;
      n.walkDy = c.dy;
      n.life = 'walk';
      n.timer = rand(16, 64);
      n.dirty = true;
    } else if (roll < 0.85) {
      const turns = CARDINALS.filter((c) => c.dir !== n.dir);
      n.dir = turns[rand(0, turns.length - 1)].dir;
      n.life = 'glance';
      n.timer = rand(30, 90);
      n.dirty = true;
    } else {
      startIdle(n);
    }
  }

  // --- Vehicle behaviour (the Entity Manager `vehicle` flag) ---

  // Scatter heading for a plow hit: blend the car's travel direction (forward),
  // the perpendicular toward the victim's SIDE (shove them out of the lane), and
  // a little straight-away, then jitter — so a crowd flies apart instead of all
  // sliding the same way. Returns a unit vector.
  function vehicleKnockDir(travelX, travelY, carX, carY, vx, vy) {
    let ax = vx - carX;
    let ay = vy - carY;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    const tl = Math.hypot(travelX, travelY);
    const tx = tl > 0.01 ? travelX / tl : ax; // parked → just shove away
    const ty = tl > 0.01 ? travelY / tl : ay;
    let px = -ty; // perpendicular to travel…
    let py = tx;
    if (px * ax + py * ay < 0) {
      px = -px; // …pointed toward the side the victim is on
      py = -py;
    }
    let dx = tx * 0.5 + px * 0.95 + ax * 0.3;
    let dy = ty * 0.5 + py * 0.95 + ay * 0.3;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const ang = (rng() * 2 - 1) * VEHICLE_KB_VARIANCE; // random spread
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  // Resolve everything the vehicle's body overlaps after a step: foes (enemies +
  // PKers) take the collide-hit + scatter knockback (per-victim cooldown so it's
  // one hit, not one-per-tick); friendlies (townsfolk + peaceful players) take no
  // damage, just a minimal nudge aside so the plow never stalls. `travelX/Y` is
  // this tick's movement, biasing the knockback forward + sideways.
  function plow(n, travelX, travelY, players, now) {
    const [bx, by, bw, bh] = actorBox(n, n.x, n.y);
    for (const e of enemies) {
      if (e.dead || e.hp <= 0 || !canHurt(n, e)) continue;
      const [ex, ey, ew, eh] = actorBox(e, e.x, e.y);
      if (!aabb(bx, by, bw, bh, ex, ey, ew, eh)) continue;
      if (now - (e.lastVehicleHit || 0) < VEHICLE_HIT_COOLDOWN_MS) continue;
      e.lastVehicleHit = now;
      const dir = vehicleKnockDir(travelX, travelY, n.x, n.y, e.x, e.y);
      applyDamage(e, n.damage, now, null, {
        x: n.x,
        y: n.y,
        inflict: [],
        kb: { mult: VEHICLE_KB_MULT, dir },
      });
    }
    // Friendly townsfolk (non-enemy actors): gentle shove out of the lane.
    for (const o of nearActors(n.x, n.y, 96)) {
      if (o === n || o.dead || o.kind === 'deleted' || o.isEnemy) continue;
      const [ox, oy, ow, oh] = actorBox(o, o.x, o.y);
      if (!aabb(bx, by, bw, bh, ox, oy, ow, oh)) continue;
      const dir = vehicleKnockDir(travelX, travelY, n.x, n.y, o.x, o.y);
      pushActor(o, n.x, n.y, 0, { dir, dist: VEHICLE_FRIENDLY_KB }); // minimal nudge
    }
    if (players)
      for (const p of players) {
        if (p.editor || (p.hp !== undefined && p.hp <= 0)) continue;
        const px = p.x - COL_W / 2;
        const py = p.y + COL_OY;
        if (!aabb(bx, by, bw, bh, px, py, COL_W, COL_H)) continue;
        const dir = vehicleKnockDir(travelX, travelY, n.x, n.y, p.x, p.y);
        if (canHurt(n, { isEnemy: false, pk: p.pk })) {
          if (now - (vehiclePlayerHitAt[p.id] || 0) < VEHICLE_HIT_COOLDOWN_MS) continue;
          vehiclePlayerHitAt[p.id] = now;
          if (onPlayerHitCb)
            onPlayerHitCb(
              p.id,
              n.damage,
              null,
              knockbackPlayerSpot(p.x, p.y, n.x, n.y, n.damage, { mult: VEHICLE_KB_MULT, dir })
            );
        } else if (onPlayerShoveCb) {
          const spot = knockbackPlayerSpot(p.x, p.y, n.x, n.y, 0, {
            dir,
            dist: VEHICLE_FRIENDLY_KB,
          });
          if (spot) onPlayerShoveCb(p.id, spot);
        }
      }
  }

  // --- Enemy behaviour & combat ---

  // Cardinal Direction (src/types.ts) facing the vector (dx,dy), dominant axis.
  function faceDir(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 2 : 3; // W : E
    return dy < 0 ? 1 : 0; // N : S
  }

  // The enemy's target within DETECT_RANGE, or null. PLAYERS ALWAYS WIN: any
  // living player in range outranks every NPC, even a closer one. Only when no
  // player is in range does the enemy fall back to the nearest living
  // townsperson it's allowed to hurt (canHurt). `isPlayer` tells the caller
  // whether to route the hit through the host (players) or apply it here (NPCs).
  // Line-of-sight gate for target ACQUISITION: an actor can only sense a target
  // it has a clear, same-room path to — no solid wall AND no door seam between
  // their foot positions. Without it, two rooms the editor places adjacent in
  // world space (separated only by a wall, or by a no-collision room boundary)
  // let an enemy "see" a target one room over and run endlessly into the wall —
  // the combat reach check blocks the swing but not the chase. Following a player
  // who actually WARPS through a door is handled before this (warpStack / door
  // mode), so gating the door seam here doesn't break chase-through-doors.
  function canSense(n, tx, ty) {
    return !wallBetween(n.x, n.y, tx, ty) && !doorBetween(n.x, n.y, tx, ty);
  }

  function aggroTarget(n, players, now) {
    // Hysteresis: a fresh enemy acquires inside detectRange, but one already
    // chasing holds the lock until the target passes the larger give-up distance
    // — it doesn't quit the moment the player steps a pixel past detect.
    const detect = n.detectRange || DETECT_RANGE; // per-spawner aggro radius (Enemy Spawner tool)
    const range = n.mode === 'chase' ? Math.max(n.giveUpRange || GIVE_UP_RANGE, detect) : detect;

    // RETALIATE FIRST — this OUTRANKS the players-always-win rule below. An NPC
    // that's right on top of this enemy (within its own striking distance) and
    // still inside the fresh grudge window is the thing actually hurting it, so
    // the enemy turns and swings back even if a player is also nearby. The reach
    // gate (attackRange, not detect) keeps this narrow: a player can still pull
    // aggro off any enemy that ISN'T currently being meleed by an NPC, since the
    // general player loop below owns that case.
    const reten = n.aggressor;
    if (reten && !reten.dead && reten.hp > 0 && now < n.aggroUntil && canHurt(n, reten)) {
      const rd = Math.hypot(reten.x - n.x, reten.y - n.y);
      if (rd <= (n.attackRange || ATTACK_RANGE) && canSense(n, reten.x, reten.y))
        return { target: reten, dist: rd, isPlayer: false };
    }

    let target = null;
    let best = range;
    for (const p of players) {
      if (p.editor) continue; // editor avatar is untargetable (out of the fight)
      if (p.hp !== undefined && p.hp <= 0) continue;
      const d = Math.hypot(p.x - n.x, p.y - n.y);
      if (d <= best && canSense(n, p.x, p.y)) {
        best = d;
        target = p;
      }
    }
    if (target) return { target, dist: best, isPlayer: true };

    // No player in range. RETALIATE (the at-range case is handled above, ahead
    // of players): an enemy attacked from a distance still turns on the NPC that
    // hit it (kept fresh in applyDamage), preferring that aggressor over a
    // marginally closer bystander as long as it's alive and still in detect range.
    const a = n.aggressor;
    if (a && !a.dead && a.hp > 0 && now < n.aggroUntil && canHurt(n, a)) {
      const d = Math.hypot(a.x - n.x, a.y - n.y);
      if (d <= range && canSense(n, a.x, a.y)) return { target: a, dist: d, isPlayer: false };
    }

    // Otherwise defend-on-sight: the nearest townsperson it may hurt.
    best = range;
    for (const o of nearActors(n.x, n.y, range)) {
      if (o.kind !== 'person' || o.dead || o.hp <= 0 || !canHurt(n, o)) continue;
      const d = Math.hypot(o.x - n.x, o.y - n.y);
      if (d <= best && canSense(n, o.x, o.y)) {
        best = d;
        target = o;
      }
    }
    return target ? { target, dist: best, isPlayer: false } : null;
  }

  // Nearest living foe within `range` that `n` (a townsperson) may hurt, or null.
  // Used by NPC self-defense: townsfolk fight any enemy, AND turn on any PK player
  // (canHurt gates both — a non-PK player is never a foe). Returns
  // { enemy, dist, isPlayer } — `enemy` is the foe (enemy actor or player snapshot).
  function nearestFoeTo(n, range, players) {
    let found = null;
    let best = range;
    let isPlayer = false;
    for (const e of nearActors(n.x, n.y, range)) {
      if (!e.isEnemy || e.dead || e.hp <= 0 || !canHurt(n, e)) continue;
      const d = Math.hypot(e.x - n.x, e.y - n.y);
      if (d <= best && canSense(n, e.x, e.y)) {
        best = d;
        found = e;
        isPlayer = false;
      }
    }
    if (players) {
      for (const p of players) {
        if (p.editor) continue; // parked editor avatar is out of the fight
        if (p.hp !== undefined && p.hp <= 0) continue;
        if (!canHurt(n, { isEnemy: false, pk: p.pk })) continue; // only PKers
        const d = Math.hypot(p.x - n.x, p.y - n.y);
        if (d <= best && canSense(n, p.x, p.y)) {
          best = d;
          found = p;
          isPlayer = true;
        }
      }
    }
    return found ? { enemy: found, dist: best, isPlayer } : null;
  }

  // Repulsion from nearby actors so pursuers fan out around the target instead
  // of stacking. Sums inverse-distance pushes from every other live actor
  // within SEP_RADIUS; players aren't included, so enemies still close in.
  function separation(n) {
    let sx = 0;
    let sy = 0;
    for (const o of nearActors(n.x, n.y, SEP_RADIUS)) {
      if (o === n || o.dead || o.kind === 'deleted') continue;
      const dx = n.x - o.x;
      const dy = n.y - o.y;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > SEP_RADIUS * SEP_RADIUS) continue;
      const d = Math.sqrt(d2);
      const w = (SEP_RADIUS - d) / SEP_RADIUS; // closer => stronger
      sx += (dx / d) * w;
      sy += (dy / d) * w;
    }
    return [sx, sy];
  }

  // True if an enemy's foot box at (x,y) is clear of walls, players, and other
  // live actors — the "can a body stand here" test shared by spawning, chasing,
  // and door-follow placement.
  function footFree(self, x, y, players) {
    const fx = x - COL_W / 2;
    const fy = y + COL_OY;
    return (
      !blocked(fx, fy, COL_W, COL_H) &&
      !hitsPlayer(fx, fy, COL_W, COL_H, players) &&
      !hitsActor(self, fx, fy, COL_W, COL_H)
    );
  }

  // Try to step one tick along unit heading (ux,uy) at `speed` (defaults to the
  // chase speed): clear of walls, players, other actors, and within `leash` px
  // of home (pass Infinity to disable — e.g. inside a building after a warp,
  // where home is across the map). Moves + returns true if clear.
  function tryStep(n, ux, uy, players, leash, speed) {
    const sp = speed != null ? speed : n.chaseSpeed;
    const nx = n.x + ux * sp;
    const ny = n.y + uy * sp;
    if (!footFree(n, nx, ny, players)) return false;
    if (Math.hypot(nx - n.homeX, ny - n.homeY) > leash) return false;
    n.x = nx;
    n.y = ny;
    n.dirty = true;
    stepAnimation(n);
    return true;
  }

  // Anti-stack nudge (runs every tick, separate from the AI). Normal movement
  // (tryStep→footFree) treats actors as solid, so a step INTO another actor is
  // always rejected — which means two that somehow end up OVERLAPPING (shoved
  // together by knockback, a door-follow drop, or a spawn) can each find no
  // clear step and lock up on top of each other forever. This pushes `n` out of
  // any actor its box penetrates, checking ONLY walls (never other actors), so a
  // stacked pair can always pull apart. Edge-touching (adjacent) doesn't trigger
  // it — aabb needs real overlap — so swarming a target still works. Exactly
  // co-located actors scatter on a stable per-id angle so they don't push the
  // same way and re-stack.
  const UNSTACK_STEP = 2; // px/tick separation nudge at EQUAL weight (preserves old feel)
  // Slide `n` by `step` px along the summed direction (sx,sy), checking ONLY walls
  // (never actors). If the direct push hits a wall, try the two perpendiculars so
  // the pile still drains in a corner instead of jamming. Returns whether it moved.
  function slideApart(n, sx, sy, step) {
    const len = Math.hypot(sx, sy);
    if (len < 0.001 || step <= 0) return false;
    const ux = (sx / len) * step;
    const uy = (sy / len) * step;
    const free = (mx, my) => {
      const [fx, fy, fw, fh] = actorBox(n, mx, my);
      return !blocked(fx, fy, fw, fh);
    };
    if (free(n.x + ux, n.y + uy)) {
      n.x += ux;
      n.y += uy;
    } else if (free(n.x - uy, n.y + ux)) {
      n.x -= uy;
      n.y += ux;
    } else if (free(n.x + uy, n.y - ux)) {
      n.x += uy;
      n.y -= ux;
    } else {
      return false; // boxed in by walls on every side — can't move this tick
    }
    n.dirty = true;
    return true;
  }

  // --- Broad-phase actor grid: kill the O(N^2) per-tick scans -----------------
  // Several hot functions (unstack, separation, enemy targeting, vehicle shove)
  // used to scan ALL ~1364 actors for EACH near actor EVERY tick — millions of
  // iterations/sec → 150-230ms event-loop stalls with just 2 players. Instead we
  // bucket the live actors into a coarse grid ONCE per tick (rebuildActorGrid)
  // and query only the local cells (nearActors), turning O(near × allActors) into
  // O(near × localActors). The grid is over-inclusive at cell granularity, so
  // callers keep their exact box/distance test — same results, a fraction of the
  // work. Built from tick-start positions (actors move ≤ a few px/tick, well
  // under the cell margin), so broad-phase never misses a real neighbour.
  const GRID_CELL = 64;
  const actorGrid = new Map(); // "cx,cy" -> actor[]
  function rebuildActorGrid() {
    actorGrid.clear();
    for (const o of actors) {
      if (o.dead || o.kind === 'deleted') continue;
      const key = Math.floor(o.x / GRID_CELL) + ',' + Math.floor(o.y / GRID_CELL);
      let arr = actorGrid.get(key);
      if (!arr) actorGrid.set(key, (arr = []));
      arr.push(o);
    }
  }
  function* nearActors(x, y, radius) {
    const r = Math.max(1, Math.ceil(radius / GRID_CELL));
    const cx = Math.floor(x / GRID_CELL);
    const cy = Math.floor(y / GRID_CELL);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const arr = actorGrid.get(cx + dx + ',' + (cy + dy));
        if (arr) for (const o of arr) yield o;
      }
    }
  }

  const UNSTACK_BROAD = 48;
  function unstack(n) {
    const [bx, by, bw, bh] = actorBox(n, n.x, n.y);
    const mN = massOf(n);
    let sx = 0;
    let sy = 0;
    let shareSum = 0;
    let cnt = 0;
    for (const o of nearActors(n.x, n.y, UNSTACK_BROAD)) {
      if (o === n || o.dead || o.kind === 'deleted') continue;
      const [ox, oy, ow, oh] = actorBox(o, o.x, o.y);
      if (!aabb(bx, by, bw, bh, ox, oy, ow, oh)) continue; // not overlapping
      let dx = n.x - o.x;
      let dy = n.y - o.y;
      if (dx === 0 && dy === 0) {
        const ang = ((n.id % 16) / 16) * Math.PI * 2; // stable per-id scatter
        dx = Math.cos(ang);
        dy = Math.sin(ang);
      }
      const d = Math.hypot(dx, dy) || 1;
      sx += dx / d;
      sy += dy / d;
      // Inverse-mass: `n` yields in proportion to how heavy `o` is relative to it.
      // Equal mass → 0.5 each (the old 50/50 split); a lighter `n` gives more
      // ground, a heavier one barely budges — so the lighter body does the moving.
      const mO = massOf(o);
      shareSum += mO / (mN + mO);
      cnt++;
    }
    if (!cnt) return;
    const lightShare = shareSum / cnt; // 0.5 at equal weight → UNSTACK_STEP, as before
    slideApart(n, sx, sy, UNSTACK_STEP * 2 * lightShare);
  }

  // Walk-push: a HEAVIER player walking into a lower-mass actor shoves it aside
  // (the "plow through the level-2 townsfolk blocking the shop" case). A small
  // per-tick nudge (NOT a knockback impulse) so sustained contact slides the
  // actor out of the way smoothly without flinging it. Equal/lighter players
  // don't push — the normal mutual block (client-side) stands. Walls clamp the
  // slide (slideApart checks blocked), so nobody is shoved through a wall.
  const PLOW_STEP = 3; // px/tick base nudge from a heavier player's body
  const PLOW_STEP_MAX = 5; // cap so even a huge weight gap is a shove, not a teleport
  function pushFromPlayers(n, players) {
    if (!players || !players.length || n.kind === 'car') return;
    const [bx, by, bw, bh] = actorBox(n, n.x, n.y);
    const mN = massOf(n);
    let sx = 0;
    let sy = 0;
    let shareSum = 0;
    let cnt = 0;
    for (const p of players) {
      if (p.editor) continue; // parked editor avatar is non-solid
      if (p.hp !== undefined && p.hp <= 0) continue; // downed players don't shove
      const mP = massOf(p);
      if (mP <= mN) continue; // only a heavier player plows this actor
      const px = p.x - COL_W / 2;
      const py = p.y + COL_OY;
      if (!aabb(bx, by, bw, bh, px, py, COL_W, COL_H)) continue;
      let dx = n.x - p.x;
      let dy = n.y - p.y;
      if (dx === 0 && dy === 0) {
        const ang = ((n.id % 16) / 16) * Math.PI * 2;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
      }
      const d = Math.hypot(dx, dy) || 1;
      sx += dx / d;
      sy += dy / d;
      shareSum += mP / (mN + mP); // heavier player → bigger share → actor moves more
      cnt++;
    }
    if (!cnt) return;
    const share = shareSum / cnt; // > 0.5 (player heavier) up toward 1
    slideApart(n, sx, sy, Math.min(PLOW_STEP_MAX, PLOW_STEP * 2 * share));
  }

  // Player↔player walk-push: a HEAVIER (higher-level) player walking into a
  // lighter one shoves them aside — the "low-level peons can't block the door to
  // a higher-level player" case. Players live on the HOST, not in `actors`, so we
  // can't move them directly: the sim computes a wall-clamped landing spot
  // (`knockbackPlayerSpot`, no damage) and hands it to the host via onPlayerShoveCb
  // (→ GameHost.shovePlayer), the SAME path the vehicle plow uses. Gated on the
  // heavier player actually MOVING this tick (playerMoved) so a resting chad isn't
  // a permanent repulsion field — you push through people as you walk, not while
  // standing. Equal/lighter players don't shove: peers still mutually block.
  const PLAYER_MOVE_EPS = 0.1; // px — below this a player counts as standing still
  function pushPlayers(players, playerMoved) {
    if (!onPlayerShoveCb || players.length < 2) return;
    for (const a of players) {
      if (a.editor || (a.hp !== undefined && a.hp <= 0)) continue;
      if (!playerMoved.has(a.id)) continue; // only a MOVING player plows
      const mA = massOf(a);
      const ax = a.x - COL_W / 2;
      const ay = a.y + COL_OY;
      for (const b of players) {
        if (b === a || b.editor || (b.hp !== undefined && b.hp <= 0)) continue;
        if (massOf(b) >= mA) continue; // a only plows strictly lighter players
        const bx = b.x - COL_W / 2;
        const by = b.y + COL_OY;
        if (!aabb(ax, ay, COL_W, COL_H, bx, by, COL_W, COL_H)) continue;
        const mB = massOf(b);
        const share = mA / (mA + mB); // > 0.5; bigger gap → bigger shove
        const step = Math.min(PLOW_STEP_MAX, PLOW_STEP * 2 * share);
        const spot = knockbackPlayerSpot(b.x, b.y, a.x, a.y, 0, { dist: step });
        if (spot) {
          onPlayerShoveCb(b.id, spot);
          b.x = spot.x; // keep the local snapshot in sync so a chain of pushes this
          b.y = spot.y; // tick resolves against the moved position, not the stale one
        }
      }
    }
  }

  // Steer one tick toward (tx,ty) at `speed`, using the same separation +
  // angled-routing as the chase: straight first, then widening left/right
  // angles, first clear heading wins, so a blocked mover fans around walls and
  // each other. `leash` caps distance from home. Caller sets n.dir. Moved?
  function moveToward(n, tx, ty, speed, players, leash) {
    const dx = tx - n.x;
    const dy = ty - n.y;
    const len = Math.hypot(dx, dy) || 1;
    let ux = dx / len;
    let uy = dy / len;
    const [sepX, sepY] = separation(n);
    ux += sepX * SEP_WEIGHT;
    uy += sepY * SEP_WEIGHT;
    const ml = Math.hypot(ux, uy) || 1;
    ux /= ml;
    uy /= ml;
    for (const a of STEER_ANGLES) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      if (tryStep(n, ux * c - uy * s, ux * s + uy * c, players, leash, speed)) return true;
    }
    return false;
  }

  // Nearest free foot spot to (cx,cy) within ~96px, or null — used to drop a
  // door-following enemy beside where the player landed without stacking on it.
  function findFreeNear(cx, cy, self, players) {
    if (footFree(self, cx, cy, players)) return { x: cx, y: cy };
    for (let r = 12; r <= 96; r += 12) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2 + (r / 12) * 0.4;
        const x = Math.round(cx + Math.cos(ang) * r);
        const y = Math.round(cy + Math.sin(ang) * r);
        if (footFree(self, x, y, players)) return { x, y };
      }
    }
    return null;
  }

  // Regroup: bring an enemy that lost its target back to its spawn point. If it
  // chased a player through doors, retrace them (warp back out at each recorded
  // door) before walking home. Returns true while still en route, false once it
  // has arrived (caller flips it back to patrol). A retrace that can't make
  // progress gives up after RETURN_GIVEUP_MS and snaps home, so a pack always
  // regroups even if greedy steering wedges it.
  function tickReturn(n, players, now) {
    if (now - n.returnSince > RETURN_GIVEUP_MS) {
      n.x = n.homeX;
      n.y = n.homeY;
      n.dir = n.homeDir;
      n.warpStack.length = 0;
      n.dirty = true;
      return false;
    }
    const stack = n.warpStack;
    if (stack.length) {
      const top = stack[stack.length - 1];
      if (Math.hypot(n.x - top.inX, n.y - top.inY) <= RETURN_ARRIVE) {
        // Reached the inside of the door we came through — warp back out.
        const spot = findFreeNear(top.outX, top.outY, n, players) || { x: top.outX, y: top.outY };
        n.x = spot.x;
        n.y = spot.y;
        n.dir = n.homeDir;
        n.dirty = true;
        stack.pop();
        return true;
      }
      n.dir = faceDir(top.inX - n.x, top.inY - n.y);
      moveToward(n, top.inX, top.inY, n.chaseSpeed, players, Infinity);
      return true;
    }
    // No chase path to retrace, but we're an outdoor enemy still standing inside
    // a room (lured in, then lost the target): walk to the nearest homeward door
    // and warp through it — never teleport across the room. After warping we'll
    // be outside and fall through to the straight walk-home below next tick.
    if (!n.indoor && sectorIndoorAt(n.x, n.y)) {
      const door = exitDoorToward(n);
      if (door) {
        if (Math.hypot(n.x - door.x, n.y - door.y) <= DOOR_TRIGGER_REACH) {
          const spot = findFreeNear(door.destX, door.destY, n, players) || {
            x: door.destX,
            y: door.destY,
          };
          n.x = spot.x;
          n.y = spot.y;
          n.dir = n.homeDir;
          n.dirty = true;
          return true; // emerged outside — keep returning from here next tick
        }
        n.dir = faceDir(door.x - n.x, door.y - n.y);
        moveToward(n, door.x, door.y, n.chaseSpeed, players, Infinity);
        return true;
      }
      // No door leads homeward (shouldn't happen) — fall through; the
      // RETURN_GIVEUP_MS snap above is the backstop.
    }
    if (Math.hypot(n.x - n.homeX, n.y - n.homeY) <= RETURN_ARRIVE) return false;
    n.dir = faceDir(n.homeX - n.x, n.homeY - n.y);
    moveToward(n, n.homeX, n.homeY, n.speed, players, Infinity);
    return true;
  }

  // Walk a committed chaser to the doorway its target warped through and warp it
  // through on contact — the enemy uses the door at its own movement rate, never
  // teleporting across the room. Records the door on warpStack so the regroup
  // retraces back out. Gives up (and regroups) if it can't reach the doorway.
  function tickDoorSeek(n, players, now) {
    const d = n.pendingDoor;
    if (!d) {
      n.mode = 'chase';
      return;
    }
    // Reached the doorway — warp through, just like the player did.
    if (Math.hypot(n.x - d.triggerX, n.y - d.triggerY) <= DOOR_TRIGGER_REACH) {
      const spot = findFreeNear(d.destX, d.destY, n, players) || { x: d.destX, y: d.destY };
      n.warpStack.push({ outX: d.triggerX, outY: d.triggerY, inX: d.destX, inY: d.destY });
      n.x = spot.x;
      n.y = spot.y;
      n.dirty = true;
      n.pendingDoor = null;
      n.mode = 'chase'; // re-acquire the target on the far side next tick
      return;
    }
    // Walk to the doorway at the normal chase pace; bail if we get wedged.
    n.dir = faceDir(d.triggerX - n.x, d.triggerY - n.y);
    moveToward(n, d.triggerX, d.triggerY, n.chaseSpeed, players, Infinity);
    if (now - n.doorSince > DOOR_GIVEUP_MS) {
      n.pendingDoor = null;
      n.mode = 'return';
      n.returnSince = now;
    }
  }

  // Roamers wander town-wide (bounded by spawner.wanderRadius from the spawn
  // point), unlike townsfolk leashed to a 32px home. With a player in sight
  // they break off and pursue, swinging when they get in range.
  function tickEnemy(n, players, now, onEnemyHit, warps) {
    // Hold position while a swing or flinch is playing so its generated frames
    // show (movement would overwrite the frame via stepAnimation).
    if ((n.pose === 'attack' || n.pose === 'hurt') && now < n.poseUntil) return;

    // EarthBound-style avoidance, BEFORE any chase/door logic: if a player who
    // out-levels this enemy (>= FLEE_LEVEL_RATIO×) is nearby, it never chases or
    // attacks them — it FLEES, and a touch from that player is an automatic win.
    {
      let scary = null;
      let scaryD = Infinity;
      for (const p of players) {
        if (p.editor || (p.hp !== undefined && p.hp <= 0) || !outLevels(p, n)) continue;
        const d = Math.hypot(p.x - n.x, p.y - n.y);
        if (d < scaryD) {
          scaryD = d;
          scary = p;
        }
      }
      if (scary) {
        // Contact = instant victory: lethal self-damage credited to the scarer
        // runs the normal kill path (XP + loot drops). No battle, no knockback —
        // exactly EB's "you won" on touching a fled-from foe. No LoS needed; if
        // they're touching, they see it.
        if (scaryD <= FLEE_TOUCH_RADIUS) {
          applyDamage(n, n.hp, now, scary.id);
          return;
        }
        // In sight range: run directly away from the scariest player (no leash —
        // a fleer may leave its wander radius). Regroups home once it's clear.
        if (scaryD <= (n.detectRange || DETECT_RANGE) && canSense(n, scary.x, scary.y)) {
          n.mode = 'flee';
          n.targetId = null;
          const len = scaryD || 1;
          const ax = n.x + ((n.x - scary.x) / len) * 200;
          const ay = n.y + ((n.y - scary.y) / len) * 200;
          n.dir = faceDir(ax - n.x, ay - n.y);
          moveToward(n, ax, ay, n.chaseSpeed, players, Infinity);
          return;
        }
      }
    }

    // Already walking to a doorway: finish that before anything else, so a
    // townsperson at the door can't steal the chase and an interior stamped
    // close by can't re-lock aggro into a wall.
    if (n.mode === 'door') {
      tickDoorSeek(n, players, now);
      return;
    }

    // Door-follow has top priority. If the player we're chasing warped through a
    // door recently (within WARP_FOLLOW_MS) and we're still close to where it
    // stood, COMMIT to that doorway: walk there and warp through on contact (see
    // tickDoorSeek) rather than teleporting across the room. The warp outlives
    // one tick, so an enemy mid-swing when the player vanished commits the moment
    // its pose clears (see WARP_FOLLOW_MS); once committed it heads to the door
    // at its own pace even after the warp record expires.
    if (n.mode === 'chase' && n.targetId != null) {
      const w = warps.get(n.targetId);
      const top = n.warpStack[n.warpStack.length - 1];
      const already = top && top.inX === (w && w.toX) && top.inY === (w && w.toY);
      if (w && !already && Math.hypot(n.x - w.fromX, n.y - w.fromY) <= WARP_FOLLOW_RANGE) {
        // Walk to the doorway and warp through on contact (tickDoorSeek) — NEVER
        // teleport across the room. `w.door` is always a real resolved door now
        // (the detector only records a warp when one sits at the crossing; a
        // door-less jump is a teleport and is never followed), so the enemy
        // physically routes to that doorway just like the player did.
        const cross = w.door;
        n.pendingDoor = { triggerX: cross.x, triggerY: cross.y, destX: w.toX, destY: w.toY };
        n.doorSince = now;
        n.mode = 'door';
        tickDoorSeek(n, players, now);
        return;
      }
    }

    const aggro = aggroTarget(n, players, now);
    if (aggro) {
      const { target, dist, isPlayer } = aggro;
      n.mode = 'chase';
      n.targetId = isPlayer ? target.id : null; // only players warp through doors
      const dx = target.x - n.x;
      const dy = target.y - n.y;
      n.dir = faceDir(dx, dy);

      // In striking range AND with a clear line (no wall AND no doorway between):
      // stand and swing on cooldown (resolved server-side; the pose broadcasts so
      // every client sees the attack). A wall OR a door between them drops to the
      // chase below, so the enemy paths to/through the doorway — becoming visible
      // in your room — instead of hitting across the seam (an invisible attacker).
      const reachBlocked =
        wallBetween(n.x, n.y, target.x, target.y) || doorBetween(n.x, n.y, target.x, target.y);
      if (dist <= (n.attackRange || ATTACK_RANGE) && !reachBlocked) {
        if (now - n.lastSwing >= n.attackCooldown && n.pose !== 'hurt') {
          n.lastSwing = now;
          n.pose = 'attack';
          n.poseStart = now;
          n.poseUntil = now + ENEMY_ATTACK_POSE_MS;
          n.frame = 0; // start on the wind-up frame
          n.dirty = true;
          // Player HP lives on the host; an NPC target is ours to damage.
          if (isPlayer) {
            // The player's Speed can dodge the swing (broadcast a MISS, no
            // damage). Enemies don't crit yet (n.crit defaults 0) but the hook is
            // here for per-enemy crit tuning later.
            const res = resolveMelee(n.crit || 0, target.dodge || 0, n.damage, rng);
            if (res.miss) {
              if (broadcastCb)
                broadcastCb({
                  type: 'combat',
                  evt: 'miss',
                  x: target.x,
                  y: target.y,
                  byPlayer: null,
                  targetPlayer: target.id,
                });
            } else {
              if (onEnemyHit)
                onEnemyHit(
                  target.id,
                  res.dmg,
                  n,
                  knockbackPlayerSpot(target.x, target.y, n.x, n.y, res.dmg, {
                    amass: massOf(n),
                    vmass: massOf(target),
                  }),
                  enemyInflict(n)
                );
              if (res.crit && broadcastCb)
                broadcastCb({
                  type: 'combat',
                  evt: 'crit',
                  x: target.x,
                  y: target.y,
                  byPlayer: null,
                  targetPlayer: target.id,
                });
            }
          } else {
            // Enemy → townsperson: the SAME inflict spec the enemy uses on
            // players (enemyInflict); tryStatus scales it by the victim's resist.
            applyDamage(target, n.damage, now, null, {
              x: n.x,
              y: n.y,
              amass: massOf(n),
              inflict: enemyInflict(n),
            });
          }
        }
        return;
      }

      // Otherwise close in. moveToward fans out around walls/each other. A locked
      // chase has NO home-distance leash — the enemy follows relentlessly wherever
      // the target goes (give-up is purely the target-distance check in
      // aggroTarget above); once it loses the target it paths back home.
      moveToward(n, target.x, target.y, n.chaseSpeed, players, Infinity);
      return;
    }

    // No target this tick. A door-follow chance was already taken at the top of
    // the tick if the chased player warped; reaching here means there's no live
    // warp to follow — the target is genuinely gone, so regroup at spawn. A
    // 'flee' that reaches here means the scary player left detect range, so it
    // also heads home instead of stranding wherever it fled to.
    if (n.mode === 'chase' || n.mode === 'flee') {
      n.mode = 'return';
      n.returnSince = now;
      n.targetId = null;
    }

    // Stuck inside a room with no one to chase: an outdoor-spawned enemy (home in
    // the overworld) that got lured into a building can't wander (its leash is
    // pinned to a home that's now across a warp), so it would idle in the room
    // forever. Send it home — tickReturn walks it out the nearest door.
    if (n.mode === 'patrol' && !n.indoor && sectorIndoorAt(n.x, n.y)) {
      n.mode = 'return';
      n.returnSince = now;
    }

    if (n.mode === 'return') {
      if (tickReturn(n, players, now)) return; // still en route
      n.mode = 'patrol'; // arrived — resume wandering
      startIdle(n);
    }

    if (n.life === 'walk') {
      const nx = n.x + n.walkDx * n.speed;
      const ny = n.y + n.walkDy * n.speed;
      // wanderRadius 0 = STATIONARY (ambush mimics): any step exceeds 0 from home
      // and is rejected, so the enemy holds its spawn until a player aggros it.
      // Use != null (not ||) so 0 is honored. Resolved per-instance first (a
      // placement's props), then the spawner's field, then the 256px default.
      const wr =
        n.wanderRadius != null
          ? n.wanderRadius
          : n.spawner && n.spawner.wanderRadius != null
            ? n.spawner.wanderRadius
            : 256;
      const stop =
        blocked(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H) ||
        hitsPlayer(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H, players) ||
        hitsActor(n, nx - COL_W / 2, ny + COL_OY, COL_W, COL_H) ||
        Math.hypot(nx - n.homeX, ny - n.homeY) > wr;
      if (!stop) {
        n.x = nx;
        n.y = ny;
        n.dirty = true;
        stepAnimation(n);
      }
      if (stop || --n.timer <= 0) startIdle(n);
      return;
    }
    if (--n.timer > 0) return;
    if (Math.random() < 0.8) {
      const c = CARDINALS[rand(0, CARDINALS.length - 1)];
      n.dir = c.dir;
      n.walkDx = c.dx;
      n.walkDy = c.dy;
      n.life = 'walk';
      n.timer = rand(30, 110);
      n.dirty = true;
    } else {
      startIdle(n);
    }
  }

  // A free spot to drop a new enemy: the spawn anchor if clear, otherwise the
  // nearest unblocked, unoccupied point around it (within the wander radius).
  // Returns null when everything nearby is taken — so an enemy is never spawned
  // on a wall, on a player, or on top of another actor. `self` is the candidate
  // (skipped in the overlap test; it's still dead at this point anyway).
  function findSpawnSpot(sp, ppos, self) {
    if (footFree(self, sp.x, sp.y, ppos)) return { x: sp.x, y: sp.y };
    const wr = sp.wanderRadius || 256;
    const maxR = Math.min(wr, 128); // keep new enemies near the anchor, not scattered
    for (let r = 16; r <= maxR; r += 16) {
      for (let a = 0; a < 8; a++) {
        // Rotate each ring slightly so samples don't all share the same spokes.
        const ang = (a / 8) * Math.PI * 2 + (r / 16) * 0.4;
        const x = Math.round(sp.x + Math.cos(ang) * r);
        const y = Math.round(sp.y + Math.sin(ang) * r);
        if (Math.hypot(x - sp.x, y - sp.y) > wr) continue;
        if (footFree(self, x, y, ppos)) return { x, y };
      }
    }
    return null;
  }

  // Wake pooled roamers at their spawn point over time, up to maxActive, and
  // only while a player is near (no point populating an empty town).
  function updateSpawners(now, ppos) {
    for (const sp of SPAWNERS) {
      const playerNear = ppos.some(
        (p) => Math.abs(p.x - sp.x) < ACTIVE_RADIUS && Math.abs(p.y - sp.y) < ACTIVE_RADIUS
      );
      if (!playerNear) continue;
      if (now - (sp._lastSpawn || 0) < (sp.spawnIntervalMs || 3000)) continue;
      const slots = pool.filter((n) => n.spawner === sp);
      const active = slots.filter((n) => !n.dead).length;
      if (active >= (sp.maxActive || slots.length)) continue;
      const cand = slots.find((n) => n.dead && now >= n.respawnAt);
      if (!cand) continue;
      // No spawning on a wall, a player, or another actor. If nothing nearby is
      // free, leave _lastSpawn untouched so the spawner keeps trying and pops the
      // enemy the moment a spot opens up.
      const spot = findSpawnSpot(sp, ppos, cand);
      if (!spot) continue;
      cand.x = spot.x;
      cand.y = spot.y;
      cand.homeX = sp.x;
      cand.homeY = sp.y;
      cand.dir = 1;
      cand.frame = 0;
      cand.life = 'idle';
      cand.timer = rand(20, 60);
      cand.hp = cand.maxHp;
      cand.dead = false;
      cand.pose = 'walk';
      cand.aggressor = null;
      cand.aggroUntil = 0;
      cand.mode = 'patrol';
      cand.targetId = null;
      cand.warpStack.length = 0;
      cand.pendingDoor = null;
      cand.doorSince = 0;
      cand.dirty = true;
      cand.hpDirty = true;
      sp._lastSpawn = now;
    }
  }

  // ROM-placed enemies (no spawner) revive at their home spot after a delay.
  function reviveStatics(now) {
    for (const n of enemies) {
      if (n.spawner || !n.dead || now < n.respawnAt) continue;
      n.x = n.homeX;
      n.y = n.homeY;
      n.dir = n.homeDir;
      n.frame = 0;
      n.life = 'idle';
      n.timer = rand(60, 300);
      n.hp = n.maxHp;
      n.dead = false;
      n.pose = 'walk';
      n.aggressor = null;
      n.aggroUntil = 0;
      n.mode = 'patrol';
      n.targetId = null;
      n.warpStack.length = 0;
      n.pendingDoor = null;
      n.doorSince = 0;
      n.dirty = true;
      n.hpDirty = true;
    }
  }

  // Downed townsfolk revive at their home spot after a delay (backlog: a chosen
  // hospital / respawn point per entity). Mirrors reviveStatics for persons.
  function reviveNpcs(now) {
    for (const n of actors) {
      if (n.kind !== 'person' || !n.dead || now < n.respawnAt) continue;
      n.x = n.homeX;
      n.y = n.homeY;
      n.dir = n.homeDir;
      n.frame = 0;
      n.pose = 'walk';
      n.life = 'idle';
      n.timer = rand(60, 300);
      n.hp = n.maxHp;
      n.dead = false;
      n.dirty = true;
      n.hpDirty = true;
    }
  }

  // Destroyed traffic cars respawn at their route start after a delay, then drive
  // the loop again — same lifecycle as a downed townsperson (reviveNpcs), but a
  // car restarts at waypoint 0 heading to waypoint 1. Entity Manager vehicles are
  // kind 'person' and revive via reviveNpcs already.
  function reviveCars(now) {
    for (const n of vehicles) {
      if (n.kind !== 'car' || !n.dead || now < n.respawnAt) continue;
      n.x = n.homeX;
      n.y = n.homeY;
      n.dir = n.homeDir;
      n.frame = 0;
      n.pose = 'walk';
      n.wpIndex = 1; // heading toward the second waypoint again
      n.step = 1;
      n.hp = n.maxHp;
      n.dead = false;
      n.dirty = true;
      n.hpDirty = true;
    }
  }

  // Apply `dmg` to a live actor WE own (enemy or townsperson): flinch, broadcast
  // HP, and on death hide + schedule the right revival. Enemies award the killer
  // their EXP (players only — killerPlayerId is null for NPC-dealt kills);
  // townsfolk just go down and respawn at home. The single death path shared by
  // player swings (handleAttack), enemy swings, and NPC self-defense.
  // Shove an in-sim actor away from (fromX,fromY) by knockDist(dmg) px, sliding
  // in KB_STEP increments and stopping at the first step that would put its
  // collision box into a wall/edge. Marks it dirty so the new spot broadcasts.
  // `opts` (optional) tunes the shove: `dir` overrides the away-from-attacker
  // unit heading (vehicles aim the scatter), `mult` scales the distance past the
  // normal cap (a car plows much further than a fist). Default = old behaviour.
  function pushActor(o, fromX, fromY, dmg, opts) {
    if (!o || o.dead) return;
    let ux = opts && opts.dir ? opts.dir.x : o.x - fromX;
    let uy = opts && opts.dir ? opts.dir.y : o.y - fromY;
    const len = Math.hypot(ux, uy);
    if (len < 0.001) return; // co-located / no heading — no push
    ux /= len;
    uy /= len;
    let cx = o.x;
    let cy = o.y;
    let rem =
      opts && opts.dist != null ? opts.dist : knockDist(dmg) * (opts && opts.mult ? opts.mult : 1);
    // Damage-based knockback (not an explicit `dist` shove) scales by the
    // attacker/victim weight class: a heavy victim resists, a heavy attacker
    // flings, clamped back under KB_MAX so it can't cross a room.
    if (!(opts && opts.dist != null)) {
      rem = Math.min(KB_MAX, rem * massKnockScale(opts && opts.amass, massOf(o)));
    }
    while (rem > 0) {
      const step = Math.min(KB_STEP, rem);
      const nx = cx + ux * step;
      const ny = cy + uy * step;
      const [bx, by, bw, bh] = actorBox(o, nx, ny);
      if (blocked(bx, by, bw, bh)) break;
      cx = nx;
      cy = ny;
      rem -= step;
    }
    if (cx !== o.x || cy !== o.y) {
      o.x = cx;
      o.y = cy;
      o.dirty = true;
    }
  }

  // Knockback landing spot for a HOST-owned player (foot box) shoved away from
  // (fromX,fromY). Pure — returns {x,y} (rounded) or null if it can't move; the
  // host applies it and broadcasts a player_push. Same slide/clamp as pushActor.
  function knockbackPlayerSpot(px, py, fromX, fromY, dmg, opts) {
    let ux = opts && opts.dir ? opts.dir.x : px - fromX;
    let uy = opts && opts.dir ? opts.dir.y : py - fromY;
    const len = Math.hypot(ux, uy);
    if (len < 0.001) return null;
    ux /= len;
    uy /= len;
    let cx = px;
    let cy = py;
    let rem =
      opts && opts.dist != null ? opts.dist : knockDist(dmg) * (opts && opts.mult ? opts.mult : 1);
    // Weight-class scaling (see massKnockScale): a high-level player barely moves
    // when a weak enemy connects; a heavy hit on a light victim flings toward the
    // cap. `vmass` is the victim's mass, passed by the caller (it has the player).
    if (!(opts && opts.dist != null)) {
      rem = Math.min(KB_MAX, rem * massKnockScale(opts && opts.amass, opts && opts.vmass));
    }
    while (rem > 0) {
      const step = Math.min(KB_STEP, rem);
      const nx = cx + ux * step;
      const ny = cy + uy * step;
      if (blocked(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H)) break;
      cx = nx;
      cy = ny;
      rem -= step;
    }
    return cx !== px || cy !== py ? { x: Math.round(cx), y: Math.round(cy) } : null;
  }

  // Roll a `chance`% proc of status `type` on an in-sim actor. The catalog +
  // duration + the post-effect immunity window (diminishing returns) live in
  // status.js. The proc is scaled by the target's ROM vulnerability for the
  // status' element (paralysis/hypnosis/flash; canon resist — 0% = immune).
  // A successful action-blocking proc holds the flinch pose for the freeze.
  function tryStatus(target, type, chance, now) {
    if (!target || target.dead) return;
    const el = status.elementOf(type);
    const eff = el ? chance * (entityVuln(target.sprite, el, 100) / 100) : chance;
    if (!status.tryInflict(target, type, eff, now, rng)) return;
    if (status.defOf(type) && status.defOf(type).blocksAction) {
      target.pose = 'hurt';
      target.poseStart = now;
      target.poseUntil = target.statuses[type].until; // hold the flinch for the freeze
      target.frame = 0;
    }
    target.dirty = true;
    target.statusDirty = true; // re-broadcast this actor's status set (drives client pips)
  }

  // `atk` (optional) = {x, y, stunChance} of the attacker — drives knockback
  // (shove the victim away from x,y, scaled by dmg) and the stun proc. Omitted by
  // legacy/test callers, which just apply HP + the flinch with no hit-reaction.
  function applyDamage(target, dmg, now, killerPlayerId, atk) {
    if (!target || target.dead || target.hp <= 0) return;
    status.breakOnHit(target, now); // a hit wakes a sleeping actor
    // Equipped armor (townsfolk who grabbed gear) soaks flat damage; a hit always
    // lands for at least 1 so armor can't make an actor unkillable.
    if (target.armorBonus) dmg = Math.max(1, dmg - target.armorBonus);
    target.hp -= dmg;
    target.hpDirty = true;
    target.pose = 'hurt';
    target.poseStart = now;
    target.poseUntil = now + HURT_MS;
    target.frame = 0; // start on the recoil frame; the tick loop plays f0->f1
    target.dirty = true;
    if (target.hp <= 0) {
      target.hp = 0;
      target.dead = true;
      // Death throw: tell clients which way the corpse should tumble + how hard.
      // The body flies AWAY from the attacker (unit vector atk->target); `force`
      // is the killing blow's damage (drives the rotate-and-bounce distance in
      // DeathFx). No `atk` (poison / scripted kill) → 0,0 = rotate in place.
      // Visual only; the batched npc_hp delta still hides the live sprite.
      if (broadcastCb) {
        let dx = atk ? target.x - atk.x : 0;
        let dy = atk ? target.y - atk.y : 0;
        const len = Math.hypot(dx, dy);
        if (len > 0.001) {
          dx /= len;
          dy /= len;
        } else {
          dx = 0;
          dy = 0;
        }
        broadcastCb({ type: 'npc_death', id: target.id, dx, dy, force: dmg });
      }
      if (target.isEnemy) {
        target.respawnAt =
          now + (target.spawner ? target.spawner.respawnDelayMs || 9000 : STATIC_RESPAWN_MS);
        if (killerPlayerId != null) {
          const loot = rollLoot(target.sprite);
          // Items become first-touch ground drops at the death spot (anyone can
          // grab them); money is still credited to the killer (→ bank in Phase E).
          const items = (loot && loot.items) || [];
          for (const it of items) {
            // Each item ejects from the corpse to its own random landing spot, so
            // it pops out and settles nearby instead of under the killer's feet.
            const land = ejectLanding(target.x, target.y);
            spawnDrop(
              'item',
              land.x,
              land.y,
              { item: it.item, name: it.itemName || '' },
              {
                x: target.x,
                y: target.y,
              }
            );
          }
          if (onEnemyKillCb)
            onEnemyKillCb(
              killerPlayerId,
              target.xp || 0,
              target,
              loot ? { money: loot.money } : null
            );
        }
      } else {
        target.respawnAt = now + NPC_RESPAWN_MS;
      }
      // Whatever the actor was hauling drops back onto the ground — for ANY
      // death (player kill, NPC kill, or poison), enemy or townsperson alike.
      ejectCarried(target);
    } else if (atk) {
      // Survived the hit — react to it: knocked back away from the attacker, plus
      // any status procs the hit carries (each element-scaled by the target's ROM
      // resist in tryStatus; an action-block holds the flinch for the freeze).
      // `atk.kb` (vehicles) overrides the shove heading/force for the plow effect;
      // `atk.amass` (attacker mass) scales the knockback by weight class.
      const kbOpts = atk.kb ? Object.assign({}, atk.kb) : {};
      if (atk.amass != null) kbOpts.amass = atk.amass;
      pushActor(target, atk.x, atk.y, dmg, kbOpts);
      for (const inf of atk.inflict || []) tryStatus(target, inf.type, inf.chance, now);
    }
  }

  // Resolve a player's melee swing: a hitbox in front of the attacker damages
  // every live enemy whose hurtbox it overlaps. Authoritative — the client only
  // requests the swing; HP, death, and respawn all live here.
  // --- Lag compensation: hits register against what the ATTACKER SAW ----------
  // Each enemy keeps a short, flat position history [t,x,y, t,x,y, ...]. When a
  // player swings, we rewind the enemy to where it was on the attacker's screen
  // (~interp delay + their latency ago) and test the hitbox against THAT spot, so
  // a fleeing enemy you aimed at still gets hit instead of the swing landing where
  // the server has already moved it. Damage/knockback still apply to the LIVE
  // enemy — only the hit TEST uses the rewound position. Flat number array (no
  // per-tick object churn). NETWORK_REMODEL.md (the 3rd netcode pillar).
  const HIST_MS = 500; // history window — must exceed the largest rewind
  function recordHist(n, now) {
    let h = n._hist;
    if (!h) h = n._hist = [];
    h.push(now, n.x, n.y);
    while (h.length > 3 && now - h[0] > HIST_MS) h.splice(0, 3);
  }
  function histPosAt(n, t) {
    const h = n._hist;
    if (!h || h.length < 3) return n;
    if (t >= h[h.length - 3]) return n; // newer than newest sample → live position
    if (t <= h[0]) return { x: h[1], y: h[2] };
    for (let i = h.length - 3; i >= 3; i -= 3) {
      const t0 = h[i - 3];
      const t1 = h[i];
      if (t0 <= t && t <= t1) {
        const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        return { x: h[i - 2] + (h[i + 1] - h[i - 2]) * k, y: h[i - 1] + (h[i + 2] - h[i - 1]) * k };
      }
    }
    return n;
  }

  function handleAttack(
    x,
    y,
    dir,
    playerId,
    offense,
    attackerPk,
    critChance = 0,
    attackSpeed = 1,
    inflict = null,
    range = 0,
    attackerLevel = 1,
    projSpeed = 0,
    pierce = false,
    projSprite = null,
    rewindMs = 0
  ) {
    const now = Date.now();
    // The attacker's weight class drives knockback vs the victim's (see
    // massKnockScale): a high-level player flings weaker foes harder. Defaults to
    // level 1 for legacy/test callers (→ scale 1 unless the victim is heavier).
    const attackerMass = massOf({ level: attackerLevel });
    // The status spec this swing carries. The equipped weapon supplies it
    // (gameHost → recomputeEquipStats); `null` means an unauthored weapon / bare
    // hands / a legacy caller, which falls back to the baseline paralysis proc so
    // behavior is unchanged unless a weapon authors its own inflicts.
    const swingInflict =
      inflict == null
        ? [{ type: status.STATUS.PARALYSIS, chance: PLAYER_PARALYSIS_CHANCE }]
        : inflict;
    // Per-player swing cooldown scales with the weapon's attackSpeed (1 = baseline,
    // >1 = faster), floored so no weapon/buy combo becomes an auto-shredder.
    const cooldown = Math.max(
      ATTACK_COOLDOWN_FLOOR_MS,
      ATTACK_COOLDOWN_MS / (attackSpeed > 0 ? attackSpeed : 1)
    );
    if (now - (lastAttackAt[playerId] || 0) < cooldown) return;
    lastAttackAt[playerId] = now;
    // PK gating: build the attacker's shape once. A player is never an enemy;
    // its `pk` decides whether it may hit non-PK targets. Today npcSim only
    // owns enemies (all PK), so a non-PK player can already hit them — but the
    // check keeps the rule centralized for when NPCs/PvP become damageable.
    const attacker = { isEnemy: false, pk: !!attackerPk };
    // Damage scales with the attacker's Offense stat (leveling makes you hit
    // harder); falls back to the flat constant if none was passed.
    const base = offense > 0 ? offense : ATTACK_DAMAGE;
    const v = DIR_VEC[dir] || DIR_VEC[0];
    // Ranged weapon: don't resolve a hitbox here — launch a projectile that flies
    // forward over the next ticks (stepProjectiles) and damages the first target
    // it overlaps, or EVERY new target if the weapon pierces. Same dodge/crit/LoS/
    // knockback resolution a melee swing uses, just spread over its flight.
    if (range > 0) {
      spawnProjectile({
        x: x + v[0] * 6, // muzzle, just ahead of the body
        y: y - 10 + v[1] * 6, // chest height, like the melee box
        vx: v[0],
        vy: v[1],
        speed: projSpeed,
        maxDist: range,
        base,
        critChance,
        attacker,
        attackerId: playerId,
        attackerMass,
        inflict: swingInflict,
        pierce,
        sprite: projSprite,
      });
      return;
    }
    // Melee: a small box in front of the attacker damages every enemy it overlaps.
    let hx, hy, hw, hh;
    hx = x + v[0] * ATTACK_REACH - ATTACK_HALF;
    hy = y - 10 + v[1] * ATTACK_REACH - ATTACK_HALF;
    hw = ATTACK_HALF * 2;
    hh = ATTACK_HALF * 2;
    // Total damage THIS swing dealt to enemies. Drives the attacker's hit juice
    // (freeze + shake) via a server-confirmed 'hit' event below, so only a swing
    // that actually connected rattles the attacker's screen — never an air-swing.
    let dealtToEnemies = 0;
    for (const n of enemies) {
      if (n.dead) continue;
      if (!canHurt(attacker, n)) continue; // PK rules decide if this lands
      // Lag comp: test the hitbox against where the attacker SAW this enemy
      // (rewound), not its live spot. Damage/knockback below still hit the live n.
      const seen = rewindMs > 0 ? histPosAt(n, now - rewindMs) : n;
      if (!aabb(hx, hy, hw, hh, seen.x - HURT_W / 2, seen.y + HURT_OY, HURT_W, HURT_H)) continue;
      if (wallBetween(x, y, seen.x, seen.y)) continue; // no reaching through a wall
      // The hitbox connected — now roll the outcome. The enemy's own dodge can
      // turn a connecting swing into a clean miss; a crit doubles the damage.
      const res = resolveMelee(critChance, n.dodge || 0, base, rng);
      if (res.miss) {
        // Dodged: floating "MISS" text for everyone; no damage.
        if (broadcastCb)
          broadcastCb({
            type: 'combat',
            evt: 'miss',
            x: n.x,
            y: n.y,
            byPlayer: playerId,
            targetPlayer: null,
          });
        continue;
      }
      // Shared death path: flinch, HP broadcast, respawn, and EXP to the killer.
      // The attacker's feet (x,y) drive knockback; the swing carries a paralysis
      // proc (element-scaled by the enemy's ROM resist in tryStatus).
      applyDamage(n, res.dmg, now, playerId, { x, y, amass: attackerMass, inflict: swingInflict });
      dealtToEnemies += res.dmg;
      if (res.crit && broadcastCb)
        broadcastCb({
          type: 'combat',
          evt: 'crit',
          x: n.x,
          y: n.y,
          byPlayer: playerId,
          targetPlayer: null,
        });
    }
    // The swing connected with at least one enemy: tell the attacker so their hit
    // juice fires (client gates on byPlayer === local). Broadcast to all like the
    // crit/miss events; everyone else ignores it. `dmg` scales the shake.
    if (dealtToEnemies > 0 && broadcastCb)
      broadcastCb({
        type: 'combat',
        evt: 'hit',
        x: Math.round(x),
        y: Math.round(y),
        byPlayer: playerId,
        targetPlayer: null,
        dmg: dealtToEnemies,
      });

    // Vehicles (traffic cars + Entity Manager `vehicle` flag) are attackable too,
    // under the SAME PK rules (canHurt): a PKer can wreck any vehicle, a non-PKer
    // only a PK-flagged one. The whole body box is the hurtbox so a swing anywhere
    // on the car connects (its foot box would be tiny for a big sprite). Vehicles
    // don't dodge and carry no status proc; death/respawn run through applyDamage's
    // shared non-enemy path (→ reviveCars for cars, reviveNpcs for EM vehicles).
    for (const n of vehicles) {
      if (n.dead || n.hp <= 0) continue;
      if (!canHurt(attacker, n)) continue; // PK rules decide if this lands
      const [vbx, vby, vbw, vbh] = actorBox(n, n.x, n.y);
      if (!aabb(hx, hy, hw, hh, vbx, vby, vbw, vbh)) continue;
      if (wallBetween(x, y, n.x, n.y)) continue; // no reaching through a wall
      const res = resolveMelee(critChance, 0, base, rng);
      if (res.miss) {
        if (broadcastCb)
          broadcastCb({
            type: 'combat',
            evt: 'miss',
            x: n.x,
            y: n.y,
            byPlayer: playerId,
            targetPlayer: null,
          });
        continue;
      }
      applyDamage(n, res.dmg, now, playerId, { x, y, inflict: [] });
      if (res.crit && broadcastCb)
        broadcastCb({
          type: 'combat',
          evt: 'crit',
          x: n.x,
          y: n.y,
          byPlayer: playerId,
          targetPlayer: null,
        });
    }

    // PvP: the SAME swing also lands on other players the PK rules allow (PK
    // players hurt anyone; anyone hurts a PKer). Player HP lives on the host, so
    // a connecting hit is applied via onPlayerHitCb (→ GameHost.damagePlayer).
    if (getPlayersCb && onPlayerHitCb) {
      for (const t of getPlayersCb()) {
        if (t.id === playerId) continue; // never hit yourself
        if (t.editor) continue; // parked editor avatar is out of the fight
        if (t.hp !== undefined && t.hp <= 0) continue; // already down
        if (!canHurt(attacker, { isEnemy: false, pk: t.pk })) continue; // PK gate
        if (!aabb(hx, hy, hw, hh, t.x - HURT_W / 2, t.y + HURT_OY, HURT_W, HURT_H)) continue;
        if (wallBetween(x, y, t.x, t.y)) continue; // no reaching through a wall
        const res = resolveMelee(critChance, t.dodge || 0, base, rng);
        if (res.miss) {
          if (broadcastCb)
            broadcastCb({
              type: 'combat',
              evt: 'miss',
              x: t.x,
              y: t.y,
              byPlayer: playerId,
              targetPlayer: t.id,
            });
          continue;
        }
        // Knock the victim back from the attacker's feet (host applies + pushes)
        // and carry the same paralysis proc a player swing lands on enemies.
        onPlayerHitCb(
          t.id,
          res.dmg,
          playerId,
          knockbackPlayerSpot(t.x, t.y, x, y, res.dmg, {
            amass: attackerMass,
            vmass: massOf(t),
          }),
          swingInflict
        );
        if (res.crit && broadcastCb)
          broadcastCb({
            type: 'combat',
            evt: 'crit',
            x: t.x,
            y: t.y,
            byPlayer: playerId,
            targetPlayer: t.id,
          });
      }
    }
  }

  // --- Ranged-weapon projectiles -----------------------------------------
  // A ranged weapon (handleAttack with range > 0) launches a projectile that
  // marches forward a few px each tick. It damages the first target its small
  // hitbox overlaps — or EVERY new target, if the weapon pierces — through the
  // same resolveMelee / applyDamage path a melee swing uses, then is spent (or
  // flies on, piercing) until it hits a wall or reaches its max range.
  // Server-authoritative: clients only render the shot from the `projectile`
  // broadcast and clear it on `proj_end`. See src/engine/Projectiles.ts.
  const PROJ_HALF = 5; // shot hitbox half-size (px)
  const PROJ_DEFAULT_SPEED = 6; // px/tick when a weapon authors no projSpeed
  const PROJ_KNOCK_BEHIND = 20; // knockback source sits this far behind the shot
  const PROJ_MUZZLE_RISE = 10; // shot flies at chest height (feet - this); see the muzzle in handleAttack
  let projectiles = [];
  let projSeq = 0;

  // Same shape as handleAttack's inline combat events; factored out so the
  // projectile path and (future callers) emit hit/miss/crit identically.
  function emitCombat(evt, ex, ey, byPlayer, targetPlayer, dmg) {
    if (!broadcastCb) return;
    const m = {
      type: 'combat',
      evt,
      x: Math.round(ex),
      y: Math.round(ey),
      byPlayer,
      targetPlayer: targetPlayer == null ? null : targetPlayer,
    };
    if (dmg) m.dmg = dmg;
    broadcastCb(m);
  }

  function spawnProjectile(o) {
    const len = Math.hypot(o.vx, o.vy) || 1;
    const p = {
      id: ++projSeq,
      x: o.x,
      y: o.y,
      vx: o.vx / len, // unit direction
      vy: o.vy / len,
      speed: o.speed > 0 ? o.speed : PROJ_DEFAULT_SPEED,
      traveled: 0,
      maxDist: o.maxDist,
      base: o.base,
      critChance: o.critChance,
      attacker: o.attacker,
      attackerId: o.attackerId,
      attackerMass: o.attackerMass,
      inflict: o.inflict,
      pierce: !!o.pierce,
      hit: new Set(), // actors already damaged (piercing shots never double-hit)
      hitPlayers: new Set(),
    };
    projectiles.push(p);
    if (broadcastCb)
      broadcastCb({
        type: 'projectile',
        id: p.id,
        byPlayer: p.attackerId,
        x: Math.round(p.x),
        y: Math.round(p.y),
        vx: p.vx,
        vy: p.vy,
        speed: p.speed,
        dist: p.maxDist,
        sprite: o.sprite || null,
        pierce: p.pierce,
      });
    return p;
  }

  function endProjectile(p, hit) {
    if (broadcastCb)
      broadcastCb({
        type: 'proj_end',
        id: p.id,
        x: Math.round(p.x),
        y: Math.round(p.y),
        hit: !!hit,
      });
  }

  // Resolve overlaps at the shot's current position. Damages each NEW target
  // (tracked per-shot, so a piercing shot never hits the same body twice) using
  // the swing resolution. Returns true if a NON-piercing shot connected and
  // should now be consumed.
  function projectileHits(p, players, now) {
    const bx = p.x - PROJ_HALF;
    const by = p.y - PROJ_HALF;
    const bw = PROJ_HALF * 2;
    const bh = PROJ_HALF * 2;
    // Knock targets along the shot's travel direction: place the knockback source
    // just BEHIND the projectile (pushActor / knockbackPlayerSpot shove away from it).
    const kx = p.x - p.vx * PROJ_KNOCK_BEHIND;
    const ky = p.y - p.vy * PROJ_KNOCK_BEHIND;
    for (const n of enemies) {
      if (n.dead || p.hit.has(n)) continue;
      if (!canHurt(p.attacker, n)) continue;
      if (!aabb(bx, by, bw, bh, n.x - HURT_W / 2, n.y + HURT_OY, HURT_W, HURT_H)) continue;
      p.hit.add(n);
      const res = resolveMelee(p.critChance, n.dodge || 0, p.base, rng);
      if (res.miss) {
        emitCombat('miss', n.x, n.y, p.attackerId, null);
        if (!p.pierce) return true;
        continue;
      }
      applyDamage(n, res.dmg, now, p.attackerId, {
        x: kx,
        y: ky,
        amass: p.attackerMass,
        inflict: p.inflict,
      });
      emitCombat('hit', p.x, p.y, p.attackerId, null, res.dmg);
      if (res.crit) emitCombat('crit', n.x, n.y, p.attackerId, null);
      if (!p.pierce) return true;
    }
    // Vehicles (traffic cars + Entity Manager vehicles): no dodge, no status proc.
    for (const n of vehicles) {
      if (n.dead || n.hp <= 0 || p.hit.has(n)) continue;
      if (!canHurt(p.attacker, n)) continue;
      const [vbx, vby, vbw, vbh] = actorBox(n, n.x, n.y);
      if (!aabb(bx, by, bw, bh, vbx, vby, vbw, vbh)) continue;
      p.hit.add(n);
      const res = resolveMelee(p.critChance, 0, p.base, rng);
      if (res.miss) {
        emitCombat('miss', n.x, n.y, p.attackerId, null);
        if (!p.pierce) return true;
        continue;
      }
      applyDamage(n, res.dmg, now, p.attackerId, { x: kx, y: ky, inflict: [] });
      emitCombat('hit', p.x, p.y, p.attackerId, null, res.dmg);
      if (res.crit) emitCombat('crit', n.x, n.y, p.attackerId, null);
      if (!p.pierce) return true;
    }
    // PvP: a shot lands on other players the PK rules allow (host owns their HP).
    if (getPlayersCb && onPlayerHitCb) {
      for (const t of players) {
        if (t.id === p.attackerId || t.editor) continue;
        if (t.hp !== undefined && t.hp <= 0) continue;
        if (p.hitPlayers.has(t.id)) continue;
        if (!canHurt(p.attacker, { isEnemy: false, pk: t.pk })) continue;
        if (!aabb(bx, by, bw, bh, t.x - HURT_W / 2, t.y + HURT_OY, HURT_W, HURT_H)) continue;
        p.hitPlayers.add(t.id);
        const res = resolveMelee(p.critChance, t.dodge || 0, p.base, rng);
        if (res.miss) {
          emitCombat('miss', t.x, t.y, p.attackerId, t.id);
          if (!p.pierce) return true;
          continue;
        }
        onPlayerHitCb(
          t.id,
          res.dmg,
          p.attackerId,
          knockbackPlayerSpot(t.x, t.y, kx, ky, res.dmg, {
            amass: p.attackerMass,
            vmass: massOf(t),
          }),
          p.inflict
        );
        emitCombat('hit', p.x, p.y, p.attackerId, t.id, res.dmg);
        if (res.crit) emitCombat('crit', t.x, t.y, p.attackerId, t.id);
        if (!p.pierce) return true;
      }
    }
    return false;
  }

  // True if the shot at (x,y) is inside a solid collision tile. The shot flies at
  // chest height, but WALLS are solid on the ground plane — so we test the SAME
  // foot-line band a walking body collides against (blocked / COL_*), shifting the
  // sample down by the muzzle rise. A small box (PROJ_HALF wide, COL_H tall) means
  // even a one-minitile-thick wall stops the bullet. This is why a shot collides
  // with exactly the walls a player can't walk through. (wallBetween samples at
  // foot height too, but offset for actor-to-actor LoS — wrong for a chest-high shot.)
  function projBlocked(x, y) {
    const footY = y + PROJ_MUZZLE_RISE;
    return blocked(x - PROJ_HALF, footY - COL_H, PROJ_HALF * 2, COL_H);
  }

  // Advance every projectile one tick. Each marches forward in sub-steps no larger
  // than its hitbox, so a fast shot can't tunnel past a thin target or wall between
  // ticks; it ends on a wall, on its first hit (unless piercing), or at max range.
  function stepProjectiles(now) {
    if (!projectiles.length) return;
    const players = getPlayersCb ? getPlayersCb() : [];
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const steps = Math.max(1, Math.ceil(p.speed / PROJ_HALF));
      const sx = (p.vx * p.speed) / steps;
      const sy = (p.vy * p.speed) / steps;
      const stepLen = Math.hypot(sx, sy);
      let done = false;
      let connected = false;
      for (let s = 0; s < steps; s++) {
        const px0 = p.x;
        const py0 = p.y;
        p.x += sx;
        p.y += sy;
        p.traveled += stepLen;
        if (projBlocked(p.x, p.y)) {
          // Stop at the first solid collision tile; back out to the last clear spot
          // so the impact spark lands on the wall face, not buried inside it.
          p.x = px0;
          p.y = py0;
          done = true;
          break;
        }
        if (projectileHits(p, players, now)) {
          connected = true;
          done = true; // non-piercing shot spent on its first target
          break;
        }
        if (p.traveled >= p.maxDist) {
          done = true; // flew its full range without connecting
          break;
        }
      }
      if (done) {
        endProjectile(p, connected);
        projectiles.splice(i, 1);
      }
    }
  }

  let tickInterval = null;
  let sendInterval = null;

  return {
    /**
     * getPlayers: () => [{id, x, y, level, hp}, ...] for connected players
     * broadcast: (obj) => void — sends to every connected client
     * onEnemyHit: (playerId, damage, enemy) => void — an enemy landed a swing;
     *   the host applies the damage to that player (server-authoritative HP).
     * onEnemyKill: (playerId, xp, enemy, loot) => void — a player landed a
     *   killing blow; the host awards EXP and `loot` ({money, item} | null,
     *   already rolled against the ROM drop rate).
     */
    start(getPlayers, broadcast, onEnemyHit, onEnemyKill, onPlayerHit, onPickup, onPlayerShove) {
      onEnemyKillCb = onEnemyKill || null;
      onPlayerHitCb = onPlayerHit || null; // PvP: apply a landed swing to a player
      getPlayersCb = getPlayers || null; // PvP: who else is in the world
      onPickupCb = onPickup || null; // ground-drop claim: (playerId, drop) => bool
      onPlayerShoveCb = onPlayerShove || null; // vehicle nudge: push a player, NO damage
      broadcastCb = broadcast; // handleAttack uses this for crit/miss events
      tickInterval = setInterval(() => {
        const players = getPlayers();
        const now = Date.now();
        reviveStatics(now);
        reviveNpcs(now);
        reviveCars(now);
        if (players.length === 0) return;
        // Broad-phase grid for this tick: lets unstack/separation/targeting query
        // only local actors instead of scanning all ~1364 (the O(N^2) stall fix).
        rebuildActorGrid();
        updateSpawners(now, players);
        // Detect door warps: a player whose reported position jumped > WARP_DELTA
        // in one tick teleported (the client warps on a door and sends the new
        // coords). Recorded into recentWarps with an expiry; enemies chasing that
        // player follow it through for WARP_FOLLOW_MS, not just this one tick.
        // `playerMoved` also captures NORMAL walking (0 < step ≤ WARP_DELTA) so the
        // player↔player plow only shoves while the heavier player is actually
        // moving into someone — not as a static repulsion aura (see pushPlayers).
        const playerMoved = new Set();
        for (const p of players) {
          if (p.editor) continue; // parked editor avatar isn't warping; never chase it
          const prev = prevPlayerPos.get(p.id);
          const guarded = now < (respawnGuard.get(p.id) || 0); // mid respawn window
          const stepDist = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
          if (stepDist > PLAYER_MOVE_EPS && stepDist <= WARP_DELTA) playerMoved.add(p.id);
          if (!guarded && prev && stepDist > WARP_DELTA) {
            // A one-tick jump bigger than WARP_DELTA is EITHER a door warp OR a
            // teleport (event warp, editor reposition, scripted move). Enemies may
            // follow a player through a DOOR, NEVER through a teleport — otherwise a
            // chaser materializes (invisible) at the player's new spot and keeps
            // hitting them. So this is only a followable warp if a REAL door sits at
            // the pre-warp position (the trigger the player stepped onto). No door
            // there ⇒ a teleport: record nothing and DROP any stale follow, so the
            // chaser loses the target and regroups at home. This one check makes
            // "no enemy teleports unless through a door" hold for every teleport
            // source, present or future — not just the ones we remember to exempt.
            const door = resolveDoor(prev.x, prev.y);
            if (door) {
              recentWarps.set(p.id, {
                fromX: prev.x,
                fromY: prev.y,
                toX: p.x,
                toY: p.y,
                until: now + WARP_FOLLOW_MS,
                door,
              });
            } else {
              recentWarps.delete(p.id);
            }
          }
          // Always track position (even while guarded) so the moment the window
          // ends prev == current and no stale jump is mistaken for a warp.
          prevPlayerPos.set(p.id, { x: p.x, y: p.y });
        }
        for (const id of prevPlayerPos.keys()) {
          if (!players.some((p) => p.id === id)) {
            prevPlayerPos.delete(id);
            respawnGuard.delete(id);
          }
        }
        // Expire stale warps and drop any whose player left.
        for (const [id, w] of recentWarps) {
          if (now > w.until || !players.some((p) => p.id === id)) recentWarps.delete(id);
        }
        for (const n of actors) {
          if (n.dead) continue;
          // Drive transient poses (attack/hurt). Runs regardless of proximity so
          // a pose never sticks if the player leaves. While it plays, step the
          // two generated frames — f0 (wind-up/recoil) for the first half, f1
          // (swing/settle) for the second — then clear back to walk.
          if (n.pose && n.pose !== 'walk') {
            if (now >= n.poseUntil) {
              n.pose = 'walk';
              n.frame = 0;
              n.dirty = true;
            } else {
              const f = now < n.poseStart + (n.poseUntil - n.poseStart) / 2 ? 0 : 1;
              if (f !== n.frame) {
                n.frame = f;
                n.dirty = true;
              }
            }
          }
          let near = false;
          for (const p of players) {
            if (Math.abs(p.x - n.x) < ACTIVE_RADIUS && Math.abs(p.y - n.y) < ACTIVE_RADIUS) {
              near = true;
              break;
            }
          }
          // Tick status conditions: expire ended ones, apply any DoT (no attacker
          // context — DoT never re-knocks or re-paralyzes). No actor inflicts DoT
          // yet, so this is dormant until poison-on-enemies lands.
          const st = status.tickStatuses(n, now);
          for (const d of st.dot) {
            applyDamage(n, Math.max(1, Math.floor(n.maxHp * d.pct)), now, null);
            if (n.dead) break;
          }
          if (st.changed) n.statusDirty = true; // a status expired — refresh client pips
          if (n.dead) continue;
          // Action-blocked (paralysis/diamond/sleep): frozen — skip all AI (no
          // move, no swing). The flinch pose (held to the status' end by
          // tryParalyze) keeps showing above.
          if (status.isActionBlocked(n, now)) continue;
          // Scrambled (feeling strange / possessed): no aggro — the actor just
          // shuffles randomly until it wears off (cars don't get statuses).
          if (status.isScrambled(n, now) && n.kind !== 'car') {
            jitter(n, players, NPC_COMBAT_LEASH, now);
            continue;
          }
          if (near) {
            if (n.kind === 'car') tickCar(n, players, now);
            else if (n.roam) tickEnemy(n, players, now, onEnemyHit, recentWarps);
            else tickNpc(n, players, now);
            // Never let two bodies stay stacked: nudge apart if this tick ended
            // overlapping another actor. Enemies + townsfolk only — cars are meant
            // to plow THROUGH actors, not separate from them.
            if (n.kind === 'enemy' || n.kind === 'person') {
              unstack(n);
              pushFromPlayers(n, players); // a heavier player plows this actor aside
            }
          } else if (n.roam && n.mode !== 'patrol') {
            // Off-station with no player nearby (the target fled far): keep
            // ticking so it finishes heading back to spawn instead of freezing
            // out of position.
            tickEnemy(n, players, now, onEnemyHit, recentWarps);
          }
        }
        // Lag-comp: snapshot each enemy's post-move position so a player's swing
        // can be resolved against where the attacker saw it (histPosAt).
        for (const e of enemies) if (!e.dead) recordHist(e, now);
        // Player↔player walk-push: heavier players shove lighter ones off the spot
        // they're standing on (e.g. clearing a blocked doorway). Runs once per tick
        // after actor movement, using this tick's movement set.
        pushPlayers(players, playerMoved);
        // Fly + resolve ranged-weapon shots after actors have moved this tick, so
        // a projectile collides against fresh enemy/player positions.
        stepProjectiles(now);
        // Ground-drop pickup: first player within reach claims each drop. The
        // host owns inventory/cash and decides if it can be taken (bag room);
        // accepted -> remove + broadcast, refused (bag full) -> leave it.
        if (groundDrops.length && onPickupCb) {
          for (let i = groundDrops.length - 1; i >= 0; i--) {
            const d = groundDrops[i];
            if (d.pickableAt && now < d.pickableAt) continue; // still mid-flight
            const p = players.find(
              (q) =>
                !q.editor &&
                !(q.hp !== undefined && q.hp <= 0) &&
                Math.abs(q.x - d.x) <= DROP_PICKUP_RADIUS &&
                Math.abs(q.y - d.y) <= DROP_PICKUP_RADIUS
            );
            if (p && onPickupCb(p.id, dropWire(d))) {
              groundDrops.splice(i, 1);
              broadcast({ type: 'drop_remove', id: d.id });
            }
          }
        }
        // Then enemies/townsfolk grab what players left behind (carry-capped).
        pickupByActors(now);
      }, 1000 / TICK_HZ);

      sendInterval = setInterval(() => {
        const moved = [];
        const hps = [];
        const stat = []; // [id, [statusId,...]] rows for actors whose set changed
        const equips = []; // [id, itemId|null] rows for actors whose held item changed
        const nowSend = Date.now();
        for (const n of actors) {
          if (n.dirty && !n.dead) {
            n.dirty = false;
            moved.push([
              n.id,
              Math.round(n.x * 2) / 2,
              Math.round(n.y * 2) / 2,
              n.dir,
              n.frame,
              poseCode(n),
            ]);
          }
          if (n.hpDirty) {
            n.hpDirty = false;
            hps.push([n.id, n.hp, n.maxHp]);
          }
          if (n.statusDirty) {
            n.statusDirty = false;
            stat.push([n.id, status.activeStatuses(n, nowSend)]);
          }
          // Held-item change (a townsperson equipped/dropped a looted weapon).
          // Sent even for a dead actor so a respawn renders unarmed (itemId null).
          if (n.equipDirty) {
            n.equipDirty = false;
            equips.push([n.id, n.itemId ?? null]);
          }
        }
        if (moved.length > 0) broadcast({ type: 'npc_update', npcs: moved });
        if (hps.length > 0) broadcast({ type: 'npc_hp', hps });
        if (stat.length > 0) broadcast({ type: 'npc_status', statuses: stat });
        if (equips.length > 0) broadcast({ type: 'npc_equip', equips });
      }, 1000 / BROADCAST_HZ);
    },

    /** Divergent-from-spawn positions of LIVE actors, for newly joining clients. */
    snapshot() {
      const out = [];
      for (const n of actors) {
        if (n.dead) continue;
        const hurt = n.pose === 'hurt';
        if (n.x !== n.homeX || n.y !== n.homeY || n.dir !== n.homeDir || n.frame !== 0 || hurt) {
          out.push([
            n.id,
            Math.round(n.x * 2) / 2,
            Math.round(n.y * 2) / 2,
            n.dir,
            n.frame,
            poseCode(n),
          ]);
        }
      }
      return out;
    },

    /**
     * HP rows for new clients: every enemy (incl. hp 0 = dead/hidden), plus any
     * townsperson OR traffic car that's currently damaged or downed (hp < maxHp)
     * so a late joiner sees their health bar / hidden-while-dead state. Full-HP
     * townsfolk/cars are omitted — the client defaults them to full anyway.
     */
    hpSnapshot() {
      const out = enemies.map((n) => [n.id, n.hp, n.maxHp]);
      for (const n of actors) {
        if ((n.kind === 'person' || n.kind === 'car') && n.hp < n.maxHp)
          out.push([n.id, n.hp, n.maxHp]);
      }
      return out;
    },

    /** Held-item rows for new clients: every LIVE actor currently holding a
     *  weapon ([id, itemId]). Mirrors hpSnapshot — only the non-default state. */
    equipSnapshot() {
      const out = [];
      for (const n of actors) if (!n.dead && n.itemId) out.push([n.id, n.itemId]);
      return out;
    },

    /**
     * AOI join snapshot (NETWORK_REMODEL.md §4): the same divergent-state bundle
     * as snapshot()/hpSnapshot()/equipSnapshot()/dropsSnapshot(), but restricted
     * to actors/drops the joiner can see — `inRange(x, y) => boolean`. One pass
     * over `actors` keeps the four row-sets consistent (same in-range set). Far
     * idle-divergent NPCs are omitted; they self-correct via npc_update once the
     * player nears them (the sim ticks them inside ACTIVE_RADIUS, < one AOI block).
     */
    aoiSnapshot(inRange) {
      const npcs = [];
      const npcHps = [];
      const npcEquips = [];
      for (const n of actors) {
        if (!inRange(n.x, n.y)) continue;
        if (!n.dead) {
          const hurt = n.pose === 'hurt';
          if (n.x !== n.homeX || n.y !== n.homeY || n.dir !== n.homeDir || n.frame !== 0 || hurt) {
            npcs.push([
              n.id,
              Math.round(n.x * 2) / 2,
              Math.round(n.y * 2) / 2,
              n.dir,
              n.frame,
              poseCode(n),
            ]);
          }
          if (n.itemId) npcEquips.push([n.id, n.itemId]);
        }
        // HP mirrors hpSnapshot: every enemy (incl. dead → hp 0), plus damaged
        // townsfolk/cars. Dead enemies still report so the client renders death.
        if (n.isEnemy) npcHps.push([n.id, n.hp, n.maxHp]);
        else if ((n.kind === 'person' || n.kind === 'car') && n.hp < n.maxHp)
          npcHps.push([n.id, n.hp, n.maxHp]);
      }
      const drops = groundDrops.filter((d) => inRange(d.x, d.y)).map(dropWire);
      return { npcs, npcHps, npcEquips, drops };
    },

    /**
     * Live enemy snapshot WITH positions: [{id, x, y, hp, maxHp, dead}, ...].
     * Unlike snapshot() (moved actors only) this returns every enemy's current
     * spot, so tests/debug tools can aim at one. Read-only — a copy per row.
     */
    enemyState() {
      return enemies.map((n) => ({
        id: n.id,
        x: n.x,
        y: n.y,
        hp: n.hp,
        maxHp: n.maxHp,
        dead: !!n.dead,
        statuses: { ...n.statuses }, // active status set (for inflict-model tests/debug)
        carried: n.carried.map((c) => ({ ...c })), // items this actor is hauling
      }));
    },

    /**
     * Anchor positions of every LIVE static interactable (person/prop) — shop
     * clerks, ATMs, phones, etc. — for server-side proximity gating. The host
     * checks a transacting player against these so buy/sell/ATM can't be invoked
     * from across the map (see GameHost _nearShop/_nearAtm). Uses live x/y (a
     * clerk that wandered is checked where it actually is). Iterates the FULL npc
     * list, not `actors` (which excludes props — ATMs are often props).
     */
    interactableAnchors() {
      const out = [];
      for (const n of npcs) {
        if (!n || n.dead) continue;
        if (n.kind !== 'person' && n.kind !== 'prop') continue;
        out.push({ sprite: n.sprite, npcId: n.npcConfigId ?? -1, x: n.x, y: n.y });
      }
      return out;
    },

    /** Authoritative player collision (walls + weight-class solid actors) for the
     *  server-side movement sim — see playerBlocked. (px,py) = foot-box top-left. */
    playerBlocked(px, py, level, curX, curY) {
      return playerBlocked(px, py, level, curX, curY);
    },

    /** The door trigger at (x,y) — `{x,y,destX,destY}` or null. Server-authoritative
     *  door validation: a warp is only honored if the player is actually standing on
     *  a real door, and the destination is the door's OWN dest (not client-chosen).
     *  Same triggers the chase AI uses (resolveDoor). */
    doorAt(x, y) {
      return resolveDoor(x, y);
    },

    /** Resolve a door-EXIT landing for a player so a warp never stacks two bodies
     *  on the doorway. Returns the destination if its foot box is clear of walls,
     *  NPCs and OTHER players; otherwise the nearest free tile (spiral out to
     *  ~96px). Shares the foot box + free-spot search with NPC door-follow
     *  placement (findFreeNear; COL_* === the player's PLAYER_COL_*), so people and
     *  enemies land by the same rule. The per-tick `unstack` is the backstop if
     *  even the spiral finds no room. `players` is the live player list; `selfId`
     *  is the warping player, excluded so it never blocks itself. */
    findPlayerLanding(destX, destY, players, selfId) {
      const self = { id: selfId }; // not in `actors` → hitsActor scans every NPC
      const others = Array.isArray(players) ? players.filter((p) => p && p.id !== selfId) : [];
      return (
        findFreeNear(destX, destY, self, others) || { x: Math.round(destX), y: Math.round(destY) }
      );
    },

    /** True if (x,y) sits on an escalator/stairway trigger. The escalator ride
     *  (gliding the player diagonally across the solid steps) is client-driven,
     *  so we can't recompute the landing here — but we CAN confirm the player is
     *  really on an escalator before honoring their ride warp, which gates
     *  `ride_warp` to "actually on a stair" (anti-cheat). Lenient radius: the
     *  authoritative position lags the visual a few px by ride start. */
    stairAt(x, y) {
      const R = 16;
      for (const s of stairTriggers) {
        if (Math.abs(s.x - x) <= R && Math.abs(s.y - y) <= R) return true;
      }
      return false;
    },

    /** Every live ground drop (wire shape), for a newly joining client. */
    dropsSnapshot() {
      return groundDrops.map(dropWire);
    },

    /** Spawn a money ground drop (Phase F: player death drops on-hand cash). */
    spawnMoneyDrop(x, y, amount) {
      if ((amount | 0) <= 0) return null;
      return spawnDrop('money', x, y, { amount: amount | 0 });
    },

    /** Player death: scatter `total` cash as a fountain of "cash object" drops
     *  (the `sprite` item art, e.g. c001). Object count = min(maxObjects, total) so
     *  each is worth ≥ $1; `total` is split as evenly as possible (the remainder
     *  spread one-per-object) so the values sum to EXACTLY `total` — no cash
     *  created or lost. Each object ejects up from (x,y) and lands a short random
     *  hop away (the existing eject arc), so they pop out and scatter. */
    spawnCashFountain(x, y, total, sprite, maxObjects = 20) {
      total = total | 0;
      if (total <= 0) return [];
      const cap = maxObjects | 0 || 1;
      const n = Math.max(1, Math.min(cap, total));
      const base = Math.floor(total / n);
      const rem = total - base * n; // first `rem` objects carry one extra dollar
      const out = [];
      for (let i = 0; i < n; i++) {
        const amount = base + (i < rem ? 1 : 0);
        const land = ejectLanding(x, y); // random non-solid spot a short hop away
        out.push(spawnDrop('money', land.x, land.y, { amount, sprite }, { x, y }));
      }
      return out;
    },

    /** Spawn an item ground drop (no eject → immediately claimable). For tests. */
    spawnItemDrop(x, y, item, name) {
      if (!item) return null;
      return spawnDrop('item', x, y, { item, name: name || '' });
    },

    /** Run one actor-pickup pass (enemies/townsfolk grab nearby drops). For tests. */
    pickupByActors,

    /**
     * Test/debug hooks for the NPC item-use mechanic. Return LIVE townsperson
     * actors (so a test can seed `carried` and read the result), plus drivers to
     * run one use pass or apply raw damage without standing up the full tick.
     */
    _test: {
      townsfolk: () => actors.filter((n) => n.kind === 'person'),
      useCarried: (n) => npcUseCarried(n),
      damage: (n, dmg, now) => applyDamage(n, dmg, now == null ? Date.now() : now, null),
    },

    /** Resolve a player's melee swing (server-authoritative). */
    handleAttack,

    // Lag-comp internals, exposed for unit tests (combat.test.js). recordHist
    // appends a [t,x,y] sample; histPosAt rewinds an enemy to a past instant.
    _lagComp: { recordHist, histPosAt },

    // Offense PSI never reaches into another room: like melee/enemy sensing, a
    // candidate is skipped if a wall (wallBetween) OR a door seam (doorBetween)
    // sits between the caster and it — the door check catches room boundaries
    // whose gap has no solid wall, which the client's room crop hides anyway.
    /**
     * Offense PSI strike: damage the nearest LIVE enemy within `range` px of
     * (x,y) that's in the SAME room (no wall or door seam between), crediting
     * `killerPlayerId` for XP/loot on a kill. Knockback flings it away from the
     * caster. Returns the struck enemy's {x,y} (for the projectile target), or
     * null if none.
     */
    psiStrike(x, y, range, dmg, killerPlayerId, inflict) {
      let best = null;
      let bestD = range;
      for (const n of enemies) {
        if (n.dead) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d <= bestD && !wallBetween(x, y, n.x, n.y) && !doorBetween(x, y, n.x, n.y)) {
          bestD = d;
          best = n;
        }
      }
      if (!best) return null;
      // Damage (may be 0 for a pure-ailment PSI) + the PSI's status inflict, each
      // element-scaled by the enemy's ROM resist inside applyDamage's atk path.
      applyDamage(best, dmg || 0, Date.now(), killerPlayerId, { x, y, inflict: inflict || [] });
      return { x: Math.round(best.x), y: Math.round(best.y) };
    },

    /**
     * Multi-target offense PSI (ROM target "row"/"all", e.g. PSI Fire, Thunder,
     * Flash, Starstorm, Rockin): the bolt PENETRATES and hits EVERY live enemy
     * within `range` px of (x,y) in the SAME room — not just the nearest (a wall
     * or door seam between caster and enemy spares it, so casts never cross into
     * the next room). Each takes the full damage + the PSI's status inflict, scaled by
     * its own ROM resist. Returns the NEAREST struck enemy's {x,y} for the
     * projectile animation target, or null if nothing was hit.
     */
    psiStrikeAll(x, y, range, dmg, killerPlayerId, inflict) {
      const now = Date.now();
      let near = null;
      let nearD = Infinity;
      for (const n of enemies) {
        if (n.dead) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d <= range && !wallBetween(x, y, n.x, n.y) && !doorBetween(x, y, n.x, n.y)) {
          applyDamage(n, dmg || 0, now, killerPlayerId, { x, y, inflict: inflict || [] });
          if (d < nearD) {
            nearD = d;
            near = n;
          }
        }
      }
      return near ? { x: Math.round(near.x), y: Math.round(near.y) } : null;
    },

    /**
     * Cone/shotgun offense PSI (e.g. PSI Fire): spray from (x,y) in unit-ish
     * direction (ux,uy) — PSI_DIR diagonals are ~0.7 so we normalize. The cone is
     * narrow at the muzzle (`halfWidth`) and FANS OUT with distance (`spread` px
     * of half-width gained per px forward), so the allowed side-offset at a given
     * `along` is `halfWidth + spread*along`. Every live enemy inside that cone,
     * within `length` forward and in the SAME room (no wall/door seam between),
     * takes the full damage + status inflict (element-scaled by its resist).
     * Returns the array of struck {x,y} (empty if it hit nothing).
     */
    psiStrikeLine(x, y, ux, uy, length, halfWidth, spread, dmg, killerPlayerId, inflict) {
      const mag = Math.hypot(ux, uy) || 1;
      const fx = ux / mag;
      const fy = uy / mag; // forward unit
      const now = Date.now();
      const struck = [];
      for (const n of enemies) {
        if (n.dead) continue;
        const ex = n.x - x;
        const ey = n.y - y;
        const along = ex * fx + ey * fy; // distance forward along the beam
        if (along < 0 || along > length) continue;
        const perp = Math.abs(ex * -fy + ey * fx); // perpendicular offset
        if (perp > halfWidth + (spread || 0) * along) continue; // cone widens forward
        if (wallBetween(x, y, n.x, n.y) || doorBetween(x, y, n.x, n.y)) continue;
        applyDamage(n, dmg || 0, now, killerPlayerId, { x, y, inflict: inflict || [] });
        struck.push({ x: Math.round(n.x), y: Math.round(n.y) });
      }
      return struck;
    },

    /**
     * Random-strike offense PSI (e.g. PSI Thunder): from the live enemies within
     * `range` px of (x,y) in the SAME room (no wall/door seam between), pick up to `count` AT RANDOM
     * and strike each for the full damage + status inflict. Stronger tiers pass a
     * higher `count` (more bolts). Returns the array of struck {x,y} (empty if no
     * enemy is in range) so the caller can drop a bolt FX on each.
     */
    psiStrikeBolts(x, y, range, count, dmg, killerPlayerId, inflict) {
      const now = Date.now();
      const cands = [];
      for (const n of enemies) {
        if (n.dead) continue;
        if (Math.hypot(n.x - x, n.y - y) > range) continue;
        if (wallBetween(x, y, n.x, n.y) || doorBetween(x, y, n.x, n.y)) continue;
        cands.push(n);
      }
      // Fisher–Yates shuffle, then take the first `count` (Math.random is fine —
      // this is the live game host, not a deterministic workflow script).
      for (let i = cands.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = cands[i];
        cands[i] = cands[j];
        cands[j] = t;
      }
      const struck = [];
      for (const n of cands.slice(0, Math.max(0, count))) {
        applyDamage(n, dmg || 0, now, killerPlayerId, { x, y, inflict: inflict || [] });
        struck.push({ x: Math.round(n.x), y: Math.round(n.y) });
      }
      return struck;
    },

    /** World pixel bounds {w, h} — the host clamps player positions to these. */
    bounds() {
      return { w: MAP_W_TILES * TILE, h: mapHTiles * TILE };
    },

    /**
     * True if a solid wall sits on the line between two actor foot positions —
     * the line-of-sight gate every melee swing uses (no reaching through walls).
     * Exposed for combat tests and any future host-side LoS check.
     */
    wallBetween,

    /**
     * Advance + resolve in-flight ranged-weapon projectiles one tick. The live
     * tick loop calls this every frame; exposed so combat tests can drive a shot
     * forward deterministically (handleAttack only LAUNCHES the projectile).
     */
    stepProjectiles,

    /**
     * Tell the sim a player just respawn-teleported to the spawn point. Pauses
     * door-warp detection for that player for RESPAWN_GUARD_MS, so a chasing
     * enemy won't follow the (revived, full-HP) player back to spawn — death
     * looks identical to a door warp otherwise (full HP + a big position jump).
     * A window, not a one-shot: the dying client keeps reporting its pre-death
     * position for a beat, so the real jump to spawn can land a few ticks late.
     * Also drops any warp already queued for this player (e.g. a real door warp
     * the instant before death) so it can't be followed to the spawn point.
     */
    noteRespawn(id) {
      respawnGuard.set(id, Date.now() + RESPAWN_GUARD_MS);
      recentWarps.delete(id);
    },

    /**
     * Tell the sim a player just LEFT the dev editor. While editing, the avatar
     * is parked server-side at its pre-editor spot (the client stops sending
     * moves) while the admin may have teleported it far away. On exit the client
     * resumes and reports the new coords — a big one-tick jump that looks exactly
     * like a door warp. Same guard as a respawn: pause warp detection briefly and
     * drop any queued warp so chasers don't follow the editor teleport.
     */
    noteEditorExit(id) {
      respawnGuard.set(id, Date.now() + RESPAWN_GUARD_MS);
      recentWarps.delete(id);
    },

    /**
     * Tell the sim a player was TELEPORTED by a script/event (e.g. warped into an
     * event room or out to its exit point). A scripted teleport is not a door, so
     * chasers must NOT follow it: pause warp detection briefly and drop any queued
     * warp. The door-only follow check already refuses door-less jumps; this is
     * the explicit belt-and-suspenders for the case where the teleport ORIGIN
     * happens to sit on a door trigger (which would otherwise read as a warp).
     */
    noteTeleport(id) {
      respawnGuard.set(id, Date.now() + RESPAWN_GUARD_MS);
      recentWarps.delete(id);
    },

    stop() {
      if (tickInterval) clearInterval(tickInterval);
      if (sendInterval) clearInterval(sendInterval);
      fs.unwatchFile(path.join(assetsDir, NPCS_FILE), reloadPlacements);
      fs.unwatchFile(OVERRIDES_PATH, reloadPlacements);
      fs.unwatchFile(ENEMY_OV_PATH, reloadEnemies);
      fs.unwatchFile(ENTITIES_OV_PATH, reloadEntities);
      fs.unwatchFile(CAR_OV_PATH, reloadTraffic);
      fs.unwatchFile(ROOMS_OV_PATH, reloadRooms);
      fs.unwatchFile(COLLISION_OV_PATH, loadCollisionWithOverrides);
      fs.unwatchFile(path.join(assetsDir, DOORS_FILE), loadDoorTriggers);
      fs.unwatchFile(DOORS_OV_PATH, loadDoorTriggers);
    },
  };
}

module.exports = { createNpcSim, resolveMelee };
