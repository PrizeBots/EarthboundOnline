/**
 * Inventory — the local player's Goods, mirrored from the server.
 *
 * The server is authoritative: it grants the starting Cookie, validates every
 * "use", and pushes the canonical list (welcome snapshot + `inventory`
 * deltas). This module just holds the latest copy so the Goods menu can render
 * it without threading state through Game. On SNES this maps to the goods RAM
 * table the menu reads.
 */

export interface GoodsItem {
  id: string;   // server slug (e.g. 'cookie')
  name: string; // display label (e.g. 'Cookie')
}

let goods: GoodsItem[] = [];

/** Replace the Goods list (called on welcome and every `inventory` delta). */
export function setGoods(items: GoodsItem[]): void {
  goods = Array.isArray(items) ? items : [];
}

export function getGoods(): readonly GoodsItem[] {
  return goods;
}
