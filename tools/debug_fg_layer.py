"""Render a region's BG dimmed + FG layer at full brightness to show exactly
which pixels can cover sprites. Usage: debug_fg_layer.py tx0 ty0 tx1 ty1 out.png"""
import json, sys
from pathlib import Path
from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())

MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX

cache = {}
def get_atlas(key):
    if key not in cache:
        p = A / "atlases" / f"{key}.png"
        cache[key] = Image.open(p).convert("RGBA") if p.exists() else None
    return cache[key]

tx0, ty0, tx1, ty1, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
W, H = (tx1 - tx0 + 1) * 32, (ty1 - ty0 + 1) * 32
img = Image.new("RGBA", (W, H), (0, 0, 0, 255))

for layer in ("", "_fg"):
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
            arr = tiles[ty * MAP_W_T + tx]
            atlas = get_atlas(f"{sec['tilesetId']}_{sec['paletteId']}{layer}")
            if atlas is None:
                continue
            sx, sy = (arr % 32) * 32, (arr // 32) * 32
            t = atlas.crop((sx, sy, sx + 32, sy + 32))
            if layer == "":
                t = ImageEnhance.Brightness(t.convert("RGB")).enhance(0.35).convert("RGBA")
                img.paste(t, ((tx - tx0) * 32, (ty - ty0) * 32))
            else:
                img.alpha_composite(t, ((tx - tx0) * 32, (ty - ty0) * 32))

img = img.resize((W * 3, H * 3), Image.NEAREST)
img.save(out)
print("saved", out)
