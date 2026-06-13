"""
Contact sheets of sprite groups (south-facing frame 0) with id labels, for
naming the cast. Reads tools/_name_ids.json (list of group ids) and writes
tools/_contact_N.png sheets. Sheets contain ROM pixels — delete after use.

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/debug_sprite_contact.py
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SPRITES = ROOT / "public" / "assets" / "sprites"

ids = json.loads((ROOT / "tools" / "_name_ids.json").read_text())
meta = {m["id"]: m for m in json.loads((SPRITES / "metadata.json").read_text())}

COLS = 10
CELL_W, CELL_H = 76, 84
SCALE = 2
PER_SHEET = 80

sheets = [ids[i : i + PER_SHEET] for i in range(0, len(ids), PER_SHEET)]
for si, batch in enumerate(sheets):
    rows = (len(batch) + COLS - 1) // COLS
    img = Image.new("RGB", (COLS * CELL_W, rows * CELL_H), (24, 26, 32))
    d = ImageDraw.Draw(img)
    for i, gid in enumerate(batch):
        cx = (i % COLS) * CELL_W
        cy = (i // COLS) * CELL_H
        m = meta.get(gid)
        p = SPRITES / f"{gid}.png"
        if m and p.exists():
            sheet = Image.open(p).convert("RGBA")
            w, h = m["width"], m["height"]
            # south-facing frame 0 = row 1, col 0
            frame = sheet.crop((0, h, w, 2 * h))
            frame = frame.resize((w * SCALE, h * SCALE), Image.NEAREST)
            img.paste(frame, (cx + (CELL_W - w * SCALE) // 2, cy + 14), frame)
        d.text((cx + 4, cy + 2), str(gid), fill=(255, 200, 80))
    out = ROOT / "tools" / f"_contact_{si}.png"
    img.save(out)
    print("wrote", out, len(batch), "sprites")
