/**
 * Map animation extraction — ports tools/palette_anim.py + tools/tile_anim.py.
 * EarthBound animates map tiles two independent ways; build_atlases bakes both to
 * per-frame atlases (`{mapTs}_{pal}_f{k}.png`) + `atlases/anim.json`, and the
 * engine's TilesetManager swaps frames on a clock.
 *
 *  1. PALETTE CYCLING ("Flash Effect" — water/lava/Moonside). The whole map
 *     palette is replaced each frame from a pre-baked sequence in the ROM. A combo
 *     is animated when its palette's Flash Effect byte (at palette+0x60, stuffed in
 *     the always-black colour-0 slot) is non-zero; that value indexes the anim table.
 *  2. TILE-GRAPHIC ("escalator/conveyor/waterfall steps"). Each frame swaps which
 *     minitile GRAPHICS a cell draws, sourced from a separate per-tileset 256-tile
 *     buffer EB DMAs to $7EC000 — NOT the tileset's own minitiles. Keyed by the
 *     drawing (graphics) tileset.
 *
 * Pure ROM reads (no eb_project YAML) so this runs in the client-side Worker.
 * Parity: test/extract/bundle.test.ts byte-matches the committed frame atlases.
 */
import { Rom, fromSnesAddress } from './Rom';
import { decompress } from './decompress';
import { decodeMinitiles } from './tileset';
import type { Tile, RGBA } from './tileset';

// --- ROM offsets (all unheadered US 1.0 FILE offsets) ---------------------
const PALETTE_PTR_TABLE = 0xef10fb; // 32 SNES ptrs to map-palette runs
const PALETTE_BYTES = 0xc0; // one full map palette: 6 subpalettes x 16 colours x 2
const FLASH_EFFECT_OFFSET = 0x60; // byte within a palette block (colour-0 of subpal 3)

const PALETTE_ANIM_PTR_TABLE = 0x1fe4e1; // 31 x 4-byte SNES long ptrs, by (FlashEffect-1)

const ANIM_TABLE = 0x2f126b; // Tile Animation Properties Table (20 entries)
const TILE_ANIM_GFX_PTR_TABLE = 0x2f11cb; // per-tileset $7EC000 graphics buffer ptrs
const MINITILE_BYTES = 32; // one 4bpp 8x8 minitile
const ANIM_GFX_NUM_TILES = 256; // tiles in the animation graphics buffer
const NUM_TILESETS = 20;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

/** Decode a 15-bit BGR555 colour from a raw byte buffer → RGBA. */
function colorFromBytes(buf: Uint8Array, o: number): RGBA {
  const v = (buf[o] | (buf[o + 1] << 8)) & 0x7fff;
  return [(v & 0x1f) * 8, ((v >> 5) & 0x1f) * 8, ((v >> 10) & 0x1f) * 8, 255];
}

export type PaletteAnim = { durations: number[]; frames: RGBA[][][] };

/**
 * {`mapTs_pal`: FlashEffect} for every combo whose Flash Effect byte is non-zero
 * (animated). Read straight from the ROM palette blocks — the byte CoilSnake
 * surfaces as map_palette_settings.yml's "Flash Effect".
 */
export function flashEffectsByCombo(rom: Rom): Map<string, number> {
  const palTbl = rom.readTable(PALETTE_PTR_TABLE, 32, 4);
  const out = new Map<string, number>();
  for (let mapTs = 0; mapTs < 32; mapTs++) {
    const num = mapTs === 31 ? 8 : Math.floor((palTbl[mapTs + 1] - palTbl[mapTs]) / PALETTE_BYTES);
    let off = fromSnesAddress(palTbl[mapTs]);
    for (let pal = 0; pal < num; pal++) {
      const fe = rom.byte(off + FLASH_EFFECT_OFFSET);
      if (fe) out.set(`${mapTs}_${pal}`, fe);
      off += PALETTE_BYTES;
    }
  }
  return out;
}

