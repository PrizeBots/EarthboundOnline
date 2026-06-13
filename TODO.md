# EarthBound Online — TODO

## Phase 1: Ness in Onett (Browser)
- [x] Extract all sprites from ROM (463 sprite groups)
- [x] Extract tilesets, arrangements, collisions, palettes
- [x] Extract full overworld map + sector metadata
- [x] Tile map renderer with sector-based atlas loading
- [x] Player movement (8-directional, diagonal normalization)
- [x] Collision detection (axis-separated sliding)
- [x] Camera follow
- [x] Sprite animation (walk cycle)
- [x] Character select screen
- [x] Character creator — pixel editor over the Ness template (SpriteEditor; sheet synced in multiplayer as a PNG data URL). The old mix-and-match parts creator was removed — it never lined up.
- [x] Attack + hurt frames in the character sheet (v2 = 10 rows; editor rows F-J procedurally posed from the standing frames — wind-up/lunge/recoil band shears; F = attack, H = hurt-test in-game; pose synced via move messages)
- [x] Held item overlays (Items.ts — our own 16x16 pixel art; G cycles bat/pan/yo-yo; synced via `equip` message so everyone sees carried items)
- [ ] Verify Onett spawn point is correct and walkable
- [ ] Fix any rendering glitches (missing atlases, palette issues) — track in bugs.md
- [x] Add NPC sprites to Onett (ROM placement extraction with fresh-start flag filter; Entity/NPC/NPCManager)
- [x] NPC dialogue — ccscript text decoding (eb_dialogue.py → npc_text.json) + Q-key talk/check (DialogueManager)
- [x] Door/zone transitions between areas (flag-gated doors, zone-door + scripted-door dest overrides; full-map crop sweep clean)
- [x] Crop interior rooms to a black background (camera roomBounds + render clip; caves/dungeons too)
- [ ] Debug overlay (collision boxes, sector grid, FPS counter)

## Phase 2: Multiplayer (Browser)
- [x] WebSocket game server (embedded Vite plugin, port 4444)
- [x] Client network layer (join/move/leave)
- [x] Remote player rendering
- [x] Character select synced with server
- [x] Fix ghost sprite on join (broadcast excluded self)
- [x] Nodemon auto-restart for server changes
- [x] Server-side NPC simulation (wander/glance movement, server/npcSim.js, synced to clients)
- [ ] Player name tags above sprites
- [x] Chat system (text bubbles or chat box)
- [ ] Server-side validation (speed, position bounds)
- [x] Interpolation/smoothing for remote player movement (RemoteInterp.ts — 100ms snapshot interpolation; teleport gaps >64px snap instead of glide)
- [ ] Interpolation for NPC movement (npc_update is 10Hz, so NPCs still step ~3px; reuse RemoteInterp with a ~150ms delay)
- [ ] Handle disconnects gracefully (timeout, reconnect)
- [ ] Stress test with 10+ simultaneous clients

## Pre-Launch: User-Supplied ROM Architecture (PokeMMO model — REQUIRED before going live)
Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution" for the architecture.
- [ ] ROM intake screen before character select (file picker, checksum-verify known dumps, ROM never uploaded)
- [ ] Port extraction pipeline to TypeScript in a Web Worker (order: fonts/sprites → map/atlases/collision → roster)
- [ ] Asset cache in IndexedDB/OPFS; AssetLoader reads cache instead of HTTP
- [ ] Exclude `public/assets/` from production build (dev keeps local pre-extracted assets for speed)
- [ ] Scrub `public/assets/` from ALL git history (`git filter-repo`), force-push
- [ ] Redeploy Render with code only; verify nothing ROM-derived is served
- [ ] SPC700 music sources sample/song data from the player's ROM (was the plan anyway)
- [ ] Consider renaming the project (trademark exposure is separate from copyright)

## Phase 3: Game Server (Production)
- [ ] Move game server to standalone Node process (separate from Vite)
- [ ] Persistent world state (player positions survive server restart)
- [ ] Area-of-interest filtering (only send updates for nearby players)
- [ ] Binary protocol (replace JSON with packed messages for bandwidth)
- [ ] Server tick rate control (fixed 20Hz or 30Hz update loop)
- [ ] Authentication (simple token or account system)

## Phase 4: Build the Game
- [ ] Real-time action combat system design doc
- [ ] Hitbox/hurtbox system
- [ ] Basic melee attack (bat swing) — attack pose/frames + held-item swing already render; needs hit detection and damage, then replace the H hurt-test key with real damage triggers
- [ ] PSI/magic system (projectiles, AoE)
- [ ] Enemy AI (overworld encounters, aggro range)
- [ ] Health/damage system
- [ ] Inventory system
- [ ] Experience/leveling
- [ ] Save system (server-side persistence)
- [ ] Custom sprites for new combat animations
- [ ] Sound effects / music integration

## Backlog: Hardware Track (out of scope for now)
The SNES ROM + ESP32 port is a long-term ambition, not part of the current project.
Engine code should still be written to port cleanly (see CLAUDE.md Architecture).
- [ ] ROM build pipeline (PVSnesLib): toolchain, hello-world boot, asset converters (4bpp tiles, map), Mode 1 tile renderer, movement/camera/collision on SNES, `npm run build:rom`
- [ ] ESP32 co-processor: firmware, SPI/UART protocol, TXS0108E level-shifter bridge, 3D-printed controller-port housing, WiFi → game server link, `npm run flash:esp`
- [ ] Real hardware integration: boot on real SNES, multiplayer state via ESP32, latency testing, multi-console stress test

## Backlog / Ideas
- [ ] Player settings screen — selectable chat font (default: regular EB font; Mr. Saturn font as a fun option via ChatManager.setChatFont)
- [ ] Build visual sprite catalog (HTML page showing all 463 groups with IDs)
- [ ] Map editor in browser
- [ ] Party system (follow the leader)
- [ ] PvP zones
- [ ] Trading system
- [ ] World events / boss encounters
- [ ] Mobile touch controls for browser version
