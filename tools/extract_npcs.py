"""
Build the NPC/prop placement list for the engine.

Joins eb_project/map_sprites.yml (per-area sprite placements; areas are a
32-wide grid of 256x256-pixel cells, same layout as door areas) with
eb_project/npc_config_table.yml (NPC id -> sprite group, facing direction,
visibility condition).

Visibility matches the world state baked into tiles.json by
tools/apply_map_changes.py (open world, post-intro) plus SET_FLAGS below:
    - Show Sprite "always"                -> included
    - "when event flag unset"             -> included unless flag in SET_FLAGS
    - "when event flag set"               -> included only if flag in SET_FLAGS
Kinds: Type "person" -> kind "person" (gets life/health bar in engine);
"object"/"item" with a real sprite -> kind "prop" (static scenery, no bar).

Props whose configured facing has no art in the sheet (single-pose objects)
get their direction rebaked to the first cardinal that has pixels.

Anchor semantics (THIRD attempt — see bugs.md "Props placed wrong", twice):
ALL placements — person, object, item — are the sprite's center-x, and the
feet sit 8px BELOW the raw Y: feet-y = Y + 8. Solved statistically by
tools/debug_person_anchor_stats.py: persons always stand on walkable ground,
and (+0,+8) leaves only 7.0% of 1084 person foot boxes on solids (sitting
NPCs etc.) vs 31.5% for raw pass-through and ~20% for every sprite-size-
relative hypothesis. Earlier interpretations (top-left + (w/2,h); then raw
pass-through) each looked "verified" from one or two hand-picked props —
beware single-prop verification, only the map-wide statistic is trustworthy.
Note many object placements are invisible interaction hotspots —
phones/signs are drawn as map tiles and the NPC just carries the check text.

Output: public/assets/map/npcs.json — [{k, x, y, sprite, dir, kind, t?}, ...]
in world pixels (x = sprite center, y = feet, matching drawSprite's anchor).
`k` is the STABLE placement identity "<areaIdx>:<npcConfigId>:<occurrence>"
that the editor overrides layer (public/overrides/npcs.json) keys edits by —
it survives anchor fixes and flag-state changes (the occurrence counter runs
over every raw placement, before any include filter), so re-extraction never
orphans authored overrides. Engine + npcSim merge overrides at load.
`t` is the NPC config id, present only when the NPC has talk/check dialogue;
it keys public/assets/map/npc_text.json — {t: [page, ...]} — decoded from
the ccscript dump (Text Pointer 1, the talk/check script; Text Pointer 2 is
the use-item-on-NPC script and is not player dialogue) by eb_dialogue.py
under the same world flag state.

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_npcs.py
"""
import json
from collections import Counter
from pathlib import Path

import yaml
from PIL import Image

import eb_dialogue

ROOT = Path(__file__).resolve().parent.parent
EB = ROOT / "eb_project"
SPRITES = ROOT / "public" / "assets" / "sprites"
OUT = ROOT / "public" / "assets" / "map" / "npcs.json"
OUT_TEXT = ROOT / "public" / "assets" / "map" / "npc_text.json"

AREA_GRID_COLS = 32
AREA_PX = 256

# Event flags considered SET in our world — single source of truth shared
# with the engine's DoorManager (and consistent with apply_map_changes.py).
SET_FLAGS = {
    int(f, 16)
    for f in json.load(open(ROOT / "src" / "world_flags.json"))["setFlags"]
}

DIRECTIONS = {
    "down": 0,        # Direction.S
    "up": 1,          # Direction.N
    "left": 2,        # Direction.W
    "right": 3,       # Direction.E
    "down-left": 5,   # Direction.SW
    "down-right": 6,  # Direction.SE
    "up-left": 4,     # Direction.NW
    "up-right": 7,    # Direction.NE
}

# Direction -> frame-0 cell (row, col) in the 4x4 sheet, cardinals only.
DIR_CELL = {0: (1, 0), 1: (0, 0), 2: (1, 2), 3: (0, 2)}

_meta = {m["id"]: m for m in json.load(open(SPRITES / "metadata.json"))}
_frame_px = {}  # (sprite, dir) -> opaque pixel count


