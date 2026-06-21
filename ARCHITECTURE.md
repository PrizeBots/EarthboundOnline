# Architecture

Living document describing how Zexonyte Online actually works. **If you change
the engine, the servers, or the extraction pipeline, update this file in the same
change.** High-level project rules (ROM distribution policy, dev ports, what not
to commit) live in CLAUDE.md; this file is the technical map.

## Overview

A browser multiplayer recreation of EarthBound's overworld: a TypeScript Canvas
engine (`src/engine/`, no emulation) renders assets extracted from the player's
ROM by Python tools (`tools/`), while a small Node server relays multiplayer
state. Every system is designed to port cleanly to real SNES hardware later
(BG layers for tiles, OAM for sprites, SPC700 for audio) — see CLAUDE.md.

```
EarthBound.sfc ──tools/*.py──▶ public/assets/*.json+png ──HTTP──▶ src/engine (browser)
eb_project/  (CoilSnake decompile: scripts, NPC/door tables, music) ──┘     ▲
                                                                            │ WebSocket
                            server/gameHost.js (GameHost) + server/npcSim.js
                            ↑ shared by server/index.js AND vite.config.ts
```

## Data pipeline (run in order)

1. `tools/extract_rom.py` — tilesets, map, sprites, collision from the ROM
2. `tools/add_sector_settings.py` — merges each sector's "Setting" byte from
   `eb_project/map_sectors.yml` into `sectors.json`: `indoor` (houses/shops)
   and `dungeon` (caves + magicant/robot/lost-underworld chunks); both drive
   the room crop (see bugs.md for the cave-visibility bug). Also bakes `town`
   from "Town Map Image" (onett/twoson/… ; absent for interiors) — overworld
   region metadata that drives the editor's location navigator.
