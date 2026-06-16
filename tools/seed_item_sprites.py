"""
seed_item_sprites.py — give every catalog item a visible PLACEHOLDER sprite.

Most of the 253 EarthBound items have no authored held-art, so they're invisible
in the Item Manager / Sprite Editor and fall back to a sparkle as a ground drop.
This seeds each unseeded item with a simple category icon (shape by equip slot,
color varied by id) so nothing is blank. These are deliberate PLACEHOLDERS, not
final art — re-draw any item in the Sprite Editor and that authored entry wins
(this script never overwrites an entry that already has pixels).

Writes public/overrides/item_sprites.json (our own art layer; not ROM-derived).

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/seed_item_sprites.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOPS = os.path.join(ROOT, "public", "assets", "map", "shops.json")
CUSTOM = os.path.join(ROOT, "public", "overrides", "custom_items.json")
OUT = os.path.join(ROOT, "public", "overrides", "item_sprites.json")

# ITEM_PALETTE indices (see src/engine/Items.ts): 0 clear, 1 black, 3 wood,
# 6 metal, 8 red, 9 green, a blue, b yellow, c orange, d purple, e silver.
# Template chars: '.' clear, 'o' outline(1), 'h' wood(3), 'X' per-item fill.
TEMPLATES = {
    "weapon": [
        "................",
        ".............oo.",
        "............oXo.",
        "...........oXXo.",
        "..........oXXo..",
        ".........oXXo...",
        "........oXXo....",
        ".......oXXo.....",
        "......oXXo......",
        ".....oXXo.......",
        "....oXXo........",
        "...oXho.........",
        "...ohho.........",
        "..ohho..........",
        "..oo............",
        "................",
    ],
    "body": [
        "................",
        "................",
        "...oo....oo.....",
        "..oXXo..oXXo....",
        ".oXXXXooXXXXo...",
        ".oXXXXXXXXXXo...",
        ".oXXXXXXXXXXo...",
        ".oXXXXXXXXXXo...",
        ".oXXXXXXXXXXo...",
        "..oXXXXXXXXo....",
        "..oXXXXXXXXo....",
        "..oXXXXXXXXo....",
        "..oXXXXXXXXo....",
        "...oooooooo.....",
        "................",
        "................",
    ],
    "arms": [
        "................",
        "................",
        "................",
        "....oooooo......",
        "..ooXXXXXXoo....",
        ".oXXoooooooXo...",
        ".oXo......oXo...",
        ".oXo......oXo...",
        ".oXo......oXo...",
        ".oXXoooooooXo...",
        "..ooXXXXXXoo....",
        "....oooooo......",
        "................",
        "................",
        "................",
        "................",
    ],
    "other": [
        "................",
        "......oooo......",
        ".....oXXXXo.....",
        "....oXXXXXXo....",
        "....oXXXXXXo....",
        "....oXXXXXXo....",
        ".....oXXXXo.....",
        "......oXXo......",
        ".......oo.......",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ],
    # consumables / key items / everything without an equip slot
    "item": [
        "................",
        "................",
        ".....oooo.......",
        "...ooXXXXoo.....",
        "..oXXXXXXXXo....",
        "..oXXXXXXXXo....",
        ".oXXXXXXXXXXo...",
        ".oXXXXXXXXXXo...",
        ".oXXXXXXXXXXo...",
        "..oXXXXXXXXo....",
        "..oXXXXXXXXo....",
        "...ooXXXXoo.....",
        ".....oooo.......",
        "................",
        "................",
        "................",
    ],
}

GRIPS = {
    "weapon": {"x": 3, "y": 13},
    "body": {"x": 8, "y": 8},
    "arms": {"x": 8, "y": 8},
    "other": {"x": 8, "y": 8},
    "item": {"x": 8, "y": 11},
}

# Fill colors cycled per item so neighbors differ (ITEM_PALETTE hex indices).
FILLS = ["8", "9", "a", "b", "c", "d", "6", "e", "4", "7"]

CHAR_TO_INDEX = {".": "0", "o": "1", "h": "3"}


def render(template, fill):
    """Template chars -> 16 rows of 16 hex (ITEM_PALETTE) indices."""
    rows = []
    for line in template:
        assert len(line) == 16, f"row not 16 wide: {line!r}"
        rows.append("".join(fill if c == "X" else CHAR_TO_INDEX[c] for c in line))
    assert len(rows) == 16
    return rows


def category(item):
    eq = item.get("equip")
    if eq and eq.get("slot") in TEMPLATES:
        return eq["slot"]
    return "item"


def has_pixels(entry):
    if not isinstance(entry, dict):
        return False
    if isinstance(entry.get("pixels"), list) and entry["pixels"]:
        return True
    frames = entry.get("frames")
    return isinstance(frames, list) and any(f for f in frames)


def main():
    shops = json.load(open(SHOPS, encoding="utf-8"))
    items = shops.get("items", {})

    existing = {}
    if os.path.exists(OUT):
        existing = json.load(open(OUT, encoding="utf-8"))

    # All ids needing a sprite: catalog + any custom-minted items.
    ids = list(items.keys())
    if os.path.exists(CUSTOM):
        cdata = json.load(open(CUSTOM, encoding="utf-8"))
        for it in cdata.get("items", []):
            if it.get("id"):
                ids.append(it["id"])

    out = dict(existing)  # keep every authored entry untouched
    seeded = 0
    for i, item_id in enumerate(ids):
        if item_id in out and has_pixels(out[item_id]):
            continue  # already has real (or seeded) art — leave it
        cat = category(items.get(item_id, {}))
        fill = FILLS[(int(item_id) if str(item_id).isdigit() else i) % len(FILLS)]
        pixels = render(TEMPLATES[cat], fill)
        out[item_id] = {"pixels": pixels, "grip": GRIPS[cat], "_placeholder": True}
        seeded += 1

    json.dump(out, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"Wrote {OUT}")
    print(f"  total entries: {len(out)}  (seeded {seeded} new placeholders, kept {len(out) - seeded})")


if __name__ == "__main__":
    main()
