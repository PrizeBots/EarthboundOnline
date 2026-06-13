"""
Correlate persons whose sprite-priority sample is 0x03 (both bits — the
bench-sitter case) with their npc_config Movement value, to find a ROM-data
discriminator for seated NPCs vs players standing behind signs.
"""
import json
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())
cols_cache = {}


def byte_at(mx, my):
    tx, ty = mx // 4, my // 4
    sec = sectors[(ty // 4) * 32 + (tx // 8)]
    ts = mapping[sec["tilesetId"]]
    if ts not in cols_cache:
        cols_cache[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    arr = tiles[ty * 256 + tx]
    c = cols_cache[ts]
    return c[arr][(my % 4) * 4 + (mx % 4)] if arr < len(c) else 0


def pri(px, py):
    """Mirror of Renderer getSpritePriority: 16x16 box above feet, skip solids."""
    bits = 0
    for my in range((py - 16) // 8, (py - 1) // 8 + 1):
        for mx in range((px - 8) // 8, (px + 7) // 8 + 1):
            b = byte_at(mx, my)
            if not (b & 0x80):
                bits |= b & 3
    return bits


npcs = json.loads((A / "map" / "npcs.json").read_text())
cfg = yaml.safe_load(open(ROOT / "eb_project" / "npc_config_table.yml"))

on03 = []
mv_all = Counter()
for n in npcs:
    if n["kind"] != "person":
        continue
    npc_id = int(n["k"].split(":")[1])
    mv = cfg[npc_id]["Movement"]
    mv_all[mv] += 1
    if pri(n["x"], n["y"]) == 3:
        on03.append((n["k"], n["x"], n["y"], n["sprite"], mv))

print("persons whose priority sample is 0x03:")
for row in on03:
    print("  ", row)
print("their movement values:", Counter(r[4] for r in on03))
print("global top movements:", mv_all.most_common(12))
