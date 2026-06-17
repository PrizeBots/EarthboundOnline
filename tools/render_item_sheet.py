"""
render_item_sheet.py — render overrides/item_sprites.json to a big labeled PNG
contact sheet so we can VISUALLY review held-item pixel art quality.

Each cell shows the item id + name (from shops.json) and its frame-0 art scaled
up, on a checkerboard so transparency reads. Purely a dev/review tool — touches
no game data.

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/render_item_sheet.py
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPRITES = os.path.join(ROOT, "public", "overrides", "item_sprites.json")
SHOPS = os.path.join(ROOT, "public", "assets", "map", "shops.json")
OUT = os.path.join(HERE, "item_sheet.png")

# ITEM_PALETTE from src/engine/Items.ts (index 0 = transparent).
PALETTE = {
    "0": None,
    "1": (0x00, 0x00, 0x00),
    "2": (0xff, 0xff, 0xff),
    "3": (0x7a, 0x4a, 0x20),
    "4": (0xc0, 0x88, 0x50),
    "5": (0x50, 0x28, 0x00),
    "6": (0xa8, 0xa8, 0xb0),
    "7": (0x48, 0x48, 0x50),
    "8": (0xd8, 0x28, 0x20),
    "9": (0x20, 0x80, 0x40),
    "a": (0x28, 0x60, 0xd8),
    "b": (0xf0, 0xd0, 0x20),
    "c": (0xe0, 0x78, 0x20),
    "d": (0x90, 0x20, 0x80),
    "e": (0xd8, 0xd8, 0xd8),
    "f": (0x18, 0x18, 0x18),
}

SCALE = 8        # px per art pixel
CELL_W = 16 * SCALE + 16
CELL_H = 16 * SCALE + 30
COLS = 12


def names():
    try:
        d = json.load(open(SHOPS, encoding="utf-8"))
        return {k: v.get("name", "") for k, v in d.get("items", {}).items()}
    except Exception:
        return {}


def frame0(entry):
    if not isinstance(entry, dict):
        return None
    fr = entry.get("frames")
    if isinstance(fr, list) and fr and isinstance(fr[0], list):
        return fr[0]
    px = entry.get("pixels")
    return px if isinstance(px, list) else None


def draw_art(img, ox, oy, grid):
    # checkerboard backdrop
    d = ImageDraw.Draw(img)
    for y in range(16):
        for x in range(16):
            shade = 0x33 if (x + y) & 1 else 0x44
            d.rectangle([ox + x * SCALE, oy + y * SCALE,
                         ox + (x + 1) * SCALE - 1, oy + (y + 1) * SCALE - 1],
                        fill=(shade, shade, shade))
    if not grid:
        return
    for y, row in enumerate(grid[:16]):
        for x, ch in enumerate(row[:16]):
            rgb = PALETTE.get(ch)
            if rgb is None:
                continue
            d.rectangle([ox + x * SCALE, oy + y * SCALE,
                         ox + (x + 1) * SCALE - 1, oy + (y + 1) * SCALE - 1],
                        fill=rgb)


def frames_of(entry):
    if isinstance(entry, dict) and isinstance(entry.get("frames"), list) and entry["frames"]:
        return entry["frames"]
    f0 = frame0(entry)
    return [f0] if f0 else []


def render_anim(sprites, nm, ids):
    """One row per item: its 3 animation frames side by side."""
    import os
    scale = 12
    fw = 16 * scale + 8
    cellh = 16 * scale + 26
    labelw = 150
    rows = [i for i in ids if i in sprites]
    W = labelw + 3 * fw + 20
    H = len(rows) * cellh
    img = Image.new("RGB", (W, H), (0x1a, 0x1a, 0x1a))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 12)
    except Exception:
        font = ImageFont.load_default()
    for i, iid in enumerate(rows):
        cy = i * cellh
        frs = frames_of(sprites[iid])
        d.text((6, cy + cellh // 2 - 6), f"{iid} {nm.get(iid,'')}"[:20], fill=(0xcc, 0xdd, 0xff), font=font)
        for fi in range(3):
            ox = labelw + fi * fw
            d.text((ox + 4, cy + 2), f"f{fi}", fill=(0x77, 0x99, 0x77), font=font)
            g = frs[fi] if fi < len(frs) else (frs[-1] if frs else None)
            global SCALE
            old = SCALE
            SCALE = scale
            draw_art(img, ox + 4, cy + 20, g)
            SCALE = old
    out = os.path.join(HERE, "item_anim.png")
    img.save(out)
    print(f"Wrote {out}  ({W}x{H}, {len(rows)} items x3 frames)")


def main():
    import sys
    sprites = json.load(open(SPRITES, encoding="utf-8"))
    nm = names()
    if len(sys.argv) > 1 and sys.argv[1] == "anim":
        want = []
        for tok in (sys.argv[2] if len(sys.argv) > 2 else "").split(","):
            if "-" in tok:
                a, b = tok.split("-"); want += [str(n) for n in range(int(a), int(b) + 1)]
            elif tok:
                want.append(tok)
        render_anim(sprites, nm, want)
        return
    ids = sorted(sprites.keys(),
                 key=lambda x: (not str(x).isdigit(), int(x) if str(x).isdigit() else 0, str(x)))
    global SCALE, CELL_W, CELL_H, COLS, OUT
    if len(sys.argv) > 1:  # crop: render only these ids (supports a-b ranges) big
        want = set()
        for tok in sys.argv[1].split(","):
            if "-" in tok:
                a, b = tok.split("-"); want |= {str(n) for n in range(int(a), int(b) + 1)}
            else:
                want.add(tok)
        ids = [i for i in ids if i in want]
        SCALE = 14; CELL_W = 16 * SCALE + 16; CELL_H = 16 * SCALE + 30; COLS = 8
        OUT = os.path.join(HERE, "item_sheet_crop.png")
    rows = (len(ids) + COLS - 1) // COLS
    W = COLS * CELL_W
    H = rows * CELL_H
    img = Image.new("RGB", (W, H), (0x1a, 0x1a, 0x1a))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 11)
    except Exception:
        font = ImageFont.load_default()

    for i, iid in enumerate(ids):
        cx = (i % COLS) * CELL_W
        cy = (i // COLS) * CELL_H
        entry = sprites[iid]
        ph = isinstance(entry, dict) and entry.get("_placeholder")
        label = f"{iid} {nm.get(iid, '')}".strip()
        d.text((cx + 8, cy + 2), label[:22], fill=(0xff, 0xcc, 0x66) if ph else (0x88, 0xff, 0x88), font=font)
        d.text((cx + 8, cy + 14), "PLACEHOLDER" if ph else "art", fill=(0x99, 0x77, 0x44) if ph else (0x55, 0xaa, 0x55), font=font)
        draw_art(img, cx + 8, cy + 28, frame0(entry))

    img.save(OUT)
    print(f"Wrote {OUT}  ({W}x{H}, {len(ids)} items, {rows} rows)")


if __name__ == "__main__":
    main()
