'use strict';
// Ground-loot subsystem, extracted from npcSim.js (Phase 2 modularization):
// death drops (rollLoot), the ground-drop list + eject/throw/settle landing
// physics, first-touch pickup (players first, then carry-capped actors), and
// the townsfolk use-what-they-carry mechanic. Server-authoritative: clients
// render drops from `drop_spawn`/`drop_remove` broadcasts (DropManager.ts) and
// the host owns inventory/cash grants (onPickup).
//
// Owns the drop list + tuning constants; world/actor state stays in npcSim and
// arrives through `deps`. Accessor deps (actors, entityDefs, onPickup,
// broadcast) are read late, per call — the underlying bindings are reassigned
// on override reloads / wired in start().
const { hyp } = require('./combatMath');

function createLoot(deps) {
  const {
    consts: { MINITILE },
    blocked, // world collision: solid-tile test (npc/world.js)
    goodFor, // (itemId) => catalog good | null (heal/equip data for npcUseCarried)
    entityDefs, // () => merged per-sprite entity defs (money + drop tables)
    actors, // () => live actor array (reassigned on placement reloads)
    nearPlayers, // grid-local player scan (npcSim's spatial grid)
    onPickup, // () => host pickup claim cb ((playerId, dropWire) => bool) | null
    broadcast, // (msg) => void; drops the message before start() wires the fan-out
  } = deps;

  // --- Ground loot drops (first-touch FFA pickup; never despawn) -------------
  // A drop is a world entity at a fixed spot. The tick finds the first player
  // within DROP_PICKUP_RADIUS and offers it to the host (onPickup), which owns
  // inventory/cash and decides if the player can take it (bag room for items).
  // Accepted -> removed + broadcast; refused (bag full) -> stays for next time.
  const groundDrops = []; // {id, kind, x, y, item?, name?, amount?, fromX?, fromY?, pickableAt?}
  let nextDropId = 1;
  const DROP_PICKUP_RADIUS = 18; // px (anchor distance) to claim a drop
  // Loot ejection: a drop flies out of the corpse at a random angle and lands
  // EJECT_MIN..EJECT_MAX px away, so it never spawns under the killer's feet (no
  // instant grab) and reads as a physical pop-out. It's unclaimable until it lands.
  const EJECT_MIN = 14;
  const EJECT_MAX = 40;
  const EJECT_MS = 450; // flight time; pickup is locked until now + EJECT_MS
  const FALL_PX_PER_MS = 0.18; // speed a wall-landed drop falls to the ground (mirrored: DropManager.ts)
  // Player-aimed toss: cap how far a player can throw a dropped item from their
  // own position. Covers ~the visible on-screen area (256x224, player ~centered)
  // so a forged drop_item can't fling loot across the map. Anti-cheat clamp.
  const THROW_MAX_DIST = 150;

  // Roll an enemy's loot on death from the merged catalog: money is always
  // granted; the item drops with probability `drop.rate` (ROM "Item Rarity",
  // e.g. 1/128). Returns {money, item:{item,itemName}|null} or null if neither.
  // gameHost decides whether the item is grantable (must be a known good).
  function rollLoot(sprite) {
    const e = entityDefs()[String(sprite)] || {};
    const money = (e.money | 0) > 0 ? e.money | 0 : 0;
    // Drop table: prefer the authored `drops` list; fall back to the catalog's
    // single `drop`. Every entry rolls independently against its own `rate`.
    const table = Array.isArray(e.drops) && e.drops.length ? e.drops : e.drop ? [e.drop] : [];
    const items = [];
    for (const d of table) {
      if (!d || !d.item) continue;
      const rate = typeof d.rate === 'number' ? d.rate : 0;
      if (Math.random() < rate) items.push({ item: d.item, itemName: d.itemName || '' });
    }
    return money || items.length ? { money, items } : null;
  }

  // Pick a non-solid landing spot a random angle+distance from (ox,oy). Tries a
  // few angles so loot doesn't settle inside a wall; falls back to the origin.
  function ejectLanding(ox, oy) {
    for (let tries = 0; tries < 6; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = EJECT_MIN + Math.random() * (EJECT_MAX - EJECT_MIN);
      const x = ox + Math.cos(ang) * dist;
      const y = oy + Math.sin(ang) * dist;
      if (!blocked(x - 4, y - 4, 8, 8)) return { x, y };
    }
    return { x: ox, y: oy };
  }

  // A player tossed an item toward (tx,ty). Clamp only the DISTANCE to
  // THROW_MAX_DIST of the player (anti-cheat: can't fling loot across the map) —
  // otherwise the item lands exactly where aimed, walls included. If that spot is
  // solid, spawnDrop's settleLanding slides it down to the nearest reachable tile,
  // so a throw at a building just drops the loot at its base instead of being
  // refused.
  function throwLanding(px, py, tx, ty) {
    let dx = tx - px;
    let dy = ty - py;
    const dist = hyp(dx, dy);
    if (dist > THROW_MAX_DIST) {
      const k = THROW_MAX_DIST / dist;
      dx *= k;
      dy *= k;
    }
    return { x: px + dx, y: py + dy };
  }

  // An item is allowed to land anywhere the player/corpse aimed — walls included.
  // If that spot is solid (building, furniture, map edge), it FALLS straight DOWN
  // until it reaches the first reachable tile, so loot never comes to rest where no
  // one can grab it and the drop reads as physically falling to the ground. Returns
  // the resting spot; the caller diffs Y against the contact spot to drive the fall
  // animation. Tests the same 8x8 foot box the landing pickers use. Caps the slide
  // so a deep wall just keeps the contact spot.
  const SETTLE_STEP = MINITILE; // px per downward probe
  const SETTLE_MAX = 256; // px to search down before giving up
  function settleLanding(x, y) {
    if (!blocked(x - 4, y - 4, 8, 8)) return { x, y };
    for (let dy = SETTLE_STEP; dy <= SETTLE_MAX; dy += SETTLE_STEP) {
      if (!blocked(x - 4, y + dy - 4, 8, 8)) return { x, y: y + dy };
    }
    return { x, y };
  }

  // Wire shape for a drop. Items carry their id (client renders the held sprite);
  // money carries an amount (client renders a coin). While a freshly ejected drop
  // is still in flight we include its origin + flight time so the client animates
  // the arc; once landed those are omitted (a late joiner just sees it at rest).
  function dropWire(d) {
    const base =
      d.kind === 'money'
        ? {
            id: d.id,
            kind: 'money',
            x: d.x,
            y: d.y,
            amount: d.amount | 0,
            // Death cash renders as the c001 "cash" item art; absent → coin glyph.
            ...(d.sprite ? { sprite: d.sprite } : {}),
          }
        : { id: d.id, kind: 'item', x: d.x, y: d.y, item: d.item, name: d.name || '' };
    const animating = d.pickableAt && Date.now() < d.pickableAt;
    if (d.fromX != null && animating) {
      base.fromX = d.fromX;
      base.fromY = d.fromY;
      base.ejectMs = EJECT_MS;
    }
    // Wall landing: tell the client the contact height so it animates the fall
    // (arc/snap to fallFromY, then drop straight down to the resting y).
    if (d.fallFromY != null && animating) base.fallFromY = d.fallFromY;
    return base;
  }

  // Spawn a drop. `landX/landY` is where it comes to rest; pass `origin` (the
  // corpse spot) to make it eject — it arcs out from there and can't be claimed
  // until it lands (now + EJECT_MS). `data` = {item,name} or {amount}.
  function spawnDrop(kind, landX, landY, data, origin) {
    // Land where aimed; if that's a wall, settleLanding gives the spot it falls to.
    const settled = settleLanding(landX, landY);
    const restY = Math.round(settled.y);
    const contactY = Math.round(landY);
    const fell = restY > contactY; // it landed on a wall and dropped down
    const fallMs = fell ? (restY - contactY) / FALL_PX_PER_MS : 0;
    const d = { id: `d${nextDropId++}`, kind, x: Math.round(settled.x), y: restY, ...data };
    if (fell) d.fallFromY = contactY; // first-contact height the client falls from
    if (origin) {
      d.fromX = Math.round(origin.x);
      d.fromY = Math.round(origin.y);
      d.pickableAt = Date.now() + EJECT_MS + fallMs; // locked through the arc AND the fall
    } else if (fell) {
      d.pickableAt = Date.now() + fallMs; // no eject, but still unclaimable mid-fall
    }
    groundDrops.push(d);
    broadcast({ type: 'drop_spawn', drop: dropWire(d) });
    return d;
  }

  // Ground-drop pickup: first player within reach claims each drop. The host
  // owns inventory/cash and decides if it can be taken (bag room); accepted ->
  // remove + broadcast, refused (bag full) -> leave it for next time.
  function pickupByPlayers(now) {
    const claim = onPickup();
    if (!groundDrops.length || !claim) return;
    for (let i = groundDrops.length - 1; i >= 0; i--) {
      const d = groundDrops[i];
      if (d.pickableAt && now < d.pickableAt) continue; // still mid-flight
      // Grid-local scan (was players.find over ALL players — O(drops × players),
      // and a death cash-fountain spawns many drops at once).
      let p = null;
      for (const q of nearPlayers(d.x, d.y, DROP_PICKUP_RADIUS)) {
        if (
          !q.editor &&
          !(q.hp !== undefined && q.hp <= 0) &&
          Math.abs(q.x - d.x) <= DROP_PICKUP_RADIUS &&
          Math.abs(q.y - d.y) <= DROP_PICKUP_RADIUS
        ) {
          p = q;
          break;
        }
      }
      if (p && claim(p.id, dropWire(d))) {
        groundDrops.splice(i, 1);
        broadcast({ type: 'drop_remove', id: d.id });
      }
    }
  }

  // --- Actor loot carrying ---------------------------------------------------
  // Enemies and townsfolk grab item drops they walk over (first-touch, same as
  // players) and hold up to ACTOR_CARRY_CAP. On death they eject their whole
  // haul back onto the ground, so a hoarder you kill gives the loot back. Carry
  // is purely positional — actors don't path toward loot, they just pick up
  // what lands near them. Vehicles/cars never carry (special behaviour).
  const ACTOR_CARRY_CAP = 2; // max ground items an enemy/townsperson holds at once
  function canCarry(n) {
    return !n.dead && (n.isEnemy || n.kind === 'person');
  }

  // Offer each unclaimed item drop to the first eligible actor within reach.
  // Runs AFTER the player pickup pass each tick, so players win contested drops.
  function pickupByActors(now) {
    if (!groundDrops.length) return;
    for (let i = groundDrops.length - 1; i >= 0; i--) {
      const d = groundDrops[i];
      if (d.kind !== 'item') continue; // actors grab items, not money
      if (d.pickableAt && now < d.pickableAt) continue; // still mid-flight
      const a = actors().find(
        (n) =>
          canCarry(n) &&
          n.carried.length < ACTOR_CARRY_CAP &&
          Math.abs(n.x - d.x) <= DROP_PICKUP_RADIUS &&
          Math.abs(n.y - d.y) <= DROP_PICKUP_RADIUS
      );
      if (a) {
        a.carried.push({ item: d.item, name: d.name || '' });
        groundDrops.splice(i, 1);
        broadcast({ type: 'drop_remove', id: d.id });
      }
    }
  }

  // Eject everything an actor was holding — both its loose carry AND anything a
  // townsperson equipped off the ground — onto the ground at its death spot
  // (independent of its own drop table), then reset so a respawn comes back
  // clean. Applies to ANY death — killed by a player, an NPC, or poison.
  function ejectCarried(actor) {
    const haul = [...(actor.carried || []), ...(actor.equipped || [])];
    for (const c of haul) {
      const land = ejectLanding(actor.x, actor.y);
      spawnDrop(
        'item',
        land.x,
        land.y,
        { item: c.item, name: c.name || '' },
        { x: actor.x, y: actor.y }
      );
    }
    actor.carried = [];
    actor.equipped = [];
    actor.weaponBonus = 0;
    actor.armorBonus = 0;
    if (actor.itemId !== null) {
      actor.itemId = null;
      actor.equipDirty = true; // broadcast the cleared held item (so a respawn shows unarmed)
    }
  }

  // A townsperson USES the loot it's carrying (enemies never call this — see the
  // tickNpc caller). One action per call: heal first if hurt, otherwise equip a
  // weapon (more swing damage + held sprite) or armor (damage soak). Healing is
  // consumed; gear moves carried -> equipped (still drops on death). No-op when
  // there's no catalog (GOODS empty) — the actor just keeps hoarding.
  function npcUseCarried(n) {
    if (!n.carried.length) return;
    // 1) Heal when actually hurt and holding a heal item.
    if (n.hp < n.maxHp) {
      const i = n.carried.findIndex((c) => (goodFor(c.item)?.heal | 0) > 0);
      if (i >= 0) {
        n.hp = Math.min(n.maxHp, n.hp + goodFor(n.carried[i].item).heal);
        n.hpDirty = true;
        n.carried.splice(i, 1); // consumed
        return; // one action per call
      }
    }
    // 2) Otherwise equip a weapon or armor we can put to use.
    const ei = n.carried.findIndex((c) => goodFor(c.item)?.equip);
    if (ei < 0) return;
    const c = n.carried[ei];
    const eq = goodFor(c.item).equip;
    if (eq.slot === 'weapon') {
      if ((eq.offense | 0) <= n.weaponBonus) return; // only ever swap UP to a better weapon
      n.weaponBonus = eq.offense | 0;
      n.itemId = String(c.item); // held weapon sprite
      n.equipDirty = true; // broadcast the held-item change (npc_equip)
    } else {
      n.armorBonus += eq.defense | 0; // body/arms/other stack as flat damage soak
    }
    n.equipped.push(c);
    n.carried.splice(ei, 1);
  }

  return {
    drops: () => groundDrops, // the LIVE list (snapshots filter + map over it)
    rollLoot,
    ejectLanding,
    throwLanding,
    spawnDrop,
    dropWire,
    pickupByPlayers,
    pickupByActors,
    ejectCarried,
    npcUseCarried,
  };
}

module.exports = { createLoot };
