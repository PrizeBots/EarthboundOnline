import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractMap } from '../../src/extract/map';
import { bakeSectorSettings } from '../../src/extract/sectorSettings';

/**
 * Parity test: the TS sector-settings bake (read straight from the ROM attribute
 * tables) must reproduce add_sector_settings.py's yml-derived indoor/dungeon/town
 * for every sector. Ground truth from `tools/dump_decomp_fixtures.py`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/sector_settings_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

type SettingRec = { indoor: boolean; dungeon: boolean; town?: string };

describe('sector-settings bake parity with add_sector_settings.py', () => {
  it.skipIf(!haveInputs)('matches indoor/dungeon/town for every sector', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected: SettingRec[] = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const tagged = bakeSectorSettings(rom, extractMap(rom).sectors);

    expect(tagged.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const got: SettingRec = { indoor: tagged[i].indoor, dungeon: tagged[i].dungeon };
      if (tagged[i].town !== undefined) got.town = tagged[i].town;
      expect(got, `sector ${i}`).toEqual(expected[i]);
    }
  });
});
