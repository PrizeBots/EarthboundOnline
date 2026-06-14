/**
 * shops.js — shared shop catalog + transaction validation for BOTH servers
 * (server/index.js and the Vite-embedded dev server in vite.config.ts), so the
 * buy/sell rules never drift between them.
 *
 * Reads the authored public/assets/map/shops.json (item catalog, per-store
 * inventories, clerk->store map; see tools/extract_shops.py). The server is
 * authoritative: it owns each player's money + inventory and validates every
 * buy/sell here. Items are identified on the wire by their numeric id as a
 * STRING (e.g. "88" = Cookie) — the same id the client renders names from.
 */

const fs = require('fs');
const path = require('path');

// HP a consumable restores when used. EarthBound encodes item effects in a way
// we don't fully decode yet, so only the few we know heal; the rest are still
// buyable/sellable, they just don't do anything when "used" (use_item no-ops).
// Cookie (88) keeps the legacy value so the starter item behaves as before.
const HEAL_BY_ID = {
  '88': 6,   // Cookie
  '89': 10,  // Bag of fries
  '90': 50,  // Hamburger
};

function loadShops(assetsDir) {
  let data = { items: {}, stores: {}, npcShops: {} };
  try {
    data = JSON.parse(fs.readFileSync(path.join(assetsDir, 'map', 'shops.json'), 'utf8'));
  } catch {
    console.warn('[shops] no shops.json — buying/selling disabled until extracted');
  }
  const items = data.items || {};
  const stores = data.stores || {};

  // GOODS catalog keyed by numeric-string id: { name, cost, heal }. Replaces the
  // old hand-authored registry; inventoryView + use_item read the same shape.
  const goods = {};
  for (const [id, it] of Object.entries(items)) {
    goods[id] = {
      name: it.name,
      cost: it.cost | 0,
      heal: HEAL_BY_ID[id] || 0,
      // Equip data (slot + offense/defense) for gear; null for consumables.
      // Lets the server apply weapon offense to attack damage and refuse to
      // "use" (consume) equippable gear. See tools/extract_shops.py.
      equip: it.equip || null,
    };
  }

  // Starter items on join. Cookie is the original starter; the Cracked bat
  // (weapon, +4 off) and Cheap bracelet (arms, +5 def) are TEMPORARY dev grants
  // so equip/combat is testable without shopping first — remove before launch
  // (players should buy their gear). See TODO.md.
  const COOKIE_ID = '88';
  const DEV_GEAR = ['17', '64']; // DEV: remove before launch — Cracked bat, Cheap bracelet
  const startingInventory = [];
  if (goods[COOKIE_ID]) startingInventory.push(COOKIE_ID);
  for (const id of DEV_GEAR) if (goods[id]) startingInventory.push(id);

  /** Is `item` (any id type) stocked by `store`? */
  function storeHas(store, item) {
    const list = stores[String(store)];
    return Array.isArray(list) && list.some((i) => String(i) === String(item));
  }

  return { goods, stores, storeHas, startingInventory };
}

module.exports = { loadShops };
