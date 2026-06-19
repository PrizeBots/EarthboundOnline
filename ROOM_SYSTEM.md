# Room System — Cleanup & Refactor Plan

> Status: **PLAN / pre-build.** This doc is the design we agreed to before writing
> code. It is the foundation for shops-by-room, hotels/healing, save rooms, and
> the future scripting system. Update it as the build lands.

## TL;DR

Today "a room" is **four different, overlapping things** that don't know about each
other. This refactor collapses spatial identity into **one** first-class entity —
a **Room** = `stable id + region + typed properties (including its BGM)` — and makes
every other system a _consumer_ of it (camera crop, music, Places navigator, shops,
hotels, scripting). The Sound Manager's "rectangle → song" model is the proven
pattern we mirror; in fact **music becomes just one Room property**, which is the
"every room plays one BGM" parity we want.

---

## Why — the problem (the mess we're cleaning up)

There are currently **four** systems that each answer a slice of "where am I / what is
this space," with no shared identity:

| #   | System               | File                                                   | What it owns                                                                                                                      | Persistence                             | Has stable ID?      |
| --- | -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------- |
| 1   | **Room registry**    | `src/engine/Rooms.ts`                                  | `RoomDef` (id, label, town, type, rect, spawn); `roomAt()` point-in-rect; `setActiveRoomFromPoint()` every frame (`Game.ts:1061`) | `overrides/rooms.json` (file)           | ✅ `"onett_burger"` |
| 2   | **Camera crop**      | `Collision.ts:computeRoomBounds` → `Camera.roomBounds` | Flood-fill of walkable minitiles → crop box + occlusion holes + movement cells                                                    | ephemeral (recomputed from collision)   | ❌                  |
| 3   | **Places navigator** | `src/editor/LocationNav.ts`                            | Door-derived town→building→room tree + manual overrides (`PlacesDoc`)                                                             | DB `world_docs` via `/api/world/places` | key-based           |
| 4   | **Music areas**      | `SoundTool.ts` + `MusicManager.ts`                     | `MusicArea {name,x,y,w,h,song}`; point-in-rect + sticky hysteresis; ~507 areas tiling the map                                     | `overrides/music.json` (file)           | name only           |

Consequences of the split:

