import { loadJSON } from './AssetLoader';
import { getSectorForTile, getTileAt, getDrawTilesetId } from './MapManager';
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
 * Check if an entire tile (32x32) is fully solid (all 16 minitiles are collision).
 */
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
