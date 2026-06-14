import { loadJSON, primeJSONCache } from '../engine/AssetLoader';
import { getSector, getSectorForTile, getTileAt } from '../engine/MapManager';
import { listRooms, RoomDef } from '../engine/Rooms';
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
  // Stable identity for the editable-outline overrides (hide / move / add). For
  // derived nodes this is a coord-based key (the derivation is deterministic);
  // manual nodes carry their generated id.
  key: string;
  townKey?: string;  // raw region key (town nodes only) — indexes added buildings
  manual?: boolean;  // hand-authored via the + buttons (vs. door-derived)
  thumb?: { x: number; y: number }; // storefront art anchor (building entrance px)
  children?: LocNode[];
}

// ── editable-outline overrides (public/overrides/places.json) ────────────────
// Layered on top of the door-derived tree each time the editor opens: you can
// add extra buildings/rooms, hide any link, and nudge a quick-link anchor. No
// ROM data — just authored navigation metadata, so it ships.
interface AddedRoom { id: string; label: string; x: number; y: number; }
interface AddedBuilding { id: string; label: string; x: number; y: number; }
interface PlacesDoc {
  version: number;
  hidden: string[];                              // node keys removed from the outline
  moved: Record<string, { x: number; y: number }>; // anchor overrides (derived or manual)
  labels: Record<string, string>;               // name overrides for DERIVED nodes
  buildings: Record<string, AddedBuilding[]>;    // townKey -> manual buildings
  rooms: Record<string, AddedRoom[]>;            // buildingKey -> manual rooms
}

function buildingKeyOf(townKey: string, ex: number, ey: number): string {
  return `${townKey}|b@${ex},${ey}`;
}
function roomKeyOf(buildingKey: string, dx: number, dy: number): string {
  return `${buildingKey}|r@${dx},${dy}`;
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
        key: `t:${town}`,
        townKey: town,
        children: buildings.map((b, i) => buildingNode(townLabel, b, i + 1)),
      };
    });
}

