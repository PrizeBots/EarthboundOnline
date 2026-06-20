# Room System — Cleanup & Refactor Plan

> Status: **IN BUILD.** Phases 0, 1, 3 are LANDED (parity core: one merged room
> registry, 505 region rooms seeded from music with parity verified, music folded
> onto room `bgm` with hysteresis preserved). Phase 2 (Room Manager tool) and
> Phases 4–6 (shop/hospital/hotel/scripting) are the remaining feature builds.
> This doc is the design + the running record; update it as each phase lands.

## TL;DR

Today "a room" is **four different, overlapping things** that don't know about each
other. This refactor collapses spatial identity into **one** first-class entity —
a **Room** = `stable id + region + typed properties (including its BGM)` — and makes
every other system a _consumer_ of it (camera crop, music, Places navigator, shops,
hotels, scripting). The Sound Manager's "rectangle → song" model is the proven
pattern we mirror; in fact **music becomes just one Room property**, which is the
"every room plays one BGM" parity we want.

---

## Guiding principle: lossless parity

This is a **consolidation, not a redesign** — the bar is that the unified system reproduces
everything the four old systems did, with **zero information lost** in migration:

- Every `MusicArea` (song + region + name) → a room. Verify by count before retiring `music.json`.
- Every custom room (`rooms.json`) → unchanged geometry + identity.
- Every Places node (door-derived, manual override, `roomId` link) → preserved.
- Every camera crop behavior → still produced by the flood-fill (untouched).

Old files retire **only after** a parity check proves their data survived in the new home. If
in doubt, carry a field forward (even into `meta`) rather than drop it. "Bring it to parity,
lose nothing" is the success test for Phases 0–3.

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
  - ⚠️ **Port the hysteresis or music regresses.** `areaForPoint` is sticky
    (`EDGE_MARGIN`, current-area-wins-until-clearly-left, `MusicManager.ts:75-87`) to stop
    songs flipping when you brush a seam. `setActiveRoomFromPoint`/`roomAt` have **no**
    hysteresis (instant first-match switch). The room→bgm resolver MUST carry the sticky
    logic forward. Acceptance test for Phase 3: **no song flip when hugging a room seam.**
  - **`bgm: null` = fall back to the sector's ROM `musicId`** (today's floor in
    `updateMusic`, `MusicManager.ts:499`). Keep that fallback when `music.json` retires —
    null means "inherit ROM default," not silence.
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
  bgm?: number | null; // SPC song number — THE per-room BGM (null = inherit sector musicId)
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
`WORLD_DOC_ALLOW` (`server/authApi.js:38`, currently `['places', 'stamps']`).

> ⚠️ **`overrides/rooms.json` does NOT retire — it is a different file than we assumed.**
> `rooms.json` is owned by **RoomBuilderTool** and carries heavy **band geometry**
> (`tiles[]`, `composites`, `bandX/Y`); `MapManager.buildCustomRoomBand()` stamps those
> tiles into the appended map band and is the **only** caller of `setRoomList()`
> (`MapManager.ts:146`). It stays as-is. The new DB `'rooms'` doc is the **identity +
> props overlay** (id → name/type/bgm/region/type-fields), a _separate_ layer merged onto
> the custom-room defs by id (see "Reconciliation" below). Music's `overrides/music.json`
> is **superseded** by room `bgm` (read once during seeding, then retired) — but the
> per-sector `musicId` fallback in `updateMusic` stays as the floor (`MusicManager.ts:499`).

---

## Reconciliation — custom rooms vs region rooms (READ BEFORE Phase 0)

The plan above writes as if `Rooms.ts` were a free-standing metadata registry. It is not:
today it is the **output of physically-stamped interior geometry**. There are really
**two kinds of room** and the refactor must hold both, merged:

- **Custom rooms** (existing): net-new authored interiors stamped into the map band by
  RoomBuilderTool. Geometry lives in `overrides/rooms.json`; `RoomDef.rect` is derived
  from `bandX*32`. Source of truth for these stays `rooms.json`.
