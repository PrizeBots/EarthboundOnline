import { loadJSON } from '../engine/AssetLoader';
import { loadWorldDoc, saveWorldDoc } from '../engine/Auth';
import { getSector, getTileAt } from '../engine/MapManager';
import {
  regionAt,
  sectorAtPx,
  REGION_ORDER as TOWN_ORDER,
  REGION_LABEL as TOWN_LABEL,
} from '../engine/Regions';
import { listRooms, RoomDef } from '../engine/Rooms';
import {
  loadAtlas,
  drawTile,
  drawForegroundTile,
  hasForegroundTile,
} from '../engine/TilesetManager';
import { TILE_SIZE, SECTOR_TILES_X, SECTOR_TILES_Y, MAP_WIDTH_SECTORS } from '../types';

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

// Named regions (anchors, labels, display order) + regionAt/sectorAtPx now live
// in engine/Regions.ts — the shared source of truth for town/area attribution,
// also used by the Enemy Spawner's by-area list grouping.

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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  townKey?: string; // raw region key (town nodes only) — indexes added buildings
  manual?: boolean; // hand-authored via the + buttons (vs. door-derived)
  thumb?: { x: number; y: number }; // storefront art anchor (building entrance px)
  thumbRect?: Rect; // explicit marquee crop for the thumbnail (overrides `thumb`)
  bounds?: Rect; // manual area footprint (marquee) — fly-to frames it
  roomId?: string; // linked Room Builder room id — clicking enters that instance
  here?: boolean; // computed each render: the player is standing here
  children?: LocNode[];
}

// ── editable-outline overrides (public/overrides/places.json) ────────────────
// Layered on top of the door-derived tree each time the editor opens: you can
// add extra buildings/rooms, hide any link, and nudge a quick-link anchor. No
// ROM data — just authored navigation metadata, so it ships.
interface AddedRoom {
  id: string;
  label: string;
  x: number;
  y: number;
  roomId?: string;
}
interface AddedBuilding {
  id: string;
  label: string;
  x: number;
  y: number;
  thumbRect?: Rect;
  roomId?: string;
}
interface AddedArea {
  id: string;
  label: string;
  x: number;
  y: number;
  bounds?: Rect;
}
const ROOT_KEY = '__root__'; // order bucket for the top-level area list
interface PlacesDoc {
  version: number;
  hidden: string[]; // node keys removed from the outline
  moved: Record<string, { x: number; y: number }>; // anchor overrides (derived or manual)
  labels: Record<string, string>; // name overrides (derived nodes incl. towns "t:<town>")
  buildings: Record<string, AddedBuilding[]>; // townKey -> manual buildings
  rooms: Record<string, AddedRoom[]>; // buildingKey -> manual rooms
  areas: AddedArea[]; // manual top-level areas
  parent: Record<string, string>; // nodeKey -> new parent key (reparent, derived+manual)
  order: Record<string, string[]>; // parentKey (or ROOT_KEY) -> ordered child keys
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
  const word = t.match(
    /\b(hospital|hotel|bakery|arcade|restaurant|library|museum|bank|theater|zoo|gym)\b/i
  );
  if (word) return word[1][0].toUpperCase() + word[1].slice(1).toLowerCase();
  return undefined;
}

// ── sector helpers ───────────────────────────────────────────────────────────
// regionAt + sectorAtPx are imported from engine/Regions (shared source of truth).
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
    if (!d.entInt && d.dstInt)
      seedEntrance([d.dx, d.dy], d.ex, d.ey); // outside → in
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
    if (
      b.rooms.some(
        (r) => Math.abs(r.dx - d.dx) <= ROOM_MERGE_PX && Math.abs(r.dy - d.dy) <= ROOM_MERGE_PX
      )
    )
      continue;
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
      drawForegroundTile(
        ctx,
        s.tilesetId,
        s.paletteId,
        getTileAt(tx, ty),
        (tx - ox) * TILE_SIZE,
        (ty - oy) * TILE_SIZE
      );
    }
  }

  const url = canvas.toDataURL();
  thumbCache.set(key, url);
  return url;
}

// Render an arbitrary world-px rectangle (a marquee crop) to a data URL — the
// authored thumbnail for a manual building. Same dual-layer pass as the
// storefront crop, but over the exact tiles the box spans.
const rectThumbCache = new Map<string, string>();
async function rectThumb(r: Rect): Promise<string | null> {
  const key = `${r.x},${r.y},${r.w},${r.h}`;
  const cached = rectThumbCache.get(key);
  if (cached) return cached;

  const tx0 = Math.floor(r.x / TILE_SIZE);
  const ty0 = Math.floor(r.y / TILE_SIZE);
  const tx1 = Math.max(tx0 + 1, Math.ceil((r.x + r.w) / TILE_SIZE));
  const ty1 = Math.max(ty0 + 1, Math.ceil((r.y + r.h) / TILE_SIZE));

  const need = new Map<string, { ts: number; pal: number }>();
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const s = getSector(Math.floor(tx / SECTOR_TILES_X), Math.floor(ty / SECTOR_TILES_Y));
      if (s) need.set(`${s.tilesetId}_${s.paletteId}`, { ts: s.tilesetId, pal: s.paletteId });
    }
  }
  await Promise.all([...need.values()].map((a) => loadAtlas(a.ts, a.pal)));

  const canvas = document.createElement('canvas');
  canvas.width = (tx1 - tx0) * TILE_SIZE;
  canvas.height = (ty1 - ty0) * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const s = getSector(Math.floor(tx / SECTOR_TILES_X), Math.floor(ty / SECTOR_TILES_Y));
      if (!s) continue;
      drawTile(
        ctx,
        s.tilesetId,
        s.paletteId,
        getTileAt(tx, ty),
        (tx - tx0) * TILE_SIZE,
        (ty - ty0) * TILE_SIZE
      );
    }
  }
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const s = getSector(Math.floor(tx / SECTOR_TILES_X), Math.floor(ty / SECTOR_TILES_Y));
      if (!s || !hasForegroundTile(s.tilesetId, s.paletteId)) continue;
      drawForegroundTile(
        ctx,
        s.tilesetId,
        s.paletteId,
        getTileAt(tx, ty),
        (tx - tx0) * TILE_SIZE,
        (ty - ty0) * TILE_SIZE
      );
    }
  }

  const url = canvas.toDataURL();
  rectThumbCache.set(key, url);
  return url;
}

