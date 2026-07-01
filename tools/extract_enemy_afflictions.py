"""
extract_enemy_afflictions.py — configure every overworld enemy's STATUS afflictions
AND its full PSI moveset from CANON ROM data (eb_project/), keyed by Overworld
Sprite so it lines up with extract_enemies.py + public/overrides/entities.json.

Covers melee status attacks (poison/cold/spores/…) AND every PSI family an enemy
casts: offense (Fire/Freeze/Thunder/Flash/Starstorm), status (Hypnosis/Paralysis/
Brainshock), recovery (Lifeup/Healing self-heal, PSI Magnet PP-drain) and assist
(Shield/PSI Shield self-shield, Offense up self-buff, Defense down on the player).

WHY this exists / what's derivable vs not
-----------------------------------------
EarthBound does NOT store "poison at 30%" as a data field — a battle action's
effect + odds live in SNES assembly at the action's `Code Address`. But two signals
ARE recoverable from the decompiled project:
  1. Each enemy's action rotation — `Action 1..4` + `Final Action` in
     enemy_configuration_table.yml (indices into battle_action_table.yml).
  2. Each action's intent — its `Text Address` resolves to the battle message
     ("scattered some spores!" = mushroomize), and PSI actions map through
     psi_ability_table.yml to a named PSI (Hypnosis/Paralysis/Brainshock).

So we can say, from canon, WHICH enemies use WHICH status attacks. For the
per-hit `chance` (which our real-time engine needs but the ROM keeps in ASM) we
DERIVE it from how many of the enemy's 4 action slots use that attack — i.e. its
canon attack frequency. This is a documented modeling choice, not invented data.

The action->status tables below were built by auditing every enemy-used action's
battle text (see tools/analyze_enemy_actions.py). Statuses with NO canon enemy
attack (sunstroke = desert environmental; diamondize = only PK Flash's random
table; burn = our own addition) are reported as gaps, never fabricated.

Run: python tools/extract_enemy_afflictions.py [--dry]
"""
import json
import os
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EB = os.path.join(ROOT, "eb_project")
ENTITIES = os.path.join(ROOT, "public", "overrides", "entities.json")

# --- audited action-id -> status -------------------------------------------
# MELEE / physical / "other" attacks the enemy uses in close range (-> `inflict`).
# Only HIGH-confidence, text-unambiguous attacks. (Instant-death "kiss of death",
# generic "war cry", bind/web attacks of uncertain effect are deliberately left
# out rather than guessed.)
MELEE_ACTION_STATUS = {
    72: "poison",   # "stung with its poison stinger"
    100: "poison",  # "took a bite using its poisonous fangs"
    205: "poison",  # "played a flute with poisonous breath"
    74: "cold",     # "exhaled arctic-cold breath"
    213: "cold",    # "let loose with a hacking cough"
    241: "cold",    # "beam that causes night-time stuffiness"
    71: "nauseous", # "burped and blew his nauseating breath"
    87: "nauseous", # "exhaled a blast of stinky breath"
    232: "nauseous",# "vented a terrible odor"
    70: "strange",  # "fired a strange beam"
    75: "strange",  # "scattered some spores" (mushroomize)
    78: "strange",  # "scattered some mold spores"
    237: "strange", # "scattered some spores"
    76: "possessed",# "tried to possess you in a frightening manner"
    77: "sleep",    # "sprinkled around some wonderful-smelling powder"
    97: "crying",   # "said something nasty"
    229: "crying",  # "grumbled about today's youth"
    230: "crying",  # "started lecturing you"
    231: "crying",  # "scowled sharply"
}

# --- enemy PSI abilities (ALL families) ------------------------------------
# psi_ability_table.yml maps each battle action -> a named PSI (psi_name_table)
# + Strength tier. We turn every PSI an enemy casts into an `abilities` entry.
# WHICH PSI is canon (read straight from the enemy's action slots). The per-cast
# numbers live in ASM, so we reuse OUR player-PSI values for the same family/tier
# (keeps enemy PSI consistent with player PSI) — a documented modeling choice.
TIER_NAME = ["alpha", "beta", "gamma", "omega"]
TIER_IDX = {"alpha": 0, "beta": 1, "gamma": 2, "omega": 3, "sigma": 3}

