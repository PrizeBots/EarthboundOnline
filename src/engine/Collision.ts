import { loadJSON } from './AssetLoader';
import {
  getSector,
  getSectorForTile,
  getTileAt,
  getDrawTilesetId,
  isIndoorTile,
  isRoomCroppableTile,
} from './MapManager';
import { RoomBounds } from './Camera';
import {
  MINITILE_SIZE,
  TILE_SIZE,
  MAP_WIDTH_TILES,
  MAP_HEIGHT_TILES,
  MAP_WIDTH_SECTORS,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
} from '../types';

// collision[drawTilesetId][arrangementId] = 16 collision bytes (4x4 minitiles)
const collisionData = new Map<number, number[][]>();

/**
 * Editor-authored collision overrides (public/overrides/collision.json — OUR
 * data). Keyed by "drawTilesetId:arrangementId" -> { minitileIndex: byte }.
 * Edits are PER-ARRANGEMENT — the SNES model, where collision is an attribute
 * of the tile graphic — so one edit applies to EVERY map cell using that
 * arrangement (the Collision Painter shows the use count / blast radius).
 * Mirrored by server/npcSim.js and tools/debug_room_crop_check.py — keep all
 * three appliers in sync.
 */
export interface CollisionOverrides {
  version: number;
  /** Legacy PER-ARRANGEMENT edits: "drawTs:arr" -> { minitileIdx: byte }. */
  edits?: Record<string, Record<string, number>>;
  /**
   * PER-MAP-TILE edits: "tileX,tileY" -> { minitileIdx: byte }. These win over
   * the arrangement's bytes for that ONE map cell, so the painter can author a
   * single tile without changing every other cell that reuses the same tile
   * graphic. Mirrored by server/npcSim.js and the py room checker.
   */
  cells?: Record<string, Record<string, number>>;
  /** @deprecated Whole-tile FG promotion (pre-minitile model). No longer written:
   *  "Behind"/Hide is now the per-minitile 0x40 collision bit stored in `cells`.
   *  Kept so old saves still parse — the value is IGNORED on load. */
  foreground?: string[];
}

let collisionOverrides: CollisionOverrides | null = null;
let overridesLoading: Promise<void> | null = null;
// Pristine extracted rows for every (ts,arr) that overrides or live painting
// touched — the editor diffs against these so no-op edits drop out.
const pristineRows = new Map<string, number[]>();

// Per-map-tile collision overrides (the `cells` section), keyed by
// tileY*MAP_WIDTH_TILES+tileX -> Map<minitileIdx, byte>. Applied on top of the
// arrangement row in effectiveRow(), so a painted cell is the ONLY one affected.
const cellOverrides = new Map<number, Map<number, number>>();

// "Behind"/Hide is a per-minitile collision bit (0x40) in the effective row: the
// painter sets it through the normal cell-override layer, so it's minitile-
// granular and saved in `cells` like every other bit. A promoted minitile's art
// is redrawn (clipped) in front of behind-FG sprites (Renderer Pass 3b) AND
// grants whole-body priority to a sprite standing over it (getSpritePriority) —
// the one-paint "hide behind this" for BG buildings the ROM never made foreground.
export const FG_PROMOTE_BIT = 0x40;

function rebuildCellOverrides(): void {
  cellOverrides.clear();
  const cells = collisionOverrides?.cells ?? {};
  for (const [tk, idxMap] of Object.entries(cells)) {
    const [tx, ty] = tk.split(',').map(Number);
    const m = new Map<number, number>();
    for (const [idx, byte] of Object.entries(idxMap)) m.set(Number(idx), byte);
    cellOverrides.set(ty * MAP_WIDTH_TILES + tx, m);
  }
}

/** Minitile indices (0-15) of a map tile flagged "Behind"/Hide (0x40) — the
 *  renderer redraws these (clipped) in front of behind-FG sprites. Empty when
 *  none. Reads the effective row, so live paints show immediately. */
export function getPromotedMinitiles(tileX: number, tileY: number): number[] {
  const row = effectiveRow(tileX, tileY);
  if (!row) return [];
  const out: number[] = [];
  for (let i = 0; i < 16; i++) if ((row[i] & FG_PROMOTE_BIT) !== 0) out.push(i);
  return out;
}