/** The draggable map marker the nav hands to the shell when a node is selected. */
export interface PlaceAnchor {
  x: number;
  y: number;
  label: string;
  onMove: (x: number, y: number) => void; // live during drag
  onCommit: () => void; // drag end — persist
}

/** What the editor shell offers the nav for the map-side anchor affordance. */
export interface PlaceAnchorApi {
  /** Current camera-view center (world px) — where a new node is dropped. */
  viewCenter: () => { x: number; y: number };
  /** Show (non-null) or clear (null) the draggable anchor on the map. */
  select: (anchor: PlaceAnchor | null) => void;
  toast: (msg: string, isError?: boolean) => void;
  /** Arm a one-shot marquee on the map; resolves with the world-px rect (or null
   *  if cancelled). Used to crop a building thumbnail / draw an area footprint. */
  beginMarquee: (onDone: (rect: Rect | null) => void) => void;
  /** The frozen player's current world position — for the "you are here" marker. */
  currentPos: () => { x: number; y: number };
}

const EMPTY_PLACES: PlacesDoc = {
  version: 1,
  hidden: [],
  moved: {},
  labels: {},
  buildings: {},
  rooms: {},
  areas: [],
  parent: {},
  order: {},
};

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

  private filter = ''; // live search text (lowercased)
  private readonly undoStack: string[] = []; // JSON snapshots of doc before each edit
  private dragKey: string | null = null; // node key currently being dragged
  private dragKind: LocNode['kind'] | null = null;
  private menuEl: HTMLDivElement | null = null; // open context menu, if any
  private rowLabels = new Map<string, HTMLSpanElement>(); // node key -> label el (for rename)
  // "You are here" markers, recomputed each render.
  private hereArea: string | null = null;
  private hereRoom: string | null = null;

  constructor(
    private readonly goTo: (x: number, y: number) => void,
    /** Town key the player is currently in, to auto-expand it. */
    private readonly currentTown: () => string,
    private readonly anchorApi: PlaceAnchorApi
  ) {}

  async mount(): Promise<void> {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;top:30px;left:0;bottom:0;width:248px;z-index:90;overflow:auto;' +
      'background:#101418f2;color:#cde;font:11px monospace;border-right:2px solid #e8a33d;' +
      'padding:6px 4px;user-select:none;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 6px 4px;';
    const title = document.createElement('span');
    title.textContent = '📍 PLACES';
    title.title =
      'Right-click a row for actions · drag rows to re-organize · double-click a label to rename · ' +
      'click a building/room then drag its pink map anchor to move it';
    title.style.cssText = 'color:#e8a33d;font-weight:bold;letter-spacing:1px;flex:1;';
    head.appendChild(title);
    head.appendChild(this.miniBtn('＋Area', 'Add a new top-level area', () => this.addArea()));
    head.appendChild(this.miniBtn('↶', 'Undo last change', () => this.undo()));
    this.panel.appendChild(head);

    // Live search — type to filter the tree; matches auto-expand.
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'search places…';
    search.style.cssText =
      'width:calc(100% - 12px);margin:0 6px 6px;box-sizing:border-box;font:11px monospace;' +
      'background:#0c1016;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    search.oninput = () => {
      this.filter = search.value.trim().toLowerCase();
      this.rerender();
    };
    search.onkeydown = (e) => e.stopPropagation();
    this.panel.appendChild(search);

    this.body = document.createElement('div');
    this.panel.appendChild(this.body);
    document.body.appendChild(this.panel);

    // A click anywhere dismisses an open context menu.
    window.addEventListener('mousedown', this.onGlobalMouseDown, true);

    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target as HTMLImageElement;
          this.thumbObserver!.unobserve(img);
          void this.fillThumb(img);
        }
      },
      { root: this.panel, rootMargin: '120px' }
    );

    try {
      const [derived, doc, roomList] = await Promise.all([
        buildTree(),
        loadPlaces(),
        loadRoomsJson(),
      ]);
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
    this.markHere();
    this.body.replaceChildren();
    this.selectedRow = null;
    this.rowLabels.clear();
    for (const town of this.composed) {
      const el = this.renderNode(town, 0, null);
      if (el) this.body.appendChild(el);
    }
    if (this.composed.length === 0) this.body.textContent = 'No doors found.';
  }

  /** Flag the area the player stands in + the nearest room, for the here-marker. */
  private markHere(): void {
    this.hereArea = `t:${this.currentTown()}`;
    const p = this.anchorApi.currentPos();
    let best: LocNode | null = null;
    let bd = 220; // px — only mark a room if the avatar is genuinely near it
    const visit = (n: LocNode) => {
      n.here = false;
      if (n.kind === 'room') {
        const d = Math.abs(n.x - p.x) + Math.abs(n.y - p.y);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      n.children?.forEach(visit);
    };
    this.composed.forEach(visit);
    this.hereRoom = best ? (best as LocNode).key : null;
  }

  private async fillThumb(img: HTMLImageElement): Promise<void> {
    const x = Number(img.dataset.tx);
    const y = Number(img.dataset.ty);
    try {
      // An explicit marquee crop (data-rw/rh) wins; otherwise the storefront art.
      const url = img.dataset.rw
        ? await rectThumb({ x, y, w: Number(img.dataset.rw), h: Number(img.dataset.rh) })
        : await storefrontThumb(x, y);
      if (url) img.src = url;
      else img.style.visibility = 'hidden';
    } catch {
      img.style.visibility = 'hidden';
    }
  }

  /** True if `node`'s label, or any descendant's, matches the active filter. */
  private subtreeMatches(node: LocNode): boolean {
    if (!this.filter) return true;
    if (node.label.toLowerCase().includes(this.filter)) return true;
    return !!node.children?.some((c) => this.subtreeMatches(c));
  }

  private renderNode(node: LocNode, depth: number, parent: LocNode | null): HTMLDivElement | null {
    if (!this.subtreeMatches(node)) return null; // filtered out
    const wrap = document.createElement('div');
    // While searching, auto-open every branch that survived the filter.
    const expanded = this.filter ? true : this.expandedKeys.has(node.key);

    const isHere =
      node.key === this.hereRoom || (node.kind === 'town' && node.key === this.hereArea);

    const row = document.createElement('div');
    row.title = node.title;
    row.draggable = true;
    row.style.cssText =
      `display:flex;align-items:center;gap:3px;padding:2px 4px;cursor:pointer;border-radius:3px;` +
      `margin-left:${depth * 10}px;` +
      (isHere ? 'box-shadow:inset 2px 0 0 #7fe07f;' : '');
    const selected = node.key === this.selectedKey;
    if (selected) {
      row.style.background = '#243447';
      this.selectedRow = row;
    }
    row.onmouseenter = () => {
      if (node.key !== this.selectedKey) row.style.background = '#1d2530';
    };
    row.onmouseleave = () => {
      if (node.key !== this.selectedKey) row.style.background = '';
    };

    // --- drag & drop: re-home / reorder ---
    row.ondragstart = (e) => {
      this.dragKey = node.key;
      this.dragKind = node.kind;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', node.key);
    };
    row.ondragend = () => {
      this.dragKey = null;
      this.dragKind = null;
      row.style.outline = '';
    };
    row.ondragover = (e) => {
      if (!this.planDrop(node, parent)) return; // invalid target
      e.preventDefault();
      row.style.outline = '1px dashed #7fe07f';
    };
    row.ondragleave = () => {
      row.style.outline = '';
    };
    row.ondrop = (e) => {
      e.preventDefault();
      row.style.outline = '';
      this.handleDrop(node, parent);
    };

    const hasKids = !!node.children && node.children.length > 0;
    const caret = document.createElement('span');
    caret.textContent = hasKids ? (expanded ? '▾' : '▸') : '·';
    caret.style.cssText = `width:10px;flex:none;color:${hasKids ? '#e8a33d' : '#456'};`;
    row.appendChild(caret);

    // Building thumbnail — a marquee crop if set, else the storefront art. Lazy.
    if (node.thumb || node.thumbRect) {
      const img = document.createElement('img');
      const r = node.thumbRect;
      if (r) {
        img.dataset.tx = String(r.x);
        img.dataset.ty = String(r.y);
        img.dataset.rw = String(r.w);
        img.dataset.rh = String(r.h);
      } else {
        img.dataset.tx = String(node.thumb!.x);
        img.dataset.ty = String(node.thumb!.y);
      }
      img.style.cssText =
        'width:40px;height:32px;flex:none;object-fit:cover;image-rendering:pixelated;' +
        'border:1px solid #2a3340;border-radius:2px;background:#0a0d10;';
      row.appendChild(img);
      this.thumbObserver?.observe(img);
    }

    const label = document.createElement('span');
    const badge = (node.roomId ? ' 🔗' : '') + (node.manual ? ' ✎' : '') + (isHere ? ' ◄' : '');
    label.textContent = node.label + badge;
    label.style.cssText =
      `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `color:${isHere ? '#bdf5bd' : node.kind === 'town' ? '#cde' : node.kind === 'building' ? '#cfe3d2' : '#8aa'};`;
    row.appendChild(label);
    this.rowLabels.set(node.key, label);

    // Quick + to add a child (towns add buildings, buildings add rooms). Everything
    // else (rename, duplicate, link, thumbnail, delete) lives on the right-click menu.
    if (node.kind === 'town') {
      row.appendChild(
        this.actionBtn('+', 'Add a building here', '#9fe3a0', () => this.addBuilding(node))
      );
    } else if (node.kind === 'building') {
      row.appendChild(this.actionBtn('+', 'Add a room here', '#9fe3a0', () => this.addRoom(node)));
    }
    row.appendChild(
      this.actionBtn('⋯', 'More actions', '#9fb8cc', () => {
        const rect = row.getBoundingClientRect();
        this.openMenu(node, parent, rect.right - 4, rect.bottom);
      })
    );

    row.oncontextmenu = (e) => {
      e.preventDefault();
      this.openMenu(node, parent, e.clientX, e.clientY);
    };

    let kids: HTMLDivElement | null = null;
    if (hasKids) {
      kids = document.createElement('div');
      kids.style.display = expanded ? 'block' : 'none';
      for (const c of node.children!) {
        const childEl = this.renderNode(c, depth + 1, node);
        if (childEl) kids.appendChild(childEl);
      }
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

    // Click flies there (to a linked room's spawn if one is wired); buildings and
    // rooms also become the selected (draggable) map anchor.
    label.onclick = () => {
      this.flyTo(node);
      if (node.kind !== 'town') this.select(node, parent, row);
    };
    label.title = 'Double-click to rename';
    label.ondblclick = (e) => {
      e.stopPropagation();
      this.renameNode(node, parent, label);
    };

    wrap.appendChild(row);
    if (kids) wrap.appendChild(kids);
    return wrap;
  }

  /** Fly to a node — a linked Room Builder room's spawn if set, else its anchor. */
  private flyTo(node: LocNode): void {
    if (node.roomId) {
      const room = listRooms().find((r) => r.id === node.roomId);
      if (room) {
        const b = room.rect ?? room.regions?.[0] ?? { x: 0, y: 0 };
        this.goTo(room.spawn?.x ?? b.x, room.spawn?.y ?? b.y);
        return;
      }
    }
    this.goTo(node.x, node.y);
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
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  }

  private miniBtn(glyph: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = glyph;
    b.title = title;
    b.style.cssText =
      'font:11px monospace;padding:1px 6px;cursor:pointer;border-radius:3px;flex:none;' +
      'background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    return b;
  }

  // --- editing ---------------------------------------------------------------

  private genId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${this.idCounter++}`;
  }

  /** Snapshot the doc so the last change can be undone. Call before each edit. */
  private snapshot(): void {
    this.undoStack.push(JSON.stringify(this.doc));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.anchorApi.toast('Nothing to undo');
      return;
    }
    this.doc = JSON.parse(prev) as PlacesDoc;
    this.clearSelection();
    void this.persist();
    this.rerender();
    this.anchorApi.toast('Undid last change');
  }

  // Manual entries live in buckets keyed by their (original) parent. After a
  // reparent the bucket key can differ from the current parent, so always find
  // a manual node by scanning every bucket for its id.
  private manualBuildingEntry(id: string): { list: AddedBuilding[]; entry: AddedBuilding } | null {
    for (const list of Object.values(this.doc.buildings)) {
      const entry = list.find((b) => b.id === id);
      if (entry) return { list, entry };
    }
    return null;
  }
  private manualRoomEntry(id: string): { list: AddedRoom[]; entry: AddedRoom } | null {
    for (const list of Object.values(this.doc.rooms)) {
      const entry = list.find((r) => r.id === id);
      if (entry) return { list, entry };
    }
    return null;
  }

  private addArea(): void {
    const c = this.anchorApi.viewCenter();
    const a: AddedArea = { id: this.genId('ma'), label: 'New Area', x: c.x, y: c.y };
    this.snapshot();
    this.doc.areas.push(a);
    this.expandedKeys.add(a.id);
    this.selectedKey = a.id;
    void this.persist();
    this.rerender();
    this.anchorApi.toast('Area added — drag buildings into it, or ⋯ → Set bounds');
  }

  private addBuilding(town: LocNode): void {
    const c = this.anchorApi.viewCenter();
    const b: AddedBuilding = { id: this.genId('mb'), label: 'New Building', x: c.x, y: c.y };
    this.snapshot();
    (this.doc.buildings[town.townKey!] ??= []).push(b);
    this.expandedKeys.add(town.key);
    this.selectedKey = b.id;
    void this.persist();
    this.rerender();
    this.selectByKey(b.id);
    // Immediately crop its thumbnail: drag a box over the storefront on the map.
    this.anchorApi.beginMarquee((rect) => {
      if (!rect) return;
      b.thumbRect = rect;
      void this.persist();
      this.rerender();
      this.anchorApi.toast('Thumbnail set');
    });
  }

  private addRoom(building: LocNode): void {
    const c = this.anchorApi.viewCenter();
    const r: AddedRoom = { id: this.genId('mr'), label: 'New Room', x: c.x, y: c.y };
    this.snapshot();
    (this.doc.rooms[building.key] ??= []).push(r);
    this.expandedKeys.add(building.key);
    this.selectedKey = r.id;
    void this.persist();
    this.rerender();
    this.selectByKey(r.id);
  }

  /** Clone a building or room as a manual sibling, nudged so it's visible. */
  private duplicate(node: LocNode, parent: LocNode | null): void {
    if (!parent) return;
    this.snapshot();
    if (node.kind === 'building') {
      const b: AddedBuilding = {
        id: this.genId('mb'),
        label: `${node.label} copy`,
        x: node.x + 16,
        y: node.y + 16,
        thumbRect: node.thumbRect,
        roomId: node.roomId,
      };
      (this.doc.buildings[parent.townKey!] ??= []).push(b);
      this.selectedKey = b.id;
    } else if (node.kind === 'room') {
      const r: AddedRoom = {
        id: this.genId('mr'),
        label: `${node.label} copy`,
        x: node.x + 16,
        y: node.y + 16,
        roomId: node.roomId,
      };
      (this.doc.rooms[parent.key] ??= []).push(r);
      this.selectedKey = r.id;
    } else {
      return;
    }
    void this.persist();
    this.rerender();
  }

  private remove(node: LocNode, parent: LocNode | null): void {
    this.snapshot();
    if (node.kind === 'town' && node.manual) {
      // Drop a manual area and everything authored under it.
      this.doc.areas = this.doc.areas.filter((a) => a.id !== node.key);
      for (const b of this.doc.buildings[node.key] ?? []) delete this.doc.rooms[b.id];
      delete this.doc.buildings[node.key];
      delete this.doc.order[node.key];
    } else if (node.manual) {
      if (node.kind === 'building') {
        const e = this.manualBuildingEntry(node.key);
        if (e) e.list.splice(e.list.indexOf(e.entry), 1);
        delete this.doc.rooms[node.key]; // its manual rooms go with it
        delete this.doc.order[node.key];
      } else if (node.kind === 'room') {
        const e = this.manualRoomEntry(node.key);
        if (e) e.list.splice(e.list.indexOf(e.entry), 1);
      }
      delete this.doc.moved[node.key];
      delete this.doc.parent[node.key];
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
    input.value = node.label.replace(/ \(\d+\)$/, ''); // strip the area "(count)" suffix
    input.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1016;color:#fff;' +
      'border:1px solid #e8a33d;border-radius:2px;padding:0 2px;';
    const row = label.parentElement as HTMLDivElement | null;
    if (row) row.draggable = false; // let the input own text selection while editing
    const commit = (save: boolean) => {
      if (row) row.draggable = true;
      const name = input.value.trim();
      input.replaceWith(label);
      if (save && name) {
        this.snapshot();
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
    if (node.kind === 'town' && node.manual) {
      this.doc.areas.forEach((a) => {
        if (a.id === node.key) a.label = name;
      });
    } else if (node.kind === 'town') {
      this.doc.labels[node.key] = name; // derived area: name override keyed by t:<town>
    } else if (node.manual && node.kind === 'building') {
      const e = this.manualBuildingEntry(node.key);
      if (e) e.entry.label = name;
    } else if (node.manual && node.kind === 'room') {
      const e = this.manualRoomEntry(node.key);
      if (e) e.entry.label = name;
    } else {
      this.doc.labels[node.key] = name; // derived node: override keyed by its coord-key
    }
  }

  /** Re-crop a manual building's thumbnail via a fresh marquee. */
  private setThumbnail(node: LocNode): void {
    const e = node.manual ? this.manualBuildingEntry(node.key) : null;
    if (!e) {
      this.anchorApi.toast('Thumbnails: manual buildings only', true);
      return;
    }
    this.anchorApi.beginMarquee((rect) => {
      if (!rect) return;
      this.snapshot();
      e.entry.thumbRect = rect;
      void this.persist();
      this.rerender();
      this.anchorApi.toast('Thumbnail updated');
    });
  }

  /** Outline a manual area on the map; its center becomes the fly-to anchor. */
  private setAreaBounds(node: LocNode): void {
    const area = this.doc.areas.find((a) => a.id === node.key);
    if (!area) {
      this.anchorApi.toast('Bounds: manual areas only', true);
      return;
    }
    this.anchorApi.beginMarquee((rect) => {
      if (!rect) return;
      this.snapshot();
      area.bounds = rect;
      area.x = rect.x + (rect.w >> 1);
      area.y = rect.y + (rect.h >> 1);
      void this.persist();
      this.rerender();
      this.anchorApi.toast('Area bounds set');
    });
  }

  /** Link a manual building/room to a real Room Builder room (clicking enters it). */
  private linkRoom(node: LocNode): void {
    const entry =
      node.kind === 'building'
        ? this.manualBuildingEntry(node.key)?.entry
        : this.manualRoomEntry(node.key)?.entry;
    if (!entry) {
      this.anchorApi.toast('Links: manual nodes only', true);
      return;
    }
    const rooms = listRooms();
    if (rooms.length === 0) {
      this.anchorApi.toast('No custom rooms yet (build some in Room Builder)', true);
      return;
    }
    this.openListPicker(
      rooms.map((r) => ({ label: r.label, value: r.id })),
      (roomId) => {
        this.snapshot();
        entry.roomId = roomId || undefined;
        void this.persist();
        this.rerender();
        this.anchorApi.toast(roomId ? 'Linked to room' : 'Link cleared');
      }
    );
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
      onMove: (x, y) => {
        node.x = x;
        node.y = y;
      },
      onCommit: () => {
        this.snapshot();
        if (node.manual) this.setCoords(node, node.x, node.y);
        else this.doc.moved[node.key] = { x: node.x, y: node.y };
        void this.persist();
        this.anchorApi.toast(`Moved "${node.label}" to (${node.x},${node.y})`);
      },
    });
  }

  /** Persist a manual node's dragged coords (parent-independent — scans buckets). */
  private setCoords(node: LocNode, x: number, y: number): void {
    if (node.kind === 'building') {
      const e = this.manualBuildingEntry(node.key);
      if (e) {
        e.entry.x = x;
        e.entry.y = y;
      }
    } else if (node.kind === 'room') {
      const e = this.manualRoomEntry(node.key);
      if (e) {
        e.entry.x = x;
        e.entry.y = y;
      }
    } else if (node.kind === 'town') {
      this.doc.areas.forEach((a) => {
        if (a.id === node.key) {
          a.x = x;
          a.y = y;
        }
      });
    }
  }

  // --- drag-drop reorganization ---------------------------------------------

  /** Resolve where dragging the current node onto `tgt` would land it, or null
   *  if that's not a legal move. A building goes under a town, a room under a
   *  building, an area reorders among areas. Dropping onto a sibling inserts
   *  before it; dropping onto a valid parent appends. */
  private planDrop(
    tgt: LocNode,
    tgtParent: LocNode | null
  ): { parentKey: string; parentNode: LocNode | null; beforeKey: string | null } | null {
    const kind = this.dragKind;
    if (!kind || !this.dragKey || this.dragKey === tgt.key) return null;
    if (kind === 'room') {
      if (tgt.kind === 'building') return { parentKey: tgt.key, parentNode: tgt, beforeKey: null };
      if (tgt.kind === 'room' && tgtParent)
        return { parentKey: tgtParent.key, parentNode: tgtParent, beforeKey: tgt.key };
      return null;
    }
    if (kind === 'building') {
      if (tgt.kind === 'town') return { parentKey: tgt.key, parentNode: tgt, beforeKey: null };
      if (tgt.kind === 'building' && tgtParent)
        return { parentKey: tgtParent.key, parentNode: tgtParent, beforeKey: tgt.key };
      return null;
    }
    // Dragging an area: reorder among the top-level areas.
    if (kind === 'town' && tgt.kind === 'town')
      return { parentKey: ROOT_KEY, parentNode: null, beforeKey: tgt.key };
    return null;
  }

  private handleDrop(tgt: LocNode, tgtParent: LocNode | null): void {
    const srcKey = this.dragKey;
    const srcKind = this.dragKind;
    const plan = this.planDrop(tgt, tgtParent);
    this.dragKey = null;
    this.dragKind = null;
    if (!srcKey || !srcKind || !plan) return;
    this.snapshot();
    this.applyReparent(srcKey, srcKind, plan.parentNode);
    this.reorderInto(plan.parentKey, srcKey, plan.beforeKey);
    if (plan.parentNode) this.expandedKeys.add(plan.parentNode.key);
    void this.persist();
    this.rerender();
  }

  /** Re-home a node under a new parent. Manual nodes move their storage bucket;
   *  derived nodes get a `parent` override. Areas don't reparent (root only). */
  private applyReparent(srcKey: string, srcKind: LocNode['kind'], newParent: LocNode | null): void {
    if (srcKind === 'town' || !newParent) return;
    const manual = !!findNode(this.composed, srcKey)?.node.manual;
    if (srcKind === 'building') {
      if (manual) {
        const e = this.manualBuildingEntry(srcKey);
        if (e) {
          e.list.splice(e.list.indexOf(e.entry), 1);
          (this.doc.buildings[newParent.townKey!] ??= []).push(e.entry);
        }
        delete this.doc.parent[srcKey];
      } else {
        this.doc.parent[srcKey] = newParent.key;
      }
    } else {
      // room
      if (manual) {
        const e = this.manualRoomEntry(srcKey);
        if (e) {
          e.list.splice(e.list.indexOf(e.entry), 1);
          (this.doc.rooms[newParent.key] ??= []).push(e.entry);
        }
        delete this.doc.parent[srcKey];
      } else {
        this.doc.parent[srcKey] = newParent.key;
      }
    }
  }

  /** Record the sibling order under `parentKey` with `srcKey` at the drop spot. */
  private reorderInto(parentKey: string, srcKey: string, beforeKey: string | null): void {
    const siblings =
      parentKey === ROOT_KEY
        ? this.composed.map((n) => n.key)
        : (findNode(this.composed, parentKey)?.node.children ?? []).map((c) => c.key);
    const keys = siblings.filter((k) => k !== srcKey);
    const i = beforeKey ? keys.indexOf(beforeKey) : -1;
    if (i >= 0) keys.splice(i, 0, srcKey);
    else keys.push(srcKey);
    this.doc.order[parentKey] = keys;
  }

  // --- context menu + pickers ------------------------------------------------

  private onGlobalMouseDown = (e: MouseEvent): void => {
    if (this.menuEl && !this.menuEl.contains(e.target as Node)) this.closeMenu();
  };

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  private openMenu(node: LocNode, parent: LocNode | null, x: number, y: number): void {
    this.closeMenu();
    const items: { label: string; fn: () => void; danger?: boolean }[] = [];
    if (node.kind === 'town') {
      items.push({ label: '＋ Add building', fn: () => this.addBuilding(node) });
      items.push({ label: '✎ Rename area', fn: () => this.startRename(node, parent) });
      if (node.manual) {
        items.push({ label: '▢ Set bounds (marquee)', fn: () => this.setAreaBounds(node) });
        items.push({ label: '🗑 Delete area', fn: () => this.remove(node, parent), danger: true });
      }
    } else if (node.kind === 'building') {
      items.push({ label: '＋ Add room', fn: () => this.addRoom(node) });
      items.push({ label: '✎ Rename', fn: () => this.startRename(node, parent) });
      items.push({ label: '⧉ Duplicate', fn: () => this.duplicate(node, parent) });
      if (node.manual) {
        items.push({ label: '▣ Set thumbnail', fn: () => this.setThumbnail(node) });
        items.push({
          label: node.roomId ? '🔗 Re-link room…' : '🔗 Link to room…',
          fn: () => this.linkRoom(node),
        });
      }
      items.push({
        label: node.manual ? '🗑 Delete' : '✕ Hide',
        fn: () => this.remove(node, parent),
        danger: true,
      });
    } else {
      items.push({ label: '✎ Rename', fn: () => this.startRename(node, parent) });
      items.push({ label: '⧉ Duplicate', fn: () => this.duplicate(node, parent) });
      if (node.manual) {
        items.push({
          label: node.roomId ? '🔗 Re-link room…' : '🔗 Link to room…',
          fn: () => this.linkRoom(node),
        });
      }
      items.push({
        label: node.manual ? '🗑 Delete' : '✕ Hide',
        fn: () => this.remove(node, parent),
        danger: true,
      });
    }

    const menu = document.createElement('div');
    menu.style.cssText =
      'position:fixed;z-index:100;min-width:150px;background:#141a22;border:1px solid #3a4a5a;' +
      'border-radius:4px;padding:3px;font:11px monospace;box-shadow:0 4px 14px #000a;';
    for (const it of items) {
      const row = document.createElement('div');
      row.textContent = it.label;
      row.style.cssText = `padding:4px 8px;border-radius:3px;cursor:pointer;color:${it.danger ? '#ff9a8a' : '#cde'};`;
      row.onmouseenter = () => (row.style.background = '#243447');
      row.onmouseleave = () => (row.style.background = '');
      row.onclick = () => {
        this.closeMenu();
        it.fn();
      };
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    // Keep the menu on-screen.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
    this.menuEl = menu;
  }

  /** Find a node's live row and start inline rename on its label. */
  private startRename(node: LocNode, parent: LocNode | null): void {
    const label = this.rowLabels.get(node.key);
    if (label) this.renameNode(node, parent, label);
  }

  /** A tiny searchable list popup (for picking a room to link). Empty value clears. */
  private openListPicker(
    options: { label: string; value: string }[],
    onPick: (value: string) => void
  ): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.style.cssText =
      'position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:101;width:240px;' +
      'max-height:60vh;overflow:auto;background:#141a22;border:1px solid #e8a33d;border-radius:5px;' +
      'padding:6px;font:11px monospace;box-shadow:0 6px 20px #000b;';
    const mk = (label: string, value: string, color: string) => {
      const row = document.createElement('div');
      row.textContent = label;
      row.style.cssText = `padding:4px 8px;border-radius:3px;cursor:pointer;color:${color};`;
      row.onmouseenter = () => (row.style.background = '#243447');
      row.onmouseleave = () => (row.style.background = '');
      row.onclick = () => {
        this.closeMenu();
        onPick(value);
      };
      return row;
    };
    menu.appendChild(mk('(clear link)', '', '#9fb8cc'));
    for (const o of options) menu.appendChild(mk(o.label, o.value, '#cde'));
    document.body.appendChild(menu);
    this.menuEl = menu;
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
    this.closeMenu();
    window.removeEventListener('mousedown', this.onGlobalMouseDown, true);
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
    const box = (r: RoomJson) => r.rect ?? r.regions?.[0] ?? { x: 0, y: 0, w: 0, h: 0 };
    const at = (r: RoomJson) => ({ x: r.spawn?.x ?? box(r).x, y: r.spawn?.y ?? box(r).y });
    if (!tnode) {
      const a = at(list[0]);
      tnode = {
        label: TOWN_LABEL[town] ?? town,
        title: `${list.length} instanced rooms`,
        x: a.x,
        y: a.y,
        kind: 'town',
        key: `t:${town}`,
        townKey: town,
        children: [],
      };
      tree.push(tnode);
    }
    tnode.children ??= [];
    const a0 = at(list[0]);
    tnode.children.push({
      label: `Custom Rooms (${list.length})`,
      title: 'authored room copies',
      x: a0.x,
      y: a0.y,
      kind: 'building',
      key: `t:${town}|instanced`,
      children: list.map((r) => {
        const a = at(r);
        return {
          label: r.label,
          title: `${r.id} · spawn (${a.x},${a.y})`,
          x: a.x,
          y: a.y,
          kind: 'room' as const,
          key: `room:${r.id}`,
        };
      }),
    });
  }
  return tree;
}

