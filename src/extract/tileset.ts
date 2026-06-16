/**
 * Tileset extraction — ports CoilSnake's `EbTileset` / `EbGraphicTileset` /
 * `EbMapPalette` decode (the slice extract_rom.py uses). Reads through the
 * decompressor + Rom table reader built alongside this.
 *
 * Four products per drawing tileset, matching extract_rom.py's outputs:
 *  - minitiles: 896 8x8 tiles of 4bpp palette indices (0–15)
 *  - arrangements: up to 1024 4x4 cell grids (16-bit cell → minitile + flips + subpalette)
 *  - collisions: per-arrangement 16 collision bytes (read uncompressed from bank 0x18)
 *  - palettes: 6×16 colors per (map-tileset, palette) pair assigned to this tileset
 *
 * Parity: `test/extract/tileset.test.ts` byte-matches native CoilSnake for all
 * 20 tilesets (fixtures from `tools/dump_decomp_fixtures.py`).
 */
import { Rom, fromSnesAddress } from './Rom';
import { decompress } from './decompress';

export const NUM_MINITILES = 896;
export const NUM_ARRANGEMENTS = 1024;

export type Cell = {
  minitileIndex: number;
  subPalette: number;
  flipH: boolean;
  flipV: boolean;
};
export type Arrangement = { cells: Cell[] }; // 16 cells, row-major 4x4
export type Tile = number[][]; // [8][8] of 0–15
export type RGBA = [number, number, number, number];

/** A blank 8x8 tile of zeros. */
function zeroTile(): Tile {
  return Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
}

/**
 * Decode one 8x8 2bpp plane into `tile`, OR-ing color bits at `bitOffset`.
 * Port of read_2bpp_graphic_from_block.
 */
function read2bpp(tile: Tile, src: Uint8Array, offset: number, bitOffset: number): void {
  for (let i = 0; i < 8; i++) {
    for (let k = 0; k < 2; k++) {
      const b = src[offset++];
      const shift = k + bitOffset;
      for (let j = 0; j < 8; j++) {
        tile[i][7 - j] |= ((b >> j) & 1) << shift;
      }
    }
  }
}

/** Decode 896 minitiles from a decompressed 4bpp graphics block. */
export function decodeMinitiles(data: Uint8Array): Tile[] {
  const tiles: Tile[] = Array.from({ length: NUM_MINITILES }, zeroTile);
  const usable = Math.floor(data.length / 32); // each 4bpp tile = 32 bytes
  const count = Math.min(NUM_MINITILES, usable);
  for (let n = 0; n < count; n++) {
    const off = n * 32;
    // 4bpp = two stacked 2bpp planes (bit-planes 0–1 then 2–3)
    read2bpp(tiles[n], data, off, 0);
    read2bpp(tiles[n], data, off + 16, 2);
  }
  return tiles;
}

/** A default all-zero arrangement (matches extract_rom.py's None handling). */
function defaultArrangement(): Arrangement {
  return {
    cells: Array.from({ length: 16 }, () => ({
      minitileIndex: 0,
      subPalette: 0,
      flipH: false,
      flipV: false,
    })),
  };
}

function decodeCell(val: number): Cell {
  return {
    minitileIndex: val & 0x3ff,
    flipH: Boolean(val & 0x400),
    flipV: Boolean(val & 0x800),
    subPalette: (val >> 12) & 0xf,
  };
}

/**
 * Decode arrangements from a decompressed block (32 bytes each = 16 cells × 2).
 * Returns a fixed 1024-length list; unfilled slots are the zero default, and a
 * parallel boolean list marks which were actually present (drives collisions).
 */
export function decodeArrangements(data: Uint8Array): {
  arrangements: Arrangement[];
  present: boolean[];
} {
  const num = Math.floor(data.length / 32);
  const arrangements: Arrangement[] = new Array(NUM_ARRANGEMENTS);
  const present: boolean[] = new Array(NUM_ARRANGEMENTS).fill(false);
  let j = 0;
  for (let i = 0; i < NUM_ARRANGEMENTS; i++) {
    if (i < num) {
      const cells: Cell[] = new Array(16);
      for (let c = 0; c < 16; c++) {
        const val = data[j] | (data[j + 1] << 8);
        j += 2;
        cells[c] = decodeCell(val);
      }
      arrangements[i] = { cells };
      present[i] = true;
    } else {
      arrangements[i] = defaultArrangement();
    }
  }
  return { arrangements, present };
}

