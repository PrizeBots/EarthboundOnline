"""
Render a map region with NPCs composited on it to verify placement anchors.
Sprites are drawn with drawSprite's convention: x = center, y = feet.
Usage: debug_npc_align.py <tileX0> <tileY0> <tileX1> <tileY1> <out.png>
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
npcs = json.loads((A / "map" / "npcs.json").read_text())
meta = {m["id"]: m for m in json.loads((A / "sprites" / "metadata.json").read_text())}

MAP_W_SEC, SEC_TX, SEC_TY = 32, 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX

atlases = {}
def get_atlas(key):
    if key not in atlases:
        p = A / "atlases" / f"{key}.png"
        atlases[key] = Image.open(p).convert("RGBA") if p.exists() else None
    return atlases[key]

# Direction -> south-row col/row of frame 0 in the 4x4 sheet (pairs: N,E,S,W)
DIR_CELL = {0: (1, 0), 1: (0, 0), 2: (1, 2), 3: (0, 2), 4: (3, 2), 5: (3, 0), 6: (2, 2), 7: (2, 0)}

tx0, ty0, tx1, ty1, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
W, H = (tx1 - tx0 + 1) * 32, (ty1 - ty0 + 1) * 32
ox, oy = tx0 * 32, ty0 * 32
img = Image.new("RGBA", (W, H), (0, 0, 0, 255))

for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        sec = sectors[(ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)]
        arr = tiles[ty * MAP_W_T + tx]
        for suffix in ("", "_fg"):
            atlas = get_atlas(f"{sec['tilesetId']}_{sec['paletteId']}{suffix}")
            if atlas is None:
                continue
            sx, sy = (arr % 32) * 32, (arr // 32) * 32
            img.alpha_composite(atlas.crop((sx, sy, sx + 32, sy + 32)),
                                ((tx - tx0) * 32, (ty - ty0) * 32))

d = ImageDraw.Draw(img)
shown = 0
for n in npcs:
    x, y = n["x"] - ox, n["y"] - oy
    if x < -32 or x > W + 32 or y < -32 or y > H + 32:
        continue
    m = meta.get(n["sprite"])
    if not m:
        continue
    sheet_p = A / "sprites" / f"{n['sprite']}.png"
    if not sheet_p.exists():
        continue
    sheet = Image.open(sheet_p).convert("RGBA")
    row, col = DIR_CELL.get(n["dir"], (1, 0))
    fw, fh = m["width"], m["height"]
    frame = sheet.crop((col * fw, row * fh, (col + 1) * fw, (row + 1) * fh))
    # drawSprite anchor: center-bottom at (x, y)
    img.alpha_composite(frame, (x - fw // 2, y - fh - 1))
    d.point((x, y), fill=(255, 0, 0, 255))  # the raw anchor pixel
    shown += 1

img = img.resize((W * 3, H * 3), Image.NEAREST)
img.save(out)
print("saved", out, "npcs drawn:", shown)