async function loadPlaces(): Promise<PlacesDoc> {
  try {
    // The Places outline lives in the DB now (world_docs / GET /api/world/places).
    const d = (await loadWorldDoc<Partial<PlacesDoc>>('places')) ?? {};
    return {
      version: d.version ?? 1,
      hidden: d.hidden ?? [],
      moved: d.moved ?? {},
      labels: d.labels ?? {},
      buildings: d.buildings ?? {},
      rooms: d.rooms ?? {},
      areas: d.areas ?? [],
      parent: d.parent ?? {},
      order: d.order ?? {},
    };
  } catch {
    return structuredClone(EMPTY_PLACES);
  }
}

async function postPlaces(doc: PlacesDoc): Promise<void> {
  // PUT /api/world/places — admin-gated on the server (trusted localhost in dev).
  await saveWorldDoc('places', doc);
}

/** Locate a node (and its parent) anywhere in the tree by key. */
function findNode(
  nodes: LocNode[],
  key: string,
  parent: LocNode | null = null
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

/** Locate a node plus the exact array that holds it (for detach on reparent). */
function locate(
  tree: LocNode[],
  key: string,
  arr: LocNode[] = tree
): { node: LocNode; arr: LocNode[] } | null {
  for (const n of arr) {
    if (n.key === key) return { node: n, arr };
    if (n.children) {
      const hit = locate(tree, key, n.children);
      if (hit) return hit;
    }
  }
  return null;
}

/** Re-sort `children` by the authored order list for `key` (unknown keys keep
 *  their relative order at the end). Pure — returns a new array. */
function applyOrder(doc: PlacesDoc, key: string, children: LocNode[]): LocNode[] {
  const ord = doc.order[key];
  if (!ord || ord.length === 0) return children;
  const idx = new Map(ord.map((k, i) => [k, i]));
  return [...children].sort(
    (a, b) =>
      (idx.has(a.key) ? idx.get(a.key)! : Number.MAX_SAFE_INTEGER) -
      (idx.has(b.key) ? idx.get(b.key)! : Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Layer the authored overrides over a fresh clone of the door-derived tree:
 * append manual areas/buildings/rooms, apply moved anchors + renames, drop
 * hidden links, re-home reparented nodes, and apply the authored sort order.
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

  // 0. Manual top-level areas — empty until buildings are added/dragged in.
  for (const ma of doc.areas) {
    tree.push({
      label: ma.label,
      title: `area (${ma.x},${ma.y}) · manual`,
      x: ma.x,
      y: ma.y,
      kind: 'town',
      key: ma.id,
      townKey: ma.id,
      manual: true,
      bounds: ma.bounds,
      children: [],
    });
  }

  // 1. Inject manual buildings/rooms and apply per-node overrides.
  for (const town of tree) {
    town.children ??= [];
    for (const mb of doc.buildings[town.townKey!] ?? []) {
      town.children.push({
        label: mb.label,
        title: `entrance (${mb.x},${mb.y}) · manual`,
        x: mb.x,
        y: mb.y,
        kind: 'building',
        key: mb.id,
        manual: true,
        thumb: { x: mb.x, y: mb.y },
        thumbRect: mb.thumbRect,
        roomId: mb.roomId,
        children: [],
      });
    }
    for (const b of town.children) {
      b.children ??= [];
      for (const mr of doc.rooms[b.key] ?? []) {
        b.children.push({
          label: mr.label,
          title: `dest (${mr.x},${mr.y}) · manual`,
          x: mr.x,
          y: mr.y,
          kind: 'room',
          key: mr.id,
          manual: true,
          roomId: mr.roomId,
        });
      }
      b.children = b.children.filter((r) => !hidden.has(r.key));
      b.children.forEach(applyMoved);
      b.children.forEach((r) => {
        const l = doc.labels[r.key];
        if (l) r.label = l;
      });
      applyMoved(b);
      const bl = doc.labels[b.key];
      if (bl) b.label = bl;
    }
    town.children = town.children.filter((b) => !hidden.has(b.key));
  }

  // 2. Reparent pass — re-home any node onto a new parent (works for derived
  //    AND manual nodes). A building may only land under a town, a room under a
  //    building; anything else is ignored so the tree stays well-formed.
  for (const [childKey, newParentKey] of Object.entries(doc.parent)) {
    const found = locate(tree, childKey);
    const target = findNode(tree, newParentKey);
    if (!found || !target) continue;
    const child = found.node;
    const tp = target.node;
    if (child.kind === 'town') continue;
    if (child.kind === 'building' && tp.kind !== 'town') continue;
    if (child.kind === 'room' && tp.kind !== 'building') continue;
    const i = found.arr.indexOf(child);
    if (i >= 0) found.arr.splice(i, 1);
    (tp.children ??= []).push(child);
  }

  // 3. Order pass — top-level areas, then each town's buildings, then rooms.
  const ordered = applyOrder(doc, ROOT_KEY, tree);
  for (const town of ordered) {
    town.children = applyOrder(doc, town.key, town.children ?? []);
    for (const b of town.children) {
      b.children = applyOrder(doc, b.key, b.children ?? []);
    }
    // Refresh the building count + apply any area-name override.
    const base = doc.labels[town.key] ?? TOWN_LABEL[town.townKey!] ?? town.townKey!;
    town.label = `${base} (${town.children.length})`;
  }
  return ordered;
}