function buildingNode(townLabel: string, b: Building, ordinal: number): LocNode {
  const rooms = b.rooms.sort((a, c) => a.dy - c.dy || a.dx - c.dx);
  const named = rooms.find((r) => r.place); // building inherits its landmark room's name
  const people = rooms.reduce((s, r) => s + r.people, 0);
  const name = named?.place ?? `${townLabel} Bldg ${ordinal}`;

  const bKey = buildingKeyOf(b.town, b.ex, b.ey);
  const counters: Record<string, number> = {};
  return {
    label: `${name}${peopleChip(people)}`,
    title: `entrance (${b.ex},${b.ey}) · ${rooms.length} room${rooms.length === 1 ? '' : 's'}`,
    x: b.ex,
    y: b.ey,
    kind: 'building',
    key: bKey,
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
        key: roomKeyOf(bKey, r.dx, r.dy),
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

/** The draggable map marker the nav hands to the shell when a node is selected. */
export interface PlaceAnchor {
  x: number;
  y: number;
  label: string;
  onMove: (x: number, y: number) => void; // live during drag
  onCommit: () => void;                    // drag end — persist
}

/** What the editor shell offers the nav for the map-side anchor affordance. */
export interface PlaceAnchorApi {
  /** Current camera-view center (world px) — where a new node is dropped. */
  viewCenter: () => { x: number; y: number };
  /** Show (non-null) or clear (null) the draggable anchor on the map. */
  select: (anchor: PlaceAnchor | null) => void;
  toast: (msg: string, isError?: boolean) => void;
}

const EMPTY_PLACES: PlacesDoc = { version: 1, hidden: [], moved: {}, labels: {}, buildings: {}, rooms: {} };

export class LocationNav {
  private panel: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private visible = true;
  // Lazily render storefront thumbnails only when their row scrolls into view.
  private thumbObserver: IntersectionObserver | null = null;

  // Door-derived tree (built once); the composed tree re-applies the overrides
  // over a fresh clone of it on every edit.
  private derivedTree: LocNode[] = [];
  private composed: LocNode[] = [];
  private doc: PlacesDoc = structuredClone(EMPTY_PLACES);

  private expandedKeys = new Set<string>();
  private selectedKey: string | null = null;
  private selectedRow: HTMLDivElement | null = null;
  private idCounter = 0;

  constructor(
    private readonly goTo: (x: number, y: number) => void,
    /** Town key the player is currently in, to auto-expand it. */
    private readonly currentTown: () => string,
    private readonly anchorApi: PlaceAnchorApi,
  ) {}

  async mount(): Promise<void> {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;top:30px;left:0;bottom:0;width:248px;z-index:90;overflow:auto;' +
      'background:#101418f2;color:#cde;font:11px monospace;border-right:2px solid #e8a33d;' +
      'padding:6px 4px;user-select:none;';

    const head = document.createElement('div');
    head.textContent = '📍 PLACES';
    head.title = '+ adds a building/room at the view center · X removes a link · ' +
      'click a building/room then drag its pink anchor on the map to move it';
    head.style.cssText = 'color:#e8a33d;font-weight:bold;letter-spacing:1px;padding:2px 6px 6px;';
    this.panel.appendChild(head);

    this.body = document.createElement('div');
    this.panel.appendChild(this.body);
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
      const [derived, doc, roomList] = await Promise.all([buildTree(), loadPlaces(), loadRoomsJson()]);
      this.derivedTree = injectInstancedRooms(derived, roomList);
      this.doc = doc;
      // Seed expansion: auto-open the town the player is standing in.
      const here = this.currentTown();
      const hereLabel = (TOWN_LABEL[here] ?? '').toLowerCase();
      for (const town of this.derivedTree) {
        if (here !== 'other' && town.label.toLowerCase().startsWith(hereLabel)) {
          this.expandedKeys.add(town.key);
        }
      }
      this.rerender();
    } catch {
      if (this.body) this.body.textContent = 'Failed to load locations.';
    }
  }

  /** Re-apply the overrides over the derived tree and rebuild the panel DOM. */
  private rerender(): void {
    if (!this.body) return;
    this.composed = composeTree(this.derivedTree, this.doc);
    this.body.replaceChildren();
    this.selectedRow = null;
    for (const town of this.composed) {
      this.body.appendChild(this.renderNode(town, 0, null));
    }
    if (this.composed.length === 0) this.body.textContent = 'No doors found.';
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

  private renderNode(node: LocNode, depth: number, parent: LocNode | null): HTMLDivElement {
    const wrap = document.createElement('div');
    const expanded = this.expandedKeys.has(node.key);

    const row = document.createElement('div');
    row.title = node.title;
    row.style.cssText =
      `display:flex;align-items:center;gap:3px;padding:2px 4px;cursor:pointer;border-radius:3px;` +
      `margin-left:${depth * 10}px;`;
    const selected = node.key === this.selectedKey;
    if (selected) {
      row.style.background = '#243447';
      this.selectedRow = row;
    }
    row.onmouseenter = () => { if (node.key !== this.selectedKey) row.style.background = '#1d2530'; };
    row.onmouseleave = () => { if (node.key !== this.selectedKey) row.style.background = ''; };

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
    label.textContent = node.label + (node.manual ? ' ✎' : '');
    label.style.cssText =
      `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `color:${node.kind === 'town' ? '#cde' : node.kind === 'building' ? '#cfe3d2' : '#8aa'};`;
    row.appendChild(label);

    // Per-row actions: + to add a child (towns add buildings, buildings add
    // rooms); X to remove the link (buildings + rooms). Double-click a label to
    // rename a manual node.
    if (node.kind === 'town') {
      row.appendChild(this.actionBtn('+', 'Add a building here', '#9fe3a0', () => this.addBuilding(node)));
    } else if (node.kind === 'building') {
      row.appendChild(this.actionBtn('+', 'Add a room here', '#9fe3a0', () => this.addRoom(node)));
      row.appendChild(this.actionBtn('✕', 'Remove this building from the outline', '#ff8a7a', () => this.remove(node, parent)));
    } else {
      row.appendChild(this.actionBtn('✕', 'Remove this room from the outline', '#ff8a7a', () => this.remove(node, parent)));
    }

    let kids: HTMLDivElement | null = null;
    if (hasKids) {
      kids = document.createElement('div');
      kids.style.display = expanded ? 'block' : 'none';
      for (const c of node.children!) kids.appendChild(this.renderNode(c, depth + 1, node));
    }

    caret.onclick = (e) => {
      e.stopPropagation();
      if (!kids) return;
      const nowOpen = kids.style.display === 'none';
      kids.style.display = nowOpen ? 'block' : 'none';
      caret.textContent = nowOpen ? '▾' : '▸';
      if (nowOpen) this.expandedKeys.add(node.key);
      else this.expandedKeys.delete(node.key);
    };

    // Click flies there; buildings/rooms also become the selected (draggable) anchor.
    label.onclick = () => {
      this.goTo(node.x, node.y);
      if (node.kind !== 'town') this.select(node, parent, row);
    };
    // Buildings and rooms (derived or manual) rename on double-click.
    if (node.kind === 'building' || node.kind === 'room') {
      label.title = 'Double-click to rename';
      label.ondblclick = (e) => { e.stopPropagation(); this.renameNode(node, parent, label); };
    }

    wrap.appendChild(row);
    if (kids) wrap.appendChild(kids);
    return wrap;
  }

  private actionBtn(glyph: string, title: string, color: string, fn: () => void): HTMLSpanElement {
    const b = document.createElement('span');
    b.textContent = glyph;
    b.title = title;
    b.style.cssText =
      `flex:none;width:16px;text-align:center;color:${color};border-radius:2px;` +
      `cursor:pointer;font-weight:bold;`;
    b.onmouseenter = () => (b.style.background = '#2c3a4c');
    b.onmouseleave = () => (b.style.background = '');
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }

  // --- editing ---------------------------------------------------------------

  private genId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${this.idCounter++}`;
  }

  private addBuilding(town: LocNode): void {
    const c = this.anchorApi.viewCenter();
    const b: AddedBuilding = { id: this.genId('mb'), label: 'New Building', x: c.x, y: c.y };
    (this.doc.buildings[town.townKey!] ??= []).push(b);
    this.expandedKeys.add(town.key);
    this.selectedKey = b.id; // highlight the new row on rerender
    void this.persist();
    this.rerender();
    this.selectByKey(b.id); // ready to drag the new anchor immediately
  }

  private addRoom(building: LocNode): void {
    const c = this.anchorApi.viewCenter();
    const r: AddedRoom = { id: this.genId('mr'), label: 'New Room', x: c.x, y: c.y };
    (this.doc.rooms[building.key] ??= []).push(r);
    this.expandedKeys.add(building.key);
    this.selectedKey = r.id; // highlight the new row on rerender
    void this.persist();
    this.rerender();
    this.selectByKey(r.id);
  }

  private remove(node: LocNode, parent: LocNode | null): void {
    if (node.manual) {
      if (node.kind === 'building' && parent) {
        const list = this.doc.buildings[parent.townKey!];
        if (list) this.doc.buildings[parent.townKey!] = list.filter((b) => b.id !== node.key);
        delete this.doc.rooms[node.key]; // its manual rooms go with it
      } else if (node.kind === 'room' && parent) {
        const list = this.doc.rooms[parent.key];
        if (list) this.doc.rooms[parent.key] = list.filter((r) => r.id !== node.key);
      }
      delete this.doc.moved[node.key];
    } else if (!this.doc.hidden.includes(node.key)) {
      this.doc.hidden.push(node.key); // derived link — hide it
    }
    delete this.doc.labels[node.key];
    if (this.selectedKey === node.key) this.clearSelection();
    void this.persist();
    this.rerender();
  }

  private renameNode(node: LocNode, parent: LocNode | null, label: HTMLSpanElement): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = node.label;
    input.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1016;color:#fff;' +
      'border:1px solid #e8a33d;border-radius:2px;padding:0 2px;';
    const commit = (save: boolean) => {
      const name = input.value.trim();
      input.replaceWith(label);
      if (save && name && name !== node.label) {
        this.setLabel(node, parent, name);
        void this.persist();
        this.rerender();
      }
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  private setLabel(node: LocNode, parent: LocNode | null, name: string): void {
    if (node.manual) {
      // Manual nodes store their label on their own entry.
      if (node.kind === 'building' && parent) {
        this.doc.buildings[parent.townKey!]?.forEach((b) => { if (b.id === node.key) b.label = name; });
      } else if (node.kind === 'room' && parent) {
        this.doc.rooms[parent.key]?.forEach((r) => { if (r.id === node.key) r.label = name; });
      }
    } else {
      // Derived node: keep a name override keyed by its stable coord-key.
      this.doc.labels[node.key] = name;
    }
  }

  // --- selection + draggable anchor -----------------------------------------

  private selectByKey(key: string): void {
    const found = findNode(this.composed, key);
    if (found) this.select(found.node, found.parent, null);
  }

  private select(node: LocNode, parent: LocNode | null, row: HTMLDivElement | null): void {
    // Don't clear the highlight when re-selecting the same key (e.g. right after
    // an add, where rerender already highlighted the new row).
    if (this.selectedRow && this.selectedKey !== node.key) this.selectedRow.style.background = '';
    this.selectedKey = node.key;
    if (row) {
      row.style.background = '#243447';
      this.selectedRow = row;
    }
    this.anchorApi.select({
      x: node.x,
      y: node.y,
      label: node.label,
      onMove: (x, y) => { node.x = x; node.y = y; },
      onCommit: () => {
        if (node.manual) this.setCoords(node, parent, node.x, node.y);
        else this.doc.moved[node.key] = { x: node.x, y: node.y };
        void this.persist();
        this.anchorApi.toast(`Moved "${node.label}" to (${node.x},${node.y})`);
      },
    });
  }

  private setCoords(node: LocNode, parent: LocNode | null, x: number, y: number): void {
    if (node.kind === 'building' && parent) {
      this.doc.buildings[parent.townKey!]?.forEach((b) => { if (b.id === node.key) { b.x = x; b.y = y; } });
    } else if (node.kind === 'room' && parent) {
      this.doc.rooms[parent.key]?.forEach((r) => { if (r.id === node.key) { r.x = x; r.y = y; } });
    }
  }

  private clearSelection(): void {
    this.selectedKey = null;
    if (this.selectedRow) this.selectedRow.style.background = '';
    this.selectedRow = null;
    this.anchorApi.select(null);
  }

  private async persist(): Promise<void> {
    try {
      await postPlaces(this.doc);
    } catch (err) {
      this.anchorApi.toast(`Save failed: ${String(err)}`, true);
    }
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.panel) this.panel.style.display = this.visible ? 'block' : 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.anchorApi.select(null);
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.panel?.remove();
    this.panel = null;
    this.body = null;
  }
}

// ── overrides load / save / compose ──────────────────────────────────────────

// ── authored rooms (from the Rooms registry / overrides/rooms.json) ───────────
// Custom rooms (copied from an interior template into the appended "interiors
// band", then edited and wired to new doors) live off the door-derived tree, so
// we list them here directly: grouped by town, under a synthetic "Custom Rooms"
// building, each flying to the room's spawn. MapManager populates the registry
// from overrides/rooms.json at load; empty ⇒ nothing added.
type RoomJson = RoomDef;

function loadRoomsJson(): RoomJson[] {
  return [...listRooms()];
}

function injectInstancedRooms(tree: LocNode[], rooms: RoomJson[]): LocNode[] {
  if (rooms.length === 0) return tree;
  const byTown = new Map<string, RoomJson[]>();
  for (const r of rooms) {
    const town = r.town && r.town !== '(unsorted)' ? r.town : 'other';
    (byTown.get(town) ?? byTown.set(town, []).get(town)!).push(r);
  }
  for (const [town, list] of byTown) {
    let tnode = tree.find((n) => n.townKey === town);
    const at = (r: RoomJson) => ({ x: r.spawn?.x ?? r.rect.x, y: r.spawn?.y ?? r.rect.y });
    if (!tnode) {
      const a = at(list[0]);
      tnode = {
        label: TOWN_LABEL[town] ?? town, title: `${list.length} instanced rooms`,
        x: a.x, y: a.y, kind: 'town', key: `t:${town}`, townKey: town, children: [],
      };
      tree.push(tnode);
    }
    tnode.children ??= [];
    const a0 = at(list[0]);
    tnode.children.push({
      label: `Custom Rooms (${list.length})`,
      title: 'authored room copies',
      x: a0.x, y: a0.y, kind: 'building', key: `t:${town}|instanced`,
      children: list.map((r) => {
        const a = at(r);
        return {
          label: r.label, title: `${r.id} · spawn (${a.x},${a.y})`,
          x: a.x, y: a.y, kind: 'room' as const, key: `room:${r.id}`,
        };
      }),
    });
  }
  return tree;
}

async function loadPlaces(): Promise<PlacesDoc> {
  try {
    const d = await loadJSON<Partial<PlacesDoc>>('/overrides/places.json');
    return {
      version: d.version ?? 1,
      hidden: d.hidden ?? [],
      moved: d.moved ?? {},
      labels: d.labels ?? {},
      buildings: d.buildings ?? {},
      rooms: d.rooms ?? {},
    };
  } catch {
    return structuredClone(EMPTY_PLACES);
  }
}

async function postPlaces(doc: PlacesDoc): Promise<void> {
  const res = await fetch('/__editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'places.json', data: doc }),
  });
  if (!res.ok) throw new Error(`save places: ${res.status}`);
  primeJSONCache('/overrides/places.json', doc);
}

/** Locate a node (and its parent) anywhere in the tree by key. */
function findNode(
  nodes: LocNode[],
  key: string,
  parent: LocNode | null = null,
): { node: LocNode; parent: LocNode | null } | null {
  for (const n of nodes) {
    if (n.key === key) return { node: n, parent };
    if (n.children) {
      const hit = findNode(n.children, key, n);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Layer the authored overrides over a fresh clone of the door-derived tree:
 * append manual buildings/rooms, apply moved anchors, drop hidden links, and
 * refresh each town's building count.
 */
function composeTree(derived: LocNode[], doc: PlacesDoc): LocNode[] {
  const tree = structuredClone(derived) as LocNode[];
  const hidden = new Set(doc.hidden);
  const applyMoved = (n: LocNode) => {
    const m = doc.moved[n.key];
    if (m) {
      n.x = m.x;
      n.y = m.y;
      if (n.thumb) n.thumb = { x: m.x, y: m.y };
    }
  };

  for (const town of tree) {
    town.children ??= [];
    // Manual buildings for this town.
    for (const mb of doc.buildings[town.townKey!] ?? []) {
      town.children.push({
        label: mb.label, title: `entrance (${mb.x},${mb.y}) · manual`,
        x: mb.x, y: mb.y, kind: 'building', key: mb.id, manual: true,
        thumb: { x: mb.x, y: mb.y }, children: [],
      });
    }
    for (const b of town.children) {
      b.children ??= [];
      // Manual rooms for this building (derived or manual).
      for (const mr of doc.rooms[b.key] ?? []) {
        b.children.push({
          label: mr.label, title: `dest (${mr.x},${mr.y}) · manual`,
          x: mr.x, y: mr.y, kind: 'room', key: mr.id, manual: true,
        });
      }
      b.children = b.children.filter((r) => !hidden.has(r.key));
      b.children.forEach(applyMoved);
      b.children.forEach((r) => { const l = doc.labels[r.key]; if (l) r.label = l; });
      applyMoved(b);
      const bl = doc.labels[b.key];
      if (bl) b.label = bl;
    }
    town.children = town.children.filter((b) => !hidden.has(b.key));
    const label = TOWN_LABEL[town.townKey!] ?? town.townKey!;
    town.label = `${label} (${town.children.length})`;
  }
  return tree;
}
