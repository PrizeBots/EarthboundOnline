#!/usr/bin/env python3
"""
extract_condiments.py — bake EarthBound's condiment table into a runtime JSON.

EarthBound seasons food: eating a food WITH a condiment adds a bonus to its
recovery. The ROM (CoilSnake `condiment_table.yml`) maps each food to:
  - condiment 1: the UNIVERSAL good condiment (always Jar of delisauce, id 126)
  - condiment 2: that food's SPECIFIC preferred condiment (e.g. fries -> ketchup)
  - good recover: bonus added when seasoned with condiment 1 OR 2
  - bad recover : bonus when seasoned with any OTHER condiment (usually +2)
  - effect      : restore hp | restore pp | restore hp/pp | increase random stat

We emit `public/assets/map/condiments.json` keyed by food id:
  { "version":1,
    "condiments":[118,119,120,121,122,123,124,126],   # all type-40 condiment ids
    "universal":126,                                    # delisauce works on everything
    "byFood": { "89": {"pref":118,"good":8,"bad":2,"effect":"hp"}, ... } }

`effect` is normalized to hp/pp/hppp/stat. The server (gameHost use_item) reads
this to auto-apply the best condiment a player carries. ROM-derived data —
regenerate with this tool, don't hand-edit. See ARCHITECTURE.md (Consumable effects).
"""
import json
import os
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "eb_project", "condiment_table.yml")
ITEMS = os.path.join(ROOT, "eb_project", "item_configuration_table.yml")
OUT = os.path.join(ROOT, "public", "assets", "map", "condiments.json")

DELISAUCE = 126  # condiment 1 for every food — the universal "good" seasoning
CONDIMENT_TYPE = 40  # EB item Type for condiments

EFFECT = {
    "restore hp": "hp",
    "restore pp": "pp",
    "restore hp/pp": "hppp",
    "increase random stat": "stat",
}


def main():
    tbl = yaml.safe_load(open(SRC, encoding="utf-8"))
    items = yaml.safe_load(open(ITEMS, encoding="utf-8"))

    # All condiment item ids (type 40), so the server knows what counts as a
    # condiment in a player's bag without re-deriving it.
    condiments = sorted(
        int(k)
        for k, it in items.items()
        if isinstance(it, dict) and it.get("Type") == CONDIMENT_TYPE
    )

    by_food = {}
    for _, e in tbl.items():
        if not isinstance(e, dict):
            continue
        food = e.get("food")
        eff = EFFECT.get(e.get("effect"))
        if food is None or eff is None:
            continue
        pref = e.get("condiment 2") or 0  # 0/Null => only delisauce seasons it
        good = int(e.get("good recover") or 0)
        bad = int(e.get("bad recover") or 0)
        # `stat` (Rock candy) is handled by our skill-point path, not seasoning;
        # and a 0/0 entry (Brain food lunch) can't be improved — skip both so the
        # runtime map only holds foods a condiment actually helps.
        if eff == "stat" or (good == 0 and bad == 0):
            continue
        by_food[str(food)] = {"pref": int(pref), "good": good, "bad": bad, "effect": eff}

    out = {
        "version": 1,
        "_note": "ROM-derived (tools/extract_condiments.py). good=bonus for delisauce/preferred; bad=any other.",
        "universal": DELISAUCE,
        "condiments": condiments,
        "byFood": by_food,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"wrote {OUT}: {len(by_food)} seasonable foods, {len(condiments)} condiments")


if __name__ == "__main__":
    main()
