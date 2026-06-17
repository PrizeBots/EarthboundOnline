# EarthBound Online — TODO2 (active worklist)

> This is the **active** worklist — everything still to do. The completed archive
> lives in **TODO.md**. Top section is the current focus.

## Status Condition System (EarthBound-faithful) — NEW, current focus

> Source data (verified from the ROM 2026-06-17): `eb_project/text_misc.yml`
> (ailment list), `ccscript/data_57.ccs` (battle messages), `enemy_configuration_table.yml`
> (per-enemy vulnerability % + Initial Status), `psi_name_table.yml`
> (Paralysis / Hypnosis / Brainshock / PSI Flash / PSI Freeze).
>
> KEY FINDING: EarthBound has **no real-time "stun"** — it's turn-based. The
> "can't act" conditions are **Paralyzed (numb)**, **Diamondized (solidified)**,
> and **Asleep**. We adapt them to real-time action combat. **Knockback + a basic
> Paralysis-style freeze already shipped** (`npcSim.applyDamage` / `damagePlayer`,
> the `player_push` message, the `stunUntil`/`stunImmuneUntil` fields). This
> section grows that into the full framework where **enemies, players, and weapons
> inflict statuses on each other**.

### Framework (build first)

- [ ] **Status-effect engine (server-authoritative)** — every combatant (player, enemy, townsperson) carries a set of active statuses `{type, until, data}`. The sim tick applies each status' effect (DoT, action-block, control-scramble, debuff) and clears expired ones. Single source of truth: `npcSim` for in-sim actors, `gameHost` for players. Generalizes the current ad-hoc `stunUntil`.
- [ ] **Inflict model** — every damage source (weapon, PSI, enemy attack) carries an inflict spec `[{status, element, chance}]`. On a landed, non-dodged hit, roll `chance` against the target's per-element **vulnerability/resist**. Hooks into the existing `resolveMelee` path.
- [ ] **Per-entity vulnerabilities from the ROM** — port `enemy_configuration_table.yml`'s `Paralysis / Fire / Freeze / Flash / Hypnosis-Brainshock vulnerability %` + `Initial Status` into the enemy catalog (`enemies.json`, `extract_enemies.py` + the TS extractor, with parity). These become each entity's resist table (replaces today's flat `PLAYER_STUN_CHANCE` constant).
- [ ] **Weapon / PSI inflict authoring** — which weapon procs which status at what %, and which PSI inflicts what. Authored in the Entity Manager (entities) + item/PSI data; merges over the ROM catalog like every other stat.
- [ ] **Status broadcast + client render** — push each combatant's active statuses; client shows status icons on HP bars + EB-style floating battle text ("became numb!", "solidified!", "got poisoned!") with the `sound(83)` sting (reuse SfxEvents).
- [ ] **Player-side enforcement (the deferred piece)** — paralysis / diamond / sleep must lock the LOCAL player's input (movement/attack/PSI) for the duration; same trust model as movement. This is the `player_stun` / input-lock piece deferred from the knockback+stun work.
- [ ] **Cures** — items + PSI clear statuses per EB (Healing β+ → paralysis & diamond; Secret Herb → most; red springs; Refreshing Herb; hospital). Death/respawn clears all. Map each cure → the statuses it removes.

### The statuses (adapted to real-time action)

Incapacitating (can't act):

- [ ] **Paralyzed / "Numb"** — real-time action lock. This is what our shipped "stun" becomes: rename it and drive the proc off each entity's **Paralysis-vulnerability %**. Battle text "body became numb!" / "suddenly could not move!". Cured by Healing β+, Secret Herb, red springs, or timeout.
- [ ] **Diamondized / "Solidified"** — hard CC, longer + rarer than paralysis: immobile, diamond-tinted sprite. Needs a cure (Healing γ / Cup of Lifenoodles / Secret Herb) or a long timeout. (EB's whole-party-diamondized = game over has no MMO analog — skip it.) Battle text "body solidified!".
- [ ] **Asleep** — action lock that **breaks when the victim takes a hit** (or times out). From the Hypnosis / Brainshock element. Battle text "fell asleep!".

Control-scramble (can act, but wrong):

- [ ] **Feeling Strange / Mushroomized** — invert/scramble movement + auto-target for a duration; Mushroomized also plants the mushroom-on-head sprite and lasts much longer. Battle text "began to feel strange!".
- [ ] **Possessed (mini-ghost)** — periodic random action / movement override. Battle text "possessed by a mini-ghost!".

Soft debuffs:

- [ ] **Can't concentrate** — PSI disabled for a duration. Battle text "could not use PSI!".
- [ ] **Crying** — accuracy / hit-rate down. Battle text "could not stop crying!".

Damage-over-time:

- [ ] **Poisoned** — HP ticks down over time. "got poisoned!".
- [ ] **Nauseous** — DoT + chance to fumble an action. "felt somewhat nauseous...".
- [ ] **Sunstroke** — heat DoT variant.
- [ ] **Sniffling / Cold** — cold DoT variant. "caught a cold!".
- [ ] **Homesick** (Ness / flavor) — periodic forced pause / morale dip; low priority.

### Elements (the inflict channels — from enemy config)

- [ ] **Element + vulnerability system** — Fire, **Freeze (ICE DAMAGE, NOT immobilize — naming trap: PSI Freeze does not freeze-in-place)**, Flash, Paralysis, Hypnosis/Brainshock. Each attack carries an element; both damage and status proc scale off the target's per-element vulnerability %.
- [ ] **PK Flash random-effect table** — Flash can randomly inflict paralysis / diamondize / crying / feeling-strange / instant-death (per EB). Model as a weighted roll on a Flash-element hit.

## Phase 4: Build the Game

- [ ] Real-time action combat system design doc (combat is built ahead of the doc — write it up to lock the rules)
- [ ] PSI/magic system (projectiles, AoE)
- [~] Inventory + equipment system — Goods (buy/use/sell, server-authoritative) + full ROM item table extracted (offense/defense/slot/who-can-equip → `extract_shops.py`). **Equipment**: EB 4-slot screen (Weapon/Body/Arms/Other) + a 2-slot quick-select hotbar; equipped **weapon offense → attack damage**, **armor defense → damage taken** (`Equipment.ts` mirror, server-authoritative per-slot equip). Inventory/money/equipped gear now **persist** (per-character save). TODO: armor types beyond offense/defense (status resist, etc.), more hotbar slots, and **hotbar persistence** (the 2 quick-slots are still client-only/in-memory). DEV: a Cracked bat is granted on join for testing (`server/shops.js` — remove before launch)
- [~] Custom sprites for combat animations — player attack/hurt bands done (SpriteEditor); enemy bands still need the NPC Sprite Animator
- [~] Sound effects / music integration — music PLAYS, but region triggers come from the ROM's per-sector musicId, which the door-stitched world often gets wrong. Fix is authoring-driven: the **Sound Manager** editor tool (`overrides/music.json` areas win over the sector lookup). Still to do: author correct regions across the map, then SFX (hit/attack/etc.)

## Dev Editor Tools (in-engine authoring layer — full checklist in EDITOR_TOOLS.md)

Dev-only, never shipped (Vite-middleware save channel; excluded from prod build).
Detailed status lives in **EDITOR_TOOLS.md**.

- [ ] NPC Sprite Animator (authored attack/hurt/diagonal bands per enemy group, gated on combat)
- [ ] Phase-1 pipeline hardening: push `extract_npcs` / `apply_map_changes` / doors / dialogue generators to ~99% before deepening matching editors

## Pre-Launch: User-Supplied ROM Architecture (PokeMMO model — REQUIRED before going live)

Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution". The full binary + text extraction pipeline is DONE and
parity-proven (see TODO.md "Completed"); what remains is the launch-gating glue.

- [ ] ROM intake screen before character select (file picker, checksum-verify known dumps, ROM never uploaded)
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
- [ ] ⚠️ **CI GAP**: all extract tests are `skipIf`-guarded on ROM+fixtures (both gitignored), so they SKIP in CI → green-but-empty. The extraction port is a LOCAL gate only (run the dumper + `npm test` on a machine with EarthBound.sfc). Decide before launch: commit a tiny synthetic fixture, or make the skip loud.

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
- [ ] Real backend for saves + auth — DECIDED: **SQLite in the Node server now** (swappable `Store` interface) → **migrate to Supabase/Postgres at MVP launch** (no paid infra until then). The custom Node game server stays for the real-time world (Supabase can't run the authoritative sim). See **Main Start Screen + Accounts** (TODO.md) + START_SCREEN.md.

## Dev Tooling & Quality Gates

- [ ] **Drop `--no-stash` from `.husky/pre-commit`** once git is upgraded. Current git is 2.31.1 (2021); its lint-staged backup-stash is broken ("Needed a single revision"), so the hook runs `lint-staged --no-stash`. After upgrading to git ≥2.35 (run `winget install --id Git.Git -e` in a normal terminal, NOT inside Claude Code — the installer needs admin + to close Git Bash), remove `--no-stash` to regain the auto-backup safety net.
- [ ] Add Zod schemas for the other hand-edited overrides (doors, collision, npcs, dialogue, item_sprites…) — only `enemy_spawns.json` is validated so far
- [ ] `idb`/Dexie for IndexedDB asset caching — feature-driven; pick up when the client-side ROM-extraction Web Worker starts (see Pre-Launch section)

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
- [ ] Knockback + stun tuning pass — knockback distance + stun frequency/duration are best felt in-game; nudge the `KB_*` / `STUN_*` constants in `npcSim.js` after a playtest. (Knockback + basic stun already shipped; this is polish, folded into the Status System above as it matures.)
- [ ] Player settings screen — selectable chat font (default: regular EB font; Mr. Saturn font as a fun option via ChatManager.setChatFont)
- [ ] Build visual sprite catalog (HTML page showing all 463 groups with IDs)
- [ ] Map editor in browser
- [ ] Party system (follow the leader)
- [ ] PvP zones
- [ ] Trading system
- [ ] World events / boss encounters
- [ ] Mobile touch controls for browser version