- **Region rooms** (new): identity + typed props over arbitrary map regions (overworld
  bgm zones, ROM interiors). Source of truth is the DB `'rooms'` doc.

**Merge model (decide here, build in Phase 0):** the registry that `roomAt()` scans is the
**union** of (a) custom-room defs from `buildCustomRoomBand()` and (b) region rooms from
the `'rooms'` doc, joined by `id`. A `'rooms'`-doc entry whose `id` matches a custom room
**augments** it (adds type/bgm/props to the band geometry); an entry with no band match is
a standalone region room. **`setRoomList()` must merge, not replace** — today it's called
once by the band builder; the Room Manager's live push has to combine both sources or it
will clobber the custom rooms (and vice-versa).

**Overlap resolution:** `roomAt` returns the _first_ containing rect; music's `areaForPoint`
returns the _last_ (topmost) + sticky. With overlapping regions (a shop inside an overworld
bgm zone) array order is nondeterministic. Define precedence explicitly —
**most-specific / smallest-area wins** (or an explicit priority field) — not list order.

### RoomBuilderTool already creates and names custom rooms — don't make a third editor

The Room Manager is **not** the only tool touching `label`/`town`/`type`. RoomBuilderTool
already does, and it's the _creator_ of custom rooms. Today:

- A new custom room is born with `label: "Room N"`, **`town: 'custom'`, `type: 'custom'`**
  (`RoomBuilderTool.ts:951-953, 1215-1217`). Note `'custom'` is **not** a valid `RoomType`
  in the new union — migration must remap it (→ `'other'`).
- **Naming is RoomBuilder's flow:** double-click a room in its list → `startInlineRename`
  → `room.label = name`, persisted to `rooms.json` (`:1285, :1895`).
- **Geometry is edited in RoomBuilder** via corner-handle resize (`:504-512`), driven by
  `bandX/bandY/w/h`. A custom room's `rect` is _derived_ from that — it is NOT a free rect.