/** Decode one Flash Effect index → its frame palettes + per-frame durations. */
function decodePaletteAnim(rom: Rom, flashEffect: number): PaletteAnim {
  const idx = flashEffect - 1; // Flash Effect 1.. → table index 0..
  const sec = fromSnesAddress(rom.readMulti(PALETTE_ANIM_PTR_TABLE + idx * 4, 3));
  const dataPtr = rom.readMulti(sec, 3);
  const nFrames = rom.byte(sec + 4);
  const durations: number[] = [];
  for (let i = 0; i < nFrames; i++) durations.push(rom.byte(sec + 5 + i));

  const blk = decompress(rom.data, fromSnesAddress(dataPtr));
  if (blk.length !== nFrames * PALETTE_BYTES) {
    throw new Error(
      `Flash Effect ${flashEffect}: decompressed ${blk.length} bytes, ` +
        `expected ${nFrames * PALETTE_BYTES} (${nFrames} frames). Wrong ROM region?`
    );
  }

  const frames: RGBA[][][] = [];
  for (let f = 0; f < nFrames; f++) {
    const base = f * PALETTE_BYTES;
    const subs: RGBA[][] = [];
    for (let s = 0; s < 6; s++) {
      const colors: RGBA[] = [];
      for (let c = 0; c < 16; c++) colors.push(colorFromBytes(blk, base + s * 32 + c * 2));
      subs.push(colors);
    }
    // NB: unlike the static atlas (EbMapPalette zeroes colour 0), palette-anim
    // frames keep their raw colour 0 — build_atlases uses plain EbPalette here.
    frames.push(subs);
  }
  return { durations, frames };
}

/** {`mapTs_pal`: PaletteAnim} for every animated combo in the ROM. */
export function comboAnimations(rom: Rom): Map<string, PaletteAnim> {
  const cache = new Map<number, PaletteAnim>();
  const out = new Map<string, PaletteAnim>();
  for (const [combo, fe] of flashEffectsByCombo(rom)) {
    let anim = cache.get(fe);
    if (!anim) {
      anim = decodePaletteAnim(rom, fe);
      cache.set(fe, anim);
    }
    out.set(combo, anim);
  }
  return out;
}

export type TileAnim = {
  frames: number;
  delay: number;
  /** Per frame: liveMinitileIndex → animation-buffer minitile index. */
  remaps: Map<number, number>[];
};

/**
 * Decompress drawing tileset `ts`'s tile-animation graphics buffer — the 256
 * minitiles EB loads to $7EC000 and the properties table's src/dst index into.
 */
export function animGraphics(rom: Rom, ts: number): Tile[] {
  const ptr = rom.readMulti(TILE_ANIM_GFX_PTR_TABLE + ts * 4, 3);
  return decodeMinitiles(decompress(rom.data, fromSnesAddress(ptr)), ANIM_GFX_NUM_TILES);
}

/**
 * {drawTilesetId: TileAnim} for every graphics tileset that animates minitiles.
 * `remaps[k]` maps each live minitile index to the buffer minitile its graphics
 * show on frame k (frame 0 == identity). Multiple concurrent sub-animations merge
 * to the max frame count; shorter ones loop within it.
 */
export function tileAnimations(rom: Rom): Map<number, TileAnim> {
  const out = new Map<number, TileAnim>();
  let off = ANIM_TABLE;
  for (let ts = 0; ts < NUM_TILESETS; ts++) {
    const nSub = rom.byte(off);
    off += 1;
    const subs: { frames: number; delay: number; transfer: number; src: number; dst: number }[] =
      [];
    for (let s = 0; s < nSub; s++) {
      subs.push({
        frames: rom.byte(off),
        delay: rom.byte(off + 1),
        transfer: rom.readMulti(off + 2, 2),
        src: rom.readMulti(off + 4, 2),
        dst: rom.readMulti(off + 6, 2),
      });
      off += 8;
    }
    if (subs.length === 0) continue;

    const nFrames = Math.max(...subs.map((s) => s.frames));
    const delay = subs[0].delay;
    const remaps: Map<number, number>[] = Array.from({ length: nFrames }, () => new Map());
    for (const sub of subs) {
      const stride = Math.floor(sub.transfer / MINITILE_BYTES); // live minitiles in this band
      const srcMt = Math.floor(sub.src / MINITILE_BYTES); // frame-0 source minitile
      const dstMt = Math.floor(sub.dst / 16); // VRAM word → minitile (16 words each)
      for (let i = 0; i < stride; i++) {
        const live = dstMt + i;
        for (let k = 0; k < nFrames; k++) {
          const fk = k % sub.frames; // short anims loop within the merged count
          remaps[k].set(live, srcMt + i + fk * stride);
        }
      }
    }
    out.set(ts, { frames: nFrames, delay, remaps });
  }
  return out;
}
