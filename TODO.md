# EarthBound Online — TODO (completed archive)

> This file is the **done log**. Active/remaining work lives in **TODO2.md**.

## Phase 4: Build the Game — done so far

- [x] Knockback + basic stun (combat hit-reactions) — server-authoritative in `npcSim.applyDamage` / `damagePlayer`: every landed hit shoves the victim away from the attacker (damage-scaled, collision-clamped; players via the new `player_push` message), and a % proc freezes in-sim actors with a capped/diminishing immunity window (`stunUntil`/`stunImmuneUntil`). Player-stun (input-lock) + the full EB status system are the next step (see TODO2.md "Status Condition System").
- [x] Hitbox/hurtbox system (server-authoritative — `npcSim.handleAttack`: directional attack box vs enemy hurtboxes; enemy swing box vs player)
- [x] Basic melee attack (bat swing) — player swing deals `ATTACK_DAMAGE`, enemies flinch/die/respawn; attack/hurt poses synced over the wire
- [x] Enemy AI (aggro range, chase, attack) — `npcSim` roamers detect within `DETECT_RANGE`, chase at `chaseSpeed`, swing on cooldown; per-spawner damage/rate/speed/level
- [x] Health/damage system — server-authoritative HP for enemies AND players (`onPlayerHp`/`onPlayerRespawn`, `player_hp`/`player_respawn` msgs), death + respawn, floating damage numbers (Emitter)
- [x] Experience/leveling — per-spawner **XP** (Enemy Spawner editor) → server-authoritative EXP-on-kill + level-up with **full stat growth** (geometric curve `30·1.5^(lvl-1)`; HP/offense/defense wired into combat, all 7 stats grow + display); pushed to client via `player_stats` → StatusModal. **Persists** now (per-character save: level/exp/all stats survive rejoin)
- [x] Ground loot + banking — first-touch ground drops + ATM/bank money model (spec in LOOT_AND_BANKING.md). Dad's phone call reports money banked / spent since the last call (`dad_call` → `dad_report`).

## Dev Editor Tools (in-engine authoring layer — full checklist in EDITOR_TOOLS.md) — done

Dev-only, never shipped (Vite-middleware save channel; excluded from prod build).
Detailed status lives in **EDITOR_TOOLS.md**.

