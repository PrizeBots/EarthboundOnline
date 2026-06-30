'use strict';
// World subsystem (map tiles, sectors, collision, doors, stairs), extracted from
// npcSim.js (Phase 2 modularization). Owns all the ROM-derived map state + the
// editor-override / custom-room-band logic, plus the fs.watchFile reload hooks
// for collision and doors. createWorld returns null when the core map data is
// absent (code-only deploy before the data disk is attached) so npcSim can fall
// back to a RELAY-ONLY sim. KEEP IN SYNC with the client: MapManager
// (buildCustomRoomBand), Collision.ts, DoorManager.ts.
const fs = require('fs');
const path = require('path');
const { hyp } = require('./combatMath');

// deps carries the map constants (mirrors src/types.ts) + the collision-box
// vertical offset COL_OY, all owned by npcSim so there's a single source.
function createWorld(assetsDir, deps) {
  const { MINITILE, TILE, MAP_W_TILES, MAP_W_SECTORS, SEC_TX, SEC_TY, COL_OY } = deps;
  const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(assetsDir, rel), 'utf8'));

  // Core world data (ROM-derived). Absent on a code-only deploy → return null so
  // npcSim runs RELAY-ONLY (join/move/chat, no NPC/collision sim).
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
    return null;
  }
  // The ROM overworld is the base; the Room Manager's custom rooms are stamped
  // into a BAND below it (bandY >= base height) — exactly like the client's
  // MapManager.buildCustomRoomBand. The server MUST mirror this or every enemy/
  // NPC placed in a custom room sits below the server's world, reads as
  // out-of-bounds solid (blocked), and freezes. KEEP IN SYNC with MapManager.
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
  const MAP_TILES_OV_PATH = path.join(assetsDir, '..', 'overrides', 'map_tiles.json');
  // Re-stamp the custom-room band over a fresh copy of the ROM base (idempotent).
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
  // from its source minitile's own tileset collision (mirrors Collision.ts).
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
  // Per-map-tile collision overrides (overrides/collision.json `cells`).
  const cellOv = new Map();
  // Collision = extracted base + editor overrides. KEEP IN SYNC with Collision.ts.
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
        } else if (arr === 0 && ty >= baseHTiles) {
          // Custom-room band: arrangement 0 is our "empty/unpainted cell"
          // sentinel. The ROM marks arrangement 0 (the solid black map-edge
          // border) fully solid, but in the band that's empty room space — so
          // it's walkable empty, NOT a wall. (Per-cell overrides still win.)
          // KEEP IN SYNC with Collision.ts effectiveRow.
          byte = 0;
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
  // positions. Melee can't reach through walls. Endpoints are skipped.
  function wallBetween(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = hyp(dx, dy);
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
  const DOOR_GRID_COLS = 32;
  const DOOR_AREA_PX = 256;
  const DOORS_FILE = 'map/doors.json';
  const DOORS_OV_PATH = path.join(assetsDir, '..', 'overrides', 'doors.json');
  // getDoorAt tests the player's MIDSECTION (feet - 12) against the anchor.
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
  // EB doors carry an event-flag condition (mirror of DoorManager.isDoorActive).
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
        // Escalator/stairway trigger (incl. NOWHERE far-landing): record its center.
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
        // style=0 short-range zone doors warp onto themselves unless an override links them.
        const zone =
          (d.style || 0) === 0 &&
          Math.abs(destPx - (baseX - MINITILE)) + Math.abs(destPy - (baseY - 4)) < 128;
        const o = edits[`${baseX},${baseY}`];
        if (o === null) continue; // override-disabled door
        if (zone && !o) continue; // zone door with no authored link
        const wx = o && o.worldX != null ? o.worldX : baseX;
        const wy = o && o.worldY != null ? o.worldY : baseY;
        // Keep the DESTINATION too (override wins, mirroring DoorManager).
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

  // Nearest door trigger to (x,y) within DOOR_MATCH_RADIUS, or null.
  const DOOR_MATCH_RADIUS = 28;
  function resolveDoor(x, y) {
    let best = null;
    let bestD = DOOR_MATCH_RADIUS;
    for (const t of doorTriggers) {
      const d = hyp(t.x - x, t.y - y);
      if (d <= bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // True if a DOORWAY sits between (x0,y0) and (x1,y1) — combat treats it like a wall.
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

  // True if (x,y) sits in an interior (indoor/dungeon) sector.
  function sectorIndoorAt(x, y) {
    const s = sectorForTile(Math.floor(x / TILE), Math.floor(y / TILE));
    return !!(s && s.indoor);
  }

  // Pick the door an enemy `n` should walk out of to head home.
  function exitDoorToward(n) {
    const homeD = hyp(n.x - n.homeX, n.y - n.homeY);
    let best = null;
    let bestScore = Infinity;
    for (const t of doorTriggers) {
      if (t.destX == null) continue;
      const destHomeD = hyp(t.destX - n.homeX, t.destY - n.homeY);
      if (destHomeD >= homeD) continue; // doesn't take us nearer home — skip
      const indoorDest = sectorIndoorAt(t.destX, t.destY) ? 1 : 0;
      // Outdoor-landing doors first; then the nearest doorway we can walk to.
      const score = indoorDest * 1e6 + hyp(n.x - t.x, n.y - t.y);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  return {
    // collision / geometry
    blocked,
    wallBetween,
    sectorForTile,
    sectorIndoorAt,
    // doors / stairs
    resolveDoor,
    doorBetween,
    exitDoorToward,
    // live-state getters (these arrays/values are reassigned on reload)
    doorTriggers: () => doorTriggers,
    stairTriggers: () => stairTriggers,
    mapHTiles: () => mapHTiles,
    // reload hook (npcs.json / rooms reload re-stamps the room band). npcSim
    // owns the rooms + map-tiles WATCH (its handler also reloads placements), so
    // we expose the paths it needs to watch/unwatch.
    reloadRooms: buildRoomBand,
    roomsOvPath: ROOMS_OV_PATH,
    mapTilesOvPath: MAP_TILES_OV_PATH,
    // Tear down the watchers world owns (collision + doors). The caller's stop()
    // calls this; the rooms/map-tiles watchers belong to npcSim.
    stop() {
      fs.unwatchFile(COLLISION_OV_PATH, loadCollisionWithOverrides);
      fs.unwatchFile(path.join(assetsDir, DOORS_FILE), loadDoorTriggers);
      fs.unwatchFile(DOORS_OV_PATH, loadDoorTriggers);
    },
  };
}

module.exports = { createWorld };