This forces two ownership rules (decision #9 below):

| Field set                          | Owner / source of truth                                       | Editor                                                                                                |
| ---------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`, band geometry, `spawn`       | `rooms.json` (custom rooms only)                              | **RoomBuilder** (create/resize)                                                                       |
| `label`, `town`                    | `rooms.json` for custom rooms; `'rooms'` doc for region rooms | created in RoomBuilder; **re-editable in Room Manager** (writes back to whichever doc owns that room) |
| `type`, `bgm`, type-specific props | DB `'rooms'` doc (overlay)                                    | **Room Manager** only                                                                                 |

### Places sync — every place/room represented, nothing duplicated

The Places outline (`LocationNav`) is built from THREE sources today and the refactor must
keep all three, merged losslessly:

1. **Door-derived tree** — town→building→room from the door graph (ROM shops/houses).
2. **Manual overrides** (`PlacesDoc`) — hand-edited nodes + `roomId` links.
3. **Injected rooms** — `injectInstancedRooms()` lists every registry room under a synthetic
   "Custom Rooms (N)" building per town (`LocationNav.ts:1564`).

Parity rules for the merged registry:

- **Dedup via `roomId`.** When seeding mints a region room for a ROM interior that is already
  a door node, **link them by `roomId`** (the field already exists, `LocNode.roomId`) — one
  entry, not a door node _and_ a registry room. Seeding must set `roomId` on the matching door
  node, not create a parallel entry.
- **Segregate overworld bgm zones** under a collapsed "BGM Zones (N)" node per town, separate
  from "Custom Rooms" and door-derived interiors. `injectInstancedRooms` (or its successor)
  splits registry rooms by `type`: `overworld` → BGM group, everything else → places.
- **Nothing dropped.** Custom rooms, ROM door nodes, manual overrides, and all 507 bgm zones each
  resolve to exactly one outline entry. The navigator is the proof every room is accounted for.

Consequences for the Room Manager spec:

- **Don't let Room Manager redraw custom-room regions.** Drawing/moving/resizing rects is for
  **region rooms only**. A custom room's geometry stays RoomBuilder-owned (editing a rect here
  would desync from the stamped tiles). The Manager shows custom-room geometry read-only.
- **Room Manager must be able to re-type any room,** including the `type:'custom'` custom rooms
  RoomBuilder mints — that's how a built interior becomes a `shop`/`hotel`/`hospital`.
- **RoomBuilder should stop pretending `type:'custom'` is meaningful.** Either drop the
  hardcoded `type` at creation (let it default to `'other'`/untyped) or leave it as a
  placeholder the Manager overrides. Don't have two tools writing conflicting `type` values.

---

## Room Manager tool (parity with Sound Manager)

A new editor tool (`src/editor/tools/RoomManagerTool.ts`), modeled on `SoundTool`:

- **Select a room** two ways: a searchable list (grouped town → type, from
  `roomsByTownAndType()`) **and** click-on-map (the active room under the cursor).
- **Edit properties** in a panel: `name`, `type` (dropdown), **`bgm`** (reuse the Sound
  Manager's `createSpritePicker` song dropdown + ▶ Test), and **type-conditional fields**
  (shop → store picker; hotel → cost / heal / bedroom-warp / wake-bgm; bedroom → save toggle).
- **Edit region(s)** on the map like music areas: draw / move / resize rects, snap to grid —
  **for region rooms only.** Custom rooms (authored in RoomBuilder) show their geometry
  **read-only** here; their size/shape is edited in RoomBuilder (corner-handle resize), since
  the rect is derived from the stamped tile band. (See Reconciliation → RoomBuilder.)
- **Re-type any room,** including the `type:'custom'` custom rooms RoomBuilder mints — assigning
  `shop`/`hotel`/`hospital`/etc. is how a built interior gains behavior. `label`/`town` edits
  here write back to whichever doc owns the room (custom → `rooms.json`, region → `'rooms'` doc).
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
  - **New work:** the `GameEvent` union only has `area:entered` (sector) today
    (`EventBus.ts:21-31`). Phase 0 must add the typed `room:enter` / `room:exit` variants
    and FlagTriggers match support — small, but it's net-new, not free.
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
- **The networking model** — room _resolution_ (which room am I in, crop, music) is
  client-side like music today; no new server sim for that. Server adds the
  `world_docs 'rooms'` endpoint only.
  - ⚠️ **But room _effects_ that touch HP/PP/money must be server-authoritative.**
    Hotel-heal, hospital-heal, shop purchase, and save-room restore are exactly the values
    a client must not own (trivial cheat) — and the EventBus doc already names the server as
    the future flag-write owner. PSI/loot already route server-side; hotel/hospital/save
    follow that pattern (client triggers the behavior, server validates + applies the
    mutation). Phases 4–5 are NOT pure-client. Resolution client-side, effects server-side.

---

## Migration & seeding (how we populate the library cheaply)

1. **Door-derived interiors → rooms FIRST.** Reuse LocationNav's door-graph (it already
   finds building/room landings) to mint interior rooms with sensible `town` + a guessed
   `type` from sign text ("DRUGSTORE" → shop, "HOTEL" → hotel, "HOSPITAL" → hospital). This
   is high-value, low-count, and navigator-worthy — do it before the music dump.
2. **Seed from music areas (every one → a room, nothing dropped).** Convert each
   `MusicArea {x,y,w,h,song}` → a `Room {regions:[rect], bgm:song, type:'overworld'}`. Carry
   the area `name` over as the room `label` so no info is lost. A one-time script
   (`tools/seed_rooms_from_music.py` or an in-editor "Import music areas" button) writes these
   into the `rooms` doc. **Parity check:** assert `#rooms-with-bgm == #music-areas` and every
   area's `song` survived before retiring `music.json`.
   - **Segregate, don't hide.** ~507 overworld zones must stay represented (parity), but can't
     drown the real places. Group them under a **collapsed "BGM Zones (N)" node** per town in
     the navigator (parallel to "Custom Rooms"), not interleaved with interiors. Everything is
     reachable; the meaningful places stay on top. _Promoting_ a zone to a real place
     (interior/shop/hotel) is a Room Manager action that moves it out of the BGM group.
3. **Backfill types** in the Room Manager by hand for the few that matter first (Onett's shops
   - hotel) — enough to build & test the hotel sequence end-to-end.

---

## Phased build order

- **Phase 0 — Cleanup/scaffolding. ✅ DONE.** `RoomDef` extended (`regions[]`, `bgm`, optional
  `rect`, `RoomType`); `Rooms.ts` is a dual-source merged registry (`setRoomList` custom +
  `setRegionRooms` region, neither clobbers the other); `roomAt` uses smallest-area-wins;
  `room:enter`/`room:exit` added to `GameEvent` + emitted from `setActiveRoomFromPoint`;
  FlagTriggers matches `room`; `'rooms'` added to `WORLD_DOC_ALLOW`.
- **Phase 1 — Registry + seed. ✅ DONE.** `vite.config` seeds the `'rooms'` doc from `music.json`
  once (505 rooms, parity verified); boot calls `loadRegionRooms()` → `setRegionRooms()`.
- **Phase 2 — Room Manager tool. ✅ DONE (needs click-test).** `RoomManagerTool.ts`, registered
  in the hub. Select from a list or click-on-map; draw/move/resize region rects (snap to tile
  grid); edit name/town/type (dropdown) + bgm (song picker + ▶ Test) + type-conditional fields
  (shop storeId, hospital healCost, hotel cost/wakeBgm/warp, bedroom save-point). Edits push
  live via `setRegionRooms` + auto-save to the `'rooms'` doc. Scope: edits REGION rooms;
  re-typing custom rooms via the overlay is a deferred follow-up.
- **Phase 3 — Music fold-in. ✅ DONE.** `updateMusic` resolves bgm from the active room (sticky
  hysteresis ported via `pointInRoom` + `EDGE_MARGIN`), sector `musicId` as the floor. Boot no
  longer loads `music.json`; the Sound Manager uses it only for live authoring/preview
  (`setMusicAuthoring`). The literal "one BGM per room" milestone.
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
5. **Custom rooms vs region rooms → merge, don't replace.** ✅ DECIDED. `rooms.json` (band
   geometry) stays RoomBuilder's; DB `'rooms'` doc is the props overlay; `roomAt()` scans
   the union joined by `id`; `setRoomList()` merges both sources. (See Reconciliation.)
