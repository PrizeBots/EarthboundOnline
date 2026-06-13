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
const MAP_H_TILES = 320;
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
const ATTACK_REACH = 16;   // px the hitbox sits in front of the attacker's feet
const ATTACK_HALF = 11;    // half-size of the (square) attack hitbox
const HURT_W = 14;         // enemy hurtbox, anchored on the feet (center-bottom)
const HURT_H = 18;
const HURT_OY = -18;
const ATTACK_DAMAGE = 6;
const ATTACK_COOLDOWN_MS = 250; // min time between a player's resolved attacks
const STATIC_RESPAWN_MS = 12000; // ROM-placed enemies revive at home after this
const ENEMY_SPEED = 0.7;   // roamers move a touch faster than ambling townsfolk
const ENEMY_FILE = 'map/enemy_spawns.json';

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function createNpcSim(assetsDir) {
  const readJSON = (rel) =>
    JSON.parse(fs.readFileSync(path.join(assetsDir, rel), 'utf8'));

  const sectors = readJSON('map/sectors.json');
  const tiles = readJSON('map/tiles.json');
  const tilesetMapping = readJSON('map/tileset_mapping.json');
  const collisionByDrawTs = new Map();

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
    if (x + w >= MAP_W_TILES * TILE || y + h >= MAP_H_TILES * TILE) return true;
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
        if (arr >= cols.length) continue;
        if ((cols[arr][(my % 4) * 4 + (mx % 4)] & 0x80) !== 0) return true;
      }
    }
    return false;
  }

  // --- Enemy config (our own content — see public/assets/map/enemy_spawns.json) ---
  let enemyCfg = null;
  try {
    enemyCfg = readJSON(ENEMY_FILE);
  } catch {
    // Optional: no enemies if the file is absent.
  }
  const ENEMY_SPRITES = new Set((enemyCfg && enemyCfg.enemySpriteGroups) || []);
  const SPAWNERS = (enemyCfg && enemyCfg.spawners) || [];
  const STATIC_ENEMY_HP = (SPAWNERS[0] && SPAWNERS[0].hp) || 24;

  // --- NPC state ---
  const NPCS_FILE = 'map/npcs.json';
  // Editor-authored placement overrides (public/overrides/npcs.json — sibling
  // of the assets dir). Absent until something is authored.
  const OVERRIDES_PATH = path.join(assetsDir, '..', 'overrides', 'npcs.json');
  const lastAttackAt = {}; // playerId -> ms, for the per-player attack cooldown

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
      roam: false,
      hp: 0,
      maxHp: 0,
      dead: false,
      hpDirty: false,
      respawnAt: 0,
      spawner: null,
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
      return baseActor({
        id,
        kind: enemy ? 'enemy' : r.kind,
        sprite: r.sprite,
        x: r.x, y: r.y, homeX: r.x, homeY: r.y,
        dir: r.dir, homeDir: r.dir,
        indoor: !!(sectorForTile(Math.floor(r.x / TILE), Math.floor(r.y / TILE)) || {}).indoor,
        isEnemy: enemy,
        hp: enemy ? STATIC_ENEMY_HP : 0,
        maxHp: enemy ? STATIC_ENEMY_HP : 0,
      });
    });
  }

  // Fixed enemy pool from the spawners, appended AFTER the ROM placements so
  // wire ids (array indexes) align with the client, which builds the same pool
  // from the same file. Slots start dead (hp 0 = hidden) until activated.
  function buildPool(startId) {
    const out = [];
    let id = startId;
    for (const sp of SPAWNERS) {
      for (let i = 0; i < (sp.poolSize || 0); i++) {
        out.push(baseActor({
          id: id++,
          kind: 'enemy',
          sprite: sp.sprite,
          x: sp.x, y: sp.y, homeX: sp.x, homeY: sp.y,
          dir: 1, homeDir: 1,
          indoor: false,
          isEnemy: true,
          roam: true,
          maxHp: sp.hp || 24,
          dead: true, // inactive until the spawner wakes it
          spawner: sp,
        }));
      }
    }
    return out;
  }

  let staticNpcs = buildNpcs(loadMergedPlacements());
  let pool = buildPool(staticNpcs.length);
  let npcs = staticNpcs.concat(pool);
  // Everything that ticks/broadcasts (townsfolk + enemies); enemies subset.
  let actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy);
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
          n.dirty = false;
          n.hpDirty = false;
          n.life = 'idle';
          return;
        }
        const enemy = ENEMY_SPRITES.has(r.sprite);
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
        n.maxHp = enemy ? STATIC_ENEMY_HP : 0;
        n.hp = enemy ? STATIC_ENEMY_HP : 0;
        n.dead = false;
        n.dirty = n.kind === 'person' || enemy;
        n.hpDirty = enemy;
      });
      npcs = staticNpcs.concat(pool);
    } else {
      // Entry count changed: wire ids (array indexes) shifted — rebuild static
      // AND the appended pool so ids realign. Connected clients must refresh.
      staticNpcs = buildNpcs(raw);
      pool = buildPool(staticNpcs.length);
      npcs = staticNpcs.concat(pool);
      for (const n of npcs) if (n.kind === 'person' || n.isEnemy) n.dirty = true;
    }
    actors = npcs.filter((n) => n.kind === 'person' || n.isEnemy);
    enemies = npcs.filter((n) => n.isEnemy);
    console.log(`[npcSim] reloaded ${NPCS_FILE} (${actors.length} actors, ${enemies.length} enemies)`);
  }

  // fs.watchFile (polling) over fs.watch: reliable on Windows and across
  // editors/scripts that replace the file rather than write in place. Watch
  // BOTH the extracted base and the editor overrides.
  fs.watchFile(path.join(assetsDir, NPCS_FILE), { interval: 2000 }, reloadPlacements);
  fs.watchFile(OVERRIDES_PATH, { interval: 2000 }, reloadPlacements);

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

  function tickNpc(n, ppos) {
    if (n.life === 'walk') {
      const nx = n.x + n.walkDx * SPEED;
      const ny = n.y + n.walkDy * SPEED;
      const stop =
        blocked(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H) ||
        hitsPlayer(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H, ppos) ||
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

  // Roamers wander town-wide (bounded by spawner.wanderRadius from the spawn
  // point), unlike townsfolk leashed to a 32px home.
  function tickEnemy(n, ppos) {
    if (n.life === 'walk') {
      const nx = n.x + n.walkDx * ENEMY_SPEED;
      const ny = n.y + n.walkDy * ENEMY_SPEED;
      const wr = (n.spawner && n.spawner.wanderRadius) || 256;
      const stop =
        blocked(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H) ||
        hitsPlayer(nx - COL_W / 2, ny + COL_OY, COL_W, COL_H, ppos) ||
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
      cand.x = sp.x; cand.y = sp.y; cand.homeX = sp.x; cand.homeY = sp.y;
      cand.dir = 1; cand.frame = 0; cand.life = 'idle'; cand.timer = rand(20, 60);
      cand.hp = cand.maxHp; cand.dead = false;
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
      n.dirty = true; n.hpDirty = true;
    }
  }

  // Resolve a player's melee swing: a hitbox in front of the attacker damages
  // every live enemy whose hurtbox it overlaps. Authoritative — the client only
  // requests the swing; HP, death, and respawn all live here.
  function handleAttack(x, y, dir, playerId) {
    const now = Date.now();
    if (now - (lastAttackAt[playerId] || 0) < ATTACK_COOLDOWN_MS) return;
    lastAttackAt[playerId] = now;
    const v = DIR_VEC[dir] || DIR_VEC[0];
    const hx = x + v[0] * ATTACK_REACH - ATTACK_HALF;
    const hy = y - 10 + v[1] * ATTACK_REACH - ATTACK_HALF;
    const hw = ATTACK_HALF * 2;
    const hh = ATTACK_HALF * 2;
    for (const n of enemies) {
      if (n.dead) continue;
      if (!aabb(hx, hy, hw, hh, n.x - HURT_W / 2, n.y + HURT_OY, HURT_W, HURT_H)) continue;
      n.hp -= ATTACK_DAMAGE;
      n.hpDirty = true;
      if (n.hp <= 0) {
        n.hp = 0;
        n.dead = true;
        n.respawnAt =
          now + (n.spawner ? n.spawner.respawnDelayMs || 9000 : STATIC_RESPAWN_MS);
      }
    }
  }

  let tickInterval = null;
  let sendInterval = null;

  return {
    /**
     * getPlayerPositions: () => [{x, y}, ...] for connected players
     * broadcast: (obj) => void — sends to every connected client
     */
    start(getPlayerPositions, broadcast) {
      tickInterval = setInterval(() => {
        const ppos = getPlayerPositions();
        const now = Date.now();
        reviveStatics(now);
        if (ppos.length === 0) return;
        updateSpawners(now, ppos);
        for (const n of actors) {
          if (n.dead) continue;
          let near = false;
          for (const p of ppos) {
            if (Math.abs(p.x - n.x) < ACTIVE_RADIUS && Math.abs(p.y - n.y) < ACTIVE_RADIUS) {
              near = true;
              break;
            }
          }
          if (near) (n.roam ? tickEnemy : tickNpc)(n, ppos);
        }
      }, 1000 / TICK_HZ);

      sendInterval = setInterval(() => {
        const moved = [];
        const hps = [];
        for (const n of actors) {
          if (n.dirty && !n.dead) {
            n.dirty = false;
            moved.push([n.id, Math.round(n.x * 2) / 2, Math.round(n.y * 2) / 2, n.dir, n.frame]);
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
        if (n.x !== n.homeX || n.y !== n.homeY || n.dir !== n.homeDir || n.frame !== 0) {
          out.push([n.id, Math.round(n.x * 2) / 2, Math.round(n.y * 2) / 2, n.dir, n.frame]);
        }
      }
      return out;
    },

    /** Every enemy's current HP (incl. hp 0 = dead/hidden), for new clients. */
    hpSnapshot() {
      return enemies.map((n) => [n.id, n.hp, n.maxHp]);
    },

    /** Resolve a player's melee swing (server-authoritative). */
    handleAttack,

    stop() {
      if (tickInterval) clearInterval(tickInterval);
      if (sendInterval) clearInterval(sendInterval);
      fs.unwatchFile(path.join(assetsDir, NPCS_FILE), reloadPlacements);
      fs.unwatchFile(OVERRIDES_PATH, reloadPlacements);
      fs.unwatchFile(COLLISION_OV_PATH, loadCollisionWithOverrides);
    },
  };
}

module.exports = { createNpcSim };
