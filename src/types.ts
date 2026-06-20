export interface ArrangementCell {
  minitileIndex: number;
  subPalette: number;
  flipH: boolean;
  flipV: boolean;
}

export interface Arrangement {
  cells: ArrangementCell[]; // 4x4 = 16 cells, row-major
  collision: number[]; // 4x4 = 16 collision bytes
}

export interface TilesetData {
  arrangements: Arrangement[];
  palettes: number[][][]; // subpalette -> color index -> [r, g, b, a]
  minitileImage: HTMLImageElement;
}

export interface SectorMeta {
  tilesetId: number;
  paletteId: number;
  musicId: number;
  // True for interior sectors (EarthBound "Setting: indoors"). Interiors are
  // small rooms surrounded by black void tiles and must be camera-cropped to
  // the current room (see MapManager.computeRoomBounds / Camera.roomBounds).
  indoor?: boolean;
  // True for cave/dungeon sectors (EarthBound "Setting: exit mouse usable").
  // Packed adjacent to unrelated map chunks just like interiors — same crop.
  dungeon?: boolean;
  // Overworld region name from EB's "Town Map Image" (onett/twoson/threed/
  // fourside/scaraba/summers); absent for interiors/dungeons. Drives the
  // editor's location navigator (EDITOR_TOOLS.md).
  town?: string;
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

// Custom character appearance: the pixel-edited sprite sheet as a PNG data
// URL. Registered as a synthetic sprite group locally and relayed verbatim so
// other players can render it too. Current sheets are 64x240 (walk rows 0-3,
// climb row 4, attack rows 5-8, hurt row 9); legacy 64x120 sheets (walk +
// climb only) are still accepted, with poses falling back to walk frames.
export type CharacterAppearance = string;

// Sprite poses. 'walk' covers idle (frame 0) and the 2-frame walk cycle;
// 'attack' is a 2-frame swing; 'hurt' is a single flinch frame per facing.
// 'peace' (victory) and 'laying' are single-direction hero poses composited from
// their own ROM sprite groups; only the 4 heroes have art for them.
export const POSES = ['walk', 'climb', 'attack', 'hurt', 'peace', 'laying'] as const;
export type Pose = (typeof POSES)[number];

export interface RemotePlayer {
  id: string;
  name: string;
  spriteGroupId: number;
  appearance?: CharacterAppearance | null;
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  pose?: Pose;
  /** Held item id (see Items.ts), or null for empty hands. */
  itemId?: string | null;
  // Synced by the server's player_hp broadcasts (enemy combat). Missing = full bar.
  hp?: number;
  maxHp?: number;
  /** Entity level (no flee AI yet — tracked for a future leveling system). */
  level?: number;
  /** PK (player-kill) flag — server-synced; drives the red nameplate + PvP rules. */
  pk?: boolean;
  /** Active status-condition ids (paralysis, poison, …); server-synced. */
  statuses?: string[];
  /** Epoch-ms until which this player blinks white from a hit (see Juice.FLASH_MS). */
  flashUntil?: number;
  /** KO/downed: drawn laying (rotated 90°). Server-synced via player_downed. */
  downed?: boolean;
  /** Epoch-ms the downed window ends (for the over-head countdown). */
  downedUntil?: number;
  /** Client-side prediction offset (px), layered on the interpolated position and
   *  decayed each frame — see RemoteInterp.applyPredOffset. Lets the local player's
   *  push/knockback on this remote player show instantly, then reconcile. */
  predOffX?: number;
  predOffY?: number;
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
export const TILE_SIZE = 32; // 4x4 minitiles
export const SECTOR_TILES_X = 8; // 8 tiles wide per sector
export const SECTOR_TILES_Y = 4; // 4 tiles tall per sector

// Full map dimensions in tiles. WIDTH is fixed (the stitched plane is 256 tiles
// wide and all row-major indexing relies on it). HEIGHT is data-driven: the map
// can be EXTENDED downward with an "interiors band" of stamped room copies (see
// ARCHITECTURE.md — Rooms), so the height comes from the loaded map data at
// runtime. `setMapDimensions` is called by MapManager after the data loads;
// these are live `let` bindings so every importer sees the resolved height.
export const MAP_WIDTH_TILES = 256;
export const MAP_WIDTH_SECTORS = 32;
export let MAP_HEIGHT_TILES = 320; // base overworld height; grows with the interiors band
export let MAP_HEIGHT_SECTORS = 80;

/** Set the runtime map height from the loaded data (MapManager.loadMapData). */
export function setMapDimensions(heightTiles: number, heightSectors: number): void {
  MAP_HEIGHT_TILES = heightTiles;
  MAP_HEIGHT_SECTORS = heightSectors;
}