- [x] Editor Shell foundation (F2 / `window.__eb.admin()`): free-fly camera + zoom, cursor readout HUD, grid overlays, undo/redo, dirty tracking, save channel, Location Navigator
- [x] Admin Hub (tool registry, launch/back, save-all, jump-to-coords)
- [x] Placement Editor — NPCs (ghosts, drag/snap, add/delete, sprite/dir/kind/dialogue edit), Spawn point (config-driven via `overrides/spawn.json`), Doors/warps (`overrides/doors.json`; `ZONE_DOOR_OVERRIDES` migrated into data)
- [x] Collision & Priority Painter (per-arrangement byte brushes, live room-crop preview, `overrides/collision.json`)
- [x] Enemy Spawner Editor (place/configure enemy spawn points — sprite, roam radius, rate, max, hp; walkable/street-connected guard; `overrides/enemy_spawns.json`, hot-reloaded client+server)
- [x] Sound Manager (draw rectangular music trigger areas + assign/audition a song; `overrides/music.json` wins over the ROM's per-sector musicId in MusicManager; sector-grid snap; fixes wrong-music spots from door-stitching) + SFX tab (event→sound assignment) with a header Stop-all button
- [x] Dialogue Editor (search/edit textId pages, EB-window live preview, NPC ref counts, `overrides/dialogue.json` merged over npc_text.json; **"Dialogue ✎"** on an NPC mints + links a fresh textId and opens the editor — full place-NPC→author flow). Deferred: ccscript flag-conditionals/branches
- [x] Save-Back Channel (`/__editor/save` Vite middleware, allow-list, atomic write + `.bak`, runtime merge in loaders)

## Pre-Launch: User-Supplied ROM Architecture — extraction pipeline done

Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution". **Approach DECIDED (2026-06-15): full TypeScript
rewrite of the extraction + bake steps (NOT Pyodide/WASM).** The binary + text
extraction pipeline below is DONE and parity-proven; the remaining launch-gating
glue (intake screen, cache-backed AssetLoader, history scrub, deploy) lives in
TODO2.md.

- [x] **Decompression primitive** (`src/extract/decompress.ts`) — faithful TS port of exhal/inhal `unpack` (the format every ROM asset uses; CoilSnake's `native_comp.decomp`). DEcompress only (we never write ROMs). **Parity-proven**: `test/extract/decompress.test.ts` byte-matches native CoilSnake on 40 real ROM blocks (~971KB); fixtures via `tools/dump_decomp_fixtures.py` (ROM-derived, gitignored). The foundational/riskiest piece — green.
- [x] **ROM container + addressing + table reader** (`src/extract/Rom.ts`) — header strip, `fromSnesAddress` (HiROM), little-endian `readMulti`, fixed-width `readTable`. **Parity-proven**: `test/extract/rom.test.ts` matches native CoilSnake `table[i][0]` for all 6 pointer/value tables. Parity caught a real bug (map_tileset is 2-byte stride, not 1).
- [x] **Tilesets** (`src/extract/tileset.ts`) — ports `EbTileset`/`EbGraphicTileset`/`EbMapPalette`: 4bpp minitile graphics, 16-bit arrangement cells, uncompressed collision bytes (bank 0x18), 6×16 BGR→RGBA palettes. **Parity-proven**: byte-matches native CoilSnake for ALL 20 drawing tilesets.
- [x] **Map + sectors** (`src/extract/map.ts`) — ports `extract_map`: 8-interleaved-stream tile plane + local-tileset high-bit packing, 2560 sectors, 32-entry tileset mapping. **Parity-proven** (81,920 tiles + 2,560 sectors + mapping).
- [x] **Sprites** (`src/extract/sprites.ts`) — ports `SpriteGroupModule`/`SpriteGroup`/`EbRegularSprite`: 4bpp frame decode, per-frame flip, 4x4 group grid, 8 shared palettes. **Parity-proven** for all 463 non-empty groups + 8 palettes.
- [x] **BAKE: sector settings** (`src/extract/sectorSettings.ts`) — ports `add_sector_settings`, reading the ROM attribute tables directly. Tags indoor/dungeon/town. **Parity-proven** for all 2,560 sectors (374 indoor, 803 dungeon).
- [x] **BAKE: map tile-changes** (`src/extract/mapChanges.ts`) — ports `apply_map_changes` + the `MapEventModule` ROM read (event tile-swap table @ bank 0x10). Bakes the curated ALLOW set (Onett barricades + Giant Step ladders). **Parity-proven**.
- [x] **Doors / warps** (`src/extract/doors.ts`) — ports `DoorModule` + door decode (door pointer table @ 0xD00000, 1280 areas; 5-byte records). All 5 kinds + text-pointer validation. **Parity-proven** (1280 areas, 2080 doors).
- [x] **Music map** (`src/extract/music.ts`) — ports `extract_music_map` (MapMusicModule, asm-ptr @ 0x6939). **Parity-proven** (165 ids).
- [x] **Text/script engine DONE** — the whole text layer extracts from the ROM, parity-proven:
  - **`ebText.ts`** — EB text byte-decoder (CCScriptWriter port).
  - **`dialogue.ts`** — NPC config table (@0xCF8985) + the eb_dialogue.py decode. **722/723 byte-exact** vs npc_text.json (the 1 is config 1091, an infinite `{inc}` loop — identical text).
  - **`music.ts`** — MapMusicModule (@0x6939) → music_map.json. **Parity** (165 ids).
  - **`items.ts`** — item table (@0x155000): names + full catalog (cost/type/equip slot+bonus/users).
  - **`shops.ts`** — store table (@0x1576B2) + clerk→store bytecode trace. **Full parity** vs shops.json.
- [x] **Atlas renderer** (`src/extract/atlas.ts`) — ports `build_atlases.py`: composes minitiles + palette into 1024×1024 BG/FG atlas RGBA (pure pixel math, runs in a Worker). **Parity-proven** (MD5 vs PIL).
- [x] **Sprite image render** (`renderSpriteImage` in `sprites.ts`) — index→RGBA. **Parity-proven** (MD5 vs extract_sprites.py).
- [x] **Asset bundle builder** (`src/extract/bundle.ts`) — the Web Worker CORE: composes every extractor + renderer into the exact `/assets/...` file set the engine loads. **Proven** (`bundle.test.ts`).
- [x] **END-TO-END smoke** (`src/extract/extractAll.ts` + `test/extract/integration.test.ts`) — diffs output against the LITERAL committed `public/assets/` files. Confirms TS output == what the running game consumes. GREEN.
- [x] **Browser wiring built** (additive — `:4444` dev flow untouched until a ROM is supplied): **`extract.worker.ts`**, **`romCache.ts`** (IndexedDB persist), **`romAssets.ts`** (boot-prime + ROM intake: file picker → SHA-256 verify → worker → persist → reload), **AssetLoader** `primeImageCache` hook, wired in `main.ts`.
- [x] **SMOKE PASSED (2026-06-15)**: maintainer ran Load ROM… → `EarthBound.sfc` extracted client-side → cached (IndexedDB, ~25 MB) → reloaded → char select + game rendered from the ROM, no errors. End-to-end PokeMMO path proven in-browser.
- [x] Legal cleanup — phase 1 (2026-06-16): `public/assets/` is now gitignored + untracked (`git rm --cached`, files kept on local disk for dev). A fresh CI/Render clone has no `public/assets/` → `vite build` can't ship it.
- **All extraction ports carry byte-for-byte parity tests vs native CoilSnake PLUS an end-to-end diff vs committed assets. The ENTIRE binary + text extraction → rendering → bundling pipeline is validated.**

## Dev Tooling & Quality Gates — done

- [x] Quality stack: ESLint + Prettier, Vitest, Zod (validates `public/overrides/*.json`), GitHub Actions CI (`npm run verify`), Husky + lint-staged pre-commit

## Phase 2: Multiplayer (Browser) ✅

- [x] Player name tags above sprites — `NamePlate.ts`: "Name Lv#" in the EB font (outlined), drawn above each player's health bar (local + remote) in `Renderer`. Remote players now also show an HP bar; remote levels stay current via `player_stats`.
- [x] Server-side validation (speed, position bounds) — `gameHost` 'move' drops non-finite coords, clamps to the map (`npcSim.bounds()`), and caps non-warp jumps to `MAX_MOVE_STEP` (=WARP_DELTA); door warps exempt via the warp shield. Tested.
- [x] Handle disconnects gracefully (timeout, reconnect) — server `_reapIdle` heartbeat closes sockets silent past `IDLE_TIMEOUT_MS` (→ save+cleanup); client auto-reconnects on unexpected drop with exponential backoff (`Network.openSocket`, replays the join). Tested.
- [x] Stress test with 10+ simultaneous clients — `server/loadtest.js` (N headless WS clients vs :4444, wander+attack+chat). Verified 12 and 20 clients: all joined cleanly, 0 errors, ~6.7k broadcast msgs/s at 20. Re-run: `node server/loadtest.js [clients] [seconds]`.
- [x] PK player toggle — **PK** item in the command menu opens a confirm ("anyone can kill you, can't turn it off for 5 minutes"). Server-authoritative + **persisted** (`pk`/`pkLockMs` in the save): enabling arms a **5-minute IN-GAME-time** lock (`pkLockMs` counts down only while online, pauses offline — can't be waited out or escaped by relogging); disabling is refused until it runs out. Broadcast as `player_pk` (remaining `lockMs`), red nameplate marks PKers.
- [x] PvP melee resolution — `handleAttack` also resolves vs other players (canHurt-gated: PK hurts anyone, anyone hurts a PKer) with crit/dodge; landed hits → `onPlayerHit`→`damagePlayer`. Tested.
- [x] NPC combat — townsfolk have HP/death + self-defense; foe-finder (`nearestFoeTo`) now also targets PK players (canHurt-gated) and swings via the host; enemies already aggro townsfolk (defend-on-sight). "enemies hurt NPCs" + "NPCs attack PKers" live.
- [x] WebSocket game server (embedded Vite plugin, port 4444)
- [x] Client network layer (join/move/leave)
- [x] Remote player rendering
- [x] Character select synced with server
- [x] Fix ghost sprite on join (broadcast excluded self)
- [x] Nodemon auto-restart for server changes
- [x] Server-side NPC simulation (wander/glance movement, server/npcSim.js, synced to clients)
- [x] Traffic cars — server-driven vehicles on authored routes (`car_traffic.json`; `Vehicle` waypoint routes, one appended actor slot per car, position broadcast like NPCs). No editor yet (hand-authored JSON)
- [x] Chat system (text bubbles or chat box)
- [x] Interpolation/smoothing for remote player movement (RemoteInterp.ts — 100ms snapshot interpolation; teleport gaps >64px snap instead of glide)
- [x] Interpolation for NPC movement (RemoteInterp reused — `npcInterp = createInterpolator(160)` + `interpolateNpcs`; NPCs/enemies/cars glide like remote players)
- [x] PK (player-kill) damage model — `pk` flag on every combatant (enemies true, NPCs false, players false) + `npcSim.canHurt(attacker, target)` as the single damage-gating rule, wired into `handleAttack`

## Main Start Screen + Accounts ✅ (full design in START_SCREEN.md)

True title screen: **START** + **CONTINUE**. Username/password accounts (our own,
`bcryptjs`); each account holds up to **3 character saves**. **Storage: SQLite in
the Node server now, behind a swappable `Store` interface → migrate to Supabase/
Postgres at MVP launch.** This feature **absorbed the Phase 4 Save System** (CONTINUE
needs persistence).

- [x] `Store` interface + `SqliteStore` (`better-sqlite3`) + schema/migrations (accounts, sessions, characters) — `server/store/` (contract in `index.js`, swap point = `createStore`); `bcryptjs` installed; `data/eb.db` gitignored; 15 tests in `server/store.test.js`
- [x] Auth API + sessions — `server/authApi.js` (Express app mounted in BOTH transports). `/api/register|login|logout|me`, `bcryptjs` hashing (cost 10), 30-day `crypto.randomBytes` session tokens, login timing-safe against username enumeration. 16 tests; verified live on :4444
- [x] Character API (`GET/POST/DELETE /api/characters`, enforce ≤3 slots) — all routes behind `requireAuth`; delete returns 404 (not 403) for non-owned ids
- [x] Client TITLE + AUTH screens — `src/engine/StartScreen.ts` (DOM overlay) + `src/engine/Auth.ts` (API client, token in `localStorage` `eb_session`). DEV: char select stays the boot screen; an **ACCOUNTS** button there opens the overlay. Register/login/logout/session-persist all live.
- [x] Creation model + persistence (SERVER) — `server/charStats.js`: 5 stats, allocate 10 pts, `deriveCombatStats` maps them onto EB combat in ONE tunable place. `POST /api/characters` validates the alloc + builds the canonical seed save. `GameHost(assetsDir, store)`: join-by-`{sessionToken,characterId}` loads the character (combat re-derived from saved alloc); save-back on level-up/equip/buy/sell/use + disconnect. Tests: `charStats.test.js` (9), `persistence.test.js` (7).
- [x] NEW CHARACTER flow UI (START) — `src/engine/charcreate/`: `CreateFlow.ts` (name → pick 1 of 3 random roster sprites → recolor → radar → Create), `StatRadar.ts`, `Recolor.ts`, `spritePreview.ts`. On confirm → create + spawn.
- [x] CHARACTER SLOTS / CONTINUE UI — `StartScreen.ts` slots view (after login): 3 boxes, empty=Create New, filled=sprite+name+Lv; click filled → resume. Verified create→persist→list live on :4444.
- [x] Client join-by-token wiring — `Network.connect(...auth)` token mode + welcome `stats`/`equipped` routed through existing handlers; `Game.startGame(opts)` + `Game.playCharacter(char)` spawn from the saved position.
- [x] Move `PlayerFlags` off `localStorage` into the save — flags now live in the character `save` JSON (gameHost `this.flags` map, persisted; private, never broadcast). Client mirrors every change to the server via a sink. Round-trip tested in `persistence.test.js`.
- [x] Migration seam doc'd for `SupabaseStore` (swap at launch) — full guide in START_SCREEN.md ("Migration to Supabase").

## Phase 1: Ness in Onett (Browser) ✅

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
