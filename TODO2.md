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

- [x] **Status-effect engine (server-authoritative)** — `server/status.js` (catalog + timer/immunity/DoT math, 8 unit tests) is the single source of truth, shared by actors + players. `npcSim` migrated off the ad-hoc `stunUntil` → the general `statuses` map (old "stun" → **Paralysis**, action-block + DoT in the actor loop). `gameHost` wired for **players**: a 4Hz status tick (DoT on player HP + expiry), inflicts via `damagePlayer`, clear-on-death; 3 host tests green. (Actor DoT application stays dormant until a poison-on-enemies source exists.)
- [x] **Inflict model** — every damage source carries a data-sourced inflict spec `[{type, chance}]` (element is intrinsic to the status — `status.elementOf`). On a landed, non-dodged, non-lethal hit each entry rolls `chance × target per-element vuln%` and applies the status (immunity-gated). **Weapons** supply their spec from `equip_stats.json` `inflict` (→ `gameHost.recomputeEquipStats.weaponInflict` → `handleAttack`); **enemies** from `enemyInflict()` (authored `inflict` array or `paralysisChance`, else the `ENEMY_PARALYZE_CHANCE` baseline), the SAME spec vs players and townsfolk. `status.normalizeInflict` sanitizes all authored specs. Unauthored weapon / bare hands → baseline paralysis (behavior unchanged). 5 tests in `combat.test.js`. REMAINING: PSI becomes a source once the PSI/magic system lands; per-weapon/enemy values are the "authoring" item below.
- [~] **Per-entity vulnerabilities from the ROM** — DONE: `extract_enemies.py` now parses `Paralysis / Fire / Freeze / Flash / Hypnosis-Brainshock vulnerability %` into the catalog's `vuln` block as **numbers** (canon, 100=susceptible/0=immune); `npcSim.entityVuln` reads it and **scales the paralysis proc** by the target's resist. REMAINING: scale the other elements as their statuses land (sleep/strange ← hypnosis, diamond ← flash, fire/freeze damage); **player** resist (EB gear-protection, not levels — needs community item data); and the same `vuln` read in the TS ROM-port extractor.
- [~] **Weapon / PSI inflict authoring** — DONE (weapons): the **Item Manager** now edits per-item stat overrides → `overrides/equip_stats.json` (offense/defense/crit/dodge/attackSpeed/cost/heal + a **status-inflict list editor**: status dropdown × chance%), layered over the ROM item table in `shops.js`. Enemy inflicts authorable via the Entity Manager's `inflict`/`paralysisChance` (read by `enemyInflict`). REMAINING: PSI inflict authoring (waits on the PSI system); a per-enemy `inflict` array field in the Entity Manager UI (only `paralysisChance` is surfaced there today); and server hot-reload of `equip_stats.json` (combat values currently apply on server restart).
- [~] **Status broadcast + client render** — DONE: `player_status` + `status_applied` (floating EB battle-text), AND color-coded **status pips** on the HP bars for players (local + remote) AND enemies/NPCs (new `npc_status` broadcast). REMAINING: a status SFX (the `sound(83)` sting — needs a manifest entry), and real icon art (pips are colored squares for now).
- [x] **Player-side enforcement** — action-block (paralysis/sleep/diamond) locks field input via `Player.freezeUntil`; **scramble** reverses controls; **noPsi** blocks casting (server + client gate). Every status flag now has a live consumer (block/DoT/scramble/blocksPsi/accuracyDown/fumble/breaksOnHit). REMAINING (cosmetic): a "frozen" tint on the avatar.
- [x] **Cures** — **Healing α** PSI clears ALL of the caster's statuses (`def.cures` → `status.clearAll` + broadcast); death/respawn already clears. REMAINING (refinement): per-cure granularity (Healing β = paralysis/diamond only, etc.) + curative ITEMS (Secret Herb, red springs).

### The statuses (adapted to real-time action)