/**
 * The effective 16-byte collision row for a map tile: the arrangement's row
 * (with any legacy per-arrangement edits already baked into collisionData) with
 * this cell's per-map-tile overrides applied on top. Null if the sector or
 * tileset data isn't loaded. Every collision read goes through here, so per-cell
 * paints affect gameplay, sprite priority, and room cropping at that cell only.
 */
const ZERO_ROW: readonly number[] = new Array(16).fill(0);

function effectiveRow(tileX: number, tileY: number): number[] | null {
  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return null; // off-map → caller treats as solid
  const collisions = collisionData.get(getDrawTilesetId(sector.tilesetId));
  if (!collisions) return null; // tileset not loaded → solid
  const arr = getTileAt(tileX, tileY);
  // Arrangement beyond the collision table = no data = non-solid (historically
  // skipped); per-cell overrides may still apply on top of an all-zero base.
  const base = arr < collisions.length ? collisions[arr] : ZERO_ROW;
  const ov = cellOverrides.get(tileY * MAP_WIDTH_TILES + tileX);
  if (!ov || ov.size === 0) return base as number[];
  const row = [...base];
  for (const [idx, byte] of ov) row[idx] = byte;
  return row;
}

function applyOverridesTo(drawTilesetId: number, data: number[][]): void {
  const edits = collisionOverrides?.edits ?? {};
  for (const [key, cells] of Object.entries(edits)) {
    const [ts, arr] = key.split(':').map(Number);
    if (ts !== drawTilesetId || arr >= data.length) continue;
    if (!pristineRows.has(key)) pristineRows.set(key, [...data[arr]]);
    const row = [...data[arr]];
    for (const [idx, byte] of Object.entries(cells)) row[Number(idx)] = byte;
    data[arr] = row;
  }
}

export async function loadCollision(drawTilesetId: number): Promise<void> {
  if (collisionData.has(drawTilesetId)) return;
  if (!overridesLoading) {
    overridesLoading = loadJSON<CollisionOverrides>('/overrides/collision.json')
      .then((ov) => {
        collisionOverrides = ov;
        rebuildCellOverrides();
      })
      .catch(() => {
        collisionOverrides = null; // nothing authored yet
        cellOverrides.clear();
      });
  }
  const [data] = await Promise.all([
    loadJSON<number[][]>(`/assets/tilesets/${drawTilesetId}/collisions.json`),
    overridesLoading,
  ]);
  applyOverridesTo(drawTilesetId, data);
  collisionData.set(drawTilesetId, data);
}

// --- Editor (dev) accessors -------------------------------------------------

/** The map cell under a world pixel as (drawTs, arrangement, minitile idx). */
export function getCollisionCellAt(
  worldX: number,
  worldY: number
): { drawTs: number; arr: number; idx: number } | null {
  const mtx = Math.floor(worldX / MINITILE_SIZE);
  const mty = Math.floor(worldY / MINITILE_SIZE);
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_TILES * 4) return null;
  const sector = getSectorForTile(mtx >> 2, mty >> 2);
  if (!sector) return null;
  const drawTs = getDrawTilesetId(sector.tilesetId);
  const arr = getTileAt(mtx >> 2, mty >> 2);
  const data = collisionData.get(drawTs);
  if (!data || arr >= data.length) return null;
  return { drawTs, arr, idx: (mty & 3) * 4 + (mtx & 3) };
}

/**
 * Per-tile collision painter accessors. The painter authors a single MAP CELL
 * (not the shared arrangement), so it works in (tileX, tileY, minitileIdx) and
 * its edits land in the per-map-tile override layer.
 */
export function getCellCollisionAt(
  worldX: number,
  worldY: number
): { tileX: number; tileY: number; idx: number; byte: number } | null {
  const mtx = Math.floor(worldX / MINITILE_SIZE);
  const mty = Math.floor(worldY / MINITILE_SIZE);
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_TILES * 4) return null;
  const tileX = mtx >> 2;
  const tileY = mty >> 2;
  const row = effectiveRow(tileX, tileY);
  if (!row) return null;
  const idx = (mty & 3) * 4 + (mtx & 3);
  return { tileX, tileY, idx, byte: row[idx] };
}

