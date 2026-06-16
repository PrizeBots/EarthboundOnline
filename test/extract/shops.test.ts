import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractShops } from '../../src/extract/shops';

/**
 * Parity test: extractShops() (items + stores + clerk→store trace) must match the
 * committed shops.json the engine/server load.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const romPath = resolve(root, 'EarthBound.sfc');
const committedPath = resolve(root, 'public/assets/map/shops.json');
const haveInputs = existsSync(romPath) && existsSync(committedPath);

describe('shops extraction parity with shops.json', () => {
  it.skipIf(!haveInputs)('matches items, stores, and clerk shops', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
    const got = extractShops(rom);
    expect(got.items, 'items').toEqual(committed.items);
    expect(got.stores, 'stores').toEqual(committed.stores);
    expect(got.npcShops, 'npcShops').toEqual(committed.npcShops);
  });
});
