"""
Build the item-container catalog for the engine (presents, trash cans, jars,
crates… — everything you "open"/"check" for an item).

In EarthBound every item-container is a "Type: item" TPT entry. They share ONE
mechanism and differ only by overworld sprite group (the container's look):
    195 present box (opens to 196), 214 trash can, 233 gift box, 262 crate,
    322 jar, 33 small container, …
(Sprite-195 entries that are Type "person" are people, not containers — skipped.)

Each container's data lives entirely in its npc_config_table.yml entry:
    - Event Flag   -> the ROM's per-container "opened" flag (its stable identity).
    - Text Pointer 2 -> the CONTENTS: a "$XX" hex value = item id (0-253). All
                      containers share a generic opener (data_32.l_0xc7d84f …),
                      so the item is NOT in the script — it's this field.
    - A few carry a 2-byte Text Pointer 2 ($10a/$4e8 …) out of item range: those
                      are SPECIAL (custom script — money/story/trap). Marked
                      `special: true`, item=null — author them in Gift Manager.

Placements (world x/y + stable key `k`, + the container `sprite`) come straight
from public/assets/map/npcs.json so each `k` matches its rendered prop exactly.
Engine + Gift Manager merge overrides/gifts.json on top (same overrides pattern).

Output: public/assets/map/gifts.json
    [{k, x, y, sprite, romFlag, item, itemName, special?}, ...]

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_gifts.py
"""
import json
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
EB = ROOT / "eb_project"
MAP = ROOT / "public" / "assets" / "map"
NPCS = MAP / "npcs.json"
OUT = MAP / "gifts.json"

MAX_ITEM_ID = 253          # item_configuration_table.yml is 0..253


def item_id_from_tp2(tp2):
    """Text Pointer 2 holds the item id as '$XX' hex. Returns (id|None)."""
    if not isinstance(tp2, str) or not tp2.startswith("$"):
        return None
    try:
        return int(tp2[1:], 16)
    except ValueError:
        return None


def main():
    config = yaml.safe_load(open(EB / "npc_config_table.yml"))
    items = yaml.safe_load(open(EB / "item_configuration_table.yml"))
    npcs = json.load(open(NPCS))

    def item_name(i):
        e = items.get(i)
        return e.get("Name") if isinstance(e, dict) else None

    gifts = []
    resolved = special = skipped = 0
    for n in npcs:
        npc_id = int(n["k"].split(":")[1])
        cfg = config.get(npc_id)
        # Every item-container (present, trash can, jar, crate…) is a "Type: item"
        # TPT entry; they differ only by sprite group. Non-item props are scenery.
        if not isinstance(cfg, dict) or cfg.get("Type") != "item":
            skipped += 1
            continue

        item = item_id_from_tp2(cfg.get("Text Pointer 2"))
        name = item_name(item) if item is not None else None
        gift = {
            "k": n["k"],
            "x": n["x"],
            "y": n["y"],
            "sprite": n["sprite"],  # container type (195 present, 214 trash can, …)
            "romFlag": cfg.get("Event Flag"),
        }
        if name is not None and 0 <= item <= MAX_ITEM_ID:
            gift["item"] = item
            gift["itemName"] = name
            resolved += 1
        else:
            # Special present (2-byte Text Pointer 2 = custom script). Don't
            # guess the contents — surface it for manual authoring.
            gift["item"] = None
            gift["special"] = True
            gift["rawTp2"] = cfg.get("Text Pointer 2")
            special += 1
        gifts.append(gift)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(gifts, f, ensure_ascii=False)

    by_sprite = Counter(g["sprite"] for g in gifts)
    print(f"Wrote {len(gifts)} containers to {OUT}")
    print(f"  contents resolved: {resolved}")
    print(f"  special (author manually): {special}")
    print(f"  non-item props skipped: {skipped}")
    print(f"  by container sprite: {dict(by_sprite)}")


if __name__ == "__main__":
    main()
