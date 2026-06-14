/**
 * Equipment — the local mirror of the player's equipped gear, one item per
 * EarthBound slot (Weapon / Body / Arms / Other). The SERVER is authoritative
 * (it applies the equipped offense/defense to combat); this just mirrors the
 * latest set for the Equip screen and the held-weapon sprite. Updated
 * optimistically when the menu equips, then re-synced by the server's
 * `equipped` message. In-memory only (resets on rejoin) until a save system
 * lands. Mirrors the per-slot model in vite.config.ts / server/index.js.
 */
export type EquipSlot = 'weapon' | 'body' | 'arms' | 'other';
export const EQUIP_SLOTS: EquipSlot[] = ['weapon', 'body', 'arms', 'other'];
export const SLOT_LABELS: Record<EquipSlot, string> = {
  weapon: 'Weapon', body: 'Body', arms: 'Arms', other: 'Other',
};

const equipped: Record<EquipSlot, string | null> = {
  weapon: null, body: null, arms: null, other: null,
};

export function getEquipped(slot: EquipSlot): string | null {
  return equipped[slot];
}

export function getAllEquipped(): Readonly<Record<EquipSlot, string | null>> {
  return equipped;
}

/** Optimistic local set (the menu calls this before the server confirms). */
export function setEquipped(slot: EquipSlot, itemId: string | null): void {
  equipped[slot] = itemId;
}

/** Authoritative replace from the server's `equipped` message. */
export function setEquippedFromServer(slots: Partial<Record<EquipSlot, string | null>>): void {
  for (const s of EQUIP_SLOTS) equipped[s] = slots[s] ?? null;
}
