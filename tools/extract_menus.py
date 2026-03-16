#!/usr/bin/env python3
"""
Extract menu assets: fonts, window graphics, window configuration.
Outputs to public/assets/fonts/ and public/assets/windows/.
"""

import os
import json
import shutil
import sys

# Full Python path required per CLAUDE.md
PYTHON = "C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe"

try:
    import yaml
except ImportError:
    print("Installing PyYAML...")
    os.system(f'"{PYTHON}" -m pip install pyyaml')
    import yaml

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("Installing Pillow / numpy...")
    os.system(f'"{PYTHON}" -m pip install pillow numpy')
    from PIL import Image
    import numpy as np

# ── Paths ─────────────────────────────────────────────────────────────────────
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EB_PROJECT   = os.path.join(PROJECT_ROOT, "eb_project")
PUBLIC       = os.path.join(PROJECT_ROOT, "public", "assets")

FONTS_SRC    = os.path.join(EB_PROJECT, "Fonts")
WINDOWS_SRC  = os.path.join(EB_PROJECT, "WindowGraphics")
WIN_CFG_SRC  = os.path.join(EB_PROJECT, "window_configuration_table.yml")

FONTS_DST    = os.path.join(PUBLIC, "fonts")
WINDOWS_DST  = os.path.join(PUBLIC, "windows")

os.makedirs(FONTS_DST, exist_ok=True)
os.makedirs(WINDOWS_DST, exist_ok=True)


# ── Helper: convert palette-mode PNG (index 0 = transparent) → RGBA PNG ───────
def palettized_to_rgba(src_path: str, dst_path: str) -> None:
    """
    CoilSnake exports palette-mode PNGs where palette index 0 is transparent.
    Convert to proper RGBA so the browser can use them directly.
    """
    img = Image.open(src_path)
    palette = img.getpalette()          # flat [R,G,B, R,G,B, ...] list
    arr = np.array(img, dtype=np.uint8)
    h, w = arr.shape

    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for idx in range(256):
        mask = arr == idx
        if not np.any(mask):
            continue
        if idx == 0:
            rgba[mask] = (0, 0, 0, 0)      # transparent
        else:
            r, g, b = palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]
            rgba[mask] = (r, g, b, 255)

    Image.fromarray(rgba, "RGBA").save(dst_path, "PNG")
    print(f"  Wrote {dst_path}")


# ── 1. Fonts ──────────────────────────────────────────────────────────────────
print("=== Extracting fonts ===")
for font_id in range(5):
    src_png = os.path.join(FONTS_SRC, f"{font_id}.png")
    dst_png = os.path.join(FONTS_DST, f"font_{font_id}.png")

    if not os.path.exists(src_png):
        print(f"  font_{font_id}.png not found — skipping")
        continue

    palettized_to_rgba(src_png, dst_png)

    # Convert width YAML → JSON
    widths_yml = os.path.join(FONTS_SRC, f"{font_id}_widths.yml")
    widths_json = os.path.join(FONTS_DST, f"font_{font_id}_widths.json")
    if os.path.exists(widths_yml):
        with open(widths_yml, "r") as f:
            raw = yaml.safe_load(f)
        # raw is {int: int} — convert keys to ints, store as list indexed by char code
        max_key = max(raw.keys())
        widths = [0] * (max_key + 1)
        for k, v in raw.items():
            widths[k] = v
        with open(widths_json, "w") as f:
            json.dump(widths, f)
        print(f"  Wrote {widths_json} ({len(widths)} entries)")
    else:
        print(f"  {font_id}_widths.yml not found — skipping")

# Copy credits.png if present (used as a bitmap text image in some contexts)
credits_src = os.path.join(FONTS_SRC, "credits.png")
if os.path.exists(credits_src):
    palettized_to_rgba(credits_src, os.path.join(FONTS_DST, "credits.png"))


# ── 2. Window Graphics ────────────────────────────────────────────────────────
print("\n=== Extracting window graphics ===")

for variant in range(7):
    # Windows1 — 128x208 full border sheet
    src1 = os.path.join(WINDOWS_SRC, f"Windows1_{variant}.png")
    dst1 = os.path.join(WINDOWS_DST, f"windows1_{variant}.png")
    if os.path.exists(src1):
        palettized_to_rgba(src1, dst1)

    # Windows2 — 56x8 title-bar strip
    src2 = os.path.join(WINDOWS_SRC, f"Windows2_{variant}.png")
    dst2 = os.path.join(WINDOWS_DST, f"windows2_{variant}.png")
    if os.path.exists(src2):
        palettized_to_rgba(src2, dst2)


