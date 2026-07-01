# Status Effects & PSI Buffs — Design + Wiring Plan

Goal: every EarthBound ailment is inflictable by **at least one enemy**, every PSI **buff**
is castable by players, **at least one enemy casts PSI** (canon), and **every** ailment and
buff has a visual indicator (reused ROM effect sprite, emoji, or custom sprite).

This doc is the map for that work. It reflects the **current** engine — much of the spine
already exists; the gaps are mostly _content_ (authoring enemies) and _buff wiring_.

---

## 1. The EarthBound status catalog (canon → our model)

EB is turn-based with no real-time "stun"; we model each ailment as a **timed** effect with a
post-effect **immunity window** so nothing chains into a perma-lock. Source of truth:
`server/status.js` (`STATUS` + `DEFS`), mirrored to the client as wire-stable id strings.

### Bad — damage-over-time (HP ticks)

| Ailment          | id          | Canon                          | Our DoT (current default) |
| ---------------- | ----------- | ------------------------------ | ------------------------- |
| Poison           | `poison`    | gradual HP loss                | 3%/1s for 8s              |
| Cold             | `cold`      | mild HP loss ("caught a cold") | 2%/1.5s for 8s            |
| Sunstroke        | `sunstroke` | heat HP loss                   | 3%/1.2s for 8s            |
| Nausea           | `nauseous`  | HP loss + can fumble a turn    | 2%/1.5s for 8s + fumble   |
| **Burn** _(new)_ | `burn`      | _(not in EB; your addition)_   | **TBD — fire DoT**        |

> **DoT becomes per-entity authored** (your call): the global `dotPct`/`dotMs` in `DEFS`
> become _defaults_; an enemy's inflict entry may override **damage** and **frequency** so a
> weak slime's poison ≠ a boss's poison. See §4.

### Bad — hard disablers (can't act)

| Ailment          | id          | Canon                                            | Our model                             |
| ---------------- | ----------- | ------------------------------------------------ | ------------------------------------- |
| Paralysis (numb) | `paralysis` | can't act                                        | timed 550ms (the old ad-hoc "stun")   |
| Diamondized      | `diamond`   | petrify; needs Healing Ω; persists out of battle | timed 4s **(canon tension — see §6)** |
| Asleep           | `sleep`     | can't act; wakes on hit                          | timed 4s, breaks on hit               |

### Bad — control / soft debuffs

| Ailment           | id          | Canon                                  | Our model                 |
| ----------------- | ----------- | -------------------------------------- | ------------------------- |
| Feeling strange   | `strange`   | confused, random/ally-targeted actions | timed 6s, scrambles input |
| Possessed         | `possessed` | periodic random action                 | timed 6s, scrambles input |
| Can't concentrate | `noPsi`     | PSI fails                              | timed 6s, blocks PSI      |
| Crying            | `crying`    | accuracy down                          | timed 8s, accuracyDown    |

### Omitted (per request)

- **Homesick** — exists in `status.js` as flavor; we leave it dormant, no enemy authored.
- **Mushroomized** — canon control-scramble; folded into `strange` (same effect) unless we
  later want the overworld-control-scramble variant.

### Good — PSI buffs (players)

| Buff                  | id (PSI stem)     | Canon                  | Status today                       |
| --------------------- | ----------------- | ---------------------- | ---------------------------------- |
| Offense Up            | `offense_up`      | raise attack           | **stub, no effect**                |
| Defense Up            | `shield`?/defense | raise defense          | **stub, no effect**                |
| Defense Down          | `defense_down`    | lower enemy defense    | **stub, no effect** (enemy-target) |
| Power/Physical Shield | `shield`          | block/reflect physical | **stub, no effect**                |
| PSI Shield            | `psi_shield`      | block/reflect PSI      | **stub, no effect**                |

Buff engine (`server/buffs.js`) already does timed flat stat bonuses and is read by combat
(offense at attack, defense on incoming hit, speed for dodge). Offense Up / Defense (stat)
buffs are a **thin wire-up**. Shields are a **new mechanic** (see §6).

---

## 2. What already exists (do NOT rebuild)

- **`server/status.js`** — full ailment catalog, apply/tryInflict/tick/immunity, resist
  scaling by ROM element vuln, `normalizeInflict` gate. Shared by players + in-sim actors.
- **`server/buffs.js`** — timed stat-buff store; `applyBuff/buffBonus/activeBuffs/tickBuffs`.
- **Player DoT loop** — `gameHost._tickPlayerStatuses()` (every 250ms) applies DoT + rebroadcasts.
- **Enemy inflict path** — `npcSim.enemyInflict(n)` reads an authored `inflict` field per
  entity; `applyDamage` calls `tryStatus` for each. **Wired, but no entity authors it yet.**