/** Effective 16-byte row (arrangement + per-cell overrides) — overlay drawing. */
export function getEffectiveRowAt(tileX: number, tileY: number): number[] | null {
  return effectiveRow(tileX, tileY);
}

/** The byte a cell reverts to when its per-tile override is cleared: the
 *  arrangement byte (legacy per-arrangement edits applied, per-cell NOT). */
export function getArrangementByteAt(tileX: number, tileY: number, idx: number): number | null {
  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return null;
  const data = collisionData.get(getDrawTilesetId(sector.tilesetId));
  if (!data) return null;
  const arr = getTileAt(tileX, tileY);
  if (arr >= data.length) return 0;
  return data[arr][idx];
}

/** Editor live paint: set one map-cell's per-tile collision byte. Gameplay and
 *  the room-crop preview read it immediately via effectiveRow. */
export function setCellCollisionLive(
  tileX: number,
  tileY: number,
  idx: number,
  byte: number
): void {
  const key = tileY * MAP_WIDTH_TILES + tileX;
  let m = cellOverrides.get(key);
  if (!m) {
    m = new Map();
    cellOverrides.set(key, m);
  }
  m.set(idx, byte);
}

/** Editor live paint: drop a map-cell's per-tile override (revert to arrangement). */
export function clearCellCollisionLive(tileX: number, tileY: number, idx: number): void {
  const key = tileY * MAP_WIDTH_TILES + tileX;
  const m = cellOverrides.get(key);
  if (!m) return;
  m.delete(idx);
  if (m.size === 0) cellOverrides.delete(key);
}

/** Current (live) 16-byte row of an arrangement, or null if not loaded. */
export function getCollisionRow(drawTs: number, arr: number): number[] | null {
  const data = collisionData.get(drawTs);
  if (!data || arr >= data.length) return null;
  return data[arr];
}

/** Editor live paint: set one minitile byte on a loaded arrangement. */
export function setCollisionByteLive(drawTs: number, arr: number, idx: number, byte: number): void {
  const data = collisionData.get(drawTs);
  if (!data || arr >= data.length) return;
  const key = `${drawTs}:${arr}`;
  if (!pristineRows.has(key)) pristineRows.set(key, [...data[arr]]);
  data[arr] = [...data[arr]];
  data[arr][idx] = byte;
}

/** The extracted (pre-override, pre-paint) byte, for editor diffing. */
export function getPristineCollisionByte(drawTs: number, arr: number, idx: number): number | null {
  const p = pristineRows.get(`${drawTs}:${arr}`);
  if (p) return p[idx];
  const data = collisionData.get(drawTs);
  if (!data || arr >= data.length) return null;
  return data[arr][idx];
}

// Door positions (warp mats AND destinations) as minitile keys, registered by
// DoorManager at load time. Used by the room flood's pocket merge: a walkable
// region with a door is a real neighboring room; one without is an enclosed
// pocket of the current room (clerk areas behind counters).
let doorCells: ReadonlySet<number> = new Set();

export function setDoorCells(cells: ReadonlySet<number>): void {
  doorCells = cells;
}

/**
 * Is the minitile at a world-pixel point solid? Used by the escalator/stairway
 * ride to detect the ramp's end (the walkable diagonal is bounded by solid at
 * each landing). The ride glides the player across, bypassing the room seal,
 * so it needs raw world collision, not `checkPlayerCollision`.
 */
export function isSolidAtPoint(worldX: number, worldY: number): boolean {
  return isMinitileSolid(Math.floor(worldX / MINITILE_SIZE), Math.floor(worldY / MINITILE_SIZE));
}

// The room the local player currently occupies. While set, walkable minitiles
// OUTSIDE the room act as solid for the player — packed interiors share
// walkable under-wall strips with their neighbors (see bugs.md, arcade/
// Tracy's-room), so rooms are sealed and only doors move you between them.
let activeRoomCells: ReadonlySet<number> | null = null;

export function setActiveRoom(bounds: RoomBounds | null): void {
  activeRoomCells = bounds?.cells ?? null;
}

/**
 * Collision check for the LOCAL PLAYER: world collision plus the active-room
 * constraint. Remote players and NPCs are positioned elsewhere and never use
 * this.
 */
