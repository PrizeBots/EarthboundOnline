/**
 * Rooms — the registry of spatial identity. ONE point→room resolver that every
 * other system consumes (camera crop, music, Places navigator, shops, scripting).
 *
 * There are two SOURCES of rooms, merged into one registry:
 *
 *  1. CUSTOM rooms (setRoomList) — net-new authored interiors stamped into the
 *     appended "interiors band" below the overworld by RoomBuilderTool. EarthBound
 *     does not reuse interiors between buildings, so this isn't de-duplication: a
 *     room is copied from a template into the band (the map grows in height only;
 *     see MapManager / buildCustomRoomBand), then edited and wired to new doors.
 *     Width is fixed at 256, so each copy is a real, distinct region. These carry a
 *     single `rect` (their band footprint). Source of truth: overrides/rooms.json.
 *
 *  2. REGION rooms (setRegionRooms) — identity + typed props (name/type/bgm)
 *     painted over EXISTING map: overworld bgm zones (seeded from the music areas)
 *     and ROM interiors. These carry `regions[]` (one or more rects) and no band
 *     geometry. Source of truth: the DB 'rooms' world doc (Phase 1+).
 *
 * roomAt() scans the UNION of both. The overworld is IMPLICIT — any point in no
 * registered room is the overworld (`null` here, id "world"). When the active room
 * changes, room:enter / room:exit fire on the EventBus (the scripting/flag spine).
 *
 * rooms.json + the 'rooms' doc are OUR authored metadata (pure ids/coords, no ROM
 * pixels). Absent ⇒ empty registry ⇒ behaves exactly like the overworld-only world.
 */

import { emitGameEvent } from './EventBus';
import { loadWorldDoc } from './Auth';
import { SECTOR_TILES_X, SECTOR_TILES_Y, TILE_SIZE } from '../types';

/** Stable id of the implicit overworld "room". */
export const WORLD_ROOM_ID = 'world';

/** One sector in world pixels (EB's native 8×4-tile grid cell). A room is a set
 *  of these — sectors partition the map, each belongs to exactly one room. */
export const SECTOR_W_PX = SECTOR_TILES_X * TILE_SIZE; // 256
export const SECTOR_H_PX = SECTOR_TILES_Y * TILE_SIZE; // 128

/** A sector grid coordinate (column, row). */
export type SectorCoord = [number, number];

/** Sector (col,row) → its world-pixel rect. */
export function sectorRect(col: number, row: number): RoomRect {
  return { x: col * SECTOR_W_PX, y: row * SECTOR_H_PX, w: SECTOR_W_PX, h: SECTOR_H_PX };
}

/** The sector (col,row) a world point falls in. */
export function sectorOfPoint(worldX: number, worldY: number): SectorCoord {
  return [Math.floor(worldX / SECTOR_W_PX), Math.floor(worldY / SECTOR_H_PX)];
}

const sectorKey = (col: number, row: number): string => col + ',' + row;

/** The typed vocabulary for room behavior. Band rooms born in RoomBuilder use
 *  'custom' today; migrate → 'other'. Kept as a loose `string` on RoomDef so
 *  existing data never fails to load — this is the intended set, not a hard gate. */
export type RoomType =
  | 'overworld'
  | 'shop'
  | 'hospital'
  | 'hotel'
  | 'house'
  | 'bedroom'
  | 'dungeon'
  | 'other';

export interface RoomRect {
  x: number; // world pixels (top-left)
  y: number;
  w: number;
  h: number;
}

export interface RoomDef {
  /** Stable unique id, e.g. "onett_burger". */
  id: string;
  /** Display name shown in the editor, e.g. "Burger Shop". */
  label: string;
  /** Grouping key for the navigator: "onett", "twoson", … (interiors inherit
   *  the town of their entrance door). Null/absent ⇒ "(unsorted)". */
  town?: string | null;
  /** Interior category (RoomType vocabulary): "shop" | "house" | … — the second
   *  navigator level and the key behaviors read. Loose string for back-compat. */
  type?: string | null;
  /** Custom-room footprint in the (extended) plane. Present on custom rooms. */
  rect?: RoomRect;
  /** Region room footprint — one or more rects (L-shaped rooms = multiple).
   *  Present on region rooms; takes precedence over `rect` when both exist.
   *  For sector rooms this is DERIVED from `sectors` (one rect per sector) so
   *  rect-based consumers (camera crop, music hysteresis) keep working. */
  regions?: RoomRect[];
  /** Sector-room membership — the EB sectors (col,row) this room owns. The source
   *  of truth for region rooms authored in the Room Manager: sectors partition the
   *  map (each sector belongs to exactly ONE room), so `roomAt` is an O(1) sector
   *  lookup. `regions` is derived from this. Absent on legacy rect-only rooms. */
  sectors?: SectorCoord[];
  /** Per-room BGM (SPC song number). null/absent ⇒ inherit the sector's musicId. */
  bgm?: number | null;
  /** Arrival point inside the room (the entrance door's destination). */
  spawn?: { x: number; y: number; dir: number };

