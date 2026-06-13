import { loadJSON } from '../engine/AssetLoader';
import { getSector, getSectorForTile, getTileAt } from '../engine/MapManager';
import { loadAtlas, drawTile, drawForegroundTile, hasForegroundTile } from '../engine/TilesetManager';
import {
  TILE_SIZE,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
  MAP_WIDTH_SECTORS,
} from '../types';

// Location navigator (EDITOR_TOOLS.md "Admin Home Screen" jump-to, expanded):
// a left-side directory of the world as town → building → room, so you can jump
// straight to a place instead of hunting the stitched map by hand.
//
// EarthBound interiors have NO names in the ROM, so we make places ID-able the
// way you actually recognize them in game — by structure and storefront art:
//
//   • Buildings are the door GRAPH, not just nearby entrances. We union every
//     interior sector that a door connects to another interior sector, so a
//     shop's back room, a hotel's floors, or a cave's chambers all collapse into
//     one building. An overworld door INTO that component is its street entrance.
//   • Rooms (the interior door destinations) are nested under their building.
//   • Each building shows a thumbnail of its exterior storefront art (the sign
//     over the door), which is the real "name" — a bakery looks like a bakery.
//   • A descriptive sign inside a room still upgrades the text label when present
//     (Hot Springs, Lier's House, Dept. Store…); otherwise a type-aware ordinal.
//
// Exact coords live in each row's hover tooltip to keep labels short. Clicking a
// building flies to its storefront; clicking a room flies inside.

const MINITILE = 8;
const DOOR_GRID_COLS = 32;
const DOOR_AREA_PX = 256;

// Sector footprint in world pixels (8x4 tiles of 32px).
const SECTOR_W = SECTOR_TILES_X * TILE_SIZE; // 256
const SECTOR_H = SECTOR_TILES_Y * TILE_SIZE; // 128

// Interior door dests within this many px are the same room (no per-room bounds
// in the data, so collapse near-coincident landings — twin staircases, etc.).
const ROOM_MERGE_PX = 56;
// An NPC counts toward / can name the room whose dest it is closest to.
const ROOM_ATTACH_PX = 160;

// Named regions. Only the 6 "Town Map Image" towns are tagged per-sector in the
// ROM (sectors.json `town`); every other area (Winters, Dalaam, the desert…) is
// placed by EarthBound's PSI-teleport destination table — authentic ROM names +
// coordinates (eb_project/psi_teleport_dest_table.yml). Coords are in 8px units;
// tile = coord / 4. The 6 town anchors reuse the ROM `town` keys so they merge
// with the per-sector labels; the rest introduce new keys. Any place not inside
// a ROM town is grouped by its NEAREST anchor — a clean Voronoi outline grounded
// in real teleport centers.
interface RegionAnchor {
  key: string;
  tx: number; // tile coord
  ty: number;
}
const REGION_ANCHORS: RegionAnchor[] = [
  { key: 'onett', tx: 63, ty: 46 },
  { key: 'twoson', tx: 44, ty: 205 },
  { key: 'threed', tx: 173, ty: 281 },
  { key: 'dusty', tx: 40, ty: 312 },
  { key: 'saturn', tx: 8, ty: 243 },
  { key: 'fourside', tx: 95, ty: 126 },
  { key: 'winters', tx: 15, ty: 72 },
  { key: 'summers', tx: 138, ty: 88 },
  { key: 'dalaam', tx: 142, ty: 112 },
  { key: 'scaraba', tx: 38, ty: 131 },
  { key: 'deepdark', tx: 176, ty: 224 },
  { key: 'tenda', tx: 141, ty: 222 },
  { key: 'underworld', tx: 81, ty: 87 },
];

