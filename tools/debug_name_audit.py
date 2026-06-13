"""
Audit sprite-name assignments: for given sprite ids, print every placement
(coords, town, first dialogue line) so location + speech pin identity.
Also lists all persons near a landmark to find who actually stands there.

Run: python tools/debug_name_audit.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
npcs = json.loads((A / "map" / "npcs.json").read_text())
text = json.loads((A / "map" / "npc_text.json").read_text())
sectors = json.loads((A / "map" / "sectors.json").read_text())


def town_at(x, y):
    sec = sectors[(y // 128) * 32 + (x // 256)]
    if sec.get("town"):
        return sec["town"]
    return "indoor" if sec.get("indoor") else ("dungeon" if sec.get("dungeon") else "?")


def first_line(n):
    pages = text.get(str(n.get("t"))) or []
    return (pages[0][:90] + "…") if pages else "(no dialogue)"


AUDIT = [79, 157, 117, 118, 125, 74, 179, 171, 328, 295, 293, 96, 126, 151]
for sid in AUDIT:
    print(f"--- sprite {sid} ---")
    for n in npcs:
        if n["sprite"] == sid:
            print(f"  ({n['x']:5d},{n['y']:5d}) {town_at(n['x'], n['y']):8s} {n['kind']:6s} {first_line(n)}")

# Who stands in Burglin Park? (near the Burglin Park sign, sprite 433)
sign = next(n for n in npcs if n["sprite"] == 433)
print(f"\n--- Burglin Park (sign at {sign['x']},{sign['y']}) persons within 500px ---")
for n in npcs:
    if abs(n["x"] - sign["x"]) < 500 and abs(n["y"] - sign["y"]) < 500:
        print(f"  sprite {n['sprite']:4d} ({n['x']:5d},{n['y']:5d}) {n['kind']:6s} {first_line(n)}")
