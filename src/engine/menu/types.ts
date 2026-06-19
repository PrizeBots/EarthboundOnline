/**
 * menu/types.ts — shared menu types, so MenuManager (state + input) and
 * menu/render.ts (drawing) can both depend on them without importing each other.
 */
import { EquipSlot } from '../Equipment';

/** Every screen the command window can be in. */
export type MenuName =
  | 'closed'
  | 'command'
  | 'message'
  | 'status'
  | 'goods'
  | 'psi'
  | 'shop'
  | 'shop_buy'
  | 'shop_sell'
  | 'phone'
  | 'save'
  | 'confirm'
  | 'atm'
  | 'equip'
  | 'equip_select';

// Hooks into the local player's equipment + PK state, wired by Game (the menu
// has no player ref). getEquipped reads a slot; equip sets it (held sprite for a
// weapon + server 'equip', which applies offense/defense). getPk reads the
// server-authoritative PK flag + lock expiry; setPk asks the server to toggle it.
export interface MenuHooks {
  getEquipped(slot: EquipSlot): string | null;
  equip(slot: EquipSlot, itemId: string | null): void;
  getPk(): { on: boolean; lockedUntil: number };
  setPk(on: boolean): void;
  /** Float a short notice over the player (e.g. "Not enough PP"). Optional. */
  notify?(text: string): void;
  /** True if PSI is currently disabled by a status (the "can't concentrate"
   *  noPsi debuff). Casting is blocked while set. Optional. */
  psiBlocked?(): boolean;
  /** Play an item's "use" animation on the local player (e.g. eating a Cookie).
   *  Visual only — the server broadcasts it so other players see it too. */
  itemUseFx?(itemId: string): void;
  /** Begin target-selection for a PARTY-target PSI (Lifeup/Healing/revive): the
   *  game enters a mode to pick self or an ally, then sends the cast. Returning
   *  true means the game took over (the menu should NOT cast directly). Optional. */
  beginPsiTarget?(abilityId: string): boolean;
}

/** Stat-change preview for the highlighted Buy item: how a stat would read after
 *  buying + wearing it (vs the piece it'd replace). null for non-gear (no stat). */
export interface ShopPreview {
  lines: { label: string; from: number; to: number }[];
}

/** One row of the combined Equip list: a slot, or an unequipped gear item. */
export type EquipRow =
  | { kind: 'slot'; slot: EquipSlot }
  | { kind: 'item'; id: string; name: string };

/**
 * A read-only snapshot of the menu's state, built once per frame by MenuManager
 * and handed to the renderer. The renderer never mutates it — drawing stays a
 * pure function of (ctx, view), so the state machine lives entirely in
 * MenuManager.
 */
export interface MenuView {
  state: MenuName;
  cursorIndex: number;
  goodsCursor: number;
  /** PSI menu: active tab (0..3), family row in that tab, and the tier popup. */
  psiTab: number;
  psiFamilyCursor: number;
  psiTierOpen: boolean;
  psiTierCursor: number;
  equipCursor: number;
  shopRootCursor: number;
  shopBuyCursor: number;
  shopSellCursor: number;
  shopStore: number;
  shopNote: string;
  /** Stat preview for the highlighted Buy row (null unless on shop_buy + gear). */
  shopPreview: ShopPreview | null;
  message: string;
  hotbar: (string | null)[];
  drag: { id: string } | null;
  hooks: MenuHooks | null;
  equipRows: EquipRow[];
  equipStats: { offense: number; defense: number };
  /** Which slot the equip sub-modal is editing (the open right-third list). */
  equipSlotSel: EquipSlot;
  equipSelectCursor: number;
  /** Items shown in the sub-modal for equipSlotSel (id '' = the Take off row). */
  equipSelectItems: { id: string; name: string }[];
}
