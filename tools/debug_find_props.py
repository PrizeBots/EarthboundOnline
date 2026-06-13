"""Locate prop placements for alignment debugging (ATMs, phones, traffic lights)."""
import json
import sys

npcs = json.load(open("public/assets/map/npcs.json"))
text = json.load(open("public/assets/map/npc_text.json", encoding="utf-8"))
meta = {m["id"]: m for m in json.load(open("public/assets/sprites/metadata.json"))}

def first_line(n):
    if "t" not in n:
        return ""
    return text[str(n["t"])][0].split("\n")[0][:50]

# Props whose dialogue mentions a keyword, or by explicit sprite id.
key = sys.argv[1] if len(sys.argv) > 1 else "ATM"
for n in npcs:
    if n["kind"] != "prop":
        continue
    m = meta.get(n["sprite"], {})
    line = first_line(n)
    if key.lower() in line.lower() or (key.isdigit() and n["sprite"] == int(key)):
        print(f"({n['x']},{n['y']}) sprite={n['sprite']} {m.get('width')}x{m.get('height')} "
              f"dir={n['dir']} t={n.get('t')} | {line}")