- **Net sync** — `player_status` / `npc_status` / `status_applied` messages already flow;
  client stores `statuses[]` on Player/RemotePlayer/NPC.
- **Visuals** — `Renderer.drawStunEmoji` (😵 for paralysis) + `drawStatusPips` (color square
  per status) + `STATUS_PIP_COLOR` map.
- **Authoring UI** — `src/editor/components/InflictEditor.ts` (`STATUS_OPTIONS` dropdown +
  `{type, chance}` rows), already used by Item Manager (weapons) and PSI Manager.

## 3. The gaps to close

1. **No enemy inflicts anything** — `entities.json` has 0 `inflict` entries. (content)
2. **PSI buffs are stubs** — `offense_up`, `defense_down`, `shield`, `psi_shield` have no
   effect params and no application code. (mechanic + wiring)
3. **No enemy casts PSI** — `npcSim` enemy AI is melee-only. (mechanic)
4. **Per-entity DoT tuning** — inflict spec is `{type, chance}` only; no damage/frequency
   override. (schema + UI)
5. **Visual coverage** — only paralysis has an emoji; buffs have no indicator; you want
   `nauseous` + `crying` (and others) on emoji like the stun face. (presentation)
6. **`burn` status** — does not exist yet. (catalog)

---

## 4. Per-entity inflict authoring (your DoT model)

Extend the inflict entry so each entity tunes its own proc + DoT:

```jsonc
// entities.json (keyed by sprite id) and equip_stats.json (weapons), same shape:
"inflict": [
  { "type": "poison", "chance": 25, "dotDmg": 4, "dotMs": 1000 },  // flat dmg/tick
  { "type": "burn",   "chance": 40, "dotPct": 0.05, "dotMs": 800 } // or % of max HP
]
```

- `chance` — how often the attack procs the ailment (existing, 1–100, vuln-scaled).
- `dotDmg` (flat) **or** `dotPct` (fraction of max HP) — damage per tick; falls back to the
  status `DEFS` default if omitted.
- `dotMs` — tick frequency; falls back to default.
- Mechanic: `applyStatus(holder, type, now, opts)` already takes `opts`; add `dotMs`/`dotDmg`
  /`dotPct` overrides stored on the status instance, read by `tickStatuses` and the player
  DoT loop. `normalizeInflict` validates/clamps the new fields.
- Authoring: add the two numeric fields to `InflictEditor.ts` rows (only shown for DoT types).

This makes "is this enemy poisonous, how hard, how fast" a per-entity setting, exactly as
requested — and the same field set drives non-DoT procs (just `type` + `chance`).

---

## 5. Visual indicators (every effect gets one)

Tiered approach — cheapest first, escalate only where it reads poorly:

- **Emoji (default for soft/DoT):** extend the stun-emoji system to a `STATUS_EMOJI` map.
  Confirmed from request: `nauseous` 🤢, `crying` 😢. Proposed rest: `poison` 🤢/☠️,
  `cold` 🤧, `sunstroke` 🥵, `burn` 🔥, `sleep` 💤, `strange`/`possessed` 💫, `noPsi` 🚫.
  Bob over head like the stun face. Pips remain as a compact fallback / multi-status overflow.
- **ROM effect sprite (preferred for "big" ailments):** `diamond` → reuse a crystal/flash
  effect; offense/PSI casts already have FX we can borrow. Audit ROM FX before drawing custom.
- **Custom sprite:** only if no ROM/emoji reads well.
- **Buffs (new — none today):** a colored **aura/glow ring** at the feet or a small
  badge: Offense Up 🔺red, Defense/Shield 🛡️blue, PSI Shield 🔵cyan, Defense Down 🔻.
  Driven by `activeBuffs()` already on the wire-ready path.

---

## 6. Design decisions (LOCKED)

1. **Shield mechanic — block/reflect N hits (canon).** New mechanic, not a flat stat buff:
   a shield instance stores a `hits` counter + kind (`physical`/`psi`) + mode
   (`block` at β / `reflect` at Ω). Incoming matching damage is nullified and decrements the
   counter; in reflect mode the damage is bounced back at the attacker. Shield breaks at 0.
   Stored alongside buffs on the holder (new `holder.shields`), read in `damagePlayer` /
   `applyDamage` before the buff/defense math.
2. **Disablers — persist until cured, NO failsafe (canon).** `diamond` holds until an ally
   cures it (Healing Ω-tier); it also **blocks incoming healing** while active. Rationale
   (user): reaching diamondizers means you've progressed far enough that other players can
   heal you. `sleep` still breaks on hit (canon); `paralysis` stays the short auto-recover
   "stun" (it replaced the ad-hoc stun and is a core action-combat beat). So the immunity
   window / auto-timeout is **removed for `diamond`** — it ends only via a cure.
