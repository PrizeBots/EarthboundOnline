"""
extract_psi.py — build the PSI catalog (public/assets/map/psi.json) from the
CoilSnake decomp tables.

Canon sources (eb_project/):
  * psi_ability_table.yml  — one row per PSI (name index + strength tier),
                             the LEVEL each of Ness/Paula/Poo learns it, the
                             battle Action id, and out-of-battle usability.
  * psi_name_table.yml     — the family names ("Lifeup", "PSI Freeze", …);
                             index 0 = "PSI(????)" (the personalized
                             Rockin/Starstorm-type move).
  * battle_action_table.yml — PP cost + target + direction, keyed by Action id.

What the ROM does NOT give (stays in ASM at the action's Code Address): the
actual effect math + any status it inflicts. So this catalog is names / tiers /
learn-levels / PP / target — the data we CAN read — and the per-ability EFFECT
(heal amount, projectile, status proc) is authored on our side.

NOTE: our players aren't Ness/Paula/Poo — they're custom characters. The learn
levels are a faithful REFERENCE template (and what the PSI animation editor lists
to author art against), not a 1:1 acquisition table for our progression.

Output is the DEFAULTS layer; authored effect/anim data merges over it.

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_psi.py
"""
import json
import os
import re
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EB = os.path.join(ROOT, "eb_project")
ABIL = os.path.join(EB, "psi_ability_table.yml")
NAMES = os.path.join(EB, "psi_name_table.yml")
ACTIONS = os.path.join(EB, "battle_action_table.yml")
OUT_PATH = os.path.join(ROOT, "public", "assets", "map", "psi.json")

# Strength tier -> the Greek suffix EarthBound shows after the name.
GREEK = {"alpha": "α", "beta": "β", "gamma": "γ", "omega": "Ω"}
TIER_ORDER = {"none": 0, "alpha": 1, "beta": 2, "gamma": 3, "omega": 4}


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def slug(name):
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower())).strip("_")


def main():
    abilities = load(ABIL)
    names = load(NAMES)
    actions = load(ACTIONS)

    name_of = {int(k): str(v.get("Name", "")).strip() for k, v in names.items()}

    out = []
    for aid in sorted(abilities.keys(), key=lambda k: int(k)):
        row = abilities[aid]
        name_idx = row.get("PSI Name")
        if name_idx is None or str(name_idx).lower() == "null":
            continue  # the empty/placeholder ability slot
        base = name_of.get(int(name_idx), f"PSI {name_idx}")
        strength = str(row.get("Strength", "none")).strip().lower()
        suffix = GREEK.get(strength, "")
        display = (base + (" " + suffix if suffix else "")).strip()

        action_id = int(row.get("Action", 0) or 0)
        act = actions.get(action_id, {}) or {}

        learn = {
            "ness": int(row.get("Level learned by Ness", 0) or 0),
            "paula": int(row.get("Level learned by Paula", 0) or 0),
            "poo": int(row.get("Level learned by Poo", 0) or 0),
        }
        types = row.get("Type") or []
        if isinstance(types, str):
            types = [types]

        out.append(
            {
                "id": f"{slug(base)}_{strength}",
                "name": base,
                "displayName": display,
                "strength": strength,
                "type": [str(t).strip() for t in types],
                "pp": int(act.get("PP Cost", 0) or 0),
                "target": str(act.get("Target", "")).strip(),
                "direction": str(act.get("Direction", "")).strip(),
                "learn": learn,
                "usableOutside": str(row.get("Usability Outside of Battle", "")).strip(),
                "actionId": action_id,
            }
        )

    # Stable order: by family (name), then strength tier.
    out.sort(key=lambda e: (e["name"], TIER_ORDER.get(e["strength"], 9)))

    doc = {
        "version": 1,
        "_note": "ROM-derived PSI catalog (names/tiers/learn-levels/PP/target). "
        "Effect + animation are authored on our side (psi_anim.json / overrides).",
        "abilities": out,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)

    print(f"Wrote {OUT_PATH}")
    print(f"  PSI abilities: {len(out)}")
    for e in out:
        if e["name"] == "Lifeup":
            print(f"  [{e['id']}] {e['strength']}  pp={e['pp']}  Ness Lv{e['learn']['ness']}")


if __name__ == "__main__":
    sys.exit(main())
