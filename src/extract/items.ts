/**
 * Item table extraction — reads the EarthBound item configuration table from the
 * ROM. For now exposes item NAMES (needed by dialogue's {itemname} codes); the
 * full shop catalog (cost/type/equip stats + stores) builds on this.
 *
 * Table: 254 entries × 39 bytes at file 0x155000. Each entry begins with a
 * 25-byte name field — EB-encoded (`byte - 0x30`), null-terminated.
 */
import { Rom } from './Rom';

const ITEM_TABLE = 0x155000; // file offset
const ITEM_ENTRY_SIZE = 39;
const NUM_ITEMS = 254;
const NAME_FIELD_LEN = 25;

/** Decode one item's name from its entry at `offset`. */
function decodeItemName(rom: Rom, offset: number): string {
  let name = '';
  for (let i = 0; i < NAME_FIELD_LEN; i++) {
    const b = rom.byte(offset + i);
    if (b === 0) break; // null-terminated
    name += String.fromCharCode(b - 0x30);
  }
  return name;
}

/** Map of item id → display name (un-stripped; matches eb_dialogue's source). */
export function extractItemNames(rom: Rom): Record<number, string> {
  const out: Record<number, string> = {};
  for (let id = 0; id < NUM_ITEMS; id++) {
    out[id] = decodeItemName(rom, ITEM_TABLE + id * ITEM_ENTRY_SIZE);
  }
  return out;
}

// Item entry field offsets within the 39-byte entry.
const TYPE_OFFSET = 25;
const COST_OFFSET = 26; // 2 bytes LE
const MISC_FLAGS_OFFSET = 28; // bitfield
const ARGUMENT_OFFSET = 31; // 4 bytes
const EQUIP_SLOTS = ['weapon', 'body', 'arms', 'other'] as const;
// Misc Flags "<X> can ..." bits → user "x". Bits 0–3 are the party members;
// bit 4 is "Item can change", whose name also matches the "<X> can" pattern, so
// extract_shops.py emits a user "item" — replicated here for parity.
const USERS = ['ness', 'paula', 'jeff', 'poo', 'item'];

export type EquipProps = { slot: string; offense?: number; defense?: number };
export type ItemRecord = {
  name: string;
  cost: number;
  type: number;
  equip?: EquipProps;
  users?: string[];
};

/**
 * Full item catalog (ids 1–253, skipping the null item 0) — the `items` block of
 * shops.json. Decodes name/cost/type plus the equip slot+bonus (Type 0x10–0x1F)
 * and who-may-use (Misc Flags bits 0–3, alphabetised to match the pipeline).
 */
export function extractItemCatalog(rom: Rom): Record<string, ItemRecord> {
  const out: Record<string, ItemRecord> = {};
  for (let id = 1; id < NUM_ITEMS; id++) {
    const base = ITEM_TABLE + id * ITEM_ENTRY_SIZE;
    const type = rom.byte(base + TYPE_OFFSET);
    const rec: ItemRecord = {
      name: decodeItemName(rom, base).trim(),
      cost: rom.readMulti(base + COST_OFFSET, 2),
      type,
    };

    if (type >= 0x10 && type < 0x20) {
      const slot = EQUIP_SLOTS[(type >> 2) & 3];
      const arg0 = rom.byte(base + ARGUMENT_OFFSET);
      rec.equip = slot === 'weapon' ? { slot, offense: arg0 } : { slot, defense: arg0 };
    }

    const misc = rom.byte(base + MISC_FLAGS_OFFSET);
    const users = USERS.filter((_, bit) => misc & (1 << bit)).sort();
    if (users.length) rec.users = users;

    out[String(id)] = rec;
  }
  return out;
}
