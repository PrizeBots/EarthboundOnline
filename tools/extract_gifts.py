"""
Build the gift/present catalog for the engine.

EarthBound gift boxes ("presents") are TPT entries that use overworld sprite
group 195 (the closed box; 196 is the opened-box frame) with Type "item". Two
sprite-195 entries are people (Type "person") and are NOT gifts — they're
excluded here.

Each present's data lives entirely in its npc_config_table.yml entry:
    - Event Flag   -> the ROM's per-present "已开" flag (unique per box, ~800-976).
                      We use it as the gift's stable ROM identity.
    - Text Pointer 2 -> the CONTENTS: a "$XX" hex value that is the item id
                      (0-253). All real presents share Text Pointer 1
                      (data_32.l_0xc7d84f, the generic opener), so the item is
                      NOT in the script — it's this field.
    - A few presents carry a 2-byte Text Pointer 2 ($10a/$105/$4e8 ...) that is
                      out of item range: those are SPECIAL presents that run a
                      custom script (money/story item/trap). We mark them
                      `special: true` with item=null rather than guess — author
                      their contents in the Gift Manager editor tool.

Placements (world x/y + stable key `k`) come straight from the already-extracted
public/assets/map/npcs.json so a gift's `k` matches its rendered prop exactly
(same key scheme tools/extract_npcs.py mints). Engine + Gift Manager merge
overrides/gifts.json on top, same overrides-layer pattern as enemies.json.

Output: public/assets/map/gifts.json
    [{k, x, y, romFlag, item, itemName, special?}, ...]

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_gifts.py
"""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
EB = ROOT / "eb_project"
MAP = ROOT / "public" / "assets" / "map"
NPCS = MAP / "npcs.json"
OUT = MAP / "gifts.json"

GIFT_SPRITE = 195          # closed present box (196 = opened frame)
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
        if n.get("sprite") != GIFT_SPRITE:
            continue
        npc_id = int(n["k"].split(":")[1])
        cfg = config.get(npc_id)
        if not isinstance(cfg, dict) or cfg.get("Type") != "item":
            skipped += 1  # the sprite-195 "person" decoys
            continue

        item = item_id_from_tp2(cfg.get("Text Pointer 2"))
        name = item_name(item) if item is not None else None
        gift = {
            "k": n["k"],
            "x": n["x"],
            "y": n["y"],
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

    print(f"Wrote {len(gifts)} gifts to {OUT}")
    print(f"  contents resolved: {resolved}")
    print(f"  special (author manually): {special}")
    print(f"  sprite-195 non-gift entries skipped: {skipped}")


if __name__ == "__main__":
    main()
