/**
 * Rooms — the registry of standalone interior rooms in the stitched map.
 *
 * EarthBound reuses ONE interior template for many shops/houses, picking the
 * clerk per-door at runtime. Our open world can't do that with a single shared
 * region (two players entering two different burger shops would land in the same
 * room). So the extractor STAMPS a copy of each reused interior — one per
 * exterior entrance — into an "interiors band" appended below the overworld (the
 * map grows in height only; see MapManager / setMapDimensions). Each copy is a
 * real, distinct region of the plane, so the existing renderer, collision,
 * room-crop, doors, and area-of-interest networking all work unchanged, and two
 * players in two different shops are simply at different world coordinates.
 *
 * This module is the index over those regions: it maps a world point to the room
 * that contains it, tracks the active room, and lists rooms grouped by town then
 * type for the editor's room navigator. The overworld is IMPLICIT — any point
 * not inside a registered room rect is the overworld (`null` here, id "world").
 *
 * rooms.json is OUR generated/authored metadata (pure ids/coords, no ROM
 * pixels): produced by tools/extract_rooms (the stamping pass) and editable via
 * the editor. Absent file ⇒ empty registry ⇒ behaves exactly like the
 * pre-rooms overworld-only world.
 */

import { loadJSON } from './AssetLoader';

/** Stable id of the implicit overworld "room". */
export const WORLD_ROOM_ID = 'world';

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
  /** Interior category: "shop" | "house" | "hospital" | "dungeon" | … — the
   *  second navigator level. */
  type?: string | null;
  /** The room's region in the (extended) plane. */
  rect: RoomRect;
  /** Arrival point inside the room (the entrance door's destination). */
  spawn?: { x: number; y: number; dir: number };
}

interface RoomsFile {
  version: number;
  rooms: RoomDef[];
}

let rooms: RoomDef[] = [];
let activeRoomId: string = WORLD_ROOM_ID;

export async function loadRooms(): Promise<void> {
  let file: RoomsFile | null = null;
  try {
    file = await loadJSON<RoomsFile>('/assets/map/rooms.json');
  } catch {
    file = null; // not extracted yet — overworld-only world
  }
  rooms = Array.isArray(file?.rooms) ? file!.rooms : [];
  console.log(`Rooms: ${rooms.length} interior room(s) loaded`);
}

/** The room containing a world point, or null when the point is the overworld. */
export function roomAt(worldX: number, worldY: number): RoomDef | null {
  for (const r of rooms) {
    const { x, y, w, h } = r.rect;
    if (worldX >= x && worldX < x + w && worldY >= y && worldY < y + h) return r;
  }
  return null;
}

/** Room id for a world point ("world" when on the overworld). */
export function roomIdAt(worldX: number, worldY: number): string {
  return roomAt(worldX, worldY)?.id ?? WORLD_ROOM_ID;
}

export function getRoom(id: string): RoomDef | null {
  return rooms.find((r) => r.id === id) ?? null;
}

export function getActiveRoomId(): string {
  return activeRoomId;
}

/** Set the active room from a world point. Returns true if it changed. */
export function setActiveRoomFromPoint(worldX: number, worldY: number): boolean {
  const id = roomIdAt(worldX, worldY);
  if (id === activeRoomId) return false;
  activeRoomId = id;
  return true;
}

export function listRooms(): readonly RoomDef[] {
  return rooms;
}

/** Rooms grouped town → type → rooms, for the editor navigator. */
export function roomsByTownAndType(): Map<string, Map<string, RoomDef[]>> {
  const byTown = new Map<string, Map<string, RoomDef[]>>();
  for (const r of rooms) {
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
