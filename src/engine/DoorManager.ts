import { loadJSON } from './AssetLoader';
import { RoomBounds } from './Camera';
import { checkCollision, setDoorCells, isSolidAtPoint } from './Collision';
import { isRoomCroppableTile } from './MapManager';
import { MINITILE_SIZE, TILE_SIZE, MAP_WIDTH_TILES } from '../types';
import worldFlags from '../world_flags.json';

// Event flags considered SET in our open world (see src/world_flags.json).
const WORLD_SET_FLAGS = new Set(worldFlags.setFlags.map((f) => parseInt(f, 16)));

/**
 * EB doors carry an event-flag condition: plain flag = usable while the flag
 * is SET, 0x8000 bit = usable while it is UNSET. Ignoring this activated the
 * intro-night "go home" zone doors (35 strips across Onett warping into
 * Ness's bedroom) and would dead-lock flag-gated house doors.
 */
function isDoorActive(flag: number): boolean {
  if (!flag) return true;
  const needSet = (flag & 0x8000) === 0;
  return needSet === WORLD_SET_FLAGS.has(flag & 0x7fff);
}


export interface DoorData {
  /** Stable identity: "worldX,worldY" of the BASE trigger anchor. */
  key: string;
  // Pixel position in world space
  worldX: number;
  worldY: number;
  type: string;
  // Destination in pixels (only for type === 'door')
  destX: number;
  destY: number;
  destDir: number;
  style: number;
}

/**
 * Editor-authored door overrides (public/overrides/doors.json — OUR data).
 * `edits` is keyed by the base trigger anchor "worldX,worldY": a value
 * replaces the door's destination (and optionally moves the trigger);
 * null disables the door. `additions` are net-new doors. Covers what the old
 * hand-coded ZONE_DOOR_OVERRIDES table did — (a) style=0 zone-transition
 * doors that need manual interior links, and (b) scripted doors whose stored
 * ROM dest is a dummy (EB runs the door's text script for the real warp,
 * e.g. the Tenda cave hole's {warp(59)}) — but as edited data. Dest values
 * are PIXELS (raw doors.json uses minitiles).
 * Mirrored by tools/debug_room_crop_check.py, which reads the same file.
 */
export interface DoorOverrides {
  version: number;
  edits?: Record<
    string,
    { worldX?: number; worldY?: number; destX: number; destY: number; destDir: number; style: number } | null
  >;
  additions?: { worldX: number; worldY: number; destX: number; destY: number; destDir: number; style: number }[];
}

/** A base door as the editor sees it (pre-override values, pixels). */
export interface EditorDoor {
  key: string;
  worldX: number;
  worldY: number;
  destX: number;
  destY: number;
  destDir: number;
  style: number;
  /** style=0 short-range zone door — inactive unless an override links it. */
  zone: boolean;
}

/**
 * An escalator/stairway trigger. EB's `EscalatorOrStairwayDoor` is NOT a warp —
 * it carries no destination, only a diagonal `direction` (CoilSnake
 * StairDirection: NW=0, NE=0x100, SW=0x200, SE=0x300). The floors are stacked
 * in the tilemap and the steps are SOLID; stepping a trigger auto-walks the
 * player diagonally across the (solid) steps to the landing on the next floor.
 */
export interface StairData {
  worldX: number;
  worldY: number;
  dx: -1 | 1; // diagonal step vector
  dy: -1 | 1;
}

// StairDirection value -> diagonal unit vector.
const STAIR_DIR_VEC: Record<number, { dx: -1 | 1; dy: -1 | 1 }> = {
  0x000: { dx: -1, dy: -1 }, // NW
  0x100: { dx: 1, dy: -1 }, // NE
  0x200: { dx: -1, dy: 1 }, // SW
  0x300: { dx: 1, dy: 1 }, // SE
};

// Raw JSON format from extraction
interface RawDoor {
  x: number; // minitile offset within door area
  y: number;
  type: string;
  destX?: number; // minitile coords in full map
  destY?: number;
  destDir?: number;
  style?: number;
  flag?: number;
  direction?: number;
}

// Door areas are a 32x40 grid, each 256x256 pixels (NOT 1:1 with sectors)
const DOOR_GRID_COLS = 32;
const DOOR_AREA_PX = 256; // each door area is 256x256 pixels

// All warpable doors indexed by door area
let doorsByArea: DoorData[][] = [];
// Escalator/stairway triggers indexed by door area (same 32-col grid).
let stairsByArea: StairData[][] = [];
// Pre-override view of every flag-active door, for the editor (incl. zone
// doors that are inactive without an override).
let editorBase: EditorDoor[] = [];

