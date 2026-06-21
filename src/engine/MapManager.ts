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
import { setRoomList, RoomDef } from './Rooms';
import { setComposites, unpackRef } from './CompositeTiles';
import { loadAtlas } from './TilesetManager';

let sectors: SectorMeta[] = [];
let mapTiles: number[] = [];
let tilesetMapping: number[] = [];
// Pristine ROM base (never mutated) so the custom-room band can be rebuilt live
// without double-stamping onto an already-extended array.
let baseTiles: number[] = [];
let baseSectors: SectorMeta[] = [];
let baseHeightTiles = 0;
let baseHeightSectors = 0;

// ── custom rooms (authored, public/overrides/rooms.json) ─────────────────────
// Custom rooms are OUR content: a room copied from an interior template (then
// editable) lives here as a tile grid + sector style at a stable band position
// BELOW the overworld. The band is built into mapTiles/sectors at load — the
// ROM's tiles.json is never touched — so re-extraction never clobbers authored
// rooms. Absent file ⇒ no band (overworld-only).
interface CustomRoom {
  id: string;
  label: string;
  town?: string | null;
  type?: string | null;
  bandX: number; // top-left TILE position in the band (sector-aligned; bandY >= base height)
  bandY: number;
  w: number; // size in tiles
  h: number;
  sector: SectorMeta; // tilesetId/paletteId/indoor/dungeon/musicId for the room
  tiles: number[]; // w*h BG arrangement values, row-major (>=COMPOSITE_BASE = composite cell)
  // Composite cells (sub-tile authored tiles): id -> 16 packed minitile refs.
  composites?: Record<string, number[]>;
  spawnDX: number; // spawn offset in px within the room
  spawnDY: number;
  spawnDir: number;
}
interface CustomRoomsDoc {
  version: number;
  rooms: CustomRoom[];
}

/** Per-map-cell tile-arrangement override (Room Builder "Edit map" →
 *  overrides/map_tiles.json). `cells` maps "tileX,tileY" → arrangement id (a
 *  composite id when ≥ COMPOSITE_BASE); `composites` defines any such ids. Pure
 *  indices, never pixels. Applied on top of the ROM base + custom-room band. */
export interface MapTilesOverride {
  version: number;
  cells?: Record<string, number>;
  composites?: Record<string, number[]>;
}

const DEFAULT_BAND_SECTOR: SectorMeta = {
  tilesetId: 0,
  paletteId: 0,
  musicId: 0,
  indoor: false,
  dungeon: false,
} as SectorMeta;

export async function loadMapData(): Promise<void> {
  const [sectorData, tileData, mapping] = await Promise.all([
    loadJSON<SectorMeta[]>('/assets/map/sectors.json'),
    loadJSON<number[]>('/assets/map/tiles.json'),
    loadJSON<number[]>('/assets/map/tileset_mapping.json'),
  ]);
  tilesetMapping = mapping;
  baseTiles = tileData;
  baseSectors = sectorData;
  baseHeightTiles = Math.round(baseTiles.length / MAP_WIDTH_TILES);
  baseHeightSectors = Math.round(baseSectors.length / MAP_WIDTH_SECTORS);
  if (baseHeightTiles !== baseHeightSectors * SECTOR_TILES_Y) {
    console.warn(
      `Map height mismatch: ${baseHeightTiles} tile rows vs ${baseHeightSectors} sector rows ` +
        `(*${SECTOR_TILES_Y} = ${baseHeightSectors * SECTOR_TILES_Y}) — tiles.json and sectors.json disagree`
    );
  }

  // Append the authored custom-room band (extends the arrays + height) and
  // register the rooms. No-ops when there's no override.
  await buildCustomRoomBand();
}

/**
 * Rebuild the custom-room band from overrides/rooms.json over a fresh copy of
 * the ROM base (so it never double-stamps). Call after saving a new/edited room
 * to apply it live. The arrays are COPIES of the base — the cached base is never
 * mutated, so this is idempotent.
 */
/** Load the atlases + collision for every tileset a composite samples from. */
async function preloadCompositeAssets(composites: Map<number, number[]>): Promise<void> {
  const atlasKeys = new Set<string>();
  const drawTs = new Set<number>();
  for (const refs of composites.values()) {
    for (const n of refs) {
      if (n < 0) continue;
      const r = unpackRef(n);
      atlasKeys.add(`${r.ts}_${r.pal}`);
      drawTs.add(getDrawTilesetId(r.ts));
    }
  }
  const jobs: Promise<unknown>[] = [];
  for (const k of atlasKeys) {
    const [ts, pal] = k.split('_').map(Number);
    jobs.push(loadAtlas(ts, pal));
  }
  if (drawTs.size) {
    // Dynamic import avoids a static MapManager <-> Collision import cycle.
    const { loadCollision } = await import('./Collision');
    for (const dt of drawTs) jobs.push(loadCollision(dt));
  }
  await Promise.all(jobs);
}

