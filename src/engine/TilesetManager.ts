import { loadImage } from './AssetLoader';
import { TILE_SIZE } from '../types';

// Pre-rendered atlas PNGs: keyed by "{mapTilesetId}_{paletteId}"
const atlasCache = new Map<string, HTMLImageElement>();
const fgAtlasCache = new Map<string, HTMLImageElement>();
const loadingAtlases = new Set<string>();

export async function loadAtlas(mapTilesetId: number, paletteId: number): Promise<void> {
  const key = `${mapTilesetId}_${paletteId}`;
  if (atlasCache.has(key) || loadingAtlases.has(key)) return;
  loadingAtlases.add(key);

  try {
    const [bgImg, fgImg] = await Promise.all([
      loadImage(`/assets/atlases/${key}.png`),
      loadImage(`/assets/atlases/${key}_fg.png`).catch(() => null),
    ]);
    atlasCache.set(key, bgImg);
    if (fgImg) fgAtlasCache.set(key, fgImg);
  } catch (e) {
    console.warn(`Failed to load atlas ${key}`);
  }
}

/**
 * Draw a single 32x32 tile from the background atlas.
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  destX: number,
  destY: number
) {
  const key = `${mapTilesetId}_${paletteId}`;
  const atlas = atlasCache.get(key);
  if (!atlas) return;

  const cols = 32;
  const srcX = (arrangementId % cols) * TILE_SIZE;
  const srcY = Math.floor(arrangementId / cols) * TILE_SIZE;

  ctx.drawImage(atlas, srcX, srcY, TILE_SIZE, TILE_SIZE, destX, destY, TILE_SIZE, TILE_SIZE);
}

/**
 * Check if a foreground atlas exists for this tileset/palette combo.
 */
export function hasForegroundTile(mapTilesetId: number, paletteId: number): boolean {
  return fgAtlasCache.has(`${mapTilesetId}_${paletteId}`);
}

const MINI = 8; // one minitile = 8x8 px (the SNES BG tile)

/** Draw a single 8x8 minitile (sub-tile of an arrangement) from the BG atlas. */
export function drawMinitile(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  minitileIdx: number, // 0..15, row-major within the 4x4 arrangement
  destX: number,
  destY: number
) {
  const atlas = atlasCache.get(`${mapTilesetId}_${paletteId}`);
  if (!atlas) return;
  const srcX = (arrangementId % 32) * TILE_SIZE + (minitileIdx % 4) * MINI;
  const srcY = Math.floor(arrangementId / 32) * TILE_SIZE + (minitileIdx >> 2) * MINI;
  ctx.drawImage(atlas, srcX, srcY, MINI, MINI, destX, destY, MINI, MINI);
}

/** Same as drawMinitile but from the FG atlas (transparent except FG pixels). */
export function drawMinitileFg(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  minitileIdx: number,
  destX: number,
  destY: number
) {
  const atlas = fgAtlasCache.get(`${mapTilesetId}_${paletteId}`);
  if (!atlas) return;
  const srcX = (arrangementId % 32) * TILE_SIZE + (minitileIdx % 4) * MINI;
  const srcY = Math.floor(arrangementId / 32) * TILE_SIZE + (minitileIdx >> 2) * MINI;
  ctx.drawImage(atlas, srcX, srcY, MINI, MINI, destX, destY, MINI, MINI);
}

/**
 * Draw a single 32x32 tile from the foreground atlas (in front of sprites).
 */
export function drawForegroundTile(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  destX: number,
  destY: number
) {
  const key = `${mapTilesetId}_${paletteId}`;
  const atlas = fgAtlasCache.get(key);
  if (!atlas) return;

  const cols = 32;
  const srcX = (arrangementId % cols) * TILE_SIZE;
  const srcY = Math.floor(arrangementId / cols) * TILE_SIZE;

  ctx.drawImage(atlas, srcX, srcY, TILE_SIZE, TILE_SIZE, destX, destY, TILE_SIZE, TILE_SIZE);
}
