/**
 * Shop — the local view of the authored shop catalog (public/.../shops.json,
 * from tools/extract_shops.py). Holds the item catalog (id -> name/cost), each
 * store's stock, and the clerk-NPC -> store map, so talking to a clerk can open
 * the right shop. The SERVER is authoritative on money/inventory and re-prices
 * everything (server/shops.js); this is read-only display data.
 */

import { loadJSON } from './AssetLoader';

export interface ShopItem {
  id: string; // numeric item id as a string (the wire id), e.g. '88' = Cookie
  name: string;
  cost: number; // buy price ($); sell is half (see sellPrice)
}

/** Decoded equip data for gear (EB item types 0x10-0x1F). */
export interface EquipProps {
  slot: 'weapon' | 'body' | 'arms' | 'other';
  offense?: number; // weapons
  defense?: number; // body/arms/other
}

/** Equip slots, plus 'none' = explicitly NOT equippable (a consumable). The Item
 *  Manager writes one of these into an item's override to change its kind. */
export type ItemSlot = EquipProps['slot'] | 'none';
export const EQUIP_SLOTS: EquipProps['slot'][] = ['weapon', 'body', 'arms', 'other'];

/** Per-item authoring overrides (overrides/equip_stats.json) that this read-only
 *  catalog layer cares about. The same file carries combat-only fields
 *  (crit/dodge/attackSpeed/heal/inflict) the SERVER applies — see server/shops.js;
 *  the client only needs the catalog-facing ones below for display + equip. */
interface ItemOverride {
  name?: string;
  slot?: ItemSlot; // change an item's kind (gear ↔ consumable)
  users?: string[]; // who may equip/use
  offense?: number;
  defense?: number;
  cost?: number;
}

interface ItemDef {
  name: string;
  cost: number;
  type: number;
  equip?: EquipProps; // present only for equippable gear
  users?: string[]; // chars who may equip/use, e.g. ['ness']
}

interface ShopData {
  items: Record<string, ItemDef>;
  stores: Record<string, number[]>;
  npcShops: Record<string, { store: number; mode: string }>;
}

const EMPTY: ShopData = { items: {}, stores: {}, npcShops: {} };
let data: ShopData = EMPTY;
// Authoring overrides keyed by item id, layered over the ROM catalog above so
// the in-game UI agrees with the server (which layers the SAME file). Loaded
// alongside the catalog; absent file = neutral. Edited in the Item Manager.
let overrides: Record<string, ItemOverride> = {};

/** Override value when it's a finite number, else the ROM/base default (keeps 0
 *  as a real override rather than a falsy skip). */
function numOv(v: number | undefined, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

export async function loadShops(): Promise<void> {
  data = await loadJSON<ShopData>('/assets/map/shops.json').catch(() => EMPTY);
  overrides =
    (await loadJSON<Record<string, ItemOverride>>('/overrides/equip_stats.json').catch(
      () => ({})
    )) ?? {};
}

/** Store id for a clerk NPC (by its ROM config id), or null if not a shop. */
export function shopStoreForNpc(npcId: number): number | null {
  const s = data.npcShops[String(npcId)];
  return s ? s.store : null;
}

export function itemName(id: string): string {
  const ov = overrides[id]?.name;
  if (ov && ov.trim()) return ov;
  return data.items[id]?.name ?? `Item ${id}`;
}

export function itemCost(id: string): number {
  return numOv(overrides[id]?.cost, data.items[id]?.cost ?? 0);
}

/** EarthBound buys items back at half their cost. */
export function sellPrice(id: string): number {
  return Math.floor(itemCost(id) / 2);
}

/** The items a store stocks, as display rows. */
export function getStoreItems(store: number): ShopItem[] {
  const ids = data.stores[String(store)] ?? [];
  return ids.map((id) => ({
    id: String(id),
    name: itemName(String(id)),
    cost: itemCost(String(id)),
  }));
}

export interface CatalogItem {
  id: string;
  name: string;
  cost: number;
  type: number;
}

/** Every item in the game catalog, id-sorted — the Item Manager's master list. */
export function allItems(): CatalogItem[] {
  return Object.entries(data.items)
    .map(([id, it]) => ({ id, name: itemName(id), cost: itemCost(id), type: it.type }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** EarthBound item Type byte (equip category / consumable bits), or 0. */
export function itemType(id: string): number {
  return data.items[id]?.type ?? 0;
}

/** Decoded equip data (slot + offense/defense) for gear, or null if not gear.
 *  Override-aware: an item's `slot` override can turn a consumable into gear (or
 *  vice versa with 'none'), and offense/defense layer over the ROM values. The
 *  server applies the SAME logic (server/shops.js) so client + server agree on
 *  what fits where. */
export function itemEquip(id: string): EquipProps | null {
  const base = data.items[id]?.equip ?? null;
  const ov = overrides[id] ?? {};
  let slot: ItemSlot | undefined = ov.slot;
  if (slot === undefined) slot = base?.slot; // no override → use ROM kind
  if (!slot || !EQUIP_SLOTS.includes(slot as EquipProps['slot'])) return null; // 'none'/missing
  return {
    slot: slot as EquipProps['slot'],
    offense: numOv(ov.offense, base?.offense ?? 0),
    defense: numOv(ov.defense, base?.defense ?? 0),
  };
}

/** Weapon offense bonus (0 for non-weapons). Override-aware via itemEquip. */
export function itemOffense(id: string): number {
  const e = itemEquip(id);
  return e?.slot === 'weapon' ? (e.offense ?? 0) : 0;
}

/** Armor defense bonus (0 for non-armor). Override-aware via itemEquip. */
export function itemDefense(id: string): number {
  const e = itemEquip(id);
  return e && e.slot !== 'weapon' ? (e.defense ?? 0) : 0;
}

/** Raw ROM equip data, IGNORING overrides — the base the Item Manager shows as the
 *  placeholder/default while you author a slot/offense override. */
export function itemBaseEquip(id: string): EquipProps | null {
  return data.items[id]?.equip ?? null;
}

/** Characters who may equip/use this item, e.g. ['ness']. Override wins when set. */
export function itemUsers(id: string): string[] {
  const ov = overrides[id]?.users;
  if (Array.isArray(ov)) return ov;
  return data.items[id]?.users ?? [];
}
