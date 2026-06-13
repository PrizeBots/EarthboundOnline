"""
Render a map region with REACHABILITY overlay: flood walkable minitiles from
a start point, then tint reachable=green, unreachable-but-walkable=yellow,
solid=red(weak). Finds invisible walls.

Usage: debug_reach.py startPxX startPxY tileX0 tileY0 tileX1 tileY1 out.png
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())

MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4
MAP_W_T, MAP_H_T = 256, 320
MW, MH = MAP_W_T * 4, MAP_H_T * 4

cols_cache = {}
def cols(ts):
    if ts not in cols_cache:
        cols_cache[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return cols_cache[ts]

def byte_at(mx, my):
    if not (0 <= mx < MW and 0 <= my < MH):
        return 0x80
    tx, ty = mx >> 2, my >> 2
    sec = sectors[(ty // SEC_TY) * MAP_W_SEC + tx // SEC_TX]
    c = cols(mapping[sec["tilesetId"]])
    arr = tiles[ty * MAP_W_T + tx]
    if arr >= len(c):
        return 0x80
    return c[arr][(my & 3) * 4 + (mx & 3)]

def solid(mx, my):
    return (byte_at(mx, my) & 0x80) != 0

px, py, tx0, ty0, tx1, ty1, out = *map(int, sys.argv[1:7]), sys.argv[7]

seen = set()
stack = [(px // 8, py // 8)]
while stack:
    x, y = stack.pop()
    if (x, y) in seen or solid(x, y):
        continue
    seen.add((x, y))
    stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]

atlases = {}
def get_atlas(key):
    if key not in atlases:
        p = A / "atlases" / f"{key}.png"
        atlases[key] = Image.open(p).convert("RGBA") if p.exists() else None
    return atlases[key]

W, H = (tx1 - tx0 + 1) * 32, (ty1 - ty0 + 1) * 32
img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        sec = sectors[(ty // SEC_TY) * MAP_W_SEC + tx // SEC_TX]
        arr = tiles[ty * MAP_W_T + tx]
        key = f"{sec['tilesetId']}_{sec['paletteId']}"
        for suffix in ("", "_fg"):
            atlas = get_atlas(key + suffix)
            if atlas is None:
                continue
            sx, sy = (arr % 32) * 32, (arr // 32) * 32
            img.alpha_composite(atlas.crop((sx, sy, sx + 32, sy + 32)), ((tx - tx0) * 32, (ty - ty0) * 32))

ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
for my in range(ty0 * 4, (ty1 + 1) * 4):
    for mx in range(tx0 * 4, (tx1 + 1) * 4):
        x, y = (mx - tx0 * 4) * 8, (my - ty0 * 4) * 8
        if solid(mx, my):
            d.rectangle([x, y, x + 7, y + 7], fill=(255, 0, 0, 60))
        elif (mx, my) in seen:
            d.rectangle([x, y, x + 7, y + 7], fill=(0, 255, 0, 50))
        else:
            d.rectangle([x, y, x + 7, y + 7], fill=(255, 255, 0, 150))
img.alpha_composite(ov)
img = img.resize((W * 2, H * 2), Image.NEAREST)
img.save(out)
print("saved", out, img.size, "reachable:", len(seen))
