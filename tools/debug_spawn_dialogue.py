"""Print decoded dialogue for NPCs near the Onett spawn (sanity check)."""
import json

npcs = json.load(open("public/assets/map/npcs.json"))
text = json.load(open("public/assets/map/npc_text.json", encoding="utf-8"))
near = [n for n in npcs if abs(n["x"] - 1296) < 400 and abs(n["y"] - 1168) < 400]
print(f"{len(near)} NPCs near spawn, {sum(1 for n in near if 't' in n)} with dialogue")
for n in near:
    if "t" not in n:
        print(f"({n['x']},{n['y']}) {n['kind']} sprite={n['sprite']} -- no dialogue")
        continue
    print(f"({n['x']},{n['y']}) {n['kind']} t={n['t']}")
    for p in text[str(n["t"])][:4]:
        print("   |", p.replace("\n", " / "))
