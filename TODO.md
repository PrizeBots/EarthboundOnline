# EarthBound Online — TODO

> Active work is up top. **Phase 1 is fully complete** and has been moved to the
> bottom (see "Completed Phases").

## 🔧 Loose ends from the last session (in progress — knock these out)

Captured from the WIP committed as "stage 2". Most of last night's work landed
green (accounts, char creation, the whole ROM extraction pipeline); these are the
threads that were left mid-flight:

- [x] **Crit/dodge combat — SERVER half.** Done: `npcSim.resolveMelee(crit,
dodge, base, rng)` (pure, dodge rolled BEFORE crit, crit = 2× `CRIT_MULT`),
      injectable rng via `createNpcSim(assetsDir, rng = Math.random)`, `critChance`
      arg on `handleAttack` that broadcasts `{type:'combat', evt:'crit'|'miss', …}`
      on dodge/crit, `resolveMelee` exported. `gameHost` passes a Luck-derived crit
      chance (`critChanceFromLuck`, ~1%/Luck, capped 50%). `combat.test.js` GREEN
      (12/12). Client side was already wired (`onCombat`→crit/miss text + SFX).
- [x] **Enemy→player crit/dodge.** Done: the enemy swing path (`tickEnemy`) now
      runs `resolveMelee` too — the player's Speed gives a dodge chance
      (`dodgeChanceFromSpeed`, ~0.5%/Speed, capped 30%) that turns an enemy hit
      into a broadcast MISS. Enemy crit hook is in place (`n.crit`, default 0) for
      per-enemy tuning later. Player dodge plumbed through the `getPlayers()` snapshot.
- [x] **`PlayerFlags` → save** — DONE this session (see Start Screen section).
- [x] **`SupabaseStore` migration seam doc** — DONE: full seam guide in
      START_SCREEN.md (swap point, contract, schema mapping, sync→async gotcha,
      security parity, cutover steps). Closes the last open Start-Screen item.

