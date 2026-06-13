"""Anchor sprite ids to known EB character names via dialogue mentions."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
npcs = json.loads((A / "map" / "npcs.json").read_text())
text = json.loads((A / "map" / "npc_text.json").read_text())

NAMES = [
    "Lier X", "Everdred", "Captain Strong", "Carpainter", "B.H. Pirkle",
    "Tony", "Maxwell", "Apple Kid", "Orange Kid", "Pippi", "Tracy",
    "Picky", "Pokey", "Buzz Buzz", "Mr. Saturn", "Tessie", "Brick Road",
    "Talah Rama", "Master Belch", "Jackie", "Venus", "Runaway Five",
    "Lucky", "Gorgeous", "Tenda", "Mach Pizza", "Escargo", "Andonuts",
    "Bubble Monkey", "Dalaam", "Poo's", "Star Master", "Photo",
]

hits = {}
for n in npcs:
    t = n.get("t")
    if t is None:
        continue
    pages = " ".join(text.get(str(t)) or [])[:600]
    for name in NAMES:
        if name in pages:
            hits.setdefault(name, set()).add(n["sprite"])

for name in NAMES:
    if name in hits:
        print(f"{name:16s} -> sprites {sorted(hits[name])}")

ids = json.loads((ROOT / "tools" / "_name_ids.json").read_text())
for i in range(0, len(ids), 80):
    print(f"sheet {i // 80}: {ids[i:i + 80]}")
