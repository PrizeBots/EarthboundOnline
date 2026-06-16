/**
 * Sprite-group extraction — ports CoilSnake's `SpriteGroupModule` /
 * `SpriteGroup` / `EbRegularSprite` (the slice extract_rom.py uses). Each of the
 * 464 groups is a 4x4 grid of overworld sprite frames (4bpp), with a header
 * giving dimensions + palette index, plus per-frame pointers that may flip
 * horizontally.
 *
 * Outputs match extract_rom.py: per-group {id, width(px), height(px), palette}
 * metadata, the decoded indexed pixel grid, and the 8 shared 16-colour sprite
 * palettes. Parity: `test/extract/sprites.test.ts`.
 */
import { Rom, fromSnesAddress } from './Rom';

const GROUP_POINTER_TABLE = 0xef133f;
const NUM_GROUPS = 464;
const PALETTE_TABLE = 0xc30000;
const NUM_PALETTES = 8;
const PALETTE_LEN = 16; // colors per sprite palette

export type RGBA = [number, number, number, number];
export type SpriteMeta = { id: number; width: number; height: number; palette: number };
export type SpriteGroupOut = {
  meta: SpriteMeta;
  pixels: number[][]; // [height*8*4][width*8*4] palette indices (0 = transparent)
};
export type ExtractedSprites = {
  groups: SpriteGroupOut[]; // only non-empty groups, like extract_rom.py
  palettes: RGBA[][]; // 8 × 16 RGBA
};

/** Read one 8x8 2bpp plane into a (possibly larger) target at (x,y), OR-ing bits. */
function read2bppInto(
  target: number[][],
  src: Uint8Array,
  offset: number,
  x: number,
  y: number,
  bitOffset: number
): number {
  for (let i = 0; i < 8; i++) {
    for (let k = 0; k < 2; k++) {
      const b = src[offset++];
      const shift = k + bitOffset;
      for (let j = 0; j < 8; j++) {
        target[y + i][x + 7 - j] |= ((b >> j) & 1) << shift;
      }
    }
  }
  return 16;
}

/** Read one 8x8 4bpp tile (two stacked 2bpp planes) into target at (x,y). */
function read4bppInto(
  target: number[][],
  src: Uint8Array,
  offset: number,
  x: number,
  y: number
): number {
  read2bppInto(target, src, offset, x, y, 0);
  read2bppInto(target, src, offset + 16, x, y, 2);
  return 32;
}

/** Decode one regular sprite (widthPx×heightPx of 4bpp tiles), optionally flipped. */
function decodeRegularSprite(
  rom: Rom,
  widthPx: number,
  heightPx: number,
  offset: number,
  flip: boolean
): number[][] {
  const data: number[][] = Array.from({ length: heightPx }, () =>
    new Array<number>(widthPx).fill(0)
  );
  let o = offset;
  for (let i = 0; i < heightPx / 8; i++) {
    for (let j = 0; j < widthPx / 8; j++) {
      o += read4bppInto(data, rom.data, o, j * 8, i * 8);
    }
  }
  if (flip) for (const row of data) row.reverse();
  return data;
}

/** Decode a sprite group at a file offset into its 4x4 indexed image. */
function decodeGroup(rom: Rom, offset: number, numSprites: number): SpriteGroupOut | null {
  const height = rom.byte(offset); // in 8px units
  const width = rom.byte(offset + 1) >> 4; // in 8px units (byte stores width<<4)
  const palette = (rom.byte(offset + 3) >> 1) & 0x7;
  const bank = rom.byte(offset + 8) << 16;

  const widthPx = width * 8;
  const heightPx = height * 8;
  if (numSprites <= 0 || widthPx === 0 || heightPx === 0) return null;

  // 4x4 grid image (unused cells stay 0/transparent)
  const image: number[][] = Array.from({ length: heightPx * 4 }, () =>
    new Array<number>(widthPx * 4).fill(0)
  );

  let p = offset + 9;
  let gx = 0;
  let gy = 0;
  for (let s = 0; s < numSprites; s++) {
    const ptr = bank | rom.readMulti(p, 2);
    const dataOff = fromSnesAddress(ptr & 0xfffffc);
    const flip = (ptr & 1) !== 0;
    const sprite = decodeRegularSprite(rom, widthPx, heightPx, dataOff, flip);
    // draw at grid cell
    const ox = gx * widthPx;
    const oy = gy * heightPx;
    for (let dy = 0; dy < heightPx; dy++) {
      for (let dx = 0; dx < widthPx; dx++) {
        image[oy + dy][ox + dx] = sprite[dy][dx];
      }
    }
    gx++;
    if (gx >= 4) {
      gy++;
      gx = 0;
    }
    p += 2;
  }

  return { meta: { id: -1, width: widthPx, height: heightPx, palette }, pixels: image };
}

/** Decode the 8 shared sprite palettes (16 raw BGR→RGBA colors each). */
function decodePalettes(rom: Rom): RGBA[][] {
  const base = fromSnesAddress(PALETTE_TABLE);
  const out: RGBA[][] = [];
  let o = base;
  for (let i = 0; i < NUM_PALETTES; i++) {
    const colors: RGBA[] = [];
    for (let c = 0; c < PALETTE_LEN; c++) {
      const bgr = rom.readMulti(o, 2) & 0x7fff;
      o += 2;
      colors.push([(bgr & 0x1f) * 8, ((bgr >> 5) & 0x1f) * 8, (bgr >> 10) * 8, 255]);
    }
    out.push(colors);
  }
  return out;
}

/**
 * Render a decoded sprite group's indexed pixels into an RGBA buffer using its
 * palette — the image extract_rom.py writes as `{id}.png`. Index 0 is
 * transparent; the main thread turns the buffer into an ImageBitmap for the
 * SpriteManager. Returns a flat RGBA Uint8ClampedArray of width*height.
 */
export function renderSpriteImage(pixels: number[][], palette: RGBA[]): Uint8ClampedArray {
  const h = pixels.length;
  const w = h > 0 ? pixels[0].length : 0;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = pixels[y][x];
      if (ci === 0) continue; // transparent
      const c = palette[ci] ?? [255, 0, 255, 255];
      const o = (y * w + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3];
    }
  }
  return out;
}

/** Full sprite extraction — the TS equivalent of extract_rom.py's extract_sprites. */
export function extractSprites(rom: Rom): ExtractedSprites {
  const groupPtrs = rom.readTable(GROUP_POINTER_TABLE, NUM_GROUPS, 4);
  const groups: SpriteGroupOut[] = [];

  for (let i = 0; i < NUM_GROUPS; i++) {
    // num_sprites from the gap to the next group (block_size = 9 + 2*n); the
    // last group is assumed to hold 8.
    const numSprites = i < NUM_GROUPS - 1 ? (groupPtrs[i + 1] - groupPtrs[i] - 9) >> 1 : 8;
    const out = decodeGroup(rom, fromSnesAddress(groupPtrs[i]), numSprites);
    if (out) {
      out.meta.id = i;
      groups.push(out);
    }
  }

  return { groups, palettes: decodePalettes(rom) };
}
