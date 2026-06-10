"""
Replicate the engine's render pipeline (new SNES model) in Python and place the
player sprite at given world positions to verify furniture layering.
Usage: debug_compose_scene.py tx0 ty0 tx1 ty1 out.png x1,y1 x2,y2 ...
"""
import json, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())
meta = json.loads((A / "sprites" / "metadata.json").read_text())

MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

cache = {}
def get_atlas(key):
    if key not in cache:
        p = A / "atlases" / f"{key}.png"
        cache[key] = Image.open(p).convert("RGBA") if p.exists() else None
    return cache[key]

def coll_byte(mtx, mty):
    sec = sectors[((mty >> 2) // SEC_TY) * MAP_W_SEC + ((mtx >> 2) // SEC_TX)]
    cols = get_collisions(mapping[sec["tilesetId"]])
    arr = tiles[(mty >> 2) * MAP_W_T + (mtx >> 2)]
    if arr >= len(cols):
        return 0
    return cols[arr][(mty & 3) * 4 + (mtx & 3)]

PRI_W, PRI_H = 16, 16
def sprite_priority(x, y):
    bits = 0
    for mty in range(int(y - PRI_H) // 8, int(y - 1) // 8 + 1):
        for mtx in range(int(x - PRI_W / 2) // 8, int(x + PRI_W / 2 - 1) // 8 + 1):
            bits |= coll_byte(mtx, mty) & 0x03
    return bits

# player sprite: group 1 (Ness), direction S frame 0 => row 1, col 0
m = next(s for s in meta if s["id"] == 1)
SW, SH = m["width"], m["height"]
sheet = Image.open(A / "sprites" / "1.png").convert("RGBA")
spr = sheet.crop((0 * SW, 1 * SH, 1 * SW, 2 * SH))

tx0, ty0, tx1, ty1, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
positions = [tuple(map(int, a.split(","))) for a in sys.argv[6:]]
W, H = (tx1 - tx0 + 1) * 32, (ty1 - ty0 + 1) * 32
img = Image.new("RGBA", (W, H), (0, 0, 0, 255))

def draw_layer(layer):
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
            arr = tiles[ty * MAP_W_T + tx]
            atlas = get_atlas(f"{sec['tilesetId']}_{sec['paletteId']}{layer}")
            if atlas is None:
                continue
            sx, sy = (arr % 32) * 32, (arr // 32) * 32
            img.alpha_composite(atlas.crop((sx, sy, sx + 32, sy + 32)), ((tx - tx0) * 32, (ty - ty0) * 32))

def draw_sprite_part(x, y, part):
    split = SH // 2
    if part == "upper":
        piece, oy = spr.crop((0, 0, SW, split)), 0
    elif part == "lower":
        piece, oy = spr.crop((0, split, SW, SH)), split
    else:
        piece, oy = spr, 0
    img.alpha_composite(piece, (x - tx0 * 32 - SW // 2, y - ty0 * 32 - SH - 1 + oy))

draw_layer("")  # BG
# pass 2: dropped halves
for (x, y) in positions:
    pri = sprite_priority(x, y)
    if pri & 0x01 and pri & 0x02:
        draw_sprite_part(x, y, "full")
    elif pri & 0x01:
        draw_sprite_part(x, y, "lower")
    elif pri & 0x02:
        draw_sprite_part(x, y, "upper")
draw_layer("_fg")  # pass 3: FG
# pass 4: non-dropped halves
for (x, y) in positions:
    pri = sprite_priority(x, y)
    if pri & 0x01 and pri & 0x02:
        pass
    elif pri & 0x01:
        draw_sprite_part(x, y, "upper")
    elif pri & 0x02:
        draw_sprite_part(x, y, "lower")
    else:
        draw_sprite_part(x, y, "full")

for (x, y) in positions:
    print(f"({x},{y}) priority bits = {sprite_priority(x, y):02x}")

img = img.resize((W * 3, H * 3), Image.NEAREST)
img.save(out)
print("saved", out)
