import { loadJSON } from './AssetLoader';
import { getSectorForTile, getTileAt, getDrawTilesetId, isIndoorTile } from './MapManager';
import { RoomBounds } from './Camera';
import { MINITILE_SIZE, TILE_SIZE, MAP_WIDTH_TILES, MAP_HEIGHT_TILES } from '../types';

// collision[drawTilesetId][arrangementId] = 16 collision bytes (4x4 minitiles)
const collisionData = new Map<number, number[][]>();

export async function loadCollision(drawTilesetId: number): Promise<void> {
  if (collisionData.has(drawTilesetId)) return;
  const data = await loadJSON<number[][]>(
    `/assets/tilesets/${drawTilesetId}/collisions.json`
  );
  collisionData.set(drawTilesetId, data);
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

      bits |= collisions[arrangementId][(mty & 3) * 4 + (mtx & 3)] & 0x03;
    }
  }
  return bits;
}

// Minitile dimensions of the whole map.
const MAP_WIDTH_MT = MAP_WIDTH_TILES * 4;
const MAP_HEIGHT_MT = MAP_HEIGHT_TILES * 4;

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
  if (!isIndoorTile(tileX, tileY)) return null;

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

    visited.add(key);
    if (visited.size > MAX_ROOM_MT) return null; // too big — treat as open area

    if (mtx < minMTX) minMTX = mtx;
    if (mtx > maxMTX) maxMTX = mtx;
    if (mty < minMTY) minMTY = mty;
    if (mty > maxMTY) maxMTY = mty;

    stack.push(
      mty * MAP_WIDTH_MT + (mtx + 1),
      mty * MAP_WIDTH_MT + (mtx - 1),
      (mty + 1) * MAP_WIDTH_MT + mtx,
      (mty - 1) * MAP_WIDTH_MT + mtx
    );
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