  // Type-specific props (only the field(s) matching `type` are meaningful). Kept
  // as a flat optional set rather than a discriminated union so loading never
  // fails on partial data; the Room Manager shows/hides them by `type`.
  storeId?: number; // type:'shop' — the store this room opens
  healCost?: number; // type:'hospital' — money to heal (0/absent = free)
  cost?: number; // type:'hotel' — money to sleep
  wakeBgm?: number; // type:'hotel' — song after waking
  bedroomWarp?: { x: number; y: number; dir: number }; // type:'hotel' — sleep destination
  isSaveRoom?: boolean; // type:'bedroom' — save point
}

// Two sources, merged. Each setter replaces only its own slice so the other
// source is never clobbered (MapManager owns custom; Room Manager owns region).
let customRooms: RoomDef[] = [];
let regionRooms: RoomDef[] = [];
let activeRoomId: string = WORLD_ROOM_ID;

/** The merged registry roomAt/getRoom scan. */
function allRooms(): RoomDef[] {
  if (!regionRooms.length) return customRooms;
  if (!customRooms.length) return regionRooms;
  return [...customRooms, ...regionRooms];
}

// Sector (col,row key) → owning region-room id. Region rooms partition the map by
// sector (each sector ∈ exactly one room), so this is the O(1) roomAt fast path.
// Built from region rooms' sectors[]; also derives their regions[] (one rect per
// sector) so rect-based consumers (camera crop, music hysteresis) stay unchanged.
let sectorIndex = new Map<string, string>();
let regionById = new Map<string, RoomDef>();

function rebuildSectorIndex(): void {
  sectorIndex = new Map();
  regionById = new Map();
  for (const r of regionRooms) {
    regionById.set(r.id, r);
    if (r.sectors && r.sectors.length) {
      // Derive regions[] from sectors so camera/music keep reading rects.
      r.regions = r.sectors.map(([c, rw]) => sectorRect(c, rw));
      for (const [c, rw] of r.sectors) sectorIndex.set(sectorKey(c, rw), r.id);
    }
  }
}

/** The region-room id owning a sector (col,row), or null if unclaimed. Used by the
 *  Room Manager to enforce one-sector-one-room (steal-with-confirm). */
export function roomIdForSector(col: number, row: number): string | null {
  return sectorIndex.get(sectorKey(col, row)) ?? null;
}

/**
 * Populate the CUSTOM-room slice (the interiors band MapManager builds from
 * overrides/rooms.json). Called after the map loads; empty ⇒ overworld-only.
 * Merges with region rooms — does NOT clear them.
 */
export function setRoomList(list: RoomDef[]): void {
  customRooms = list;
  console.log(`Rooms: ${customRooms.length} custom + ${regionRooms.length} region room(s)`);
}

/**
 * Populate the REGION-room slice (the 'rooms' world doc — overworld bgm zones +
 * ROM interiors). Merges with custom rooms — does NOT clear them. The Room
 * Manager pushes its working set here for live updates without a reboot.
 */
export function setRegionRooms(list: RoomDef[]): void {
  regionRooms = list;
  rebuildSectorIndex();
  console.log(`Rooms: ${customRooms.length} custom + ${regionRooms.length} region room(s)`);
}

/**
 * Load region rooms from the DB 'rooms' world doc and register them. Called at
 * boot. Loopback-only route in dev; absent/empty in prod ⇒ no region rooms ⇒ the
 * game falls back to per-sector music (today's behavior). The prod read path is a
 * pre-launch item, same as the other overrides.
 */
export async function loadRegionRooms(): Promise<void> {
  try {
    const doc = await loadWorldDoc<{ rooms?: RoomDef[] }>('rooms');
    setRegionRooms(doc?.rooms ?? []);
  } catch {
    setRegionRooms([]);
  }
}

