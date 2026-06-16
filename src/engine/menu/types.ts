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
  | 'equip';

// Hooks into the local player's equipment + PK state, wired by Game (the menu
// has no player ref). getEquipped reads a slot; equip sets it (held sprite for a
// weapon + server 'equip', which applies offense/defense). getPk reads the
// server-authoritative PK flag + lock expiry; setPk asks the server to toggle it.
export interface MenuHooks {
  getEquipped(slot: EquipSlot): string | null;
  equip(slot: EquipSlot, itemId: string | null): void;
  getPk(): { on: boolean; lockedUntil: number };
  setPk(on: boolean): void;
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
  psiCursor: number;
  equipCursor: number;
  shopRootCursor: number;
  shopBuyCursor: number;
  shopSellCursor: number;
  shopStore: number;
  shopNote: string;
  message: string;
  hotbar: (string | null)[];
  drag: { id: string } | null;
  hooks: MenuHooks | null;
  equipRows: EquipRow[];
  equipStats: { offense: number; defense: number };
}
