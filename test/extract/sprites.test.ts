import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractSprites, type ExtractedSprites } from '../../src/extract/sprites';

/**
 * Parity test: extractSprites() must byte-match native CoilSnake — every group's
 * metadata + decoded indexed pixel grid + the 8 shared palettes. Runs against
 * the maintainer's own EarthBound.sfc (gitignored); ground truth from
 * `tools/dump_decomp_fixtures.py`. Skipped when ROM/fixtures absent.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/sprite_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

describe('sprite-group extraction parity with native CoilSnake', () => {
  it.skipIf(!haveInputs)('matches all groups + palettes', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected: ExtractedSprites = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const got = extractSprites(rom);

    expect(got.palettes).toEqual(expected.palettes);
    expect(got.groups.length).toBe(expected.groups.length);
    for (let i = 0; i < expected.groups.length; i++) {
      expect(got.groups[i].meta, `group #${expected.groups[i].meta.id} meta`).toEqual(
        expected.groups[i].meta
      );
      expect(got.groups[i].pixels, `group #${expected.groups[i].meta.id} pixels`).toEqual(
        expected.groups[i].pixels
      );
    }
  });
});
