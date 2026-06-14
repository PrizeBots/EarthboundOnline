/**
 * Rooms — the registry of CUSTOM authored interior rooms.
 *
 * EarthBound does not reuse interiors between separate buildings (verified by
 * tracing the door table and the script-warp doors), so this isn't about
 * de-duplicating shared rooms. It's the substrate for AUTHORING new rooms that
 * don't exist in the ROM: a room is copied from an existing interior template
 * into an "interiors band" appended below the overworld (the map grows in height
 * only; see MapManager / setMapDimensions), then edited and wired to new doors.
 * Width is fixed at 256, so each copy is a real, distinct region and the existing
 * renderer, collision, room-crop, doors, and area-of-interest networking all
 * work unchanged.
 *
 * This module is the index over those regions: it maps a world point to the room
 * that contains it, tracks the active room, and lists rooms grouped by town then
 * type for the editor's Places column. The overworld is IMPLICIT — any point not
 * inside a registered room rect is the overworld (`null` here, id "world").
 *
 * rooms.json is OUR authored metadata (pure ids/coords, no ROM pixels). Absent
 * file ⇒ empty registry ⇒ behaves exactly like the overworld-only world (the
 * current state until rooms are authored).
 */

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

let rooms: RoomDef[] = [];
let activeRoomId: string = WORLD_ROOM_ID;

/**
 * Populate the registry with the absolute room definitions MapManager builds
 * from the custom-rooms band (overrides/rooms.json). Called once after the map
 * loads; empty list ⇒ overworld-only.
 */
export function setRoomList(list: RoomDef[]): void {
  rooms = list;
  console.log(`Rooms: ${rooms.length} custom room(s) registered`);
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
