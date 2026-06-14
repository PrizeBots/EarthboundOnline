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
  { dir: 0, dx: 0, dy: 1 },  // S
  { dir: 1, dx: 0, dy: -1 }, // N
  { dir: 2, dx: -1, dy: 0 }, // W
  { dir: 3, dx: 1, dy: 0 },  // E
];

// --- Combat tuning ---
// Facing unit vectors indexed by Direction (src/types.ts): S,N,W,E,NW,SW,SE,NE.
const DIAG = Math.SQRT1_2;
const DIR_VEC = [
  [0, 1], [0, -1], [-1, 0], [1, 0],
  [-DIAG, -DIAG], [-DIAG, DIAG], [DIAG, DIAG], [DIAG, -DIAG],
];
const ATTACK_REACH = 14;   // px the hitbox sits in front of the attacker's feet
const ATTACK_HALF = 8;     // half-size of the (square) attack hitbox
const HURT_W = 14;         // enemy hurtbox, anchored on the feet (center-bottom)
const HURT_H = 18;
const HURT_OY = -18;
const ATTACK_DAMAGE = 6;
const ATTACK_COOLDOWN_MS = 250; // min time between a player's resolved attacks
const HURT_MS = 300;            // how long a struck enemy shows its flinch pose

// --- Enemy aggression (Heavy) ---
// Enemies have a level (set from the spawner / a default) and so do players, so
// a future EarthBound-style "flee if you out-level it" rule can hook in here.
// For now level is just tracked; aggro is unconditional: any enemy chases and
// hits the nearest living player it can see.
const DEFAULT_ENEMY_LEVEL = 4;
const DETECT_RANGE = 220;          // px — default aggro radius; per-entity `detectRange` (Entity Manager) overrides it
const ATTACK_RANGE = 24;           // px — enemy must be this close to land a hit
const ENEMY_CHASE_SPEED = 1.6;     // px/frame while pursuing (player is 2.0) — fast enough to be a real threat, slow enough to outrun
const ENEMY_ATTACK_COOLDOWN_MS = 700; // min time between one enemy's swings
const ENEMY_ATTACK_POSE_MS = 250;  // how long the swing pose shows
const ENEMY_DAMAGE = 7;            // HP per landed hit
const DEFAULT_ENEMY_XP = 5;        // EXP a kill grants the killer (spawners override)

// --- Pursuit steering (anti-clump + obstacle routing) ---
// Separation spreads pursuers around the target instead of stacking; angled
// steering lets a blocked enemy fan out around a wall/each other rather than
// stalling in a line. STEER_ANGLES (radians) are tried in order — straight
// first, then alternating left/right by widening angles.
const SEP_RADIUS = 24;   // px — other actors within this push the enemy away
const SEP_WEIGHT = 0.8;  // separation strength vs the (unit) pursue vector
const STEER_ANGLES = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4];

// --- Pursuit into buildings + regroup-at-spawn ---
// Player movement is client-reported (server/index.js just records msg.x/msg.y),
// and the client warps a player through a door by setting its own coords — so a
// door warp reaches us as a one-tick jump in the reported position. Enemies use
// that to follow a player they're chasing through the door, then once they lose
// the target they retrace their way out and head back to the spawn point.
const PURSUIT_LEASH_MULT = 3;   // chase reaches this * wanderRadius from home (the patrol leash) before dropping a heading
const WARP_DELTA = 96;          // a one-tick player jump bigger than this is a door warp (players move ~2px/tick)
const WARP_FOLLOW_RANGE = DETECT_RANGE; // an enemy this close to the door the player took follows it through
const RETURN_ARRIVE = 24;       // px from the spawn point / a retraced door counted as "arrived"
const RETURN_GIVEUP_MS = 8000;  // can't path back in this long -> snap to spawn so the pack always regroups