3. **Enemy abilities — full 1:1 canon translation.** Every attack/PSI an enemy has in EB, our
   enemy gets the equivalent: offense PSI (beams/PK), status PSI (Hypnosis/Paralysis/Brainshock),
   assist (Shield/Offense Up/heal), and status-on-hit. Build the enemy-cast path generically so
   authored enemy movesets (from the ROM catalog) drive it — not one hardcoded caster.

---

## 6b. Enemy afflictions — CANON-EXTRACTED (do not hand-edit)

`public/overrides/entities.json` `inflict`/`abilities` are now **generated from the
ROM's canon data** by `tools/extract_enemy_afflictions.py` — NOT hand-authored. Re-run
the tool to regenerate; hand-edits get overwritten. Other keys (stats/combat) stay
hand-authored via the Entity Manager.

**How canon maps to our data** (see the tool's header + `tools/analyze_enemy_actions.py`):
EarthBound keeps each attack's exact status land-% in ASM, not as data. But the
decompiled project (`eb_project/`) gives each enemy's **action rotation** (`Action 1–4`
in `enemy_configuration_table.yml`) and each action's **intent** (its battle text, e.g.
"scattered some spores!" = mushroomize; PSI actions map through `psi_ability_table.yml`
to Hypnosis/Paralysis/Brainshock). So which enemy inflicts which status is read straight
from canon; the per-hit `chance` is **derived** from how many of the enemy's 4 action
slots use that attack (its canon frequency: 1 slot → 25%, 2 → 50%).

**Enemy PSI — ALL families** (via `psi_ability_table.yml` → PSI name + tier). Every PSI an
enemy casts in canon becomes a ranged `abilities` entry with a `mode`. Which PSI is canon;
the per-cast numbers (ASM) reuse OUR player-PSI values for the same family/tier so enemy
PSI stays consistent with player PSI:

| Family                                      | mode                        | effect                                    | example enemies                                        |
| ------------------------------------------- | --------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Fire / Freeze / Thunder / Flash / Starstorm | `offense`                   | damage the player                         | Starman Junior, Mr. Molecule, Thunder Mite, Chomposaur |
| Hypnosis / Paralysis / Brainshock           | `offense` (dmg 0 + inflict) | sleep / paralysis / strange+noPsi         | Crazed Sign, Evil Mani-Mani, Handsome Tom              |
| Lifeup / Healing                            | `heal`                      | caster restores HP (only when hurt)       | Mobile Sprout, Mr. Carpainter, Smelly Ghost            |
| Shield / PSI Shield                         | `shield`                    | caster raises a block-N-hits shield       | Spinning Robo, Ranboob                                 |
| Offense up                                  | `buff`                      | caster's swings hit harder                | (Mondo Mole variant)                                   |
| Defense down                                | `debuff`                    | player's defense drops (hits land harder) | Titanic Ant                                            |
| PSI Magnet                                  | `magnet`                    | drains the player's PP                    | Foppy, Gigantic Ant, Evil Mani-Mani                    |

Mechanic: the enemy-cast path (`npcSim` `castEnemyAbility`) dispatches on `mode` — self-casts
(heal/buff/shield) apply to the enemy actor; player-casts route through the host
(`_applyEnemyPsiEffect` for debuff/magnet). Enemy shields are consumed in `applyDamage`
(player melee = physical; instant player PSI tagged `psi`; cone/bolt PSI not yet tagged).

**Status coverage (25 sprites; 40 total with PSI):**

| Status    | Canon inflictors (examples)                                    |
| --------- | -------------------------------------------------------------- |
| poison    | Zombie Dog, Skelpion, Gigantic Ant                             |
| cold      | Li'l UFO, Spinning Robo, Urban Zombie, Guardian Hieroglyph     |
| nauseous  | Master Belch, Smelly Ghost, Violent Roach, Slimy Little Pile   |
| strange   | Ramblin' Evil Mushroom, Territorial Oak, Foppy, Handsome Tom   |
| possessed | Zombie Possessor                                               |
| sleep     | Attack Slug, Ranboob, Abstract Art, Crazed Sign (Hypnosis PSI) |
| crying    | Cranky Lady, Annoying Old Party Man, No Good Fly, Frank        |
| paralysis | Crazed Sign, Evil Mani-Mani (Paralysis PSI)                    |
| noPsi     | Foppy, Handsome Tom, Territorial Oak (Brainshock PSI)          |

**GAPS — no canon enemy attack exists (NOT fabricated):**

