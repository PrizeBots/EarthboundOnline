"""
Solve the true map_sprites.yml anchor convention empirically.

Persons in EB always stand on walkable ground (their wander AI moves on the
same collision the player uses), so the correct (dx, dy) interpretation of a
placement is the one where ~every person's foot box lands on walkable
minitiles map-wide. Props can't be used: ATMs/signs/poles intentionally sit
on solid furniture tiles.

For each candidate offset, a person at raw (X, Y) gets feet at
(X + dx, Y + dy); the engine foot box is 14x8 ending at the feet, so we
sample the box center (feetX, feetY - 4) plus the two bottom corners.

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/debug_person_anchor_stats.py
"""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
EB = ROOT / "eb_project"

sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())
meta = {m["id"]: m for m in json.loads((A / "sprites" / "metadata.json").read_text())}
cols_cache = {}

MAP_W_SEC, SEC_TX, SEC_TY = 32, 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX
AREA_GRID_COLS, AREA_PX = 32, 256


def collision_at(px, py):
    if px < 0 or py < 0:
        return 0x80
    mx, my = px // 8, py // 8
    tx, ty = mx // 4, my // 4
    sec_idx = (ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)
    if sec_idx >= len(sectors):
        return 0x80
    sec = sectors[sec_idx]
    draw = mapping[sec["tilesetId"]]
    if draw not in cols_cache:
        cols_cache[draw] = json.loads(
            (A / "tilesets" / str(draw) / "collisions.json").read_text()
        )
    t_idx = ty * MAP_W_T + tx
    if t_idx >= len(tiles):
        return 0x80
    arr = tiles[t_idx]
    cols = cols_cache[draw]
    if arr >= len(cols):
        return 0
    return cols[arr][(my % 4) * 4 + (mx % 4)]


def foot_blocked(feet_x, feet_y):
    """Sample the engine's 14x8 foot box (center + bottom corners)."""
    for sx, sy in ((0, -4), (-6, -1), (6, -1)):
        if collision_at(feet_x + sx, feet_y + sy) & 0x80:
            return True
    return False


def main():
    placements = yaml.safe_load(open(EB / "map_sprites.yml"))
    config = yaml.safe_load(open(EB / "npc_config_table.yml"))

    persons = []
    for row, cols in placements.items():
        for col, entries in (cols or {}).items():
            for e in entries or []:
                cfg = config.get(e["NPC ID"])
                if not cfg or cfg["Type"] != "person":
                    continue
                sprite = cfg["Sprite"]
                if sprite not in meta:
                    continue
                x = col * AREA_PX + e["X"]
                y = row * AREA_PX + e["Y"]
                persons.append((x, y, meta[sprite]["width"], meta[sprite]["height"]))

    print(f"{len(persons)} person placements")
    print(f"{'offset':>16} {'blocked':>8} {'pct':>7}")

    candidates = []
    for dy in (-24, -16, -8, 0, 8, 12, 16, 24):
        for dx in (-8, 0, 8):
            candidates.append((f"({dx:+d},{dy:+d})", dx, dy, False))
    # Sprite-size-relative hypotheses (h = sprite height, w = width)
    candidates += [
        ("(0,+h/2) ctr-ctr", 0, None, "h2"),
        ("(0,+h) top-feet", 0, None, "h"),
        ("(+w/2,+h) topleft", None, None, "tlwh"),
    ]

    for label, dx, dy, mode in candidates:
        blocked = 0
        for x, y, w, h in persons:
            if mode == "h2":
                fx, fy = x, y + h // 2
            elif mode == "h":
                fx, fy = x, y + h
            elif mode == "tlwh":
                fx, fy = x + w // 2, y + h
            else:
                fx, fy = x + dx, y + dy
            if foot_blocked(fx, fy):
                blocked += 1
        pct = 100 * blocked / len(persons)
        print(f"{label:>16} {blocked:>8} {pct:>6.1f}%")


if __name__ == "__main__":
    main()
