# Abilities & Build Parity

How the 5 character stats turn into power. Goal: **every stat is a full, viable build** —
you can pour everything into one (a specialist) or split across several (a custom combo),
and any path of equal investment reaches a **comparable power ceiling**, expressed in its
own lane. No trap stats, no mandatory stat.

The 5 stats (`server/charStats.js`): **Muscle, Spirit, Speed, Mental, Knowledge.** Each
1–10 at creation (10 points to spend); then **+1 skill point per character level** (cap
99/stat) spent on any stat. A pure build reaches stat ~50 around character level ~50; a
50/50 hybrid reaches ~25 in two stats; a generalist ~10 in all five.

---

## 1. The parity principle

> Equal investment → equal power, different shape.

- **Damage lanes** (Muscle, Mental, Knowledge) share a _damage ceiling_, differentiated
  by shape + cost: Muscle = sustained/free/melee; Mental = burst/PP-fueled/ranged-AOE;
  Knowledge = crafted-gear + gadget-bombs + crit.
- **Force-multiplier lanes** (Spirit, Speed) reach parity through _effective_ DPS — outlast
  or out-evade = more uptime = comparable total impact, with their own win condition
  (Spirit outlasts + counters; Speed out-paces + evades).
- **Hybrids** trade a capstone for breadth: two lanes to mid-tier instead of one to the top.

**#1 balance bug today:** Mental does **not** scale PSI damage (fixed per tier), so a
maxed-Mental nuke = a level-1's borrowed nuke. Muscle scales, Mental doesn't → parity
requires the PSI-power fix (§4.4).

---

## 2. The shared tier grid

Every stat unlocks an **active ability at the same five milestones**, plus a **continuous
passive** every point. Same levels across columns = parity is visible at a glance.

| Tier (stat lvl)        | **Muscle** — Bruiser | **Spirit** — Tank | **Speed** — Skirmisher      | **Mental** — Psychic   | **Knowledge** — Artificer    |
| ---------------------- | -------------------- | ----------------- | --------------------------- | ---------------------- | ---------------------------- |
| **Passive** (every pt) | +offense             | +maxHP, +defense  | +move spd, +dodge, +atk spd | +PP, +PSI power        | +crit%, +craft quality       |
| **I** (L4)             | Heavy Swing          | Guard Stance      | Dash                        | PSI α basics           | Fix I (basic weapons)        |
| **II** (L12)           | Cleave (AOE)         | Second Wind       | Evade Roll (i-frames)       | PSI β                  | Fix II + first gadget bomb   |
| **III** (L22)          | Guard Break          | Counter           | Flurry                      | PSI γ                  | Fix III (mid weapons, armor) |
| **IV** (L34)           | Knockback Slam       | Bulwark / Taunt   | Flank (backstab)            | PSI Ω                  | Fix IV + heavy bombs         |
| **Capstone** (L50)     | **Megaton Blow**     | **Last Stand**    | **Blitz**                   | **Rockin' Ω** (scaled) | **Master Artificer**         |

The capstones are tuned to the **same damage/impact budget** (§4): Megaton ≈ Rockin' Ω ≈
a Master-Artificer signature weapon's burst; Last Stand ≈ Blitz uptime as the survival/
evasion equivalent.

---

## 3. Per-stat ladders

Resource notes: Muscle/Speed arts cost **stamina** (a regenerating bar, **built** — see §6);
Mental costs **PP**; Knowledge gadget-bombs are **consumable items** (crafted); Spirit stances
cost nothing but slow/root you.

> **Decision (2026-06-25): basic weapon swings also cost stamina** (`STAMINA_ATTACK_COST=8`,
> binary gate like PP — not damage-scaled), so melee is _not_ strictly free. This diverges
> from the "sustained free melee" framing below. **Accepted caveat:** it taxes the Muscle lane
> on its own core attack and is ~free for a high-Spirit pool — revisit for parity once the
> active arts (which add their _own_ stamina cost on top) land, to avoid the bruiser double-dipping.

