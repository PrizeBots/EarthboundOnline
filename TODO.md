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
- [ ] Verify Onett spawn point is correct and walkable
- [ ] Fix any rendering glitches (missing atlases, palette issues)
- [ ] Add NPC sprites to Onett (static placement from ROM data)
- [ ] Door/zone transitions between areas
- [ ] Debug overlay (collision boxes, sector grid, FPS counter)

## Phase 2: Multiplayer (Browser)
- [x] WebSocket game server (embedded Vite plugin, port 4444)
- [x] Client network layer (join/move/leave)
- [x] Remote player rendering
- [x] Character select synced with server
- [x] Fix ghost sprite on join (broadcast excluded self)
- [x] Nodemon auto-restart for server changes
- [ ] Player name tags above sprites
- [ ] Chat system (text bubbles or chat box)
- [ ] Server-side validation (speed, position bounds)
- [ ] Interpolation/smoothing for remote player movement
- [ ] Handle disconnects gracefully (timeout, reconnect)
- [ ] Stress test with 10+ simultaneous clients

## Phase 3: Game Server (Production)
- [ ] Move game server to standalone Node process (separate from Vite)
- [ ] Persistent world state (player positions survive server restart)
- [ ] Area-of-interest filtering (only send updates for nearby players)
- [ ] Binary protocol (replace JSON with packed messages for bandwidth)
- [ ] Server tick rate control (fixed 20Hz or 30Hz update loop)
- [ ] Authentication (simple token or account system)

## Phase 4: ROM Build Pipeline (PVSnesLib)
- [ ] Install PVSnesLib toolchain (65816 cross-compiler)
- [ ] Hello world ROM that boots on real SNES hardware
- [ ] Asset converter: PNG sprites → SNES 4bpp tile format
- [ ] Asset converter: map data → SNES-compatible format
- [ ] Basic tile renderer on SNES (Mode 1 BG layers)
- [ ] Player movement on SNES (joypad input → sprite position)
- [ ] Camera/scrolling system on SNES
- [ ] Collision detection on SNES
- [ ] `npm run build:rom` script to compile ROM from assets

## Phase 5: ESP32 Co-Processor
- [ ] ESP32 firmware skeleton (Arduino or ESP-IDF)
- [ ] SPI/UART communication protocol design
- [ ] Hardware bridge: TXS0108E level shifter wiring
- [ ] 3D print controller port housing
- [ ] ESP32 ↔ SNES data transfer (player input, game state)
- [ ] ESP32 WiFi → game server connection
- [ ] Sync multiplayer state: server → ESP32 → SNES
- [ ] `npm run flash:esp` script to compile and flash firmware

## Phase 6: Real Hardware Integration
- [ ] ROM boots on real SNES with Ness walking in Onett
- [ ] ESP32 receives multiplayer data and passes to SNES
- [ ] See other players on real SNES hardware
- [ ] Latency testing (WiFi → ESP32 → SNES pipeline)
- [ ] Stress test with multiple SNES consoles

## Phase 7: Build the Game
- [ ] Real-time action combat system design doc
- [ ] Hitbox/hurtbox system
- [ ] Basic melee attack (bat swing)
- [ ] PSI/magic system (projectiles, AoE)
- [ ] Enemy AI (overworld encounters, aggro range)
- [ ] Health/damage system
- [ ] Inventory system
- [ ] Experience/leveling
- [ ] Save system (server-side persistence)
- [ ] Custom sprites for new combat animations
- [ ] Sound effects / music integration

## Backlog / Ideas
- [ ] Build visual sprite catalog (HTML page showing all 463 groups with IDs)
- [ ] Map editor in browser
- [ ] Party system (follow the leader)
- [ ] PvP zones
- [ ] Trading system
- [ ] World events / boss encounters
- [ ] Mobile touch controls for browser version
