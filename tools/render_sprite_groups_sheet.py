"""
render_sprite_groups_sheet.py — montage every overworld sprite group into labeled
contact sheets so we can VISUALLY scan them (names in the ROM are unreliable).

Reads eb_project/SpriteGroups/NNN.png (the CoilSnake decompile, 464 groups) and
the authored names in src/data/spriteNames.json. Writes a few PNG sheets to
tools/sprite_sheets/ — each cell shows the group's first frame, its number, and
its name (or "—"). Numbered so you can rename the police car once you spot it.

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/render_sprite_groups_sheet.py
"""

import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "eb_project" / "SpriteGroups"
NAMES = json.loads((ROOT / "src" / "data" / "spriteNames.json").read_text(encoding="utf-8"))
OUT = ROOT / "tools" / "sprite_sheets"
OUT.mkdir(exist_ok=True)

COLS = 12
PER_SHEET = 120  # groups per sheet -> ~4 sheets
CELL_W, CELL_H = 72, 116  # sprite cell + label strip
LABEL_H = 22
SCALE = 1

try:
    font = ImageFont.truetype("arial.ttf", 10)
except Exception:
    font = ImageFont.load_default()


def group_id(p: Path) -> int:
    try:
        return int(p.stem)
    except ValueError:
        return -1


pngs = sorted([p for p in SRC.glob("*.png")], key=group_id)
print(f"{len(pngs)} sprite groups found")

for sheet_i in range(math.ceil(len(pngs) / PER_SHEET)):
    chunk = pngs[sheet_i * PER_SHEET : (sheet_i + 1) * PER_SHEET]
    rows = math.ceil(len(chunk) / COLS)
    W = COLS * CELL_W
    H = rows * CELL_H
    img = Image.new("RGB", (W, H), (0x1a, 0x1a, 0x1a))
    d = ImageDraw.Draw(img)
    for i, p in enumerate(chunk):
        gx = (i % COLS) * CELL_W
        gy = (i // COLS) * CELL_H
        gid = group_id(p)
        # First frame: top-left 16x24-ish region scaled up. EB group sheets are a
        # 4x4 grid of frames; just paste the whole sheet scaled to fit the cell.
        try:
            sp = Image.open(p).convert("RGBA")
            fit = sp.copy()
            maxw, maxh = CELL_W - 6, CELL_H - LABEL_H - 4
            fit.thumbnail((maxw, maxh), Image.NEAREST)
            img.paste(fit, (gx + (CELL_W - fit.width) // 2, gy + 2), fit)
        except Exception as e:
            d.text((gx + 4, gy + 4), "ERR", fill=(0xff, 0x55, 0x55), font=font)
        name = NAMES.get(str(gid), "")
        d.text((gx + 3, gy + CELL_H - LABEL_H + 1), f"#{gid}", fill=(0x6c, 0xf0, 0xd0), font=font)
        d.text((gx + 3, gy + CELL_H - LABEL_H + 11), (name[:13] if name else "—"),
               fill=(0xcc, 0xcc, 0xcc), font=font)
    out = OUT / f"sprite_groups_{sheet_i + 1}.png"
    img.save(out)
    print(f"  wrote {out.name}  ({len(chunk)} groups, {W}x{H})")

print("done ->", OUT)