export async function loadDoors(): Promise<void> {
  const [raw, overrides] = await Promise.all([
    loadJSON<RawDoor[][]>('/assets/map/doors.json'),
    loadJSON<DoorOverrides>('/overrides/doors.json').catch(() => null),
  ]);
  const edits = overrides?.edits ?? {};
  const additions = overrides?.additions ?? [];
  editorBase = [];

  doorsByArea = raw.map((area, idx) => {
    const areaX = idx % DOOR_GRID_COLS;
    const areaY = Math.floor(idx / DOOR_GRID_COLS);
    const originX = areaX * DOOR_AREA_PX;
    const originY = areaY * DOOR_AREA_PX;

    const out: DoorData[] = [];
    for (const d of area) {
      if (d.type !== 'door') continue;
      if (!isDoorActive(d.flag ?? 0)) continue;

      // The ROM door cell is the LEFT minitile of a 16px-wide doorway
      // (verified against the rendered map in tools/debug_door_align.py),
      // so the trigger anchors at the doorway center: cell x + 8.
      // Vertically the cell IS the threshold row, so center within it (+4).
      const baseX = originX + d.x * MINITILE_SIZE + MINITILE_SIZE;
      const baseY = originY + d.y * MINITILE_SIZE + 4;
      const key = `${baseX},${baseY}`;

      // style=0 short-range zone transitions are inactive unless an override
      // links them somewhere real (their stored dest is the trigger itself).
      const destPx = (d.destX ?? 0) * MINITILE_SIZE;
      const destPy = (d.destY ?? 0) * MINITILE_SIZE;
      const zone =
        d.style === 0 && Math.abs(destPx - (baseX - MINITILE_SIZE)) + Math.abs(destPy - (baseY - 4)) < 128;

      editorBase.push({
        key,
        worldX: baseX,
        worldY: baseY,
        destX: destPx,
        destY: destPy,
        destDir: d.destDir ?? 0,
        style: d.style ?? 0,
        zone,
      });

      const o = edits[key];
      if (o === null) continue; // override-disabled door
      if (zone && !o) continue; // zone door with no authored link
      out.push({
        key,
        worldX: o?.worldX ?? baseX,
        worldY: o?.worldY ?? baseY,
        type: d.type,
        destX: o ? o.destX : destPx,
        destY: o ? o.destY : destPy,
        destDir: o ? o.destDir : (d.destDir ?? 0),
        style: o ? o.style : (d.style ?? 0),
      });
    }
    return out;
  });

  // Authored net-new doors, bucketed by their trigger area.
  additions.forEach((a, i) => {
    const idx =
      Math.floor(a.worldY / DOOR_AREA_PX) * DOOR_GRID_COLS + Math.floor(a.worldX / DOOR_AREA_PX);
    if (idx < 0 || idx >= doorsByArea.length) return;
    doorsByArea[idx].push({
      key: `+${i}`,
      worldX: a.worldX,
      worldY: a.worldY,
      type: 'door',
      destX: a.destX,
      destY: a.destY,
      destDir: a.destDir,
      style: a.style,
    });
  });

  // Register every door's minitiles (mat cells + destination) with Collision:
  // the room flood's pocket merge uses them to tell real neighboring rooms
  // (which always have a door) from enclosed clerk pockets (which never do).
  // Built from the RAW table — a flag-inactive door still marks a real room.
  const MAP_W_MT = MAP_WIDTH_TILES * 4;
  const AREA_MT = DOOR_AREA_PX / MINITILE_SIZE;
  const cells = new Set<number>();
  // Escalator/stairway triggers: a diagonal `direction` and NO destination —
  // the player rides the (walkable) ramp; Game owns the ride (see getStairAt).
  stairsByArea = raw.map(() => []);
  raw.forEach((area, idx) => {
    const ox = (idx % DOOR_GRID_COLS) * AREA_MT;
    const oy = Math.floor(idx / DOOR_GRID_COLS) * AREA_MT;
    for (const d of area) {
      if (d.type === 'stair') {
        const vec = STAIR_DIR_VEC[d.direction ?? -1];
        if (!vec) continue; // NOWHERE / invalid direction
        stairsByArea[idx].push({
          worldX: (ox + d.x) * MINITILE_SIZE + MINITILE_SIZE / 2,
          worldY: (oy + d.y) * MINITILE_SIZE + MINITILE_SIZE / 2,
          dx: vec.dx,
          dy: vec.dy,
        });
        continue;
      }
      if (d.type !== 'door') continue;
      // The ROM cell is the LEFT minitile of a 16px-wide doorway.
      cells.add((oy + d.y) * MAP_W_MT + ox + d.x);
      cells.add((oy + d.y) * MAP_W_MT + ox + d.x + 1);
      if (d.destX !== undefined && d.destY !== undefined) {
        cells.add(d.destY * MAP_W_MT + d.destX);
      }
    }
  });
  for (const o of Object.values(edits)) {
    if (!o) continue;
    cells.add(Math.floor(o.destY / MINITILE_SIZE) * MAP_W_MT + Math.floor(o.destX / MINITILE_SIZE));
  }
  for (const a of additions) {
    cells.add(Math.floor(a.worldY / MINITILE_SIZE) * MAP_W_MT + Math.floor(a.worldX / MINITILE_SIZE));
    cells.add(Math.floor(a.destY / MINITILE_SIZE) * MAP_W_MT + Math.floor(a.destX / MINITILE_SIZE));
  }
  setDoorCells(cells);

  const total = doorsByArea.reduce((n, a) => n + a.length, 0);
  const stairTotal = stairsByArea.reduce((n, a) => n + a.length, 0);
  console.log(`Loaded ${total} doors, ${stairTotal} stairs across ${doorsByArea.length} areas`);
}

