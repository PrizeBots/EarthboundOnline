// Dev-only planner (NOT shipped): finds walkable Onett street points for shark
// spawners by replicating server/npcSim.js collision + a flood fill from the
// arcade. Prints a verified spawn point, the reachable street bbox, and a set
// of well-spread spawner anchors. Pure analysis — writes nothing.
import fs from 'fs';
import path from 'path';

const A = 'public/assets';
const J = (p) => JSON.parse(fs.readFileSync(path.join(A, p), 'utf8'));

const MINITILE = 8, TILE = 32, MAP_W_TILES = 256, MAP_H_TILES = 320;
const MAP_W_SECTORS = 32, SEC_TX = 8, SEC_TY = 4;
const COL_W = 14, COL_H = 8, COL_OY = -8;

const sectors = J('map/sectors.json');
const tiles = J('map/tiles.json');
const tilesetMapping = J('map/tileset_mapping.json');
const cols = new Map();
for (const ts of new Set(tilesetMapping)) {
  try { cols.set(ts, J(`tilesets/${ts}/collisions.json`)); } catch {}
}
const sectorForTile = (tx, ty) => {
  const sx = Math.floor(tx / SEC_TX), sy = Math.floor(ty / SEC_TY);
  if (sx < 0 || sx >= MAP_W_SECTORS) return null;
  return sectors[sy * MAP_W_SECTORS + sx] || null;
};
function blocked(x, y, w, h) {
  if (x < 0 || y < 0) return true;
  if (x + w >= MAP_W_TILES * TILE || y + h >= MAP_H_TILES * TILE) return true;
  const x0 = Math.floor(x / MINITILE), y0 = Math.floor(y / MINITILE);
  const x1 = Math.floor((x + w - 1) / MINITILE), y1 = Math.floor((y + h - 1) / MINITILE);
  for (let my = y0; my <= y1; my++) for (let mx = x0; mx <= x1; mx++) {
    const tx = Math.floor(mx / 4), ty = Math.floor(my / 4);
    const sec = sectorForTile(tx, ty);
    if (!sec) return true;
    const c = cols.get(tilesetMapping[sec.tilesetId] ?? 0);
    if (!c) return true;
    const arr = tiles[ty * MAP_W_TILES + tx] ?? 0;
    if (arr >= c.length) continue;
    if ((c[arr][(my % 4) * 4 + (mx % 4)] & 0x80) !== 0) return true;
  }
  return false;
}
// Walkable for an NPC standing with feet at (x,y): its foot box is clear AND
// it's an outdoor Onett street tile (no roofs/interiors/other towns).
function walkable(x, y) {
  if (blocked(x - COL_W / 2, y + COL_OY, COL_W, COL_H)) return false;
  const sec = sectorForTile(Math.floor(x / TILE), Math.floor(y / TILE));
  return !!sec && sec.town === 'onett' && !sec.indoor && !sec.dungeon;
}

// --- Flood fill the reachable street network from the PLAYER SPAWN (16px) ---
const spawn = { x: 1488, y: 1176 }; // public/overrides/spawn.json (canonical Onett street)
console.log(`player spawn (${spawn.x},${spawn.y}) walkable: ${walkable(spawn.x, spawn.y)}`);
const STEP = 16;
const key = (gx, gy) => gx + ',' + gy;
const start = { gx: Math.round(spawn.x / STEP), gy: Math.round(spawn.y / STEP) };
const seen = new Set([key(start.gx, start.gy)]);
const reach = [];
const q = [start];
while (q.length) {
  const { gx, gy } = q.pop();
  const x = gx * STEP, y = gy * STEP;
  if (!walkable(x, y)) continue;
  reach.push({ x, y });
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const k = key(gx + dx, gy + dy);
    if (!seen.has(k)) { seen.add(k); q.push({ gx: gx + dx, gy: gy + dy }); }
  }
}
const xs = reach.map((p) => p.x), ys = reach.map((p) => p.y);
const bbox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
console.log(`reachable street cells: ${reach.length}`);
console.log(`street bbox: x ${bbox.minX}..${bbox.maxX}  y ${bbox.minY}..${bbox.maxY}`);

