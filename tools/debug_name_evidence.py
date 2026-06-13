"""
Full naming-evidence dump: for every used sprite group, print up to 5 distinct
placements with town + first dialogue line. Output feeds the spriteNames.json
review. No pattern filtering — occupational self-intros ("I'm an arms
dealer...") matter as much as proper names.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
npcs = json.loads((A / "map" / "npcs.json").read_text())
text = json.loads((A / "map" / "npc_text.json").read_text())
sectors = json.loads((A / "map" / "sectors.json").read_text())
names = json.loads((ROOT / "src" / "data" / "spriteNames.json").read_text())


def town_at(x, y):
    sec = sectors[(y // 128) * 32 + (x // 256)]
    if sec.get("town"):
        return sec["town"][:6]
    return "indoor" if sec.get("indoor") else ("dng" if sec.get("dungeon") else "?")


by_sprite = {}
for n in npcs:
    by_sprite.setdefault(n["sprite"], []).append(n)

out = []
for sid in sorted(by_sprite):
    rows = by_sprite[sid]
    cur = names.get(str(sid), "??")
    out.append(f"### {sid} [{cur}] x{len(rows)} ({rows[0]['kind']})")
    seen = set()
    shown = 0
    for n in rows:
        pages = text.get(str(n.get("t"))) or []
        line = pages[0][:100].replace("\n", " ") if pages else "(silent)"
        if line in seen:
            continue
        seen.add(line)
        out.append(f"  {town_at(n['x'], n['y']):6s} {line}")
        shown += 1
        if shown >= 5:
            break

(ROOT / "tools" / "_name_evidence.txt").write_text("\n".join(out), encoding="utf-8")
print(f"wrote tools/_name_evidence.txt ({len(out)} lines, {len(by_sprite)} sprites)")
