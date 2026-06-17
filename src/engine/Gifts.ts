/**
 * Gifts — EarthBound item-containers you open/check: presents (sprite 195),
 * trash cans (214), gift boxes (233), crates (262), jars (322), and a basket
 * (33). All share one mechanism; they differ only by the `sprite` (the look).
 * "Gift" is just the umbrella term.
 *
 * Each is a placed prop (in npcs.json) whose CONTENTS + identity come from the
 * ROM-derived catalog public/assets/map/gifts.json (built by
 * tools/extract_gifts.py): item id from the TPT entry's Text Pointer 2, and a
 * unique ROM Event Flag. Authored edits (Gift Manager tool) layer on top via
 * overrides/gifts.json — same overrides pattern as enemies/npcs.
 *
 * Visual: a PRESENT (sprite 195) packs BOTH states in its OWN sheet — the
 * wrapped/closed box faces South (row 1, the baked direction of every ROM
 * present), the lidless/OPEN box faces North (row 0). Opening flips the box to
 * face North; it PERSISTS showing that open frame (it is NOT removed). Other
 * containers (trash cans, jars…) have no open frame — they grant once and stay
 * unchanged. (Sprite 196 is a "?" thought bubble, NOT an open box — never used.)
 *
 * Per-PLAYER one-time open: the ROM's single global "opened" flag can't work in
 * an MMO (the world is shared, progress is personal), so each gift maps to a
 * private PlayerFlag at GIFT_FLAG_BASE + romFlag. The SERVER owns the grant
 * (gameHost 'open_gift'): it checks the flag, adds the item, and acks
 * 'gift_opened'; the client then flips the box open and marks the flag locally.
 * On load a present whose flag is already set renders open from the start.
 */

import { loadJSON } from './AssetLoader';
import { hasFlag, setFlag } from './PlayerFlags';
import { Direction } from '../types';
import type { NPC } from './NPC';

export interface GiftDef {
  /** Stable placement key — matches the prop's NPC.placementKey (npcs.json k). */
  k: string;
  x: number;
  y: number;
  /** ROM Event Flag — the gift's unique identity; maps to a per-player flag. */
  romFlag: number;
  /** Container sprite group (195 present, 214 trash can, 322 jar, …). */
  sprite: number;
  /** Item id inside, or null for an unresolved "special" present (author it). */
  item: number | null;
  itemName?: string;
  /** True when the ROM contents couldn't be auto-resolved (2-byte Text Ptr 2). */
  special?: boolean;
  /** True for an admin-authored container (Gift Manager), not a ROM placement. */
  added?: boolean;
}

/** One admin-authored container (Gift Manager): a new box/can placed in the world. */
export interface GiftAddition {
  k: string;
  x: number;
  y: number;
  sprite: number;
  romFlag: number;
  item: number | null;
}

/** Authored gift overrides (Gift Manager tool). */
export interface GiftOverrides {
  version?: number;
  /** Contents edits to EXISTING (ROM) gifts, keyed by placement key. */
  edits?: Record<string, { item?: number | null }>;
  /** Brand-new gift boxes the admin placed. */
  additions?: GiftAddition[];
}

export const GIFT_SPRITE_CLOSED = 195;
// Present box (sprite 195) state is encoded by FACING within its own sheet:
// South = closed (row 1, the baked direction), North = open/lidless (row 0).
const GIFT_OPEN_DIR = Direction.N;

/** Is this a present box? Only presents have an open frame (flip-to-North). */
export function isPresentSprite(sprite: number): boolean {
  return sprite === GIFT_SPRITE_CLOSED;
}

// Default display names for the ROM container sprites (the admin can rename a
// sprite group in Entity Manager to override these). Used for Gift Manager tabs.
const CONTAINER_TYPE_NAMES: Record<number, string> = {
  195: 'Presents',
  214: 'Trash cans',
  233: 'Gift boxes',
  262: 'Crates',
  322: 'Jars',
  33: 'Baskets',
};

/** A human label for a container sprite type (falls back to "Sprite N"). */
export function containerTypeName(sprite: number): string {
  return CONTAINER_TYPE_NAMES[sprite] ?? `Sprite ${sprite}`;
}

// Per-player gift flags sit well clear of ROM world flags (<900000) and other
// authored player flags. romFlag is ~800–976, so this band is collision-free.
export const GIFT_FLAG_BASE = 910000;

