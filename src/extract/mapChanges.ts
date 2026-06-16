/**
 * Map event tile-changes — extracts EB's event-driven tile swaps from the ROM
 * (CoilSnake `MapEventModule`) and bakes the open-world state into the tile
 * plane. The worker equivalent of apply_map_changes.py, but reading the change
 * table from the ROM instead of the `map_changes.yml` decompile.
 *
 * The ROM's base map is the game-intro state (police barricades block Onett's
 * roads, Giant Step ladders missing). We apply only the curated ALLOW set — the
 * swaps verified against the rendered map — so other areas keep their base state.
 */
import { Rom, fromSnesAddress } from './Rom';
import type { Sector } from './map';

const BANK_BYTE_OFFSET = 0x704;
const POINTER_TABLE_POINTER_OFFSET = 0x70d;
const NUM_DRAW_TILESETS = 20;

const MAP_W_T = 256;
const MAP_H_T = 320;
const MAP_W_SEC = 32;
const SEC_TX = 8;
const SEC_TY = 4;

export type TileChange = { before: number; after: number };
export type MapChangeEntry = { flag: number; changes: TileChange[] };
export type MapChanges = Record<number, MapChangeEntry[]>; // draw tileset → entries

/**
 * Curated open-world bakes (draw tileset → entry index). Matches
 * apply_map_changes.py's ALLOW — our authored game-state selection, NOT bulk ROM
 * data. Other event entries are deliberately left unapplied.
 */
export const ALLOW: ReadonlyArray<readonly [number, number]> = [
  [1, 0], // Onett police barricades → open road (flag 0x8068)
  [13, 0], // Giant Step cave ladders appear (flag 0x8137)
];

/** Read the per-draw-tileset event tile-change table from the ROM. */
export function extractMapChanges(rom: Rom): MapChanges {
  // The data bank lives in one byte; the pointer table is a 3-byte pointer.
  const bank = fromSnesAddress(rom.byte(BANK_BYTE_OFFSET) << 16) >> 16;
  const ptTableOffset = fromSnesAddress(rom.readMulti(POINTER_TABLE_POINTER_OFFSET, 3));

  const out: MapChanges = {};
  for (let ts = 0; ts < NUM_DRAW_TILESETS; ts++) {
    const ptr16 = rom.readMulti(ptTableOffset + ts * 2, 2);
    let d = ptr16 | (bank << 16);

    const entries: MapChangeEntry[] = [];
    // Each entry: [flag:2][numSub:2][ (before:2, after:2) × numSub ]; a 0 flag
    // word terminates the list.
    while (rom.readMulti(d, 2) !== 0) {
      const flag = rom.readMulti(d, 2);
      d += 2;
      const numSub = rom.readMulti(d, 2);
      d += 2;
      const changes: TileChange[] = [];
      for (let s = 0; s < numSub; s++) {
        changes.push({ before: rom.readMulti(d, 2), after: rom.readMulti(d + 2, 2) });
        d += 4;
      }
      entries.push({ flag, changes });
    }
    out[ts] = entries;
  }
  return out;
}

/**
 * Bake the ALLOWed tile swaps into a flat tile plane (returns a new array). For
 * each allowed (drawTileset, entry), swap every Before→After arrangement on map
 * cells whose sector resolves to that drawing tileset.
 */
export function applyMapChanges(
  tiles: number[],
  sectors: Sector[],
  tilesetMapping: number[],
  changes: MapChanges,
  allow: ReadonlyArray<readonly [number, number]> = ALLOW
): number[] {
  const out = tiles.slice();
  for (const [drawTs, entryIdx] of allow) {
    const entries = changes[drawTs] ?? [];
    if (entryIdx >= entries.length) continue;
    const subst = new Map<number, number>();
    for (const c of entries[entryIdx].changes) subst.set(c.before, c.after);

    for (let ty = 0; ty < MAP_H_T; ty++) {
      for (let tx = 0; tx < MAP_W_T; tx++) {
        const sec = sectors[Math.floor(ty / SEC_TY) * MAP_W_SEC + Math.floor(tx / SEC_TX)];
        if (tilesetMapping[sec.tilesetId] !== drawTs) continue;
        const idx = ty * MAP_W_T + tx;
        const repl = subst.get(out[idx]);
        if (repl !== undefined) out[idx] = repl;
      }
    }
  }
  return out;
}
