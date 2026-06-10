import { loadJSON } from './AssetLoader';
import {
  SectorMeta,
  MAP_WIDTH_SECTORS,
  MAP_HEIGHT_SECTORS,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
  MAP_WIDTH_TILES,
  MAP_HEIGHT_TILES,
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

/** True if the tile belongs to an interior ("indoors") sector. */
export function isIndoorTile(tileX: number, tileY: number): boolean {
  return getSectorForTile(tileX, tileY)?.indoor === true;
}
