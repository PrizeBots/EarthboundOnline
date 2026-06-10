"""
Render a map region from the pre-built atlases (BG + FG) and overlay collision:
red = solid (0x80), blue tint = priority bits, green outline = FG flag 0x10.
Usage: debug_render_room.py <tileX0> <tileY0> <tileX1> <tileY1> <out.png>
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
MAP_W_T = MAP_W_SEC * SEC_TX

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

atlases = {}
def get_atlas(key):
    if key not in atlases:
        p = A / "atlases" / f"{key}.png"
        atlases[key] = Image.open(p).convert("RGBA") if p.exists() else None
    return atlases[key]

tx0, ty0, tx1, ty1, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
W, H = (tx1 - tx0 + 1) * 32, (ty1 - ty0 + 1) * 32
img = Image.new("RGBA", (W, H), (0, 0, 0, 255))

for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
        arr = tiles[ty * MAP_W_T + tx]
        key = f"{sec['tilesetId']}_{sec['paletteId']}"
        for suffix in ("", "_fg"):
            atlas = get_atlas(key + suffix)
            if atlas is None:
                continue
            sx, sy = (arr % 32) * 32, (arr // 32) * 32
            tile_img = atlas.crop((sx, sy, sx + 32, sy + 32))
            img.alpha_composite(tile_img, ((tx - tx0) * 32, (ty - ty0) * 32))

overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
        arr = tiles[ty * MAP_W_T + tx]
        cols = get_collisions(mapping[sec["tilesetId"]])
        if arr >= len(cols):
            continue
        for my in range(4):
            for mx in range(4):
                b = cols[arr][my * 4 + mx]
                x = (tx - tx0) * 32 + mx * 8
                y = (ty - ty0) * 32 + my * 8
                if b & 0x80:
                    d.rectangle([x, y, x + 7, y + 7], fill=(255, 0, 0, 150))
                if b & 0x10:
                    d.rectangle([x, y, x + 7, y + 7], outline=(0, 255, 0, 200))
                if b & 0x03:
                    d.rectangle([x + 1, y + 1, x + 6, y + 6], fill=(0, 128, 255, 160))

for ty in range(ty0, ty1 + 1):
    d.line([(0, (ty - ty0) * 32), (W, (ty - ty0) * 32)], fill=(255, 255, 255, 70))
for tx in range(tx0, tx1 + 1):
    d.line([((tx - tx0) * 32, 0), ((tx - tx0) * 32, H)], fill=(255, 255, 255, 70))

img.alpha_composite(overlay)
img = img.resize((W * 2, H * 2), Image.NEAREST)
img.save(out)
print("saved", out, img.size)
