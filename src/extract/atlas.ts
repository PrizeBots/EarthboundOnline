/**
 * Atlas rendering — ports build_atlases.py. Composes the decoded minitiles +
 * palette into the 1024×1024 BG/FG tile atlases the engine's TilesetManager
 * loads (one per used (mapTileset, palette) combo). Pure RGBA pixel math (no
 * canvas) so it runs in a Worker AND is unit-testable; the main thread turns the
 * buffers into ImageBitmaps for AssetLoader.
 *
 * NOTE: the atlas decodes each 16-bit arrangement cell with build_atlases.py's
 * layout — subpalette = bits 10–12, h/v-flip = bits 14/15 — which differs from
 * extract_rom.py's arrangements.json layout (flips at bits 10/11, subpalette at
 * 12–15). Both ship today and feed different consumers (atlas image vs data
 * JSON); we reproduce each faithfully. See ARCHITECTURE / the two cell decoders.
 *
 * Parity: `test/extract/atlas.test.ts` byte-matches PIL-rendered atlases.
 */
import type { Tile, RGBA } from './tileset';

export const ATLAS_SIZE = 1024;
const COLS = 32;
const TILE = 32;
const MINI = 8;

/** Decode a decompressed arrangement block into raw 16-bit cell values (1024 ×
 *  16). Slots past the data length are null (absent → not drawn). */
export function decodeRawArrangements(data: Uint8Array): (number[] | null)[] {
  const num = Math.floor(data.length / 32);
  const out: (number[] | null)[] = new Array(1024).fill(null);
  let j = 0;
  for (let i = 0; i < num && i < 1024; i++) {
    const cells = new Array<number>(16);
    for (let c = 0; c < 16; c++) {
      cells[c] = data[j] | (data[j + 1] << 8);
      j += 2;
    }
    out[i] = cells;
  }
  return out;
}

export type AtlasResult = { bg: Uint8ClampedArray; fg: Uint8ClampedArray | null };

/**
 * Render one atlas. `subpalettes` is the EbMapPalette's 6 subpalettes (16 RGBA
 * each, index 0 = solid BG colour). Returns the BG buffer always and the FG
 * buffer only if any foreground pixel was drawn (else null, matching the Python
 * which only writes a `_fg.png` when `has_fg`).
 *
 * `mtRemap`/`animTiles` drive TILE-GRAPHIC animation frames (escalator steps): a
 * BG cell whose minitile index is in `mtRemap` draws the substitute minitile from
 * `animTiles` (the $7EC000 animation buffer) instead of the tileset's own. The FG
 * layer is never remapped. Both omitted = a normal static / palette-only render.
 */
export function renderAtlas(
  minitiles: Tile[],
  subpalettes: RGBA[][],
  rawArrangements: (number[] | null)[],
  mtRemap?: Map<number, number>,
  animTiles?: Tile[]
): AtlasResult {
  const bg = new Uint8ClampedArray(ATLAS_SIZE * ATLAS_SIZE * 4);
  const fg = new Uint8ClampedArray(ATLAS_SIZE * ATLAS_SIZE * 4);
  let hasFg = false;

  const put = (buf: Uint8ClampedArray, x: number, y: number, c: RGBA) => {
    const o = (y * ATLAS_SIZE + x) * 4;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
    buf[o + 3] = c[3];
  };

  for (let arrIdx = 0; arrIdx < 1024; arrIdx++) {
    const cells = rawArrangements[arrIdx];
    if (!cells) continue;
    const ax = (arrIdx % COLS) * TILE;
    const ay = Math.floor(arrIdx / COLS) * TILE;

    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) {
        const cell = cells[cy * 4 + cx];
        const mtIndex = cell & 0x3ff;
        const subPal = (cell >> 10) & 0x7;
        const flipH = (cell & 0x4000) !== 0;
        const flipV = (cell & 0x8000) !== 0;
        // SNES BG palette slots 0–1 are reserved; subpalettes 0–5 map to 2–7.
        const sp = subpalettes[Math.max(0, subPal - 2)] ?? subpalettes[0];
        const dx = ax + cx * MINI;
        const dy = ay + cy * MINI;

        // Background minitile. A tile-animation frame swaps which GRAPHICS a
        // remapped cell draws (from the animation buffer); every other cell
        // draws its normal minitile from the tileset.
        let mt: Tile | undefined;
        if (mtRemap && animTiles && mtRemap.has(mtIndex)) {
          const sub = mtRemap.get(mtIndex)!;
          if (sub < animTiles.length) mt = animTiles[sub];
        }
        if (!mt && mtIndex < minitiles.length) mt = minitiles[mtIndex];
        if (mt) {
          for (let py = 0; py < 8; py++) {
            for (let px = 0; px < 8; px++) {
              const sx = flipH ? 7 - px : px;
              const sy = flipV ? 7 - py : py;
              const ci = mt[sy][sx];
              put(bg, dx + px, dy + py, sp[ci] ?? [255, 0, 255, 255]);
            }
          }
        }

        // Foreground minitile, paired at index + 512 (only for BG tiles < 384).
        if (mtIndex < 384) {
          const fmt = minitiles[mtIndex + 512];
          if (fmt) {
            for (let py = 0; py < 8; py++) {
              for (let px = 0; px < 8; px++) {
                const sx = flipH ? 7 - px : px;
                const sy = flipV ? 7 - py : py;
                const ci = fmt[sy][sx];
                if (ci !== 0) {
                  hasFg = true;
                  put(fg, dx + px, dy + py, sp[ci] ?? [255, 0, 255, 255]);
                }
              }
            }
          }
        }
      }
    }
  }

  return { bg, fg: hasFg ? fg : null };
}
