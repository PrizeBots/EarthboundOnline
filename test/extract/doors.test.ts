import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractDoors, type DoorRecord } from '../../src/extract/doors';

/**
 * Parity test: extractDoors() must match CoilSnake's DoorModule — every area's
 * door list (kinds + destination/flag/direction fields), including the
 * stop-on-invalid-door behaviour. Ground truth from `tools/dump_decomp_fixtures.py`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/door_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

describe('door extraction parity with native CoilSnake', () => {
  it.skipIf(!haveInputs)('matches all 1280 door areas', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected: DoorRecord[][] = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const got = extractDoors(rom);
    expect(got.length).toBe(expected.length);
    expect(got).toEqual(expected);
  });
});
