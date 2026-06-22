import { loadJSON } from './AssetLoader';
import { RoomBounds } from './Camera';
import { checkCollision, setDoorCells } from './Collision';
import { MINITILE_SIZE, MAP_WIDTH_TILES } from '../types';
import { DEFAULT_DOOR_SFX, normalizeDoorSfx } from './DoorSfx';
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
  /** Sound effect id played when the player uses the door (see DoorSfx.ts). */
  sfx: string;
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
    {
      worldX?: number;
      worldY?: number;
      destX: number;
      destY: number;
      destDir: number;
      style: number;
      sfx?: string;
    } | null
  >;
  additions?: {
    worldX: number;
    worldY: number;
    destX: number;
    destY: number;
    destDir: number;
    style: number;
    sfx?: string;
  }[];
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
  /** Sound effect id played when the door is used (see DoorSfx.ts). */
  sfx: string;
  /** style=0 short-range zone door — inactive unless an override links it. */
  zone: boolean;
}

/**
 * An escalator/stairway trigger. EB's `EscalatorOrStairwayDoor` is NOT a warp —
 * it carries no destination, only a diagonal `direction` (CoilSnake
 * StairDirection: NW=0, NE=0x100, SW=0x200, SE=0x300). The floors are stacked
 * CONTIGUOUSLY in the tilemap and the steps are SOLID; stepping a trigger
 * auto-walks the player diagonally across the (solid) steps to the PAIRED
 * trigger at the far end of the ramp. Every ROM stair pairs along its diagonal
 * (audited: all directional ends march to a partner; all NOWHERE ends are some
 * directional's partner), so the destination is fully deterministic — computed
 * once at load (see loadDoors), not guessed at ride time. There is no warp.
 */
export interface StairData {
  worldX: number;
  worldY: number;
  // Ride direction toward the paired landing, and that landing's world coords.
  // (0,0)/self when this trigger has no partner — Game then starts no ride.
  // EB `StairDirection.NOWHERE` (0x8000) ends carry no encoded diagonal; their
  // direction is the REVERSE of the partner that points at them (set at load).
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  destX: number;
  destY: number;
}

// StairDirection value -> diagonal unit vector. NOWHERE (0x8000) is absent on
// purpose — it has no fixed diagonal and is handled separately (see nowhere).
const STAIR_DIR_VEC: Record<number, { dx: -1 | 1; dy: -1 | 1 }> = {
  0x000: { dx: -1, dy: -1 }, // NW
  0x100: { dx: 1, dy: -1 }, // NE
  0x200: { dx: -1, dy: 1 }, // SW
  0x300: { dx: 1, dy: 1 }, // SE
};
const STAIR_NOWHERE = 0x8000;

// A stair trigger while it's being paired at load time (carries its raw ROM
// direction + its resolved ride vector/destination).
interface FlatStair {
  worldX: number;
  worldY: number;
  dir: number;
  area: number;
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  destX: number;
  destY: number;
}

// March the 45° diagonal (dx,dy) from `from` and return the nearest OTHER stair
// trigger it passes over — the paired landing. Every ROM stair pairs this way
// (the two ends of a ramp sit on the same diagonal); used once per stair at load.
function marchToPartner(
  from: FlatStair,
  dx: -1 | 1,
  dy: -1 | 1,
  all: FlatStair[]
): FlatStair | null {
  const STEP = MINITILE_SIZE;
  for (let s = 1; s <= 64; s++) {
    const px = from.worldX + dx * STEP * s;
    const py = from.worldY + dy * STEP * s;
    for (const cand of all) {
      if (cand === from) continue;
      // Skip anything still touching the start (a paired up/down trigger sits
      // right next to us); we want the OTHER end of the ramp.
      if (
        Math.abs(cand.worldX - from.worldX) <= STAIR_TRIGGER &&
        Math.abs(cand.worldY - from.worldY) <= STAIR_TRIGGER
      )
        continue;
      if (
        Math.abs(cand.worldX - px) <= STAIR_TRIGGER + 1 &&
        Math.abs(cand.worldY - py) <= STAIR_TRIGGER + 1
      )
        return cand;
    }
  }
  return null;
}

