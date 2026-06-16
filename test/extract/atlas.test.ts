import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom, fromSnesAddress } from '../../src/extract/Rom';
import { decompress } from '../../src/extract/decompress';
import { decodeMinitiles, decodeMapPalette, type RGBA } from '../../src/extract/tileset';
import { renderAtlas, decodeRawArrangements } from '../../src/extract/atlas';

/**
 * Parity test: renderAtlas() must produce byte-identical RGBA to build_atlases.py
 * (which generated the committed atlas PNGs). Compared via MD5 of the raw RGBA
 * buffers for a few real combos. Ground truth from `tools/dump_decomp_fixtures.py`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/atlas_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

const md5 = (buf: Uint8ClampedArray) =>
  createHash('md5').update(Buffer.from(buf.buffer)).digest('hex');

describe('atlas render parity with build_atlases.py', () => {
  it.skipIf(!haveInputs)('matches RGBA hashes for sampled combos', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const fixtures: Record<string, { bg: string; fg: string | null }> = JSON.parse(
      readFileSync(fixturePath, 'utf8')
    );

    const graphics = rom.readTable(0xef105b, 20, 4);
    const arrange = rom.readTable(0xef10ab, 20, 4);
    const mapTileset = rom.readTable(0xef101b, 32, 2);
    const palette = rom.readTable(0xef10fb, 32, 4);

    // Per drawing tileset: decoded minitiles + raw arrangement cells (cached).
    const cache = new Map<
      number,
      { minitiles: ReturnType<typeof decodeMinitiles>; raw: (number[] | null)[] }
    >();
    const tilesetData = (drawTs: number) => {
      let d = cache.get(drawTs);
      if (!d) {
        d = {
          minitiles: decodeMinitiles(decompress(rom.data, fromSnesAddress(graphics[drawTs]))),
          raw: decodeRawArrangements(decompress(rom.data, fromSnesAddress(arrange[drawTs]))),
        };
        cache.set(drawTs, d);
      }
      return d;
    };

    // Resolve a (mapTs,pal) combo's 6 subpalettes the same way extractTilesets does.
    const subpalettesFor = (mapTs: number, pal: number): RGBA[][] => {
      const numPal = mapTs === 31 ? 8 : Math.floor((palette[mapTs + 1] - palette[mapTs]) / 0xc0);
      const off = fromSnesAddress(palette[mapTs]) + pal * 0xc0;
      if (pal >= numPal) throw new Error(`combo ${mapTs}_${pal} has no palette`);
      return decodeMapPalette(rom, off);
    };

    for (const [key, expected] of Object.entries(fixtures)) {
      const [mapTs, pal] = key.split('_').map(Number);
      const { minitiles, raw } = tilesetData(mapTileset[mapTs]);
      const { bg, fg } = renderAtlas(minitiles, subpalettesFor(mapTs, pal), raw);
      expect(md5(bg), `${key} bg`).toBe(expected.bg);
      expect(fg ? md5(fg) : null, `${key} fg`).toBe(expected.fg);
    }
  });
});
