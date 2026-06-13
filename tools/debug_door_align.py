"""
Render a map region with door-trigger overlays to check alignment:
    yellow rect  = the door's 8x8 minitile cell from the ROM data
    orange dot   = current engine trigger center (worldX/worldY in DoorManager)
    cyan rect    = current engine trigger zone (TRIGGER_X/Y box around center)
Usage: debug_door_align.py <tileX0> <tileY0> <tileX1> <tileY1> <out.png>
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
doors = json.loads((A / "map" / "doors.json").read_text())

MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4
MAP_W_T = MAP_W_SEC * SEC_TX
DOOR_GRID_COLS = 32
DOOR_AREA_PX = 256

atlases = {}
def get_atlas(key):
    if key not in atlases:
        p = A / "atlases" / f"{key}.png"
        atlases[key] = Image.open(p).convert("RGBA") if p.exists() else None
    return atlases[key]

tx0, ty0, tx1, ty1, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
W, H = (tx1 - tx0 + 1) * 32, (ty1 - ty0 + 1) * 32
ox, oy = tx0 * 32, ty0 * 32  # world-pixel origin of the render
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
            img.alpha_composite(atlas.crop((sx, sy, sx + 32, sy + 32)),
                                ((tx - tx0) * 32, (ty - ty0) * 32))

overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)
TRIGGER_X, TRIGGER_Y = 6, 8

for idx, area in enumerate(doors):
    aox = (idx % DOOR_GRID_COLS) * DOOR_AREA_PX
    aoy = (idx // DOOR_GRID_COLS) * DOOR_AREA_PX
    for door in area:
        cell_x = aox + door["x"] * 8 - ox
        cell_y = aoy + door["y"] * 8 - oy
        if cell_x < -16 or cell_x > W + 16 or cell_y < -16 or cell_y > H + 16:
            continue
        # ROM door cell
        d.rectangle([cell_x, cell_y, cell_x + 7, cell_y + 7],
                    outline=(255, 255, 0, 255))
        d.text((cell_x + 1, cell_y - 10), door["type"][:4], fill=(255, 255, 0, 255))
        if door["type"] != "door":
            continue
        # current engine trigger center (doorway center: +8,+4) and zone
        cx, cy = cell_x + 8, cell_y + 4
        d.rectangle([cx - TRIGGER_X, cy - TRIGGER_Y, cx + TRIGGER_X, cy + TRIGGER_Y],
                    outline=(0, 255, 255, 200))
        d.ellipse([cx - 1, cy - 1, cx + 1, cy + 1], fill=(255, 128, 0, 255))

img.alpha_composite(overlay)
img = img.resize((W * 3, H * 3), Image.NEAREST)
img.save(out)
print("saved", out, img.size)