/** Pre-override base doors for the editor (loadDoors must have run). */
export function getEditorDoorBase(): EditorDoor[] {
  return editorBase;
}

// Trigger half-size in pixels. X covers the full 16px doorway (center ±8).
const TRIGGER_X = 8;
const TRIGGER_Y = 8;

/**
 * Check if a position overlaps any door in nearby areas.
 * px, py = player feet position. We check from the midsection (py - 12).
 */
export function getDoorAt(px: number, py: number): DoorData | null {
  // Check from player midsection, not feet
  const checkY = py - 12;
  const ax = Math.floor(px / DOOR_AREA_PX);
  const ay = Math.floor(checkY / DOOR_AREA_PX);

  // Check current area and immediate neighbors (doors can be on edges)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cy < 0 || cx >= DOOR_GRID_COLS) continue;
      const idx = cy * DOOR_GRID_COLS + cx;
      if (idx < 0 || idx >= doorsByArea.length) continue;

      const doors = doorsByArea[idx];
      for (const door of doors) {
        const distX = Math.abs(px - door.worldX);
        const distY = Math.abs(checkY - door.worldY);
        if (distX <= TRIGGER_X && distY <= TRIGGER_Y) {
          return door;
        }
      }
    }
  }

  return null;
}

// Stair triggers are single minitiles; a tight box avoids snagging the player
// on the adjacent escalator of an up/down pair while walking past.
const STAIR_TRIGGER = 5;

/**
 * Check if the player's feet overlap an escalator/stairway trigger.
 * Returns its diagonal step vector, or null. px, py = feet position.
 */
export function getStairAt(px: number, py: number): StairData | null {
  const ax = Math.floor(px / DOOR_AREA_PX);
  const ay = Math.floor(py / DOOR_AREA_PX);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cy < 0 || cx >= DOOR_GRID_COLS) continue;
      const idx = cy * DOOR_GRID_COLS + cx;
      if (idx < 0 || idx >= stairsByArea.length) continue;
      for (const stair of stairsByArea[idx]) {
        if (
          Math.abs(px - stair.worldX) <= STAIR_TRIGGER &&
          Math.abs(py - stair.worldY) <= STAIR_TRIGGER
        ) {
          return stair;
        }
      }
    }
  }
  return null;
}

/**
 * The floor-change door an escalator/stairway delivers you to. EB escalators
 * are a short connecting SHAFT (solid-bounded walkable region) with a `door`
 * warp at the end that teleports to the next floor's map region. We flood the
 * shaft from the trigger and pick the door inside it that (a) warps to an
 * indoor/croppable floor (not the building's outdoor exit) and (b) lies in the
 * ride's vertical direction (an UP escalator → the highest floor = smallest
 * destY; DOWN → largest). Returns null for shafts that are too big to be a
 * clean escalator (e.g. open-floor banks) — the caller then just stops.
 */
export function getStairExit(px: number, py: number, dy: number): DoorData | null {
  const MAP_W_MT = MAP_WIDTH_TILES * 4;
  const seedX = Math.floor(px / MINITILE_SIZE);
  const seedY = Math.floor(py / MINITILE_SIZE);
  // Flood the shaft (bounded by solid). Cap small: a real escalator shaft is a
  // few dozen minitiles; a huge flood means we're on an open floor, not a shaft.
  const SHAFT_CAP = 200;
  const shaft = new Set<number>();
  const stack = [seedY * MAP_W_MT + seedX];
  while (stack.length) {
    const k = stack.pop()!;
    if (shaft.has(k)) continue;
    const mx = k % MAP_W_MT;
    const my = (k - mx) / MAP_W_MT;
    if (isSolidAtPoint(mx * MINITILE_SIZE + 4, my * MINITILE_SIZE + 4)) continue;
    shaft.add(k);
    if (shaft.size > SHAFT_CAP) return null; // not a clean shaft
    stack.push(k + 1, k - 1, k + MAP_W_MT, k - MAP_W_MT);
  }

  let best: DoorData | null = null;
  for (const area of doorsByArea) {
    for (const door of area) {
      const mtKey =
        Math.floor(door.worldY / MINITILE_SIZE) * MAP_W_MT +
        Math.floor(door.worldX / MINITILE_SIZE);
      if (!shaft.has(mtKey)) continue;
      const destTX = Math.floor(door.destX / TILE_SIZE);
      const destTY = Math.floor(door.destY / TILE_SIZE);
      if (!isRoomCroppableTile(destTX, destTY)) continue; // outdoor exit — skip
      // UP escalators climb toward smaller destY, DOWN toward larger.
      if (!best || (dy < 0 ? door.destY < best.destY : door.destY > best.destY)) {
        best = door;
      }
    }
  }
  return best;
}
