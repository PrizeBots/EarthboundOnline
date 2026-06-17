/**
 * Gifts — EarthBound present boxes (sprite group 195 closed / 196 open).
 *
 * Each present is a placed prop (in npcs.json) whose CONTENTS + identity come
 * from the ROM-derived catalog public/assets/map/gifts.json (built by
 * tools/extract_gifts.py): item id from the TPT entry's Text Pointer 2, and a
 * unique ROM Event Flag. Authored edits (Gift Manager tool) layer on top via
 * overrides/gifts.json — same overrides pattern as enemies/npcs.
 *
 * Per-PLAYER one-time open: the ROM's single global "opened" flag can't work in
 * an MMO (the world is shared, progress is personal), so each gift maps to a
 * private PlayerFlag at GIFT_FLAG_BASE + romFlag. The SERVER owns the grant
 * (gameHost 'open_gift'): it checks the flag, adds the item, and acks
 * 'gift_opened'; the client then plays the open→fade and marks the flag locally.
 *
 * This module is the shared catalog + the client-side open/fade state helpers.
 * Gift animation state lives on the NPC instance (giftOpenedAt/spriteGroupId);
 * these helpers read it so the Renderer and NPCManager stay declarative.
 */

import { loadJSON } from './AssetLoader';
import { loadSpriteGroup } from './SpriteManager';
import { hasFlag, setFlag } from './PlayerFlags';
import type { NPC } from './NPC';

export interface GiftDef {
  /** Stable placement key — matches the prop's NPC.placementKey (npcs.json k). */
  k: string;
  x: number;
  y: number;
  /** ROM Event Flag — the gift's unique identity; maps to a per-player flag. */
  romFlag: number;
  /** Item id inside, or null for an unresolved "special" present (author it). */
  item: number | null;
  itemName?: string;
  /** True when the ROM contents couldn't be auto-resolved (2-byte Text Ptr 2). */
  special?: boolean;
}

/** Per-gift authored edits (Gift Manager tool), keyed by placement key. */
export interface GiftOverrides {
  version?: number;
  edits?: Record<string, { item?: number | null }>;
}

export const GIFT_SPRITE_CLOSED = 195;
export const GIFT_SPRITE_OPEN = 196;

// Per-player gift flags sit well clear of ROM world flags (<900000) and other
// authored player flags. romFlag is ~800–976, so this band is collision-free.
export const GIFT_FLAG_BASE = 910000;

// Open animation: hold the opened box briefly, then fade it out.
const OPEN_HOLD_MS = 220;
const FADE_MS = 420;
const GONE_MS = OPEN_HOLD_MS + FADE_MS;

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
}

export function allGifts(): GiftDef[] {
  return [...catalog.values()];
}

export function giftForKey(k: string | null): GiftDef | null {
  return k ? (catalog.get(k) ?? null) : null;
}

export function giftFlagId(romFlag: number): number {
  return GIFT_FLAG_BASE + romFlag;
}

/**
 * Tag a freshly built prop as a gift (called from NPCManager.buildStaticNpcs).
 * Only sprite-195 props with a catalog entry become gifts; everything else is
 * left as ordinary scenery.
 */
export function tagGift(npc: NPC): void {
  if (npc.spriteGroupId !== GIFT_SPRITE_CLOSED) return;
  const g = giftForKey(npc.placementKey);
  if (!g) return;
  npc.giftItem = g.item;
  npc.giftRomFlag = g.romFlag;
}

/**
 * A gift the player already opened, past its open animation — hidden from
 * gameplay (skipped in getNearbyNPCs). Mid-animation it stays visible so the
 * open→fade plays out; a gift opened in a PRIOR session (giftOpenedAt 0) is
 * gone immediately on load.
 */
export function giftGone(npc: NPC, now: number): boolean {
  if (npc.giftRomFlag == null) return false;
  if (!hasFlag(giftFlagId(npc.giftRomFlag))) return false;
  return now - npc.giftOpenedAt >= GONE_MS;
}

/** Render alpha for a gift (1 while closed/opening, ramping to 0 as it fades). */
export function giftAlpha(npc: NPC, now: number): number {
  if (!npc.giftOpenedAt) return 1;
  const t = now - npc.giftOpenedAt;
  if (t <= OPEN_HOLD_MS) return 1;
  return Math.max(0, 1 - (t - OPEN_HOLD_MS) / FADE_MS);
}

/**
 * Begin the local open animation after the server confirms the grant
 * ('gift_opened'). Swaps to the opened-box sprite, starts the fade clock, and
 * marks the per-player flag (setFlag persists it; the server already has it, so
 * its set_flag handler is a harmless no-op).
 */
export function beginGiftOpen(npc: NPC): void {
  if (npc.giftRomFlag == null || npc.giftOpenedAt) return;
  npc.giftOpenedAt = Date.now();
  npc.spriteGroupId = GIFT_SPRITE_OPEN;
  void loadSpriteGroup(GIFT_SPRITE_OPEN).catch(() => {}); // ensure the open frame is ready to fade
  setFlag(giftFlagId(npc.giftRomFlag));
}