export function checkPlayerCollision(x: number, y: number, width: number, height: number): boolean {
  if (checkCollision(x, y, width, height)) return true;
  if (!activeRoomCells) return false;

  const minMTX = Math.floor(x / MINITILE_SIZE);
  const minMTY = Math.floor(y / MINITILE_SIZE);
  const maxMTX = Math.floor((x + width - 1) / MINITILE_SIZE);
  const maxMTY = Math.floor((y + height - 1) / MINITILE_SIZE);
  for (let mty = minMTY; mty <= maxMTY; mty++) {
    for (let mtx = minMTX; mtx <= maxMTX; mtx++) {
      if (!activeRoomCells.has(mty * MAP_WIDTH_MT + mtx)) return true;
    }
  }
  return false;
}

export function checkCollision(x: number, y: number, width: number, height: number): boolean {
  if (x < 0 || y < 0) return true;
  if (x + width >= MAP_WIDTH_TILES * TILE_SIZE) return true;
  if (y + height >= MAP_HEIGHT_TILES * TILE_SIZE) return true;

  const minMTX = Math.floor(x / MINITILE_SIZE);
  const minMTY = Math.floor(y / MINITILE_SIZE);
  const maxMTX = Math.floor((x + width - 1) / MINITILE_SIZE);
  const maxMTY = Math.floor((y + height - 1) / MINITILE_SIZE);

  for (let mty = minMTY; mty <= maxMTY; mty++) {
    for (let mtx = minMTX; mtx <= maxMTX; mtx++) {
      const tileX = Math.floor(mtx / 4);
      const tileY = Math.floor(mty / 4);
      const localX = mtx % 4;
      const localY = mty % 4;

      const row = effectiveRow(tileX, tileY);
      if (!row) return true; // off-map or tileset not loaded → solid
      if ((row[localY * 4 + localX] & 0x80) !== 0) return true;
    }
  }

  return false;
}

/**
 * Check if a tile has any foreground minitiles (bit 4 set).
 * Foreground tiles are drawn on top of the player (foliage, building eaves).
 */
export function isForegroundTile(tileX: number, tileY: number): boolean {
  const row = effectiveRow(tileX, tileY);
  if (!row) return false;
  for (let i = 0; i < 16; i++) {
    if ((row[i] & 0x10) !== 0) return true;
  }
  return false;
}

/**
 * Check if a tile has ANY solid minitile.
 * Used to determine if FG content is ground-level (depth-sorted) vs overhead (always on top).
 */
export function tileHasAnySolid(tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0) return false;
  if (tileX >= MAP_WIDTH_TILES || tileY >= MAP_HEIGHT_TILES) return false;

  const row = effectiveRow(tileX, tileY);
  if (!row) return false;
  for (let i = 0; i < 16; i++) {
    if ((row[i] & 0x80) !== 0) return true;
  }
  return false;
}

/**
 * Check if an entire tile (32x32) is fully solid (all 16 minitiles are collision).
 */
// Region sampled for sprite priority: the ground covered by the sprite's
// LOWER HALF (16x16 above the feet). The 0x01/0x02 flags hug furniture edges
// sparsely (e.g. only the cushion minitiles of a knocked-over sofa), so a
// smaller foot-only box walks right past them.
const PRI_BOX_W = 16;
const PRI_BOX_H = 16;

/**
 * Get sprite priority bits (bits 0-1) for a sprite whose feet are at
 * (worldX, worldY). Bits are OR-ed over every minitile under the foot box —
 * the flags hug furniture edges with gaps, so a single-point sample flickers.
 * Bit 0 (0x01): the sprite's LOWER half renders behind the FG layer
 * (walking onto bed feet, behind sofa backs, counters).
 * Bit 1 (0x02): the sprite's UPPER half renders behind the FG layer
 * (under tree canopies, overhangs).
 */
