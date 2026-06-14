#!/usr/bin/env python
"""
extract_vehicle_colboxes.py — exact per-direction collision boxes for vehicles.

A car's footprint differs by facing (E/W is wide, N/S is shorter/taller) and the
sprite CELL (e.g. 48x32) is padded with transparent pixels, so using the whole
cell as the collision box is too big. This computes the tight OPAQUE bounding box
of each direction's drive frames and emits it as a feet-anchored box, so both the
client (NPCManager) and the server (npcSim) collide cars by their real shape.

Output: public/assets/sprites/colboxes.json
  { "<spriteId>": { "<dir>": {"w","h","offX","offY"}, ... 8 dirs ... }, ... }

Box convention (matches EntityCol in src/engine/EntityStats.ts): the entity is
drawn center-x / feet-y, so a box is `w` wide centred on x+offX, `h` tall with
its BOTTOM at y+offY (offY 0 = sits on the feet).

Direction codes + the cell layout mirror src/engine/SpriteManager.ts
(Direction enum + DIRECTION_LAYOUT). Re-run after changing vehicle art:

  py tools/extract_vehicle_colboxes.py
"""
import json
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPRITES = os.path.join(ROOT, "public", "assets", "sprites")
OUT = os.path.join(SPRITES, "colboxes.json")

# The drivable vehicle sprite groups (mirror TrafficEditorTool VEHICLE_SPRITES).
VEHICLE_IDS = [255, 206, 459, 207, 460, 208, 243, 254]

# Direction enum (src/types.ts): S,N,W,E,NW,SW,SE,NE = 0..7.
S, N, W, E, NW, SW, SE, NE = range(8)
# Cell pairs per direction (mirror SpriteManager DIRECTION_LAYOUT) as (row, col).
DIRECTION_LAYOUT = {
    N:  [(0, 0), (0, 1)],
    E:  [(0, 2), (0, 3)],
    S:  [(1, 0), (1, 1)],
    W:  [(1, 2), (1, 3)],
    NE: [(2, 0), (2, 1)],
    SE: [(2, 2), (2, 3)],
    SW: [(3, 0), (3, 1)],
    NW: [(3, 2), (3, 3)],
}
# A diagonal with no art falls back to its cardinal (mirror DIAGONAL_FALLBACK).
DIAGONAL_FALLBACK = {NE: E, SE: E, SW: W, NW: W}


def load_meta():
    with open(os.path.join(SPRITES, "metadata.json"), "r", encoding="utf-8") as f:
        return {e["id"]: e for e in json.load(f)}


def union_bbox(img, cells, W, H):
    """Opaque bounding box (in cell coords) over the union of `cells`, or None."""
    box = None
    for (r, c) in cells:
        cell = img.crop((c * W, r * H, c * W + W, r * H + H))
        bb = cell.getbbox()
        if not bb:
            continue
        box = bb if box is None else (
            min(box[0], bb[0]), min(box[1], bb[1]),
            max(box[2], bb[2]), max(box[3], bb[3]),
        )
    return box


def to_feet_box(bb, W, H):
    """Cell-space bbox -> feet-anchored {w,h,offX,offY} (see module docstring)."""
    bx0, by0, bx1, by1 = bb
    w = bx1 - bx0
    h = by1 - by0
    return {
        "w": w,
        "h": h,
        "offX": round(bx0 + w / 2 - W / 2),
        "offY": by1 - H,  # <= 0: box bottom relative to the feet line (y = H)
    }


def main():
    meta = load_meta()
    out = {}
    for sid in VEHICLE_IDS:
        e = meta.get(sid)
        png = os.path.join(SPRITES, f"{sid}.png")
        if not e or not os.path.exists(png):
            print(f"  skip {sid}: no metadata/png")
            continue
        W, H = e["width"], e["height"]
        img = Image.open(png).convert("RGBA")
        # First pass: tight boxes for whichever directions actually have art.
        raw = {}
        for d, cells in DIRECTION_LAYOUT.items():
            bb = union_bbox(img, cells, W, H)
            if bb:
                raw[d] = to_feet_box(bb, W, H)
        # Fill empty diagonals from their cardinal fallback (4-dir sheets).
        dirs = {}
        for d in range(8):
            src = d if d in raw else DIAGONAL_FALLBACK.get(d)
            if src in raw:
                dirs[str(d)] = raw[src]
        if dirs:
            out[str(sid)] = dirs
            sizes = ",".join(f"{dirs[str(d)]['w']}x{dirs[str(d)]['h']}" for d in (E, S))
            print(f"  {sid}: {len(dirs)} dirs (E,S = {sizes})")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {OUT} ({len(out)} vehicles)")


if __name__ == "__main__":
    main()
