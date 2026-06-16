import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractAll } from '../../src/extract/extractAll';

/**
 * END-TO-END smoke test: run the whole TS extraction pipeline over the ROM and
 * diff its output against the LITERAL committed `public/assets/` files the engine
 * loads today. Unlike the per-module parity tests (which compare to fresh
 * CoilSnake dumps), this proves the composed pipeline reproduces exactly what
 * the running game consumes — the real "is our progress validated" check.
 *
 * Covers the data assets + the tileset data layers (arrangements / collisions /
 * palettes). Atlas PNGs aren't built here (separate step); the pixel decode they
 * derive from is covered by tileset.test.ts / sprites.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const romPath = resolve(root, 'EarthBound.sfc');
const assets = resolve(root, 'public/assets');
const haveInputs = existsSync(romPath) && existsSync(resolve(assets, 'map/tiles.json'));

const load = (p: string) => JSON.parse(readFileSync(resolve(assets, p), 'utf8'));

describe('extraction pipeline vs committed game assets (end-to-end)', () => {
  it.skipIf(!haveInputs)('reproduces the data assets the engine loads', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const out = extractAll(rom);

    // --- map data ---
    expect(out.tiles, 'map/tiles.json (baked)').toEqual(load('map/tiles.json'));
    expect(out.sectors, 'map/sectors.json').toEqual(load('map/sectors.json'));
    expect(out.tilesetMapping, 'map/tileset_mapping.json').toEqual(
      load('map/tileset_mapping.json')
    );
    expect(out.doors, 'map/doors.json').toEqual(load('map/doors.json'));

    // --- sprites ---
    expect(out.sprites.palettes, 'sprites/palettes.json').toEqual(load('sprites/palettes.json'));
    expect(
      out.sprites.groups.map((g) => g.meta),
      'sprites/metadata.json'
    ).toEqual(load('sprites/metadata.json'));

    // --- tilesets (per-tileset data layers) ---
    for (let ts = 0; ts < out.tilesets.length; ts++) {
      expect(out.tilesets[ts].arrangements, `tilesets/${ts}/arrangements.json`).toEqual(
        load(`tilesets/${ts}/arrangements.json`)
      );
      expect(out.tilesets[ts].collisions, `tilesets/${ts}/collisions.json`).toEqual(
        load(`tilesets/${ts}/collisions.json`)
      );
      expect(out.tilesets[ts].palettes, `tilesets/${ts}/palettes.json`).toEqual(
        load(`tilesets/${ts}/palettes.json`)
      );
    }
  });
});