## Phase 2: Multiplayer (Browser)

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
- [x] Client TITLE + AUTH screens — `src/engine/StartScreen.ts` (DOM overlay) + `src/engine/Auth.ts` (API client, token in `localStorage` `eb_session`). DEV: char select stays the boot screen; an **ACCOUNTS** button there opens the overlay (not a boot gate). Register/login/logout/session-persist all live. START/CONTINUE present but stubbed (next phases). NOTE: replaced a parallel `src/engine/auth/` impl another agent had wired as a forced boot gate in `main.ts` — deleted, `main.ts` restored to char-select-first.
- [x] Creation model + persistence (SERVER) — `server/charStats.js`: 5 stats (Muscle/Mental/Spirit/Speed/Knowledge), allocate 10 pts (1–10 each), `deriveCombatStats` maps them onto EB combat (offense/defense/hp/pp/iq/luck…) in ONE tunable place. `POST /api/characters` validates the alloc + builds the canonical seed save. `GameHost(assetsDir, store)`: join-by-`{sessionToken,characterId}` loads the character (combat re-derived from saved alloc, gear/inventory re-validated), welcome carries `self`+`stats`+`equipped`; save-back on level-up/equip/buy/sell/use + disconnect. Anonymous dev/char-select join unchanged. Tests: `charStats.test.js` (9), `persistence.test.js` (7 incl. round-trip + auth-failure + cross-account refusal).
- [x] NEW CHARACTER flow UI (START) — `src/engine/charcreate/`: `CreateFlow.ts` (name → pick 1 of 3 random roster sprites → recolor → radar → Create), `StatRadar.ts` (SVG pentagon, draggable connected dots, 10-pt budget, Create gated until spent), `Recolor.ts` (auto-detect 3 color groups, per-group hue slider → recolored `appearance` PNG), `spritePreview.ts`. On confirm → create + spawn.
- [x] CHARACTER SLOTS / CONTINUE UI — `StartScreen.ts` slots view (after login): 3 boxes, empty=Create New, filled=sprite+name+Lv; click filled → resume. Verified create→persist→list live on :4444.
- [x] Client join-by-token wiring — `Network.connect(...auth)` token mode + welcome `stats`/`equipped` routed through existing handlers; `Game.startGame(opts)` + `Game.playCharacter(char)` spawn from the saved position; HP bar synced from stats.
- [x] Move `PlayerFlags` off `localStorage` into the save — flags now live in the character `save` JSON (gameHost `this.flags` map, persisted with level/inventory/etc; private, never broadcast). Client `PlayerFlags` keeps a synchronous in-memory Set hydrated from `welcome.flags`, mirroring every change to the server via a sink (`setFlagSink`→`Network.sendFlag`→`set_flag`/`clear_flag`/`clear_all_flags`). Defaults seed after hydrate (`getPlayerDefaultFlags`). Anon dev joins keep ephemeral flags (reset on reload, by design). Round-trip tested in `persistence.test.js`.
- [x] Migration seam doc'd for `SupabaseStore` (swap at launch) — full guide in START_SCREEN.md ("Migration to Supabase"): swap point, contract, schema mapping, sync→async gotcha, security parity, cutover.

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
  - [x] **Sprites** (`src/extract/sprites.ts`) — ports `SpriteGroupModule`/`SpriteGroup`/`EbRegularSprite`: 4bpp frame decode, per-frame flip, 4x4 group grid, 8 shared palettes. **Parity-proven**: `test/extract/sprites.test.ts` byte-matches native CoilSnake for all 463 non-empty groups (indexed pixels) + 8 palettes.
  - [x] **BAKE: sector settings** (`src/extract/sectorSettings.ts`) — ports `add_sector_settings`, reading the ROM attribute tables (misc 0xD7B200 setting; town-map 0xEFA70F image) directly instead of `map_sectors.yml`. Tags indoor/dungeon/town. **Parity-proven**: `test/extract/sectorSettings.test.ts` reproduces the yml-derived result for all 2,560 sectors (374 indoor, 803 dungeon).
  - [x] **BAKE: map tile-changes** (`src/extract/mapChanges.ts`) — ports `apply_map_changes` + the `MapEventModule` ROM read (event tile-swap table @ bank 0x10). `extractMapChanges` matches CoilSnake for all 20 tilesets; `applyMapChanges` bakes the curated ALLOW set (Onett barricades + Giant Step ladders). **Parity-proven**: `test/extract/mapChanges.test.ts` matches the Python-baked plane.
  - [x] **Doors / warps** (`src/extract/doors.ts`) — ports `DoorModule` + door decode (door pointer table @ 0xD00000, 1280 areas; 5-byte records → destination bank 0xF0000). All 5 kinds (door/stair/ladder-rope/switch/npc) + text-pointer validation that terminates areas. **Parity-proven**: `test/extract/doors.test.ts` matches CoilSnake (1280 areas, 2080 doors). Parity caught the missing text-pointer range check.
  - [ ] Next: **dialogue** (`eb_dialogue` ccscript decode — biggest remaining, decodes text-engine bytecode), **shops/items** (`extract_shops` — item table + clerk→store), **music map** — then wire into the Web Worker + IndexedDB cache + AssetLoader + ROM intake screen
  - [x] **END-TO-END smoke** (`src/extract/extractAll.ts` + `test/extract/integration.test.ts`) — composes all extractors and diffs the output against the LITERAL committed `public/assets/` files the engine loads (tiles/sectors/doors/mapping/sprite-meta/palettes + all 20 tilesets' arrangements/collisions/palettes). Confirms TS output == what the running game consumes, not just == CoilSnake. GREEN.
  - **All extraction ports carry byte-for-byte parity tests vs native CoilSnake (`test/extract/*`, fixtures from `tools/dump_decomp_fixtures.py`) PLUS an end-to-end diff vs committed assets. 50 checks green.**
  - ⚠️ **CI GAP**: all extract tests are `skipIf`-guarded on ROM+fixtures (both gitignored), so they SKIP in CI → green-but-empty. The extraction port is a LOCAL gate only (run the dumper + `npm test` on a machine with EarthBound.sfc). Decide before launch: commit a tiny synthetic fixture, or make the skip loud.

**SEQUENCING DECIDED (2026-06-15): wire the finished BINARY pipeline to the browser FIRST (real end-to-end render smoke), THEN port the text/script engine.** The 3 remaining extractors (dialogue/shops/music-map) read from the `eb_project/` ccscript decompile, not raw ROM — they need EB's text/script engine ported from ROM (the single biggest piece, uncertain size). Deferred so we prove the render path in-browser first; dialogue/shops/music stay as the current Python JSON in the interim (dev-only, unchanged).

- [x] **Atlas renderer** (`src/extract/atlas.ts`) — ports `build_atlases.py`: composes minitiles + palette into 1024×1024 BG/FG atlas RGBA (pure pixel math, no canvas → runs in a Worker AND is unit-testable). Uses build_atlases' cell-bit layout (differs from arrangements.json's — both ship, different consumers; noted in-file). **Parity-proven**: `test/extract/atlas.test.ts` MD5-matches PIL-rendered atlases (incl. FG) for sampled combos. This was the missing render primitive — the map can now be drawn in-browser from a ROM.
- [x] **Sprite image render** (`renderSpriteImage` in `sprites.ts`) — index→RGBA (0 transparent). **Parity-proven** (`spriteRender.test.ts`, MD5 vs extract_sprites.py).
- [x] **Asset bundle builder** (`src/extract/bundle.ts`) — the Web Worker CORE: composes every extractor + renderer into the exact `/assets/...` file set the engine loads (map/sectors/doors/tilesets JSON + sprite images + an atlas per used combo). Pure logic, node-testable. **Proven**: `bundle.test.ts` matches committed JSON, produces an atlas for EVERY committed atlas PNG (no blank areas), a sprite per group, pixel MD5s match.
- **53 parity/integration checks green. The ENTIRE binary extraction + rendering + bundling pipeline is done and validated end-to-end against the committed game assets.**
- [x] **Browser wiring built** (additive — `:4444` dev flow untouched until a ROM is supplied): **`extract.worker.ts`** (runs buildAssetBundle off-thread), **`romCache.ts`** (IndexedDB persist), **`romAssets.ts`** (boot-prime from cache + rasterize RGBA→HTMLImageElement + ROM intake: file picker → SHA-256 verify → worker → persist → reload), **AssetLoader** `primeImageCache` hook (reuses existing json/image caches → zero type ripple), wired in `main.ts`. SHA-256 allowlist = clean US reference ROM. Typecheck 0 errors, prod build emits the worker bundle.
- [x] **SMOKE PASSED (2026-06-15)**: maintainer ran Register tab → Load ROM… → `EarthBound.sfc` extracted client-side (Worker) → cached (IndexedDB, PNG blobs ~25 MB) → reloaded → **char select + game rendered from the ROM, no errors**. End-to-end PokeMMO path proven in-browser. Two bugs fixed en route: raw-RGBA OOM (→ stream PNG blobs) and sprite-sheet ImageData dim mismatch (→ size from pixel grid; invariant test added). `__eb.romClear()` resets.
- [x] **Music map** (`src/extract/music.ts`) — ports `extract_music_map` from the ROM (MapMusicModule, asm-ptr @ 0x6939 → per-musicId entry lists in bank 0x0f; first flag-0x0 entry = default song, ≤191). **Parity-proven**: `test/extract/music.test.ts` matches committed music_map.json (165 ids).
- [x] **Text/script engine DONE** — the whole text layer now extracts from the ROM, parity-proven:
  - **`ebText.ts`** — EB text byte-decoder (CCScriptWriter port: char=`byte−0x30`, full CONTROL_CODES + `getLength`, block-end 0x02/0x0A, special bytes, compression-ref codes).
  - **`dialogue.ts`** — NPC config table read (@0xCF8985) + the eb_dialogue.py decode (jump graph, flag-eval vs world_flags, page/line split, `[15/16/17]` text-compression expansion @0x8cded, `[1C 01/02/05]`→stat/name/itemname, `{ctoarg}`/etc test-resets). **722/723 byte-exact** vs npc_text.json (the 1 is config 1091, an infinite `{inc}` loop — identical text, arbitrary cutoff).
  - **`music.ts`** — MapMusicModule (@0x6939) → music_map.json. **Parity** (165 ids).
  - **`items.ts`** — item table (@0x155000): names + full catalog (cost/type/equip slot+bonus/users).
  - **`shops.ts`** — store table (@0x1576B2) + clerk→store bytecode trace. **Full parity** vs shops.json (items/stores/npcShops).
  - All three (npc_text/shops/music_map) now produced by `buildAssetBundle` → the Worker, so the cached ROM bundle is text-complete. 56 extract checks green.
