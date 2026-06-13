"""
Print the collision minitile grid around a prop placement to find the true
anchor convention. EB sprites add no collision — the MAP carries solid
minitiles where a pole/ATM/mailbox stands — so the correct interpretation of
a map_sprites.yml (X, Y) drops the prop base exactly onto those solids.

Usage: debug_prop_anchor.py <rawX> <rawY>   (raw map_sprites coords)
Legend: '#' solid (0x80), '.' walkable, digits mark candidate anchors:
  R = raw point as-is
  Each cell shows the minitile the candidate lands in.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())
cols_cache = {}

MAP_W_SEC, SEC_TX, SEC_TY = 32, 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX


def collision_at(px, py):
    mx, my = px // 8, py // 8
    tx, ty = mx // 4, my // 4
    sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
    draw = mapping[sec["tilesetId"]]
    if draw not in cols_cache:
        cols_cache[draw] = json.loads((A / "tilesets" / str(draw) / "collisions.json").read_text())
    arr = tiles[ty * MAP_W_T + tx]
    cols = cols_cache[draw]
    if arr >= len(cols):
        return 0
    return cols[arr][(my % 4) * 4 + (mx % 4)]


raw_x, raw_y = int(sys.argv[1]), int(sys.argv[2])
R = 6  # minitiles around the raw point
mx0, my0 = raw_x // 8 - R, raw_y // 8 - R

print(f"raw placement ({raw_x},{raw_y}); grid = 8px minitiles; '#'=solid '.'=walkable")
for my in range(my0, my0 + 2 * R + 1):
    row = ""
    for mx in range(mx0, mx0 + 2 * R + 1):
        c = collision_at(mx * 8, my * 8)
        ch = "#" if c & 0x80 else "."
        if mx == raw_x // 8 and my == raw_y // 8:
            ch = "R" if ch == "." else "@"  # @ = raw point on solid
        row += ch
    print(row)
