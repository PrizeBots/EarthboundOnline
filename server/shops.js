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
// we don't decode yet, so the BASE heal is 0 for everything — the heals we know
// (Cookie/fries/burger, etc.) live in the authored override layer
// (overrides/equip_stats.json), fully visible + editable in the Item Manager.
// Items with no heal are still buyable/sellable; they just no-op on use.
function loadShops(assetsDir) {
  let data = { items: {}, stores: {}, npcShops: {} };
  try {
    data = JSON.parse(fs.readFileSync(path.join(assetsDir, 'map', 'shops.json'), 'utf8'));
  } catch {
    console.warn('[shops] no shops.json — buying/selling disabled until extracted');
  }
  const items = data.items || {};
  const stores = data.stores || {};

  // Crit/dodge/attack-speed per equippable item live in OUR own override file
  // (shops.json is ROM-derived and can't grow), keyed by item id:
  // { "17": { crit: 5, dodge: 0, attackSpeed: 1.15 } }. crit/dodge are percent
  // points; attackSpeed is a swing-rate multiplier (1 = baseline, >1 = faster,
  // <1 = slower — weapons trade firerate vs damage). Merged onto each good's
  // equip block below. Absent file = all gear is neutral. See gameHost
  // recomputeEquipStats.
  let equipStats = {};
  try {
    const p = path.resolve(assetsDir, '..', 'overrides', 'equip_stats.json');
    equipStats = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    /* none authored — gear adds no crit/dodge */
  }

  // GOODS catalog keyed by numeric-string id: { name, cost, heal }. Replaces the
  // old hand-authored registry; inventoryView + use_item read the same shape.
  // Numeric override helper: use the authored value when it's a finite number,
  // else the ROM/base default. Keeps `0` as a real override (not falsy-skipped).
  const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

  const EQUIP_SLOTS = ['weapon', 'body', 'arms', 'other'];

  const goods = {};
  for (const [id, it] of Object.entries(items)) {
    // Our per-item authoring overrides (overrides/equip_stats.json), edited in the
    // Item Manager. Every field is OPTIONAL and layers over the ROM item table:
    // gear gets offense/defense/crit/dodge/attackSpeed/inflict; ALL items can
    // override name, cost, heal, users, and even their KIND (slot: turn a
    // consumable into gear or 'none' to make gear consumable). ROM data is never
    // mutated — this is the mod layer (client/Shop.ts layers the SAME file).
    const ov = equipStats[id] || {};
    // Effective equip slot: an explicit override wins (including 'none' to drop
    // the equip block), else the ROM kind. Anything not a real slot = consumable.
    let slot = ov.slot != null ? ov.slot : it.equip ? it.equip.slot : null;
    if (!EQUIP_SLOTS.includes(slot)) slot = null;
    // Equip data (slot + offense/defense) for gear; null for consumables. Lets
    // the server apply weapon offense to attack damage and refuse to "use"
    // (consume) equippable gear. See tools/extract_shops.py.
    let equip = null;
    if (slot) {
      const base = it.equip || {};
      // attackSpeed defaults to 1 (baseline) when unauthored; a non-positive
      // value would divide-by-zero the cooldown, so clamp to a small positive.
      const aspd = typeof ov.attackSpeed === 'number' && ov.attackSpeed > 0 ? ov.attackSpeed : 1;
      // Raw status-inflict spec for a weapon ([{type, chance}]); gameHost
      // sanitizes it via status.normalizeInflict. null = none authored (the
      // weapon falls back to the baseline paralysis proc in npcSim).
      const inflict = Array.isArray(ov.inflict) ? ov.inflict : null;
      equip = {
        slot,
        offense: num(ov.offense, base.offense | 0),
        defense: num(ov.defense, base.defense | 0),
        crit: ov.crit | 0,
        dodge: ov.dodge | 0,
        attackSpeed: aspd,
        inflict,
      };
    }
    goods[id] = {
      name: typeof ov.name === 'string' && ov.name.trim() ? ov.name : it.name,
      cost: num(ov.cost, it.cost | 0),
      heal: num(ov.heal, 0),
      healPp: num(ov.healPp, 0),
      // Consumable effects beyond raw HP/PP, all authored in the Item Manager and
      // applied by gameHost on use (cure/buffs) or on lethal damage (revive):
      //  cure  — status ids this item clears on use (e.g. ["poison","cold"]).
      //  buffs — timed stat boosts ([{stat, amount, durationMs}]); see buffs.js.
      //  revive — HP an auto-revive restores when it saves you from a killing
      //           blow (0 = not a revive item). Sanitized at the use-site.
      cure: Array.isArray(ov.cure) ? ov.cure : null,
      buffs: Array.isArray(ov.buffs) ? ov.buffs : null,
      revive: num(ov.revive, 0),
      users: Array.isArray(ov.users) ? ov.users : it.users || [],
      equip,
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