// --- NPC self-defense (townsfolk fight back) ---
// Every 'person' can defend itself: it HOLDS GROUND (never chases) and swings at
// any living enemy within NPC_DETECT_RANGE — "defend on sight", no first hit
// required. Players ALWAYS take targeting priority for enemies, so an enemy only
// turns on townsfolk when no player is in range (see aggroTarget). A downed
// townsperson hides (hp 0) and revives at its home spot after a delay (backlog:
// a hospital / per-entity chosen respawn point + personality flags in the
// Entity Manager). Whether an NPC may damage an enemy still goes through canHurt.
const NPC_HP = 30;                  // townsfolk max HP (matches client Entity default)
const NPC_DAMAGE = 5;               // HP an NPC's swing takes off an enemy
const NPC_DETECT_RANGE = 96;        // px — an enemy this close makes an NPC defend
const NPC_ATTACK_RANGE = 24;        // px — NPC must be this close to land a hit
const NPC_ATTACK_COOLDOWN_MS = 800; // min time between one townsperson's swings
const NPC_ATTACK_POSE_MS = 250;     // how long the NPC's swing pose shows
const NPC_RESPAWN_MS = 12000;       // a downed townsperson revives at home after this
// When an NPC hits an enemy, the enemy remembers its attacker this long and (if
// no player is in range — players keep priority) turns to retaliate against it.
const ENEMY_AGGRO_MEMORY_MS = 4000;

// Pose -> wire code, indexing POSES in src/types.ts: walk,climb,attack,hurt.
// Broadcast in npc_update rows so every client sees the same animation pose.
const POSE_CODE = { walk: 0, climb: 1, attack: 2, hurt: 3 };
function poseCode(n) {
  return POSE_CODE[n.pose] || 0;
}
const STATIC_RESPAWN_MS = 12000; // ROM-placed enemies revive at home after this
const ENEMY_SPEED = 0.7;   // roamers move a touch faster than ambling townsfolk
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
  if (attacker.pk) return true;                  // PK players hurt everything
  return !!target.pk;                            // others hurt only PKers
}

