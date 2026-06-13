"""List props with dialogue near the Onett spawn (deterministic talk targets)."""
import json

npcs = json.load(open("public/assets/map/npcs.json"))
text = json.load(open("public/assets/map/npc_text.json", encoding="utf-8"))
props = [n for n in npcs if n["kind"] == "prop" and "t" in n]
props.sort(key=lambda n: abs(n["x"] - 1296) + abs(n["y"] - 1168))
for n in props[:8]:
    first = text[str(n["t"])][0].replace("\n", " / ")
    print(f"({n['x']},{n['y']}) sprite={n['sprite']} t={n['t']}: {first[:70]}")
