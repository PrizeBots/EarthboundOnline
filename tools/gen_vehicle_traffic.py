#!/usr/bin/env python
"""
gen_vehicle_traffic.py — link every vehicle-sprite NPC to the traffic system.

EarthBound places cars/taxis/trucks as static placements in npcs.json (kind
'prop'). In the real game many of these drove the streets; our traffic system
(public/overrides/car_traffic.json, driven by server/npcSim.js buildCarPool)
already IS the "NPC + waypoints" mechanism for that. This script converts each
plain vehicle prop into a traffic instance so it's server-driven and synced, and
removes the now-duplicate static placement.

What it writes (overrides layer only — never the ROM-derived base):
  public/overrides/car_traffic.json  — one named, enabled vehicle per prop, with
       a default 2-waypoint route running ALONG the prop's facing (the road it
       was parked on). Hand-authored vehicles already in the file are preserved.
  public/overrides/npcs.json         — edits[k] = null for each converted prop,
       so the static car vanishes and only the traffic car remains. Other
       authored npc edits/additions are preserved.

The routes are deliberately simple stubs — refine each in the Traffic Editor
(F2 -> Traffic), reachable in one click from the Placement Editor.

Idempotent: re-running skips vehicles already linked (by deterministic id).

  py tools/gen_vehicle_traffic.py
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NPCS = os.path.join(ROOT, "public", "assets", "map", "npcs.json")
META = os.path.join(ROOT, "public", "assets", "sprites", "metadata.json")
CAR_OV = os.path.join(ROOT, "public", "overrides", "car_traffic.json")
NPC_OV = os.path.join(ROOT, "public", "overrides", "npcs.json")

# The drivable vehicle sprite groups (mirror TrafficEditorTool VEHICLE_SPRITES).
VEHICLE_SPRITES = {
    255: "car",
    206: "taxi",
    459: "truck",
    207: "delivery-truck",
    460: "moving-van",
    208: "camper-van",
    243: "tour-bus",
    254: "bulldozer",
}

# Facing unit vectors indexed by Direction (src/types.ts: S,N,W,E,NW,SW,SE,NE),
# mirroring npcSim.js DIR_VEC so the stub route runs the way the car faces.
D = math.sqrt(0.5)
DIR_VEC = [
    (0, 1), (0, -1), (-1, 0), (1, 0),
    (-D, -D), (-D, D), (D, D), (D, -D),
]

RUN = 96  # px each way from the placement along its facing — a short road run


def load(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def sprite_sizes():
    sizes = {}
    for e in load(META, []):
        if isinstance(e, dict) and "id" in e:
            sizes[e["id"]] = (e.get("width", 40), e.get("height", 28))
    return sizes


def main():
    npcs = load(NPCS, [])
    sizes = sprite_sizes()
    car_ov = load(CAR_OV, {"version": 1, "vehicles": []})
    npc_ov = load(NPC_OV, {"version": 1})

    vehicles = car_ov.get("vehicles", [])
    have_ids = {v.get("id") for v in vehicles}
    edits = npc_ov.setdefault("edits", {})

    per_type = {}   # sprite -> running count, for stable names
    added = 0
    skipped_person = 0

    for n in npcs:
        k = n.get("k")
        # Apply any existing override edit so the route starts where the prop
        # actually sits now (a prior reposition wins over the ROM base). A
        # null edit means it's already been removed — skip it entirely.
        cur = n
        if k is not None and k in edits:
            if edits[k] is None:
                continue
            cur = edits[k]
        sprite = cur.get("sprite")
        if sprite not in VEHICLE_SPRITES:
            continue
        # Skip talkable cars (kind 'person' with dialogue) — they stay NPCs so
        # their talk/check text survives.
        if cur.get("kind") == "person":
            skipped_person += 1
            continue
        if k is None:
            continue
        vid = "v_npc_" + str(k).replace(":", "_")
        idx = per_type.get(sprite, 0) + 1
        per_type[sprite] = idx
        # Remove the static placement either way, so re-runs keep it removed.
        edits[k] = None
        if vid in have_ids:
            continue  # already linked — don't duplicate the traffic instance

        d = cur.get("dir", 0)
        fx, fy = DIR_VEC[d] if 0 <= d < len(DIR_VEC) else (1, 0)
        x, y = cur["x"], cur["y"]
        w, h = sizes.get(sprite, (40, 28))
        vehicles.append({
            "id": vid,
            "name": f"{VEHICLE_SPRITES[sprite]}-{idx}",
            "sprite": sprite,
            "w": w,
            "h": h,
            "speed": 1,
            "loop": True,
            "enabled": True,
            "waypoints": [
                [round(x - fx * RUN), round(y - fy * RUN)],
                [round(x + fx * RUN), round(y + fy * RUN)],
            ],
        })
        have_ids.add(vid)
        added += 1

    car_ov["version"] = car_ov.get("version", 1)
    car_ov["vehicles"] = vehicles
    npc_ov["version"] = npc_ov.get("version", 1)
    npc_ov["edits"] = edits

    with open(CAR_OV, "w", encoding="utf-8") as f:
        json.dump(car_ov, f, indent=2)
    with open(NPC_OV, "w", encoding="utf-8") as f:
        json.dump(npc_ov, f, indent=2)

    print(f"linked {added} vehicle props to traffic "
          f"({len(vehicles)} vehicles total in car_traffic.json)")
    print(f"removed {len([1 for v in edits.values() if v is None])} static "
          f"placements via npcs.json edits; skipped {skipped_person} talkable cars")


if __name__ == "__main__":
    main()
