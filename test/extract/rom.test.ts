import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom, fromSnesAddress } from '../../src/extract/Rom';

/**
 * Parity test: Rom.readTable() must reproduce CoilSnake's table[i][0] values for
 * every pointer/value table extract_rom.py reads. Runs against the maintainer's
 * own EarthBound.sfc (gitignored); table_fixtures.json (ground truth) comes from
 * `tools/dump_decomp_fixtures.py`. Skipped when ROM/fixtures absent.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/table_fixtures.json');

type TableFx = { snesAddr: number; rows: number; entryBytes: number; values: number[] };
type Fixtures = { romSize: number; tables: Record<string, TableFx> };

const haveInputs = existsSync(romPath) && existsSync(fixturePath);
const fixtures: Fixtures | null = haveInputs ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;

describe('Rom address + table reading', () => {
  it('maps SNES HiROM addresses to file offsets', () => {
    expect(fromSnesAddress(0xef105b)).toBe(0xef105b - 0xc00000);
    expect(fromSnesAddress(0x008000)).toBe(0x008000); // below 0xc00000 passes through
  });

  it.skipIf(!haveInputs)('matches native CoilSnake table values', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    expect(rom.size).toBe(fixtures!.romSize);
    for (const [name, fx] of Object.entries(fixtures!.tables)) {
      const got = rom.readTable(fx.snesAddr, fx.rows, fx.entryBytes);
      expect(got, `table ${name}`).toEqual(fx.values);
    }
  });
});