export async function buildCustomRoomBand(): Promise<void> {
  mapTiles = baseTiles.slice();
  sectors = baseSectors.slice();
  const doc = await loadJSON<CustomRoomsDoc>('/overrides/rooms.json').catch(() => null);
  const custom = doc?.rooms ?? [];

  // Grow the arrays to fit the lowest room (sector-aligned), then stamp each.
  let hSectors = baseHeightSectors;
  for (const r of custom) {
    hSectors = Math.max(hSectors, Math.ceil((r.bandY + r.h) / SECTOR_TILES_Y));
  }
  const hTiles = hSectors * SECTOR_TILES_Y;
  for (let i = mapTiles.length; i < hTiles * MAP_WIDTH_TILES; i++) mapTiles.push(0);
  for (let i = sectors.length; i < hSectors * MAP_WIDTH_SECTORS; i++)
    sectors.push({ ...DEFAULT_BAND_SECTOR });

  const defs: RoomDef[] = [];
  for (const r of custom) {
    for (let ly = 0; ly < r.h; ly++) {
      for (let lx = 0; lx < r.w; lx++) {
        mapTiles[(r.bandY + ly) * MAP_WIDTH_TILES + (r.bandX + lx)] = r.tiles[ly * r.w + lx] ?? 0;
      }
    }
    const s0x = Math.floor(r.bandX / SECTOR_TILES_X),
      s1x = Math.floor((r.bandX + r.w - 1) / SECTOR_TILES_X);
    const s0y = Math.floor(r.bandY / SECTOR_TILES_Y),
      s1y = Math.floor((r.bandY + r.h - 1) / SECTOR_TILES_Y);
    for (let sy = s0y; sy <= s1y; sy++) {
      for (let sx = s0x; sx <= s1x; sx++) sectors[sy * MAP_WIDTH_SECTORS + sx] = { ...r.sector };
    }
    defs.push({
      id: r.id,
      label: r.label,
      town: r.town,
      type: r.type,
      rect: { x: r.bandX * 32, y: r.bandY * 32, w: r.w * 32, h: r.h * 32 },
      spawn: { x: r.bandX * 32 + r.spawnDX, y: r.bandY * 32 + r.spawnDY, dir: r.spawnDir },
    });
  }

  // Gather every room's composite tiles into the global registry, and preload
  // the source tilesets' atlases + collision so they render and collide.
  const composites = new Map<number, number[]>();
  for (const r of custom) {
    for (const [id, refs] of Object.entries(r.composites ?? {})) composites.set(Number(id), refs);
  }

  // Per-map-cell TILE override (Room Builder "Edit map" — overrides/map_tiles.json):
  // replace the arrangement at specific cells of ANY room (not just the custom
  // band), so baked furniture can be moved/covered/added. Applied LAST so it wins
  // over both the ROM base and the band. Collision follows for free: both client
  // (Collision.effectiveRow) and server (blocked) read the cell's arrangement, so
  // a changed tile brings its own collision. Cells are interpreted with the
  // target cell's own sector tileset/palette, so the editor matches styles.
  const mapOv = await loadJSON<MapTilesOverride>('/overrides/map_tiles.json').catch(() => null);
  if (mapOv?.cells) {
    for (const [k, arr] of Object.entries(mapOv.cells)) {
      const [tx, ty] = k.split(',').map(Number);
      const i = ty * MAP_WIDTH_TILES + tx;
      if (i >= 0 && i < mapTiles.length) mapTiles[i] = arr;
    }
  }
  if (mapOv?.composites) {
    for (const [id, refs] of Object.entries(mapOv.composites)) composites.set(Number(id), refs);
  }

  setComposites(composites);
  await preloadCompositeAssets(composites);

  setMapDimensions(hTiles, hSectors);
  setRoomList(defs);
  const bandRows = hSectors - baseHeightSectors;
  console.log(
    `Map loaded: ${MAP_WIDTH_TILES}x${baseHeightTiles} overworld` +
      (bandRows > 0
        ? ` + ${bandRows} sector-row band (${custom.length} custom rooms) -> ${hTiles} tall`
        : '')
  );
}

export function getDrawTilesetId(mapTilesetId: number): number {
  return tilesetMapping[mapTilesetId] ?? 0;
}

/** ROM overworld height in tiles (where the custom-room band begins). */
export function getOverworldHeightTiles(): number {
  return baseHeightTiles;
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