let catalog = new Map<string, GiftDef>();

/** Load the gift catalog (ROM base + authored overrides). Idempotent. */
export async function loadGifts(): Promise<void> {
  const [base, ov] = await Promise.all([
    loadJSON<GiftDef[]>('/assets/map/gifts.json').catch(() => [] as GiftDef[]),
    loadJSON<GiftOverrides>('/overrides/gifts.json').catch(() => null),
  ]);
  catalog = new Map();
  for (const g of base ?? []) catalog.set(g.k, { ...g });
  for (const [k, e] of Object.entries(ov?.edits ?? {})) {
    const g = catalog.get(k);
    if (!g || e.item === undefined) continue;
    g.item = e.item;
    g.special = e.item == null; // authored to null => still unresolved
  }
  // Admin-placed gift boxes (not ROM placements) — NPCManager spawns a present
  // prop for each so it renders + opens.
  for (const a of ov?.additions ?? []) {
    if (!a || typeof a.k !== 'string') continue;
    catalog.set(a.k, {
      k: a.k,
      x: a.x,
      y: a.y,
      sprite: a.sprite ?? GIFT_SPRITE_CLOSED,
      romFlag: a.romFlag,
      item: a.item ?? null,
      added: true,
    });
  }
  // No sheet preload needed: the open present is sprite 195 (already loaded via
  // its closed props) drawn at a different facing — not a separate sprite group.
}

export function allGifts(): GiftDef[] {
  return [...catalog.values()];
}

/** Just the admin-placed gifts (NPCManager spawns a prop for each). */
export function giftAdditions(): GiftDef[] {
  return [...catalog.values()].filter((g) => g.added);
}

/**
 * Mint a free placement key + per-player ROM flag for a NEW gift. The flag sits
 * at romFlag >= 1000 — clear of the ROM gifts' own range (~800–976) and every
 * other gift in the catalog — so giftFlagId() stays collision-free.
 */
export function freeGiftSlot(): { k: string; romFlag: number } {
  let n = 1;
  while (catalog.has(`gift+${n}`)) n++;
  const used = new Set([...catalog.values()].map((g) => g.romFlag));
  let romFlag = 1000;
  while (used.has(romFlag)) romFlag++;
  return { k: `gift+${n}`, romFlag };
}

export function giftForKey(k: string | null): GiftDef | null {
  return k ? (catalog.get(k) ?? null) : null;
}

export function giftFlagId(romFlag: number): number {
  return GIFT_FLAG_BASE + romFlag;
}

/**
 * Tag a freshly built prop as an item-container (called from
 * NPCManager.buildStaticNpcs). Any prop with a catalog entry becomes a gift,
 * regardless of its sprite (present, trash can, jar…); everything else is left
 * as ordinary scenery.
 */
export function tagGift(npc: NPC): void {
  const g = giftForKey(npc.placementKey);
  if (!g) return;
  npc.giftItem = g.item;
  npc.giftRomFlag = g.romFlag;
  // A present already opened in a PRIOR session (its flag persists) starts open:
  // flip it to the lidless North frame so it loads showing the open box.
  if (isPresentSprite(npc.spriteGroupId) && hasFlag(giftFlagId(g.romFlag))) {
    npc.giftOpenedAt = 1; // nonzero marker — "already opened" (blocks re-open)
    npc.direction = GIFT_OPEN_DIR;
  }
}

/** Has this player already opened the container? (blocks re-open / re-grant). */
export function giftOpened(npc: NPC): boolean {
  return npc.giftRomFlag != null && hasFlag(giftFlagId(npc.giftRomFlag));
}

/**
 * React to the server confirming a grant ('gift_opened'). Marks the per-player
 * flag (setFlag persists it; the server already has it, so its set_flag handler
 * is a harmless no-op). A PRESENT additionally flips to the lidless OPEN frame
 * (sprite 195 facing North) and PERSISTS that way; other containers (trash cans,
 * jars…) have no open frame and simply stay put now that they're emptied.
 */
export function beginGiftOpen(npc: NPC): void {
  if (npc.giftRomFlag == null) return;
  setFlag(giftFlagId(npc.giftRomFlag));
  if (!isPresentSprite(npc.spriteGroupId)) return;
  npc.giftOpenedAt = Date.now();
  npc.direction = GIFT_OPEN_DIR; // show the lidless box, and keep it that way
}