Incapacitating (can't act):

- [x] **Paralyzed / "Numb"** — live end-to-end: players↔enemies inflict it on a landed hit (action-lock + post-effect immunity + "became numb!" battle text + local input-lock). REMAINING (folded into the framework items): drive the proc off each entity's **Paralysis-vulnerability %** instead of the current flat constants (`PLAYER_PARALYSIS_CHANCE` / `ENEMY_PARALYZE_CHANCE`), and a cure path.
- [x] **Asleep** — action-lock (via `blocksAction`) that **breaks when struck** (`status.breakOnHit` in `applyDamage` + `_applyHitStatuses`). Inflicted by **Hypnosis α** PSI. Battle text "fell asleep!".
- [~] **Diamondized / "Solidified"** — the EFFECT works (action-block + immunity + pip + "solidified!" text, same path as paralysis, longer/rarer). REMAINING: an inflict source (a Flash PSI / enemy) + a diamond-tint sprite.

Control-scramble (can act, but wrong) — **DONE**:

- [x] **Feeling Strange** — controls reversed (`Player.statuses` → input negated in `Player.update`); scrambled actors shuffle randomly (`jitter`) instead of aggro. Inflicted by **Brainshock α**. Battle text "feels strange!".
- [~] **Possessed (mini-ghost)** — uses the same `scramble` consumer (reversed/random). REMAINING: an inflict source + the random-action flavor.

Soft debuffs — **DONE**:

- [x] **Can't concentrate (noPsi)** — blocks ALL PSI (server `use_psi` gate + client `psiBlocked` hook + "Can't concentrate!" notify). Inflicted by **Brainshock α**.
- [x] **Crying** — accuracy down: a crying attacker whiffs (`CRY_MISS_CHANCE`, broadcast MISS). REMAINING: an inflict source (an onion-type enemy).

Damage-over-time — engine DONE (the DoT tick applies HP loss for actors + players; **Nauseous** also fumbles swings). Each just needs an inflict source (enemy attack data, authored per-entity):

- [~] **Poisoned** / **Nauseous** / **Sunstroke** / **Sniffling-Cold** — DoT + fumble consumers all live; REMAINING: which enemy attack inflicts each (Entity Manager authoring).
- [ ] **Homesick** (Ness / flavor) — periodic forced pause; low priority, no consumer yet.

### PSI animation authoring (sprite editor) — NEXT

> DESIGN LOCKED (2026-06-17): **48×48** frames, **variable** count (add/remove,
> flipbook), per-PSI **delivery** mode: `caster` (on the caster) / `target` (on
> the affected entity, Lifeup default) / `projectile` (travels caster→target —
> the "kamehameha"). Authored art → `public/overrides/psi_anim.json` (OUR data,
> shippable), keyed by PSI id from `psi.json`. Start with **Lifeup**.

- [x] **PSI catalog loader** (client) — `PsiCatalog.ts` loads `assets/map/psi.json` (52 abilities) for the editor picker + cast system.
- [x] **PSI-anim asset store** (client) — `PsiAnim.ts`: load/get/set `overrides/psi_anim.json` (`{ [psiId]: { delivery, frames: string[] } }`, 48×48 PNG data URLs).
- [x] **Sprite-editor "PSI" mode** — third mode beside char/item: ability picker (✎ marks authored ones), **variable** 48×48 frame strip (click to select, +Frame / 🗑Frame), the full shared pixel engine painting the selected frame, a **delivery** dropdown (caster/target/projectile), looping preview, autosave → `psi_anim.json`. Generalized `pixelCanvas` to a dynamic `activeBuffer()` so item + PSI share the engine; typecheck clean, server suite green.
- [x] **Procedural art for all 52 PSIs** — `tools/author_psi_anim.py` (same workflow as `author_item_sprites.py`): one effect style per family (fire/freeze/thunder/flash/stars/heal/shield/buff/hypnosis/magnet/teleport/paralysis), tier-scaled (α<β<γ<Ω), 6 frames each → `psi_anim.json`. **Placeholders to hand-polish in the editor**, NOT final artist art (flagged per the no-fabrication rule). Lifeup → `target` (heal sparkles).
- [~] **Cast/effect runtime** — DONE: `PsiFx.ts` rasterizes the authored frames + plays them in world space per delivery (caster/target spot, or projectile travel). **Server-authoritative**: `use_psi` heals the caster OR (offense PSI) the server picks the **nearest live enemy with line-of-sight in range** (`npcSim.psiStrike` → damage + knockback + XP/loot on kill), then `psi_cast` broadcasts to EVERYONE (incl. caster) with the PsiAnim id + caster/target positions so the projectile flies caster→target. **PSI Fire α** added as the first offense PSI (PP 5, dmg 14, range 240) + in the cast menu. 3 host tests. REMAINING: the `noPsi` status gate (block casting while can't-concentrate); hand-polish the 51 non-Lifeup effects in the editor; more offense PSI (Freeze/Thunder/Rockin) once tuned.
- [ ] **PSI editor polish** — dynamic EDIT-panel title (shows 48×48 in PSI mode), a status SFX, and a per-PSI "test cast" button.

### Elements (the inflict channels — from enemy config)

- [ ] **Element + vulnerability system** — Fire, **Freeze (ICE DAMAGE, NOT immobilize — naming trap: PSI Freeze does not freeze-in-place)**, Flash, Paralysis, Hypnosis/Brainshock. Each attack carries an element; both damage and status proc scale off the target's per-element vulnerability %.
- [ ] **PK Flash random-effect table** — Flash can randomly inflict paralysis / diamondize / crying / feeling-strange / instant-death (per EB). Model as a weighted roll on a Flash-element hit.

## Phase 4: Build the Game

- [ ] Real-time action combat system design doc (combat is built ahead of the doc — write it up to lock the rules)
- [~] PSI/magic system (projectiles, AoE) — canon **PSI catalog** extracted: `tools/extract_psi.py` → `public/assets/map/psi.json` (52 abilities — names/tiers/learn-levels/PP/target from `psi_ability_table` + `psi_name_table` + `battle_action_table`; e.g. Lifeup α/β/γ/Ω, PP 5/8/13/24, Ness Lv 2/20/39/70). NEXT: PSI animation authoring in the sprite editor (frames per ability, Lifeup first) → then cast/effect runtime.
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