3. `tools/apply_map_changes.py` — bakes the open-world event state into
   `tiles.json` (the ROM's base map is the game-intro state)
4. `tools/build_atlases.py` — pre-renders BG + FG tile atlases per palette, plus
   per-frame atlases + `anim.json` for EB's animated palettes (`tools/palette_anim.py`)
5. `tools/extract_npcs.py` — NPC/prop placements (`npcs.json`) **and dialogue**
   (`npc_text.json`), see below
6. `tools/extract_shops.py` — shop catalog + clerk→store map (`shops.json`)
7. `tools/extract_enemies.py` — enemy catalog (`enemies.json`) from
   `enemy_configuration_table.yml`: per-sprite stats (HP/XP/level/money/damage)
   - item drops & rates, keyed by sprite id. The DEFAULTS layer for combat (see
     Combat & enemies).
8. `tools/extract_gifts.py` — present-box catalog (`gifts.json`), see Gifts below
9. `npm run dev` — Vite on port 4444 (game WebSocket server attaches to Vite
   in dev; `server/index.js` is the standalone deployment)

Dev aid (not part of the game build): `tools/copy_rom_sources.py` stages EVERY
graphic CoilSnake decompiled (eb_project/**/\*.png — battle sprites, battle BGs,
swirls, title/logos, town maps, cutscene anims, plus the imported sprite groups)
into the gitignored `public/assets/rom_sources/` with an `index.json`, so the
editor's **Source Assets\*\* tool can browse the full ROM art set. `eb_project/`
isn't served, hence the copy.

**Create-from-asset.** Source Assets isn't just a browser: selecting an asset
exposes "New Entity / New Item from this". _Entity_ mints a **standalone custom
sprite group** (`src/engine/CustomSprites.ts`) — id ≥ `CUSTOM_GROUP_BASE`, wrapping
the graphic as a static all-directions sheet — and persists ONLY metadata
(id/name/`src` path, never pixels) to `overrides/custom_sprites.json`, re-loading
the art from `rom_sources/` at boot (`loadCustomSprites`, after name overrides).
It then opens the **Entity Manager** focused on the new sprite, editable like any
ROM group. _Item_ mints a custom item (`addCustomItem`), quantizes the graphic into
the 16×16 `ITEM_PALETTE` held art (`itemPixelsFromImage`), writes
`custom_items.json` + `item_sprites.json`, and opens the **Item Manager**. Both
respect the ROM-distribution rule: entity art is a by-reference pointer into the
player's own extraction; item art is re-quantized to our own non-ROM palette.

**Furniture from map tiles (the third custom-sprite source).** MOST EarthBound
furniture is already a ROM sprite OBJECT (Bench/Plant/Stove/Jar/Painting/Crate/…,
extracted into `npcs.json`, placed/moved in the Placement editor like any prop) —
those need no special handling. Only a MINORITY (structural built-ins fused into
the BG/FG tile atlas) is tile-only; for THOSE, the **Room Builder**'s "→ Furniture"
button
harvests a sampled tile region into a movable, solid prop: it mints a custom
sprite group whose art is a **tile-arrangement region** (`CustomSpriteTiles` on
the `custom_sprites.json` entry — `{tilesetId, paletteId, w, h, bg[]}`, pure
arrangement INDICES, never pixels) that `renderTiles` re-draws from the player's
own atlas at boot (BG + FG of each arrangement, so it looks identical to the
baked tile). It also writes a full-footprint collision box to
`overrides/entities.json` so the furniture is solid (see "props with a col are
solid", below), then hands off to the **Placement** editor (`requestPlaceProp`)
ready to drop as a `prop`. Harvested furniture is for placing in custom rooms /
new spots — it can't erase the baked original from a ROM map (the ROM
`tiles.json` is never touched).

**Editing a custom entity (Sprite Editor `entity` mode).** Custom entities are
paintable in the Sprite Editor — a 4th `EditMode` ('char'/'item'/'psi'/'entity')
modeled on the item editor: one variable-size paint buffer through the shared
`pixelCanvas` engine (pencil/fill/select/move/rotate/flip + undo). The palette is
EXTRACTED from the art into `S.palette` (stays paletted = SNES-honest); double-click
a swatch to recolor the whole palette entry (a palette swap). A **Scale %** control
resizes the frame (nearest-neighbour), changing the entity's dimensions. Editing
promotes the entity from a ROM-source reference to an authored **`png` pixel layer**
on its `custom_sprites.json` entry (`registerFromCanvas` re-registers live,
`setCustomSpritePng` + save persists); once a `png` layer exists it IS the art (our
own hand-painted pixels), so the entity no longer depends on the ROM source. Reached
via the Sprite Editor's CHARACTER dropdown ("Custom entities" section) or Entity
Manager's "Edit sprite →" (`openSpriteEditor({focusChar})`).

**Editing a tile stamp (Sprite Editor `stamp` mode).** Room Builder stamps are
cleanable in the Sprite Editor — a 5th `EditMode` that REUSES the entity buffer
surface (single variable-size buffer + extracted `S.palette` + the shared
`pixelCanvas` engine). It renders the stamp to pixels (`Stamps.renderStampToCanvas`),
and on save slices the buffer back into 8×8 custom-tile minitiles
(`Stamps.applyEditedPixels` → `CustomTiles` `mintCustomTile`/`setCustomTile`),
OVERWRITING the same stamp in place (reusing its tile ids so repeated autosaves
don't orphan tiles); a fully-transparent 8×8 block becomes an empty ref so it
drops out when painted (the floor shows through). Persists `custom_tiles.json`
(via the editor save channel) + the stamp library (DB). A **Stamp** mode button
opens a thumbnail browser of the whole library; Room Builder's stamp ✎ hands off
via `openSpriteEditor({focusStamp})` (the SAME standardized wiring as
`focusItem`/`focusPsi`/`focusChar`). The stamp library itself is the shared
`src/engine/Stamps.ts` service (one source of truth — Room Builder and the editor
both read/write it; Room Builder's `this.stamps`/`folders` are accessors over it).

The event-flag state for the open world lives in `src/world_flags.json` — the
single source of truth shared by `apply_map_changes.py`, `extract_npcs.py`,
`eb_dialogue.py`, and the engine's DoorManager. Change a flag there and re-run
the pipeline; map, NPC visibility, and dialogue stay consistent.

## Client engine (`src/engine/`)

`Game.ts` owns the loop and phases (`loading → charselect → playing`)
and wires everything; per-frame order in `update()` matters: chat typing freezes
the world, then menu, then dialogue, then talk/door triggers, then movement.

**Loading is visible-first, stream-the-rest.** Both at spawn and through a door,
the game BLOCKS on only the tileset atlases + collision for the sectors VISIBLE
around the destination (`loadVisibleSectors` → a small range from
`visibleSectorRange`), not the full 9×13 `loadNearbySectors` neighborhood (most
of which the room crop hides). The wider neighborhood then streams in
fire-and-forget via the per-frame `loadNearbySectors` (and the editor's
`loadSectorsInView`). A **door prefetch** kicks `loadVisibleSectors(dest)` at
fade-OUT start (`startTransition`), so the ~283ms fade hides the load and we fade
straight back in instead of stalling on black; `updateTransition` just awaits
that promise. Any genuine wait shows a **progress bar** (`drawLoadingBar`, driven
by `AssetLoader.imageLoadProgress()` counters) — on the boot `loading` screen and,
only if a slow load outruns the fade, on the door-transition black. Atlases/
sprites/collision are immutable, so production should serve them with long-lived
`Cache-Control`; the ROM-extraction path (IndexedDB prime, see CLAUDE.md) makes
repeat sessions skip HTTP entirely.
Dev hook: `window.__eb.game.debugTeleport(x, y)` jumps anywhere with proper
sector load + room crop — use it from the console or verification scripts.

- **Renderer / TilesetManager / MapManager** — EB's dual-layer system: BG atlas
  behind sprites, FG atlas in front, FG tiles depth-sorted with sprites.
- **Animated tiles (palette animation)** — EB animates a few map palettes (the
  "Flash Effect": Fire Spring lava, water, dept-store escalators, …) by cycling
  the WHOLE palette through a short frame sequence. The frames + per-frame
  durations are ROM data: `tools/palette_anim.py` reads the Palette Animation
  Pointer Table (US 1.0 file `0x1FE4E1`) → secondary table → decompresses each
  flagged combo's frames. `build_atlases.py` bakes one atlas per frame
  (`{ts}_{pal}_f{k}.png`, +`_fg`) and writes `atlases/anim.json` (frame count +
  durations @60Hz). `TilesetManager` loads the manifest, lazily pulls the frame
  atlases when a combo's sector loads, and `drawTile`/`drawForegroundTile` swap to
  the live frame on a shared wall clock. Only the ~8 animated combos cost extra
  atlases; everything else renders the single static atlas. (On real SNES this is
  a CGRAM palette write per frame — same model, baked into atlases for the browser.)
- **Collision.ts** — minitile collision; byte bit 7 = solid, bits 0–1 = sprite
  priority: 0x01 = lower body behind FG (tall grass, counters), 0x02 = WHOLE
  body behind FG (canopies, behind signs; 0x03 = whole wins). There is NO
  upper-half bit — two earlier misreadings caused the floating-head-on-signs
  bug (bugs.md). Also computes room bounds (camera crop) for every `indoor` or
  `dungeon` sector — interiors AND caves are packed adjacent to unrelated
  chunks on the stitched map and must be masked to the current room. Rooms
  are SEALED (bugs.md, arcade/Tracy's-room): the flood won't slip under
  walls in indoor sectors, pocket-merge skips regions containing doors
  (DoorManager registers mat+dest cells via `setDoorCells`). The pocket merge
  scans the room's `floodSectors` PLUS same-style INDOOR sectors adjacent to
  them — a shop's back-wall row (counter/register) is often its own floorless
  sector, so its behind-counter pocket would otherwise never be scanned and the
  counter renders black (bugs.md, dept-store 3F). A final
  guard-free fill then reclaims floor minitiles the guarded flood skipped on
  the parasitic strip UNDER in-room furniture (shop counters/shelves) — it
  grows from `visited` but never leaves the room's own `floodSectors` and
  never steps on a door cell, so it fills the room's own floor (else black
  squares — bugs.md, cycle shop) while a neighbour-room merge stays
  impossible. The local
  player moves through `checkPlayerCollision`, which treats minitiles
  outside the active room (`setActiveRoom`/`RoomBounds.cells`) as solid —
  only doors (and escalators) move you between rooms.
  `tools/debug_room_crop_check.py` replays the exact algorithm in Python
  over all door destinations; keep it in sync when changing the algorithm.
  **Escalators/stairways**: EB's `EscalatorOrStairwayDoor` is NOT a warp — it
  carries only a diagonal `direction`. An escalator is a walkable diagonal RAMP
  (two landing strips joined by the ramp) bounded by solid; too narrow/corner-
  connected for normal foot-box movement, so the player is _glided_ across it
  (see DoorManager/Game). `isSolidAtPoint()` is the raw look-ahead the ride uses
  to find the ramp's end. The floor change is either a `door` warp at the strip
  end (fade) OR — for stacked floors with no door between them — the ride just
  re-crops onto the destination floor. Those stacked floors are SEPARATE crop
  regions joined only by the solid ramp, so during such a ride `Game` shows the
  UNION of both floors + the ramp (`computeRideBounds`); otherwise the
  destination (and the down-ramp) render black and you glide into a void
  (bugs.md, dept-store escalators). See bugs.md (escalators) for the full mechanic.
- **Entity.ts** — base class for Player and NPC (position = sprite center-x /
  feet-y, 2-frame walk cycle). Remote players share the drawable shape only.
- **DoorManager** — door triggers + fade transitions; also loads escalator/
  stairway triggers (`getStairAt` → diagonal vector) and resolves their floor
  warp (`getStairExit` floods the shaft, picks the `door` inside it leading to
  an indoor floor in the ride's vertical direction, skipping outdoor exits).
  Game drives the ride: stepping a trigger glides the player diagonally along
  the ramp (collision + room-seal bypassed) until the cell ahead is solid, then
  warps through that floor door (fade reveals the next floor fully). Over-large
  shafts get no warp (ride stops in place). Steps don't animate (no
  tile-animation system).
- **NPCManager / NPC.ts** — loads placements, buckets them into the ROM's
  256px area grid, lazy-loads sprite sheets, applies server `npc_update` rows.
  `blockedByNPC` makes `person`/`enemy`/`car` NPCs solid for the player (the
  player's move combines it with `checkPlayerCollision`). A `prop` is solid
  ONLY if it has an authored collision box (`col` in `entities.json` —
  harvested furniture); a `prop` WITHOUT one stays walkable because many ROM
  props are invisible interaction hotspots whose body is already in the map
  collision. Solid props never yield to weight-push (furniture is fixed), and
  the debug-box overlay (`drawDebugBoxes`) draws a prop's `col` when it has
  one. This is client-side only — the server is client-authoritative for player
  movement, so a placed furniture prop blocks the local player without a server
  change (enemies don't yet path around it).
- **DialogueManager** — NPC talk/check text window (see below).
- **ChatManager** — Enter opens typing box; messages float as speech bubbles.
- **RemoteInterp** — snapshot interpolation for remote players: clients send
  position every 3 frames (~50ms), so remote players render 100ms in the
  past, lerped between buffered snapshots (gaps >64px = teleport → snap).
  `onPlayerMove` only buffers; `Game.update()` interpolates every frame,
  before the menu/dialogue early-returns so remotes keep moving while local
  UI is open. NPC `npc_update` (10Hz) is not yet interpolated — see TODO.
- **MenuManager, MusicManager (SPC700 emulation), Network, Input,
  CharacterSelect** — as named.
- **SpriteNames.ts** — display names for all 285 used ROM sprite groups
  (`src/data/spriteNames.json`, OUR authored metadata, ships with the app).
  The ROM stores no names: the cast was anchored from dialogue
  self-introductions ("I'm Frank.", "I'm Mayor B.H. Pirkle…" — see
  `tools/debug_name_mining*.py`) plus visual identification from contact
  sheets (`tools/debug_sprite_contact.py`); generic townsfolk/props carry
  descriptive names. Shown in the character-select preview and the editor's
  placement panel (NPCs and props).
- **SpriteEditor** — the character creation screen (the CREATE cell on
  character select). A DOM-overlay pixel editor over the Ness sheet template
  (16x24 frames, localStorage-persisted). Sheet v3 is 64x312, 13 rows: walk
  0-3, climb 4, attack 5-8, hurt 9-12 — attack and hurt both use the walk
  direction layout (8 dirs x 2 frames). **Left/right mirroring:** EB's
  west-facing frames are exact horizontal flips of the east-facing ones
  (verified pixel-for-pixel on Ness), so the editor only shows and edits the
  canonical directions (N/S/E/NE/SE) — the FRAMES strip omits W/NW/SW
  entirely — and auto-fills the mirrored cells as flips on every paint (the
  full 8-direction result is visible in the live test pane). This is an
  editor-only convenience — the on-disk sheet still stores all 8 directions
  and `drawSprite` is unchanged, so ROM NPC sprites (most of which are NOT
  mirror-symmetric) are untouched. Attack/hurt rows are GENERATED from each
  standing frame by re-posing body bands (head/torso/legs shear: wind-up
  leans back, swing lunges forward, hurt recoils then settles) — EB has no
  overworld attack art, so these are procedural starting points; only
  transform math is committed, no pixels. The shears are symmetric in the
  facing sign, so a generated west frame equals the flip of its east frame.
  Saves migrate forward on load: v1 (5-row) and v2 (10-row, single-row hurt)
  gain the blocks they lack (v2 keeps its attack, gets the new 8-dir hurt),
  and pose rows still holding verbatim walk copies are upgraded in place
  (edited rows are left alone). Test pane: WASD walk, F attack, H hurt, G
  cycle held item. Confirming registers the sheet via
  `SpriteManager.registerCustomSheet` (accepts 5-, 10-, or 13-row sheets;
  poses a sheet lacks fall back to walk frames — ROM sprites included) and
  sends it as a PNG data URL in the join message's `appearance` field; both
  servers cap that field at 64KB.
- **Items.ts** — held-item overlays: 16x16 pixel art (our own, never
  ROM-derived) drawn at a per-direction hand anchor relative to the entity
  anchor; facing away (N/NE/NW) puts the item in the far hand, under the body
  sprite. A weapon has **`ITEM_FRAMES` (3) animation frames** — wind-up (f0),
  swing (f1), follow-through (f2) — and the attack pose drives which draws
  (`Player` splits `ATTACK_TOTAL` into thirds; the body sprite has only 2 attack
  frames and clamps f2 to its swing). A small per-frame hand nudge traces the
  swing arc on top of the drawn frames. An item with fewer authored frames falls
  back to frame 0 (static). An item may carry a body-mount **`offset`** from the
  entity anchor (e.g. a badge on the chest) — it's drawn as-authored at that spot
  (no per-direction flip) but STILL plays its full swing animation; positioning
  only moves where the swing happens. Authored by dragging the item on the
  editor's live-test character (`offsetFor`/`setItemOffset`). Art is keyed by **catalog item id**
  (shops.json): authored per-item in `overrides/item_sprites.json` (`frames`: up to
  3 ITEM_PALETTE-index grids; `pixels` mirrors frame 0 for back-compat; + a grip point + optional worn `offset`),
  loaded by `loadItemSprites()` at startup so every client renders the same
  gear. A few legacy hand-authored defs (bat/pan/yoyo) seed/fallback. The
  equip cycle key (G) steps through the **equippable gear in your inventory**
  (by item Type, `isEquippable`); equipping broadcasts the catalog id via the
  `equip` message (persisted on the server player record so late joiners see
  it), and remote clients render it with `drawHeldItem`. Equip is server-
  authoritative for COMBAT: the equipped weapon's **offense** (decoded from the
  ROM item table by `extract_shops.py`, exposed via `server/shops.js` GOODS
  `.equip`) is added to attack damage — Cracked bat = +4, like the game — but
  only if the player actually owns it. Equippable gear can never be consumed
  (`use_item` refuses items with `.equip`), fixing the bug where a weapon
  vanished when "used" from Goods.
- **Item Manager + Sprite Editor item mode** — the held-gear authoring
  pipeline. The Item Manager (editor tool) lists the WHOLE item catalog with
  the shared sprite-preview dropdown + search, and makes **every item property
  editable** (all writing to `overrides/equip_stats.json`): **name**, **kind**
  (the `slot` override — pick Consumable/Weapon/Body/Arms/Other to retype any
  item; 'none'=consumable), **users** (which heroes may equip/use), cost, and —
  for whatever kind it now is — the combat stats (weapon offense/atk-speed/inflict
  or armor defense, plus crit/dodge) or consumable heal. The kind selector regates
  the stat rows live. It also shows whether each item has art yet, and hands off (`openSpriteEditor({
focusItem })`) to the Sprite Editor's Item mode. The Sprite Editor's item list
  is split into **Weapons / Items / Custom** tabs: Weapons/Items come from the
  catalog (a weapon is gear whose equip slot is `weapon`); **Custom** holds the
  legacy seed art (bat/pan/yoyo = `HELD_ITEM_IDS`) plus admin-made items. Since
  shops.json is ROM-derived and can't grow, the **+ New custom item** button mints
  a `custom-N` id stored in `overrides/custom_items.json` (id+name; `Items.ts`
  `loadCustomItems`/`addCustomItem`), with its art in `item_sprites.json` like any
  other item. Item mode edits **3 frames per item** — click a frame in the FRAMES
  strip to edit it (the active one is highlighted there; unauthored frames seed
  from the previous one) and a 2nd live preview loops just the item's swing.
  Editing saves all 3 frames to
  `overrides/item_sprites.json` via the dev save channel, shared by all clients.
  (Catalog item ids and the Goods inventory ids are the same numeric-string id space.)
- **Inventory.ts + MenuManager Goods** — the server-authoritative Goods
  inventory. The server grants a starting Cookie on join and is the sole
  authority on contents and effects; `Inventory.ts` just mirrors the latest
  list (welcome snapshot + `inventory` deltas) so the command window's **Goods**
  command can render it. Selecting an item sends `use_item`; the Cookie heals
  6 HP (capped at max), and the server replies with the trimmed list and a
  `player_hp` carrying `heal` (the owner pops a green heal number). Items are
  identified on the wire by their numeric id as a STRING (e.g. `"88"` = Cookie),
  the same id the catalog names from.
- **Equip screen + quick-select hotbar** (MenuManager, `Equipment.ts`) — the
  **Equip** command opens an item-centric screen: ONE list of the 4 slots
  (**Weapon / Body / Arms / Other**, each showing its equipped item) then the
  player's UNEQUIPPED gear (with `+off`/`+def` tags). Selecting a gear row
  equips it into its slot; selecting an occupied slot takes it off; equipped
  items drop out of the list. A live **status panel** (Offense/Defense incl.
  gear via `equipStats()` = `getStatus()` base + `itemOffense`/`itemDefense`)
  sits to the right so changes show immediately. Selecting an equippable item in
  the **Goods** list auto-equips it and pops the new stat. Equipping is
  server-authoritative: the client mirrors the set in `Equipment.ts`
  (optimistic + re-synced by the server's `equipped` message) and sends
  `equip {slot, itemId}`; the server validates ownership+slot, recomputes
  **weapon offense** (→ attack damage) and **total armor defense** (→ damage
  taken in `damagePlayer`), sets the held-weapon sprite, and echoes the
  authoritative `equipped` set. The held-weapon sprite is broadcast to others
  via the old `equip {itemId}` message. A **2-slot hotbar** at bottom-center is
  drawn in EVERY open menu state: drag a **Goods** row onto a box (the new
  `isPointerDown`/`consumePointerPress`/`consumePointerRelease` Input latches; a
  press-then-release on the same row is a plain use), and number keys **1–2** or
  a click trigger a slot — equip the parked weapon into its slot, or use a
  consumable. The hotbar is **independent of and optional to** equipping: it's a
  quick-switch shelf for weapons you park there (a slot whose weapon is currently
  worn shows a green ring), NOT where a weapon must live to be equipped. Equipping
  from the Equip/Goods screens never touches the bar; only acquiring a new
  weapon/consumable auto-fills an EMPTY slot (`autoHotbarNewItems`). Hotbar slots +
  equipped gear are in-memory (more slots + a save system are
  TODO). The equip model lives once in `GameHost` (`server/gameHost.js`).
- **Wallet.ts + money window** — the server-authoritative money ($). Every
  player joins with $1000; the balance ships in `welcome` and every `money`
  delta (shop buy/sell). `Wallet.ts` mirrors it so MenuManager can
  draw a small EB cash window in the top-right whenever the menu is open.
- **Shops** — EarthBound shop clerks have no dialogue; their ROM script sets a
  store flag and calls the shop routine. `tools/extract_shops.py` traces each
  clerk's Text Pointer 1 to that flag (`store = flag - 225`) and writes
  `public/assets/map/shops.json`: the item catalog (id → name/cost/type), each
  store's stock, and a clerk-NPC → store map. `Shop.ts` loads it; `NPCManager`
  tags each clerk NPC with its `shopStore` (by ROM config id from the placement
  key). `Game.tryTalk` treats a clerk as an **interactive** target (so a silent
  prop in front can't steal the probe) and calls `MenuManager.openShop` instead
  of opening dialogue. The shop UI (Buy/Sell + item lists) lives in MenuManager;
  Buy/Sell send `buy`/`sell`, and the server (`server/shops.js`, shared by both
  servers) re-prices and validates every transaction — stock, affordability,
  ownership, 14-slot cap, half-price buyback — then pushes fresh `inventory` +
  `money`. Prices/stock come from the catalog server-side, never the client.

## Editor tools (dev only — see EDITOR_TOOLS.md)

`src/editor/` is loaded by `Game.init()` through a dynamic import inside
`if (import.meta.env.DEV)` — it does not exist in production bundles (verified:
zero editor strings in `dist/`). F2 or `__eb.admin()` enters editor mode from
the playing phase: gameplay input/update suspends (remote players and NPCs keep
simulating), and the client tells the server (`sendEditorMode(true)` → `editor`
msg) to make our avatar a **non-participant anchor**: it stays in `getPlayers()`
(carrying an `editor` flag) so the world keeps living around the parked character
exactly as before — area-of-interest activation and spawners still use it — but
npcSim skips it for **targeting** (`aggroTarget`), **collision**
(`hitsPlayer`/`plow`), and **door-warp tracking**, and `damagePlayer`
no-ops for it. So enemies ignore the avatar entirely and can't kill it; without
this a death's `player_respawn` would yank the free camera back across the map.
`onPlayerRespawn` also skips the self camera-follow while the editor is active
(belt-and-suspenders). Filtering the avatar out of `getPlayers()` entirely was
wrong — a solo admin then left the sim with zero players and the whole world
froze. `setEditing(false)` on exit makes it a live target again. The camera
free-flies (WASD/drag, Shift fast; mouse wheel zooms
0.25x–2x anchored at the cursor — `Camera.zoom`, which the Renderer applies as
one scale transform with zoom-aware culling; gameplay always runs at 1), and a
HUD shows the
cursor readout (world px / tile / minitile / sector meta / collision byte via
`Collision.getCollisionByteAt`) plus grid toggles (1 tile, 2 minitile,
3 sector, 4 room-crop). Esc opens the Admin Hub (tool tiles from the
self-registration registry, jump-to-coords, save-all). Tools implement the
`EditorTool` interface (`src/editor/types.ts`): claimable mouse events,
overlay hook, shared `CommandStack` undo/redo (Ctrl+Z/Y), per-domain dirty
tracking. Saves go through `/__editor/save` — Vite dev-middleware only
(`editorSavePlugin`, `apply: 'serve'`), allow-listed filenames, atomic write +
`.bak` — into `public/overrides/`: OUR authored layer, applied on top of
extraction so re-running the pipeline never clobbers authoring. Smoke test:
`tools/verify_editor.mjs`.

**DB-backed authored content (world_docs).** The **Places** outline is the
first override to leave the file channel for the DB, so edits survive dev-server
restarts in one place. `Store.getWorldDoc(name)`/`putWorldDoc(name,data,now)`
back a generic `world_docs(name TEXT PK, data TEXT, updated_at)` table (`data` →
Postgres `jsonb` at the Supabase swap, like the character `save` column). HTTP:
`GET`/`PUT /api/world/:name`, allow-listed to `places`. **Editor is dev-only:**
these routes are mounted ONLY when `createAuthApi(store,{editorApi:true})` — the
Vite dev server passes it, the deploy server (`server/index.js`) does NOT, so the
editing surface simply doesn't exist in production. They're loopback-gated too,
so a LAN-exposed dev server stays local. (The client editor is already excluded
from `dist/` via the `import.meta.env.DEV` dynamic import; this closes the server
side.) The legacy `public/overrides/places.json` is imported into the DB once on
first dev boot, then dormant.

**Override apply path (canonical pattern):** runtime merge in the loaders, no
py bake step. Per domain: `{version, edits: {stableKey: replacement|null},
additions: [...]}` with stable keys emitted by the extraction tool. First
instance — NPC placements: `extract_npcs.py` emits `k` =
"areaIdx:npcConfigId:occurrence" per placement; `public/overrides/npcs.json`
is merged at load by `NPCManager.mergeNpcOverrides` AND `server/npcSim.js`
(**keep both in sync** — array index = wire id; deletions become tombstone
slots so ids never shift; additions append before the enemy pool). npcSim
watches the overrides file, so saved person edits go live in ~2s; props need
a browser refresh.

**Placement Editor** (`src/editor/tools/PlacementTool.ts`, READY in the hub),
three tabs:

- **NPCs**: ghosts every placement through the real `drawSprite` at the
  authored position with color-coded foot boxes, click-select + drag with
  snap (G: free/8/32px), add person/prop, delete/restore (tombstone), edit
  sprite/facing/kind/textId with live thumbnail; saves the DIFF to
  `overrides/npcs.json`.
- **Spawn**: draggable marker with facing arrow, solid/wander-leash overlap
  warnings, "Test spawn"; saves `overrides/spawn.json`, consumed by
  `Game.startGame` and both servers' join handlers (spawn is no longer
  hardcoded server-side).
- **Doors**: trigger markers, drag trigger AND destination (dashed link),
  arrive-facing/style fields, walk-test, add/disable doors; saves
  `overrides/doors.json` keyed by the base trigger anchor "x,y" and re-runs
  `loadDoors()` live. The old hand-coded `ZONE_DOOR_OVERRIDES` table migrated
  into that file; `DoorManager` and `tools/debug_room_crop_check.py` both
  read it (sweep verified identical to baseline).

**Collision & Priority Painter** (`src/editor/tools/CollisionTool.ts`, READY):
paints the minitile bytes — solid `0x80` (red), pri-lo `0x01` (blue lower
half), pri-hi `0x02` (green upper half). **Edits are PER-ARRANGEMENT**
("drawTs:arr" → {minitileIdx: byte}) — the SNES model, so one paint changes
every map tile using that graphic; the inspector shows the use count and 'U'
outlines instances. Brushes: bit tools (first cell decides set/clear), clear,
rect fill, eyedrop→stamp; B brush size; M hides art; R recomputes the room
crop at the cursor against PAINTED collision; strokes undoable. **`G Hide`**
is per-TILE foreground promotion (not per-arrangement): it marks a tile so its
art redraws OVER sprites (Renderer "Pass 3b") AND so `getSpritePriority` grants
whole-body priority to any sprite the tile overlaps — i.e. one paint is the
entire "let the player walk behind a building the ROM never made foreground"
action, no separate pri-hi needed. While the local player is behind them, a
soft CIRCLE of reveal around the player ghosts the overlapping promoted tiles
(Pass 3b radial falloff, ~0.1 alpha at centre) so you can see what's behind
the building — yourself, other players, enemies, gift boxes (all of which draw
in the behind-FG pass, so fading the FG redraw exposes them); the rest of the
building stays opaque. Promoted tiles are stored as
`foreground: ["x,y", ...]` in `overrides/collision.json`; native ROM foreground
(trees/overhangs) is untouched. Saves per-arrangement byte diffs plus that
foreground list, applied at three synced
points: `Collision.loadCollision`, `npcSim` (file-watched), and the py room
sweep. The "Verify rooms" button runs `debug_room_crop_check.py` via the
dev-only `/__editor/verify` endpoint (fixed-command allow-list in
`editorSavePlugin`).

**Sound Manager** (`src/editor/tools/SoundTool.ts`, READY): the fix for music
playing in the wrong spots. EarthBound assigns music PER SECTOR (`sectors.json`
`musicId` → `music_map.json` → SPC song number), but the door-stitched open
world leaves many sectors with the wrong (intro-state or neighbouring) musicId.
The admin draws rectangular trigger areas on the map and assigns the song that
plays inside each — drag to create, drag to move, and a **song dropdown** of real
track titles (`SongNames`, pulled from the SPC ID666 tags by
`tools/extract_song_names.py` → `src/data/songNames.json`) with a **Test** button
(`MusicManager.previewSong`, which resumes a suspended AudioContext so sound is
enabled) to audition. Songs are renamable like entities — the override lives in
`overrides/song_names.json` (`loadSongNameOverrides` at startup). Areas snap to the EB
sector grid (256×128 px) on release so they bake back to per-sector musicId on
SNES (the box follows the cursor freely while dragging; snap is applied on
mouse-up). Saved to `overrides/music.json` (`{version, areas:[{name,x,y,w,h,song}]}`);
`MusicManager.areaForPoint` checks areas first and falls back to the sector
lookup, so unauthored regions are unchanged. Resolution is **sticky**: the area
you're already in keeps the music until you leave it by more than `EDGE_MARGIN`
(one tile), so being close to a border never triggers a neighbouring room's song. `loadMusicAreas()`
runs at startup and ships like other overrides; saving pushes the working set
live via `setMusicAreas()`.

## Multiplayer server

**`server/gameHost.js` is the single source of truth for host logic** — the
`GameHost` class owns the players map, the message switch (join/move/chat/
attack/equip/use_item/buy/sell/use_psi), progression (level/exp/stats), combat
HP, and the `npcSim` wiring. There are now TWO thin transports around it, NOT
two copies of the logic:

- `server/index.js` — standalone deploy server: Express serves `dist/`, a plain
  `ws` server hands each socket to `host.handleConnection(ws)`.
- `vite.config.ts` `gameServerPlugin` — dev server: the `/ws` upgrade hands each
  socket to the same `host.handleConnection(ws)`.

Both construct one `GameHost(assetsDir)`, call `host.start()`, and forward
sockets. Any behaviour change goes in `GameHost` and both servers get it — the
old "keep both servers in sync" hazard is gone by construction (the two copies
had already drifted: the standalone server was missing progression + PSI before
this was unified). A socket only needs to look like a `ws` WebSocket
(`.send`/`.readyState`/`.on`), which both transports satisfy.

### Production data (the assets disk)

The server's authoritative sim (`npcSim`) needs ROM-derived world data —
`sectors.json`, `tiles.json`, `tileset_mapping.json`, per-tileset
`collisions.json`, `npcs.json`, `enemies.json`, `enemy_spawns.json`,
`doors.json`, `car_traffic.json`, `colboxes.json`, `gifts.json` — and the client
(until in-browser ROM extraction lands) fetches all of `/assets/*` over HTTP.

**Testing phase (now): assets are force-committed to git.** `public/assets` is
gitignored but force-added (`git add -f`), so the deploy is self-contained — the
vite build copies `public/` into `dist/` and `server/index.js` serves it (plus an
explicit `/assets` static for the in-repo path the server reads). `rom_sources/`
(the dev-only Source Assets browser) stays out. This intentionally relaxes the
ROM-no-commit policy while private-testing (no public users yet).

**At launch: stop committing, scrub history, switch to a disk.** Move the data to
a **Render persistent disk** mounted over `public/assets` (a `disk:` block in
`render.yaml` at `/opt/render/project/src/public/assets` — that path keeps the
server's overrides resolution intact, `assetsDir/../overrides` → committed
`public/overrides`). Populate it once via SSH (your local `public/assets` is the
source of truth), then `git rm -r --cached public/assets` so it's no longer
shipped in the bundle:

```
rsync -avz --delete --exclude rom_sources/ \
  ./public/assets/ <srv-id>@ssh.<region>.render.com:/opt/render/project/src/public/assets/
```

**Resilience (both phases):** if the world data is absent, `npcSim` (and
shops/gifts) degrade instead of crashing — a missing core file makes
`createNpcSim` return a RELAY-ONLY stub (no NPCs/enemies/collision; multiplayer
join/move/chat still works), so the service always boots green.
`server/gameHost.test.js` (`npm test`) drives the class with fake sockets and
asserts both the broadcast contract (join/move/chat/leave) and the
server-authoritative economy rules (equip/use_item/buy/sell, incl. refusing to
consume gear and rejecting unaffordable buys) — 17 checks.

`GameHost` relays join/move/chat/equip **and runs `server/npcSim.js`**:
server-authoritative NPC
wander AI (mirrors Collision.ts math, and stops a wander leg that would overlap
a player so collision is mutual) so all clients see identical NPC state. Wire:
`move` carries `pose` (whitelisted to walk/climb/attack/hurt); `equip` sets the
player's held item id (string ≤ 24 chars, stored on the player record so late
joiners see it; clients ignore unknown ids); `use_item` consumes a Goods slot
the player owns (validated against the server-side `GOODS` registry) and applies
its effect (Cookie → +10 HP, capped), replying with an `inventory` list to the
owner and a `heal`-tagged `player_hp` to everyone; players also carry `money`
(start $1000), shipped in `welcome`; `attack` requests a melee swing,
resolved server-side from the player's _tracked_ position (not client coords)
against enemy hurtboxes. `npc_update: [[id, x, y, dir, frame], ...]` carries
positions and `npc_hp: [[id, hp, maxHp], ...]` carries enemy HP (hp ≤ 0 =
dead/hidden); both keyed by the shared wire id, and `welcome` ships an `npcHps`
snapshot beside the `npcs` one. npcSim hot-reloads `npcs.json` (2s poll) when
extraction rewrites it and re-broadcasts every person — without this, a running
server kept pushing stale home positions and clients saw NPCs snap back to
pre-fix spots; refresh the browser too so the client picks up props. (Message handling is
single-sourced in `GameHost` now, so there is nothing to keep in sync.) The
server never touches ROM assets beyond the pure-index JSON it simulates from.

## Combat & enemies

Enemy is a third NPC kind, **selectable per placement** in the Placement Editor
(`kind: person | prop | enemy`). A placement is an enemy if its kind is `enemy`
**or** its sprite is in the legacy hostile list — both `NPCManager` (client) and
`npcSim` (server) apply the SAME rule (`isEnemyPlacement`), so they never
disagree.

**Stat layering (the cascade).** Every entity of EVERY kind (person/prop/enemy/
car) draws from one shared property shape (`EntityProps`,
`src/engine/EntityStats.ts`) resolved through a single cascade by `resolveProps`
— mirrored in `server/npcSim.js` and `src/engine/NPCManager.ts` (KEEP IN SYNC):

    kind default (floor)  ->  sprite-group entity table  ->  instance override

The **Entity Manager is the master for every entity** — the sprite-group layer
applies to all kinds, not just enemies. The kind value (NPC*HP / VEHICLE_HP /
level 1 / …) is only the \_floor default* when the entity table doesn't set a
field; author a townsperson's hp/level/speed in the Entity Manager and every
placed instance of that sprite inherits it.

The **sprite-group** layer is itself `DEFAULT_ENTITY_STATS < enemies.json (ROM
catalog) < entities.json (authored, Entity Manager)`, merged into `entityDefs`
(keep `buildEntityDefs`/`loadEntities` in sync). The master table lives in its
own file — **`overrides/entities.json`** — separate from `enemy_spawns.json`,
which is purely the **enemy-spawner config** (spawner instances +
`enemySpriteGroups` classification, owned by the Enemy Spawner tool). Both
runtimes + both editor tools read entities with a back-compat fallback to the
legacy `enemy_spawns.json` `entities` for pre-split saves. The **instance** layer
is the per-thing override that WINS over the sprite group: a placement's sparse
`props` (npcs.json, authored in the **Placement** tool's properties panel — the
shared `EntityPropsForm` component), or a **spawner**'s own fields (the Enemy
Spawner panel uses the same `EntityPropsForm`; blank = inherit the entity's
stats, and overrides save flat on the spawner so `resolveProps` reads them), or
a **vehicle**'s inline fields. So two spawners — or two placed enemies — of the
same sprite can differ in hp/aggro/chase/roam/etc., while anything left unset
inherits. `tools/extract_enemies.py` builds the catalog keyed by sprite id
(the ROM "Overworld Sprite" field IS our sprite id — direct equality). The catalog feeds **stats only** — it does NOT auto-classify its 77
sprites as hostile (that stays the explicit kind / legacy list), so adding ROM
enemies never silently turns existing NPCs aggressive. Static (placed) enemies
now read full per-entity stats, same as the spawner pool — a placed and a
spawned enemy of the same sprite are identical. They also **behave**
identically: a placed enemy is built with `roam: true` (the tick-dispatch flag
that routes to `tickEnemy`), so it wanders, chases, and swings at players AND
townsfolk just like a spawned one — it is not the passive `tickNpc` self-defense
AI that people use.

**Loot.** On a player kill, `npcSim.rollLoot(sprite)` awards the enemy's money
and rolls its item drop against the ROM rate (`drop.rate`, e.g. 1/128).
`gameHost.awardKill` credits money and, if the item is a known good
(`shops.js` GOODS) with bag room, grants it + a `loot` message. Drops of items
not yet in the goods registry are skipped (data is present; granting deferred).

`public/assets/map/enemy_spawns.json` (OUR content, not ROM-derived) lists the
legacy hostile sprite list and the spawners. Client (`NPCManager`) and server
(`npcSim`) both build the same fixed enemy **pool** appended after the extracted NPCs so
wire ids stay aligned. The server spawner activates pool slots at the spawn
point (the arcade overworld entrance ~1584,1680), they wander town-wide
(bounded by `wanderRadius`, not leashed like townsfolk), and on death
deactivate then re-activate later; ROM-placed enemies instead revive at home
after a delay. HP, damage, death, and respawn are all server-authoritative —
the client only sends `attack` and renders the broadcast `npc_hp`. Hurt/hit
box geometry is mirrored in `npcSim.handleAttack` (authoritative) and
`Renderer` (the **B**-key debug overlay). **No melee through walls:** every swing
(player→enemy, enemy→player/NPC, NPC→enemy) is gated by `npcSim.wallBetween`,
which samples the collision grid along the line between the two foot positions —
a solid tile between them blocks the hit (and an enemy so blocked drops to its
chase, pathing around the wall instead of striking through it).
`server/combat.test.js` (`npm test`)
asserts the authoritative resolution — exact damage, miss, death, cooldown, and
the wall block — aiming at a real enemy via `npcSim.enemyState()` (a positions
accessor added for tests/debug). Enemies AND townsfolk are damageable
(see NPC self-defense below); health bars hide at full HP, so a damaged shark or
hurt townsperson shows its bar while the local player always sees its own.

**Hit feedback / game feel.** Impact is sold client-side and is purely cosmetic —
the server stays authoritative for HP/death. **Knockback** is server-computed
(`npcSim.knockbackPlayerSpot`, collision-clamped) and broadcast as a landing
spot; the local player eases to it over a few frames (`Player.knockTo`) so the
camera glides instead of teleporting.

**Weight class (level-driven push + knockback).** Every actor and player has a
`mass` derived from its level (`massOf` in `npcSim.js`: `1 + level*MASS_PER_LEVEL`,
or an authored per-entity `mass` override — the Entity Manager field is a TODO).
Mass feeds two server-authoritative behaviors, both of which reduce to the OLD
behavior at equal mass so a fair same-level fight is unchanged — only a level GAP
creates asymmetry: **(1) Knockback** distance (still damage-proportional) is scaled
by the attacker/victim mass ratio (`massKnockScale`, clamped `[0.15, 2]` then back
under `KB_MAX`): a much-heavier attacker flings a light victim toward the cap, a
much-lighter attacker barely budges a heavy one — so a weak enemy chipping a
high-level player moves them almost nothing. Attacker mass is threaded through
`applyDamage`/`handleAttack` (`atk.amass`, `opts.amass/vmass`). **(2) Walk-push:**
the anti-stack `unstack` is now inverse-mass weighted (the lighter body yields
more; equal mass = the old 50/50), and `pushFromPlayers` lets a HEAVIER player
walking into a lower-mass actor shove it aside — a small capped per-tick nudge
(`PLOW_STEP`/`PLOW_STEP_MAX`), NOT a knockback impulse, so sustained contact slides
the actor smoothly out of the way (the "plow through the level-2 townsfolk blocking
the shop" case). Both share `slideApart`, which clamps the slide against walls so
nothing is shoved through one. Equal/lighter players don't plow — the normal mutual
block stands. **Player↔player** walk-push (`pushPlayers`) extends this to other
players (clearing a low-level crowd off a doorway): players live on the host, not in
`actors`, so the sim computes a wall-clamped landing spot (`knockbackPlayerSpot`, no
damage) and hands it to the host via `onPlayerShoveCb` → `GameHost.shovePlayer` (the
SAME path the vehicle plow uses; the client honors the `player_push` hint). It's
gated on the heavier player actually MOVING this tick (`playerMoved`), so a resting
player isn't a permanent repulsion aura — you push through people as you walk.

The **juice trio** lives in `Juice.ts`, a
module-level singleton (like `Emitter`) any hit-detector can poke: **hitstop**
(`Game.update` skips the world sim for a few frames while the freeze holds —
render still runs), **screen shake** (decaying trauma → camera offset applied
around the world/overlay draws in `Game.render`, restored before the HUD), and a
per-sprite **hit flash** (`Entity.flashUntil` → `drawSprite`'s `flash` arg paints
a white silhouette via a scratch-canvas `source-atop` tint). Triggers: enemy hits
flash the struck sprite from `NPCManager.applyNpcHp` (always — harmless on anyone's
hit), but the shake/hitstop juice rides a **server-confirmed `hit` combat event**:
`npcSim.handleAttack` sums the damage a swing actually dealt to enemies and, if it
connected, broadcasts `{evt:'hit', byPlayer, dmg}`; `Game.onCombat` fires the juice
only when `byPlayer` is the local player. So a swing at empty air can't be rattled
by some off-screen brawl, and townsfolk/other players hitting nearby enemies flash
the sprite but never shake your screen. Player hits fire from `Game`'s `onPlayerHp` (heavier
— taking a hit outweighs landing one), and crits add an extra punch in `onCombat`
only when the local player dealt or took it. Weapon **attack speed** (`equip_stats.json`
`attackSpeed`, server-authoritative) scales both the swing cooldown and the
client swing-pose duration so fast weapons animate as fast as they resolve.
Floating **combat numbers** (`Emitter.ts`: damage/heal/crit/miss popups, plus the
magnitude-scaled size — bigger hits read bigger) take their feel from
`CombatJuice.ts`, a live-tunable config (size curve, arc/gravity/launch, fade,
crit-burst scale, the per-popup colors, and an optional big-hit color ramp). It
loads from `overrides/combat_juice.json` and is dialed in real time by the dev
**Combat** editor tool (numbers/colors only — combat MATH stays server-side).

**Netcode — server-authoritative movement + client prediction.** The **client is
"dumb": it sends INPUTS, never positions**, and the **server owns every position**.
Each moving frame the client emits `{type:'input', seq, dx, dy}` (`Network.sendInput`)
and PREDICTS locally (`Player.applyInput` — the movement step, an exact mirror of the
server's `gameHost._stepPlayer`). The server's 30Hz sim (`_simPlayers`) drains the
queue, steps each player against authoritative collision (`npcSim.playerBlocked` =
walls + weight-class solid actors, mirroring `Player.blocked`), and replies
`{type:'pos', x, y, seq}`; the client **reconciles** (`Player.reconcile`: snap to the
server spot for that seq, replay un-acked inputs) so prediction stays ahead with no
rubber-band. **Doors are server-validated**: the client `sendUseDoor()` and the server
(`case 'use_door'` → `npcSim.doorAt`) warps to the door's OWN dest only if the player is
truly on it (`onWarp` → `Player.warpTo`). **Escalators** glide the player diagonally
client-side (`Player.rideStep`, bypasses collision); `Player.riding` suppresses
reconciliation for the glide, and at ride end `sendRideWarp(x,y)` resyncs the server
(`case 'ride_warp'`, gated by `npcSim.stairAt` = "actually on a stair", same trust as
`move`/knockback). Event warps are server-initiated (`warpEventPlayer`). **Remote players + NPCs/enemies/cars** are snapshot-interpolated
~100-160ms back (`RemoteInterp.ts`). Server-authoritative REACTIONS to your actions (a
walk-push, a melee knockback) are **predicted then reconciled** via a `predOff`
displacement (`applyPredOffset`/`injectPredOffset`, decayed by `PRED_DECAY`) — injectors
(`predictPlayerPush`/`predictMeleeKnockback`/`Game.predictPushRemotePlayers`/
`predictPvpKnockback`) mirror the server math so it lands where the result will;
movement-only (flash/hitstop/damage numbers stay server-confirmed). REMAINING: the
server `move` handler is not yet GATED (walking is server-driven for honest clients but
not yet _enforced_ — pending a playtest before locking `move` to editor/warp-shielded);
lag-compensated hit resolution (server rewinds to the attacker's view) is future.

**Status conditions + inflict model.** `server/status.js` is the single catalog +
timer/immunity/DoT engine (paralysis, sleep, diamond, poison, …), shared by
in-sim actors (npcSim) and players (gameHost). Each status names the ROM
**element** that resists it (`elementOf` → paralysis/fire/freeze/flash/hypnosis).
Every damage source carries a **data-sourced inflict spec** `[{type, chance}]`:
weapons from `equip_stats.json` `inflict` (→ `gameHost.weaponInflict` →
`handleAttack`), enemies from `enemyInflict()` (authored `inflict`/`paralysisChance`,
else a baseline). On a landed, non-dodged, **non-lethal** hit each entry's chance
is scaled by the target's per-element vulnerability (`entityVuln` for actors,
`_playerVuln` for players — player resist is gear-based, a TODO, so 100% for now)
and rolled immunity-gated (`tryStatus` / `_applyHitStatuses`). `normalizeInflict`
sanitizes all authored specs; unauthored weapon/bare hands → baseline paralysis.
Action-blocking statuses freeze actor AI and lock the local player's input.
**Consumable effects.** Beyond raw `heal` (HP), a consumable's `equip_stats.json`
entry can carry: `healPp` (restore PP), `cure` (status ids cleared on use, e.g.
`["poison","cold"]`), `buffs` (timed stat boosts `[{stat, amount, durationMs}]`),
and `revive` (HP an **auto-revive** restores). `server/buffs.js` is the buff engine
(mirrors status.js: flat additive `{stat, amount, until}` on `holder.buffs`, summed
at each use-site — attack offense, incoming-damage defense, dodge-from-speed — and
pruned each tick; `statsPayload` reports EFFECTIVE base+buff so the status screen
agrees). `use_item` applies heal/healPp/cure/buffs and refuses an all-no-op use
(full bars, nothing to cure).

**Mortal Damage (EB rolling-HP death).** A lethal hit does NOT drop you instantly.
`damagePlayer` splits on `newHp`: survivable hits apply at once; a hit that would
reach ≤0 calls `_enterDying` instead, starting the **rolling-HP death** — the EB
mechanic where the meter slides to 0 over a few seconds and you can heal mid-slide to
live. State: `p.dying`, `p.hpReal` (true post-hit total, ≤0 — what a heal must lift
back above 0), `p.dyingUntil`. Roll duration scales with how much HP you had:
`ms = (fromHp/maxHp)·MORTAL_DRAIN_FULL_MS` (4s full bar), so a hit from high HP gives a
long window, from low HP a short one. Only windows ≥ `MORTAL_BANNER_MS` (2s) flag
`banner` → the client raises **MORTAL DAMAGE!** over that player (broadcast, everyone
sees it). The visible slide is client-driven (`HealthRoll` `startMortalRoll`/
`tickMortalRoll`, drives both hp+displayHp); the authoritative death deadline is
`dyingUntil`, checked in `_tickPlayerStatuses`. **Healing** while `dying` runs through
`healPlayer`, which adds to `hpReal` and, if it clears 0, **cancels the roll (survive,
stay standing)** — so a quick potion (self via the `entry.dying` `use_item` branch, or
an ally's Lifeup via `use_psi`) literally saves you before you fall. The player stays
up + can act during the roll; `damagePlayer` early-returns on `p.dying` (invuln while
bleeding out). If the meter lands, `_mortalExpired` → `_enterDowned`.

**Downed / KO + revive.** When the mortal roll lands (or any future direct-down path),
the player enters a **downed** state for `DOWNED_MS` (30s) — `_enterDowned` (laying pose,
statuses/buffs cleared, untargetable via the `hp<=0` guards). The cash-drop penalty
is **deferred** to `_trueDeath` (timer elapses via `_tickPlayerStatuses`, or the
player **gives up the ghost** — client holds Space/touch 2s → `give_up`), so a
revive costs nothing. An ally **revives** a downed friend (`_reviveDowned`, stands
them up in place) two ways, both server-validated so a bad/out-of-range attempt is
refused without consuming anything: a **revive item** (`revive` HP; `use_item` with
optional `targetId`, else nearest downed within `REVIVE_RANGE`) — canon Horn of
life/Secret herb/Cup of Lifenoodles — or **revive PSI** (Healing γ/Ω `reviveFrac`).
A downed player can also **self-rescue**: while down they may use a healing OR revive
consumable on _themselves_ (`use_item`'s `entry.downed` branch routes any HP-restoring
food through `_reviveDowned` to stand back up; non-healing items are refused). Client:
the downed input branch fires only `triggerHotbarConsumable` (weapons/PSI stay locked).
(This downed-window self-rescue is a SECOND safety net after the mortal roll: if you
couldn't out-heal the slide and fell, you still get the 30s KO to be revived.)
Client: `player_downed`/`player_revived` drive the laying render, the over-head
countdown, and the owner's closing **vignette**. (The **MORTAL DAMAGE!** banner fires
earlier, at the START of the roll on `player_mortal` — not here.) `player_downed`
carries the killing blow's `{dx, dy, force}` (server stashes it from the lethal hit's
knockback landing), so the collapse plays a **KO throw** (`KoThrow.ts`) — the same
rotate + fling + wall-ricochet physics as the NPC `DeathFx`, but settling into the
laying pose instead of sinking (a downed player stays revivable). It's a pure render
offset (`offX/offY` + hop `z` + `angle`) on the Player/RemotePlayer — authoritative
position never moves — and the body, countdown, and vignette all ride it; cleared on
revive/standup/respawn. Deterministic from the broadcast, so every client matches.

**NPC death throw (`DeathFx.ts`).** When a combatant (enemy / townsperson / car)
is killed, `applyDamage` broadcasts **`npc_death`** `{id, dx, dy, force}` — `(dx,dy)`
is the unit heading away from the attacker, `force` the killing blow's damage (no
`atk` ⇒ `0,0`, a poison/scripted kill that rotates in place). The client
(`NPCManager.applyNpcDeath`) hands the slain actor's frozen visual to `DeathFx`,
which plays a VISUAL-ONLY throw: a fast 90° rotate (the KO flip), a `force`-scaled
backward fling, 1–2 hops, and a horizontal slide that **ricochets off solid tiles**
(real `checkCollision` foot-box test — it bounces off walls, never clips through);
once it stops bouncing it does a final **sink into the floor** (slides straight down
past a fixed ground mask — no fade). The body feeds the Renderer's
feet-Y sprite pass (`collectDeathSprites`) so it **respects layer depth sorting**
like any sprite. Gated per entity by the class-level `Entity.rotateOnDeath` (default
on; flipped off in code for kinds that shouldn't tumble — not a per-instance field).
The batched `npc_hp` delta still hides the live slot; this is pure cosmetics over it.

**Rolling HP bars (`HealthRoll.ts`).** Bars don't snap on a hit: every holder (player,
remote, NPC) carries a `displayHp` that **lags** the authoritative `hp`. On damage
`noteHealthDamage` holds the pre-hit fill, the lost chunk **flashes** (`pendColor`)
behind the real fill for ~320ms, then **drains** in increments toward `hp` (`rollHealth`,
advanced per-frame inside `drawHealthBar`); heals roll the fill back up. Pure
presentation — `displayHp` never touches the simulation (death stays server-authoritative).

**PSI targeting.** Support PSI (Lifeup/Healing/revive — `target:'ally'`) is
PARTY-target: the client enters a **target picker** (rings on valid targets, `Z`=
self, click an ally, `Esc`) and sends `use_psi` with a `targetId`; the server routes
heal/cure/revive to that target (or self) and validates range (`PSI_HEAL_RANGE`).
Offense PSI auto-targets (no manual aim) but its FOOTPRINT depends on the move's
`shape`: **radius** (default) hits the nearest enemy, or every enemy in `range`
when `multi` (Rockin'/Starstorm/Flash); **line** (PSI Fire) sprays a forward CONE
in the caster's facing direction — a shotgun narrow at the muzzle (`±width`) that
FANS OUT with distance (allowed side-offset = `width + spread*along`) out to
`length` ahead; both `length` and `spread` climb steeply per tier (`psiStrikeLine`),
and the cast carries a `beams[]` fan of projectile endpoints so the client sprays a
shotgun of FX; **bolts** (PSI Thunder) zaps `bolts` RANDOM live enemies within
`range`, more bolts per tier (`psiStrikeBolts`, the `psi_cast` carries a `hits[]`
so the client drops a strike FX on each). Every shape is ROOM-SCOPED: a candidate is skipped if a wall
(`wallBetween`) OR a door seam (`doorBetween`) sits between caster and enemy — the
same barrier melee/enemy-sensing use — so no PSI ever reaches into the next room
(the client's room crop would hide the attacker anyway). Healing γ/Ω revive (γ half
HP, Ω full), Lifeup heals. (Full multi-tier
roster + per-character learn-by-level gating remains a backlog content/system task.)

**PSI roster.** The full canon set — **52 abilities** across 17 families and all
their tiers (α/β/γ/Ω/Σ) — is the base on each side, BUILT from one compact family
spec (`PSI_FAMILY_SPECS`) rather than 52 literals, so the two sides stay in sync
(server `gameHost.js` + client `src/engine/PsiTuning.ts`). Each move's id matches
the ROM PSI catalog id (`PsiCatalog`) AND its `overrides/psi_anim.json` animation
key, so cast FX resolve exactly and higher tiers reuse the family's authored art
(no per-tier pixels). The four canon types — `offense`/`recover`/`assist`/`other`
— are the menu's tabs. The PSI command menu is canon-style: a **tab bar** →
**family list** → **tier popup** (`menu/layout.ts` + `menu/render.ts`); Enter
casts the highlighted tier, number keys 1-6 (or drag) equip it to a hotbar slot.

**PSI tuning (mod layer).** Every move's stats — PP, heal, damage, range, `multi`,
`reviveFrac`, `cures`, status `inflict` — live in the base table on each side
(`PSI_BASE`, re-exported as the menu's `PSI_ABILITIES` so there's no duplicate
list). The **PSI Manager** tool (`src/editor/tools/PsiManagerTool.ts`) layers
authored tuning on top via **`overrides/psi.json`** (`{ version, moves: { <id>:
{…} } }`) — the SAME file the server merges (`GameHost._loadPsi`, read at startup
→ `this.PSI`, like `equip_stats`) and the client mirrors (`effectivePsi`). It's a
FolderDesktop library (category folders Offense/Recover/Assist/Other, persisted to
`overrides/psi_folders.json`) whose tiles show each move's cast-animation icon;
the right panel tunes the fields and an **"Edit animation →"** button hands off to
the Sprite Editor's PSI mode (`openSpriteEditor({ focusPsi })`, which authors
`overrides/psi_anim.json`). Combat values apply on **server restart** (parallels
`equip_stats`).

**Ranged weapons (projectiles).** A weapon's `equip_stats.json` can set
`ranged:true` + `range` (px), plus `projSpeed` (px/tick travel), `pierce`
(hit every target in the path vs the first), and `projSprite` (on-screen look:
`'bullet'` default, `'pellet'` slings, `'beam'` energy weapons). `recomputeEquipStats`
exposes these as `weaponRange/weaponProjSpeed/weaponPierce/weaponProjSprite`. Instead
of an instant hitbox, `handleAttack` **launches a projectile** that
`stepProjectiles` (run each tick after actor movement) marches forward in sub-steps
(no tunnelling); it damages the first target its small box overlaps via the same
`resolveMelee`/`applyDamage`/LoS path a melee swing uses — or EVERY new target if
`pierce` — then ends on a wall, on its first hit, or at max range. Server-authoritative:
the launch broadcasts `projectile` (id, muzzle, unit dir, speed, dist, sprite) and the
end broadcasts `proj_end` (id, impact point, hit?); the client (`src/engine/Projectiles.ts`,
wired in `Game.ts`/`Network.ts`) only renders the flying shot + impact spark, and
self-retires a shot that flew its full `dist` if `proj_end` is ever dropped. Shots +
sparks aren't a flat overlay — `collectProjectileSprites` hands them to the Renderer's
feet-Y sprite pass (`y` = sort key) so they **respect layer depth sorting**: a shot
behind a building/canopy or behind a sprite in front of it is occluded, not painted on
top (any behind-FG priority hides the whole point-sized shot). Aim is the
facing direction. Equippable guns/beams/slings (item ids 36–48, 50, 51, 215) are all
tagged; one-shot battle items (Bazooka, Bottle rockets, sprays) have no equip slot and
are out of this system.

`overrides/equip_stats.json` is the **per-item mod layer** edited in the **Item
Manager** — name, kind (`slot`, incl. `'none'`=consumable), users,
offense/defense/crit/dodge/attackSpeed/ranged/range/projSpeed/pierce/projSprite/cost/heal/healPp/cure/buffs/revive

- the inflict list. It is
  layered over the ROM item table on BOTH sides (ROM data untouched): `server/shops.js`
  applies every field (combat + the catalog-facing name/cost/kind/users) and `src/engine/Shop.ts`
  applies the catalog-facing fields client-side, so client and server agree on what
  each item is and what slot it fits. The server reads it once at host start (combat
  values apply on the next server start); the client reads it in `loadShops`, so
  name/cost/kind apply on the next client reload.

**NPC self-defense.** Every `person` carries HP (`NPC_HP`, matching the client's
Entity default so full-HP folk need no sync) and defends itself on
**defend-on-sight** (no first hit needed) against the nearest living enemy within
its **resolved `detectRange`** (floor `NPC_DETECT_RANGE`). Combat numbers come
from the **resolved entity stats** — `damage`, `attackCooldown`, `attackRange`,
and `crit`/`dodge` (rolled through the same `resolveMelee` as enemies), with the
`NPC_*` constants only as floors. So townsfolk are full Entity-class citizens: a
Master-Roshi entity (high level/damage/crit) genuinely out-fights a generic one,
and an entity authored with **`damage: 0` can't fight at all** — it keeps its
distance instead of swinging (a civilian, not a brawler). Rather than freezing in
place, a combatant **maneuvers per a combat personality** (`tickNpcCombat`): `brave`
closes in and presses, `skirmisher` darts in to swing then peels off,
`coward` flees and only swings when cornered, `nervous` trades blows while
shuffling restlessly, and `pursuer` is a **COP** — it locks onto a bad guy and
chases it down with **no home leash** (at `chaseSpeed`), holding the chase out to
its `giveUpRange` (hysteresis via `n.pursuing`, set in `tickNpc`) before the
walk-home returns it to its beat. Personality resolves through the same cascade as
every stat: **per-placement override** (the Placement editor `combat` dropdown →
`props.combat`) **> entity default** (Entity Manager `entities[sprite].combat`) **>
a stable seeded pick by id**. The seeded fallback draws from the NON-pursuer set
(`COMBAT_PERSONALITIES`) so an unassigned crowd varies but a cop is always opt-in,
never random (`VALID_PERSONALITIES` adds `pursuer`). The resolved value rides the
actor as `n.combat` (set in `resolveProps`/build), read by `npcCombatPersonality`.
The behavior
RANGES (`detectRange`/`giveUpRange` aggro & chase, plus the `wanderRadius` roam
radius) are all authorable at the entity level (Entity Manager) and overridable
per placement. Non-pursuer combat ranges up to `NPC_COMBAT_LEASH` from home
(`NPC_FLEE_LEASH` for cowards); once the threat clears, an NPC walks back inside
its **resolved `wanderRadius`** (the `LEASH` constant is just the floor when none
is authored — `wanderRadius: 0` = a STATIONARY clerk/guard that holds its spot)
before resuming the ambient wander. A downed
townsperson hides (hp 0, like a dead enemy — the client's `NPC.dead` getter now
covers persons) and `reviveNpcs` revives it at its home spot after
`NPC_RESPAWN_MS` (backlog: a hospital / per-entity respawn point). Enemies target the nearest living
**player** within `DETECT_RANGE`, and **only if none is in range** fall back to
the nearest townsperson — players always take targeting priority. **Level-gap
flee (EB-style):** before any of that, an enemy checks for a nearby player who
out-levels it by `FLEE_LEVEL_RATIO`× (`outLevels`, default 2× — every actor
carries a resolved `level`; enemies from the ROM catalog, townsfolk default 1).
If one is in `DETECT_RANGE` and in sight, the enemy never chases or attacks it —
it enters `flee` mode and runs directly away (no leash), regrouping home once the
scarer leaves. A touch from that player (within `FLEE_TOUCH_RADIUS`) is an
**instant win**: lethal self-damage credited to the scarer runs the normal kill
path (full XP + loot, no battle), exactly like EarthBound's auto-victory on
contacting a fled-from foe. **Retaliation:**
when an NPC hits an enemy it stamps itself as that enemy's `aggressor` for
`ENEMY_AGGRO_MEMORY_MS`; with no player in range the enemy turns on its attacker
first (over a closer bystander). `applyDamage` is the one death path shared by
player swings, enemy swings, and NPC swings (it awards EXP only on player-dealt
enemy kills); all damage is still gated by `canHurt`. `hpSnapshot` ships
damaged/downed persons too so late joiners see their bars.

**Vehicles** are exclusively the `car` kind (see Traffic, below) — there is no
separate "vehicle entity" flag. A vehicle is either **parked** (1 waypoint, holds
its authored facing) or **driving** (2+ waypoints, follows the route via
`tickCar`). Both are attackable: `handleAttack` loops a maintained `vehicles` list
(`kind === 'car'`) under the same PK rules as enemies, so a PKer can destroy any
car, and they revive on a timer (`reviveCars`). _(Historical note: an Entity
Manager `vehicle` boolean once spawned an autonomous `person`-kind actor with its
own `tickVehicle` hunt-and-wander AI. That was removed — it duplicated the car
system and idled like a townsperson; the flag, `isVehicle`, and `tickVehicle` are
gone. A car that should chase is just a routed traffic car.)_

**Pursuit into buildings & regroup.** Each enemy runs a small `mode` machine:
`patrol` (wander) → `chase` (has a target) → `return` (lost it). Player movement
is client-reported (`index.js`/`vite.config.ts` just record `msg.x/y`) and the
client warps through a door by setting its own coords, so a door warp reaches the
sim as a **one-tick position jump** (`> WARP_DELTA`). The tick loop diffs each
player's position against `prevPlayerPos` to spot those jumps. A jump is only a
**followable door warp if a real door (`resolveDoor`) sits at the pre-jump
position** — that is the trigger the player stepped onto. Any other big jump is a
**teleport** (event warp, editor reposition, scripted move, respawn): it is NOT
recorded and any queued follow is dropped, so a chaser can never teleport along
and keep hitting the player invisibly. This door-only rule holds for every
teleport source by construction; sources that snap a player server-side also call
an explicit exemption (`noteRespawn` / `noteEditorExit` / `noteTeleport`) as
belt-and-suspenders for the rare case the teleport ORIGIN lands on a door trigger.
An enemy whose chased `targetId` made a real door warp while it's within
`WARP_FOLLOW_RANGE` of the doorway **follows through** — it walks to the doorway
and warps on contact (never teleports across the room), landing beside where the
player did, and the door is pushed onto its `warpStack`. A locked chase has **no home leash**
— the enemy pursues relentlessly wherever the target goes; it gives up only when
the target passes `giveUpRange` (hysteresis: acquire at `detectRange`, drop at
the larger give-up distance) or it dies, then it paths home. Both radii (plus
`wanderRadius`) resolve through the cascade above: defaults `DETECT_RANGE` /
`GIVE_UP_RANGE` / 256, overridable per-spawner (Enemy Spawner tool "aggro" /
"chase" / "roam") OR per-placement (Placement tool's properties panel), so two
spawners — or two placed enemies — of the same sprite can differ. A respawn-teleport also jumps the (full-HP)
player to spawn, indistinguishable from a door warp, so the host calls
`npcSim.noteRespawn(id)` to exempt that one jump. On losing the target the enemy
switches to `return`: it retraces its `warpStack` (warping back out at each
recorded door) then walks to its spawn point to regroup; a wedged retrace gives
up after `RETURN_GIVEUP_MS` and snaps home. If an **outdoor** enemy (its spawn
sector isn't `indoor`) ever finds itself standing in an interior with no chase
path to retrace — lured into a building and then orphaned — it can't wander (its
leash is pinned to a home across the warp), so `tickReturn` walks it to the
nearest **homeward door** (`exitDoorToward`: a door whose stored destination,
kept by `loadDoorTriggers`, lands closer to home and ideally outdoors) and warps
it through on contact, repeating for nested interiors until it emerges and walks
home. The same indoor check also flips a stuck `patrol` enemy back to `return`.
Returning enemies keep ticking even with no player nearby (the off-station branch
in the tick loop) so they don't freeze out of position. Pool/static respawns
reset `mode/targetId/warpStack`.

**Pose animation.** EB has no overworld combat art, so `SpriteManager`
(`loadSpriteGroup`) gives EVERY group a 13-row pose sheet — the ROM walk rows
plus attack/hurt bands generated by `PoseGen` (wind-up→swing, recoil→settle) —
so any NPC/enemy/player can play every pose. The sim drives it: setting an
`attack`/`hurt` pose stamps `poseStart`, and the tick loop steps the two
generated frames (f0 for the first half, f1 for the second) and holds the actor
still while a pose plays (movement would overwrite the frame). All of this lives
in `npcSim` (shared by both servers).

**PK (player-kill) model.** Every combatant carries a `pk` flag, and one helper
— `npcSim.canHurt(attacker, target)` — is the single source of truth for who
can damage whom. Enemies are always `pk:true`, townsfolk NPCs `pk:false`,
players `pk:false` for now (a per-player toggle is backlogged). Rules: enemies
hurt every non-enemy but never each other; PK players hurt everything including
other PKers and enemies; non-PK players and NPCs hurt only PKers, so two
non-PKers can't friendly-fire. `handleAttack` takes the attacker's `pk` (the
host passes `player.pk`) and gates each hit through `canHurt`. Players live on
the host (`vite.config.ts` / `server/index.js`), not in npcSim, so the host
builds the attacker shape from its player record. Live consequences today:
players hit enemies, enemies hit players and townsfolk, and townsfolk hit
enemies back (NPC self-defense above). Player-vs-player melee resolution still
isn't wired (no PK player can yet land a swing on another), but the flag and
rule cover it.

## Traffic (cars)

Car is a fourth NPC kind, and the ONLY kind of vehicle. `car_traffic.json` (OUR
content — committed default in `public/assets/map/`, editor override in
`public/overrides/`) lists vehicles, each with a sprite group, speed, loop flag,
**`hp`**, **`damage`**, a **`dir`** (parked facing), and a hand-authored
**waypoint route**. A vehicle is **parked** (1 waypoint — spawns, sits at its
`dir` facing, fully attackable) or **driving** (2+ waypoints — follows the route).
Client (`NPCManager`) and server (`npcSim`) build the same car **pool** appended
_after_ the enemy pool (one slot per active vehicle — `enabled` with **≥1
waypoint**; `activeVehicles` filter kept in sync) in file order so wire ids stay
aligned. The server drives each routed car along its waypoints (`tickCar`/`dir8`),
facing its travel direction, and broadcasts position over the existing
`npc_update` channel; `tickCar` no-ops a 1-waypoint car, so a parked car simply
holds its spot and authored facing (the server never re-faces it — the client
seeds the parked facing from `dir`). A car is a **full combatant** that follows
its **hand-authored route and is NOT wall-blocked** (routes are drawn on drivable
streets; a wall check would falsely stall the large body box on tile edges). As it
drives, `plow()` resolves whoever its body box overlaps — foes (enemies + PKers,
gated by `canHurt`) take its `damage` + scatter knockback, friendlies are nudged
out of the lane. It **is itself attackable** (`handleAttack`
loops the `vehicles` list under the same PK rules — only PKers can wreck a car),
carries `hp`/`maxHp` broadcast on the `npc_hp` channel (HP bar + damage numbers on
the client), and on death respawns at its route start (`reviveCars`). A **vehicle
is a car NPC** (parked or driving), so it can also be **talkable**: a vehicle may carry a `t`
(textId), and `NPCManager` spawns the car NPC with it — `Game.tryTalk`/
`getNpcDialogue` work on any NPC with a textId, so a car speaks like EB's parked
cars. Author its line via the Traffic Editor's **Dialogue** button (same handoff
as the Placement Editor's). Cars are solid to actors/the local player via
`hitsActor`/`blockedByNPC` (full per-direction body box). Routes, HP, and damage
are authored in the **Traffic Editor** (`src/editor/tools/TrafficEditorTool.ts`).
No road data exists in the ROM, so routes are entirely hand-placed on the streets.

**Entity collision boxes.** A car's footprint differs by facing and the sprite
cell is transparent-padded, so a car collides by the **exact per-direction box**
of the frame it's facing, not the padded cell. `tools/extract_vehicle_colboxes.py`
precomputes the tight opaque-pixel bounds of each direction's drive frames into
`public/assets/sprites/colboxes.json` (`spriteId → dir(0-7) → {w,h,offX,offY}`,
feet-anchored). Client (`NPCManager.blockedByNPC`) and server (`npcSim.actorBox`)
load the SAME file and pick the box by the car's current `dir` — keep them in
sync. Precedence for any entity's box: a manual per-sprite-group override
(`enemy_spawns.json` `entities[sprite].col`, authored in the **Entity Manager**'s
Collision section — a direction-cycling preview with a draggable box) wins; else
the precomputed per-direction box for cars; else the kind default (full cell for
cars not in colboxes.json, the 14×8 foot box for people/enemies). People keep the
foot box by default — collision is by their feet, not their whole body.

EarthBound's static vehicle-sprite placements (cars/taxis/trucks placed as
`prop` NPCs) are linked to traffic instances by `tools/gen_vehicle_traffic.py`:
it appends one named, enabled vehicle per prop to the `car_traffic.json` override
(default route running ±96px along the prop's facing — the road it sat on) and
removes the now-duplicate static placement via an `npcs.json` `edits[k]=null`
(talkable `person` cars carry their `t`/textId onto the vehicle so the dialogue
survives — the car stays speakable). The script is
idempotent (deterministic `v_npc_<k>` ids). The **Placement Editor** surfaces all
traffic vehicles as green markers in its NPCs tab and can **place** one: the
**`+ vehicle`** button drops a parked car (1 waypoint, South facing, default Car
sprite) and writes it straight to `car_traffic.json` (`PlacementTool.saveTraffic`,
same file shape the Traffic Editor saves). Selecting a vehicle shows an
"Edit route in Traffic →" button that opens the Traffic Editor preselected on that
vehicle (`TrafficEditorTool.requestVehicle`) — where you draw its route (making it
drive), pick its sprite/facing, set speed/HP/damage, and author dialogue. So the
workflow is: drop a car in Placement → optionally route it in Traffic.

## NPC system

`tools/extract_npcs.py` joins `eb_project/map_sprites.yml` (placements on a
32-wide grid of 256×256px areas) with `eb_project/npc_config_table.yml`
(sprite, facing, visibility flag, text pointers), filtered by world flags.
Type `person` → wanders server-side, gets a health bar; `object`/`item` →
`prop`, static. All placement types use the SAME anchor: sprite center-x,
feet at raw Y + 8 (the placement Y sits 8px above the feet). This was wrong
twice (top-left + (w/2,h), then raw pass-through) — see bugs.md, and verify
any future anchor change with `tools/debug_person_anchor_stats.py` (persons
must stand on walkable ground map-wide; single-prop spot checks have
mis-"verified" this twice). Some props are invisible interaction hotspots
(phones, signs): the visible object is map tiles, the NPC only carries the
check text.

## Rooms (custom room authoring)

EB does NOT reuse interiors between separate buildings — verified by tracing the
door table AND the script-`{warp(N)}` doors with their real origins: every shop
and house has its own dedicated interior region (the only multi-entrance
interiors are caves, i.e. one dungeon with several mouths). So there is nothing
to "de-duplicate." Instead, this is the substrate for AUTHORING **custom** rooms
that don't exist in the ROM — copy an interior as a template, edit its tiles, and
wire new doors to it.

- **Extendable map.** New rooms are stamped into an "interiors band" appended
  BELOW the overworld; the plane grows in HEIGHT only (width fixed at 256, so all
  row-major indexing is unchanged). `MAP_HEIGHT_TILES`/`MAP_HEIGHT_SECTORS` in
  `types.ts` are live bindings set by `MapManager.loadMapData` from the data.
  Width-fixed means copying a room's tile _values_ into a band region whose
  sectors share the source's tilesetId/paletteId reproduces rendering AND
  collision (collision is keyed by tile ARRANGEMENT, not position).
- **Server MUST stamp the band too.** The band is NOT baked into `tiles.json`
  (that stays the 320-tile ROM overworld) — it's assembled at load from
  `overrides/rooms.json`. The client does this in `MapManager.buildCustomRoomBand`;
  `server/npcSim.js` mirrors it in `buildRoomBand()` (grows `tiles`/`sectors`,
  re-derives `mapHTiles`, registers composite tiles for `blocked()`), file-watched
  on `rooms.json` (2s poll → re-stamp + `reloadPlacements` so `indoor` re-derives).
  This is load-bearing: a placement below the base height that the server doesn't
  stamp reads as out-of-bounds **solid** in `blocked()`, so any enemy/NPC in a
  custom room can neither sense players (`canSense`) nor wander — it freezes in
  place while the client (player movement is client-side) walks the room fine.
  Custom-room composite cells (id ≥ `COMPOSITE_BASE`) carry per-source-minitile
  collision, mirrored from `Collision.ts` `compositeRow` in `npcSim.compositeByte`.
- **Editing EXISTING rooms (map-tile override).** `overrides/map_tiles.json` is a
  per-map-cell tile override (`{cells: {"tx,ty": arrangementId}, composites}`) that
  lets the Room Builder repaint ANY room — not just the band — so baked-in
  furniture can be moved, covered (paint floor over it), or added. It's applied
  LAST in `buildCustomRoomBand` (client) / `buildRoomBand` (server, file-watched
  like `rooms.json`), so it wins over the ROM base + band. **Collision follows for
  free**: both `Collision.effectiveRow` and `npcSim.blocked()` read the cell's
  arrangement, so a changed tile brings its own collision — no `collision.json`
  edit needed. A painted arrangement is interpreted with the TARGET cell's own
  sector tileset/palette, so the Room Builder enforces a style match (reject a
  mismatched brush). Toggle via Room Builder's "Edit map" button; furniture
  OBJECTS (sprite props like Bench/Stove/Jar — most EB furniture) are instead
  moved/added in the **Placement** editor, since they're sprite placements, not
  tiles.
- **Registry.** `src/engine/Rooms.ts` loads `rooms.json`
  (`{id,label,town,type,rect,spawn}`), maps a point→room, and tracks the active
  room (`Game.updateRoomBounds`). The editor's **Places** column
  (`LocationNav.injectInstancedRooms`) lists authored rooms under their town.
  Absent `rooms.json` ⇒ overworld-only, no behavior change (current state).
- **Places outline.** `LocationNav` composes a door-derived `area→building→room`
  tree, then layers authored overrides (`PlacesDoc`: manual `areas`, reparent
  `parent`, sort `order`, renames/hides, marquee `thumbRect`/`bounds`, room
  `roomId` links). Edits drag-and-drop, rename inline, and persist to the DB
  (`world_docs['places']` via the dev-only `/api/world/places` routes) — see the
  DB-backed-content note above. Pure navigation metadata; no runtime/gameplay
  consumer.

## NPC dialogue (talk/check)

**Extraction** — `tools/eb_dialogue.py` decodes the CoilSnake ccscript text
dump (`eb_project/ccscript/data_*.ccs`) into plain text pages by walking the
text-engine bytecode the way the game would:

- `npc_config_table` **Text Pointer 1 is the talk/check script**; Text
  Pointer 2 is the use-item-on-NPC script (e.g. the ATM's "Nothing
  happened") and is never shown as dialogue.
- Flag conditionals are evaluated against `src/world_flags.json`:
  `[06 LL HH ptr]` = jump-if-flag-set; `{isset(flag N)}` + `[1B 02/03 ptr]`
  = jump if last test false/true. Tests we can't evaluate (items, counters)
  fall through to the default branch.
- `{stat(N)}` prints character-record text: N = 8/30/52/74 are the four party
  member names (records are 22 apart), 7 is the bank balance. `{name(N)}` and
  `{itemname(N)}` expand from the party list / item table.
- The lead member (Ness in the ROM — `{stat(8)}` / `{name(1)}`) is the local
  player in our MMO, so those codes extract to the literal token `$name`.
  `DialogueManager.openDialogue()` substitutes `$name` → the talking player's
  character name at display time, so the same line reads correctly for everyone.
  Authors can also type `$name` directly in hand-written dialogue.
- `<` and `>` are EB's double-quote glyphs → mapped to ASCII `"` (the engine's
  TextRenderer is a 128-cell ASCII grid that silently skips other codepoints).
- Yes/No menus `[19 02]` and computed jumps `[09 ..]` end the decode — the
  text up to the question still reads naturally. `call()` subroutines (battle
  setups, gift handlers) are skipped.

`extract_npcs.py` attaches `t` (the NPC config id) to each placement that has
dialogue and writes `public/assets/map/npc_text.json` = `{t: [page, ...]}`.

**Runtime** — Q is the contextual Talk to/Check button (`isTalkPressed` in
Input.ts). `Game.tryTalk()` probes 16px in front of the player's facing
direction and picks the nearest NPC/prop within 24px of the probe; its pages
open in `DialogueManager` (fixed 3-line EB window, typewriter reveal;
Q/Space/Enter/Z skips the reveal → advances boxes → closes). No target or no
text → the authentic Check fallback, "There was no problem here." While a
dialogue is open, movement, doors, chat, and menu are frozen, and a `person`
target is turned to face the player every frame (server wander updates would
otherwise override it). Dialogue is client-local; no server messages.

**Known limitation** — dialogue is decoded at extraction time with the world
flag state baked in, so flag-conditional NPCs always say their open-world
line. Runtime flag evaluation means porting the decoder into the engine,
which fits the planned client-side Web Worker extraction (CLAUDE.md).

### Gifts (item-containers)

Every EarthBound item-container you open/check is a `Type: item` TPT entry; they
share ONE mechanism and differ only by overworld sprite group (the look): **195
present** (opens to 196), **214 trash can**, **233 gift box**, **262 crate**,
**322 jar**, **33 basket**. Each one's data lives entirely in its
`npc_config_table.yml` entry: **`Text Pointer 2`** is the item id (`$XX` hex),
and **`Event Flag`** is the container's unique ROM identity. (All share one
opener script, so contents are NOT in the script — they're that field.) A few
carry a 2-byte `Text Pointer 2` (a custom-script pointer, not an item) and are
flagged `special` with `item: null` for manual authoring, never guessed.

`tools/extract_gifts.py` joins the `Type: item` placements already in `npcs.json`
(so each `k` matches its rendered prop) with those config fields and writes
`public/assets/map/gifts.json` =
`[{k, x, y, sprite, romFlag, item, itemName, special?}, ...]` (`sprite` = the
container type). Authored changes layer on via `overrides/gifts.json` =
`{edits: {k: {item}}, additions: [{k,x,y,sprite,romFlag,item}]}`, edited in the
**Gift Manager** tool (a type tab per container sprite + All). `edits` re-author
a ROM container's contents; `additions` are brand-NEW containers the admin placed
(click-to-place; the active tab picks the type) with a minted key (`gift+N`) and
a private flag (romFlag ≥ 1000, clear of ROM containers). NPCManager spawns a
**`gift`-kind** NPC for each container — both ROM placements (classified by
catalog membership) and additions (into the area buckets + npcByKey, NOT
npcsById — that stays aligned with the server's enemy/car pool). `kind: 'gift'`
behaves exactly like a `prop` (inert, no health bar, solid only with an authored
col box) but is labelled so the Placement Editor shows `(gift)` not `(prop)`.
The server hot-reloads
`overrides/gifts.json` (fs.watchFile) so new containers are openable without a
restart.

**Visual.** EVERY container sprite packs BOTH states in its own sheet: the
closed box faces **South** (row 1 — the baked direction of every ROM container),
the lidless/**open** (empty) box faces **North** (row 0). This holds for all six
types — present (195), trash can (214), gift box (233), crate (262), jar (322),
basket (33) — verified frame-by-frame. Opening just flips the box to face North
(`beginGiftOpen`), and it PERSISTS that way — the box is never removed. On load,
a container whose flag is already set starts North (open). `giftOpened(npc)` =
the player's flag is set; it gates re-opening (and the open frame already shows
it's done, so the client doesn't re-ping an opened container).

**Per-player one-time open.** The ROM's single global "opened" flag can't model
an MMO (shared world, personal progress), so each gift maps to a PRIVATE
PlayerFlag at `GIFT_FLAG_BASE (910000) + romFlag` (kept in sync between
`src/engine/Gifts.ts` and `server/gameHost.js`). The flow is
server-authoritative: pressing Talk on a box (`Game.tryTalk` → `sendOpenGift(k)`)
sends `open_gift`; the host checks the flag, the bag has room, grants the item
(`inventory` + `loot`), sets the flag, and acks `gift_opened`. The client then
flips the container to its open North frame (`Gifts.beginGiftOpen`) and marks
the flag locally. The editor's `getNpcsInRect` shows every box so the Gift
Manager always lists them all.

**Empty / "special" containers.** A container with no resolvable item (a
`special` gift) has nothing to grant, so instead of doing nothing it replies
with the canon EarthBound flavor line: `emptyContainerText(sprite)` ("There was
just plain ol' garbage in the trash can." for 214, "But the present was empty."
for 195, else "But it was empty."; mirrors `eb_project/ccscript/data_33.ccs`),
sent as a `notice`. It does NOT consume the flag, so an empty container stays
CLOSED and re-checkable (you can keep digging — always garbage). A container
that DID grant an item is flipped open and its flag set, so re-checking it is a
no-op (the open frame already shows it's emptied).

### Ness's mom (favorite-food heal)

Talking to **Ness's mom** (sprite group 145; `NPC.isMom`, gated in `Game.tryTalk`
like phones/ATMs/gifts) cooks the player's **favorite food** — a server-
authoritative heal of `MOM_FOOD_HEAL` (50 HP) on a `MOM_FOOD_COOLDOWN_MS` (5 min)
wall-clock cooldown. The client sends `mom_food`; the host heals (clamped, via a
`player_hp` broadcast), arms `momFoodReadyAt`, and replies `{healed, readyInMs,
food}`; the client renders her dialogue from those facts (heal line / "ready in
Xm Ys" while cooling down / "already full"). `momFoodReadyAt` is **persisted in
the save**, so relogging can't reset the timer. `favoriteThing`/`favoriteFood`
are authored at character creation (CreateFlow → `POST /api/characters`) and live
in the character save; `_loadCharacterInit`/`_saveCharacter` round-trip them (and
must keep including them, or a later save would wipe them).

**Verification** — `tools/verify_dialogue.mjs` drives the real game in
headless Chromium (Playwright) and screenshots the dialogue flow. Note:
synthetic instant key presses are invisible to the polled key set — hold keys
~120ms. Delete captured screenshots; they contain ROM-derived pixels.