# psi_name_table index -> (category, anim stem, [value per tier]).
#   offense -> damage    heal -> HP restored    shield -> hits soaked
#   buff -> stat +N      debuff -> player stat -N    magnet -> PP drained
#   status_* -> land%    (Hypnosis/Paralysis/Brainshock)
PSI_FAMILY = {
    1: ("offense", "psi_fire", [14, 30, 60, 130]),
    2: ("offense", "psi_freeze", [12, 28, 58, 110]),
    3: ("offense", "psi_thunder", [16, 34, 70, 100]),
    4: ("offense", "psi_flash", [10, 22, 40, 70]),
    5: ("offense", "psi_starstorm", [30, 60, 60, 60]),
    6: ("heal", "lifeup", [40, 80, 150, 300]),
    7: ("heal", "healing", [60, 120, 220, 400]),
    8: ("shield_phys", "shield", [3, 6, 6, 12]),
    9: ("shield_psi", "psi_shield", [3, 6, 6, 12]),
    10: ("buff", "offense_up", [20, 45, 45, 45]),
    11: ("debuff", "defense_down", [15, 30, 30, 30]),
    12: ("status_sleep", "hypnosis", [85, 88, 90, 90]),
    13: ("magnet", "psi_magnet", [10, 18, 25, 30]),
    14: ("status_para", "paralysis", [80, 84, 88, 88]),
    15: ("status_strange", "brainshock", [75, 80, 82, 82]),
}
STATUS_CAT = {"status_sleep": "sleep", "status_para": "paralysis", "status_strange": "strange"}


def load_psi_map():
    """battle-action id -> (psi_name_index, tier_index) for every PSI ability."""
    psi = load_yaml("psi_ability_table.yml")
    out = {}
    for _, v in psi.items():
        if not isinstance(v, dict):
            continue
        action = v.get("Action")
        nidx = v.get("PSI Name")
        tier = TIER_IDX.get(v.get("Strength"))
        if action and nidx is not None and tier is not None:
            out[int(action)] = (int(nidx), tier)
    return out


def build_psi_abilities(slots, psi_map):
    """Turn an enemy's PSI action slots into `abilities` (one per PSI family, best
    tier it casts; cooldown from how many slots use it)."""
    fam = {}  # nameIdx -> [best_tier, count]
    for a in slots:
        info = psi_map.get(a)
        if not info:
            continue
        nidx, tier = info
        if nidx not in PSI_FAMILY:
            continue
        cur = fam.get(nidx)
        if cur is None:
            fam[nidx] = [tier, 1]
        else:
            cur[0] = max(cur[0], tier)
            cur[1] += 1
    abilities = []
    for nidx, (tier, cnt) in sorted(fam.items()):
        cat, stem, vals = PSI_FAMILY[nidx]
        val = vals[min(tier, len(vals) - 1)]
        cooldown = max(2200, min(5500, 6500 - cnt * 1000))
        ab = {"anim": f"{stem}_{TIER_NAME[tier]}", "range": 240, "cooldownMs": cooldown}
        if cat == "offense":
            ab.update(mode="offense", damage=val, inflict=[])
        elif cat == "heal":
            ab.update(mode="heal", damage=0, heal=val, range=400)
        elif cat == "shield_phys":
            ab.update(mode="shield", damage=0, shieldKind="physical", shieldHits=val, range=400)
        elif cat == "shield_psi":
            ab.update(mode="shield", damage=0, shieldKind="psi", shieldHits=val, range=400)
        elif cat == "buff":
            ab.update(mode="buff", damage=0, buffStat="offense", buffAmt=val, buffMs=20000, range=400)
        elif cat == "debuff":
            ab.update(mode="debuff", damage=0, debuffStat="defense", debuffAmt=val, debuffMs=15000)
        elif cat == "magnet":
            ab.update(mode="magnet", damage=0, drainPp=val)
        elif cat in STATUS_CAT:
            infl = [{"type": STATUS_CAT[cat], "chance": val}]
            if cat == "status_strange":  # Brainshock: strange + can't-concentrate
                infl.append({"type": "noPsi", "chance": val})
            ab.update(mode="offense", damage=0, inflict=infl)
        abilities.append(ab)
    return abilities


