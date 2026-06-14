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
- [x] Verify Onett spawn point is correct and walkable
- [x] Fix any rendering glitches (missing atlases, palette issues) — track in bugs.md
- [x] Add NPC sprites to Onett (ROM placement extraction with fresh-start flag filter; Entity/NPC/NPCManager)
- [x] NPC dialogue — ccscript text decoding (eb_dialogue.py → npc_text.json) + Q-key talk/check (DialogueManager)
- [x] Door/zone transitions between areas (flag-gated doors, zone-door + scripted-door dest overrides; full-map crop sweep clean)
- [x] Crop interior rooms to a black background (camera roomBounds + render clip; caves/dungeons too)
- [x] Debug overlay (collision boxes, sector grid, FPS counter) — delivered by the dev Editor Shell HUD (F2): cursor readout shows world/tile/minitile/sector + collision byte (hex + SOLID/PRI flags, `Collision.getCollisionByteAt`), tile/minitile/sector grid overlays, room-crop preview, FPS

## Phase 2: Multiplayer (Browser)
- [x] WebSocket game server (embedded Vite plugin, port 4444)
- [x] Client network layer (join/move/leave)
- [x] Remote player rendering
- [x] Character select synced with server
- [x] Fix ghost sprite on join (broadcast excluded self)
- [x] Nodemon auto-restart for server changes
- [x] Server-side NPC simulation (wander/glance movement, server/npcSim.js, synced to clients)
- [x] Traffic cars — server-driven vehicles on authored routes (`car_traffic.json`; `Vehicle` waypoint routes, one appended actor slot per car, position broadcast like NPCs). No editor yet (hand-authored JSON)
- [ ] Player name tags above sprites
- [x] Chat system (text bubbles or chat box)
- [ ] Server-side validation (speed, position bounds)
- [x] Interpolation/smoothing for remote player movement (RemoteInterp.ts — 100ms snapshot interpolation; teleport gaps >64px snap instead of glide)
- [x] Interpolation for NPC movement (RemoteInterp reused — `npcInterp = createInterpolator(160)` + `interpolateNpcs`; NPCs/enemies/cars glide like remote players)
- [ ] Handle disconnects gracefully (timeout, reconnect)
- [ ] Stress test with 10+ simultaneous clients
- [x] PK (player-kill) damage model — `pk` flag on every combatant (enemies true, NPCs false, players false) + `npcSim.canHurt(attacker, target)` as the single damage-gating rule, wired into `handleAttack`
- [ ] PK player toggle — let a player flip their own `pk` on/off (UI + server `set_pk` message); all players are non-PK until this ships
- [ ] PvP melee resolution — server-side player-hitbox-vs-player so PK rules apply between players (PK players hurt anyone; anyone hurts a PKer)
- [ ] NPC combat — give townsfolk HP/death and AI that attacks nearby PKers (so "enemies hurt NPCs" and "NPCs attack PKers" go live)

