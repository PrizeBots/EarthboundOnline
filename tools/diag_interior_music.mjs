// Diagnostic: what song resolves inside each Onett interior room?
// Reconstructs the door-graph buildings/rooms the way LocationNav does, then
// resolves each room's world point against the music areas (overrides/music.json)
// with the sector musicId as fallback — mirroring MusicManager.areaForPoint.
// Run: node tools/diag_interior_music.mjs [region]
import { readFileSync } from 'node:fs';
const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));

const sectors = J('../public/assets/map/sectors.json');
const doorsAreas = J('../public/assets/map/doors.json');
const areas = J('../public/overrides/music.json').areas ?? [];
const musicMap = J('../public/assets/music/music_map.json');
const songNames = J('../src/data/songNames.json');

const MINITILE = 8,
  TILE = 32,
  SECTOR_W = 256,
  SECTOR_H = 128,
  COLS = 32;
const DOOR_GRID_COLS = 32,
  DOOR_AREA_PX = 256;
const ANCHORS = [
  ['onett', 63, 46],
  ['twoson', 44, 205],
  ['threed', 173, 281],
  ['dusty', 40, 312],
  ['saturn', 8, 243],
  ['fourside', 95, 126],
  ['winters', 15, 72],
  ['summers', 138, 88],
  ['dalaam', 142, 112],
  ['scaraba', 38, 131],
  ['deepdark', 176, 224],
  ['tenda', 141, 222],
  ['underworld', 81, 87],
];
const wantRegion = process.argv[2] || 'onett';

const sectorAtPx = (px, py) =>
  sectors[Math.floor(py / SECTOR_H) * COLS + Math.floor(px / SECTOR_W)];
const isInt = (px, py) => {
  const s = sectorAtPx(px, py);
  return !!s && (!!s.indoor || !!s.dungeon);
};
const sIdx = (px, py) => Math.floor(py / SECTOR_H) * COLS + Math.floor(px / SECTOR_W);
function regionAt(px, py) {
  const s = sectorAtPx(px, py);
  if (s?.town) return s.town;
  const tx = Math.floor(px / TILE),
    ty = Math.floor(py / TILE);
  let best = 'other',
    bd = Infinity;
  for (const [k, ax, ay] of ANCHORS) {
    const d = (tx - ax) ** 2 + (ty - ay) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}
const songName = (n) => (songNames[String(n)] ? `"${songNames[String(n)]}"` : '(unnamed)');

// Resolve song at a resting point: topmost area containing it, else sector musicId.
function resolve(px, py) {
  for (let i = areas.length - 1; i >= 0; i--) {
    const a = areas[i];
    if (px >= a.x && px < a.x + a.w && py >= a.y && py < a.y + a.h)
      return { song: a.song, src: `area "${a.name}"` };
  }
  const s = sectorAtPx(px, py);
  const mid = s ? s.musicId : -1;
  const song = musicMap[String(mid)] ?? 0;
  return { song, src: `sector musicId=${mid}${song === 0 ? ' (no mapping → silence)' : ''}` };
}

// DSU over interior sector indices.
const parent = new Map();
const find = (a) => {
  let r = a;
  while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
  parent.set(a, r);
  return r;
};
const union = (a, b) => parent.set(find(a), find(b));

const doors = [];
doorsAreas.forEach((area, idx) => {
  if (!area) return;
  const ox = (idx % DOOR_GRID_COLS) * DOOR_AREA_PX,
    oy = Math.floor(idx / DOOR_GRID_COLS) * DOOR_AREA_PX;
  for (const d of area) {
    if (d.type !== 'door' || d.destX == null || d.destY == null) continue;
    const ex = ox + d.x * MINITILE,
      ey = oy + d.y * MINITILE;
    const dx = d.destX * MINITILE,
      dy = d.destY * MINITILE;
    doors.push({ ex, ey, dx, dy, entInt: isInt(ex, ey), dstInt: isInt(dx, dy) });
  }
});
for (const d of doors) if (d.entInt && d.dstInt) union(sIdx(d.ex, d.ey), sIdx(d.dx, d.dy));

const byComp = new Map();
const seed = (cx, cy, sx, sy) => {
  const root = find(sIdx(cx, cy));
  let b = byComp.get(root);
  if (!b) byComp.set(root, (b = { town: regionAt(sx, sy), ex: sx, ey: sy, rooms: [] }));
  if (sy < b.ey || (sy === b.ey && sx < b.ex)) {
    b.ex = sx;
    b.ey = sy;
    b.town = regionAt(sx, sy);
  }
};
for (const d of doors) {
  if (!d.entInt && d.dstInt) seed(d.dx, d.dy, d.ex, d.ey);
  else if (d.entInt && !d.dstInt) seed(d.ex, d.ey, d.dx, d.dy);
}
for (const d of doors) {
  if (!d.dstInt) continue;
  const root = find(sIdx(d.dx, d.dy));
  let b = byComp.get(root);
  if (!b) byComp.set(root, (b = { town: regionAt(d.dx, d.dy), ex: d.dx, ey: d.dy, rooms: [] }));
  if (b.rooms.some((r) => Math.abs(r.dx - d.dx) <= 56 && Math.abs(r.dy - d.dy) <= 56)) continue;
  b.rooms.push({ dx: d.dx, dy: d.dy });
}

const blds = [...byComp.values()].filter((b) => b.town === wantRegion && b.rooms.length);
blds.sort((a, b) => a.ey - b.ey || a.ex - b.ex);
console.log(`\n${wantRegion}: ${blds.length} interior buildings\n`);
for (const b of blds) {
  console.log(`Building @ street (${b.ex},${b.ey})  [${b.rooms.length} room(s)]`);
  for (const r of b.rooms) {
    const { song, src } = resolve(r.dx, r.dy);
    console.log(`   room (${r.dx},${r.dy}) → song ${song} ${songName(song)}  via ${src}`);
  }
}
