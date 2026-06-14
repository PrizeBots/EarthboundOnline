# Game Editor Tools

Dev-only authoring tools to build the world faster. They **augment** the Python
pipeline with live, in-engine *admin intervention* — they do not replace it. The
`tools/` scripts remain the canonical ROM→data path; the editors add a human
authoring/override layer on top (see
[Relationship to the Python Pipeline](#relationship-to-the-python-pipeline)).

## Goal & Sequencing
Two phases, in order:

1. **Phase 1 — excellent py pipeline (priority, the bulk of the work).** The
   `tools/` scripts should auto-build **~99%** of the world correctly straight
   from the ROM: placement, anchors, collision/priority, doors, dialogue, sector
   settings. The quality bar is "almost nothing needs hand-fixing." When a whole
   *class* of things is wrong, the fix is a better py heuristic — not clicking
   through instances in an editor.
2. **Phase 2 — admin editors (the last 1% + new content).** Editors exist to
   (a) tweak the residual outliers the pipeline genuinely can't infer, and
   (b) author **net-new content** that doesn't exist in the ROM at all — new
   NPCs, dialogue, doors, areas.

**Guardrail:** never build an editor feature to paper over a pipeline gap. The
urge to bulk-fix something in the editor is a signal to improve a py tool
instead. Editors are for the residual and the net-new, never for setup.

## Decisions
- **UI: HTML/DOM overlay.** Hub and tool panels are HTML/CSS layered over the
  canvas (fast forms/lists/inputs). The live world + overlays stay on the canvas;
  editors only read/draw against the real `Renderer`/`Camera`.
- **Save channel: Vite dev-server middleware.** The write endpoint runs *only*
  during `npm run dev` — it is not part of the production bundle and never exists
  on the deployed express/Render server, so it cannot ship by construction (no
  runtime gate to forget).

## Relationship to the Python Pipeline
The editors do **not** replace `tools/`. Data flows:

```
ROM --extract_*.py--> base JSON --apply overrides (authored in editors)--> final assets
```

The `tools/` scripts split into three roles:

1. **Extraction pipeline — untouchable.** `extract_rom`, `apply_map_changes`,
   `build_atlases`, `extract_npcs`, `eb_dialogue`, `add_sector_settings`,
   `build_spc_mapping`. The only path from ROM to data. Editors never write here.
2. **Verifiers — keep, and surface inside the editors.** `debug_room_crop_check`
   (canonical room checker), `verify_dialogue.mjs`, `verify_props.mjs`,
   `debug_person_anchor_stats`. A tool's "Verify" button just runs these.
3. **Ad-hoc inspectors — the live readout ends the *need to write new ones*.**
   `debug_find_*`, `debug_room_ascii`, `debug_room_inspect`, etc. Existing ones
   stay; the cursor readout/overlays mean the pile stops growing.

**Editors write to an overrides layer, never to generated files directly.** This
mirrors the patterns already in the codebase — `apply_map_changes.py`'s curated
`ALLOW` table and `DoorManager`'s `ZONE_DOOR_OVERRIDES`. Consequences:
- Re-extracting from the ROM never clobbers authoring (overrides re-apply on top).
- Provenance stays clean: ROM-derived base vs. human-authored overrides are
  separable. The overrides are *our* non-ROM data — shippable under the PokeMMO
  model, while the base regenerates from the player's own ROM.

## Principles
- **Dev-only, never shipped.** Editors and their save channel are excluded from
  production builds — the save endpoint only exists in the Vite dev server. They
  must never reach players.
- **Edits go to the overrides layer, not generated files.** Tools read the
  extracted data (`npcs.json`, `tiles.json`, etc.) for context but *save* to
  override files that the pipeline bakes on top — so re-extraction never clobbers
  authoring. Never ROM-derived pixels/audio — keeps the PokeMMO distribution
  model intact (see CLAUDE.md).
- **Port-clean.** Everything an editor touches maps to a real SNES concept:
  placement → OAM, collision/priority → BG tile attributes, dialogue → script
  text. Don't author anything that couldn't exist on hardware.
- **Live in the real renderer.** Edit against the actual `Renderer`/`Camera` so
  what you see is what ships — no separate preview that can drift.
- **Reuse the `SpriteEditor.ts` overlay pattern** for input/mode handling.
- **Reuse the sprite picker.** Any "choose a sprite" UI must use the shared
  `createSpritePicker` dropdown in `engine/SpritePicker.ts` (trigger + every row
  render the real sprite next to its id/name) — not a number field or stepper.
  Pair it with `drawSpriteGroupThumb` and `listSpriteGroupIds()`. The Cast
  editor and the Enemy Spawner both use it.

---

## 0. Editor Shell (foundation — build first)
Shared plumbing every tool depends on. Nothing else is cheap until this exists.
**Built 2026-06-12** (`src/editor/EditorShell.ts`), smoke-tested via
`tools/verify_editor.mjs` (Playwright: F2 → hub → pan → exit).

- [x] Dev flag gate — `Game.init()` loads `src/editor/` via a dynamic import
      inside `if (import.meta.env.DEV)`; verified absent from the production
      bundle (0 editor strings, module count unchanged)
- [x] Editor mode toggle (F2) that suspends normal gameplay input/update
      (`Game.update`/`onKeyDown` check `editor.isActive()`; remote players and
      NPCs keep simulating so the world stays live)
- [x] Free-fly camera decoupled from `camera.follow` (WASD/arrows pan, Shift =
      fast, left-drag pan) with mouse-wheel zoom 0.25x–2x, anchored at the
      cursor (`Camera.zoom` — gameplay always renders at 1; pan speed and the
      whole render/overlay/picking path are zoom-aware; readout shows %)
- [x] Cursor readout HUD: world px, tile, minitile, sector + tileset/palette/
      music/indoor/dungeon, collision byte (hex + SOLID/PRI-LO/PRI-HI), FPS
      (new `Collision.getCollisionByteAt`)
- [x] Grid overlays: tile grid (1), minitile grid (2), sector boundaries (3),
      room-crop preview toggle (4)
- [x] Shared selection model — `EditorTool` interface: hover + claimable
      mouse-down/move/up (unclaimed drags pan), per-tool canvas overlay hook
- [x] Dev save channel (see [Save-Back](#save-back-channel)) with dirty-state
      tracking (per-domain), HUD unsaved indicator, and `beforeunload` warning
- [x] Undo/redo stack (`CommandStack`, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, shared
      across tools via `EditorShellApi.run`)
- [x] Clean enter/exit: restores `camera.roomBounds` + re-follows the player,
      clears the gameplay key set both ways (no stuck walk keys), removes all
      DOM/listeners
- [x] **Location navigator** (`src/editor/LocationNav.ts`) — left-side directory
      of the world as **region → building → room**; click a node to fly there
      (`goTo` moves the player + camera, keeping free-fly). The 6 Town Map Image
      towns come from each overworld sector's `town` (baked into `sectors.json`
      by `add_sector_settings.py`); every OTHER region (Winters, Dalaam, Saturn
      Valley, Deep Darkness, Lost Underworld, Dusty Dunes, Tenda Village) is
      placed from EarthBound's **PSI-teleport destination table** (authentic ROM
      names + coords, `eb_project/psi_teleport_dest_table.yml`; coord/4 = tile —
      validated by the 6 towns landing exactly on their own sectors). Anything
      the ROM doesn't tag as a town is grouped by its **nearest teleport anchor**
      (Voronoi), so all 13 regions appear with no catch-all bucket. Interiors
      have no ROM names, so buildings come
      from the **door graph**: interior sectors linked by a door are unioned into
      one building (a shop's back room, a hotel's floors, a cave's chambers all
      collapse together), and the overworld door bridging that component is its
      street entrance. Each door destination is nested under its building as a
      room. Labels: a descriptive in-room sign upgrades the text (Hot Springs,
      Lier's House, Dept. Store…) — otherwise a type-aware ordinal (`Room 2`,
      `Dungeon 3`) plus a `·N👤` occupant count. Exact coords move to the row
      tooltip. Each building also shows a **storefront thumbnail** rendered from
      the overworld art at its entrance (lazy via `IntersectionObserver`) — the
      sign over the door is the real "name", read by sight. Interiors with no
      overworld door (elevator/nested-only) bucket under "Other / Interiors".
      "Places" button in the HUD toggles it; the player's current town
      auto-expands.
- [x] **Editable outline** — the derived tree is the base layer; hand edits layer
      on top and persist to `public/overrides/places.json` (save-back channel,
      allow-listed). Per-row actions: `+` on a region adds a building, `+` on a
      building adds a room (both dropped at the current view center), `✕` removes
      a building or room from the outline (manual nodes are deleted; derived ones
      are added to a `hidden` list). Click a building/room to select it: its
      quick-link anchor shows as a draggable **pink pin** on the map (handled in
      `EditorShell` — grab beats pan/tool), and dropping it writes the new coords
      (`moved` for derived nodes, the node's own x/y for manual ones).
      **Double-click any building/room label to rename it** — derived nodes store
      a name override in `labels` (keyed by their coord-key), manual nodes update
      their own entry; manual nodes also carry a `✎`. Overrides re-apply over a
      fresh derived clone each open, so the door graph stays authoritative while
      your additions/prunes/moves ride on top.

---

## 1. Tool dock (persistent right column)
The hub is no longer a modal — it's a **persistent right-side dock** built by the
Editor Shell (`EditorShell.buildDock`), so the tab menu is always on screen and
admins flip between tools without ever leaving the editor. `EditorHub.ts` is now
just a registry re-export shim.

- [x] Entry trigger: F2 hotkey + `window.__eb.admin()` console hook → enters the
      editor with the dock already present (no modal landing screen)
- [x] Tool registry unchanged: tools self-register via `registerEditorTool`
- [x] **Tab per tool** in the dock (name + status; WIP tools disabled), the
      active one highlighted. Click a tab to activate; click it again to
      deselect. Self-contained tools (Sprite Editor) launch their own overlay
- [x] The **active tool mounts its panel into the dock body** (`api.panelHost`),
      which scrolls — tools no longer float their own `position:fixed` panels
- [x] Footer: global **Save all** (runs per-domain `registerSaveHandler` fns,
      label shows the unsaved count), a **jump-to-px** field (wraps `goTo`/
      `debugTeleport`), and **Back to game**. Esc deselects the current tool;
      F2 exits the editor
- [x] HTML/DOM styling kept visually distinct from in-game EB chrome so dev UI
      is never mistaken for it

---

## 2. Placement Editor — NPCs & Doors
Highest leverage. Place/move/configure NPCs and doors in the live world. Replaces
the *manual eyeballing* the `debug_npc_align` / `debug_door_align` /
`debug_prop_anchor` scripts did by hand, and turns `DoorManager`'s hand-coded
`ZONE_DOOR_OVERRIDES` into edited data. Saves to the placement overrides layer.

### NPCs
**Built 2026-06-12** (`src/editor/tools/PlacementTool.ts`, READY in the hub).
Identity: `extract_npcs.py` now emits a stable `k` per placement
("areaIdx:npcConfigId:occurrence", counted over raw placements so keys survive
flag/anchor changes). Overrides = `public/overrides/npcs.json`
`{version, edits: {k: entry|null}, additions: [entry]}`, merged at load by BOTH
`NPCManager.mergeNpcOverrides` and `server/npcSim.js` (kept in sync — array
index = wire id; deletions become tombstone slots so ids never shift). npcSim
hot-reloads the overrides file, so saved person edits go live without a
restart; props need a browser refresh (ghosts show authored truth meanwhile).

- [x] Render all NPCs in editor mode as ghosts through the real `drawSprite`
      at the real anchor, with foot-box overlay (color-coded person/prop/
      added; deleted = red X)
- [x] Click-select; drag to reposition with snap (G cycles free / 8px / 32px)
- [x] Place new NPC (+ person / + prop buttons, then click to place)
- [x] Edit selected: sprite id, facing direction, kind, linked dialogue
      `textId`, exact x/y (wander/leash params are global npcSim constants —
      not yet per-NPC data; add when a tool needs them)
- [x] Delete NPC (Del key or button; restorable, undoable)
- [x] Sprite thumbnail with ◀/▶ id stepping (live via `SpriteManager`) — a
      full browse/search picker grid is still TODO (shares the backlog
      "visual sprite catalog")
- [x] Foot-box overlay at the gameplay collision box — automatic conflict
      warnings (spawning inside solids / other NPCs) still TODO
- [x] Save to NPC overrides keyed to placement identity (`k`); generated
      npcs.json is never written, re-extraction re-applies cleanly

### Spawn Point
**Built 2026-06-12** (SPAWN tab of the Placement Editor). Override =
`public/overrides/spawn.json` `{x, y, dir}`; consumed by `Game.startGame`
(client) and both servers' join handlers (which previously hardcoded the
spawn — that loose end is closed).

- [x] Move spawn off the hardcoded `Player.ts` constructor into config the engine
      reads (`src/spawn.json`: x, y, dir; current Onett value is the default)
- [x] Render a spawn marker in editor mode (player-sized outline + facing
      arrow + foot box)
- [x] Click / drag to set spawn position (snapped); facing via dropdown
- [x] "Test spawn" — teleports the player there without leaving editor
- [x] Warn if the spawn foot box overlaps solid collision or sits inside a
      person NPC's 32px wander-leash reach (the trapped-on-a-wanderer bug)
- [ ] Named spawns (per area / per door) — grow when needed

### Doors / Warps
**Built 2026-06-12** (DOORS tab). Identity: the base trigger anchor
"worldX,worldY" (the key `ZONE_DOOR_OVERRIDES` already used). Override =
`public/overrides/doors.json` `{version, edits: {key: {worldX?, worldY?,
destX, destY, destDir, style} | null}, additions: [...]}` (dest in PIXELS);
consumed by `DoorManager.loadDoors` AND `tools/debug_room_crop_check.py`
(which now reads the same file instead of its own hardcoded mirror —
verified: sweep output identical to the documented baseline). Saving re-runs
`loadDoors()` so edits apply live in the editing client.

- [x] Render door triggers; selected door draws the trigger→dest dashed link
      + dest marker (zone doors without an authored link render dimmed)
- [x] Select/drag trigger position and destination position (both handles)
- [x] Edit `destDir` (arrive facing) and style; trigger/dest also numerically.
      Event `flag` editing deferred — overrides act on flag-ACTIVE doors;
      authoring flag conditions belongs with a world-flag editor
- [x] "Walk-test": teleport through the selected door without leaving editor
      (+ "Go to dest" to fly the camera there)
- [x] Migrated hand-coded `ZONE_DOOR_OVERRIDES` into `overrides/doors.json`
      (the Tenda-hole entries are now edited data; the code table is gone)
- [x] Save to door overrides, applied on top of extracted door data; add /
      delete (disable) / restore doors supported

---

## 3. Collision & Priority Painter
Visual brush for the bytes behind the most bugs — replaces the *hand-inspection*
the `debug_pri_flags` / `debug_solid_pri` / `debug_room_bleed` /
`debug_sector_claims` scripts did. Keep `debug_room_crop_check` as the
verifier this tool calls to confirm room crops after edits.

**Built 2026-06-12** (`src/editor/tools/CollisionTool.ts`, READY in the dock).
**Model: edits are PER-MAP-TILE** — a paint affects ONLY the cell you click,
even when other map tiles reuse the same tile graphic. A per-map-tile override
layer (`overrides/collision.json` `cells`: "tx,ty" → {minitileIdx: byte}) is
applied on top of the shared arrangement bytes; any legacy per-arrangement
`edits` already in the file still apply underneath and are preserved on save.
Overrides apply at THREE points kept in sync: `Collision.effectiveRow`
(client — every collision/priority/room-crop read), `server/npcSim.js` (wander
AI, hot-reloads the override file), and `tools/debug_room_crop_check.py` (the
canonical sweep sees painted collision).

- [x] Overlay the collision grid colored by byte: solid `0x80` red full-cell,
      `0x01` blue LOWER half, `0x02` green UPPER half (halves match meaning)
- [x] Brush tools: solid / pri-lo / pri-hi (first cell decides set-vs-clear),
      clear, rectangle fill, eyedropper → stamp byte (keys S/L/H/C/T/E/X)
- [x] Adjustable brush size (B: 1/2/4 minitiles); minitile-accurate painting;
      strokes are undoable; painting a cell back to its arrangement default
      drops the override (no redundant data)
- [x] Live room-crop preview (R recomputes `computeRoomBounds` at the cursor
      against PAINTED collision; auto-refreshes after each stroke); "Verify
      rooms" button runs `debug_room_crop_check.py` through the dev-only
      `/__editor/verify` endpoint (fixed-command allow-list) and shows output
- [x] Legend + cell inspector (map tile, minitile, byte); the clicked cell is
      outlined
- [x] Toggle map art off (M) to paint against bare collision
- [x] Save to `overrides/collision.json` `cells` (per-map-tile diffs vs the
      arrangement default; no-op edits drop out) — generated collision files
      never written; npcSim re-applies via file watch, the py sweep reads it

---

## 4. Dialogue Editor — v1 DONE (`src/editor/tools/DialogueTool.ts`, READY)
Author the decoded NPC text. Each entry is keyed by a `textId` (the NPC config
id; NPCs link via their `t` field) and holds ordered pages — the same shape
`npc_text.json` / `DialogueManager` use. Client-side only (no server role), so
edits go live on save with just `reloadNpcText()`; no dev-server restart.

- [x] List/search dialogue entries by `textId`; each row shows a snippet, an
      authored `*` marker, and a `👤N` count of NPCs that speak it (from
      `npcs.json` + placement overrides, grouped by `t`)
- [x] Edit pages (one textarea per page, add/remove page) with a **faithful
      EB-window live preview** (reuses `drawWindow`/`drawText`/`wrapText`, font 0,
      real wrapping; ◀/▶ flip pages, ▼ hint when a page overflows one box)
- [x] "Go to speaker" flies the camera to the first NPC that references the entry
- [x] Save to `overrides/dialogue.json` (`{version, edits:{textId: pages|null}}`,
      only entries that diverge from the decoded base) — merged over
      `npc_text.json` by `NPCManager.mergeDialogue`; generated text never touched.
      "Revert to base" restores an entry's decoded pages
- [x] Assign a `textId` to an NPC + author net-new lines — the Placement Editor's
      **"Dialogue ✎"** button on a selected NPC mints a fresh textId (≥900000, clear
      of ROM config ids) if it has none, saves the NPC + link, then opens the
      Dialogue Editor focused on that entry (`dialogueTool.requestEntry` handoff +
      `shell.openTool`). The Dialogue Editor also has a standalone **"+ New
      dialogue"**. So: place NPC → Dialogue ✎ → type → Save
- [ ] Support flag conditionals / branches the engine understands — DEFERRED
      (ccscript-level; the engine renders flat pages today)
- [ ] Validate: orphaned entries / blank dialogue — DEFERRED (`verify_dialogue.mjs`
      is a heavy Playwright screenshot run, not a quick fixed-command verifier)

---

## 5. Cast Sprite Editor — DONE (lives in `engine/SpriteEditor.ts`, off char-select)
**Built, but not as an F2 tool.** Reached from the character-select screen's
✎ EDIT cell. Pick any cast character from the dropdown (the `characters.json`
roster) and hand-polish the **attack/hurt** animation bands PoseGen generates,
with the live WASD/F/H walk-test pane and held-item editing/overlay. Walk/climb
rows are ROM and locked. **Save (Ctrl+S)** writes only the attack/hurt diff vs
the generated frames to `public/overrides/sprites.json` (the same override layer
described below), applying to that sprite group everywhere in-game.

The earlier plan was an F2 "NPC Sprite Animator" tool; that was scrapped in
favor of reusing the richer create-character editor UI. The notes below describe
the shippable override layer it writes into (still accurate).

**DECIDED — authored-only sprite override layer (the goal: real-time-action
frames for every character).** EarthBound's overworld sprites have only walk +
climb; real-time action needs attack, hurt, and full 8-direction coverage. We
**augment** the ROM base with our own frames rather than redrawing whole sheets:

- An override stores **only the authored frames** (e.g. attack/hurt rows, filled
  diagonals) keyed by sprite group id — **never the ROM walk frames.** So it is
  non-ROM-derived, committable, and shippable under the PokeMMO model.
- At load the engine **composites**: ROM-extracted base sheet (regenerated from
  the player's own ROM) + our authored band on top. Missing-frame lookups fall
  through base → override.
- This is the **same layer for the player too**, not just NPCs — the player's
  current full-sheet localStorage path (which contains ROM Ness pixels) is the
  dev-only exception; the shippable model is base + authored overlay for all.
- Format/compositing is shared engine code; this tool is just the authoring UI
  that writes into it.

- [ ] Sprite-group picker: browse/search all 463 groups by id with thumbnails
      (reuse `SpriteManager`; shares the backlog "visual sprite catalog")
- [ ] Load a group's ROM sheet at **that group's** frame dimensions
      (`getSpriteGroupMeta().width/height`, not the hardcoded 16×24) and its
      native 4×4-grid → 8-direction layout (see `project_sprite_layout`)
- [ ] **Do NOT auto-mirror NPC sheets** — the editor's W-from-E flip is a
      Ness-template convenience; ROM sprites are mostly not mirror-symmetric
      (ARCHITECTURE.md). Detect per-sheet and edit each direction independently
- [ ] Respect diagonal support per sheet (`sheetHasDiagonals`): 4-direction
      sheets fill diagonals from E/W; surface that instead of editing empties
- [ ] Author attack/hurt bands seeded procedurally from the standing frame (the
      existing body-band shear), then hand-edit; per-direction frame editing with
      walk/attack/hurt test pane
- [ ] **Save authored-only sprite overrides** keyed by group id — store ONLY the
      new frames, never the ROM walk frames, so the override stays non-ROM-derived
      and shippable (PokeMMO model). Engine composites the override band on top of
      the ROM-extracted base at load (additive per-group merge, like
      `registerCustomSheet` but it adds rows rather than replacing the sheet)
- [ ] Batch view: list groups still missing attack/hurt art to work through them
- [ ] Integrate with Placement Editor: selecting an NPC offers "Edit sprite" →
      opens this on that group

---

## 6. Enemy Spawner Editor — DONE (`src/editor/tools/EnemySpawnerTool.ts`, READY)
Place and configure the enemy spawn points (the data behind
`enemy_spawns.json`) visually. One enemy type per spawner; mix by adding more.

- [x] List of spawners + "+ New spawner" (N) → click the map to drop one;
      select/drag a marker to move it; Del removes it
- [x] Per-spawner fields: name, enabled toggle, enemy sprite (id + ◀/▶ + live
      thumbnail), x/y, **roam radius**, **rate** (spawn interval, seconds),
      **max** active, **hp**, **respawn delay** (seconds). `poolSize` is derived
      from max at save time (a buffer above the live cap), not hand-managed.
      "min enemies" was intentionally dropped — max + rate were enough
- [x] Live overlay: spawn marker + foot box, the **roam-radius ring**, and a
      ghost of the assigned enemy sprite
- [x] **Walkability/connection guard** — the marker and a panel readout turn RED
      when a spawn point is on a solid tile or sealed off from the street network
      (bounded 8px flood fill mirroring `Collision`/`npcSim`). This is the exact
      bug that trapped the arcade sharks in a pocket; the editor now refuses to
      let it pass silently
- [x] Saves the WHOLE file to `public/overrides/enemy_spawns.json` (OUR authored
      content — no ROM base to merge, so the override REPLACES the committed
      default). `enemySpriteGroups` is auto-derived from the enabled spawners'
      sprites. Preferred over `public/assets/map/enemy_spawns.json` by BOTH
      `NPCManager.loadNPCs` (client) and `server/npcSim.js`, which now hot-reloads
      it. KEEP IN SYNC: both skip disabled spawners when building the pool so
      wire ids stay aligned
- [x] Apply model: on save the editing client re-runs `loadNPCs` and the server
      reloads live. Tuning edits (radius/rate/hp/position) apply immediately;
      changing the live **pool size** (add/remove/enable/disable/max) shifts wire
      ids, so other connected clients must refresh (the save toast says so)

---

## 7. Traffic Editor — DONE (`src/editor/tools/TrafficEditorTool.ts`, READY)
Place vehicles and draw the **waypoint routes** they drive around town (the data
behind `car_traffic.json`). One car per vehicle; the server drives it.

- [x] List of vehicles + "+ New vehicle" (N) → click the map to drop one (its
      first waypoint), then **Add waypoints** mode appends the rest of the route
      on each click; drag any dot to move it; Del removes the selected waypoint
      (or the vehicle when none is selected)
- [x] Per-vehicle fields: name, vehicle sprite (id + ◀/▶ + live thumbnail —
      Taxi 206 / Car 255 / Truck 459 / Bus 243 …), **speed**, **loop** (circuit
      vs. back-and-forth), enabled toggle
- [x] Live overlay: the route polyline (closed when looping) with per-segment
      **direction arrows**, numbered waypoint dots, a start marker, and a ghost
      of the vehicle sprite facing its first segment
- [x] Saves the WHOLE file to `public/overrides/car_traffic.json` (OUR authored
      content — no ROM base; replaces the committed default). The collision box
      `w`/`h` is derived from the sprite size at save time. Preferred over
      `public/assets/map/car_traffic.json` by BOTH `NPCManager.loadNPCs` and
      `server/npcSim.js` (hot-reloaded). KEEP IN SYNC: both build one car per
      active vehicle (`enabled` + ≥2 waypoints) in file order so wire ids align
- [x] Behaviour (server-authoritative, `npcSim.tickCar`): the car follows its
      route facing the travel direction (`dir8` → the matching directional
      sprite), looping or ping-ponging. It is **solid to every entity, no
      damage** — it waits in place when a player/NPC/other car is in its path and
      resumes when clear; `blockedByNPC` also makes it solid for the local player
- [x] Apply model: on save the editing client re-runs `loadNPCs` and the server
      reloads live; changing the active-vehicle count shifts wire ids, so other
      connected clients must refresh (the save toast says so)

---

## Save-Back Channel
Shared dev-only persistence used by all tools. **Implemented as a Vite dev-server
middleware** (`vite.config.ts` `configureServer`) — exists only under
`npm run dev`, never in the production bundle or on the deployed express server.
Writes go to the **overrides layer**, not the generated asset files.

- [x] Vite middleware write endpoint (`/__editor/save` in `vite.config.ts`
      `editorSavePlugin`) writing `public/overrides/<name>` — built 2026-06-12
- [x] Lives entirely in the dev server: `apply: 'serve'` plugin, not bundled,
      not on express/Render (restart `npm run dev` once to load it)
- [x] Path allow-list (npcs / doors / spawn / collision / dialogue / sprites /
      names / enemy_spawns / places / car_traffic `.json` only) + 8MB body cap
- [x] Atomic write (tmp + rename) + pretty-print (stable key order is the
      writing tool's responsibility)
- [x] `.bak` copy of the previous version before every overwrite
- [x] Client helpers: `saveOverride(name, json)` / `loadOverride(name)`
      (`src/editor/saveOverride.ts`); hub Save-all surfaces success/error toasts
- [x] **Apply step** — DECIDED with the Placement Editor: **runtime merge in
      the loaders** (not a py bake step), so saved edits go live without
      re-running the pipeline. Canonical format per domain:
      `{version, edits: {stableKey: replacement|null}, additions: [...]}`,
      with stable keys emitted by the extraction tool. First instance: NPC
      placements — `NPCManager.mergeNpcOverrides` (client) mirrored in
      `server/npcSim.js` (which also hot-reloads the overrides file);
      deletions tombstone their slot so wire ids never shift. Future tools
      follow this pattern with their own stable keys

---

## Backlog (later tools)
- [ ] Sector settings editor (music id, indoor/dungeon flags — pairs with
      `tools/add_sector_settings.py`)
- [ ] Tile / map arrangement painter (overworld art)
- [ ] World-flag / event-state editor (`world_flags.json`, open-world overrides)
- [ ] Item / held-item editor
- [ ] Music preview hookup (SPC700)

---

## Build Order

**Phase 1 — get the py pipeline to ~99% (do this first).** Push each generator
until manual fixup is rare, *before* investing in the matching editor. Editor
work for a domain should start only once its pipeline is as good as it can get:
- [ ] Placement/anchors (`extract_npcs.py`) — minimize off-anchor outliers
- [ ] Collision & priority (`apply_map_changes.py` + extraction) — correct rooms,
      walls, depth flags out of the box
- [ ] Doors (extraction + fold in `ZONE_DOOR_OVERRIDES` learnings)
- [ ] Dialogue (`eb_dialogue.py`) — correct text/flag decoding
- [ ] Sector settings, atlases, music mapping

**Phase 2 — admin editors (last 1% + new content):**
1. **Editor Shell** + **Admin Home Screen** + **Save-Back Channel** (foundation)
2. **Placement Editor** (NPCs first, then doors)
3. **Collision & Priority Painter**
4. **Dialogue Editor**
5. **NPC Sprite Animator** (gated on combat needing NPC attack/hurt art)