## Dev Editor Tools (in-engine authoring layer — full checklist in EDITOR_TOOLS.md)
Dev-only, never shipped (Vite-middleware save channel; excluded from prod build).
Detailed status lives in **EDITOR_TOOLS.md** — summary only here.
- [x] Editor Shell foundation (F2 / `window.__eb.admin()`): free-fly camera + zoom, cursor readout HUD, grid overlays, undo/redo, dirty tracking, save channel, Location Navigator
- [x] Admin Hub (tool registry, launch/back, save-all, jump-to-coords)
- [x] Placement Editor — NPCs (ghosts, drag/snap, add/delete, sprite/dir/kind/dialogue edit), Spawn point (config-driven via `overrides/spawn.json`), Doors/warps (`overrides/doors.json`; `ZONE_DOOR_OVERRIDES` migrated into data)
- [x] Collision & Priority Painter (per-arrangement byte brushes, live room-crop preview, `overrides/collision.json`)
- [x] Enemy Spawner Editor (place/configure enemy spawn points — sprite, roam radius, rate, max, hp; walkable/street-connected guard; `overrides/enemy_spawns.json`, hot-reloaded client+server)
- [x] Sound Manager (draw rectangular music trigger areas + assign/audition a song; `overrides/music.json` wins over the ROM's per-sector musicId in MusicManager; sector-grid snap; fixes wrong-music spots from door-stitching)
- [x] Dialogue Editor (search/edit textId pages, EB-window live preview, NPC ref counts, `overrides/dialogue.json` merged over npc_text.json; **"Dialogue ✎"** on an NPC mints + links a fresh textId and opens the editor — full place-NPC→author flow). Deferred: ccscript flag-conditionals/branches
- [x] Save-Back Channel (`/__editor/save` Vite middleware, allow-list, atomic write + `.bak`, runtime merge in loaders)
- [ ] NPC Sprite Animator (authored attack/hurt/diagonal bands per enemy group, gated on combat)
- [ ] Phase-1 pipeline hardening: push `extract_npcs` / `apply_map_changes` / doors / dialogue generators to ~99% before deepening matching editors

## Pre-Launch: User-Supplied ROM Architecture (PokeMMO model — REQUIRED before going live)
Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution" for the architecture.
- [ ] ROM intake screen before character select (file picker, checksum-verify known dumps, ROM never uploaded)
- [ ] Port extraction pipeline to TypeScript in a Web Worker (order: fonts/sprites → map/atlases/collision → roster)
- [ ] Asset cache in IndexedDB/OPFS; AssetLoader reads cache instead of HTTP
- [ ] Exclude `public/assets/` from production build (dev keeps local pre-extracted assets for speed)
- [ ] Scrub `public/assets/` from ALL git history (`git filter-repo`), force-push
  (also covers `tools/_*.png` debug renders — untracked + gitignored now, but
  still present in earlier commits)
- [ ] Redeploy Render with code only; verify nothing ROM-derived is served
- [ ] SPC700 music sources sample/song data from the player's ROM (was the plan anyway)
- [ ] Consider renaming the project (trademark exposure is separate from copyright)

## Phase 3: Game Server (Production)
- [~] Move game server to standalone Node process (separate from Vite) — host
  logic is now unified in `GameHost` (`server/gameHost.js`); `server/index.js`
  (standalone) and `vite.config.ts` are thin transports over it. Remaining: make
  the standalone process the dev runtime too (proxy Vite HMR) so there's one
  server everywhere, not just one code path.
- [ ] Persistent world state (player positions survive server restart)
- [ ] Area-of-interest filtering (only send updates for nearby players)
- [ ] Binary protocol (replace JSON with packed messages for bandwidth)
- [ ] Server tick rate control (fixed 20Hz or 30Hz update loop)
- [ ] Authentication — BACKLOGGED until launch / cross-device / real stakes (trading, PvP, bans). Interim identity = the anonymous `localStorage` save-token. When built, prefer **OAuth** ("sign in with Google/Discord") or email **magic-links** over storing passwords; let players claim their token-save by linking a credential
- [ ] Real backend for saves + auth — DECIDED (later): **Supabase or equivalent** (managed Postgres + built-in OAuth/magic-link auth). Handles persistence + identity ONLY; the custom Node game server stays for the real-time world (Supabase can't run the 60Hz authoritative sim). Game server loads/writes saves to it; client logs in via it. Skip the flat-JSON interim and go straight here if/when building toward launch

## Phase 4: Build the Game
- [ ] Real-time action combat system design doc (combat is built ahead of the doc — write it up to lock the rules)
- [x] Hitbox/hurtbox system (server-authoritative — `npcSim.handleAttack`: directional attack box vs enemy hurtboxes; enemy swing box vs player)
- [x] Basic melee attack (bat swing) — player swing deals `ATTACK_DAMAGE`, enemies flinch/die/respawn; attack/hurt poses synced over the wire
- [ ] PSI/magic system (projectiles, AoE)
- [x] Enemy AI (aggro range, chase, attack) — `npcSim` roamers detect within `DETECT_RANGE`, chase at `chaseSpeed`, swing on cooldown; per-spawner damage/rate/speed/level
- [x] Health/damage system — server-authoritative HP for enemies AND players (`onPlayerHp`/`onPlayerRespawn`, `player_hp`/`player_respawn` msgs), death + respawn, floating damage numbers (Emitter)
- [~] Inventory + equipment system — Goods (buy/use/sell, server-authoritative) + full ROM item table extracted (offense/defense/slot/who-can-equip → `extract_shops.py`). **Equipment**: EB 4-slot screen (Weapon/Body/Arms/Other) + a 2-slot quick-select hotbar; equipped **weapon offense → attack damage**, **armor defense → damage taken** (`Equipment.ts` mirror, server-authoritative per-slot equip). TODO: armor types beyond offense/defense (status resist, etc.), more hotbar slots, and **persistence** (equipped gear + hotbar + inventory reset on rejoin — needs the save system). DEV: a Cracked bat is granted on join for testing (`server/shops.js` — remove before launch)
- [x] Experience/leveling — per-spawner **XP** (Enemy Spawner editor) → server-authoritative EXP-on-kill + level-up with **full stat growth** (geometric curve `30·1.5^(lvl-1)`; HP/offense/defense wired into combat, all 7 stats grow + display); pushed to client via `player_stats` → StatusModal. No persistence yet (resets on rejoin — needs the save system)
- [ ] Save system (server-side persistence) — DECIDED: start with flat per-player JSON saves keyed by an **anonymous token** (generated client-side, stored in `localStorage`, sent on join); persists the progression block (level/exp/stats), **inventory, money, equipped gear (4 slots) + hotbar** across rejoins. No DB or login needed yet. Design saves so they can later be **"claimed" by a login**. Move to SQLite/Postgres when the standalone server (Phase 3) or accounts arrive
- [~] Custom sprites for combat animations — player attack/hurt bands done (SpriteEditor); enemy bands still need the NPC Sprite Animator
- [~] Sound effects / music integration — music PLAYS, but region triggers come from the ROM's per-sector musicId, which the door-stitched world often gets wrong. Fix is authoring-driven: the **Sound Manager** editor tool (`overrides/music.json` areas win over the sector lookup). Still to do: author correct regions across the map, then SFX (hit/attack/etc.)

## Backlog: Hardware Track (out of scope for now)
The SNES ROM + ESP32 port is a long-term ambition, not part of the current project.
Engine code should still be written to port cleanly (see CLAUDE.md Architecture).
- [ ] ROM build pipeline (PVSnesLib): toolchain, hello-world boot, asset converters (4bpp tiles, map), Mode 1 tile renderer, movement/camera/collision on SNES, `npm run build:rom`
- [ ] ESP32 co-processor: firmware, SPI/UART protocol, TXS0108E level-shifter bridge, 3D-printed controller-port housing, WiFi → game server link, `npm run flash:esp`
- [ ] Real hardware integration: boot on real SNES, multiplayer state via ESP32, latency testing, multi-console stress test

## Backlog / Ideas
- [ ] **Tile animation system** — EB animates tiles via palette/tile cycling (escalator
  steps scrolling, water, sunset, waterfalls). Our renderer pre-renders STATIC atlases,
  so escalator steps ride correctly but don't visually scroll. A tile-animation layer
  would cover all of these. (Escalators became rideable in DoorManager/Collision/Game;
  animation is the remaining piece.)
- [ ] Combat hit-reactions (stun + knockback) — the hurt flinch no longer locks movement (mob stunlock fix). Re-introduce **stun** as a deliberate, server-authoritative status effect: a **% proc chance** per enemy/weapon (entity stat) that freezes the victim for a short, **capped/diminishing** window so it can't chain into a perma-freeze. Pair with **knockback**: on a landed hit, shove the victim away from the attacker by a distance scaled to damage dealt (collision-checked, server-authoritative; small for chip damage, bigger for heavy hits). Wire both into `npcSim.applyDamage`/`damagePlayer` and broadcast so all clients see it.
- [ ] Player settings screen — selectable chat font (default: regular EB font; Mr. Saturn font as a fun option via ChatManager.setChatFont)
- [ ] Build visual sprite catalog (HTML page showing all 463 groups with IDs)
- [ ] Map editor in browser
- [ ] Party system (follow the leader)
- [ ] PvP zones
- [ ] Trading system
- [ ] World events / boss encounters
- [ ] Mobile touch controls for browser version
