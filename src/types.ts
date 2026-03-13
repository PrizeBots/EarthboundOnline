export interface ArrangementCell {
  minitileIndex: number;
  subPalette: number;
  flipH: boolean;
  flipV: boolean;
}

export interface Arrangement {
  cells: ArrangementCell[]; // 4x4 = 16 cells, row-major
  collision: number[];      // 4x4 = 16 collision bytes
}

export interface TilesetData {
  arrangements: Arrangement[];
  palettes: number[][][];   // subpalette -> color index -> [r, g, b, a]
  minitileImage: HTMLImageElement;
}

export interface SectorMeta {
  tilesetId: number;
  paletteId: number;
  musicId: number;
}

export interface SpriteGroupMeta {
  id: number;
  width: number;
  height: number;
  palette: number;
}

export interface NPCData {
  x: number;
  y: number;
  spriteGroupId: number;
  direction: number;
}

export interface PlayerState {
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  moving: boolean;
}

export interface RemotePlayer {
  id: string;
  name: string;
  spriteGroupId: number;
  x: number;
  y: number;
  direction: Direction;
  frame: number;
}

export enum Direction {
  S = 0,
  N = 1,
  W = 2,
  E = 3,
  NW = 4,
  SW = 5,
  SE = 6,
  NE = 7,
}

// SNES native resolution
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 224;

// Tile/sector sizes
export const MINITILE_SIZE = 8;
export const TILE_SIZE = 32;          // 4x4 minitiles
export const SECTOR_TILES_X = 8;     // 8 tiles wide per sector
export const SECTOR_TILES_Y = 4;     // 4 tiles tall per sector

// Full map dimensions in tiles
export const MAP_WIDTH_TILES = 256;
export const MAP_HEIGHT_TILES = 320;
export const MAP_WIDTH_SECTORS = 32;
export const MAP_HEIGHT_SECTORS = 80;
