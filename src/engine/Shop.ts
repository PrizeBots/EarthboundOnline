/**
 * Shop — the local view of the authored shop catalog (public/.../shops.json,
 * from tools/extract_shops.py). Holds the item catalog (id -> name/cost), each
 * store's stock, and the clerk-NPC -> store map, so talking to a clerk can open
 * the right shop. The SERVER is authoritative on money/inventory and re-prices
 * everything (server/shops.js); this is read-only display data.
 */

import { loadJSON } from './AssetLoader';

export interface ShopItem {
  id: string;   // numeric item id as a string (the wire id), e.g. '88' = Cookie
  name: string;
  cost: number; // buy price ($); sell is half (see sellPrice)
}

/** Decoded equip data for gear (EB item types 0x10-0x1F). */
export interface EquipProps {
  slot: 'weapon' | 'body' | 'arms' | 'other';
  offense?: number; // weapons
  defense?: number; // body/arms/other
}

interface ItemDef {
  name: string;
  cost: number;
  type: number;
  equip?: EquipProps;   // present only for equippable gear
  users?: string[];     // chars who may equip/use, e.g. ['ness']
}

interface ShopData {
  items: Record<string, ItemDef>;
  stores: Record<string, number[]>;
  npcShops: Record<string, { store: number; mode: string }>;
}

const EMPTY: ShopData = { items: {}, stores: {}, npcShops: {} };
let data: ShopData = EMPTY;

export async function loadShops(): Promise<void> {
  data = await loadJSON<ShopData>('/assets/map/shops.json').catch(() => EMPTY);
}

/** Store id for a clerk NPC (by its ROM config id), or null if not a shop. */
export function shopStoreForNpc(npcId: number): number | null {
  const s = data.npcShops[String(npcId)];
  return s ? s.store : null;
}

export function itemName(id: string): string {
  return data.items[id]?.name ?? `Item ${id}`;
}

export function itemCost(id: string): number {
  return data.items[id]?.cost ?? 0;
}

/** EarthBound buys items back at half their cost. */
export function sellPrice(id: string): number {
  return Math.floor(itemCost(id) / 2);
}

/** The items a store stocks, as display rows. */
export function getStoreItems(store: number): ShopItem[] {
  const ids = data.stores[String(store)] ?? [];
  return ids.map((id) => ({ id: String(id), name: itemName(String(id)), cost: itemCost(String(id)) }));
}

export interface CatalogItem { id: string; name: string; cost: number; type: number; }

/** Every item in the game catalog, id-sorted — the Item Manager's master list. */
export function allItems(): CatalogItem[] {
  return Object.entries(data.items)
    .map(([id, it]) => ({ id, name: it.name, cost: it.cost, type: it.type }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** EarthBound item Type byte (equip category / consumable bits), or 0. */
export function itemType(id: string): number {
  return data.items[id]?.type ?? 0;
}

/** Decoded equip data (slot + offense/defense) for gear, or null if not gear. */
export function itemEquip(id: string): EquipProps | null {
  return data.items[id]?.equip ?? null;
}

/** Weapon offense bonus (0 for non-weapons). */
export function itemOffense(id: string): number {
  const e = data.items[id]?.equip;
  return e?.slot === 'weapon' ? e.offense ?? 0 : 0;
}

/** Armor defense bonus (0 for non-armor). */
export function itemDefense(id: string): number {
  const e = data.items[id]?.equip;
  return e && e.slot !== 'weapon' ? e.defense ?? 0 : 0;
}

/** Characters who may equip/use this item, e.g. ['ness']. */
export function itemUsers(id: string): string[] {
  return data.items[id]?.users ?? [];
}
