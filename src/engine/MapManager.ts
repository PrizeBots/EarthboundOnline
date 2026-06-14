import { loadJSON } from './AssetLoader';
import {
  SectorMeta,
  MAP_WIDTH_SECTORS,
  MAP_HEIGHT_SECTORS,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
  MAP_WIDTH_TILES,
  MAP_HEIGHT_TILES,
  setMapDimensions,
} from '../types';

let sectors: SectorMeta[] = [];
let mapTiles: number[] = [];
let tilesetMapping: number[] = [];

export async function loadMapData(): Promise<void> {
  const [sectorData, tileData, mapping] = await Promise.all([
    loadJSON<SectorMeta[]>('/assets/map/sectors.json'),
    loadJSON<number[]>('/assets/map/tiles.json'),
    loadJSON<number[]>('/assets/map/tileset_mapping.json'),
  ]);
  sectors = sectorData;
  mapTiles = tileData;
  tilesetMapping = mapping;

  // Height is data-driven: an extended map (overworld + stamped interiors band)
  // makes the arrays taller. Width is fixed at 256, so the row count is the
  // height. Resolve it from the data and publish to the live dim bindings.
  const heightTiles = Math.round(mapTiles.length / MAP_WIDTH_TILES);
  const heightSectors = Math.round(sectors.length / MAP_WIDTH_SECTORS);
  setMapDimensions(heightTiles, heightSectors);
  // Tile rows and sector rows must agree (each sector is SECTOR_TILES_Y tall).
  if (heightTiles !== heightSectors * SECTOR_TILES_Y) {
    console.warn(
      `Map height mismatch: ${heightTiles} tile rows vs ${heightSectors} sector rows ` +
      `(*${SECTOR_TILES_Y} = ${heightSectors * SECTOR_TILES_Y}) — tiles.json and sectors.json disagree`,
    );
  }
  console.log(`Map loaded: ${MAP_WIDTH_TILES}x${heightTiles} tiles (${heightSectors} sector rows)`);
}

export function getDrawTilesetId(mapTilesetId: number): number {
  return tilesetMapping[mapTilesetId] ?? 0;
}

export function getSector(sectorX: number, sectorY: number): SectorMeta | null {
  if (sectorX < 0 || sectorX >= MAP_WIDTH_SECTORS) return null;
  if (sectorY < 0 || sectorY >= MAP_HEIGHT_SECTORS) return null;
  return sectors[sectorY * MAP_WIDTH_SECTORS + sectorX];
}

export function getTileAt(tileX: number, tileY: number): number {
  if (tileX < 0 || tileX >= MAP_WIDTH_TILES) return 0;
  if (tileY < 0 || tileY >= MAP_HEIGHT_TILES) return 0;
  return mapTiles[tileY * MAP_WIDTH_TILES + tileX] ?? 0;
}

export function getSectorForTile(tileX: number, tileY: number): SectorMeta | null {
  const sectorX = Math.floor(tileX / SECTOR_TILES_X);
  const sectorY = Math.floor(tileY / SECTOR_TILES_Y);
  return getSector(sectorX, sectorY);
}

/** True if the tile belongs to a building-interior ("indoors") sector. */
export function isIndoorTile(tileX: number, tileY: number): boolean {
  return getSectorForTile(tileX, tileY)?.indoor === true;
}

/**
 * True if the tile belongs to a sector that must be camera-cropped to the
 * current room: interiors ("indoors") AND caves/dungeons ("exit mouse
 * usable"). Both are packed adjacent to unrelated map chunks on the big
 * stitched map; without the crop, neighboring areas are visible (bugs.md).
 */
export function isRoomCroppableTile(tileX: number, tileY: number): boolean {
  const sector = getSectorForTile(tileX, tileY);
  return sector?.indoor === true || sector?.dungeon === true;
}