ALL_STATUSES = [
    "poison", "cold", "nauseous", "strange", "possessed",
    "sleep", "crying", "paralysis", "noPsi",
]

PSI_MAP = {}  # set in main() from load_psi_map()


def ability_label(ab):
    """Short human tag for the report."""
    m = ab.get("mode", "offense")
    fam = "_".join(ab["anim"].split("_")[:-1])
    if m == "offense":
        if ab.get("inflict"):
            return "PSI:" + "+".join(i["type"] for i in ab["inflict"])
        return f"PSI:{fam}~{ab.get('damage', 0)}dmg"
    if m == "heal":
        return f"PSI:heal+{ab.get('heal', 0)}"
    if m == "shield":
        return f"PSI:shield({ab.get('shieldKind', 'physical')[:4]}x{ab.get('shieldHits', 0)})"
    if m == "buff":
        return f"PSI:{ab.get('buffStat', 'offense')}+{ab.get('buffAmt', 0)}"
    if m == "debuff":
        return f"PSI:{ab.get('debuffStat', 'defense')}-{ab.get('debuffAmt', 0)}"
    if m == "magnet":
        return f"PSI:magnet-{ab.get('drainPp', 0)}pp"
    return "PSI:?"


def load_yaml(name):
    with open(os.path.join(EB, name), "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def is_real_name(name):
    if not name:
        return False
    s = str(name).strip()
    return s and s.lower() != "null"


def group_by_sprite(enemies):
    """Mirror extract_enemies.py: group real overworld configs by Overworld Sprite,
    primary = lowest level (tie: HP, then config id). Returns {sprite: (primary_cfg,
    [variant_cfgs])}."""
    by_sprite = {}
    for cid in sorted(enemies.keys(), key=lambda k: int(k)):
        cfg = enemies[cid]
        sprite = int(cfg.get("Overworld Sprite", 0) or 0)
        if sprite == 0 or not is_real_name(cfg.get("Name")):
            continue
        by_sprite.setdefault(sprite, []).append((int(cid), cfg))
    out = {}
    for sprite, cfgs in by_sprite.items():
        ordered = sorted(
            cfgs,
            key=lambda t: (int(t[1].get("Level", 0) or 0), int(t[1].get("HP", 0) or 0), t[0]),
        )
        out[sprite] = (ordered[0][1], [c for _, c in ordered[1:]])
    return out


def action_slots(cfg):
    """The 4 main action slots (non-zero) + the final action separately."""
    main = [int(cfg.get(f"Action {i}", 0) or 0) for i in (1, 2, 3, 4)]
    final = int(cfg.get("Final Action", 0) or 0)
    return [a for a in main if a], final


def build_afflictions(cfg):
    """Return (inflict_list, abilities_list, notes) for one enemy config."""
    main, final = action_slots(cfg)
    slots = main if main else []
    total = 4  # canon rotation is over the 4 main slots

    # --- melee inflicts: chance from slot frequency ---
    melee_counts = {}
    for a in slots:
        s = MELEE_ACTION_STATUS.get(a)
        if s:
            melee_counts[s] = melee_counts.get(s, 0) + 1
    # final-action-only status attacks are uncommon last resorts
    final_status = MELEE_ACTION_STATUS.get(final)

    inflict = []
    for s, cnt in sorted(melee_counts.items()):
        chance = max(10, min(90, round(100 * cnt / total)))
        inflict.append({"type": s, "chance": chance})
    if final_status and final_status not in melee_counts:
        inflict.append({"type": final_status, "chance": 12})

    # --- PSI abilities (all families: offense/heal/shield/buff/debuff/magnet/status) ---
    abilities = build_psi_abilities(slots + ([final] if final else []), PSI_MAP)

    return inflict, abilities


def main():
    global PSI_MAP
    dry = "--dry" in sys.argv
    PSI_MAP = load_psi_map()
    enemies = load_yaml("enemy_configuration_table.yml")
    grouped = group_by_sprite(enemies)

    # sprite -> {inflict?, abilities?}
    result = {}
    report_rows = []
    coverage = {s: [] for s in ALL_STATUSES}
    variant_notes = []

    for sprite in sorted(grouped):
        primary, variants = grouped[sprite]
        inflict, abilities = build_afflictions(primary)
        if not inflict and not abilities:
            continue
        entry = {}
        if inflict:
            entry["inflict"] = inflict
        if abilities:
            entry["abilities"] = abilities
        result[str(sprite)] = entry
        name = str(primary.get("Name")).strip()
        lvl = int(primary.get("Level", 0) or 0)
        parts = [f"{i['type']}({i['chance']}%)" for i in inflict]
        parts += [ability_label(ab) for ab in abilities]
        report_rows.append((sprite, name, lvl, ", ".join(parts)))
        for i in inflict:
            coverage[i["type"]].append(name)
        for ab in abilities:
            for inf in ab.get("inflict", []):
                coverage.setdefault(inf["type"], []).append(name)
        # note variants whose actions add a status the primary lacks
        for v in variants:
            vi, va = build_afflictions(v)
            vstat = {i["type"] for i in vi} | {
                inf["type"] for ab in va for inf in ab.get("inflict", [])
            }
            pstat = {i["type"] for i in inflict} | {
                inf["type"] for ab in abilities for inf in ab.get("inflict", [])
            }
            extra = vstat - pstat
            if extra:
                variant_notes.append(
                    f"  sprite {sprite} variant '{str(v.get('Name')).strip()}' also: {', '.join(sorted(extra))}"
                )

    # --- report ---
    print("=== CANON ENEMY AFFLICTIONS (per Overworld Sprite) ===")
    for sprite, name, lvl, parts in sorted(report_rows, key=lambda r: r[2]):
        print(f"  sprite {sprite:>3}  L{lvl:<3} {name:<26} {parts}")
    print(f"\nConfigured {len(result)} enemy sprites.")

    print("\n=== COVERAGE (canon inflictors per status) ===")
    for s in ALL_STATUSES:
        who = sorted(set(coverage.get(s, [])))
        print(f"  {s:<10} {len(who):>2} enemies: {', '.join(who[:6])}{' …' if len(who) > 6 else ''}")
    psi_cats = {}
    for entry in result.values():
        for ab in entry.get("abilities", []):
            m = ab.get("mode", "offense")
            key = ("status-PSI" if ab.get("inflict") else "offense-PSI") if m == "offense" else m
            psi_cats[key] = psi_cats.get(key, 0) + 1
    print("\n=== ENEMY PSI ABILITIES (canon, all families) ===")
    for k, n in sorted(psi_cats.items(), key=lambda kv: -kv[1]):
        print(f"  {k:<12} {n} casts")

    print("\n=== GAPS (no canon enemy attack - NOT fabricated) ===")
    print("  sunstroke  - Dusty Dunes desert environmental damage, not an enemy attack")
    print("  diamond    - only PK Flash's random effect table (no dedicated melee attack)")
    print("  burn       - our own addition (not an EarthBound status)")

    if variant_notes:
        print("\n=== VARIANT NOTES (palette-swaps on the same sprite w/ extra afflictions) ===")
        print("\n".join(variant_notes))

    if dry:
        print("\n[--dry] no files written.")
        return

    # --- merge into entities.json (preserve non-affliction overrides) ---
    with open(ENTITIES, "r", encoding="utf-8") as f:
        doc = json.load(f)
    ents = doc.setdefault("entities", {})
    # Strip any prior inflict/abilities everywhere (clean out old hand-authored /
    # non-canon guesses), then apply the canon set.
    for k, v in ents.items():
        v.pop("inflict", None)
        v.pop("abilities", None)
    for sprite, entry in result.items():
        ents.setdefault(sprite, {}).update(entry)
    # drop entries that are now empty
    for k in [k for k, v in ents.items() if not v]:
        del ents[k]
    doc["_note"] = (
        "Per-sprite entity overrides. `inflict`/`abilities` are CANON-derived by "
        "tools/extract_enemy_afflictions.py (do not hand-edit those; re-run the tool). "
        "Other keys (stats/combat) are hand-authored via the Entity Manager."
    )
    with open(ENTITIES, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\nWrote {ENTITIES} ({len(result)} sprites with afflictions).")


if __name__ == "__main__":
    main()