def frame_pixels(sprite, d):
    key = (sprite, d)
    if key not in _frame_px:
        m = _meta.get(sprite)
        path = SPRITES / f"{sprite}.png"
        if not m or not path.exists() or d not in DIR_CELL:
            _frame_px[key] = 0
        else:
            img = Image.open(path).convert("RGBA")
            row, col = DIR_CELL[d]
            w, h = m["width"], m["height"]
            crop = img.crop((col * w, row * h, (col + 1) * w, (row + 1) * h))
            _frame_px[key] = sum(1 for p in crop.getdata() if p[3] > 0)
    return _frame_px[key]


def visible_dir(sprite, want):
    """A direction whose frame actually has art (single-pose props often
    only fill one cell)."""
    candidates = [want if want in DIR_CELL else 0, 0, 1, 2, 3]
    for d in candidates:
        if frame_pixels(sprite, d) >= 10:
            return d
    return want


_dialogue_cache = {}  # NPC config id -> [page, ...] (possibly empty)


def npc_dialogue(npc_id, cfg):
    if npc_id not in _dialogue_cache:
        _dialogue_cache[npc_id] = eb_dialogue.decode(cfg["Text Pointer 1"], SET_FLAGS)
    return _dialogue_cache[npc_id]


def main():
    placements = yaml.safe_load(open(EB / "map_sprites.yml"))
    config = yaml.safe_load(open(EB / "npc_config_table.yml"))

    npcs = []
    text_map = {}
    skipped = Counter()
    # map_sprites.yml is {areaRow: {areaCol: [placements]}} (40 rows x 32 cols)
    flat = []
    for row, cols in placements.items():
        for col, entries in (cols or {}).items():
            if entries:
                flat.append((row * AREA_GRID_COLS + col, entries))
    occurrence = Counter()  # (areaIdx, npcId) -> nth raw placement
    for area_idx, entries in flat:
        ox = (area_idx % AREA_GRID_COLS) * AREA_PX
        oy = (area_idx // AREA_GRID_COLS) * AREA_PX
        for e in entries:
            # Stable identity for the overrides layer. Counted over EVERY raw
            # placement (before any skip/filter) so keys don't shift when a
            # flag change includes a previously-skipped placement.
            occ_key = (area_idx, e["NPC ID"])
            key = f"{area_idx}:{e['NPC ID']}:{occurrence[occ_key]}"
            occurrence[occ_key] += 1

            cfg = config.get(e["NPC ID"])
            if cfg is None:
                skipped["no config"] += 1
                continue

            if cfg["Type"] == "person":
                kind = "person"
            elif cfg["Type"] in ("object", "item"):
                kind = "prop"
            else:
                skipped[f"type {cfg['Type']}"] += 1
                continue

            show, flag = cfg["Show Sprite"], cfg["Event Flag"]
            included = (
                show == "always"
                or (show == "when event flag unset" and flag not in SET_FLAGS)
                or (show == "when event flag set" and flag in SET_FLAGS)
            )
            if not included:
                skipped[f"show '{show}'"] += 1
                continue

            sprite = cfg["Sprite"]
            if not sprite or sprite not in _meta:
                skipped["no sprite"] += 1
                continue

            d = DIRECTIONS.get(cfg["Direction"], 0)
            # Feet are 8px below the raw Y (see anchor semantics above).
            x, y = ox + e["X"], oy + e["Y"] + 8
            if kind == "prop":
                d = visible_dir(sprite, d)
            elif frame_pixels(sprite, d if d in DIR_CELL else 0) < 10:
                skipped["invisible person frame"] += 1
                continue

            entry = {
                "k": key,
                "x": x,
                "y": y,
                "sprite": sprite,
                "dir": d,
                "kind": kind,
            }
            pages = npc_dialogue(e["NPC ID"], cfg)
            if pages:
                entry["t"] = e["NPC ID"]
                text_map[e["NPC ID"]] = pages
            npcs.append(entry)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(npcs, f)
    with open(OUT_TEXT, "w", encoding="utf-8") as f:
        json.dump(text_map, f, ensure_ascii=False)

    kinds = Counter(n["kind"] for n in npcs)
    talkers = sum(1 for n in npcs if "t" in n)
    print(f"Wrote {len(npcs)} entries to {OUT} ({dict(kinds)})")
    print(f"Dialogue: {talkers} placements, {len(text_map)} scripts -> {OUT_TEXT}")
    print(f"Unique sprite groups: {len({n['sprite'] for n in npcs})}")
    for reason, count in skipped.most_common():
        print(f"  skipped {count}: {reason}")


if __name__ == "__main__":
    main()
