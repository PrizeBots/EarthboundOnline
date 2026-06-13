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
  edits?: Record<string, Record<string, number>>;
}

let collisionOverrides: CollisionOverrides | null = null;
let overridesLoading: Promise<void> | null = null;
// Pristine extracted rows for every (ts,arr) that overrides or live painting
// touched — the editor diffs against these so no-op edits drop out.
const pristineRows = new Map<string, number[]>();

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
      })
      .catch(() => {
        collisionOverrides = null; // nothing authored yet
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
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_MT) return null;
  const sector = getSectorForTile(mtx >> 2, mty >> 2);
  if (!sector) return null;
  const drawTs = getDrawTilesetId(sector.tilesetId);
  const arr = getTileAt(mtx >> 2, mty >> 2);
  const data = collisionData.get(drawTs);
  if (!data || arr >= data.length) return null;
  return { drawTs, arr, idx: (mty & 3) * 4 + (mtx & 3) };
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
export function checkPlayerCollision(
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
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

export function checkCollision(
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
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

      const sector = getSectorForTile(tileX, tileY);
      if (!sector) return true;

      const drawTilesetId = getDrawTilesetId(sector.tilesetId);
      const collisions = collisionData.get(drawTilesetId);
      if (!collisions) return true;

      const arrangementId = getTileAt(tileX, tileY);
      if (arrangementId >= collisions.length) continue;

      const collisionByte = collisions[arrangementId][localY * 4 + localX];
      if ((collisionByte & 0x80) !== 0) return true;
    }
  }

  return false;
}

/**
 * Check if a tile has any foreground minitiles (bit 4 set).
 * Foreground tiles are drawn on top of the player (foliage, building eaves).
 */
export function isForegroundTile(tileX: number, tileY: number): boolean {
  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return false;

  const drawTilesetId = getDrawTilesetId(sector.tilesetId);
  const collisions = collisionData.get(drawTilesetId);
  if (!collisions) return false;

  const arrangementId = getTileAt(tileX, tileY);
  if (arrangementId >= collisions.length) return false;

  for (let i = 0; i < 16; i++) {
    if ((collisions[arrangementId][i] & 0x10) !== 0) return true;
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

  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return false;

  const drawTilesetId = getDrawTilesetId(sector.tilesetId);
  const collisions = collisionData.get(drawTilesetId);
  if (!collisions) return false;

  const arrangementId = getTileAt(tileX, tileY);
  if (arrangementId >= collisions.length) return false;

  for (let i = 0; i < 16; i++) {
    if ((collisions[arrangementId][i] & 0x80) !== 0) return true;
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
      const tileX = mtx >> 2;
      const tileY = mty >> 2;
      const sector = getSectorForTile(tileX, tileY);
      if (!sector) continue;

      const drawTilesetId = getDrawTilesetId(sector.tilesetId);
      const collisions = collisionData.get(drawTilesetId);
      if (!collisions) continue;

      const arrangementId = getTileAt(tileX, tileY);
      if (arrangementId >= collisions.length) continue;

      // Skip SOLID minitiles: counters/tables carry priority bits on their
      // own solid front faces (e.g. burger-shop counter = 0x80|0x02), but
      // feet can never stand there — sampling them sank the player's head
      // behind the counter when pressed against it. Only flags on walkable
      // ground (clerk strips, sofa cushions, canopy shade) apply to sprites.
      const b = collisions[arrangementId][(mty & 3) * 4 + (mtx & 3)];
      if ((b & 0x80) === 0) bits |= b & 0x03;
    }
  }
  return bits;
}

// Minitile dimensions of the whole map.
const MAP_WIDTH_MT = MAP_WIDTH_TILES * 4;
const MAP_HEIGHT_MT = MAP_HEIGHT_TILES * 4;

/**
 * Raw collision byte for the minitile under a world pixel, or null when the
 * sector/collision data isn't loaded. Editor/debug readouts only — gameplay
 * goes through checkCollision/getSpritePriority.
 */
export function getCollisionByteAt(worldX: number, worldY: number): number | null {
  const mtx = Math.floor(worldX / MINITILE_SIZE);
  const mty = Math.floor(worldY / MINITILE_SIZE);
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_MT) return null;
  const tileX = mtx >> 2;
  const tileY = mty >> 2;
  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return null;
  const collisions = collisionData.get(getDrawTilesetId(sector.tilesetId));
  if (!collisions) return null;
  const arrangementId = getTileAt(tileX, tileY);
  if (arrangementId >= collisions.length) return null;
  return collisions[arrangementId][(mty & 3) * 4 + (mtx & 3)];
}

/** True if the 8x8 minitile at (mtx, mty) is solid (or off-map). */
function isMinitileSolid(mtx: number, mty: number): boolean {
  if (mtx < 0 || mty < 0 || mtx >= MAP_WIDTH_MT || mty >= MAP_HEIGHT_MT) return true;

  const tileX = mtx >> 2;
  const tileY = mty >> 2;
  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return true;

  const drawTilesetId = getDrawTilesetId(sector.tilesetId);
  const collisions = collisionData.get(drawTilesetId);
  if (!collisions) return true; // not loaded yet — treat as wall

  const arrangementId = getTileAt(tileX, tileY);
  if (arrangementId >= collisions.length) return true;

  return (collisions[arrangementId][(mty & 3) * 4 + (mtx & 3)] & 0x80) !== 0;
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
  let minMTX = seedX, maxMTX = seedX, minMTY = seedY, maxMTY = seedY;

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
      if (
        isIndoorTile(nx >> 2, mty >> 2) &&
        isMinitileSolid(nx, mty - 1)
      ) {
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

  // Merge enclosed walkable pockets the player can't reach — clerk areas
  // behind shop counters, fenced nooks. The flood never enters them, so
  // without this they (and the tiles holding them) render as black bars over
  // counters/registers. A pocket belongs to this room iff it stays wholly
  // inside the room's own sectors AND contains no door: real neighboring
  // rooms (which can share a sector with this room) always have a warp mat
  // or door destination; clerk pockets never do.
  const processed = new Set<number>();
  for (const sIdx of floodSectors) {
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
          if (!floodSectors.has(kSec)) {
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
  dilate(WALL_MARGIN_EW, [[-1, 0], [1, 0]]); // side walls
  if (WALL_MARGIN_S > 0) dilate(WALL_MARGIN_S, [[0, 1]]);

  // Bounding rect of the mask (camera clamping), plus "holes": minitiles
  // inside masked tiles that are a neighboring room's floor (walls are not
  // always tile-aligned, so an edge tile can straddle both rooms).
  let minTX = MAP_WIDTH_TILES, maxTX = 0, minTY = MAP_HEIGHT_TILES, maxTY = 0;
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

  const sector = getSectorForTile(tileX, tileY);
  if (!sector) return true;

  const drawTilesetId = getDrawTilesetId(sector.tilesetId);
  const collisions = collisionData.get(drawTilesetId);
  if (!collisions) return true;

  const arrangementId = getTileAt(tileX, tileY);
  if (arrangementId >= collisions.length) return true;

  // Check all 16 minitiles — tile is solid only if ALL are solid
  for (let i = 0; i < 16; i++) {
    if (collisions[arrangementId][i] === 0) return false;
  }
  return true;
}
