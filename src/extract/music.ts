/**
 * Music-map extraction — ports extract_music_map.py reading from the ROM
 * (CoilSnake MapMusicModule) instead of the `map_music.yml` decompile. Produces
 * `music_map.json`: musicId → default SPC song number.
 *
 * Each musicId points at a list of {Event Flag, Music} entries; the first entry
 * with flag 0x0 is the unconditional default. The Music field is 2 bytes but a
 * real song number is ≤ 191 (larger values are conditional/script music we map
 * to 0). Parity: `test/extract/music.test.ts` vs the committed music_map.json.
 */
import { Rom, fromSnesAddress } from './Rom';

const MAP_MUSIC_ASM_POINTER = 0x6939; // 3-byte pointer to the music pointer table
const NUM_MUSIC = 165;
const MUSIC_DATA_BANK = 0x0f0000; // entries live in bank 0x0f
const MAX_ENTRIES = 64; // safety bound on a malformed list

export function extractMusicMap(rom: Rom): Record<string, number> {
  const ptTableOffset = fromSnesAddress(rom.readMulti(MAP_MUSIC_ASM_POINTER, 3));
  const out: Record<string, number> = {};

  for (let i = 0; i < NUM_MUSIC; i++) {
    const ptr = rom.readMulti(ptTableOffset + i * 2, 2);
    let o = MUSIC_DATA_BANK | ptr; // bank 0x0f file offset
    let def = 0;
    for (let n = 0; n < MAX_ENTRIES; n++) {
      const flag = rom.readMulti(o, 2);
      const music = rom.readMulti(o + 2, 2);
      o += 4;
      if (flag === 0) {
        def = music <= 191 ? music : 0;
        break;
      }
    }
    out[String(i)] = def;
  }
  return out;
}
