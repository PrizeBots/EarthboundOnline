# 199X — TODO (roadmap)

> The single roadmap. **Real to-dos live up top; everything shipped is archived at
> the bottom** (see "✅ Shipped / Completed"). _(Consolidated 2026-06-30 from the
> old `TODO2.md` active list + `TODO_archived.md` done-log into this one file.)_

## Status Condition System (EarthBound-faithful) — current focus

> Source data (verified from the ROM 2026-06-17): `eb_project/text_misc.yml`
> (ailment list), `ccscript/data_57.ccs` (battle messages), `enemy_configuration_table.yml`
> (per-enemy vulnerability % + Initial Status), `psi_name_table.yml`
> (Paralysis / Hypnosis / Brainshock / PSI Flash / PSI Freeze).
>
> KEY FINDING: EarthBound has **no real-time "stun"** — it's turn-based. The
> "can't act" conditions are **Paralyzed (numb)**, **Diamondized (solidified)**,
> and **Asleep**. We adapt them to real-time action combat. The framework, the
> incapacitating/scramble/soft-debuff statuses, paralysis/sleep/strange/noPsi/
> crying, and player-side enforcement have **all shipped** (archived below). What
> remains is per-entity tuning from the ROM, more inflict sources, and the
> element-channel layer.

### Framework — remaining

- [~] **Per-entity vulnerabilities from the ROM** — DONE: `extract_enemies.py` now parses `Paralysis / Fire / Freeze / Flash / Hypnosis-Brainshock vulnerability %` into the catalog's `vuln` block as **numbers** (canon, 100=susceptible/0=immune); `npcSim.entityVuln` reads it and **scales the paralysis proc** by the target's resist. REMAINING: scale the other elements as their statuses land (sleep/strange ← hypnosis, diamond ← flash, fire/freeze damage); **player** resist (EB gear-protection, not levels — needs community item data); and the same `vuln` read in the TS ROM-port extractor.
- [~] **Weapon / PSI inflict authoring** — DONE (weapons): the **Item Manager** now edits per-item stat overrides → `overrides/equip_stats.json` (offense/defense/crit/dodge/attackSpeed/cost/heal + a **status-inflict list editor**: status dropdown × chance%), layered over the ROM item table in `shops.js`. Enemy inflicts authorable via the Entity Manager's `inflict`/`paralysisChance` (read by `enemyInflict`). REMAINING: PSI inflict authoring (waits on the PSI system); a per-enemy `inflict` array field in the Entity Manager UI (only `paralysisChance` is surfaced there today); and server hot-reload of `equip_stats.json` (combat values currently apply on server restart).
- [~] **Status broadcast + client render** — DONE: `player_status` + `status_applied` (floating EB battle-text), AND color-coded **status pips** on the HP bars for players (local + remote) AND enemies/NPCs (new `npc_status` broadcast). REMAINING: a status SFX (the `sound(83)` sting — needs a manifest entry), and real icon art (pips are colored squares for now).

### The statuses — remaining