// Display order (rough EB story progression) + pretty labels.
const TOWN_ORDER = REGION_ANCHORS.map((a) => a.key);
const TOWN_LABEL: Record<string, string> = {
  onett: 'Onett',
  twoson: 'Twoson',
  threed: 'Threed',
  dusty: 'Dusty Dunes',
  saturn: 'Saturn Valley',
  fourside: 'Fourside',
  winters: 'Winters',
  summers: 'Summers',
  dalaam: 'Dalaam',
  scaraba: 'Scaraba',
  deepdark: 'Deep Darkness',
  tenda: 'Tenda Village',
  underworld: 'Lost Underworld',
  other: 'Other / Interiors',
};

interface RawDoor {
  x: number;
  y: number;
  type: string;
  destX?: number;
  destY?: number;
}

interface RawNPC {
  x: number;
  y: number;
  kind: string; // 'person' | 'prop' | 'enemy' | ...
  t?: number; // text pointer into npc_text.json
}

interface LocNode {
  label: string;
  title: string; // hover tooltip (exact coords)
  x: number;
  y: number;
  kind: 'town' | 'building' | 'room';
  thumb?: { x: number; y: number }; // storefront art anchor (building entrance px)
  children?: LocNode[];
}

interface Room {
  dx: number;
  dy: number;
  kind: 'indoor' | 'dungeon' | 'plain';
  people: number;
  place?: string; // derived from a sign in the room, if any
}

interface Building {
  town: string;
  ex: number; // street entrance (storefront) px
  ey: number;
  rooms: Room[];
}

