"""
Per-minitile collision flag map for a tile rectangle.
Each minitile prints one char:
  .  empty            #  solid only (0x80)
  1  0x01 (lower half behind FG)   2  0x02 (upper behind)  3  both
  uppercase A/B/C = same flags but ALSO solid (A=1+solid, B=2+solid, C=3+solid)
  f  FG pixels flag (0x10) only, no solid/priority

Usage: python tools/debug_pri_flags.py x0 y0 x1 y1   (tile coords)
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles_arr = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())

MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

def byte_at(mtx, mty):
    tx, ty = mtx >> 2, mty >> 2
    sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
    cols = get_collisions(mapping[sec["tilesetId"]])
    arr = tiles_arr[ty * MAP_W_T + tx]
    if arr >= len(cols):
        return 0x80
    return cols[arr][(mty & 3) * 4 + (mtx & 3)]

def ch(b):
    pri = b & 0x03
    solid = b & 0x80
    if pri:
        if solid:
            return "ABC"[pri - 1]
        return "123"[pri - 1]
    if solid:
        return "#"
    if b & 0x10:
        return "f"
    return "."

x0, y0, x1, y1 = map(int, sys.argv[1:5])
print("    " + "".join(f"{tx%100:02d}  " for tx in range(x0, x1 + 1)))
for mty in range(y0 * 4, (y1 + 1) * 4):
    row = "".join(ch(byte_at(mtx, mty)) for mtx in range(x0 * 4, (x1 + 1) * 4))
    mark = f"y{mty//4:<3d}" if mty % 4 == 0 else "    "
    print(mark + row)