Incapacitating (can't act):

- [~] **Diamondized / "Solidified"** — the EFFECT works (action-block + immunity + pip + "solidified!" text, same path as paralysis, longer/rarer). REMAINING: an inflict source (a Flash PSI / enemy) + a diamond-tint sprite.

Control-scramble (can act, but wrong):

- [~] **Possessed (mini-ghost)** — uses the same `scramble` consumer (reversed/random). REMAINING: an inflict source + the random-action flavor.

Damage-over-time — engine DONE (the DoT tick applies HP loss for actors + players; **Nauseous** also fumbles swings). Each just needs an inflict source (enemy attack data, authored per-entity):

- [~] **Poisoned** / **Nauseous** / **Sunstroke** / **Sniffling-Cold** — DoT + fumble consumers all live; REMAINING: which enemy attack inflicts each (Entity Manager authoring).
- [ ] **Homesick** (Ness / flavor) — periodic forced pause; low priority, no consumer yet.

### PSI animation authoring (sprite editor) — remaining

> DESIGN LOCKED (2026-06-17): **48×48** frames, **variable** count (add/remove,
> flipbook), per-PSI **delivery** mode: `caster` (on the caster) / `target` (on
> the affected entity, Lifeup default) / `projectile` (travels caster→target —
> the "kamehameha"). Authored art → `public/overrides/psi_anim.json` (OUR data,
> shippable), keyed by PSI id from `psi.json`. Catalog loader, asset store,
> sprite-editor PSI mode, and procedural placeholder art for all 52 have shipped
> (archived below); what's left is runtime polish + more offense PSI.

- [~] **Cast/effect runtime** — DONE: `PsiFx.ts` rasterizes the authored frames + plays them in world space per delivery (caster/target spot, or projectile travel). **Server-authoritative**: `use_psi` heals the caster OR (offense PSI) the server picks the **nearest live enemy with line-of-sight in range** (`npcSim.psiStrike` → damage + knockback + XP/loot on kill), then `psi_cast` broadcasts to EVERYONE (incl. caster) with the PsiAnim id + caster/target positions so the projectile flies caster→target. **PSI Fire α** added as the first offense PSI (PP 5, dmg 14, range 240) + in the cast menu. 3 host tests. REMAINING: hand-polish the 51 non-Lifeup effects in the editor; more offense PSI (Freeze/Thunder/Rockin) once tuned. (The `noPsi` gate already shipped.)
- [ ] **PSI editor polish** — dynamic EDIT-panel title (shows 48×48 in PSI mode), a status SFX, and a per-PSI "test cast" button.

### Elements (the inflict channels — from enemy config)

- [ ] **Element + vulnerability system** — Fire, **Freeze (ICE DAMAGE, NOT immobilize — naming trap: PSI Freeze does not freeze-in-place)**, Flash, Paralysis, Hypnosis/Brainshock. Each attack carries an element; both damage and status proc scale off the target's per-element vulnerability %.
- [ ] **PK Flash random-effect table** — Flash can randomly inflict paralysis / diamondize / crying / feeling-strange / instant-death (per EB). Model as a weighted roll on a Flash-element hit.

## Phase 4: Build the Game

- [ ] Real-time action combat system design doc (combat is built ahead of the doc — write it up to lock the rules)
- [ ] **PSI learn / level gate** — every PSI family is currently castable by every player (no gate; see `layout.ts:161` comment). Wire abilities to character level + the Mental stat (each `psi.json` ability already has a learn-level). DEV convenience now; a real gate before launch.
- [~] PSI/magic system (projectiles, AoE) — canon **PSI catalog** extracted: `tools/extract_psi.py` → `public/assets/map/psi.json` (52 abilities — names/tiers/learn-levels/PP/target from `psi_ability_table` + `psi_name_table` + `battle_action_table`; e.g. Lifeup α/β/γ/Ω, PP 5/8/13/24, Ness Lv 2/20/39/70). Catalog + anim authoring + cast/effect runtime shipped; NEXT: more offense PSI + AoE shapes + the learn gate above.
- [~] Inventory + equipment system — Goods (buy/use/sell, server-authoritative) + full ROM item table extracted (offense/defense/slot/who-can-equip → `extract_shops.py`). **Equipment**: EB 4-slot screen (Weapon/Body/Arms/Other) + a 2-slot quick-select hotbar; equipped **weapon offense → attack damage**, **armor defense → damage taken** (`Equipment.ts` mirror, server-authoritative per-slot equip). Inventory/money/equipped gear + the hotbar now **persist** (per-character save). TODO: armor types beyond offense/defense (status resist, etc.), more hotbar slots.
- [~] Custom sprites for combat animations — player attack/hurt bands done (SpriteEditor); enemy bands still need the NPC Sprite Animator
- [~] Sound effects / music integration — music PLAYS, but region triggers come from the ROM's per-sector musicId, which the door-stitched world often gets wrong. Fix is authoring-driven: the **Sound Manager** editor tool (`overrides/music.json` areas win over the sector lookup). Still to do: author correct regions across the map, then SFX (hit/attack/etc.)

> **Build parity / stat design** for Phase 4 lives in **ABILITIES.md** (the 5-stat
> ladders, the parity math, the open decisions like PSI power scaling + respec).

## Dev Editor Tools (in-engine authoring layer — full checklist in EDITOR_TOOLS.md)

Dev-only, never shipped (Vite-middleware save channel; excluded from prod build).
Detailed status lives in **EDITOR_TOOLS.md**.

- [ ] NPC Sprite Animator (authored attack/hurt/diagonal bands per enemy group, gated on combat)
- [ ] Per-entity `mass` override field in the Entity Manager — `npcSim` weight-class push reads a `mass` value but it's not authorable yet (`npcSim.js:117`); surface it like `paralysisChance`.
- [ ] Phase-1 pipeline hardening: push `extract_npcs` / `apply_map_changes` / doors / dialogue generators to ~99% before deepening matching editors

## Room System refactor — Phases 4–6 remaining (full plan in ROOM_SYSTEM.md)

Phases 0–3 LANDED (one merged room registry, 505 region rooms seeded from music,
music folded onto room `bgm`). Remaining feature builds:

- [ ] **Phase 4** — Shop/Hospital binding (`shop.storeId` opens the store; hospital heal flow)
- [ ] **Phase 5** — Hotel sleep sequence (first data-driven script: sleep→heal→warp→wake)
- [ ] **Phase 6** — Scripting generalization (lift the hotel sequence into reusable script steps wired to FlagTriggers/EventBus)

## Live Ops: observe + live-edit the prod world from the editor — DESIGN PARKED (2026-06-18)

> Goal (maintainer ask): from the localhost editor, **toggle between the local-dev
> server and the live prod server**, observe the running prod world, AND make
> changes (start with enemy spawners) that take effect in **real time for all
> connected prod players**. Not needed right now — parked with the design so it can
> be picked up cleanly.
>
> Context gathered while scoping: WS URL is same-origin only (`Network.ts:229`,
> `openSocket()`); ALL account/save HTTP goes through one `fetch` in `Auth.ts:65`
> (`/api/*`); assets/overrides/world-docs load locally and should STAY local. The
> editor is dev-only (F2 / `__eb.admin`), localStorage is the persistence idiom
> (mirror `MuteButton.ts` / `Auth.ts`). Prod URL is NOT in the repo — supply it
> (Render hostname, e.g. `https://earthbound-online.onrender.com`). The `world_docs`
> Supabase table already exists and is the natural home for live-editable content.

### Phase 0 — Observe toggle (small, no security weight)

- [ ] Editor HUD toggle (mirror the **Reload** toggle pattern, `EditorShell.ts:997`)
      switching the active backend **dev ↔ prod**, stored in localStorage, applied
      on a page reload (cleanest — boot-time `connect()` re-reads it).
- [ ] Central "active server" module (`serverTarget.ts`): `apiBase()` + `wsUrl()`.
      `Network.openSocket` uses `wsUrl()`; `Auth.api()` prefixes **auth/character**
      calls (NOT world-docs, NOT assets) with `apiBase()`.
- [ ] **Per-server session token** namespacing (`eb_session` vs `eb_session_prod`)
      so the dev and prod logins coexist instead of clobbering each other.
- [ ] **Localhost-only CORS allow** on the prod server's `/api/*` (so the dev page
      can call prod auth). WS already cross-connects (no CORS). Gate to `localhost`
      origins only — zero effect on real prod users.
