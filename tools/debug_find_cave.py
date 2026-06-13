"""
Find door destinations that land in 'exit mouse usable' (dungeon) sectors —
used to locate cave rooms for room-crop testing.

    python tools/debug_find_cave.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W = 32
AREA_PX = 256
MT = 8

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


def setting_at(px, py):
    return settings.get((py // 128) * W + (px // 256), "?")


areas = json.loads((ROOT / "public" / "assets" / "map" / "doors.json").read_text())
hits = []
for i, area in enumerate(areas):
    ox, oy = (i % W) * AREA_PX, (i // W) * AREA_PX
    for d in area:
        if d.get("type") != "door" or "destX" not in d:
            continue
        sx_px, sy_px = ox + d["x"] * MT, oy + d["y"] * MT
        dx_px, dy_px = d["destX"] * MT, d["destY"] * MT
        if setting_at(dx_px, dy_px) == "exit mouse usable":
            hits.append((sx_px, sy_px, setting_at(sx_px, sy_px), dx_px, dy_px))

print(f"{len(hits)} doors into dungeon sectors")
for h in sorted(hits):
    print(f"  src=({h[0]:5d},{h[1]:5d}) [{h[2]:18s}] -> dest=({h[3]:5d},{h[4]:5d}) sector=({h[3]//256},{h[4]//128})")
