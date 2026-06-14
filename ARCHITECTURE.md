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
6. `tools/extract_shops.py` — shop catalog + clerk→store map (`shops.json`)
7. `npm run dev` — Vite on port 4444 (game WebSocket server attaches to Vite
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
  connected for normal foot-box movement, so the player is *glided* across it
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
- **Items.ts** — held-item overlays: 16x16 pixel art (our own, never
  ROM-derived) drawn at a per-direction hand anchor relative to the entity
  anchor; facing away (N/NE/NW) puts the item in the far hand, under the body
  sprite. Attack pose raises (frame 0) then swings (frame 1) the item. Art is
  keyed by **catalog item id** (shops.json): authored per-item in
  `overrides/item_sprites.json` (ITEM_PALETTE-index rows + a grip point),
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
  the shared sprite-preview dropdown + search, shows name/cost/type plus the
  decoded EQUIP data — slot (weapon/body/arms/other), offense/defense, and who
  may equip it — and whether each item has art yet, and hands off (`openSpriteEditor({
  focusItem })`) to the Sprite Editor's Item mode. The Sprite Editor's item list
  is split into **Weapons / Items / Custom** tabs: Weapons/Items come from the
  catalog (a weapon is gear whose equip slot is `weapon`); **Custom** holds the
  legacy seed art (bat/pan/yoyo = `HELD_ITEM_IDS`) plus admin-made items. Since
  shops.json is ROM-derived and can't grow, the **+ New custom item** button mints
  a `custom-N` id stored in `overrides/custom_items.json` (id+name; `Items.ts`
  `loadCustomItems`/`addCustomItem`), with its art in `item_sprites.json` like any
  other item. Editing saves the 16x16 art to `overrides/item_sprites.json` via the
  dev save channel, shared by all clients. (Catalog item ids and the Goods
  inventory ids are the same numeric-string id space.)
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
  a click trigger a slot — toggle-equip gear into its slot, or use a consumable.
  Hotbar slots + equipped gear are in-memory (more slots + a save system are
  TODO). Mirrored equip model in `vite.config.ts` and `server/index.js`.
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
sector grid (64×32 px) by default so they bake back to per-sector musicId on
SNES. Saved to `overrides/music.json` (`{version, areas:[{name,x,y,w,h,song}]}`);
`MusicManager.songForPoint` checks areas first (last match wins) and falls back
to the sector lookup, so unauthored regions are unchanged. `loadMusicAreas()`
runs at startup and ships like other overrides; saving pushes the working set
live via `setMusicAreas()`.

## Multiplayer server

`server/index.js` (standalone) and the Vite-embedded dev server both relay
join/move/chat/equip **and run `server/npcSim.js`**: server-authoritative NPC
wander AI (mirrors Collision.ts math, and stops a wander leg that would overlap
a player so collision is mutual) so all clients see identical NPC state. Wire:
`move` carries `pose` (whitelisted to walk/climb/attack/hurt); `equip` sets the
player's held item id (string ≤ 24 chars, stored on the player record so late
joiners see it; clients ignore unknown ids); `use_item` consumes a Goods slot
the player owns (validated against the server-side `GOODS` registry) and applies
its effect (Cookie → +10 HP, capped), replying with an `inventory` list to the
owner and a `heal`-tagged `player_hp` to everyone; players also carry `money`
(start $1000), shipped in `welcome`; `attack` requests a melee swing,
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
`Renderer` (the **B**-key debug overlay). Enemies AND townsfolk are damageable
(see NPC self-defense below); health bars hide at full HP, so a damaged shark or
hurt townsperson shows its bar while the local player always sees its own.

**NPC self-defense.** Every `person` carries HP (`NPC_HP`, matching the client's
Entity default so full-HP folk need no sync) and defends itself: it HOLDS GROUND
— never chases — and on **defend-on-sight** (no first hit needed) faces and
swings at the nearest living enemy within `NPC_DETECT_RANGE`, dealing `NPC_DAMAGE`
on a cooldown. A downed townsperson hides (hp 0, like a dead enemy — the client's
`NPC.dead` getter now covers persons) and `reviveNpcs` revives it at its home
spot after `NPC_RESPAWN_MS` (backlog: a hospital / per-entity respawn point and
personality flags in the Entity Manager). Enemies target the nearest living
**player** within `DETECT_RANGE`, and **only if none is in range** fall back to
the nearest townsperson — players always take targeting priority. **Retaliation:**
when an NPC hits an enemy it stamps itself as that enemy's `aggressor` for
`ENEMY_AGGRO_MEMORY_MS`; with no player in range the enemy turns on its attacker
first (over a closer bystander). `applyDamage` is the one death path shared by
player swings, enemy swings, and NPC swings (it awards EXP only on player-dealt
enemy kills); all damage is still gated by `canHurt`. `hpSnapshot` ships
damaged/downed persons too so late joiners see their bars.

