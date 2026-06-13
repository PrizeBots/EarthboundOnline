"""
ASCII map of the 32x80 sector grid showing each sector's Setting class:
  I = indoors, X = exit mouse usable (caves/dungeons), M/R/L = magicant/robot/
  lost-underworld sprite settings, . = none.
Used to decide which settings should get interior room-cropping.

    python tools/debug_sector_settings_map.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W, H = 32, 80

settings = {}
idx = None
with open(ROOT / "eb_project" / "map_sectors.yml", encoding="utf-8") as f:
    for line in f:
        m = re.match(r"^(\d+):\s*$", line)
        if m:
            idx = int(m.group(1))
            continue
        s = re.match(r"^\s+Setting:\s*(.+?)\s*$", line)
        if s and idx is not None:
            settings[idx] = s.group(1)

CH = {
    "none": ".",
    "indoors": "I",
    "exit mouse usable": "X",
    "magicant sprites": "M",
    "robot sprites": "R",
    "lost underworld sprites": "L",
}

print("    " + "".join(str(x % 10) for x in range(W)))
for sy in range(H):
    row = "".join(CH.get(settings.get(sy * W + sx, "none"), "?") for sx in range(W))
    print(f"{sy:3d} {row}")