/** Every rect a room occupies (regions[] wins over rect when present). */
function rectsOf(r: RoomDef): RoomRect[] {
  if (r.regions && r.regions.length) return r.regions;
  return r.rect ? [r.rect] : [];
}

function rectContains(rc: RoomRect, x: number, y: number): boolean {
  return x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h;
}

/** Is a point inside any of a room's rects (optionally grown by `margin` px)?
 *  Used by music for sticky-at-the-seam hysteresis. */
export function pointInRoom(r: RoomDef, x: number, y: number, margin = 0): boolean {
  for (const rc of rectsOf(r)) {
    if (
      x >= rc.x - margin &&
      x < rc.x + rc.w + margin &&
      y >= rc.y - margin &&
      y < rc.y + rc.h + margin
    )
      return true;
  }
  return false;
}

/** Smallest area among a room's containing rects, or Infinity if none contain. */
function containingArea(r: RoomDef, x: number, y: number): number {
  let best = Infinity;
  for (const rc of rectsOf(r)) {
    if (rectContains(rc, x, y)) best = Math.min(best, rc.w * rc.h);
  }
  return best;
}

/**
 * The room containing a world point, or null on the overworld. When regions
 * overlap (e.g. a shop inside an overworld bgm zone) the MOST-SPECIFIC room —
 * the one with the smallest containing rect — wins, deterministically.
 */
export function roomAt(worldX: number, worldY: number): RoomDef | null {
  // Fast path: sector rooms partition the map 1:1 — one O(1) lookup, no overlap.
  if (sectorIndex.size) {
    const [c, rw] = sectorOfPoint(worldX, worldY);
    const id = sectorIndex.get(sectorKey(c, rw));
    if (id) return regionById.get(id) ?? null;
  }
  // Fallback: legacy rect rooms (custom band rooms; region rooms without sectors).
  // Sector rooms are index-only — skip them here so the two paths never disagree.
  let winner: RoomDef | null = null;
  let winnerArea = Infinity;
  for (const r of allRooms()) {
    if (r.sectors && r.sectors.length) continue;
    const a = containingArea(r, worldX, worldY);
    if (a < winnerArea) {
      winnerArea = a;
      winner = r;
    }
  }
  return winner;
}

/** Room id for a world point ("world" when on the overworld). */
export function roomIdAt(worldX: number, worldY: number): string {
  return roomAt(worldX, worldY)?.id ?? WORLD_ROOM_ID;
}

export function getRoom(id: string): RoomDef | null {
  if (id === WORLD_ROOM_ID) return null;
  return allRooms().find((r) => r.id === id) ?? null;
}

export function getActiveRoomId(): string {
  return activeRoomId;
}

/** The active room's def, or null on the overworld (for music/behaviors). */
export function getActiveRoom(): RoomDef | null {
  return getRoom(activeRoomId);
}

/**
 * Set the active room from a world point. Returns true if it changed. On change,
 * fires room:exit (old) then room:enter (new) on the EventBus — the trigger spine
 * scripting/flags ride on. "world" is a valid room id for these events.
 */
export function setActiveRoomFromPoint(worldX: number, worldY: number): boolean {
  const id = roomIdAt(worldX, worldY);
  if (id === activeRoomId) return false;
  const prev = activeRoomId;
  activeRoomId = id;
  emitGameEvent({ type: 'room:exit', room: prev });
  emitGameEvent({ type: 'room:enter', room: id });
  return true;
}

/** The CUSTOM rooms only (what the Places navigator injects today). */
export function listRooms(): readonly RoomDef[] {
  return customRooms;
}

/** The REGION rooms only (bgm zones + ROM interiors). */
export function listRegionRooms(): readonly RoomDef[] {
  return regionRooms;
}

/** The merged registry (custom + region). */
export function listAllRooms(): readonly RoomDef[] {
  return allRooms();
}

/** Rooms grouped town → type → rooms, for the editor navigator. */
export function roomsByTownAndType(): Map<string, Map<string, RoomDef[]>> {
  const byTown = new Map<string, Map<string, RoomDef[]>>();
  for (const r of allRooms()) {
    const town = r.town || '(unsorted)';
    const type = r.type || '(other)';
    let types = byTown.get(town);
    if (!types) byTown.set(town, (types = new Map()));
    let list = types.get(type);
    if (!list) types.set(type, (list = []));
    list.push(r);
  }
  return byTown;
}
