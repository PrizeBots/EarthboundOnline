# Loot Drops + Banking (build spec)

Server-authoritative ground loot, first-touch pickup, and an ATM/bank money model.
All economy state lives on the server; clients only _request_, the server decides.
No client ever sets a balance or an inventory — anti-cheat by construction.

## Decisions (locked)

- **Pickup:** pure first-touch FFA — first player to touch a ground drop claims it
  (killer has no priority).
- **Drop tables:** each enemy has `drops: [{item, rate}]`; every entry is rolled
  independently on death (`rate` = probability, from ROM "Item Rarity", e.g. 1/128).
- **Despawn:** ground drops **never** despawn (grab-or-stays). Ephemeral: wiped on
  server restart, not persisted.
- **Money model:** kill money accrues to a **bank** balance (server-only). On-hand
  **cash** is what shops spend. Players move money bank↔cash at an **ATM**
  (sprites **259 / 447**), withdraw **and** deposit, server-validated.
- **Cash drops** are a ground-drop _kind_ (`money`), not an inventory item — on
  pickup they merge straight into on-hand cash (never fill a bag slot).
- **Death penalty:** on death a player drops **50%** of on-hand cash as a `money`
  ground drop at the death spot (bank is always safe). Tunable constant.

## Two drop kinds, one system

A ground drop is a server entity broadcast via the existing area-of-interest path
(same as NPCs). Two kinds:

| kind    | sprite           | on claim                                 |
| ------- | ---------------- | ---------------------------------------- |
| `item`  | held-item sprite | push into bag (14 slots); bag-full popup |
| `money` | coin/wad sprite  | add to on-hand cash; never bag-limited   |

Claim = proximity of a player's anchor to the drop, checked server-side each tick.
First valid claim wins (atomic): mark claimed → remove → broadcast removal. The
`item` claim only succeeds if the bag has room; otherwise the drop **stays** and a
debounced popup tells the player why.

## Phases

### Phase A — Item catalog completeness — DONE (no work)

`shops.json` already holds all 253 EarthBound items (ids 1–253), each classified
weapon (85) / item (168) via its `equip.slot`. All 43 distinct enemy-drop items are
already present. `GOODS` (server) is built from all of them, so the existing
`awardKill` id-guard already passes for every drop. Keep the guard; nothing to add.
(Open content task: confirm each droppable item has a held sprite for ground render.)

### Phase B — Drop tables (server data)

- Schema: add `drops: [{item, rate, itemName?}]` to `EntityStatsSchema`
  (`src/data/overrideSchemas.ts`); keep legacy single `drop` as a fallback the
  catalog still emits.
- `npcSim.rollLoot(sprite)`: roll **every** `drops` entry independently; fall back to
  `drop` if `drops` is absent. Returns `{money, items: [...]}` (was a single item).
- Authored in **EntityManagerTool** (drop-table editor); merges over the
  `enemies.json` catalog default like every other per-entity stat.

### Phase C — Ground-drop entities + first-touch (the backbone) — DONE

- `npcSim`: a `drops` list of `{id, kind, sprite, x, y, payload, claimedBy|null}`.
- On enemy death: instead of crediting the killer, spawn a drop per rolled item at
  the death spot. (Kill **money** still → bank, not a ground drop — see Phase E.)
- Tick: for each unclaimed drop, find the first player within pickup radius that can
  take it; claim atomically, apply payload, broadcast `drop_remove`.
- Wire: `drop_spawn` / `drop_remove` (AoI-filtered) + client render using the
  held-item / coin sprite. Reuse the existing `loot` "Found X!" toast on `item`.

### Phase D — Bag-full popup — DONE

- `item` claim with a full bag: do **not** claim; leave the drop; send a `notice`
  toast ("Your bag is full") **debounced** per (player, drop) so standing on it
  doesn't spam.
- New client toast UI for `notice` (distinct from the `loot` "Found X!" toast).

### Phase E — Bank + ATM — DONE

- Split balances: server `entry.bank` + on-hand `entry.cash` (rename/keep `money`
  as cash). Both persisted in the save row (SQLite now → Supabase at launch) and in
  the welcome snapshot. `Wallet.ts` gains a bank field + display.
- Kill money → `entry.bank += reward`; broadcast a `bank` delta.
- ATM entities (sprites 259/447) become interactable (reuse the talk/check interact
  path). Opening sends an `atm_open`; client shows a withdraw/deposit menu.
- `atm_withdraw {amount}` → validate `bank >= amount` → bank→cash, broadcast both.
  `atm_deposit {amount}` → validate `cash >= amount` → cash→bank. Server clamps; a
  bad/forged amount is rejected, never trusted.

### Phase F — Death drop — DONE

- On player death: spawn a `money` drop worth `floor(cash * 0.5)` at the death spot
  (FFA), set on-hand cash to the remainder. Bank untouched. Constant `DEATH_CASH_PCT`.

## Keep-in-sync notes

- Client `NPCManager` and server `npcSim` must build drop entities + read drop tables
  identically (same merge order: `DEFAULT_ENTITY_STATS < enemies.json < overrides`).
- The economy is server-authoritative: pickup, claim, bank, and ATM math all resolve
  server-side. Clients send intents (`atm_withdraw` etc.), never results.