- [x] Legal cleanup — phase 1 (done 2026-06-16): `public/assets/` is now
      gitignored + untracked (`git rm --cached`, files kept on local disk for
      dev). New commits can't re-add ROM data, and a fresh CI/Render clone has no
      `public/assets/` → `vite build` can't ship it. This also covers "exclude
      from production build" (it's simply not in the repo the build clones).
- [ ] Asset cache in IndexedDB/OPFS; AssetLoader reads cache instead of HTTP
- [ ] ⚠️ **BEFORE making this repo PUBLIC** — scrub `public/assets/` from ALL git
      history (`git filter-repo --path public/assets --invert-paths`) + force-push.
      DEFERRED while the repo is private (history only leaks if it goes public /
      gets mirrored / host breached). Irreversible; rewrites shared history — run
      it deliberately (maybe in a real terminal, like the git-upgrade note). Also
      sweep `tools/_*.png` debug renders (untracked now, still in old commits).
- [ ] ⚠️ **BEFORE a PUBLIC launch** — wire a hard "supply your ROM before play"
      gate (the ROM-intake screen above). Without `public/assets/`, a deployed
      player who hasn't supplied a ROM has NO assets → broken game. Fine while
      private/dev (assets are on the maintainer's disk); a hard requirement for
      a public, code-only deploy.
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