- **sunstroke** — Dusty Dunes desert _environmental_ damage, no enemy attack inflicts it.
- **diamond** (diamondize) — only PK Flash's _random_ effect table; no dedicated attack.
  (Diamond Dog / Petrified Royal Guard do NOT diamondize in canon — verified.)
- **burn** — our own addition, not an EarthBound status.

> Decision for the maintainer: keep these three uncovered (pure canon), or re-add a
> synthetic inflictor for coverage? The earlier hand-authored guesses (Skelpion→sunstroke,
> Petrified Guard→diamondize) were **non-canon and have been removed**. Offense PSI casters
> (Starman PK Beam, etc.) are canon too but out of scope for this afflictions pass — a
> follow-up can extract them the same way.

## 7. Phased plan — STATUS

- **P0 — Catalog + per-entity DoT** ✅ `burn` added; inflict spec carries `dotDmg`/`dotPct`/
  `dotMs` overrides; InflictEditor exposes dmg/rate fields. Unit-tested.
- **P1 — Buffs + shields** ✅ Offense Up / Defense Down wired; new `shields.js`
  (block/reflect N hits, physical/psi) consumed in `damagePlayer`; diamond is
  persist-until-cured + blocks healing. Unit + integration tested.
- **P2 — Visuals** ✅ `STATUS_EMOJI` over every entity (nauseous 🤢 / crying 😢 / burn 🔥 /
  etc.); shield chips in the buff HUD; Blocked!/Reflected! floating FX. Diamond uses 💎
  (ROM-FX swap is optional polish).
- **P3 — Enemy abilities** ✅ Generic authored enemy-cast path in `npcSim` (offense + status
  PSI at range, tagged `psi` so PSI Shield guards it); roster above. Spec sanitizer tested;
  AI-cast glue is playtest-verified (no start()-less tick hook).
- **P4 — Verify** ⏳ Automated: full server suite green (status 10, shields 4, combat 31,
  gameHost 74/1*, botFleet/loot/charStats). *the 1 failing gameHost door test is PRE-EXISTING
  (fails on clean `main`, unrelated). Manual playtest checklist below.

## 8. Playtest checklist (yours)

1. Fight **Coil Snake / Skelpion / Master Belch** → see the DoT emoji + HP bleed at the
   authored rate; confirm the per-enemy numbers feel right (tune in InflictEditor).
2. Get hit by **Petrified Royal Guard** → diamondized (💎), can't act, **can't be healed**
   until an ally casts Healing (which cures it). Confirm no auto-recovery.
3. Stand near **Starman Junior / Smelly Ghost / Insane Cultist / Thunder Mite / Fire Plug**
   → they cast PSI at range (flipbook flies at you); confirm status/damage lands.
4. Cast **PSI Shield** then eat an enemy PSI cast → Blocked!/Reflected!; cast **Power Shield**
   vs melee. Check the shield chips + charge countdown in the HUD.
5. Cast **Offense Up** (hits harder) and **Defense Down** on an enemy (it takes more).

## 9. Known follow-ups (not blocking)

- Enemy self-buff/self-shield (assist PSI on enemies) — needs enemy-damage buff plumbing.
- Defense-down has no on-enemy visual tell (only the cast FX); buffs are owner-only HUD.
- Diamond ROM-FX crystal overlay (currently the 💎 emoji).
- Automated coverage for the enemy AI cast decision (needs a tick hook).

## 7b. Original phased plan (reference)

- **P0 — Catalog finish:** add `burn` to `status.js` DEFS (fire DoT) + element. Add per-entity
  DoT override fields to `applyStatus`/`tickStatuses`/`normalizeInflict`.
- **P1 — Buff + shield wiring:** `offense_up`/`defense_down` → `buffs.js` in `use_psi`; new
  `shields.js` (block/reflect N hits) read in `damagePlayer`/`applyDamage`; diamond
  persist-until-cured + blocks-healing; a cure PSI/item that clears diamond.
- **P2 — Visuals:** `STATUS_EMOJI` map (nauseous 🤢, crying 😢, etc.) + buff/shield aura
  renderer; ROM-FX for diamond.
- **P3 — Enemy abilities (content + mechanic):** generic enemy-cast path in `npcSim`
  (offense/status/assist PSI + status-on-hit) driven by authored movesets; translate the ROM
  enemy movesets 1:1; ensure ≥1 enemy inflicts each ailment; author via InflictEditor /
  entity data.
- **P4 — Verify:** playtest one enemy per ailment + PSI casters; confirm emoji/auras/pips,
  per-entity DoT scaling, shield block/reflect, diamond cure-only. Update this doc + ARCHITECTURE.md.

> Pipeline note: all authored data lives in override JSON (`entities.json`, `equip_stats.json`,
> `psi.json`) — respects the client-side ROM/base-mod layer discipline. No ROM-derived assets
> added.