// Is the old arcade pocket (1584,1680) part of the main street network?
const arcadeInMain = seen.has(key(Math.round(1584 / STEP), Math.round(1680 / STEP)));
console.log(`old arcade (1584,1680) connected to main streets: ${arcadeInMain}`);
// Closest main-street cell to the old arcade location = its street frontage.
let frontage = null, fd = Infinity;
for (const p of reach) {
  const d = Math.hypot(p.x - 1584, p.y - 1680);
  if (d < fd) { fd = d; frontage = p; }
}
console.log(`nearest main-street cell to old arcade: ${JSON.stringify(frontage)} (dist ${Math.round(fd)})`);

// --- Final spawner anchors ---
// Primary = the arcade's STREET FRONTAGE (sharks spill from the game building
// onto the road). Then greedy farthest-point sampling for town-wide coverage,
// excluding the player-spawn neighborhood so players don't appear inside a mob.
const SPAWN_CLEAR = 200; // keep spawners this far from the player spawn
const MIN_SEP = 480;
const cands = reach.filter((p) => Math.hypot(p.x - spawn.x, p.y - spawn.y) >= SPAWN_CLEAR);
const anchors = [frontage];
for (let n = 0; n < 6; n++) {
  let best = null, bestD = -1;
  for (const p of cands) {
    let d = Infinity;
    for (const a of anchors) d = Math.min(d, Math.hypot(p.x - a.x, p.y - a.y));
    if (d > bestD) { bestD = d; best = p; }
  }
  if (best && bestD >= MIN_SEP) anchors.push(best);
}
console.log('\nFINAL spawner anchors (first = arcade frontage):');
for (const a of anchors) {
  const sec = sectorForTile(Math.floor(a.x / TILE), Math.floor(a.y / TILE));
  const far = Math.round(Math.max(...reach.map((p) => Math.hypot(p.x - a.x, p.y - a.y))));
  console.log(`  { x: ${a.x}, y: ${a.y} }  farthest reachable street: ${far}px`);
}

// --- Verify roamers actually disperse from the arcade frontage onto streets ---
// Replays npcSim.js tickEnemy (cardinal random walk, bounded by collision and
// wanderRadius) for the arcade spawner; reports spread + any off-street steps.
const ENEMY_SPEED = 0.7, LEASH_DUMMY = 0;
const C2 = { dir: 0 }; // unused
function simRoamer(home, wr, ticks) {
  const CARD = [[0,1],[0,-1],[-1,0],[1,0]];
  let x = home.x, y = home.y, life = 'idle', timer = 30, wdx = 0, wdy = 0;
  let maxDist = 0, offStreet = 0;
  for (let t = 0; t < ticks; t++) {
    if (life === 'walk') {
      const nx = x + wdx * ENEMY_SPEED, ny = y + wdy * ENEMY_SPEED;
      const stop = blocked(nx - COL_W/2, ny + COL_OY, COL_W, COL_H) ||
                   Math.hypot(nx - home.x, ny - home.y) > wr;
      if (!stop) { x = nx; y = ny; }
      if (stop || --timer <= 0) { life = 'idle'; timer = 30 + (t % 60); }
    } else if (--timer <= 0) {
      const c = CARD[t % 4]; wdx = c[0]; wdy = c[1]; life = 'walk'; timer = 30 + (t % 80);
    }
    maxDist = Math.max(maxDist, Math.hypot(x - home.x, y - home.y));
    const sec = sectorForTile(Math.floor(x / TILE), Math.floor(y / TILE));
    if (!sec || sec.indoor || sec.town !== 'onett') offStreet++;
  }
  return { maxDist: Math.round(maxDist), offStreet, end: { x: Math.round(x), y: Math.round(y) } };
}
console.log('\nArcade roamer dispersal sim (frontage 1648,1696, radius 1400):');
for (let i = 0; i < 5; i++) {
  const r = simRoamer({ x: 1648, y: 1696 }, 1400, 8000);
  console.log(`  roamer ${i}: wandered up to ${r.maxDist}px from arcade, ended at (${r.end.x},${r.end.y}), off-street steps: ${r.offStreet}`);
}