- [ ] You join prod as one of YOUR prod characters; you see players near you
      (area-of-interest), with editor overlays on top.

### Phase 1 — Live spawners (the vertical slice; HAS security weight)

- [ ] **Admin identity on prod — DECISION PENDING.** Today there is NO admin layer
      (editor is only localhost-gated). Options weighed: (A) **username allowlist via
      env `ADMIN_USERNAMES`** on Render — recommended for v1, no migration, tied to a
      real account; (B) `accounts.is_admin` column (migration, scales to roles);
      (C) shared `ADMIN_KEY` env secret (simplest, but not identity-bound — least
      recommended). **Pick A/B/C before building Phase 1.**
- [ ] Live-editable spawn content in **Supabase** (extend `world_docs`, e.g. an
      `enemy_spawns` doc) that the prod server reads at boot AND can mutate at
      runtime — instead of the baked-in deployed override file.
- [ ] **Admin write API on prod** behind a `requireAdmin` gate:
      `POST /api/admin/spawner`, `DELETE /api/admin/spawner/:id` → validate → persist
      to Supabase → apply to the live sim. (Same localhost CORS allow.)
- [ ] **Runtime apply + broadcast**: GameHost/npcSim methods to add/remove a spawner
      live, spawn the enemy now, and push it to every connected client (reuse the
      existing enemy-spawn broadcast — clients already render server-driven enemies,
      so little/no client change).
- [ ] Editor's **EnemySpawnerTool**: when toggled to prod, send edits to the prod
      admin API instead of `/__editor/save`. Local mode unchanged.

### Phase 2 — Generalize

- [ ] Same admin-write + live-apply pattern for NPCs, items, dialogue, Places.
- [ ] Proper roles/audit log; revoke path; rate-limit admin endpoints.

### Security notes (do not skip at build time)

- A compromised admin = whoever can rewrite the live world. Keep the admin set
  tiny, validate every payload server-side, never trust client-sent geometry.
- Admin endpoints: auth-gated + localhost-CORS only + input-validated + logged.
- Editor content WRITES stay local in dev mode; prod writes ONLY via the admin API
  (never re-enable the loopback `editorApi` on the deploy server).

## Pre-Launch: User-Supplied ROM Architecture (PokeMMO model — REQUIRED before going live)

Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution". The full binary + text extraction pipeline is DONE and
parity-proven (see the archive below); what remains is the launch-gating glue.