export function getSpritePriority(worldX: number, worldY: number): number {
  const minMTX = Math.floor((worldX - PRI_BOX_W / 2) / MINITILE_SIZE);
  const maxMTX = Math.floor((worldX + PRI_BOX_W / 2 - 1) / MINITILE_SIZE);
  const minMTY = Math.floor((worldY - PRI_BOX_H) / MINITILE_SIZE);
  const maxMTY = Math.floor((worldY - 1) / MINITILE_SIZE);

  let bits = 0;
  for (let mty = minMTY; mty <= maxMTY; mty++) {
    for (let mtx = minMTX; mtx <= maxMTX; mtx++) {
      const row = effectiveRow(mtx >> 2, mty >> 2);
      if (!row) continue;

      const b = row[(mty & 3) * 4 + (mtx & 3)];
      // Explicit Behind/Hide (0x40) grants whole-body priority even on SOLID
      // cells — that's the whole point: you walk up against a building and your
      // foot box reaches into its solid front wall (which you painted Behind),
      // so your overlapping upper body hides behind it. One paint = "hide behind
      // this" for BG buildings with no native ROM foreground.
      if ((b & FG_PROMOTE_BIT) !== 0) bits |= 0x02;
      // Native pri bits (0x01/0x02) only apply on WALKABLE ground: counters/
      // tables carry them on their own solid front faces (e.g. burger-shop
      // counter = 0x80|0x02), but feet never stand there — sampling them sank
      // the player's head behind the counter when pressed against it.
      if ((b & 0x80) === 0) bits |= b & 0x03;
    }
  }
  return bits;
}

// Minitile width of the whole map (fixed). Height is data-driven (the map grows
// with the interiors band), so height bounds read the live MAP_HEIGHT_TILES
// rather than a value cached at import.
const MAP_WIDTH_MT = MAP_WIDTH_TILES * 4;

/**
 * Raw collision byte for the minitile under a world pixel, or null when the
 * sector/collision data isn't loaded. Editor/debug readouts only — gameplay
 * goes through checkCollision/getSpritePriority.
 */
export function getCollisionByteAt(worldX: number, worldY: number): number | null {
  const mtx = Math.floor(worldX / MINITILE_SIZE);
  const mty = Math.floor(worldY / MINITILE_SIZE);
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_TILES * 4) return null;
  const row = effectiveRow(mtx >> 2, mty >> 2);
  if (!row) return null;
  return row[(mty & 3) * 4 + (mtx & 3)];
}

/** True if the 8x8 minitile at (mtx, mty) is solid (or off-map). */
function isMinitileSolid(mtx: number, mty: number): boolean {
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_TILES * 4) return true;
  const row = effectiveRow(mtx >> 2, mty >> 2);
  if (!row) return true; // off-map or not loaded — treat as wall
  return (row[(mty & 3) * 4 + (mtx & 3)] & 0x80) !== 0;
}

// Sanity backstop on flood-fill size (in minitiles). Real interiors — even the
// department store — stay well under this; it only guards against runaway fills.
const MAX_ROOM_MT = 50000;
// How far past the walkable floor the crop may extend over the room's own wall
// tiles. EB rooms have a tall back wall above the floor, thin side walls, and
// no front wall below the floor (the next row down is the neighboring room).
const WALL_MARGIN_N = 4;
const WALL_MARGIN_EW = 2;
const WALL_MARGIN_S = 0;

/**
 * Compute the pixel bounds of the interior room the player is standing in.
 *
 * Interiors are packed adjacent on one big map and only separated by solid
 * walls, so we flood-fill the *walkable* minitiles (which a single room fully
 * encloses) to find the floor, then grow the box outward over the bordering
 * wall tiles up to the surrounding black void. Returns null for outdoor tiles
 * or for areas too large to be a single room (camera then scrolls freely).
 */
