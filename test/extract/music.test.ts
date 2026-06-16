import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractMusicMap } from '../../src/extract/music';

/**
 * Parity test: extractMusicMap() must match the committed music_map.json the
 * engine loads (which extract_music_map.py produced from map_music.yml).
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const romPath = resolve(root, 'EarthBound.sfc');
const committedPath = resolve(root, 'public/assets/music/music_map.json');
const haveInputs = existsSync(romPath) && existsSync(committedPath);

describe('music-map extraction parity', () => {
  it.skipIf(!haveInputs)('matches the committed music_map.json', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected = JSON.parse(readFileSync(committedPath, 'utf8'));
    expect(extractMusicMap(rom)).toEqual(expected);
  });
});