// ── place-name extraction ────────────────────────────────────────────────────
// EB signs are the only in-world text naming interiors; best-effort over a few
// landmark placards. Everything else falls back to a type+ordinal label.
function placeFromSign(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ').trim();
  const owner = t.match(/([A-Z][\w.]*?)['’]s (?:house|home)/);
  if (owner) return `${owner[1]}'s House`;
  if (/hot\s*spring/i.test(t)) return 'Hot Springs';
  if (/department/i.test(t)) return 'Dept. Store';
  if (/drugstore|drug store/i.test(t)) return 'Drugstore';
  if (/\bmarket\b/i.test(t)) return 'Market';
  if (/pyramid/i.test(t)) return 'Pyramid';
  const word = t.match(/\b(hospital|hotel|bakery|arcade|restaurant|library|museum|bank|theater|zoo|gym)\b/i);
  if (word) return word[1][0].toUpperCase() + word[1].slice(1).toLowerCase();
  return undefined;
}

// ── sector helpers ───────────────────────────────────────────────────────────
function sectorAtPx(px: number, py: number) {
  return getSectorForTile(Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE));
}
function isInteriorPx(px: number, py: number): boolean {
  const s = sectorAtPx(px, py);
  return !!s && !!(s.indoor || s.dungeon);
}
function roomKindPx(px: number, py: number): Room['kind'] {
  const s = sectorAtPx(px, py);
  if (s?.indoor) return 'indoor';
  if (s?.dungeon) return 'dungeon';
  return 'plain';
}
function sectorIndexPx(px: number, py: number): number {
  return Math.floor(py / SECTOR_H) * MAP_WIDTH_SECTORS + Math.floor(px / SECTOR_W);
}
/**
 * Region a world point belongs to: the ROM `town` label when present (the 6
 * Town Map Image towns, authoritative), otherwise the nearest PSI-teleport
 * anchor. Door-stitched regions are spatially separated, so nearest-anchor is a
 * reliable partition for everything the ROM doesn't tag.
 */
function regionAt(px: number, py: number): string {
  const s = sectorAtPx(px, py);
  if (s?.town) return s.town;
  const tx = Math.floor(px / TILE_SIZE);
  const ty = Math.floor(py / TILE_SIZE);
  let best = 'other';
  let bd = Infinity;
  for (const a of REGION_ANCHORS) {
    const d = (tx - a.tx) ** 2 + (ty - a.ty) ** 2;
    if (d < bd) {
      bd = d;
      best = a.key;
    }
  }
  return best;
}
function roomNoun(kind: Room['kind']): string {
  return kind === 'dungeon' ? 'Dungeon' : kind === 'plain' ? 'Area' : 'Room';
}
function peopleChip(n: number): string {
  return n > 0 ? ` ·${n}\u{1F465}` : '';
}

// ── union-find over interior sector indices ──────────────────────────────────
class DSU {
  private parent = new Map<number, number>();
  find(a: number): number {
    let root = a;
    let p = this.parent.get(root);
    while (p !== undefined && p !== root) {
      root = p;
      p = this.parent.get(root);
    }
    // Path-compress.
    let cur = a;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    this.parent.set(root, root);
    return root;
  }
  union(a: number, b: number): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

interface DoorRec {
  ex: number;
  ey: number;
  dx: number;
  dy: number;
  entInt: boolean;
  dstInt: boolean;
}

/** Build the town → building → room tree from door connectivity. */
async function buildTree(): Promise<LocNode[]> {
  const areas = await loadJSON<RawDoor[][]>('/assets/map/doors.json');

  // 1. Flatten doors to world-pixel edges, tagging interior endpoints.
  const doors: DoorRec[] = [];
  areas.forEach((area, idx) => {
    if (!area) return;
    const originX = (idx % DOOR_GRID_COLS) * DOOR_AREA_PX;
    const originY = Math.floor(idx / DOOR_GRID_COLS) * DOOR_AREA_PX;
    for (const d of area) {
      if (d.type !== 'door' || d.destX == null || d.destY == null) continue;
      const ex = originX + d.x * MINITILE;
      const ey = originY + d.y * MINITILE;
      const dx = d.destX * MINITILE;
      const dy = d.destY * MINITILE;
      doors.push({ ex, ey, dx, dy, entInt: isInteriorPx(ex, ey), dstInt: isInteriorPx(dx, dy) });
    }
  });

  // 2. Union interior sectors linked by an interior↔interior door.
  const dsu = new DSU();
  for (const d of doors) {
    if (d.entInt && d.dstInt) dsu.union(sectorIndexPx(d.ex, d.ey), sectorIndexPx(d.dx, d.dy));
  }

  // 3. Seed buildings from any door bridging overworld↔interior — the storefront
  //    is whichever side sits on the overworld. EB records some doors only as the
  //    outside mat pointing in, others only as the inside mat pointing out, so we
  //    accept both directions to avoid losing a building's street entrance.
  const byComp = new Map<number, Building>();
  const seedEntrance = (compPx: [number, number], streetX: number, streetY: number) => {
    const root = dsu.find(sectorIndexPx(compPx[0], compPx[1]));
    let b = byComp.get(root);
    const town = regionAt(streetX, streetY);
    if (!b) byComp.set(root, (b = { town, ex: streetX, ey: streetY, rooms: [] }));
    // Prefer the topmost-left entrance as the canonical storefront.
    if (streetY < b.ey || (streetY === b.ey && streetX < b.ex)) {
      b.ex = streetX;
      b.ey = streetY;
      b.town = regionAt(streetX, streetY);
    }
  };
  for (const d of doors) {
    if (!d.entInt && d.dstInt) seedEntrance([d.dx, d.dy], d.ex, d.ey); // outside → in
    else if (d.entInt && !d.dstInt) seedEntrance([d.ex, d.ey], d.dx, d.dy); // inside → out
  }

  // 4. Attach interior door-destinations as rooms of their component, merging
  //    near-coincident landings. Components with no street entrance (unreachable
  //    interiors) are bucketed under "other" at their own location.
  const allRooms: Room[] = [];
  for (const d of doors) {
    if (!d.dstInt) continue;
    const root = dsu.find(sectorIndexPx(d.dx, d.dy));
    let b = byComp.get(root);
    // Orphan interiors (no overworld door) still join their nearest region
    // rather than a catch-all bucket.
    if (!b) byComp.set(root, (b = { town: regionAt(d.dx, d.dy), ex: d.dx, ey: d.dy, rooms: [] }));
    if (b.rooms.some((r) => Math.abs(r.dx - d.dx) <= ROOM_MERGE_PX && Math.abs(r.dy - d.dy) <= ROOM_MERGE_PX)) continue;
    const room: Room = { dx: d.dx, dy: d.dy, kind: roomKindPx(d.dx, d.dy), people: 0 };
    b.rooms.push(room);
    allRooms.push(room);
  }

  await attachNPCs(allRooms);

  // 5. Group buildings by town and emit nodes.
  const byTown = new Map<string, Building[]>();
  for (const b of byComp.values()) {
    let list = byTown.get(b.town);
    if (!list) byTown.set(b.town, (list = []));
    list.push(b);
  }

  const order = (t: string) => {
    const i = TOWN_ORDER.indexOf(t);
    return i === -1 ? TOWN_ORDER.length + (t === 'other' ? 1 : 0) : i;
  };

  return [...byTown.keys()]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((town) => {
      const buildings = byTown.get(town)!.sort((a, b) => a.ey - b.ey || a.ex - b.ex);
      const townLabel = TOWN_LABEL[town] ?? town;
      const cx = Math.round(buildings.reduce((s, b) => s + b.ex, 0) / buildings.length);
      const cy = Math.round(buildings.reduce((s, b) => s + b.ey, 0) / buildings.length);
      return {
        label: `${townLabel} (${buildings.length})`,
        title: `${buildings.length} buildings`,
        x: cx,
        y: cy,
        kind: 'town' as const,
        children: buildings.map((b, i) => buildingNode(townLabel, b, i + 1)),
      };
    });
}

function buildingNode(townLabel: string, b: Building, ordinal: number): LocNode {
  const rooms = b.rooms.sort((a, c) => a.dy - c.dy || a.dx - c.dx);
  const named = rooms.find((r) => r.place); // building inherits its landmark room's name
  const people = rooms.reduce((s, r) => s + r.people, 0);
  const name = named?.place ?? `${townLabel} Bldg ${ordinal}`;

  const counters: Record<string, number> = {};
  return {
    label: `${name}${peopleChip(people)}`,
    title: `entrance (${b.ex},${b.ey}) · ${rooms.length} room${rooms.length === 1 ? '' : 's'}`,
    x: b.ex,
    y: b.ey,
    kind: 'building',
    thumb: { x: b.ex, y: b.ey },
    children: rooms.map((r) => {
      const noun = roomNoun(r.kind);
      const ord = (counters[noun] = (counters[noun] ?? 0) + 1);
      const label = r.place ?? `${noun} ${ord}`;
      return {
        label: `${label}${peopleChip(r.people)}`,
        title: `dest (${r.dx},${r.dy})`,
        x: r.dx,
        y: r.dy,
        kind: 'room' as const,
      };
    }),
  };
}

/**
 * Assign each NPC to the room (door dest) it sits closest to, within
 * ROOM_ATTACH_PX. Bumps that room's occupant count and, when the NPC is a sign
 * with recognizable text, names the room. Best-effort: no room bounds exist, so
 * nearest-dest is the cleanest partition available.
 */
async function attachNPCs(rooms: Room[]): Promise<void> {
  if (rooms.length === 0) return;
  let npcs: RawNPC[];
  let text: Record<string, string[]>;
  try {
    [npcs, text] = await Promise.all([
      loadJSON<RawNPC[]>('/assets/map/npcs.json'),
      loadJSON<Record<string, string[]>>('/assets/map/npc_text.json'),
    ]);
  } catch {
    return; // naming gracefully degrades to type+ordinal labels
  }

  for (const n of npcs) {
    if (!n) continue;
    let best: Room | null = null;
    let bd = ROOM_ATTACH_PX;
    for (const r of rooms) {
      const d = Math.abs(r.dx - n.x) + Math.abs(r.dy - n.y);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    if (!best) continue;
    if (n.kind === 'person' || n.kind === 'enemy') best.people++;
    const sign = n.t != null ? text[String(n.t)]?.[0] : undefined;
    if (sign && !best.place) {
      const place = placeFromSign(sign);
      if (place) best.place = place;
    }
  }
}

// ── storefront thumbnail ─────────────────────────────────────────────────────
const THUMB_COLS = 5; // tiles wide
const THUMB_ROWS = 4; // tiles tall
const thumbCache = new Map<string, string>(); // entrance key → data URL

/**
 * Render the overworld art around a building's street entrance (the storefront
 * sign sits just above the door) to a small data URL. This is the building's
 * real "name": you read it by sight. Returns null if the art can't be drawn.
 */
async function storefrontThumb(entranceX: number, entranceY: number): Promise<string | null> {
  const key = `${entranceX},${entranceY}`;
  const cached = thumbCache.get(key);
  if (cached) return cached;

  const etx = Math.floor(entranceX / TILE_SIZE);
  const ety = Math.floor(entranceY / TILE_SIZE);
  const ox = etx - Math.floor(THUMB_COLS / 2);
  const oy = ety - THUMB_ROWS + 1; // door at the bottom row, sign above

  // Load every atlas the crop touches before drawing (drawTile no-ops without it).
  const need = new Map<string, { ts: number; pal: number }>();
  for (let ty = oy; ty < oy + THUMB_ROWS; ty++) {
    for (let tx = ox; tx < ox + THUMB_COLS; tx++) {
      const s = getSector(Math.floor(tx / SECTOR_TILES_X), Math.floor(ty / SECTOR_TILES_Y));
      if (s) need.set(`${s.tilesetId}_${s.paletteId}`, { ts: s.tilesetId, pal: s.paletteId });
    }
  }
  await Promise.all([...need.values()].map((a) => loadAtlas(a.ts, a.pal)));

  const canvas = document.createElement('canvas');
  canvas.width = THUMB_COLS * TILE_SIZE;
  canvas.height = THUMB_ROWS * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  for (let ty = oy; ty < oy + THUMB_ROWS; ty++) {
    for (let tx = ox; tx < ox + THUMB_COLS; tx++) {
      const s = getSector(Math.floor(tx / SECTOR_TILES_X), Math.floor(ty / SECTOR_TILES_Y));
      if (!s) continue;
      const arr = getTileAt(tx, ty);
      drawTile(ctx, s.tilesetId, s.paletteId, arr, (tx - ox) * TILE_SIZE, (ty - oy) * TILE_SIZE);
    }
  }
  // Foreground pass (some signs/awnings live in the FG layer).
  for (let ty = oy; ty < oy + THUMB_ROWS; ty++) {
    for (let tx = ox; tx < ox + THUMB_COLS; tx++) {
      const s = getSector(Math.floor(tx / SECTOR_TILES_X), Math.floor(ty / SECTOR_TILES_Y));
      if (!s || !hasForegroundTile(s.tilesetId, s.paletteId)) continue;
      drawForegroundTile(ctx, s.tilesetId, s.paletteId, getTileAt(tx, ty), (tx - ox) * TILE_SIZE, (ty - oy) * TILE_SIZE);
    }
  }

  const url = canvas.toDataURL();
  thumbCache.set(key, url);
  return url;
}

export class LocationNav {
  private panel: HTMLDivElement | null = null;
  private visible = true;
  // Lazily render storefront thumbnails only when their row scrolls into view.
  private thumbObserver: IntersectionObserver | null = null;

  constructor(
    private readonly goTo: (x: number, y: number) => void,
    /** Town key the player is currently in, to auto-expand it. */
    private readonly currentTown: () => string,
  ) {}

  async mount(): Promise<void> {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;top:30px;left:0;bottom:0;width:230px;z-index:90;overflow:auto;' +
      'background:#101418f2;color:#cde;font:11px monospace;border-right:2px solid #e8a33d;' +
      'padding:6px 4px;user-select:none;';

    const head = document.createElement('div');
    head.textContent = '📍 PLACES';
    head.style.cssText = 'color:#e8a33d;font-weight:bold;letter-spacing:1px;padding:2px 6px 6px;';
    this.panel.appendChild(head);

    const body = document.createElement('div');
    this.panel.appendChild(body);
    document.body.appendChild(this.panel);

    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target as HTMLImageElement;
          this.thumbObserver!.unobserve(img);
          void this.fillThumb(img);
        }
      },
      { root: this.panel, rootMargin: '120px' },
    );

    try {
      const tree = await buildTree();
      const here = this.currentTown();
      for (const town of tree) {
        // Auto-expand the town the player is standing in.
        const expand = town.label.toLowerCase().startsWith((TOWN_LABEL[here] ?? '').toLowerCase()) && here !== 'other';
        body.appendChild(this.renderNode(town, 0, expand));
      }
      if (tree.length === 0) body.textContent = 'No doors found.';
    } catch {
      body.textContent = 'Failed to load locations.';
    }
  }

  private async fillThumb(img: HTMLImageElement): Promise<void> {
    const x = Number(img.dataset.tx);
    const y = Number(img.dataset.ty);
    try {
      const url = await storefrontThumb(x, y);
      if (url) img.src = url;
      else img.style.visibility = 'hidden';
    } catch {
      img.style.visibility = 'hidden';
    }
  }

  private renderNode(node: LocNode, depth: number, expanded: boolean): HTMLDivElement {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.title = node.title;
    row.style.cssText =
      `display:flex;align-items:center;gap:3px;padding:2px 4px;cursor:pointer;border-radius:3px;` +
      `margin-left:${depth * 10}px;`;
    row.onmouseenter = () => (row.style.background = '#1d2530');
    row.onmouseleave = () => (row.style.background = '');

    const hasKids = !!node.children && node.children.length > 0;
    const caret = document.createElement('span');
    caret.textContent = hasKids ? (expanded ? '▾' : '▸') : '·';
    caret.style.cssText = `width:10px;flex:none;color:${hasKids ? '#e8a33d' : '#456'};`;
    row.appendChild(caret);

    // Storefront thumbnail (buildings only) — rendered lazily on scroll-in.
    if (node.thumb) {
      const img = document.createElement('img');
      img.dataset.tx = String(node.thumb.x);
      img.dataset.ty = String(node.thumb.y);
      img.style.cssText =
        'width:40px;height:32px;flex:none;object-fit:cover;image-rendering:pixelated;' +
        'border:1px solid #2a3340;border-radius:2px;background:#0a0d10;';
      row.appendChild(img);
      this.thumbObserver?.observe(img);
    }

    const label = document.createElement('span');
    label.textContent = node.label;
    label.style.cssText =
      `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `color:${node.kind === 'town' ? '#cde' : node.kind === 'building' ? '#cfe3d2' : '#8aa'};`;
    row.appendChild(label);

    let kids: HTMLDivElement | null = null;
    if (hasKids) {
      kids = document.createElement('div');
      kids.style.display = expanded ? 'block' : 'none';
      for (const c of node.children!) kids.appendChild(this.renderNode(c, depth + 1, false));
    }

    // Caret toggles expand; clicking the label/thumb flies to the node's coord.
    caret.onclick = (e) => {
      e.stopPropagation();
      if (!kids) return;
      const open = kids.style.display === 'none';
      kids.style.display = open ? 'block' : 'none';
      caret.textContent = open ? '▾' : '▸';
    };
    label.onclick = () => this.goTo(node.x, node.y);

    wrap.appendChild(row);
    if (kids) wrap.appendChild(kids);
    return wrap;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.panel) this.panel.style.display = this.visible ? 'block' : 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.panel?.remove();
    this.panel = null;
  }
}