6. **Music hysteresis → carried into the room resolver.** ✅ DECIDED. The sticky
   `EDGE_MARGIN` behavior moves with bgm; "no song flip at a seam" is a Phase 3 acceptance test.
7. **Room effects (heal/pay/save) → server-authoritative.** ✅ DECIDED. Resolution stays
   client-side; HP/PP/money mutations route through the server like PSI/loot. Phases 4–5.
8. **Overlap precedence → most-specific (smallest area) wins,** not list order.
9. **RoomBuilder stays the custom-room creator/namer; Room Manager owns type/bgm/props.**
   ✅ DECIDED. No third name editor: RoomBuilder creates + names + resizes band geometry;
   Room Manager assigns `type`/`bgm`/type-fields (overlay) and can re-type custom rooms but
   shows their geometry read-only. Migrate custom rooms' `type:'custom'` → `'other'`. (See
   Reconciliation → RoomBuilder.)
10. **One label field per room — editable from either tool.** ✅ DECIDED. RoomBuilder and Room
    Manager both rename; both write the _same_ stored field (the room's home doc), never a
    shadow copy. Rename anywhere, no divergence.
11. **Lossless parity, verified.** ✅ DECIDED. Every music area, custom room, and Places node maps
    to exactly one entry in the new system; overworld bgm zones are **segregated (collapsed
    "BGM Zones" group), not hidden**; ROM interiors dedup via `roomId`. Old files retire only
    after a count/parity check.

```

```
