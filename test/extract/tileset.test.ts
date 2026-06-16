import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractTilesets, type DecodedTileset } from '../../src/extract/tileset';

/**
 * Parity test: extractTilesets() must byte-match native CoilSnake for all 20
 * drawing tilesets — minitiles, arrangement cells, collision bytes, palettes.
 * Runs against the maintainer's own EarthBound.sfc (gitignored); ground truth
 * from `tools/dump_decomp_fixtures.py`. Skipped when ROM/fixtures absent.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const tablePath = resolve(here, '../../tools/_parity/table_fixtures.json');
const tsPath = resolve(here, '../../tools/_parity/tileset_fixtures.json');

const haveInputs = existsSync(romPath) && existsSync(tablePath) && existsSync(tsPath);

type TableFx = { snesAddr: number; rows: number; entryBytes: number; values: number[] };
type Fixtures = { tables: Record<string, TableFx> };

describe('tileset extraction parity with native CoilSnake', () => {
  it.skipIf(!haveInputs)('matches all 20 tilesets', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const tf: Fixtures = JSON.parse(readFileSync(tablePath, 'utf8'));
    const expected: DecodedTileset[] = JSON.parse(readFileSync(tsPath, 'utf8'));

    const got = extractTilesets(rom, {
      graphics: tf.tables.graphics.values,
      arrangements: tf.tables.arrangements.values,
      collisions: tf.tables.collisions.values,
      mapTileset: tf.tables.map_tileset.values,
      palette: tf.tables.palette.values,
    });

    expect(got.length).toBe(expected.length);
    for (let ts = 0; ts < expected.length; ts++) {
      expect(got[ts].minitiles, `tileset ${ts} minitiles`).toEqual(expected[ts].minitiles);
      expect(got[ts].arrangements, `tileset ${ts} arrangements`).toEqual(expected[ts].arrangements);
      expect(got[ts].collisions, `tileset ${ts} collisions`).toEqual(expected[ts].collisions);
      expect(got[ts].palettes, `tileset ${ts} palettes`).toEqual(expected[ts].palettes);
    }
  });
});
