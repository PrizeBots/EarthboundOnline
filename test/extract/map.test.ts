import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractMap, type ExtractedMap } from '../../src/extract/map';

/**
 * Parity test: extractMap() must byte-match native CoilSnake — the full tile
 * plane (incl. local-tileset high bits), all 2560 sectors, and the tileset
 * mapping. Runs against the maintainer's own EarthBound.sfc (gitignored); ground
 * truth from `tools/dump_decomp_fixtures.py`. Skipped when ROM/fixtures absent.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/map_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

describe('map + sector extraction parity with native CoilSnake', () => {
  it.skipIf(!haveInputs)('matches tile plane, sectors, and tileset mapping', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected: ExtractedMap = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const got = extractMap(rom);

    expect(got.tiles.length).toBe(expected.tiles.length);
    expect(got.tiles).toEqual(expected.tiles);
    expect(got.sectors).toEqual(expected.sectors);
    expect(got.tilesetMapping).toEqual(expected.tilesetMapping);
  });
});