export function computeRoomBounds(worldX: number, worldY: number): RoomBounds | null {
  const tileX = Math.floor(worldX / TILE_SIZE);
  const tileY = Math.floor(worldY / TILE_SIZE);
  if (!isRoomCroppableTile(tileX, tileY)) return null;

  // Seed the flood-fill at the nearest open minitile to the player's feet.
  let seedX = Math.floor(worldX / MINITILE_SIZE);
  let seedY = Math.floor(worldY / MINITILE_SIZE);
  if (isMinitileSolid(seedX, seedY)) {
    let found = false;
    for (let r = 1; r <= 6 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (!isMinitileSolid(seedX + dx, seedY + dy)) {
            seedX += dx;
            seedY += dy;
            found = true;
          }
        }
      }
    }
    if (!found) return null;
  }

  const visited = new Set<number>();
  const stack: number[] = [seedY * MAP_WIDTH_MT + seedX];
  let minMTX = seedX,
    maxMTX = seedX,
    minMTY = seedY,
    maxMTY = seedY;

  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    const mtx = key % MAP_WIDTH_MT;
    const mty = (key - mtx) / MAP_WIDTH_MT;
    if (isMinitileSolid(mtx, mty)) continue;
    // Never leave indoor/dungeon sectors: house exits have walkable door
    // thresholds that spill into the outdoor-flagged filler between interior
    // clusters — following them merges dozens of unrelated rooms into one.
    if (!isRoomCroppableTile(mtx >> 2, mty >> 2)) continue;

    visited.add(key);
    if (visited.size > MAX_ROOM_MT) return null; // too big — treat as open area

    if (mtx < minMTX) minMTX = mtx;
    if (mtx > maxMTX) maxMTX = mtx;
    if (mty < minMTY) minMTY = mty;
    if (mty > maxMTY) maxMTY = mty;

    stack.push((mty + 1) * MAP_WIDTH_MT + mtx, (mty - 1) * MAP_WIDTH_MT + mtx);
    // Horizontal expansion: packed buildings share walkable 1-minitile-tall
    // strips under their wall bottoms (the sector-row "doorway" rows), which
    // would walkably merge unrelated rooms (arcade/Tracy's-room, bugs.md).
    // Inside building interiors, don't slip horizontally under a wall.
    // Dungeons keep free expansion — caves have legitimate 1-tall squeezes
    // and cliff ledges.
    for (const nx of [mtx + 1, mtx - 1]) {
      if (isIndoorTile(nx >> 2, mty >> 2) && isMinitileSolid(nx, mty - 1)) {
        continue;
      }
      stack.push(mty * MAP_WIDTH_MT + nx);
    }
  }

  // Sectors holding the room's floor, and their visual styles. EB interiors
  // are authored within sector boundaries (tileset/palette are per-sector),
  // so a solid tile in a differently-styled sector is another room's wall or
  // furniture — claiming it paints visible pieces of that room. Same-styled
  // foreign sectors stay claimable: tall walls of multi-sector rooms cross
  // sector edges, but only into sectors with matching settings.
  const SECTOR_MT_X = SECTOR_TILES_X * 4;
  const SECTOR_MT_Y = SECTOR_TILES_Y * 4;
  const floodSectors = new Set<number>();
  const floodStyles = new Set<number>();
  for (const key of visited) {
    const mtx = key % MAP_WIDTH_MT;
    const mty = (key - mtx) / MAP_WIDTH_MT;
    const sx = Math.floor(mtx / SECTOR_MT_X);
    const sy = Math.floor(mty / SECTOR_MT_Y);
    const sIdx = sy * MAP_WIDTH_SECTORS + sx;
    if (!floodSectors.has(sIdx)) {
      floodSectors.add(sIdx);
      const sec = getSector(sx, sy);
      if (sec) floodStyles.add((sec.tilesetId << 8) | sec.paletteId);
    }
  }

  // The pocket merge runs over the room's flood sectors PLUS same-style INDOOR
  // sectors directly adjacent to them. A shop's back-wall row (where the
  // counter/register sits) is often its OWN sector holding no floor at all, so
  // it's not a flood sector — the walkable strip behind the counter would never
  // be scanned and the counter tiles render black (bugs.md, dept-store 3F
  // counter). Buildings only (caves keep their flood sectors); same-style only
  // (a differently-styled neighbour is another room); the door check below
  // still rejects any region that reaches a real neighbour's door mat.
  const mergeSectors = new Set<number>(floodSectors);
  for (const sIdx of floodSectors) {
    const sy = Math.floor(sIdx / MAP_WIDTH_SECTORS);
    const sx = sIdx % MAP_WIDTH_SECTORS;
    for (const [dsx, dsy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nsx = sx + dsx,
        nsy = sy + dsy;
      if (nsx < 0 || nsy < 0 || nsx >= MAP_WIDTH_SECTORS) continue;
      const nIdx = nsy * MAP_WIDTH_SECTORS + nsx;
      if (mergeSectors.has(nIdx)) continue;
      const sec = getSector(nsx, nsy);
      if (sec && sec.indoor && floodStyles.has((sec.tilesetId << 8) | sec.paletteId)) {
        mergeSectors.add(nIdx);
      }
    }
  }

  // Merge enclosed walkable pockets the player can't reach — clerk areas
  // behind shop counters, fenced nooks. The flood never enters them, so
  // without this they (and the tiles holding them) render as black bars over
  // counters/registers. A pocket belongs to this room iff it stays wholly
  // inside the room's own (merge) sectors AND contains no door: real neighboring
  // rooms (which can share a sector with this room) always have a warp mat
  // or door destination; clerk pockets never do.
  const processed = new Set<number>();
  for (const sIdx of mergeSectors) {
    const sy = Math.floor(sIdx / MAP_WIDTH_SECTORS);
    const sx = sIdx % MAP_WIDTH_SECTORS;
    for (let mty = sy * SECTOR_MT_Y; mty < (sy + 1) * SECTOR_MT_Y; mty++) {
      for (let mtx = sx * SECTOR_MT_X; mtx < (sx + 1) * SECTOR_MT_X; mtx++) {
        const seed = mty * MAP_WIDTH_MT + mtx;
        if (visited.has(seed) || processed.has(seed) || isMinitileSolid(mtx, mty)) continue;

        const region: number[] = [];
        const stk = [seed];
        let inside = true;
        let hasDoor = false;
        while (stk.length > 0) {
          const k = stk.pop()!;
          if (processed.has(k) || visited.has(k)) continue;
          const x = k % MAP_WIDTH_MT;
          const y = (k - x) / MAP_WIDTH_MT;
          if (isMinitileSolid(x, y)) continue;
          const kSec =
            Math.floor(y / SECTOR_MT_Y) * MAP_WIDTH_SECTORS + Math.floor(x / SECTOR_MT_X);
          if (!mergeSectors.has(kSec)) {
            inside = false; // leaks out of the room's sectors — foreign floor
            continue; // don't expand outward; keeps the scan bounded
          }
          processed.add(k);
          region.push(k);
          if (doorCells.has(k)) hasDoor = true;
          stk.push(
            y * MAP_WIDTH_MT + (x + 1),
            y * MAP_WIDTH_MT + (x - 1),
            (y + 1) * MAP_WIDTH_MT + x,
            (y - 1) * MAP_WIDTH_MT + x
          );
        }
        if (inside && !hasDoor) {
          for (const k of region) visited.add(k);
        }
      }
    }
  }

  // Guard-free fill, bounded strictly to the room's own sectors and stopped by
  // door mats: reclaims floor minitiles the guarded flood skipped because they
  // lie on a parasitic walkable strip BENEATH in-room furniture (shop counters,
  // shelves) — those strips have a solid cell above, which trips the
  // anti-slip-under-a-wall guard, so the flood never reaches the floor's lower
  // edge and it renders as black squares (bugs.md, twoson cycle shop). The
  // pocket merge can't help: the strip leaks into the packed NEIGHBOR room's
  // sector, so it's rejected wholesale. Growing guard-free from `visited` but
  // refusing to leave `floodSectors` (and never stepping onto a door cell)
  // fills the room's own floor while making it impossible to cross into a
  // neighbor — which always lives in a different sector or behind a door mat.
  const fillStack: number[] = [...visited];
  while (fillStack.length > 0) {
    const key = fillStack.pop()!;
    const x = key % MAP_WIDTH_MT;
    const y = (key - x) / MAP_WIDTH_MT;
    const neighbors: [number, number][] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (isMinitileSolid(nx, ny)) continue;
      const nk = ny * MAP_WIDTH_MT + nx;
      if (visited.has(nk)) continue;
      const nSec = Math.floor(ny / SECTOR_MT_Y) * MAP_WIDTH_SECTORS + Math.floor(nx / SECTOR_MT_X);
      if (!floodSectors.has(nSec)) continue;
      if (doorCells.has(nk)) continue;
      visited.add(nk);
      fillStack.push(nk);
    }
  }

  // Collect the room's tiles: every tile containing walkable floor of this
  // room, then dilate over the room's own wall tiles. EB rooms have a tall
  // back wall ABOVE the floor and thin side walls; there is no front wall
  // below the floor (the next row down already belongs to the room below).
  // A wall tile only joins the mask if it contains NO walkable minitile
  // foreign to this room (that would be a neighboring room's floor) and is
  // not pure black filler (arrangement 0).
  const tiles = new Set<number>();
  for (const key of visited) {
    const mtx = key % MAP_WIDTH_MT;
    const mty = (key - mtx) / MAP_WIDTH_MT;
    tiles.add((mty >> 2) * MAP_WIDTH_TILES + (mtx >> 2));
  }

  const isOwnWallTile = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= MAP_WIDTH_TILES || ty >= MAP_HEIGHT_TILES) return false;
    if (getTileAt(tx, ty) === 0) return false; // black void filler
    const sx = Math.floor(tx / SECTOR_TILES_X);
    const sy = Math.floor(ty / SECTOR_TILES_Y);
    if (!floodSectors.has(sy * MAP_WIDTH_SECTORS + sx)) {
      const sec = getSector(sx, sy);
      if (!sec || !floodStyles.has((sec.tilesetId << 8) | sec.paletteId)) {
        return false; // differently-styled sector — another room's territory
      }
    }
    for (let my = 0; my < 4; my++) {
      for (let mx = 0; mx < 4; mx++) {
        const mtx = tx * 4 + mx;
        const mty = ty * 4 + my;
        if (!isMinitileSolid(mtx, mty) && !visited.has(mty * MAP_WIDTH_MT + mtx)) {
          return false; // another room's floor — never reveal it
        }
      }
    }
    return true;
  };

  const dilate = (passes: number, offsets: [number, number][]) => {
    for (let p = 0; p < passes; p++) {
      const added: number[] = [];
      for (const t of tiles) {
        const tx = t % MAP_WIDTH_TILES;
        const ty = (t - tx) / MAP_WIDTH_TILES;
        for (const [dx, dy] of offsets) {
          const key = (ty + dy) * MAP_WIDTH_TILES + (tx + dx);
          if (!tiles.has(key) && isOwnWallTile(tx + dx, ty + dy)) added.push(key);
        }
      }
      if (added.length === 0) break;
      for (const key of added) tiles.add(key);
    }
  };
  dilate(WALL_MARGIN_N, [[0, -1]]); // back walls
  dilate(WALL_MARGIN_EW, [
    [-1, 0],
    [1, 0],
  ]); // side walls
  if (WALL_MARGIN_S > 0) dilate(WALL_MARGIN_S, [[0, 1]]);

  // Bounding rect of the mask (camera clamping), plus "holes": minitiles
  // inside masked tiles that are a neighboring room's floor (walls are not
  // always tile-aligned, so an edge tile can straddle both rooms).
  let minTX = MAP_WIDTH_TILES,
    maxTX = 0,
    minTY = MAP_HEIGHT_TILES,
    maxTY = 0;
  const holes: { x: number; y: number }[] = [];
  for (const t of tiles) {
    const tx = t % MAP_WIDTH_TILES;
    const ty = (t - tx) / MAP_WIDTH_TILES;
    if (tx < minTX) minTX = tx;
    if (tx > maxTX) maxTX = tx;
    if (ty < minTY) minTY = ty;
    if (ty > maxTY) maxTY = ty;
    for (let my = 0; my < 4; my++) {
      for (let mx = 0; mx < 4; mx++) {
        const mtx = tx * 4 + mx;
        const mty = ty * 4 + my;
        if (!isMinitileSolid(mtx, mty) && !visited.has(mty * MAP_WIDTH_MT + mtx)) {
          holes.push({ x: mtx * MINITILE_SIZE, y: mty * MINITILE_SIZE });
        }
      }
    }
  }

  return {
    minX: minTX * TILE_SIZE,
    minY: minTY * TILE_SIZE,
    maxX: (maxTX + 1) * TILE_SIZE,
    maxY: (maxTY + 1) * TILE_SIZE,
    tiles,
    holes,
    cells: visited,
  };
}

export function checkCollisionTile(tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0) return true;
  if (tileX >= MAP_WIDTH_TILES || tileY >= MAP_HEIGHT_TILES) return true;

  const row = effectiveRow(tileX, tileY);
  if (!row) return true;

  // Check all 16 minitiles — tile is solid only if ALL are solid
  for (let i = 0; i < 16; i++) {
    if (row[i] === 0) return false;
  }
  return true;
}
