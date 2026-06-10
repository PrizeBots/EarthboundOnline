"""
Curate the character-select roster.

Walks every 16x24 sprite group and keeps only real, walkable characters:
    - drops the playable cast's pose/transformation sheets via
      playable_char_gfx_table.yml (ladder + rope climbs, the ghost/angel
      "dead" forms; tiny forms are 16x16 and excluded by size already)
    - drops any sheet without at least 4 distinct cardinal directions
      (single-pose enemies/props repeat one frame across the whole grid)

Output:
    public/assets/sprites/characters.json — ordered list of selectable
        sprite group ids, loaded by CharacterSelect.ts

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/build_char_select.py
"""
import json
import hashlib
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPRITES = ROOT / "public" / "assets" / "sprites"
GFX_TABLE = ROOT / "eb_project" / "playable_char_gfx_table.yml"

FRAME_W, FRAME_H = 16, 24
# Frame 0 of each cardinal pair in the 4x4 grid: N, E, S, W
CARDINAL_CELLS = [(0, 0), (0, 2), (1, 0), (1, 2)]
MIN_FRAME_PIXELS = 20


def pose_exclusions():
    import yaml

    table = yaml.safe_load(open(GFX_TABLE))
    exclude = set()
    for entry in table.values():
        for key in ("Ladder Sprite Group", "Rope Sprite Group", "Dead Sprite Group"):
            exclude.add(entry[key])
    exclude -= {entry["Default Sprite Group"] for entry in table.values()}
    return exclude


def cardinal_frames(img):
    img = img.convert("RGBA")
    frames = []
    for row, col in CARDINAL_CELLS:
        crop = img.crop(
            (col * FRAME_W, row * FRAME_H, (col + 1) * FRAME_W, (row + 1) * FRAME_H)
        )
        frames.append(crop)
    return frames


def main():
    meta = json.load(open(SPRITES / "metadata.json"))
    exclude = pose_exclusions()

    kept, removed = [], []
    for m in meta:
        if m["width"] != FRAME_W or m["height"] != FRAME_H:
            continue
        gid = m["id"]
        path = SPRITES / f"{gid}.png"
        if not path.exists():
            continue
        if gid in exclude:
            removed.append((gid, "pose/angel sheet of a playable character"))
            continue

        frames = cardinal_frames(Image.open(path))
        counts = [sum(1 for p in f.getdata() if p[3] > 0) for f in frames]
        if min(counts) < MIN_FRAME_PIXELS:
            removed.append((gid, "missing cardinal direction art"))
            continue
        hashes = {hashlib.md5(f.tobytes()).hexdigest() for f in frames}
        if len(hashes) < 4:
            removed.append((gid, f"only {len(hashes)} distinct direction(s)"))
            continue
        kept.append(gid)

    with open(SPRITES / "characters.json", "w") as f:
        json.dump(kept, f)

    print(f"Kept {len(kept)} characters, removed {len(removed)}")
    for gid, reason in removed:
        print(f"  removed {gid}: {reason}")


if __name__ == "__main__":
    main()