// Resolve every stair's paired landing in one pass. A directional end marches its
// encoded diagonal to its partner; if that partner is a NOWHERE landing (no
// encoded direction of its own) it inherits the REVERSE vector — it just rides
// back the way it came. Stairs with no partner keep dx=dy=0 (Game starts no ride).
function pairStairs(stairs: FlatStair[]): void {
  for (const s of stairs) {
    const vec = STAIR_DIR_VEC[s.dir];
    if (!vec) continue; // NOWHERE end — gets resolved as some directional's partner
    const partner = marchToPartner(s, vec.dx, vec.dy, stairs);
    if (!partner) continue;
    s.dx = vec.dx;
    s.dy = vec.dy;
    s.destX = partner.worldX;
    s.destY = partner.worldY;
    if (!STAIR_DIR_VEC[partner.dir]) {
      partner.dx = -vec.dx as -1 | 1;
      partner.dy = -vec.dy as -1 | 1;
      partner.destX = s.worldX;
      partner.destY = s.worldY;
    }
  }
}

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
        d.style === 0 &&
        Math.abs(destPx - (baseX - MINITILE_SIZE)) + Math.abs(destPy - (baseY - 4)) < 128;

      editorBase.push({
        key,
        worldX: baseX,
        worldY: baseY,
        destX: destPx,
        destY: destPy,
        destDir: d.destDir ?? 0,
        style: d.style ?? 0,
        sfx: DEFAULT_DOOR_SFX,
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
        sfx: normalizeDoorSfx(o?.sfx),
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
      sfx: normalizeDoorSfx(a.sfx),
    });
  });

  // Register every door's minitiles (mat cells + destination) with Collision:
  // the room flood's pocket merge uses them to tell real neighboring rooms
  // (which always have a door) from enclosed clerk pockets (which never do).
  // Built from the RAW table — a flag-inactive door still marks a real room.
  const MAP_W_MT = MAP_WIDTH_TILES * 4;
  const AREA_MT = DOOR_AREA_PX / MINITILE_SIZE;
  const cells = new Set<number>();
  // Escalator/stairway triggers: a diagonal `direction` and NO destination — the
  // player rides the (walkable) ramp to the PAIRED trigger at its far end. Collect
  // them flat first, then pair each along its diagonal (one deterministic pass) so
  // the ride glides straight to a known landing — no runtime guessing. Game owns
  // the ride (see getStairAt). The floors are contiguous in map coords; the ride
  // never warps.
  stairsByArea = raw.map(() => []);
  const flatStairs: FlatStair[] = [];
  raw.forEach((area, idx) => {
    const ox = (idx % DOOR_GRID_COLS) * AREA_MT;
    const oy = Math.floor(idx / DOOR_GRID_COLS) * AREA_MT;
    for (const d of area) {
      if (d.type === 'stair') {
        const dir = d.direction ?? -1;
        if (dir !== STAIR_NOWHERE && !STAIR_DIR_VEC[dir]) continue; // invalid direction
        const worldX = (ox + d.x) * MINITILE_SIZE + MINITILE_SIZE / 2;
        const worldY = (oy + d.y) * MINITILE_SIZE + MINITILE_SIZE / 2;
        flatStairs.push({
          worldX,
          worldY,
          dir,
          area: idx,
          dx: 0,
          dy: 0,
          destX: worldX,
          destY: worldY,
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
  pairStairs(flatStairs);
  for (const s of flatStairs) {
    stairsByArea[s.area].push({
      worldX: s.worldX,
      worldY: s.worldY,
      dx: s.dx,
      dy: s.dy,
      destX: s.destX,
      destY: s.destY,
    });
  }
  for (const o of Object.values(edits)) {
    if (!o) continue;
    cells.add(Math.floor(o.destY / MINITILE_SIZE) * MAP_W_MT + Math.floor(o.destX / MINITILE_SIZE));
  }
  for (const a of additions) {
    cells.add(
      Math.floor(a.worldY / MINITILE_SIZE) * MAP_W_MT + Math.floor(a.worldX / MINITILE_SIZE)
    );
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