- **Identity is scattered.** Room #1 has stable IDs but only covers **net-new authored**
  rooms — none of the ROM's real shops/hospitals/houses are in it. The flood-fill crop
  (#2) knows the _shape_ of every ROM interior but has **no identity** to hang data on.
- **Music is its own island.** #4 already tiles the whole map with regions→song, but it's
  a parallel rectangle system that duplicates what a room region is.
- **Shops are NPC-bound, not room-bound.** A shop opens only because you talk to a clerk
  (`npc.shopStore` → `openShop`, `Game.ts:1749`). The _room_ doesn't know it's a shop, so
  nothing room-scoped (heal-on-enter, hotel sleep, "you're in a store" music) is possible.
- **Nowhere to put room properties.** No `type:shop` / `type:hotel`, no per-room data → no
  substrate for the behaviors we want, and no foundation for scripting.

This is the blocker. Fixing it unlocks shops, hotels, healing, save rooms, and scripting
in one coherent move.

---

## The big idea

**One Room entity. Everything else consumes it.**

```
                 ┌─────────────────────────────┐
                 │   ROOM REGISTRY (Rooms.ts)   │   ← single source of spatial
                 │   id · region · typed props  │     identity + properties
                 └─────────────┬───────────────┘
        ┌──────────────┬───────┼────────────┬──────────────┐
        ▼              ▼       ▼            ▼              ▼
   Camera crop     Music     Places     Shops / Hotel   Scripting
   (visual only)   (bgm=     (library/  (type+props     (enter/exit
                    prop)     nav over   drive menus     events +
                              rooms)     & healing)      behaviors)
```

- A **Room** owns: a **stable id**, a **region** (one or more rects), and a **typed
  property set** — `name`, `bgm`, `type` (`overworld` | `shop` | `hospital` | `hotel` |
  `house` | `bedroom` | `dungeon` | …), plus **type-specific fields** (a shop's store id, a
  hotel's cost/heal/bedroom-warp, etc.).
- **`setActiveRoomFromPoint()` already runs every frame** — it becomes the single "what room
  am I in" resolver and **emits `room:enter` / `room:exit` on the EventBus**.
- **Music folds in:** `updateMusic()` reads `activeRoom.bgm` instead of its own rectangle
  lookup. The ~507 music areas **seed** the initial room library (instant map coverage +
  every region already carries a song → bgm).
- **Camera flood-fill crop stays** as a _visual_ mechanism only (it's good at irregular
  shapes + occlusion). Rooms provide _identity + data + bgm_, not the pixel crop. This
  **decouples room identity from the fragile collision flood-fill.**
- **Places becomes the human-facing library/navigator** over the room registry. It already
  links nodes to rooms by `roomId` (`LocNode.roomId`) — we lean on that instead of inventing
  a parallel tree.

---

## Data model (proposed)

Extend `RoomDef` with a region list and a discriminated, per-type property block. Typed
unions (not a loose `Record`) so the Room Manager can render **type-conditional panels**
(same approach as the Combat tool's conditional dials).

```ts
interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type RoomType =
  | 'overworld'
  | 'shop'
  | 'hospital'
  | 'hotel'
  | 'house'
  | 'bedroom'
  | 'dungeon'
  | 'other';

interface RoomBase {
  id: string; // stable, e.g. "onett_drugstore"
  label: string; // "Onett Drugstore"
  town?: string | null; // navigator grouping
  regions: RoomRect[]; // one or more rects (L-shaped rooms = multiple)
  spawn?: { x: number; y: number; dir: number };
  bgm?: number | null; // SPC song number — THE per-room BGM (null = inherit/silence)
}

type Room =
  | (RoomBase & { type: 'shop'; storeId: number })
  | (RoomBase & { type: 'hospital'; healCost?: number }) // heal-for-pay or free
  | (RoomBase & { type: 'hotel'; cost: number; bedroomWarp?: { x; y; dir }; wakeBgm?: number })
  | (RoomBase & { type: 'bedroom'; isSaveRoom?: boolean })
  | (RoomBase & { type: 'house' | 'dungeon' | 'overworld' | 'other' });
```

Notes:

- `regions: RoomRect[]` (vs a single rect) handles non-rectangular interiors without
  flood-fill, and lets us seed straight from one-or-more music areas.
- Keep an escape hatch (`meta?: Record<string, unknown>`) for experimental props before they
  earn a typed field — but the goal is typed-per-type so tools and consumers stay honest.

---

## Persistence — **DECIDED: DB `world_docs`**

Rooms live in the DB as the `'rooms'` world doc (via `/api/world/rooms`), consistent with
Places (its navigator) and shippable/synced like real content. Requires adding `'rooms'` to
`WORLD_DOC_ALLOW` (`server/authApi.js:38`). The existing `overrides/rooms.json` is migrated
into the doc once, then retired. Music's `overrides/music.json` is **superseded** by room
`bgm` (read once during seeding, then retired).

---

## Room Manager tool (parity with Sound Manager)

A new editor tool (`src/editor/tools/RoomManagerTool.ts`), modeled on `SoundTool`:

- **Select a room** two ways: a searchable list (grouped town → type, from
  `roomsByTownAndType()`) **and** click-on-map (the active room under the cursor).
- **Edit properties** in a panel: `name`, `type` (dropdown), **`bgm`** (reuse the Sound
  Manager's `createSpritePicker` song dropdown + ▶ Test), and **type-conditional fields**
  (shop → store picker; hotel → cost / heal / bedroom-warp / wake-bgm; bedroom → save toggle).
- **Edit region(s)** on the map like music areas: draw / move / resize rects, snap to grid.
- **Live + auto-save** through the shell (`markDirty('rooms')`), pushing the working set into
  the engine immediately (`setRoomList(...)`) so the crop/music/behavior update without reboot
  (fixes today's "reboot to reload rooms" gap).
- **Test buttons:** jump-to-room, preview bgm, and (later) "run this room's behavior" (e.g.
  trigger the hotel sleep sequence) without leaving the editor.

---

## Consumers this unlocks

1. **Shops by room.** A `shop` room carries `storeId`. The clerk NPC can still open it, but
   now the _room_ knows its store → enables room-scoped UX and removes the "shop only via the
   one clerk" coupling. (Keep clerk trigger; augment, don't rip out.)
2. **Hospital healing.** `hospital` room → heal flow (free or `healCost`) on clerk-talk or
   on a healing tile; the room is the anchor.
3. **Hotel sleep sequence — the first real _script_.** Interact in a `hotel` room →
   `pay cost → fade out → restore HP/PP → (optional) warp to bedroomWarp → swap to wakeBgm →
fade in "refreshed"`. The room supplies every parameter; the sequence is a scripted
   behavior keyed off `type:hotel`.
4. **Save rooms / bedroom.** `bedroom { isSaveRoom }` → save point; future "teleport home"
   warps here.
5. **Per-room music** falls out for free — it's just `bgm`.

---

## Scripting foundation (why this is the keystone)

The room refactor _is_ the bottom layer of scripting:

- **Triggers:** `room:enter` / `room:exit` events on the existing **EventBus**, plus
  interaction-in-room. These join the **FlagTriggers** spine already built for quests.
- **Data:** room `type` + typed props are the parameters a behavior reads.
- **Behaviors:** a small registry of `type → behavior` (hotel-sleep, hospital-heal,
  shop-open). The hotel sequence is the proof-of-concept; once it works as a hand-written
  behavior, generalize the _sequence_ (fade/heal/warp/bgm/dialogue steps) into the first
  authored **script** primitives.

So: **rooms now → behaviors next → authored scripts after.** Each step ships value on its own.

---

## What this does NOT touch (scope guard)

- **Collision & Priority Painter** — unaffected by design. Room _identity_ stops depending on
  the collision flood-fill (it moves to authored regions), so the painter's job actually
  _shrinks_ w.r.t. rooms: it keeps painting walls/priority; the flood-fill crop keeps working
  for visuals. No painter refactor required.
- **Combat / loot / PSI** — untouched.
- **The networking model** — rooms are client-resolved like music today; no new server sim.
  (Server only needs the `world_docs 'rooms'` endpoint if we pick the DB option.)

---

## Migration & seeding (how we populate the library cheaply)

1. **Seed from music areas.** Convert each `MusicArea {x,y,w,h,song}` → a `Room {regions:[rect],
bgm:song, type:'overworld'/'other'}`. Instant map-wide coverage + bgm already set. A
   one-time script (`tools/seed_rooms_from_music.py` or an in-editor "Import music areas"
   button) writes the initial `rooms` doc.
2. **Door-derived interiors → rooms.** Reuse LocationNav's door-graph (it already finds
   building/room landings) to mint interior rooms with sensible `town` + a guessed `type` from
   sign text ("DRUGSTORE" → shop, "HOTEL" → hotel, "HOSPITAL" → hospital).
3. **Backfill types** in the Room Manager by hand for the few that matter first (Onett's shops
   - hotel) — enough to build & test the hotel sequence end-to-end.

---

## Phased build order

- **Phase 0 — Cleanup/scaffolding.** Extend `RoomDef` → `Room` (regions[] + typed props),
  add `room:enter`/`room:exit` events to `setActiveRoomFromPoint`, decide persistence.
- **Phase 1 — Registry + seed.** Seed rooms from music areas; load at boot; live `setRoomList`.
- **Phase 2 — Room Manager tool.** Select/edit/region-draw/bgm/type-conditional panels +
  auto-save (the parity-with-Sound-Manager deliverable).
- **Phase 3 — Music fold-in.** `updateMusic` reads `activeRoom.bgm`; retire `music.json` after
  one migration pass. (This is the literal "one BGM per room" milestone.)
- **Phase 4 — Shop/Hospital binding.** `shop.storeId` opens the store; hospital heal flow.
- **Phase 5 — Hotel sequence (first script).** The sleep→heal→warp→wake behavior, fully
  data-driven from the room.
- **Phase 6 — Scripting generalization.** Lift the hotel sequence into reusable script steps;
  wire to FlagTriggers/EventBus.

Each phase is independently shippable; Phases 0–3 are the "clean up + parity" core, Phases
4–6 are the payoff.

---

## Decisions (locked)

1. **Persistence → DB `world_docs` `'rooms'`.** ✅ DECIDED. Consistent with Places; shippable.
   Add `'rooms'` to `WORLD_DOC_ALLOW`; migrate `rooms.json` → the doc.
2. **Music → subsume into rooms.** ✅ DECIDED. `bgm` is a room property; seed from the 507
   music areas; `updateMusic` reads `activeRoom.bgm`; retire `music.json` after one pass.
3. **Region model → authored `rects[]`.** ✅ ADOPTED (recommended; revisit if a real interior
   resists rect coverage). Flood-fill stays for the visual crop only.
4. **Shop trigger → keep clerk + add room.** ✅ ADOPTED (additive, no regressions).

```

```
