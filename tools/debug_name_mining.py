"""
Mine npc_text.json for self-identifying lines, grouped by sprite group, to
anchor sprite-name authoring. Prints sprite id -> candidate intro lines.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
npcs = json.loads((A / "map" / "npcs.json").read_text())
text = json.loads((A / "map" / "npc_text.json").read_text())

PAT = re.compile(
    r"(I'm [A-Z][a-zA-Z.\' ]+|I am [A-Z][a-zA-Z.\' ]+|[Mm]y name is [A-Z][a-zA-Z.\' ]+|"
    r"call me [A-Z][a-zA-Z.\' ]+|It's me, [A-Z][a-zA-Z.\' ]+)"
)

by_sprite = {}
for n in npcs:
    t = n.get("t")
    if t is None:
        continue
    pages = text.get(str(t)) or []
    for page in pages[:3]:
        m = PAT.search(page)
        if m:
            by_sprite.setdefault(n["sprite"], set()).add(m.group(1)[:60])

for sprite in sorted(by_sprite):
    for line in sorted(by_sprite[sprite]):
        print(f"{sprite:4d}  {line}")