# ── 3. Build window slice sheets for 9-slice rendering ────────────────────────
#
# The Windows1 image (128×208) is a 16×26 grid of 8×8 tiles.
# Layout (from CoilSnake source analysis):
#   Rows  0 – 9  (y=0–79):  the window border tiles
#   Rows 10 –15  (y=80–127): empty / padding
#   Rows 16 –25  (y=128–207): interior fill tiles
#
# For 9-slice rendering we pre-extract four regions from each variant:
#   top_left corner:   tile area x= 0..15,  y=0..15  (2×2 tiles = 16×16px)
#   top_right corner:  tile area x=112..127, y=0..15 (2×2 tiles = 16×16px)
#   top_edge:          tile area x=16..111,  y=0..7   (12×1 tile  = 96×8px)
#   left_edge:         tile area x= 0..7,   y=16..79  (1×8 tiles  = 8×64px)
#   right_edge:        tile area x=120..127, y=16..79 (1×8 tiles  = 8×64px)
#   bottom section:    rows 22–25 (y=176–207) provide bottom border  (128×32px)
#   fill_tile:         first tile of interior (x=0..7, y=128..135)   (8×8px)
#
# However, for simplicity in the browser renderer, we emit per-variant
# metadata JSON that tells WindowRenderer.ts exactly what slices to sample
# from each windows1_N.png file.

print("\n=== Building window slice metadata ===")

BORDER_PX = 8         # EarthBound window border = 8 px (1 tile)

def build_slice_info(variant: int) -> dict:
    """
    Return 9-slice source rectangles for windows1_{variant}.png.
    All values are pixel coordinates in the 128×208 source image.
    """
    # Border tiles: rows 0-9 (0..79px), full 128px wide
    # The top-left corner occupies cols 0-1, rows 0-1 (16×16)
    # Actual content starts at col=1 for row=0 (col 0 of row 0 is empty)
    # For consistency, we treat the corner as 16×16 (2 tiles)

    return {
        "variant": variant,
        "sourceWidth":  128,
        "sourceHeight": 208,
        "border": BORDER_PX,
        # 9-slice source rects: [x, y, w, h] in the PNG
        "topLeft":     [0,   0,  16, 16],   # 2×2 tiles, top-left corner
        "topRight":    [112, 0,  16, 16],   # 2×2 tiles, top-right corner
        "bottomLeft":  [0,   64, 16, 16],   # rows 8-9 of border section
        "bottomRight": [112, 64, 16, 16],
        "topEdge":     [16,  0,  96,  8],   # tiles 2-13 of row 0 (repeated)
        "bottomEdge":  [16,  72, 96,  8],   # row 9, cols 2-13
        "leftEdge":    [0,   16, 8,  48],   # col 0, rows 2-7
        "rightEdge":   [120, 16, 8,  48],   # col 15, rows 2-7
        # Interior fill tile (tiled to fill the content area)
        "fillTile":    [0,   128, 8,  8],   # first tile of interior section
        # Interior section for larger fill patches (rows 16-25 = 128×80)
        "fillSection": [0,   128, 128, 80],
    }

slice_data = {}
for variant in range(7):
    slice_data[variant] = build_slice_info(variant)

slice_json = os.path.join(WINDOWS_DST, "window_slices.json")
with open(slice_json, "w") as f:
    json.dump(slice_data, f, indent=2)
print(f"  Wrote {slice_json}")


# ── 4. Window Configuration Table ─────────────────────────────────────────────
print("\n=== Extracting window configuration table ===")

with open(WIN_CFG_SRC, "r") as f:
    raw_cfg = yaml.safe_load(f)

# Convert to list of dicts with camelCase keys
window_configs = []
for idx in sorted(raw_cfg.keys()):
    entry = raw_cfg[idx]
    window_configs.append({
        "id":      idx,
        "width":   entry.get("Width",    0),
        "height":  entry.get("Height",   0),
        "xOffset": entry.get("X Offset", 0),
        "yOffset": entry.get("Y Offset", 0),
    })

cfg_json = os.path.join(WINDOWS_DST, "window_config.json")
with open(cfg_json, "w") as f:
    json.dump(window_configs, f, indent=2)
print(f"  Wrote {cfg_json} ({len(window_configs)} entries)")


print("\nDone! All menu assets extracted.")
