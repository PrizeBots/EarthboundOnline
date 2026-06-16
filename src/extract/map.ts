/**
 * Map + sector extraction — ports extract_rom.py's `extract_map`. Produces the
 * same three outputs the engine loads:
 *  - tiles: flat 256×320 tile plane (row-major), each entry a 10-bit tile id
 *    (low 8 bits from the row data, high 2 bits packed from the local-tileset
 *    table — that's what selects which of the 4 local tilesets a row uses)
 *  - sectors: 32×80 = 2560 entries of {tilesetId, paletteId, musicId}
 *  - tilesetMapping: the 32 map-tileset → drawing-tileset entries
 *
 * Parity: `test/extract/map.test.ts` byte-matches native CoilSnake output.
 */
import { Rom, fromSnesAddress } from './Rom';

const MAP_POINTERS_OFFSET = 0xa1db;
const LOCAL_TILESETS_OFFSET = 0x175000;
const MAP_HEIGHT = 320;
const MAP_WIDTH = 256;
const SECTOR_TILESETS_PALETTES = 0xd7a800;
const SECTOR_MUSIC = 0xdcd637;
const NUM_SECTORS_X = 32;
const NUM_SECTORS_Y = 80;
const NUM_SECTORS = NUM_SECTORS_X * NUM_SECTORS_Y;
const MAP_TILESET_TABLE = 0xef101b;

export type Sector = { tilesetId: number; paletteId: number; musicId: number };
export type ExtractedMap = {
  tiles: number[]; // flat, length MAP_WIDTH * MAP_HEIGHT
  sectors: Sector[];
  tilesetMapping: number[]; // length 32
};

export function extractMap(rom: Rom): ExtractedMap {
  // The map is stored as 8 interleaved row-streams; map_addrs[row % 8] gives the
  // base for that stream and (row >> 3) << 8 walks down it 256 bytes per band.
  const mapPtrsAddr = fromSnesAddress(rom.readMulti(MAP_POINTERS_OFFSET, 3));
  const mapAddrs: number[] = [];
  for (let x = 0; x < 8; x++) {
    mapAddrs.push(fromSnesAddress(rom.readMulti(mapPtrsAddr + x * 4, 4)));
  }

  const tiles: number[][] = [];
  for (let row = 0; row < MAP_HEIGHT; row++) {
    const offset = mapAddrs[row % 8] + ((row >> 3) << 8);
    const r: number[] = new Array(MAP_WIDTH);
    for (let j = 0; j < MAP_WIDTH; j++) r[j] = rom.byte(offset + j);
    tiles.push(r);
  }

  // Apply the local-tileset high bits: each byte holds 2-bit selectors for 4
  // rows (rows 0–3 from `k`, rows 4–7 from `k + 0x3000`), one byte per column
  // per 8-row band.
  let k = LOCAL_TILESETS_OFFSET;
  for (let i = 0; i < MAP_HEIGHT >> 3; i++) {
    for (let j = 0; j < MAP_WIDTH; j++) {
      const lo = rom.byte(k);
      const hi = rom.byte(k + 0x3000);
      tiles[i << 3][j] |= (lo & 3) << 8;
      tiles[(i << 3) | 1][j] |= ((lo >> 2) & 3) << 8;
      tiles[(i << 3) | 2][j] |= ((lo >> 4) & 3) << 8;
      tiles[(i << 3) | 3][j] |= ((lo >> 6) & 3) << 8;
      tiles[(i << 3) | 4][j] |= (hi & 3) << 8;
      tiles[(i << 3) | 5][j] |= ((hi >> 2) & 3) << 8;
      tiles[(i << 3) | 6][j] |= ((hi >> 4) & 3) << 8;
      tiles[(i << 3) | 7][j] |= ((hi >> 6) & 3) << 8;
      k++;
    }
  }

  const flatTiles: number[] = [];
  for (const r of tiles) flatTiles.push(...r);

  const sectors: Sector[] = [];
  const tpBase = fromSnesAddress(SECTOR_TILESETS_PALETTES);
  const musicBase = fromSnesAddress(SECTOR_MUSIC);
  for (let i = 0; i < NUM_SECTORS; i++) {
    const val = rom.byte(tpBase + i);
    sectors.push({
      tilesetId: val >> 3,
      paletteId: val & 7,
      musicId: rom.byte(musicBase + i),
    });
  }

  const tilesetMapping = rom.readTable(MAP_TILESET_TABLE, 32, 2);

  return { tiles: flatTiles, sectors, tilesetMapping };
}
