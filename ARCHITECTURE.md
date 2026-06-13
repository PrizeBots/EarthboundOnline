# Architecture

Living document describing how EarthBound Online actually works. **If you change
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
                                            server/index.js + server/npcSim.js
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
4. `tools/build_atlases.py` — pre-renders BG + FG tile atlases per palette
5. `tools/extract_npcs.py` — NPC/prop placements (`npcs.json`) **and dialogue**
   (`npc_text.json`), see below
6. `npm run dev` — Vite on port 4444 (game WebSocket server attaches to Vite
   in dev; `server/index.js` is the standalone deployment)

The event-flag state for the open world lives in `src/world_flags.json` — the
single source of truth shared by `apply_map_changes.py`, `extract_npcs.py`,
`eb_dialogue.py`, and the engine's DoorManager. Change a flag there and re-run
the pipeline; map, NPC visibility, and dialogue stay consistent.

## Client engine (`src/engine/`)

`Game.ts` owns the loop and phases (`loading → charselect → playing`)
and wires everything; per-frame order in `update()` matters: chat typing freezes
the world, then menu, then dialogue, then talk/door triggers, then movement.
Dev hook: `window.__eb.game.debugTeleport(x, y)` jumps anywhere with proper
sector load + room crop — use it from the console or verification scripts.

- **Renderer / TilesetManager / MapManager** — EB's dual-layer system: BG atlas
  behind sprites, FG atlas in front, FG tiles depth-sorted with sprites.
- **Collision.ts** — minitile collision; byte bit 7 = solid, bits 0–1 = sprite
  priority: 0x01 = lower body behind FG (tall grass, counters), 0x02 = WHOLE
  body behind FG (canopies, behind signs; 0x03 = whole wins). There is NO
  upper-half bit — two earlier misreadings caused the floating-head-on-signs
  bug (bugs.md). Also computes room bounds (camera crop) for every `indoor` or
  `dungeon` sector — interiors AND caves are packed adjacent to unrelated
  chunks on the stitched map and must be masked to the current room. Rooms
  are SEALED (bugs.md, arcade/Tracy's-room): the flood won't slip under
  walls in indoor sectors, pocket-merge skips regions containing doors
  (DoorManager registers mat+dest cells via `setDoorCells`), and the local
  player moves through `checkPlayerCollision`, which treats minitiles
  outside the active room (`setActiveRoom`/`RoomBounds.cells`) as solid —
  only doors move you between rooms.
  `tools/debug_room_crop_check.py` replays the exact algorithm in Python
  over all door destinations; keep it in sync when changing the algorithm.
- **Entity.ts** — base class for Player and NPC (position = sprite center-x /
  feet-y, 2-frame walk cycle). Remote players share the drawable shape only.
- **DoorManager** — door triggers + fade transitions.
- **NPCManager / NPC.ts** — loads placements, buckets them into the ROM's
  256px area grid, lazy-loads sprite sheets, applies server `npc_update` rows.
  `blockedByNPC` makes `person` NPCs solid for the player (the player's move
  combines it with `checkPlayerCollision`); `prop` placements stay walkable
  because many are invisible interaction hotspots whose body is already in
  the map collision.
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
- **Items.ts** — held-item overlays: 16x16 pixel-art sprites authored IN THIS
  FILE as text grids (our own art, never ROM-derived). Drawn at a
  per-direction hand anchor relative to the entity anchor; facing away
  (N/NE/NW) puts the item in the far hand, under the body sprite. Attack pose
  raises (frame 0) then swings (frame 1) the item. In-game keys: F = attack,
  H = hurt (debug hook until combat deals damage), G = cycle held item
  (placeholder until an inventory exists). Pose rides on the move message;
  the held item syncs via the `equip` message and persists on the server
  player record so late joiners see it.

## Editor tools (dev only — see EDITOR_TOOLS.md)

`src/editor/` is loaded by `Game.init()` through a dynamic import inside
`if (import.meta.env.DEV)` — it does not exist in production bundles (verified:
zero editor strings in `dist/`). F2 or `__eb.admin()` enters editor mode from
the playing phase: gameplay input/update suspends (remote players and NPCs keep
simulating), the camera free-flies (WASD/drag, Shift fast; mouse wheel zooms
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
crop at the cursor against PAINTED collision; strokes undoable. Saves
per-arrangement diffs to `overrides/collision.json`, applied at three synced
points: `Collision.loadCollision`, `npcSim` (file-watched), and the py room
sweep. The "Verify rooms" button runs `debug_room_crop_check.py` via the
dev-only `/__editor/verify` endpoint (fixed-command allow-list in
`editorSavePlugin`).

## Multiplayer server

`server/index.js` (standalone) and the Vite-embedded dev server both relay
join/move/chat/equip **and run `server/npcSim.js`**: server-authoritative NPC
wander AI (mirrors Collision.ts math, and stops a wander leg that would overlap
a player so collision is mutual) so all clients see identical NPC state. Wire:
`move` carries `pose` (whitelisted to walk/climb/attack/hurt); `equip` sets the
player's held item id (string ≤ 24 chars, stored on the player record so late
joiners see it; clients ignore unknown ids); `attack` requests a melee swing,
resolved server-side from the player's *tracked* position (not client coords)
against enemy hurtboxes. `npc_update: [[id, x, y, dir, frame], ...]` carries
positions and `npc_hp: [[id, hp, maxHp], ...]` carries enemy HP (hp ≤ 0 =
dead/hidden); both keyed by the shared wire id, and `welcome` ships an `npcHps`
snapshot beside the `npcs` one. npcSim hot-reloads `npcs.json` (2s poll) when
extraction rewrites it and re-broadcasts every person — without this, a running
server kept pushing stale home positions and clients saw NPCs snap back to
pre-fix spots; refresh the browser too so the client picks up props. **Keep
both servers' message handling in sync.** The server never touches ROM assets
beyond the pure-index JSON it simulates from.

## Combat & enemies

Enemy is a third NPC kind. `public/assets/map/enemy_spawns.json` (OUR content,
not ROM-derived) lists hostile sprite groups (currently `284`, the Onett
Sharks) and spawners. Client (`NPCManager`) and server (`npcSim`) both
reclassify any NPC whose sprite is hostile to kind `enemy` **by sprite**, and
both build the same fixed enemy **pool** appended after the extracted NPCs so
wire ids stay aligned. The server spawner activates pool slots at the spawn
point (the arcade overworld entrance ~1584,1680), they wander town-wide
(bounded by `wanderRadius`, not leashed like townsfolk), and on death
deactivate then re-activate later; ROM-placed enemies instead revive at home
after a delay. HP, damage, death, and respawn are all server-authoritative —
the client only sends `attack` and renders the broadcast `npc_hp`. Hurt/hit
box geometry is mirrored in `npcSim.handleAttack` (authoritative) and
`Renderer` (the **B**-key debug overlay). Friendly fire is impossible — only
enemies are damageable; health bars hide at full HP, so a damaged shark shows
its bar while the local player always sees its own.

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

**Verification** — `tools/verify_dialogue.mjs` drives the real game in
headless Chromium (Playwright) and screenshots the dialogue flow. Note:
synthetic instant key presses are invisible to the polled key set — hold keys
~120ms. Delete captured screenshots; they contain ROM-derived pixels.
