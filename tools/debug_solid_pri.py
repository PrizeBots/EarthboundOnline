"""
Map-wide sweep for the head-clip hazard: SOLID minitiles carrying sprite
priority bits (0x01/0x02) that sit within 2 minitile rows ABOVE walkable
ground — i.e. places where the 16px-tall priority sample box of a sprite
pressed against the furniture used to pick up the solid tile's flags.

Prints total count and per-region tallies (tile coords of hotspots).
"""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles_arr = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())

MAP_W_SEC, MAP_H_SEC = 32, 80
SEC_TX, SEC_TY = 8, 4
MAP_W_T, MAP_H_T = MAP_W_SEC * SEC_TX, MAP_H_SEC * SEC_TY
MAP_W_MT, MAP_H_MT = MAP_W_T * 4, MAP_H_T * 4

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

def byte_at(mtx, mty):
    if not (0 <= mtx < MAP_W_MT and 0 <= mty < MAP_H_MT):
        return 0x80
    tx, ty = mtx >> 2, mty >> 2
    sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
    cols = get_collisions(mapping[sec["tilesetId"]])
    arr = tiles_arr[ty * MAP_W_T + tx]
    if arr >= len(cols):
        return 0x80
    return cols[arr][(mty & 3) * 4 + (mtx & 3)]

total = 0
hazards = 0
regions = Counter()
for mty in range(MAP_H_MT):
    for mtx in range(MAP_W_MT):
        b = byte_at(mtx, mty)
        if (b & 0x80) and (b & 0x03):
            total += 1
            # walkable ground within the 2 rows below => sprite can press up
            if any((byte_at(mtx + dx, mty + dy) & 0x80) == 0
                   for dy in (1, 2) for dx in (-1, 0, 1)):
                hazards += 1
                regions[(mtx // 32, mty // 32)] += 1  # 8x8-tile region buckets

print(f"solid minitiles with priority bits: {total}")
print(f"...reachable from below (head-clip hazard): {hazards}")
print(f"hazard regions ({len(regions)}), top 25 by count (region = 8x8 tiles):")
for (rx, ry), n in regions.most_common(25):
    print(f"  tiles ~({rx*8},{ry*8})  px ~({rx*256},{ry*256})  count {n}")