- [ ] ROM intake screen before character select (file picker, checksum-verify known dumps, ROM never uploaded)
- [ ] Asset cache in IndexedDB/OPFS; AssetLoader reads cache instead of HTTP
- [ ] **Accept the full known-dump set** in `romAssets.ts` once the worker applies the IPS fixes (`src/extract/romAssets.ts:22` — only the base dump is accepted today)
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

### Dev-only shims to STRIP before a public launch

Convenience hacks that are fine in private/dev but must be removed/gated before
real players join:

- [ ] **Guest auto-login on the Start screen** — `StartScreen.ts:139` (`import.meta.env.DEV`): START signs into a throwaway guest account and jumps straight to the character creator (no name/pass/ROM). Compiled out of prod today, but confirm the real sign-in path is the only one live before launch.
- [ ] **Cracked bat granted on join** — `server/shops.js` grants a test weapon to every new player. Remove.
- [ ] **Every PSI castable by everyone** — folded into the **PSI learn / level gate** to-do under Phase 4.

## Phase 3: Game Server (Production)

- [~] Move game server to standalone Node process (separate from Vite) — host
  logic is now unified in `GameHost` (`server/gameHost.js`); `server/index.js`
  (standalone) and `vite.config.ts` are thin transports over it. Remaining: make
  the standalone process the dev runtime too (proxy Vite HMR) so there's one
  server everywhere, not just one code path.