### 3.1 Muscle — Bruiser (sustained free melee)

Passive: hit = `offense = 3 + 1.5×Muscle`; also feeds **guts** (mortal-damage resist + SMAAAASH).

- **I · Heavy Swing** — charge a 2× hit (slow windup).
- **II · Cleave** — melee arc hits all enemies in front (the melee answer to PSI radius).
- **III · Guard Break** — ignore a chunk of target defense (anti-tank).
- **IV · Knockback Slam** — big knockback + brief stun (synergizes with the weight-class push).
- **Capstone · Megaton Blow** — huge burst ≈ Rockin' Ω damage; the bruiser's nuke.

### 3.2 Spirit — Tank (outlast + counter)

Passive: `maxHP = 30 + Muscle + 5×Spirit`, `defense = 1 + 1.2×Spirit`, +vitality (regen).

- **I · Guard Stance** — active damage reduction while held (slows you).
- **II · Second Wind** — out-of-combat HP regen; small on-hit lifesteal.
- **III · Counter** — reflect a % of damage taken back to the attacker (the tank's kill path).
- **IV · Bulwark / Taunt** — soak damage for nearby allies / force aggro (group role).
- **Capstone · Last Stand** — brief invulnerability or one self-revive; survival ceiling
  equal to others' damage ceiling.

### 3.3 Speed — Skirmisher (fast DPS + evasion)

Passive: move speed (`moveSpeedFor`), dodge %, **attack-speed** (more hits/sec).

- **I · Dash** — short burst move / gap-close.
- **II · Evade Roll** — brief i-frames.
- **III · Flurry** — rapid multi-hit attack-speed spike.
- **IV · Flank** — bonus damage when striking from behind (positioning skill).
- **Capstone · Blitz** — extreme attack-speed burst → effective DPS ≈ the damage lanes,
  while staying nearly impossible to pin.

### 3.4 Mental — Psychic (PSI burst, PP-fueled) — _the fine-grained lane_

Passive: `ppMax = 2 + 2×Mental`; **+PSI power** (the §4.4 fix). Unlike the others, Mental
unlocks **one PSI move per point** (50 moves, sorted by PP cost), so its ladder fills every
level — the α/β/γ/Ω tier bands map onto grid tiers I–IV, capstone = Rockin' Ω.

| Mental | maxPP  | Move learned (cost)                                                                         |
| ------ | ------ | ------------------------------------------------------------------------------------------- |
| 1      | 4      | Teleport α (2) — + Magnet α/Ω (free)                                                        |
| 2      | 6      | Thunder α (3)                                                                               |
| 3      | 8      | Freeze α (4)                                                                                |
| 4      | 10     | Lifeup α (5)                                                                                |
| 5      | 12     | Healing α (5)                                                                               |
| 6      | 14     | Fire α (6)                                                                                  |
| 7      | 16     | Shield α (6)                                                                                |
| 8      | 18     | Defense down α (6)                                                                          |
| 9      | 20     | Hypnosis α (6)                                                                              |
| 10     | 22     | Thunder β (7)                                                                               |
| 11–16  | 24–34  | Lifeup β (8), Healing β (8), PSI Shield α (8), Flash α (8), Paralysis α (8), Teleport β (8) |
| 17     | 36     | Freeze β (9)                                                                                |
| 18–21  | 38–44  | Rockin' α (10), Shield β (10), Brainshock α (10), Offense up α (10)                         |
| 22     | 46     | Fire β (12)                                                                                 |
| 23     | 48     | Lifeup γ (13)                                                                               |
| 24–25  | 50–52  | Rockin' β (14), PSI Shield β (14)                                                           |
| 26–27  | 54–56  | Thunder γ (16), Flash β (16)                                                                |
| 28–31  | 58–64  | Freeze γ (18), Defense down Ω (18), Hypnosis Ω (18), Shield Σ (18)                          |
| 32–34  | 66–70  | Fire γ (20), Healing γ (20), Thunder Ω (20)                                                 |
| 35–39  | 72–80  | Lifeup Ω (24), Flash γ (24), Starstorm α (24), PSI Shield Σ (24), Paralysis Ω (24)          |
| 40     | 82     | Freeze Ω (28)                                                                               |
| 41–43  | 84–88  | Brainshock Ω (30), Offense up Ω (30), Shield Ω (30)                                         |
| 44     | 90     | Flash Ω (32)                                                                                |
| 45     | 92     | Healing Ω (38)                                                                              |
| 46     | 94     | Rockin' γ (40)                                                                              |
| 47–49  | 96–100 | Fire Ω (42), Starstorm Ω (42), PSI Shield Ω (42)                                            |
| 50     | 102    | **Rockin' Ω (98)** — capstone                                                               |

Unlock = `unlockMental` (the rank above), **not** raw `maxPP ≥ cost` — that's what evens it
out (one move/level, no batches, no gaps). Because the pool grows faster than the cost
you're unlocking, **learn ≈ afford** — you can cast a move shortly after learning it.
(Ties within a cost ordered by family; tune in `psi.json`.)

### 3.5 Knowledge — Artificer (Fix It crafting + gadget-bombs + crit)

Passive: **crit%** (`~1%/luck`, `luck = 3 + Knowledge`, cap 50%), +IQ, +craft success/quality.
Canon: Jeff **fixes broken items overnight** into gear, gated by level/IQ —

> **X** (Knowledge) **+ Y** (a broken item) **+ Z** (rest at an inn / save-point) **→ fixed item.**

- **I · Fix I** — repair basic \_Broken \_\_\_\_ drops into low-tier weapons (offense ≈ early Muscle).
- **II · Fix II** — better recipes, higher success; **first gadget-bomb** (Bottle Rocket —
  consumable ranged burst, Knowledge's PSI-equivalent).
- **III · Fix III** — mid-tier weapons + armor fixes (offense ≈ mid Muscle).
- **IV · Fix IV** — high-tier; **heavy bombs** (Bazooka/Big Bottle Rocket — burst ≈ PSI Ω).
- **Capstone · Master Artificer** — **signature weapons in the ~150–220 offense band**
  (Knowledge-locked to equip), best bombs ≈ Rockin' Ω burst.

**Inputs already exist** — _Broken spray can_ etc. drop from enemies (`enemies.json`), so
crafting plugs into the loot economy (ARCHITECTURE.md "Loot"). **Net-new:** the rest/inn
trigger, the recipe table (broken→fixed + knowledge req + success%), gadget-bomb items,
and an equip-Knowledge gate for signature weapons.

**Economy vs personal damage:** a weapon's offense helps whoever wields it → crafting is
naturally an economy role (arm the server, sell for profit). Gate the **capstone signature
weapons + heavy bombs to require Knowledge to use** so a 100%-Knowledge build also _wields_
the best — both supplier and damage-dealer.

---

## 4. Damage-ceiling targets (the parity math — to tune)

Anchor: **a maxed Muscle melee hit.** `offense = 3 + 1.5×Muscle` → Muscle 99 ≈ **151/swing**,
sustained, free. Starting targets (playtest, not law):

1. **Mental** — maxed Rockin' Ω ≈ **150–220/cast** (slight burst premium for costing ~98 PP
   - running dry). Needs §4.4 power scaling.
2. **Knowledge** — a maxed signature weapon lifts effective per-hit to the Muscle band; heavy
   bombs deliver PSI-tier burst; +up to 50% crit for 2× spikes. Damage = gear + bombs + crit.
3. **Speed** — lower per-hit × more hits/sec × evasion uptime → comparable _effective_ DPS.
4. **Spirit** — not a damage ceiling; an **effective-HP + counter** ceiling that outlasts.

**4.4 PSI power scaling (load-bearing fix).** Multiply `def.damage`/`def.heal` by a caster
coefficient in `use_psi`: `effective = base × (1 + Mental×k)`. Tune `k` so maxed Rockin' Ω
hits the §4.1 band. **Open:** scale on Mental (simple, single-stat caster) or split power→IQ
(deeper two-stat caster). Undecided.

---

## 5. Combos & specialization

The same ladders support pure specialists and custom hybrids:

- **Specialist (≈50 in one).** Full ladder + capstone of one lane. The strongest _single_
  win condition (biggest nuke / unkillable / fastest / best crafter).
- **Two-stat hybrid (≈25/25).** Both lanes to **Tier III**, no capstone. Examples:
  - _Muscle + Speed_ — fast bruiser: Cleave + Flurry, sustained melee that's hard to pin.
  - _Mental + Spirit_ — battle-mage: PSI γ while tanky enough to channel it.
  - _Mental + Knowledge_ — caster-artificer: PSI + bombs + self-crafted gear (two burst lanes).
  - _Muscle + Spirit_ — juggernaut: Guard Break + Counter, hits hard and won't die.
  - _Speed + Knowledge_ — gadgeteer: dash-in, bomb, crit, dash-out.
- **Tri-stat / generalist (≈16/16/16 or 10×5).** Tier I–II everywhere — flexible, no ceiling;
  relies on gear + teamplay over a personal capstone.

Parity rule that makes combos fair: **the cost of breadth is the capstone.** A specialist
out-peaks a hybrid in its lane; the hybrid out-flexes the specialist across two. Neither
strictly dominates.

---

## 6. Implementation hooks

- **Dev bypass via a server-verified role (DONE for PSI).** Accounts have a `role`
  column (`'player'|'dev'|'admin'`, `server/store/*`), loaded at join onto the player and
  **never trusted from the client** (the `editor` flag is client-spoofable, so it can't grant
  prod powers). `gameHost.js psiUnlocked(entry, move) = isDevPlayer(entry) || mental >=
move.unlockMental`. Set a dev with `node server/setRole.js <username> dev`. Every future
  ability lane reuses `isDevPlayer` → dev testing never breaks as specials are added.
- **PSI unlock gate (DONE).** `unlockMental` per move (ranked by PP, see §3.4) is computed
  in both `PsiTuning.ts` and `gameHost.js`. Server enforces it in `use_psi`; the client
  mirrors it in the PSI menu (locked tiers dimmed, cast blocked) deriving Mental from
  `ppMax`. `welcome` sends `role` so the menu unlocks fully for devs.
- **Other lanes (future):** one shared map `unlocks[stat] = [{level, abilityId}]`; gate each
  ability (client UI + server) on the same `isDevPlayer || stat >= level` shape.
- **PSI:** add `unlockMental` per move in `psi.json`; gate menu (`menu/layout.ts`) + server
  `use_psi` (`gameHost.js:3362`) on `mental >= move.unlockMental`; keep the PP affordability
  check; sticky high-water-mark learning. PSI power scaling = one multiply in `use_psi` (§4.4).
- **Stamina bar (DONE, 2026-06-25).** Yellow bar under PP. `staminaMax = 40 + 5×Spirit`,
  `staminaRegen = 6 + 1.5×Muscle`/s (`deriveCombatStats`, mirrored client/server); grows only
  via skill-point spend like PP (GROWTH 0, cap 99/stat). Server-authoritative, client-predicted
  - throttled `player_stamina` reconcile. **Sinks:** basic swing (cost 8, gated like PP) and
    **run** (hold-Shift = 1.5× walk, drain 18/s, "winded" latch locks running out at 0 until it
    recharges to 20%). Future Muscle/Speed **arts** plug in as additional stamina sinks.
- **Net-new systems:** the active-art framework, crafting + rest/inn (§3.5), gadget-bomb items.
  Each wants its own spec when prioritized.
- **Done:** PSI ???? → "PSI <favorite thing>" (`psiName`).

---

## 7. Open items / decisions

- **PSI power: Mental-only or split to IQ?** (§4.4) — single-stat vs two-stat caster. Undecided.
- **Respec — required before launch (TBD).** Now MORE urgent: with the PSI gate live, a
  low-Mental build is locked out of PSI until respec exists (dev accounts bypass; players
  don't). Sticky high-water-mark learning is still TODO — the gate reads current Mental,
  which is fine only while Mental can't drop (i.e. until respec lands). A creation choice
  must not be a permanent trap or parity breaks. None exists today (`spend_points` only
  adds). **Canon home (pick
  one):** _Magicant_ — your inner mind, which already strips all gear in canon (the ideal
  safety rail: respec is pure-essence, no equipment exploits); or _Saturn Valley_ — **Mr.
  Saturn does it for you** (quirky NPC service). Trigger via the rest/sleep mechanic (§3.5);
  scaling cost (homesickness / PP / a Mr. Saturn coffee / in-game time) so it's a deliberate
  reflection, not mid-fight spam. Decide: travel-to-a-place vs enter-from-anywhere-via-sleep.
- **Stamina resource** — DONE (§6): cap = Spirit, regen = Muscle, sinks = basic swing + run.
  Open: whether basic swings should stay a sink (parity caveat, §3) and how arts layer on top.
- **Crafting design (§3.5)** — recipe table, rest/inn mechanic + location, inn economy,
  gadget-bombs, equip-Knowledge gate. Its own doc when prioritized.
- **PP regen economy — DONE.** PP now passively regenerates, fueled by **Mental +
  Spirit** (`charStats.deriveCombatStats.ppRegen = 0.4 + 0.05×Mental + 0.05×Spirit`
  PP/sec). **Combat-throttled** (`PP_COMBAT_FRAC` for `PP_COMBAT_WINDOW_MS` after a
  cast or a hit, `gameHost.js`) so PSI still "runs dry" mid-fight (preserves the
  Mental-lane burst identity, §1/§4.1) and refills you **between** fights — a pure
  caster recovers slowly relative to their big pool, while the **Mental+Spirit
  battle-mage hybrid (§5)** gets real cast uptime. Regenerates whole points only
  (keeps the integer `pp` clean); owner gets a `player_stats` push per tick.
  Level-up/respawn + consumables remain the fast/clutch restores. _Open: PSI Magnet
  is catalogued but its PP-steal effect is still a no-op — wire it as the active
  early-game restore._
- **XP curve** — geometric `30×1.5^(level-1)` walls out past ~L50, starving the post-cap
  point grind that _is_ the endgame. Flatten (e.g. `~25×level^1.5`); calibrate to mob XP.
- **All §2/§4 numbers are starting targets** — they need playtest tuning to truly balance.

### UI direction (tracks, not a tree)

The 5 stats are **linear tracks** (gated by one stat each, no branches/prereqs/node-choices),
so a branching skill tree misrepresents the system. Plan instead:

- **Keep the level-up pentagon** as the allocator; add a **"next unlock" hint** when dragging
  a stat (e.g. "Muscle 9→10 · next: Cleave at 12").
- **Add a persistent Abilities screen** (browsable anytime, separate from the spend modal) —
  render the §2 parity grid: 5 lanes × tier rows, each ability marked unlocked / next / locked,
  with a "you are here" position. Lets players plan a build before spending.
- **The PSI menu is already the Mental lane** — extend it (gray locked tiers, show the
  `unlockMental` requirement) rather than replacing it.
- **Build Mental-first**, stub the other 4 lanes as locked/coming, fill them as specials ship.
- Respect the dev bypass (§6): with `devUnlockAll` on, the Abilities screen shows everything
  unlocked so devs can reach any move/special for testing.
  </content>
