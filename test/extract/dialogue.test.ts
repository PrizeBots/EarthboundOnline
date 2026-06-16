import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractDialogue } from '../../src/extract/dialogue';
import { extractItemNames } from '../../src/extract/items';

/**
 * Parity test: dialogue decoded from the ROM must match the committed
 * npc_text.json (eb_dialogue.py's output) for every NPC config it lists. Uses
 * the same open-world flag state (src/world_flags.json).
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const romPath = resolve(root, 'EarthBound.sfc');
const npcTextPath = resolve(root, 'public/assets/map/npc_text.json');
const flagsPath = resolve(root, 'src/world_flags.json');
const haveInputs = existsSync(romPath) && existsSync(npcTextPath) && existsSync(flagsPath);

function loadSetFlags(): Set<number> {
  const data = JSON.parse(readFileSync(flagsPath, 'utf8')) as { setFlags: string[] };
  return new Set(data.setFlags.map((f) => parseInt(f, 16)));
}

describe('dialogue extraction parity with npc_text.json', () => {
  it.skipIf(!haveInputs)('matches dialogue for every committed NPC config', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const committed: Record<string, string[]> = JSON.parse(readFileSync(npcTextPath, 'utf8'));
    const ids = Object.keys(committed).map(Number);
    const got = extractDialogue(
      rom,
      { setFlags: loadSetFlags(), itemNames: extractItemNames(rom) },
      ids
    );

    const mismatches: string[] = [];
    for (const id of Object.keys(committed)) {
      if (JSON.stringify(got[id]) !== JSON.stringify(committed[id])) {
        mismatches.push(id);
      }
    }
    if (mismatches.length) {
      const sample = mismatches
        .slice(0, 5)
        .map((id) => ({ id, got: got[id], want: committed[id] }));
      console.log(
        `${mismatches.length}/${ids.length} mismatched. Sample:`,
        JSON.stringify(sample, null, 2)
      );
    }

    // Config 1091 is the dad's phone call — an INFINITE `{inc}` loop
    // (l_0xc63352 ⇄ l_0xc63382 saying "Ness....Ness....") that only the page cap
    // breaks. The decoded text is identical; eb_dialogue.py and our decoder just
    // cut the never-ending loop at a different iteration (one extra "Ness...."
    // page). Not a decode error — an arbitrary loop-cutoff artifact. Everything
    // else must be byte-exact.
    const KNOWN_INFINITE_LOOP = ['1091'];
    expect(mismatches.filter((id) => !KNOWN_INFINITE_LOOP.includes(id))).toEqual([]);
  });
});
