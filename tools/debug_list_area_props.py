"""List props in a world-pixel rectangle: x0 y0 x1 y1."""
import json
import sys

npcs = json.load(open("public/assets/map/npcs.json"))
meta = {m["id"]: m for m in json.load(open("public/assets/sprites/metadata.json"))}

x0, y0, x1, y1 = map(int, sys.argv[1:5])
for n in npcs:
    if n["kind"] != "prop" or not (x0 <= n["x"] <= x1 and y0 <= n["y"] <= y1):
        continue
    m = meta.get(n["sprite"], {})
    print(f"({n['x']},{n['y']}) sprite={n['sprite']} {m.get('width')}x{m.get('height')} dir={n['dir']} t={n.get('t', '-')}")