- [ ] Persistent world state (player positions survive server restart)
- [ ] **Wire the phone "Save" command to real persistence** — `MenuManager.ts:1200` `saveGame()` is a STUB (acknowledges only). Inventory/money/gear/hotbar already auto-persist per-character; this is the explicit player-facing save point.
- [ ] Area-of-interest filtering (only send updates for nearby players) — IN PROGRESS, tracked in **NETWORK_REMODEL.md** (AOI shipped behind `AOI_ENABLED`, on by default)
- [ ] Binary protocol (replace JSON with packed messages for bandwidth) — IN PROGRESS, **NETWORK_REMODEL.md** (binary + delta wire format landed behind `BINARY_WIRE`)
- [ ] Server tick rate control (fixed 20Hz or 30Hz update loop)
- [ ] Authentication — DONE via **Main Start Screen + Accounts** (own username/password, `bcryptjs`; see the archive below + ARCHITECTURE.md persistence). OAuth/magic-link reframed as a _later_ "claim your account" upgrade, not the first auth.
- [ ] Real backend for saves + auth — DONE: **SQLite in the Node server** (swappable `Store` interface) → **Supabase/Postgres at MVP launch** (`SUPABASE_SETUP.md`). The custom Node game server stays for the real-time world (Supabase can't run the authoritative sim). See **Main Start Screen + Accounts** in the archive below.

## Dev Tooling & Quality Gates

- [ ] **Drop `--no-stash` from `.husky/pre-commit`** once git is upgraded. Current git is 2.31.1 (2021); its lint-staged backup-stash is broken ("Needed a single revision"), so the hook runs `lint-staged --no-stash`. After upgrading to git ≥2.35 (run `winget install --id Git.Git -e` in a normal terminal, NOT inside Claude Code — the installer needs admin + to close Git Bash), remove `--no-stash` to regain the auto-backup safety net.
- [ ] Add Zod schemas for the other hand-edited overrides (doors, collision, npcs, dialogue, item_sprites…) — only `enemy_spawns.json` is validated so far
- [ ] `idb`/Dexie for IndexedDB asset caching — feature-driven; pick up when the client-side ROM-extraction Web Worker starts (see Pre-Launch section)
- [ ] **Reuse UI components across the codebase — don't re-implement.** Standing rule: before building a panel/widget, check for an existing one. Known duplication to consolidate: **floating draggable/resizable windows** — `src/editor/FloatingPanel.ts` (new, viewport-`fixed`, exported/decoupled) vs the Sprite Editor's private `makeFloating` (`src/engine/spriteEditor/dom.ts`, `absolute` within `S.overlay`, own layout store). Migrate `makeFloating` onto `FloatingPanel` so there's ONE implementation. Also audit other repeated widgets (FolderDesktop galleries, `createSpritePicker`, mkBtn/mkRow helpers duplicated per tool) and hoist shared ones.

## Backlog: Hardware Track (out of scope for now)

The SNES ROM + ESP32 port is a long-term ambition, not part of the current project.
Engine code should still be written to port cleanly (see CLAUDE.md Architecture).

- [ ] ROM build pipeline (PVSnesLib): toolchain, hello-world boot, asset converters (4bpp tiles, map), Mode 1 tile renderer, movement/camera/collision on SNES, `npm run build:rom`
- [ ] ESP32 co-processor: firmware, SPI/UART protocol, TXS0108E level-shifter bridge, 3D-printed controller-port housing, WiFi → game server link, `npm run flash:esp`
- [ ] Real hardware integration: boot on real SNES, multiplayer state via ESP32, latency testing, multi-console stress test

## Backlog / Ideas

- [~] **Tile animation system** — EB has TWO systems; both wired into the per-frame-atlas
  - `anim.json` pipeline (build_atlases bakes `{key}_f{k}.png`, `TilesetManager` swaps on a
    clock). DONE: **palette cycling** — all 8 Flash-Effect combos (`tools/palette_anim.py`,
    water/lava/the 29_3 palette). DONE: **tile-graphic animation** frame source FOUND —
    `MAP_DATA_TILE_ANIMATION_PTR_TABLE` (file `0x2F11CB`) → compressed 256-minitile buffer
    per tileset (EB's $7EC000), decoded by `tile_anim.anim_graphics`; the properties' src/dst
    index into it (frame 0 == live minitiles at rest, later frames scrolled). `build_atlases`
    draws frames from it; **dept-store escalators enabled** (`ESCALATOR_DRAW_TS={12,13}`,
    Twoson + Fourside). REMAINING: enable the water/waterfall tilesets (0,1,5,6,7,8,16,17,18,19)
    — same mechanism, just add to `ESCALATOR_DRAW_TS` and check in-game (some target the FG
    layer; verify before shipping). Combos using BOTH systems (Fourside 29_3/29_4) already
    merge to lcm(frames) with the tile delay.
- [ ] Knockback + stun tuning pass — knockback distance + stun frequency/duration are best felt in-game; nudge the `KB_*` / `STUN_*` constants in `npcSim.js` after a playtest. (Knockback + basic stun already shipped; this is polish, folded into the Status System above as it matures.)
- [ ] Player settings screen — selectable chat font (default: regular EB font; Mr. Saturn font as a fun option via ChatManager.setChatFont)
- [ ] Build visual sprite catalog (HTML page showing all 463 groups with IDs)
- [ ] Map editor in browser
- [ ] Party system (follow the leader)
- [ ] PvP zones
- [ ] Trading system
- [ ] World events / boss encounters
- [ ] **Contested Zones (town territory control)** — enemy-held city spots players
      clear/capture; world-shared PvE; owner state is just a FLAG that doors/vendors/story/
      spawns react to (loose coupling); decay loop back to enemy control = living map, not
      one-time content. Full design in **CONTESTED_ZONES.md**. Leans on flag system + Event
      Manager state machine + enemy spawners + loot/banking + room=shard. (Riffed 2026-06-30.)

---

# ✅ Shipped / Completed (archive)

> The done log. Kept verbatim (incl. minor REMAINING refinement notes) for history,
> grouped by the section the work came from.

## Status Condition System — Framework (shipped)

- [x] **Status-effect engine (server-authoritative)** — `server/status.js` (catalog + timer/immunity/DoT math, 8 unit tests) is the single source of truth, shared by actors + players. `npcSim` migrated off the ad-hoc `stunUntil` → the general `statuses` map (old "stun" → **Paralysis**, action-block + DoT in the actor loop). `gameHost` wired for **players**: a 4Hz status tick (DoT on player HP + expiry), inflicts via `damagePlayer`, clear-on-death; 3 host tests green. (Actor DoT application stays dormant until a poison-on-enemies source exists.)
- [x] **Inflict model** — every damage source carries a data-sourced inflict spec `[{type, chance}]` (element is intrinsic to the status — `status.elementOf`). On a landed, non-dodged, non-lethal hit each entry rolls `chance × target per-element vuln%` and applies the status (immunity-gated). **Weapons** supply their spec from `equip_stats.json` `inflict` (→ `gameHost.recomputeEquipStats.weaponInflict` → `handleAttack`); **enemies** from `enemyInflict()` (authored `inflict` array or `paralysisChance`, else the `ENEMY_PARALYZE_CHANCE` baseline), the SAME spec vs players and townsfolk. `status.normalizeInflict` sanitizes all authored specs. Unauthored weapon / bare hands → baseline paralysis (behavior unchanged). 5 tests in `combat.test.js`.
- [x] **Player-side enforcement** — action-block (paralysis/sleep/diamond) locks field input via `Player.freezeUntil`; **scramble** reverses controls; **noPsi** blocks casting (server + client gate). Every status flag now has a live consumer (block/DoT/scramble/blocksPsi/accuracyDown/fumble/breaksOnHit). REMAINING (cosmetic): a "frozen" tint on the avatar.
- [x] **Cures** — **Healing α** PSI clears ALL of the caster's statuses (`def.cures` → `status.clearAll` + broadcast); death/respawn already clears. REMAINING (refinement): per-cure granularity (Healing β = paralysis/diamond only, etc.) + curative ITEMS (Secret Herb, red springs).

## Status Condition System — The statuses (shipped)

- [x] **Paralyzed / "Numb"** — live end-to-end: players↔enemies inflict it on a landed hit (action-lock + post-effect immunity + "became numb!" battle text + local input-lock). REMAINING (folded into the framework items): drive the proc off each entity's **Paralysis-vulnerability %** instead of the current flat constants (`PLAYER_PARALYSIS_CHANCE` / `ENEMY_PARALYZE_CHANCE`), and a cure path.
- [x] **Asleep** — action-lock (via `blocksAction`) that **breaks when struck** (`status.breakOnHit` in `applyDamage` + `_applyHitStatuses`). Inflicted by **Hypnosis α** PSI. Battle text "fell asleep!".
- [x] **Feeling Strange** — controls reversed (`Player.statuses` → input negated in `Player.update`); scrambled actors shuffle randomly (`jitter`) instead of aggro. Inflicted by **Brainshock α**. Battle text "feels strange!".
- [x] **Can't concentrate (noPsi)** — blocks ALL PSI (server `use_psi` gate + client `psiBlocked` hook + "Can't concentrate!" notify). Inflicted by **Brainshock α**.
- [x] **Crying** — accuracy down: a crying attacker whiffs (`CRY_MISS_CHANCE`, broadcast MISS). REMAINING: an inflict source (an onion-type enemy).

## Status Condition System — PSI animation authoring (shipped)

- [x] **PSI catalog loader** (client) — `PsiCatalog.ts` loads `assets/map/psi.json` (52 abilities) for the editor picker + cast system.
- [x] **PSI-anim asset store** (client) — `PsiAnim.ts`: load/get/set `overrides/psi_anim.json` (`{ [psiId]: { delivery, frames: string[] } }`, 48×48 PNG data URLs).
- [x] **Sprite-editor "PSI" mode** — third mode beside char/item: ability picker (✎ marks authored ones), **variable** 48×48 frame strip (click to select, +Frame / 🗑Frame), the full shared pixel engine painting the selected frame, a **delivery** dropdown (caster/target/projectile), looping preview, autosave → `psi_anim.json`. Generalized `pixelCanvas` to a dynamic `activeBuffer()` so item + PSI share the engine; typecheck clean, server suite green.
- [x] **Procedural art for all 52 PSIs** — `tools/author_psi_anim.py` (same workflow as `author_item_sprites.py`): one effect style per family (fire/freeze/thunder/flash/stars/heal/shield/buff/hypnosis/magnet/teleport/paralysis), tier-scaled (α<β<γ<Ω), 6 frames each → `psi_anim.json`. **Placeholders to hand-polish in the editor**, NOT final artist art (flagged per the no-fabrication rule). Lifeup → `target` (heal sparkles).

## Phase 4: Build the Game — done so far

- [x] Knockback + basic stun (combat hit-reactions) — server-authoritative in `npcSim.applyDamage` / `damagePlayer`: every landed hit shoves the victim away from the attacker (damage-scaled, collision-clamped; players via the new `player_push` message), and a % proc freezes in-sim actors with a capped/diminishing immunity window (`stunUntil`/`stunImmuneUntil`). Player-stun (input-lock) + the full EB status system are the next step (see "Status Condition System" up top).
- [x] Hitbox/hurtbox system (server-authoritative — `npcSim.handleAttack`: directional attack box vs enemy hurtboxes; enemy swing box vs player)
- [x] Basic melee attack (bat swing) — player swing deals `ATTACK_DAMAGE`, enemies flinch/die/respawn; attack/hurt poses synced over the wire
- [x] Enemy AI (aggro range, chase, attack) — `npcSim` roamers detect within `DETECT_RANGE`, chase at `chaseSpeed`, swing on cooldown; per-spawner damage/rate/speed/level
- [x] Health/damage system — server-authoritative HP for enemies AND players (`onPlayerHp`/`onPlayerRespawn`, `player_hp`/`player_respawn` msgs), death + respawn, floating damage numbers (Emitter)
- [x] Experience/leveling — per-spawner **XP** (Enemy Spawner editor) → server-authoritative EXP-on-kill + level-up (geometric curve `30·1.5^(lvl-1)`; HP/offense/defense wired into combat). Level-up auto-grows **only maxHp** (survival drip) + banks a skill point — offense/defense/speed/etc. grow by SPENDING points on the pentagon, not automatically; all 7 stats display. Pushed to client via `player_stats` → StatusModal. **Persists** now (per-character save: level/exp/all stats survive rejoin)
- [x] Ground loot + banking — first-touch ground drops + ATM/bank money model (now documented in ARCHITECTURE.md "Loot" + "Loot banking"). Dad's phone call reports money banked / spent since the last call (`dad_call` → `dad_report`).

## Dev Editor Tools (in-engine authoring layer — full checklist in EDITOR_TOOLS.md) — done

Dev-only, never shipped (Vite-middleware save channel; excluded from prod build).

- [x] Editor Shell foundation (F2 / `window.__eb.admin()`): free-fly camera + zoom, cursor readout HUD, grid overlays, undo/redo, dirty tracking, save channel, Location Navigator
- [x] Admin Hub (tool registry, launch/back, save-all, jump-to-coords)
- [x] Placement Editor — NPCs (ghosts, drag/snap, add/delete, sprite/dir/kind/dialogue edit), Spawn point (config-driven via `overrides/spawn.json`), Doors/warps (`overrides/doors.json`; `ZONE_DOOR_OVERRIDES` migrated into data)
- [x] Collision & Priority Painter (per-arrangement byte brushes, live room-crop preview, `overrides/collision.json`)
- [x] Enemy Spawner Editor (place/configure enemy spawn points — sprite, roam radius, rate, max, hp; walkable/street-connected guard; `overrides/enemy_spawns.json`, hot-reloaded client+server)
- [x] Sound Manager (draw rectangular music trigger areas + assign/audition a song; `overrides/music.json` wins over the ROM's per-sector musicId in MusicManager; sector-grid snap; fixes wrong-music spots from door-stitching) + SFX tab (event→sound assignment) with a header Stop-all button
- [x] Dialogue Editor (search/edit textId pages, EB-window live preview, NPC ref counts, `overrides/dialogue.json` merged over npc_text.json; **"Dialogue ✎"** on an NPC mints + links a fresh textId and opens the editor — full place-NPC→author flow). Deferred: ccscript flag-conditionals/branches
- [x] Save-Back Channel (`/__editor/save` Vite middleware, allow-list, atomic write + `.bak`, runtime merge in loaders)
- [x] Room System Phases 0–3 (merged room registry, 505 region rooms seeded from music, music folded onto room `bgm`; Room Manager tool) — full record in ROOM_SYSTEM.md

## Pre-Launch: User-Supplied ROM Architecture — extraction pipeline done

Goal: we distribute zero ROM-derived data; every player supplies their own
EarthBound ROM and all assets are extracted in their browser. See CLAUDE.md
"ROM & Asset Distribution". **Approach DECIDED (2026-06-15): full TypeScript
rewrite of the extraction + bake steps (NOT Pyodide/WASM).** The binary + text
extraction pipeline below is DONE and parity-proven; the remaining launch-gating
glue (intake screen, cache-backed AssetLoader, history scrub, deploy) lives in the
Pre-Launch section up top.

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

## Main Start Screen + Accounts ✅

True title screen: **START** + **CONTINUE**. Username/password accounts (our own,
`bcryptjs`); each account holds up to **3 character saves**. Storage: SQLite in the
Node server → Supabase/Postgres at MVP launch (operator guide: **SUPABASE_SETUP.md**;
persistence + Store contract documented in **ARCHITECTURE.md**). This feature
**absorbed the Phase 4 Save System** (CONTINUE needs persistence).

- [x] `Store` interface + `SqliteStore` (`better-sqlite3`) + schema/migrations (accounts, sessions, characters) — `server/store/` (contract in `index.js`, swap point = `createStore`); `bcryptjs` installed; `data/eb.db` gitignored; 15 tests in `server/store.test.js`
- [x] Auth API + sessions — `server/authApi.js` (Express app mounted in BOTH transports). `/api/register|login|logout|me`, `bcryptjs` hashing (cost 10), 30-day `crypto.randomBytes` session tokens, login timing-safe against username enumeration. 16 tests; verified live on :4444
- [x] Character API (`GET/POST/DELETE /api/characters`, enforce ≤3 slots) — all routes behind `requireAuth`; delete returns 404 (not 403) for non-owned ids
- [x] Client TITLE + AUTH screens — `src/engine/StartScreen.ts` (DOM overlay) + `src/engine/Auth.ts` (API client, token in `localStorage` `eb_session`). DEV: char select stays the boot screen; an **ACCOUNTS** button there opens the overlay. Register/login/logout/session-persist all live.
- [x] Creation model + persistence (SERVER) — `server/charStats.js`: 5 stats, allocate 10 pts, `deriveCombatStats` maps them onto EB combat in ONE tunable place. `POST /api/characters` validates the alloc + builds the canonical seed save. `GameHost(assetsDir, store)`: join-by-`{sessionToken,characterId}` loads the character (combat re-derived from saved alloc); save-back on level-up/equip/buy/sell/use + disconnect. Tests: `charStats.test.js` (9), `persistence.test.js` (7).
- [x] NEW CHARACTER flow UI (START) — `src/engine/charcreate/`: `CreateFlow.ts` (name → pick 1 of 3 random roster sprites → recolor → radar → Create), `StatRadar.ts`, `Recolor.ts`, `spritePreview.ts`. On confirm → create + spawn.
- [x] CHARACTER SLOTS / CONTINUE UI — `StartScreen.ts` slots view (after login): 3 boxes, empty=Create New, filled=sprite+name+Lv; click filled → resume. Verified create→persist→list live on :4444.
- [x] Client join-by-token wiring — `Network.connect(...auth)` token mode + welcome `stats`/`equipped` routed through existing handlers; `Game.startGame(opts)` + `Game.playCharacter(char)` spawn from the saved position.
- [x] Move `PlayerFlags` off `localStorage` into the save — flags now live in the character `save` JSON (gameHost `this.flags` map, persisted; private, never broadcast). Client mirrors every change to the server via a sink. Round-trip tested in `persistence.test.js`.
- [x] **Supabase migration BUILT (2026-06-17)** — `SupabaseStore` (`server/store/SupabaseStore.js`) implemented + wired; `createStore` auto-selects by env (a Postgres URL → Supabase, else SQLite). Store contract went async-for-real; `_saveCharacter` is a per-character serialized write queue flushed on `SIGTERM`. Schema in `supabase/migrations/`. Operator steps: **SUPABASE_SETUP.md**.

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
- [x] Traffic cars — server-driven vehicles on authored routes (`car_traffic.json`; `Vehicle` waypoint routes, one appended actor slot per car, position broadcast like NPCs). Authored in the Traffic Editor.
- [x] Chat system (text bubbles or chat box)
- [x] Interpolation/smoothing for remote player movement (RemoteInterp.ts — adaptive snapshot interpolation on a server-time playout clock; teleport gaps >64px snap instead of glide)
- [x] Interpolation for NPC movement (RemoteInterp reused — `npcInterp` + `interpolateNpcs`; NPCs/enemies/cars glide like remote players)
- [x] PK (player-kill) damage model — `pk` flag on every combatant (enemies true, NPCs false, players false) + `npcSim.canHurt(attacker, target)` as the single damage-gating rule, wired into `handleAttack`

## Network scaling (Phases 0–2) ✅ — full record in NETWORK_REMODEL.md

- [x] **Phase 0 — instrumentation** (`_recordSend`/`netStats`, `NET_DEBUG`).
- [x] **Phase 1 — AOI in the monolith** — `server/aoi.js` SpatialGrid, `publishToArea`, per-client spawn/despawn + npc_update filtering, subscription hysteresis, crowd caps, AOI-scoped welcome, crowd aggregate render. `AOI_ENABLED` ON by default; teleport-resnapshot + reciprocal spawn defects fixed.
- [x] **Phase 2 — binary + delta wire format** — `wire.js`/`wire.ts` binary codecs for npc_update + player_move (behind `BINARY_WIRE`), delta-coding (per-socket / per-viewer baselines), event-relevance routing (`_publishPlayerEvent`). Measured ~9.4× downlink reduction (33.8 → 3.6 KB/s, 20 clustered players).
- [x] **Combat feel / latency** — lag compensation for melee (`LAG_COMP`, rewind to attacker's view), time-based step budget, player interp trim, NPC broadcast 10→30Hz.
- [x] **Sim-cost optimization pass (2026-06-26)** — profilers (`simProfile.js`, `sim_microbench.js`), rate-adaptive interp buffer, AI time-slice, killed O(actors×players)/O(players²) scans. Measured ceiling: 1000 dispersed players ≈ 2.5+ cores → sharding is the next lever (Phases 5/6), not tuning.
- [x] **WebRTC DataChannel transport (Stage D)** — `server/rtc.js`, unreliable/unordered firehose, dev auto-on / prod WS (Render has no inbound UDP). Verified end-to-end 2026-06-27.
- Remaining (gateway split, WebTransport, sharding) tracked in NETWORK_REMODEL.md Phases 3–6.

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

## Dev Tooling & Quality Gates — done

- [x] Quality stack: ESLint + Prettier, Vitest, Zod (validates `public/overrides/*.json`), GitHub Actions CI (`npm run verify`), Husky + lint-staged pre-commit