/**
 * Decode the 16 collision bytes for each present arrangement. Collision data is
 * NOT compressed: a 2-byte pointer table at `collisionsOffset` indexes into bank
 * 0x18 (0x180000 | ptr). Absent arrangements get 16 zeros.
 */
export function decodeCollisions(
  rom: Rom,
  collisionsOffset: number,
  present: boolean[]
): number[][] {
  const out: number[][] = new Array(NUM_ARRANGEMENTS);
  for (let i = 0; i < NUM_ARRANGEMENTS; i++) {
    if (present[i]) {
      const ptr = rom.readMulti(collisionsOffset + i * 2, 2);
      const collOff = 0x180000 | ptr;
      const bytes = new Array<number>(16);
      for (let k = 0; k < 16; k++) bytes[k] = rom.byte(collOff + k);
      out[i] = bytes;
    } else {
      out[i] = new Array<number>(16).fill(0);
    }
  }
  return out;
}

/** Decode a single 15-bit BGR color → RGBA. Port of EbColor.from_block. */
export function decodeColor(rom: Rom, offset: number): RGBA {
  const bgr = rom.readMulti(offset, 2) & 0x7fff;
  const r = (bgr & 0x001f) * 8;
  const g = ((bgr & 0x03e0) >> 5) * 8;
  const b = (bgr >> 10) * 8;
  return [r, g, b, 255];
}

/**
 * Decode an EbMapPalette: 6 subpalettes × 16 colors (0xC0 bytes), with color 0
 * of every subpalette forced to black (transparent). The flag/sprite-palette/
 * flash-effect metadata extract_rom.py never outputs is skipped.
 */
export function decodeMapPalette(rom: Rom, offset: number): RGBA[][] {
  const subs: RGBA[][] = [];
  let o = offset;
  for (let sp = 0; sp < 6; sp++) {
    const colors: RGBA[] = [];
    for (let c = 0; c < 16; c++) {
      colors.push(decodeColor(rom, o));
      o += 2;
    }
    colors[0] = [0, 0, 0, 255];
    subs.push(colors);
  }
  return subs;
}

const NUM_TILESETS = 20;
const PALETTE_STRIDE = 0xc0;

export type DecodedTileset = {
  minitiles: Tile[];
  arrangements: Arrangement[];
  collisions: number[][];
  palettes: Record<string, RGBA[][]>; // "{mapTs}_{pal}" → 6×16 RGBA
};

/**
 * Full tileset extraction for all 20 drawing tilesets — the TS equivalent of
 * extract_rom.py's extract_tilesets(). `tables` are the five pointer/value
 * tables read via Rom.readTable.
 */
export function extractTilesets(
  rom: Rom,
  tables: {
    graphics: number[];
    arrangements: number[];
    collisions: number[];
    mapTileset: number[]; // map-tileset → drawing-tileset (32 entries)
    palette: number[]; // 32 SNES pointers
  }
): DecodedTileset[] {
  const out: DecodedTileset[] = [];
  for (let ts = 0; ts < NUM_TILESETS; ts++) {
    const gfx = decompress(rom.data, fromSnesAddress(tables.graphics[ts]));
    const arr = decompress(rom.data, fromSnesAddress(tables.arrangements[ts]));
    const { arrangements, present } = decodeArrangements(arr);
    out.push({
      minitiles: decodeMinitiles(gfx),
      arrangements,
      collisions: decodeCollisions(rom, fromSnesAddress(tables.collisions[ts]), present),
      palettes: {},
    });
  }

  // Assign palettes: each of the 32 map-tilesets points at a drawing tileset and
  // owns a run of palettes (0xC0 bytes each). Mirrors extract_rom.py exactly.
  for (let mapTs = 0; mapTs < 32; mapTs++) {
    const drawTs = tables.mapTileset[mapTs];
    let numPalettes: number;
    if (mapTs === 31) {
      numPalettes = 8;
    } else {
      numPalettes = Math.floor(
        (tables.palette[mapTs + 1] - tables.palette[mapTs]) / PALETTE_STRIDE
      );
    }
    let palOffset = fromSnesAddress(tables.palette[mapTs]);
    for (let pal = 0; pal < numPalettes; pal++) {
      out[drawTs].palettes[`${mapTs}_${pal}`] = decodeMapPalette(rom, palOffset);
      palOffset += PALETTE_STRIDE;
    }
  }

  return out;
}
