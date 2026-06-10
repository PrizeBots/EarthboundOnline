"""Per-minitile collision bytes + FG-atlas pixel coverage for a tile region.
Usage: debug_tile_info.py tx0 ty0 tx1 ty1
"""
import json, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())

MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

fg_cache = {}
def fg_opaque(key, arr):
    if key not in fg_cache:
        p = A / "atlases" / f"{key}_fg.png"
        fg_cache[key] = Image.open(p).convert("RGBA") if p.exists() else None
    atlas = fg_cache[key]
    if atlas is None:
        return -1
    sx, sy = (arr % 32) * 32, (arr // 32) * 32
    return sum(1 for px in atlas.crop((sx, sy, sx + 32, sy + 32)).getdata() if px[3] > 0)

tx0, ty0, tx1, ty1 = map(int, sys.argv[1:5])
print("collision bytes (4 minitile rows per tile row):")
for ty in range(ty0, ty1 + 1):
    for my in range(4):
        row = []
        for tx in range(tx0, tx1 + 1):
            sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
            arr = tiles[ty * MAP_W_T + tx]
            cols = get_collisions(mapping[sec["tilesetId"]])
            if arr >= len(cols):
                row.append("?? ?? ?? ??")
            else:
                row.append(" ".join("%02x" % cols[arr][my * 4 + mx] for mx in range(4)))
        print("  ".join(row))
    print()

print("arrangement / FG opaque pixels per tile (-1 = no FG atlas):")
for ty in range(ty0, ty1 + 1):
    out = []
    for tx in range(tx0, tx1 + 1):
        sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
        key = f"{sec['tilesetId']}_{sec['paletteId']}"
        arr = tiles[ty * MAP_W_T + tx]
        out.append(f"a{arr}:{fg_opaque(key, arr)}")
    print(f"row {ty}: " + "  ".join(out))