**Pursuit into buildings & regroup.** Each enemy runs a small `mode` machine:
`patrol` (wander) → `chase` (has a target) → `return` (lost it). Player movement
is client-reported (`index.js`/`vite.config.ts` just record `msg.x/y`) and the
client warps through a door by setting its own coords, so a door warp reaches the
sim as a **one-tick position jump** (`> WARP_DELTA`). The tick loop diffs each
player's position against `prevPlayerPos` to spot those jumps; an enemy whose
chased `targetId` jumped while it's within `WARP_FOLLOW_RANGE` of the doorway
**follows through** — it's dropped beside where the player landed (`findFreeNear`)
and the door is pushed onto its `warpStack`. While chasing, the home leash is
widened (`PURSUIT_LEASH_MULT × wanderRadius`) and dropped entirely once inside a
building (home is across the map). A respawn-teleport also jumps the (full-HP)
player to spawn, indistinguishable from a door warp, so the host calls
`npcSim.noteRespawn(id)` to exempt that one jump. On losing the target the enemy
switches to `return`: it retraces its `warpStack` (warping back out at each
recorded door) then walks to its spawn point to regroup; a wedged retrace gives
up after `RETURN_GIVEUP_MS` and snaps home. Returning enemies keep ticking even
with no player nearby (the off-station branch in the tick loop) so they don't
freeze out of position. Pool/static respawns reset `mode/targetId/warpStack`.

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

Car is a fourth NPC kind. `car_traffic.json` (OUR content — committed default in
`public/assets/map/`, editor override in `public/overrides/`) lists vehicles,
each with a sprite group, speed, loop flag, and a hand-authored **waypoint
route**. Client (`NPCManager`) and server (`npcSim`) build the same car **pool**
appended *after* the enemy pool (one slot per active vehicle — `enabled` with
≥2 waypoints — in file order) so wire ids stay aligned. The server drives each
car along its route (`tickCar`/`dir8`), facing its travel direction, and
broadcasts position over the existing `npc_update` channel; cars carry no HP and
aren't attackable. A **vehicle is an NPC that drives**, so it can also be
**talkable**: a vehicle may carry a `t` (textId), and `NPCManager` spawns the car
NPC with it — `Game.tryTalk`/`getNpcDialogue` work on any NPC with a textId, so a
car speaks like EB's parked cars. Author its line via the Traffic Editor's
**Dialogue** button (same handoff as the Placement Editor's). Cars are solid to
**everything**: a car waits in place when a
player or any actor overlaps its body box (`carBlocked`), `hitsActor`/`blockedByNPC`
make cars solid for other actors and the local player. Routes are authored in the
**Traffic Editor** (`src/editor/tools/TrafficEditorTool.ts`). No road data exists
in the ROM, so routes are entirely hand-placed on the streets.

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
traffic vehicles as read-only green markers in its NPCs tab; selecting one shows
an "Edit route in Traffic →" button that opens the Traffic Editor preselected on
that vehicle (`TrafficEditorTool.requestVehicle`).

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
  `types.ts` are live bindings set by `MapManager.loadMapData` from the data;
  `server/npcSim.js` derives `mapHTiles` the same way. Width-fixed means copying a
  room's tile *values* into a band region whose sectors share the source's
  tilesetId/paletteId reproduces rendering AND collision (collision is keyed by
  tile ARRANGEMENT, not position).
- **Registry.** `src/engine/Rooms.ts` loads `rooms.json`
  (`{id,label,town,type,rect,spawn}`), maps a point→room, and tracks the active
  room (`Game.updateRoomBounds`). The editor's **Places** column
  (`LocationNav.injectInstancedRooms`) lists authored rooms under their town.
  Absent `rooms.json` ⇒ overworld-only, no behavior change (current state).

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
