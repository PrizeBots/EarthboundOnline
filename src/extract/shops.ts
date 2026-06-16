/**
 * Shops extraction — reproduces extract_shops.py / `shops.json` from the ROM.
 * EarthBound shops have no dialogue: a clerk NPC's Text Pointer 1 runs a script
 * that does `set(flag N)` then calls the shop routine; the store is `flag - 225`.
 * We trace each person-config's script bytecode (set-flag + a call to the
 * buy/sell or buy-only routine) instead of parsing ccscript.
 *
 * Output: { items, stores, npcShops } — OUR pure-index metadata (no ROM pixels).
 * Parity: `test/extract/shops.test.ts` vs the committed shops.json.
 */
import { Rom, fromSnesAddress } from './Rom';
import { readBlock, operandPointer } from './ebText';
import { extractItemCatalog } from './items';

const NPC_CONFIG_TABLE = 0xcf8985;
const CONFIG_ENTRY_SIZE = 17;
const NUM_CONFIGS = 1584;
const TYPE_OFFSET = 0;
const TEXT_PTR1_OFFSET = 9;
const PERSON_TYPE = 1;

const STORE_TABLE = 0x1576b2; // file offset; 7 item-ids per store
const NUM_STORES = 66;

const FLAG_TO_STORE_OFFSET = 225; // storeId = set-flag - 225
const BUYSELL_ROUTINE = 0xc5decb; // shop routine offering Buy + Sell
const BUY_ROUTINE = 0xc5dfb1; // shop routine offering Buy only
const MAX_TRACE_DEPTH = 8;

// Our fan-game content override (matches extract_shops.py): the Onett Burger
// Shop clerk (config 33) is ROM-wired to store 3 but should sell store 4.
const CLERK_STORE_OVERRIDES: Record<string, number> = { '33': 4 };

export type ShopsData = {
  items: ReturnType<typeof extractItemCatalog>;
  stores: Record<string, number[]>;
  npcShops: Record<string, { store: number; mode: string }>;
};

/** Store inventories (drop empty slots and the null store). */
function extractStores(rom: Rom): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (let s = 0; s < NUM_STORES; s++) {
    const ids: number[] = [];
    for (let k = 0; k < 7; k++) {
      const id = rom.byte(STORE_TABLE + s * 7 + k);
      if (id) ids.push(id);
    }
    if (ids.length) out[String(s)] = ids;
  }
  return out;
}

/**
 * Follow call/goto chains from a clerk's text pointer to find (store flag, mode).
 * Mirrors extract_shops.py's trace_shop over the bytecode: a `set flag` is [04
 * LL HH]; a shop routine is a [08]/[0A] target matching BUYSELL/BUY.
 */
function traceShop(
  rom: Rom,
  addr: number,
  seen: Set<number>,
  depth: number
): { flag?: number; mode?: string } {
  if (depth > MAX_TRACE_DEPTH || seen.has(addr)) return {};
  seen.add(addr);

  const tokens = readBlock(rom, fromSnesAddress(addr));
  let flag: number | undefined;
  let mode: string | undefined;
  const targets: number[] = [];

  for (const t of tokens) {
    if (t.kind !== 'code') continue;
    if (t.op === 0x04 && flag === undefined) {
      flag = t.operand[0] | (t.operand[1] << 8); // set flag
    } else if (t.op === 0x08 || t.op === 0x0a) {
      const tgt = operandPointer(t.operand, 0); // call / goto
      if (tgt === BUYSELL_ROUTINE) mode ??= 'buysell';
      else if (tgt === BUY_ROUTINE) mode ??= 'buy';
      else targets.push(tgt);
    }
  }
  if (flag && mode) return { flag, mode };

  for (const tgt of targets) {
    const r = traceShop(rom, tgt, seen, depth + 1);
    flag ??= r.flag;
    mode ??= r.mode;
    if (flag && mode) return { flag, mode };
  }
  return { flag, mode };
}

/** Clerk NPC config → store + mode, by tracing each person's Text Pointer 1. */
function extractNpcShops(rom: Rom, stores: Record<string, number[]>): ShopsData['npcShops'] {
  const base = fromSnesAddress(NPC_CONFIG_TABLE);
  const out: ShopsData['npcShops'] = {};

  for (let id = 0; id < NUM_CONFIGS; id++) {
    if (rom.byte(base + id * CONFIG_ENTRY_SIZE + TYPE_OFFSET) !== PERSON_TYPE) continue;
    const tp1 = rom.readMulti(base + id * CONFIG_ENTRY_SIZE + TEXT_PTR1_OFFSET, 4);
    if (tp1 === 0) continue;

    const { flag, mode } = traceShop(rom, tp1, new Set(), 0);
    if (!flag || !mode) continue;
    const store = flag - FLAG_TO_STORE_OFFSET;
    if (!(String(store) in stores)) continue; // off-table flag
    out[String(id)] = { store, mode };
  }

  // Content overrides (our fan-game store repoints).
  for (const [id, store] of Object.entries(CLERK_STORE_OVERRIDES)) {
    if (String(store) in stores) {
      out[id] = { store, mode: out[id]?.mode ?? 'buy' };
    }
  }
  return out;
}

export function extractShops(rom: Rom): ShopsData {
  const stores = extractStores(rom);
  return {
    items: extractItemCatalog(rom),
    stores,
    npcShops: extractNpcShops(rom, stores),
  };
}