function createNpcSim(assetsDir) {
  const readJSON = (rel) =>
    JSON.parse(fs.readFileSync(path.join(assetsDir, rel), 'utf8'));

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
  // `let` so the file watch can swap them in live.
  let enemyCfg = loadEnemyCfg();
  let ENEMY_SPRITES = new Set((enemyCfg && enemyCfg.enemySpriteGroups) || []);
  let SPAWNERS = ((enemyCfg && enemyCfg.spawners) || []).filter((s) => s.enabled !== false);
  let STATIC_ENEMY_HP = (SPAWNERS[0] && SPAWNERS[0].hp) || 24;

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

  // --- NPC state ---
  const NPCS_FILE = 'map/npcs.json';
  // Editor-authored placement overrides (public/overrides/npcs.json — sibling
  // of the assets dir). Absent until something is authored.
  const OVERRIDES_PATH = path.join(assetsDir, '..', 'overrides', 'npcs.json');
  const lastAttackAt = {}; // playerId -> ms, for the per-player attack cooldown
  const prevPlayerPos = new Map(); // playerId -> last {x,y}, to detect door warps
  const warpSuppressed = new Set(); // ids whose next position jump is a respawn, not a door (host flags via noteRespawn)
  let onEnemyKillCb = null; // set in start(): (playerId, xp, enemy) => void

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
    return Object.assign({
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
      lastSwing: 0,  // ms of this enemy's last attack (per-enemy cooldown)
      poseStart: 0,  // ms a transient pose (attack/hurt) began — drives frame anim
      aggressor: null, // the NPC that most recently hit this enemy (retaliation)
      aggroUntil: 0,   // ms until that grudge expires
      spawner: null,
      // Pursuit / regroup state machine (enemies only):
      mode: 'patrol',   // 'patrol' wander | 'chase' a target | 'return' to spawn
      targetId: null,   // id of the player being chased (for door-follow matching)
      warpStack: [],     // doors warped through while chasing, retraced on return
      returnSince: 0,    // ms the current regroup began (RETURN_GIVEUP_MS timer)
    }, fields);
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
          id, kind: 'deleted', sprite: 0,
          x: 0, y: 0, homeX: 0, homeY: 0, dir: 0, homeDir: 0,
          indoor: false, dead: true,
        });
      }
      const enemy = ENEMY_SPRITES.has(r.sprite);
      const person = !enemy && r.kind === 'person'; // props/deleted carry no HP
      return baseActor({
        id,
        kind: enemy ? 'enemy' : r.kind,
        sprite: r.sprite,
        x: r.x, y: r.y, homeX: r.x, homeY: r.y,
        dir: r.dir, homeDir: r.dir,
        indoor: !!(sectorForTile(Math.floor(r.x / TILE), Math.floor(r.y / TILE)) || {}).indoor,
        isEnemy: enemy,
        pk: enemy, // enemies are always PK; townsfolk never are
        hp: enemy ? STATIC_ENEMY_HP : (person ? NPC_HP : 0),
        maxHp: enemy ? STATIC_ENEMY_HP : (person ? NPC_HP : 0),
        level: enemy ? DEFAULT_ENEMY_LEVEL : 1,
        xp: enemy ? DEFAULT_ENEMY_XP : 0,
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
    const e = (enemyCfg && enemyCfg.entities && enemyCfg.entities[sp.sprite]) || {};
    if (e[key] != null) return e[key];
    if (sp[key] != null) return sp[key];
    return def;
  }

  function buildPool(startId) {
    const out = [];
    let id = startId;
    for (const sp of SPAWNERS) {
      const speed = spawnerStat(sp, 'speed', ENEMY_SPEED);
      for (let i = 0; i < (sp.poolSize || 0); i++) {
        out.push(baseActor({
          id: id++,
          kind: 'enemy',
          sprite: sp.sprite,
          x: sp.x, y: sp.y, homeX: sp.x, homeY: sp.y,
          dir: 1, homeDir: 1,
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
        }));
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
          x: sx, y: sy, homeX: sx, homeY: sy,
          dir: 0, homeDir: 0,
          indoor: false,
          waypoints: v.waypoints,
          wpIndex: 1, // heading toward the second waypoint
          step: 1,    // ping-pong direction for non-looping routes
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
          n.dirty = false;
          n.hpDirty = false;
          n.life = 'idle';
          return;
        }
        const enemy = ENEMY_SPRITES.has(r.sprite);
        const person = !enemy && r.kind === 'person';
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
        n.maxHp = enemy ? STATIC_ENEMY_HP : (person ? NPC_HP : 0);
        n.hp = enemy ? STATIC_ENEMY_HP : (person ? NPC_HP : 0);
        n.level = enemy ? DEFAULT_ENEMY_LEVEL : 1;
        n.xp = enemy ? DEFAULT_ENEMY_XP : 0;
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
    console.log(`[npcSim] reloaded ${NPCS_FILE} (${actors.length} actors, ${enemies.length} enemies)`);
  }

  // Hot-reload enemy spawners when the Enemy Spawner editor saves
  // overrides/enemy_spawns.json. Static reclassification (by sprite) AND the
  // appended pool both depend on the enemy config, so rebuild both. A changed
  // live pool size shifts wire ids — connected clients must refresh (the
  // editing client re-runs loadNPCs on save); tuning-only edits (radius, rate,
  // hp, position) apply live without an id shift.
  function reloadEnemies() {
    enemyCfg = loadEnemyCfg();
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
    console.log(`[npcSim] reloaded enemy spawners (${enemies.length} enemies, ${SPAWNERS.length} spawners)`);
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
      const px = p.x - COL_W / 2;
      const py = p.y + COL_OY;
      if (x < px + COL_W && x + w > px && y < py + COL_H && y + h > py) return true;
    }
    return false;
  }

  // True if the foot box overlaps any OTHER live actor's foot box. Makes
  // townsfolk and enemies solid to each other (same box/anchor as the player),
  // so a chasing pack can't all stack on the same pixel — they jostle for
  // position instead. Dead/tombstoned slots are non-solid.
  function hitsActor(self, x, y, w, h) {
    for (const o of actors) {
      if (o === self || o.dead || o.kind === 'deleted') continue;
      // Cars are big obstacles (full sprite rect); everyone else is a foot box.
      const ox = o.kind === 'car' ? o.x - o.carW / 2 : o.x - COL_W / 2;
      const oy = o.kind === 'car' ? o.y - o.carH : o.y + COL_OY;
      const ow = o.kind === 'car' ? o.carW : COL_W;
      const oh = o.kind === 'car' ? o.carH : COL_H;
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
    const bx = nx - c.carW / 2;
    const by = ny - c.carH;
    for (const p of players) {
      if (aabb(bx, by, c.carW, c.carH, p.x - COL_W / 2, p.y + COL_OY, COL_W, COL_H)) return true;
    }
    for (const o of actors) {
      if (o === c || o.dead || o.kind === 'deleted') continue;
      const ox = o.kind === 'car' ? o.x - o.carW / 2 : o.x - COL_W / 2;
      const oy = o.kind === 'car' ? o.y - o.carH : o.y + COL_OY;
      const ow = o.kind === 'car' ? o.carW : COL_W;
      const oh = o.kind === 'car' ? o.carH : COL_H;
      if (aabb(bx, by, c.carW, c.carH, ox, oy, ow, oh)) return true;
    }
    return false;
  }

  // Next waypoint index for a car: looping routes wrap; one-shot routes
  // ping-pong (reverse at the ends) so the car never teleports back to start.
  function nextWp(c) {
    const n = c.waypoints.length;
    if (c.loop) return (c.wpIndex + 1) % n;
    let i = c.wpIndex + c.step;
    if (i >= n) { c.step = -1; i = n - 2; }
    else if (i < 0) { c.step = 1; i = 1; }
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

  function tickNpc(n, ppos, now) {
    // Hold position while a swing or flinch is playing so its generated frames
    // show (movement would overwrite the frame via stepAnimation).
    if ((n.pose === 'attack' || n.pose === 'hurt') && now < n.poseUntil) return;

    // Self-defense (defend on sight, hold ground): if a living enemy is within
    // NPC_DETECT_RANGE, the townsperson stops wandering, faces it, and swings
    // when it's adjacent — it never chases. Players are never targeted (only
    // enemies, gated by canHurt). Props/0-HP people can't fight.
    if (n.hp > 0) {
      const foe = nearestEnemyTo(n, NPC_DETECT_RANGE);
      if (foe) {
        if (n.life === 'walk') startIdle(n); // plant and stand firm
        const nd = faceDir(foe.enemy.x - n.x, foe.enemy.y - n.y);
        if (nd !== n.dir) { n.dir = nd; n.dirty = true; }
        if (
          foe.dist <= NPC_ATTACK_RANGE &&
          now - n.lastSwing >= NPC_ATTACK_COOLDOWN_MS &&
          n.pose !== 'hurt'
        ) {
          n.lastSwing = now;
          n.pose = 'attack';
          n.poseStart = now;
          n.poseUntil = now + NPC_ATTACK_POSE_MS;
          n.frame = 0; // start on the wind-up frame
          n.dirty = true;
          applyDamage(foe.enemy, NPC_DAMAGE, now, null);
          // Make the enemy remember (and turn on) whoever just hit it.
          foe.enemy.aggressor = n;
          foe.enemy.aggroUntil = now + ENEMY_AGGRO_MEMORY_MS;
        }
        return; // hold ground — skip the wander AI this tick
      }
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

  // --- Enemy behaviour & combat ---

  // Cardinal Direction (src/types.ts) facing the vector (dx,dy), dominant axis.
  function faceDir(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 2 : 3; // W : E
    return dy < 0 ? 1 : 0;                                  // N : S
  }

  // The enemy's target within DETECT_RANGE, or null. PLAYERS ALWAYS WIN: any
  // living player in range outranks every NPC, even a closer one. Only when no
  // player is in range does the enemy fall back to the nearest living
  // townsperson it's allowed to hurt (canHurt). `isPlayer` tells the caller
  // whether to route the hit through the host (players) or apply it here (NPCs).
  function aggroTarget(n, players, now) {
    const range = n.detectRange || DETECT_RANGE; // per-entity aggro radius (Entity Manager)
    let target = null;
    let best = range;
    for (const p of players) {
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

  // Nearest living enemy within `range` that `n` (a townsperson) may hurt, or
  // null. Used by NPC self-defense — townsfolk only ever target enemies.
  function nearestEnemyTo(n, range) {
    let found = null;
    let best = range;
    for (const e of enemies) {
      if (e.dead || e.hp <= 0 || !canHurt(n, e)) continue;
      const d = Math.hypot(e.x - n.x, e.y - n.y);
      if (d <= best) {
        best = d;
        found = e;
      }
    }
    return found ? { enemy: found, dist: best } : null;
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
      n.x = n.homeX; n.y = n.homeY; n.dir = n.homeDir;
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
        n.x = spot.x; n.y = spot.y; n.dir = n.homeDir; n.dirty = true;
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

  // Roamers wander town-wide (bounded by spawner.wanderRadius from the spawn
  // point), unlike townsfolk leashed to a 32px home. With a player in sight
  // they break off and pursue, swinging when they get in range.
  function tickEnemy(n, players, now, onEnemyHit, warps) {
    // Hold position while a swing or flinch is playing so its generated frames
    // show (movement would overwrite the frame via stepAnimation).
    if ((n.pose === 'attack' || n.pose === 'hurt') && now < n.poseUntil) return;

    const aggro = aggroTarget(n, players, now);
    if (aggro) {
      const { target, dist, isPlayer } = aggro;
      n.mode = 'chase';
      n.targetId = isPlayer ? target.id : null; // only players warp through doors
      const dx = target.x - n.x;
      const dy = target.y - n.y;
      n.dir = faceDir(dx, dy);

      // In striking range: stand and swing on cooldown (the hit is resolved
      // server-side; the pose broadcasts so every client sees the attack).
      if (dist <= (n.attackRange || ATTACK_RANGE)) {
        if (now - n.lastSwing >= n.attackCooldown && n.pose !== 'hurt') {
          n.lastSwing = now;
          n.pose = 'attack';
          n.poseStart = now;
          n.poseUntil = now + ENEMY_ATTACK_POSE_MS;
          n.frame = 0; // start on the wind-up frame
          n.dirty = true;
          // Player HP lives on the host; an NPC target is ours to damage.
          if (isPlayer) {
            if (onEnemyHit) onEnemyHit(target.id, n.damage, n);
          } else {
            applyDamage(target, n.damage, now, null);
          }
        }
        return;
      }

      // Otherwise close in. moveToward fans out around walls/each other. Inside
      // a building (we warped in after the player) the home leash is across the
      // map and meaningless, so drop it; outside, allow a wide pursuit leash so
      // a chase can reach a doorway past the patrol wander radius.
      const wr = (n.spawner && n.spawner.wanderRadius) || 256;
      const leash = n.warpStack.length ? Infinity : wr * PURSUIT_LEASH_MULT;
      moveToward(n, target.x, target.y, n.chaseSpeed, players, leash);
      return;
    }

    // No target this tick.
    if (n.mode === 'chase') {
      // The player we were chasing may have just stepped through a door — its
      // reported position jumped this tick (see warp detection in start()). If
      // we're right behind it, follow through: drop beside where it landed and
      // keep the chase going inside, recording the door so we can retrace out.
      const w = n.targetId != null && warps && warps.find((e) => e.id === n.targetId);
      if (w && Math.hypot(n.x - w.fromX, n.y - w.fromY) <= WARP_FOLLOW_RANGE) {
        const spot = findFreeNear(w.toX, w.toY, n, players);
        if (spot) {
          n.warpStack.push({ outX: w.fromX, outY: w.fromY, inX: w.toX, inY: w.toY });
          n.x = spot.x; n.y = spot.y; n.dirty = true;
          return; // still 'chase' — aggro should re-acquire inside next tick
        }
      }
      // Lost the target for real — head back to the spawn area to regroup.
      n.mode = 'return';
      n.returnSince = now;
      n.targetId = null;
    }

    if (n.mode === 'return') {
      if (tickReturn(n, players, now)) return; // still en route
      n.mode = 'patrol';                       // arrived — resume wandering
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
      cand.x = spot.x; cand.y = spot.y; cand.homeX = sp.x; cand.homeY = sp.y;
      cand.dir = 1; cand.frame = 0; cand.life = 'idle'; cand.timer = rand(20, 60);
      cand.hp = cand.maxHp; cand.dead = false;
      cand.pose = 'walk'; cand.aggressor = null; cand.aggroUntil = 0;
      cand.mode = 'patrol'; cand.targetId = null; cand.warpStack.length = 0;
      cand.dirty = true; cand.hpDirty = true;
      sp._lastSpawn = now;
    }
  }

  // ROM-placed enemies (no spawner) revive at their home spot after a delay.
  function reviveStatics(now) {
    for (const n of enemies) {
      if (n.spawner || !n.dead || now < n.respawnAt) continue;
      n.x = n.homeX; n.y = n.homeY; n.dir = n.homeDir; n.frame = 0;
      n.life = 'idle'; n.timer = rand(60, 300);
      n.hp = n.maxHp; n.dead = false;
      n.pose = 'walk'; n.aggressor = null; n.aggroUntil = 0;
      n.mode = 'patrol'; n.targetId = null; n.warpStack.length = 0;
      n.dirty = true; n.hpDirty = true;
    }
  }

  // Downed townsfolk revive at their home spot after a delay (backlog: a chosen
  // hospital / respawn point per entity). Mirrors reviveStatics for persons.
  function reviveNpcs(now) {
    for (const n of actors) {
      if (n.kind !== 'person' || !n.dead || now < n.respawnAt) continue;
      n.x = n.homeX; n.y = n.homeY; n.dir = n.homeDir; n.frame = 0;
      n.pose = 'walk'; n.life = 'idle'; n.timer = rand(60, 300);
      n.hp = n.maxHp; n.dead = false;
      n.dirty = true; n.hpDirty = true;
    }
  }

  // Apply `dmg` to a live actor WE own (enemy or townsperson): flinch, broadcast
  // HP, and on death hide + schedule the right revival. Enemies award the killer
  // their EXP (players only — killerPlayerId is null for NPC-dealt kills);
  // townsfolk just go down and respawn at home. The single death path shared by
  // player swings (handleAttack), enemy swings, and NPC self-defense.
  function applyDamage(target, dmg, now, killerPlayerId) {
    if (!target || target.dead || target.hp <= 0) return;
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
        if (killerPlayerId != null && onEnemyKillCb) onEnemyKillCb(killerPlayerId, target.xp || 0, target);
      } else {
        target.respawnAt = now + NPC_RESPAWN_MS;
      }
    }
  }

  // Resolve a player's melee swing: a hitbox in front of the attacker damages
  // every live enemy whose hurtbox it overlaps. Authoritative — the client only
  // requests the swing; HP, death, and respawn all live here.
  function handleAttack(x, y, dir, playerId, offense, attackerPk) {
    const now = Date.now();
    if (now - (lastAttackAt[playerId] || 0) < ATTACK_COOLDOWN_MS) return;
    lastAttackAt[playerId] = now;
    // PK gating: build the attacker's shape once. A player is never an enemy;
    // its `pk` decides whether it may hit non-PK targets. Today npcSim only
    // owns enemies (all PK), so a non-PK player can already hit them — but the
    // check keeps the rule centralized for when NPCs/PvP become damageable.
    const attacker = { isEnemy: false, pk: !!attackerPk };
    // Damage scales with the attacker's Offense stat (leveling makes you hit
    // harder); falls back to the flat constant if none was passed.
    const dmg = offense > 0 ? offense : ATTACK_DAMAGE;
    const v = DIR_VEC[dir] || DIR_VEC[0];
    const hx = x + v[0] * ATTACK_REACH - ATTACK_HALF;
    const hy = y - 10 + v[1] * ATTACK_REACH - ATTACK_HALF;
    const hw = ATTACK_HALF * 2;
    const hh = ATTACK_HALF * 2;
    for (const n of enemies) {
      if (n.dead) continue;
      if (!canHurt(attacker, n)) continue; // PK rules decide if this lands
      if (!aabb(hx, hy, hw, hh, n.x - HURT_W / 2, n.y + HURT_OY, HURT_W, HURT_H)) continue;
      // Shared death path: flinch, HP broadcast, respawn, and EXP to the killer.
      applyDamage(n, dmg, now, playerId);
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
     * onEnemyKill: (playerId, xp, enemy) => void — a player landed a killing
     *   blow; the host awards that player the enemy's EXP.
     */
    start(getPlayers, broadcast, onEnemyHit, onEnemyKill) {
      onEnemyKillCb = onEnemyKill || null;
      tickInterval = setInterval(() => {
        const players = getPlayers();
        const now = Date.now();
        reviveStatics(now);
        reviveNpcs(now);
        if (players.length === 0) return;
        updateSpawners(now, players);
        // Detect door warps: a player whose reported position jumped > WARP_DELTA
        // in one tick teleported (the client warps on a door and sends the new
        // coords). Enemies chasing that player use these to follow it through.
        const warps = [];
        for (const p of players) {
          const prev = prevPlayerPos.get(p.id);
          if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > WARP_DELTA && !warpSuppressed.has(p.id)) {
            warps.push({ id: p.id, fromX: prev.x, fromY: prev.y, toX: p.x, toY: p.y });
          }
          warpSuppressed.delete(p.id); // one-shot: only the immediate respawn jump is exempt
          prevPlayerPos.set(p.id, { x: p.x, y: p.y });
        }
        for (const id of prevPlayerPos.keys()) {
          if (!players.some((p) => p.id === id)) prevPlayerPos.delete(id);
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
          if (near) {
            if (n.kind === 'car') tickCar(n, players);
            else if (n.roam) tickEnemy(n, players, now, onEnemyHit, warps);
            else tickNpc(n, players, now);
          } else if (n.roam && n.mode !== 'patrol') {
            // Off-station with no player nearby (the target fled far): keep
            // ticking so it finishes heading back to spawn instead of freezing
            // out of position.
            tickEnemy(n, players, now, onEnemyHit, warps);
          }
        }
      }, 1000 / TICK_HZ);

      sendInterval = setInterval(() => {
        const moved = [];
        const hps = [];
        for (const n of actors) {
          if (n.dirty && !n.dead) {
            n.dirty = false;
            moved.push([n.id, Math.round(n.x * 2) / 2, Math.round(n.y * 2) / 2, n.dir, n.frame, poseCode(n)]);
          }
          if (n.hpDirty) {
            n.hpDirty = false;
            hps.push([n.id, n.hp, n.maxHp]);
          }
        }
        if (moved.length > 0) broadcast({ type: 'npc_update', npcs: moved });
        if (hps.length > 0) broadcast({ type: 'npc_hp', hps });
      }, 1000 / BROADCAST_HZ);
    },

    /** Divergent-from-spawn positions of LIVE actors, for newly joining clients. */
    snapshot() {
      const out = [];
      for (const n of actors) {
        if (n.dead) continue;
        const hurt = n.pose === 'hurt';
        if (n.x !== n.homeX || n.y !== n.homeY || n.dir !== n.homeDir || n.frame !== 0 || hurt) {
          out.push([n.id, Math.round(n.x * 2) / 2, Math.round(n.y * 2) / 2, n.dir, n.frame, poseCode(n)]);
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

    /** Resolve a player's melee swing (server-authoritative). */
    handleAttack,

    /**
     * Tell the sim a player just respawn-teleported to the spawn point. Its next
     * position jump is exempt from door-warp detection, so a chasing enemy won't
     * follow the (revived, full-HP) player back to spawn — death looks identical
     * to a door warp otherwise (full HP + a big position jump in one tick).
     */
    noteRespawn(id) {
      warpSuppressed.add(id);
    },

    stop() {
      if (tickInterval) clearInterval(tickInterval);
      if (sendInterval) clearInterval(sendInterval);
      fs.unwatchFile(path.join(assetsDir, NPCS_FILE), reloadPlacements);
      fs.unwatchFile(OVERRIDES_PATH, reloadPlacements);
      fs.unwatchFile(ENEMY_OV_PATH, reloadEnemies);
      fs.unwatchFile(CAR_OV_PATH, reloadTraffic);
      fs.unwatchFile(COLLISION_OV_PATH, loadCollisionWithOverrides);
    },
  };
}

module.exports = { createNpcSim };
