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
const BROADCAST_HZ = 10;
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
const ATTACK_REACH = 14; // px the hitbox sits in front of the attacker's feet
const ATTACK_HALF = 8; // half-size of the (square) attack hitbox
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
const KB_MIN = 5; // px — even a light hit nudges
const KB_MAX = 44; // px — cap so a big/crit hit can't fling across the room
const KB_PER_DMG = 1.6; // px of knockback per point of damage dealt
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

// Knockback distance for a hit that dealt `dmg` damage (clamped to [MIN,MAX]).
function knockDist(dmg) {
  return Math.max(KB_MIN, Math.min(KB_MAX, KB_MIN + dmg * KB_PER_DMG));
}

// --- Enemy aggression (Heavy) ---
// Enemies have a level (set from the spawner / a default) and so do players, so
// a future EarthBound-style "flee if you out-level it" rule can hook in here.
// For now level is just tracked; aggro is unconditional: any enemy chases and
// hits the nearest living player it can see.
const DEFAULT_ENEMY_LEVEL = 4;
const DETECT_RANGE = 220; // px — default aggro radius; per-entity `detectRange` (Entity Manager) overrides it
// Once an enemy has LOCKED ON it does not give up at the detect radius — it
// pursues relentlessly (no home-distance leash) until the target gets this far
// away (or the enemy dies), then it turns back and paths home. Hysteresis:
// acquire at detectRange, drop only past this larger give-up distance. Per-entity
// `giveUpRange` (Entity Manager) overrides it; never smaller than detectRange.
const GIVE_UP_RANGE = 560; // px — chase breaks off when the target exceeds this
const ATTACK_RANGE = 24; // px — enemy must be this close to land a hit
const ENEMY_CHASE_SPEED = 1.6; // px/frame while pursuing (player is 2.0) — fast enough to be a real threat, slow enough to outrun
const ENEMY_ATTACK_COOLDOWN_MS = 700; // min time between one enemy's swings
const ENEMY_ATTACK_POSE_MS = 250; // how long the swing pose shows
const ENEMY_DAMAGE = 7; // HP per landed hit
const DEFAULT_ENEMY_XP = 5; // EXP a kill grants the killer (spawners override)

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
// KEEP IN SYNC with src/engine/EntityStats.ts CombatPersonality.
const COMBAT_PERSONALITIES = ['brave', 'skirmisher', 'coward', 'nervous'];
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
const VEHICLE_SPEED = 1.5; // px/tick cruising (townsfolk wander 0.5; enemy chase 1.6)
const VEHICLE_DAMAGE = 14; // HP per collide (heavy — the whole point of a car)
const VEHICLE_DETECT = 280; // px — spots and bears down on foes from far off
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
const ENEMY_SPEED = 0.7; // roamers move a touch faster than ambling townsfolk
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

  const sectors = readJSON('map/sectors.json');
  const tiles = readJSON('map/tiles.json');
  const tilesetMapping = readJSON('map/tileset_mapping.json');
  // Map height is data-driven (the map grows with the stamped interiors band;
  // see ARCHITECTURE.md). Width is fixed at 256, so the row count is the height.
  const mapHTiles = Math.round(tiles.length / MAP_W_TILES);
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
        const cols = collisionByDrawTs.get(tilesetMapping[sector.tilesetId] ?? 0);
        if (!cols) return true;
        const arr = tiles[ty * MAP_W_TILES + tx] ?? 0;
        const idx = (my % 4) * 4 + (mx % 4);
        let byte = arr < cols.length ? cols[arr][idx] : 0;
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
    raw.forEach((area, idx) => {
      const originX = (idx % DOOR_GRID_COLS) * DOOR_AREA_PX;
      const originY = Math.floor(idx / DOOR_GRID_COLS) * DOOR_AREA_PX;
      for (const d of area) {
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
        out.push({ x: wx, y: wy + DOOR_FOOT_OFFSET });
      }
    });
    for (const a of additions) out.push({ x: a.worldX, y: a.worldY + DOOR_FOOT_OFFSET });
    doorTriggers = out;
    console.log(`[npcSim] loaded ${out.length} door triggers`);
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

  // Effective per-entity stats = catalog (ROM defaults) overlaid by authored
  // entities. Rebuilt whenever enemy_spawns.json changes (reloadEnemies).
  function buildEntityDefs(cfg) {
    const cat = (enemyCatalog && enemyCatalog.bySprite) || {};
    const file = (cfg && cfg.entities) || {};
    const out = {};
    for (const k of new Set([...Object.keys(cat), ...Object.keys(file)])) {
      out[k] = Object.assign({}, cat[k], file[k]);
    }
    return out;
  }

  // `let` so the file watch can swap them in live.
  let enemyCfg = loadEnemyCfg();
  let entityDefs = buildEntityDefs(enemyCfg);
  // Sprites auto-classified as enemies regardless of placement kind (backward
  // compat with placements authored before 'enemy' was a first-class kind).
  // NOTE: intentionally NOT every catalog sprite — only the authored list — so
  // adding 77 ROM enemies to the catalog doesn't silently turn existing NPC
  // placements hostile. New enemies are placed via kind:'enemy' (PlacementTool).
  let ENEMY_SPRITES = new Set((enemyCfg && enemyCfg.enemySpriteGroups) || []);
  let SPAWNERS = ((enemyCfg && enemyCfg.spawners) || []).filter((s) => s.enabled !== false);
  let STATIC_ENEMY_HP = (SPAWNERS[0] && SPAWNERS[0].hp) || 24;

  // True if a placement is an enemy: explicit kind, or a legacy enemy sprite.
  function isEnemyPlacement(r) {
    return r.kind === 'enemy' || ENEMY_SPRITES.has(r.sprite);
  }
  // One effective per-entity stat (merged catalog+authored), or `def`.
  function entityStat(sprite, key, def) {
    const e = entityDefs[String(sprite)];
    return e && e[key] != null ? e[key] : def;
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
    return ((cfg && cfg.vehicles) || []).filter(
      (v) => v.enabled !== false && Array.isArray(v.waypoints) && v.waypoints.length >= 2
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
        ? { id: d.id, kind: 'money', x: d.x, y: d.y, amount: d.amount | 0 }
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
    const merged = base.map((e) => {
      const o = e.k !== undefined && ov && ov.edits ? ov.edits[e.k] : undefined;
      if (o === null) return null;
      if (o) return Object.assign({}, o, { k: e.k });
      return e;
    });
    for (const a of (ov && ov.additions) || []) merged.push(Object.assign({}, a));
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
        isVehicle: false, // vehicle behaviour (tickVehicle): hunt + plow. Set in build*.
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
        attackRange: ATTACK_RANGE, // px the enemy must be within to land a hit
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
      // A vehicle (Entity Manager flag) is a friendly NPC with its own behaviour.
      // It's NOT an enemy; it rides on the 'person' kind so it has HP, a health
      // bar, and lives in the actor list — see tickVehicle.
      const vehicle = !enemy && !!entityStat(r.sprite, 'vehicle', false);
      const person = !enemy && (r.kind === 'person' || vehicle); // props/deleted carry no HP
      // Enemy stats come from the merged per-entity table (ROM catalog overlaid
      // by authored entities), keyed by sprite — same source the spawner pool
      // uses, so a placed enemy and a spawned one of the same sprite match.
      const hp = enemy
        ? entityStat(r.sprite, 'hp', STATIC_ENEMY_HP)
        : vehicle
          ? entityStat(r.sprite, 'hp', VEHICLE_HP)
          : person
            ? NPC_HP
            : 0;
      const speed = enemy
        ? entityStat(r.sprite, 'speed', ENEMY_SPEED)
        : vehicle
          ? entityStat(r.sprite, 'speed', VEHICLE_SPEED)
          : ENEMY_SPEED;
      return baseActor({
        id,
        kind: enemy ? 'enemy' : vehicle ? 'person' : r.kind,
        sprite: r.sprite,
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
        isVehicle: vehicle,
        hp,
        maxHp: hp,
        level: enemy ? entityStat(r.sprite, 'level', DEFAULT_ENEMY_LEVEL) : 1,
        xp: enemy ? entityStat(r.sprite, 'xp', DEFAULT_ENEMY_XP) : 0,
        damage: enemy
          ? entityStat(r.sprite, 'damage', ENEMY_DAMAGE)
          : vehicle
            ? entityStat(r.sprite, 'damage', VEHICLE_DAMAGE)
            : ENEMY_DAMAGE,
        attackCooldown: enemy
          ? entityStat(r.sprite, 'attackCooldownMs', ENEMY_ATTACK_COOLDOWN_MS)
          : ENEMY_ATTACK_COOLDOWN_MS,
        speed,
        chaseSpeed: speed * CHASE_RATIO,
        detectRange: enemy
          ? entityStat(r.sprite, 'detectRange', DETECT_RANGE)
          : vehicle
            ? entityStat(r.sprite, 'detectRange', VEHICLE_DETECT)
            : DETECT_RANGE,
        attackRange: enemy ? entityStat(r.sprite, 'attackRange', ATTACK_RANGE) : ATTACK_RANGE,
      });
    });
  }

  // Fixed enemy pool from the spawners, appended AFTER the ROM placements so
  // wire ids (array indexes) align with the client, which builds the same pool
  // from the same file. Slots start dead (hp 0 = hidden) until activated.
  // Combat stats now live PER ENTITY (sprite group) in enemyCfg.entities, set by
  // the Entity Manager; spawners inherit them. Fall back to any legacy
  // per-spawner field (old files), then the global default.
  function spawnerStat(sp, key, def) {
    const e = entityDefs[String(sp.sprite)] || {};
    if (e[key] != null) return e[key];
    if (sp[key] != null) return sp[key]; // legacy per-spawner field (old files)
    return def;
  }

  function buildPool(startId) {
    const out = [];
    let id = startId;
    for (const sp of SPAWNERS) {
      const speed = spawnerStat(sp, 'speed', ENEMY_SPEED);
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
            indoor: false,
            isEnemy: true,
            pk: true, // pooled enemies are PK
            roam: true,
            maxHp: spawnerStat(sp, 'hp', 24),
            level: spawnerStat(sp, 'level', DEFAULT_ENEMY_LEVEL),
            xp: spawnerStat(sp, 'xp', DEFAULT_ENEMY_XP),
            damage: spawnerStat(sp, 'damage', ENEMY_DAMAGE),
            attackCooldown: spawnerStat(sp, 'attackCooldownMs', ENEMY_ATTACK_COOLDOWN_MS),
            speed,
            chaseSpeed: speed * CHASE_RATIO,
            detectRange: spawnerStat(sp, 'detectRange', DETECT_RANGE),
            attackRange: spawnerStat(sp, 'attackRange', ATTACK_RANGE),
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
  // waypoint and drives the route from there; w/h are the collision box.
  function buildCarPool(startId) {
    const out = [];
    let id = startId;
    for (const v of activeVehicles(carCfg)) {
      const [sx, sy] = v.waypoints[0];
      out.push(
        baseActor({
          id: id++,
          kind: 'car',
          sprite: v.sprite,
          x: sx,
          y: sy,
          homeX: sx,
          homeY: sy,
          dir: 0,
          homeDir: 0,
          indoor: false,
          waypoints: v.waypoints,
          wpIndex: 1, // heading toward the second waypoint
          step: 1, // ping-pong direction for non-looping routes
          loop: v.loop !== false,
          speed: v.speed || 1,
          carW: v.w || 40,
          carH: v.h || 28,
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
        const person = !enemy && r.kind === 'person';
        const hp = enemy ? entityStat(r.sprite, 'hp', STATIC_ENEMY_HP) : person ? NPC_HP : 0;
        const speed = enemy ? entityStat(r.sprite, 'speed', ENEMY_SPEED) : ENEMY_SPEED;
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
        n.maxHp = hp;
        n.hp = hp;
        n.level = enemy ? entityStat(r.sprite, 'level', DEFAULT_ENEMY_LEVEL) : 1;
        n.xp = enemy ? entityStat(r.sprite, 'xp', DEFAULT_ENEMY_XP) : 0;
        n.damage = enemy ? entityStat(r.sprite, 'damage', ENEMY_DAMAGE) : ENEMY_DAMAGE;
        n.attackCooldown = enemy
          ? entityStat(r.sprite, 'attackCooldownMs', ENEMY_ATTACK_COOLDOWN_MS)
          : ENEMY_ATTACK_COOLDOWN_MS;
        n.speed = speed;
        n.chaseSpeed = speed * CHASE_RATIO;
        n.detectRange = enemy ? entityStat(r.sprite, 'detectRange', DETECT_RANGE) : DETECT_RANGE;
        n.attackRange = enemy ? entityStat(r.sprite, 'attackRange', ATTACK_RANGE) : ATTACK_RANGE;
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
  function reloadEnemies() {
    enemyCfg = loadEnemyCfg();
    entityDefs = buildEntityDefs(enemyCfg);
    ENEMY_SPRITES = new Set((enemyCfg && enemyCfg.enemySpriteGroups) || []);
    SPAWNERS = ((enemyCfg && enemyCfg.spawners) || []).filter((s) => s.enabled !== false);
    STATIC_ENEMY_HP = (SPAWNERS[0] && SPAWNERS[0].hp) || 24;
    staticNpcs = buildNpcs(loadMergedPlacements());
    pool = buildPool(staticNpcs.length);
    carPool = buildCarPool(staticNpcs.length + pool.length);
    npcs = staticNpcs.concat(pool).concat(carPool);
    for (const n of npcs) if (n.kind === 'person' || n.isEnemy) n.dirty = true;
    actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy || n.kind === 'car');
    enemies = npcs.filter((n) => n.isEnemy);
    console.log(
      `[npcSim] reloaded enemy spawners (${enemies.length} enemies, ${SPAWNERS.length} spawners)`
    );
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
    console.log(`[npcSim] reloaded traffic (${carPool.length} cars)`);
  }

  // fs.watchFile (polling) over fs.watch: reliable on Windows and across
  // editors/scripts that replace the file rather than write in place. Watch
  // BOTH the extracted base and the editor overrides.
  fs.watchFile(path.join(assetsDir, NPCS_FILE), { interval: 2000 }, reloadPlacements);
  fs.watchFile(OVERRIDES_PATH, { interval: 2000 }, reloadPlacements);
  fs.watchFile(ENEMY_OV_PATH, { interval: 2000 }, reloadEnemies);
  fs.watchFile(CAR_OV_PATH, { interval: 2000 }, reloadTraffic);

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

  // Cardinal+diagonal Direction (src/types.ts: S,N,W,E,NW,SW,SE,NE) for a
  // heading vector, so a car shows the sprite for the way it's driving.
  function dir8(dx, dy) {
    if (dx === 0 && dy === 0) return 0;
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
    // oct 0..7 = E,SE,S,SW,W,NW,N,NE  ->  Direction codes
    return [3, 6, 0, 5, 2, 4, 1, 7][oct];
  }

  // True if a car's body box at (nx,ny) overlaps any player or other live actor.
  // Cars yield to everything: when blocked they wait in place until it clears.
  function carBlocked(c, nx, ny, players) {
    const [bx, by, bw, bh] = actorBox(c, nx, ny);
    for (const p of players) {
      if (p.editor) continue; // cars drive through the parked editor avatar
      if (aabb(bx, by, bw, bh, p.x - COL_W / 2, p.y + COL_OY, COL_W, COL_H)) return true;
    }
    for (const o of actors) {
      if (o === c || o.dead || o.kind === 'deleted') continue;
      const [ox, oy, ow, oh] = actorBox(o, o.x, o.y);
      if (aabb(bx, by, bw, bh, ox, oy, ow, oh)) return true;
    }
    return false;
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
  // travel direction. If an entity is in the way, wait (don't advance).
  function tickCar(c, players) {
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
    const nx = c.x + ux * step;
    const ny = c.y + uy * step;
    if (carBlocked(c, nx, ny, players)) return; // entity ahead — wait
    c.x = nx;
    c.y = ny;
    c.dirty = true;
    stepAnimation(c); // cycle the 2 drive frames while actually moving
    if (Math.hypot(tgt[0] - c.x, tgt[1] - c.y) < 0.5) c.wpIndex = nextWp(c);
  }

  // The combat personality for a townsperson: the Entity Manager assignment for
  // its sprite group (entities[sprite].combat), else a stable seeded pick by id
  // so an unconfigured crowd still reacts diversely. KEEP IN SYNC with
  // EntityStats.CombatPersonality / EntityManagerTool's dropdown.
  function npcCombatPersonality(n) {
    const c =
      enemyCfg &&
      enemyCfg.entities &&
      enemyCfg.entities[n.sprite] &&
      enemyCfg.entities[n.sprite].combat;
    if (c && COMBAT_PERSONALITIES.includes(c)) return c;
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

    const canSwing =
      dist <= NPC_ATTACK_RANGE &&
      now - n.lastSwing >= NPC_ATTACK_COOLDOWN_MS &&
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
      if (foe.isPlayer) {
        // Swing at a PK player: HP lives on the host, so apply it there. Flat
        // NPC_DAMAGE (no crit/dodge) — townsfolk are a deliberate PK deterrent.
        console.log(
          `[HITDBG] TOWNSPERSON hit player ${e.id}: npc id=${n.id} sprite=${n.sprite} at (${Math.round(n.x)},${Math.round(n.y)}) -> player at (${Math.round(e.x)},${Math.round(e.y)}) dist=${Math.round(dist)} (player must be PK)`
        );
        if (onPlayerHitCb)
          onPlayerHitCb(
            e.id,
            NPC_DAMAGE,
            null,
            knockbackPlayerSpot(e.x, e.y, n.x, n.y, NPC_DAMAGE)
          );
      } else {
        // Townsfolk knock enemies back but don't paralyze them (a deliberate
        // deterrent, not a lockdown) — no status inflict.
        applyDamage(e, NPC_DAMAGE, now, null, { x: n.x, y: n.y, inflict: [] });
        e.aggressor = n; // the enemy remembers (and may turn on) whoever hit it
        e.aggroUntil = now + ENEMY_AGGRO_MEMORY_MS;
      }
    };

    n.dir = faceDir(e.x - n.x, e.y - n.y); // watch the threat by default

    switch (npcCombatPersonality(n)) {
      case 'brave':
        // Press the attack: close the gap, stand and swing once adjacent.
        if (dist > NPC_ATTACK_RANGE)
          moveToward(n, e.x, e.y, NPC_COMBAT_SPEED, players, NPC_COMBAT_LEASH);
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
        if (dist > NPC_ATTACK_RANGE)
          moveToward(n, e.x, e.y, NPC_COMBAT_SPEED, players, NPC_COMBAT_LEASH);
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
      const foe = nearestFoeTo(n, NPC_DETECT_RANGE, ppos);
      if (foe) {
        tickNpcCombat(n, foe, ppos, now);
        return; // combat owns this tick — skip the wander AI
      }
    }

    // No threat, but a fight may have carried us off our home spot: walk back
    // before resuming the leashed wander (the wander itself can't path beyond
    // LEASH, so it would otherwise stay stranded out in the street).
    if (Math.hypot(n.x - n.homeX, n.y - n.homeY) > LEASH) {
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
        Math.abs(nx - n.homeX) > LEASH ||
        Math.abs(ny - n.homeY) > LEASH;
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
    for (const o of actors) {
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

  // One tick of a vehicle: bear down on the nearest foe (enemy/PKer) if one is in
  // range, else cruise on a wandering heading. Movement is WALL-ONLY — the car
  // drives straight through the crowd (plow() resolves who it runs over), which
  // is what makes the plow read. Never leashed to home; doesn't flinch.
  function tickVehicle(n, players, now) {
    let hx;
    let hy;
    const foe = n.hp > 0 ? nearestFoeTo(n, n.detectRange || VEHICLE_DETECT, players) : null;
    if (foe) {
      hx = foe.enemy.x - n.x;
      hy = foe.enemy.y - n.y;
      n.life = 'idle';
    } else {
      if (n.life !== 'drive' || --n.timer <= 0) {
        const c = CARDINALS[rand(0, CARDINALS.length - 1)];
        n.walkDx = c.dx;
        n.walkDy = c.dy;
        n.life = 'drive';
        n.timer = rand(40, 120);
      }
      hx = n.walkDx;
      hy = n.walkDy;
    }
    const len = Math.hypot(hx, hy) || 1;
    const ux = hx / len;
    const uy = hy / len;
    const sp = n.speed || VEHICLE_SPEED;
    const nx = n.x + ux * sp;
    const ny = n.y + uy * sp;
    const [bx, by, bw, bh] = actorBox(n, nx, ny);
    if (blocked(bx, by, bw, bh)) {
      n.timer = 0; // walled in — repick a heading next tick
      plow(n, ux, uy, players, now); // still shove whatever we're pressed against
      return;
    }
    const travelX = nx - n.x;
    const travelY = ny - n.y;
    n.x = nx;
    n.y = ny;
    n.dir = faceDir(ux, uy);
    n.dirty = true;
    stepAnimation(n);
    plow(n, travelX, travelY, players, now);
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
  function aggroTarget(n, players, now) {
    // Hysteresis: a fresh enemy acquires inside detectRange, but one already
    // chasing holds the lock until the target passes the larger give-up distance
    // — it doesn't quit the moment the player steps a pixel past detect.
    const detect = n.detectRange || DETECT_RANGE; // per-entity aggro radius (Entity Manager)
    const range = n.mode === 'chase' ? Math.max(n.giveUpRange || GIVE_UP_RANGE, detect) : detect;
    let target = null;
    let best = range;
    for (const p of players) {
      if (p.editor) continue; // editor avatar is untargetable (out of the fight)
      if (p.hp !== undefined && p.hp <= 0) continue;
      const d = Math.hypot(p.x - n.x, p.y - n.y);
      if (d <= best) {
        best = d;
        target = p;
      }
    }
    if (target) return { target, dist: best, isPlayer: true };

    // No player in range. RETALIATE first: an enemy being attacked turns on the
    // NPC that's hitting it (kept fresh in applyDamage), preferring that
    // aggressor over a marginally closer bystander as long as it's alive and
    // still in detection range.
    const a = n.aggressor;
    if (a && !a.dead && a.hp > 0 && now < n.aggroUntil && canHurt(n, a)) {
      const d = Math.hypot(a.x - n.x, a.y - n.y);
      if (d <= range) return { target: a, dist: d, isPlayer: false };
    }

    // Otherwise defend-on-sight: the nearest townsperson it may hurt.
    best = range;
    for (const o of actors) {
      if (o.kind !== 'person' || o.dead || o.hp <= 0 || !canHurt(n, o)) continue;
      const d = Math.hypot(o.x - n.x, o.y - n.y);
      if (d <= best) {
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
    for (const e of enemies) {
      if (e.dead || e.hp <= 0 || !canHurt(n, e)) continue;
      const d = Math.hypot(e.x - n.x, e.y - n.y);
      if (d <= best) {
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
        if (d <= best) {
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
    for (const o of actors) {
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
  const UNSTACK_STEP = 2; // px/tick separation nudge
  function unstack(n) {
    const [bx, by, bw, bh] = actorBox(n, n.x, n.y);
    let sx = 0;
    let sy = 0;
    let stacked = false;
    for (const o of actors) {
      if (o === n || o.dead || o.kind === 'deleted') continue;
      const [ox, oy, ow, oh] = actorBox(o, o.x, o.y);
      if (!aabb(bx, by, bw, bh, ox, oy, ow, oh)) continue; // not overlapping
      stacked = true;
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
    }
    if (!stacked) return;
    const len = Math.hypot(sx, sy) || 1;
    const ux = (sx / len) * UNSTACK_STEP;
    const uy = (sy / len) * UNSTACK_STEP;
    const free = (mx, my) => {
      const [fx, fy, fw, fh] = actorBox(n, mx, my);
      return !blocked(fx, fy, fw, fh);
    };
    // Push apart; if a wall blocks that, slide along it (either perpendicular)
    // so the pile still drains instead of jamming in a corner.
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
      return; // boxed in by walls on every side — can't move this tick
    }
    n.dirty = true;
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
        // Walk to the crossing point and warp through on contact (tickDoorSeek)
        // — NEVER teleport across the room. A resolved door gives the exact
        // doorway anchor; a zone seam / scripted warp has no door trigger, so
        // the player's OWN pre-warp position is the crossing the enemy walks to
        // and warps through, treated as a synthetic doorway. Same walk-to-warp
        // path either way, so the regroup retrace (warpStack) is uniform.
        const cross = w.door || { x: w.fromX, y: w.fromY };
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

      // In striking range AND with a clear line (no wall between): stand and
      // swing on cooldown (resolved server-side; the pose broadcasts so every
      // client sees the attack). A wall between them drops to the chase below,
      // so the enemy paths around it instead of hitting through it.
      if (dist <= (n.attackRange || ATTACK_RANGE) && !wallBetween(n.x, n.y, target.x, target.y)) {
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
              console.log(
                `[HITDBG] ENEMY hit player ${target.id}: enemy id=${n.id} sprite=${n.sprite} kind=${n.kind} mode=${n.mode} dead=${n.dead} at (${Math.round(n.x)},${Math.round(n.y)}) -> player at (${Math.round(target.x)},${Math.round(target.y)}) dist=${Math.round(dist)} dmg=${res.dmg}`
              );
              if (onEnemyHit)
                onEnemyHit(
                  target.id,
                  res.dmg,
                  n,
                  knockbackPlayerSpot(target.x, target.y, n.x, n.y, res.dmg),
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
            applyDamage(target, n.damage, now, null, { x: n.x, y: n.y, inflict: enemyInflict(n) });
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
    // warp to follow — the target is genuinely gone, so regroup at spawn.
    if (n.mode === 'chase') {
      n.mode = 'return';
      n.returnSince = now;
      n.targetId = null;
    }

    if (n.mode === 'return') {
      if (tickReturn(n, players, now)) return; // still en route
      n.mode = 'patrol'; // arrived — resume wandering
      startIdle(n);
    }

    if (n.life === 'walk') {
      const nx = n.x + n.walkDx * n.speed;
      const ny = n.y + n.walkDy * n.speed;
      const wr = (n.spawner && n.spawner.wanderRadius) || 256;
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
    } else if (atk) {
      // Survived the hit — react to it: knocked back away from the attacker, plus
      // any status procs the hit carries (each element-scaled by the target's ROM
      // resist in tryStatus; an action-block holds the flinch for the freeze).
      // `atk.kb` (vehicles) overrides the shove heading/force for the plow effect.
      pushActor(target, atk.x, atk.y, dmg, atk.kb);
      for (const inf of atk.inflict || []) tryStatus(target, inf.type, inf.chance, now);
    }
  }

  // Resolve a player's melee swing: a hitbox in front of the attacker damages
  // every live enemy whose hurtbox it overlaps. Authoritative — the client only
  // requests the swing; HP, death, and respawn all live here.
  function handleAttack(
    x,
    y,
    dir,
    playerId,
    offense,
    attackerPk,
    critChance = 0,
    attackSpeed = 1,
    inflict = null
  ) {
    const now = Date.now();
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
    const hx = x + v[0] * ATTACK_REACH - ATTACK_HALF;
    const hy = y - 10 + v[1] * ATTACK_REACH - ATTACK_HALF;
    const hw = ATTACK_HALF * 2;
    const hh = ATTACK_HALF * 2;
    for (const n of enemies) {
      if (n.dead) continue;
      if (!canHurt(attacker, n)) continue; // PK rules decide if this lands
      if (!aabb(hx, hy, hw, hh, n.x - HURT_W / 2, n.y + HURT_OY, HURT_W, HURT_H)) continue;
      if (wallBetween(x, y, n.x, n.y)) continue; // no reaching through a wall
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
      applyDamage(n, res.dmg, now, playerId, { x, y, inflict: swingInflict });
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
        console.log(
          `[HITDBG] PVP hit player ${t.id}: by player ${playerId} at (${Math.round(t.x)},${Math.round(t.y)}) dmg=${res.dmg}`
        );
        // Knock the victim back from the attacker's feet (host applies + pushes)
        // and carry the same paralysis proc a player swing lands on enemies.
        onPlayerHitCb(
          t.id,
          res.dmg,
          playerId,
          knockbackPlayerSpot(t.x, t.y, x, y, res.dmg),
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
        if (players.length === 0) return;
        updateSpawners(now, players);
        // Detect door warps: a player whose reported position jumped > WARP_DELTA
        // in one tick teleported (the client warps on a door and sends the new
        // coords). Recorded into recentWarps with an expiry; enemies chasing that
        // player follow it through for WARP_FOLLOW_MS, not just this one tick.
        for (const p of players) {
          if (p.editor) continue; // parked editor avatar isn't warping; never chase it
          const prev = prevPlayerPos.get(p.id);
          const guarded = now < (respawnGuard.get(p.id) || 0); // mid respawn window
          if (!guarded && prev && Math.hypot(p.x - prev.x, p.y - prev.y) > WARP_DELTA) {
            // Resolve which doorway the player stepped through (its last pre-warp
            // position sits on the trigger) so chasers can walk to it and warp.
            recentWarps.set(p.id, {
              fromX: prev.x,
              fromY: prev.y,
              toX: p.x,
              toY: p.y,
              until: now + WARP_FOLLOW_MS,
              door: resolveDoor(prev.x, prev.y),
            });
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
            if (n.kind === 'car') tickCar(n, players);
            else if (n.roam) tickEnemy(n, players, now, onEnemyHit, recentWarps);
            else if (n.isVehicle) tickVehicle(n, players, now);
            else tickNpc(n, players, now);
            // Never let two bodies stay stacked: nudge apart if this tick ended
            // overlapping another actor. Enemies + townsfolk only — cars and
            // vehicles are meant to plow THROUGH actors, not separate from them.
            if (n.kind === 'enemy' || (n.kind === 'person' && !n.isVehicle)) unstack(n);
          } else if (n.roam && n.mode !== 'patrol') {
            // Off-station with no player nearby (the target fled far): keep
            // ticking so it finishes heading back to spawn instead of freezing
            // out of position.
            tickEnemy(n, players, now, onEnemyHit, recentWarps);
          }
        }
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
      }, 1000 / TICK_HZ);

      sendInterval = setInterval(() => {
        const moved = [];
        const hps = [];
        const stat = []; // [id, [statusId,...]] rows for actors whose set changed
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
        }
        if (moved.length > 0) broadcast({ type: 'npc_update', npcs: moved });
        if (hps.length > 0) broadcast({ type: 'npc_hp', hps });
        if (stat.length > 0) broadcast({ type: 'npc_status', statuses: stat });
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
     * townsperson that's currently damaged or downed (hp < maxHp) so a late
     * joiner sees their health bar / hidden-while-dead state. Full-HP townsfolk
     * are omitted — the client defaults them to full anyway.
     */
    hpSnapshot() {
      const out = enemies.map((n) => [n.id, n.hp, n.maxHp]);
      for (const n of actors) {
        if (n.kind === 'person' && n.hp < n.maxHp) out.push([n.id, n.hp, n.maxHp]);
      }
      return out;
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
      }));
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

    /** Resolve a player's melee swing (server-authoritative). */
    handleAttack,

    /**
     * Offense PSI strike: damage the nearest LIVE enemy within `range` px of
     * (x,y) that has line of sight (no wall between), crediting `killerPlayerId`
     * for XP/loot on a kill. Knockback flings it away from the caster. Returns
     * the struck enemy's {x,y} (for the projectile target), or null if none.
     */
    psiStrike(x, y, range, dmg, killerPlayerId, inflict) {
      let best = null;
      let bestD = range;
      for (const n of enemies) {
        if (n.dead) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d <= bestD && !wallBetween(x, y, n.x, n.y)) {
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

    stop() {
      if (tickInterval) clearInterval(tickInterval);
      if (sendInterval) clearInterval(sendInterval);
      fs.unwatchFile(path.join(assetsDir, NPCS_FILE), reloadPlacements);
      fs.unwatchFile(OVERRIDES_PATH, reloadPlacements);
      fs.unwatchFile(ENEMY_OV_PATH, reloadEnemies);
      fs.unwatchFile(CAR_OV_PATH, reloadTraffic);
      fs.unwatchFile(COLLISION_OV_PATH, loadCollisionWithOverrides);
      fs.unwatchFile(path.join(assetsDir, DOORS_FILE), loadDoorTriggers);
      fs.unwatchFile(DOORS_OV_PATH, loadDoorTriggers);
    },
  };
}

module.exports = { createNpcSim, resolveMelee };
