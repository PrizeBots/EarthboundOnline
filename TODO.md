# EarthBound Online — TODO

> Active work is up top. **Phase 1 is fully complete** and has been moved to the
> bottom (see "Completed Phases").

## Phase 2: Multiplayer (Browser)

- [ ] Player name tags above sprites
- [ ] Server-side validation (speed, position bounds)
- [ ] Handle disconnects gracefully (timeout, reconnect)
- [ ] Stress test with 10+ simultaneous clients
- [ ] PK player toggle — let a player flip their own `pk` on/off (UI + server `set_pk` message); all players are non-PK until this ships
- [ ] PvP melee resolution — server-side player-hitbox-vs-player so PK rules apply between players (PK players hurt anyone; anyone hurts a PKer)
- [ ] NPC combat — give townsfolk HP/death and AI that attacks nearby PKers (so "enemies hurt NPCs" and "NPCs attack PKers" go live)
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

## Dev Editor Tools (in-engine authoring layer — full checklist in EDITOR_TOOLS.md)

Dev-only, never shipped (Vite-middleware save channel; excluded from prod build).
Detailed status lives in **EDITOR_TOOLS.md** — summary only here.

- [ ] NPC Sprite Animator (authored attack/hurt/diagonal bands per enemy group, gated on combat)
- [ ] Phase-1 pipeline hardening: push `extract_npcs` / `apply_map_changes` / doors / dialogue generators to ~99% before deepening matching editors
- [x] Editor Shell foundation (F2 / `window.__eb.admin()`): free-fly camera + zoom, cursor readout HUD, grid overlays, undo/redo, dirty tracking, save channel, Location Navigator
- [x] Admin Hub (tool registry, launch/back, save-all, jump-to-coords)
- [x] Placement Editor — NPCs (ghosts, drag/snap, add/delete, sprite/dir/kind/dialogue edit), Spawn point (config-driven via `overrides/spawn.json`), Doors/warps (`overrides/doors.json`; `ZONE_DOOR_OVERRIDES` migrated into data)
- [x] Collision & Priority Painter (per-arrangement byte brushes, live room-crop preview, `overrides/collision.json`)
- [x] Enemy Spawner Editor (place/configure enemy spawn points — sprite, roam radius, rate, max, hp; walkable/street-connected guard; `overrides/enemy_spawns.json`, hot-reloaded client+server)
- [x] Sound Manager (draw rectangular music trigger areas + assign/audition a song; `overrides/music.json` wins over the ROM's per-sector musicId in MusicManager; sector-grid snap; fixes wrong-music spots from door-stitching)
- [x] Dialogue Editor (search/edit textId pages, EB-window live preview, NPC ref counts, `overrides/dialogue.json` merged over npc_text.json; **"Dialogue ✎"** on an NPC mints + links a fresh textId and opens the editor — full place-NPC→author flow). Deferred: ccscript flag-conditionals/branches
- [x] Save-Back Channel (`/__editor/save` Vite middleware, allow-list, atomic write + `.bak`, runtime merge in loaders)

## Dev Tooling & Quality Gates

- [ ] **Drop `--no-stash` from `.husky/pre-commit`** once git is upgraded. Current git is 2.31.1 (2021); its lint-staged backup-stash is broken ("Needed a single revision"), so the hook runs `lint-staged --no-stash`. After upgrading to git ≥2.35 (run `winget install --id Git.Git -e` in a normal terminal, NOT inside Claude Code — the installer needs admin + to close Git Bash), remove `--no-stash` to regain the auto-backup safety net.
- [ ] Add Zod schemas for the other hand-edited overrides (doors, collision, npcs, dialogue, item_sprites…) — only `enemy_spawns.json` is validated so far
- [ ] `idb`/Dexie for IndexedDB asset caching — feature-driven; pick up when the client-side ROM-extraction Web Worker starts (see Pre-Launch section)
- [x] Quality stack: ESLint + Prettier, Vitest, Zod (validates `public/overrides/*.json`), GitHub Actions CI (`npm run verify`), Husky + lint-staged pre-commit

## Main Start Screen + Accounts (PLANNED — full design in START_SCREEN.md)

True title screen: **START** + **CONTINUE**. Username/password accounts (our own,
`bcryptjs`); each account holds up to **3 character saves**. START = create a character
(name → pick); CONTINUE = resume one of your saves. **Storage: SQLite in the Node server
now, behind a swappable `Store` interface → migrate to Supabase/Postgres at MVP launch
and test then.** ROM-intake step skipped for now (slots in after AUTH later). This feature
**absorbs the Phase 4 Save System** (CONTINUE needs persistence) and **reverses the
earlier "auth backlogged / OAuth-only / no DB yet" stance** — deliberate.

- [x] `Store` interface + `SqliteStore` (`better-sqlite3`) + schema/migrations (accounts, sessions, characters) — `server/store/` (contract in `index.js`, swap point = `createStore`); `bcryptjs` installed; `data/eb.db` gitignored; 15 tests in `server/store.test.js`
- [x] Auth API + sessions — `server/authApi.js` (Express app mounted in BOTH transports: `server/index.js` + `vite.config.ts`). `/api/register|login|logout|me`, `bcryptjs` hashing (cost 10), 30-day `crypto.randomBytes` session tokens, login timing-safe against username enumeration. 16 tests in `server/authApi.test.js`; verified live on :4444
- [x] Character API (`GET/POST/DELETE /api/characters`, enforce ≤3 slots) — same `authApi.js`, all routes behind `requireAuth`; delete returns 404 (not 403) for non-owned ids
- [ ] Client TITLE + AUTH screens (DOM overlay over canvas, EB-styled)
- [ ] NEW CHARACTER flow (START): name input → reuse canvas `CharacterSelect` picker → create in free slot
- [ ] CHARACTER SLOTS flow (CONTINUE): list ≤3 saves (name/sprite/level), pick → join
- [ ] Network join change: send `{sessionToken, characterId}`; server loads save and spawns from it (name/sprite/appearance come from the save)
- [ ] Wire save read on join / write on change + disconnect + periodic autosave; move `PlayerFlags` off `localStorage` into the save
- [ ] Migration seam doc'd for `SupabaseStore` (swap at launch)

## Pre-Launch: User-Supplied ROM Architecture (PokeMMO model — REQUIRED before going live)

Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution" for the architecture.

**Approach DECIDED (2026-06-15): full TypeScript rewrite of the extraction +
bake steps (NOT Pyodide/WASM) — clean/fast end state over speed-to-launch; the
public launch can wait.** Base layer (ROM-derived: tilesets/atlases/tiles.json/
sprites/collision/NPC tables/dialogue/item table/music) is extracted client-side
and never shipped; the mod layer (`public/overrides/*` + our authored JSON) keeps
merging in the existing TS loaders, unchanged. The two Python BAKE steps
(`apply_map_changes.py`, `add_sector_settings.py`) must also run in the worker.
Every ported extractor must byte-match its Python tool's output (parity tests).
First concrete step when work starts: a ~30-min spike on the CoilSnake
decompression primitive (`EbCompressibleBlock`) + a parity harness.

- [ ] ROM intake screen before character select (file picker, checksum-verify known dumps, ROM never uploaded)
- [~] Port extraction pipeline to TypeScript in a Web Worker (order: fonts/sprites → map/atlases/collision → roster)
  - [x] **Decompression primitive** (`src/extract/decompress.ts`) — faithful TS port of exhal/inhal `unpack` (the format every ROM asset uses; CoilSnake's `native_comp.decomp`). DEcompress only (we never write ROMs). **Parity-proven**: `test/extract/decompress.test.ts` byte-matches native CoilSnake on 40 real ROM blocks (~971KB); fixtures via `tools/dump_decomp_fixtures.py` (ROM-derived, gitignored). This was the foundational/riskiest piece — green.
  - [x] **ROM container + addressing + table reader** (`src/extract/Rom.ts`) — header strip, `fromSnesAddress` (HiROM), little-endian `readMulti`, fixed-width `readTable`. **Parity-proven**: `test/extract/rom.test.ts` matches native CoilSnake `table[i][0]` for all 6 pointer/value tables (graphics/arrangements/collisions/map_tileset/palette/sprite_group). Parity caught a real bug (map_tileset is 2-byte stride, not 1).
  - [x] **Tilesets** (`src/extract/tileset.ts`) — ports `EbTileset`/`EbGraphicTileset`/`EbMapPalette`: 4bpp minitile graphics (two stacked 2bpp planes), 16-bit arrangement cells, uncompressed collision bytes (bank 0x18), 6×16 BGR→RGBA palettes with the per-map-tileset assignment loop. **Parity-proven**: `test/extract/tileset.test.ts` byte-matches native CoilSnake for ALL 20 drawing tilesets (minitiles pixel-for-pixel + arrangements + collisions + palettes).
  - [x] **Map + sectors** (`src/extract/map.ts`) — ports `extract_map`: 8-interleaved-stream tile plane + local-tileset high-bit packing, 2560 sectors (tileset/palette/music), 32-entry tileset mapping. **Parity-proven**: `test/extract/map.test.ts` byte-matches native CoilSnake (81,920 tiles + 2,560 sectors + mapping).
  - [ ] Next: **sprites** (`SpriteGroupModule` — group sheets/palettes), then the two BAKE steps (`apply_map_changes`, `add_sector_settings`), then doors/dialogue/shops/music
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
- [ ] Authentication — SUPERSEDED by **Main Start Screen + Accounts** (own username/password now, `bcryptjs`; see START*SCREEN.md). OAuth/magic-link reframed as a \_later* "claim your account" upgrade, not the first auth.
- [ ] Real backend for saves + auth — DECIDED: **SQLite in the Node server now** (swappable `Store` interface) → **migrate to Supabase/Postgres at MVP launch** (no paid infra until then). The custom Node game server stays for the real-time world (Supabase can't run the authoritative sim). See **Main Start Screen + Accounts** section + START_SCREEN.md.

## Phase 4: Build the Game

- [ ] Real-time action combat system design doc (combat is built ahead of the doc — write it up to lock the rules)
- [ ] PSI/magic system (projectiles, AoE)
- [ ] Save system (server-side persistence) — FOLDED INTO **Main Start Screen + Accounts** (CONTINUE needs it). No more anonymous-token interim: saves are now per-character rows in the account DB (SQLite → Supabase at launch), persisting progression (level/exp/stats), inventory, money, equipped gear (4 slots) + hotbar, position, and player flags. See START_SCREEN.md.
- [x] Hitbox/hurtbox system (server-authoritative — `npcSim.handleAttack`: directional attack box vs enemy hurtboxes; enemy swing box vs player)
- [x] Basic melee attack (bat swing) — player swing deals `ATTACK_DAMAGE`, enemies flinch/die/respawn; attack/hurt poses synced over the wire
- [x] Enemy AI (aggro range, chase, attack) — `npcSim` roamers detect within `DETECT_RANGE`, chase at `chaseSpeed`, swing on cooldown; per-spawner damage/rate/speed/level
- [x] Health/damage system — server-authoritative HP for enemies AND players (`onPlayerHp`/`onPlayerRespawn`, `player_hp`/`player_respawn` msgs), death + respawn, floating damage numbers (Emitter)
- [x] Experience/leveling — per-spawner **XP** (Enemy Spawner editor) → server-authoritative EXP-on-kill + level-up with **full stat growth** (geometric curve `30·1.5^(lvl-1)`; HP/offense/defense wired into combat, all 7 stats grow + display); pushed to client via `player_stats` → StatusModal. No persistence yet (resets on rejoin — needs the save system)
- [~] Inventory + equipment system — Goods (buy/use/sell, server-authoritative) + full ROM item table extracted (offense/defense/slot/who-can-equip → `extract_shops.py`). **Equipment**: EB 4-slot screen (Weapon/Body/Arms/Other) + a 2-slot quick-select hotbar; equipped **weapon offense → attack damage**, **armor defense → damage taken** (`Equipment.ts` mirror, server-authoritative per-slot equip). TODO: armor types beyond offense/defense (status resist, etc.), more hotbar slots, and **persistence** (equipped gear + hotbar + inventory reset on rejoin — needs the save system). DEV: a Cracked bat is granted on join for testing (`server/shops.js` — remove before launch)
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

---

## Completed Phases

### Phase 1: Ness in Onett (Browser) ✅

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
      </content>
      </invoke>
