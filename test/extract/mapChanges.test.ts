import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractMap } from '../../src/extract/map';
import { extractMapChanges, applyMapChanges, type MapChanges } from '../../src/extract/mapChanges';

/**
 * Parity test: extractMapChanges() must reproduce CoilSnake's MapEventModule for
 * every draw tileset, AND applyMapChanges() must bake the same open-world tile
 * plane as apply_map_changes.py's ALLOW set. Ground truth from
 * `tools/dump_decomp_fixtures.py`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/map_changes_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

type Fixtures = { changes: Record<string, MapChanges[number]>; bakedTiles: number[] };

describe('map event tile-changes parity', () => {
  it.skipIf(!haveInputs)('extracts changes + bakes the open-world plane', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected: Fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

    // 1. The extracted change table matches CoilSnake for all 20 tilesets.
    const changes = extractMapChanges(rom);
    for (let ts = 0; ts < 20; ts++) {
      expect(changes[ts], `tileset ${ts} changes`).toEqual(expected.changes[String(ts)]);
    }

    // 2. Baking the ALLOW set over the raw plane matches the Python bake.
    const { tiles, sectors, tilesetMapping } = extractMap(rom);
    const baked = applyMapChanges(tiles, sectors, tilesetMapping, changes);
    expect(baked).toEqual(expected.bakedTiles);
  });
});
