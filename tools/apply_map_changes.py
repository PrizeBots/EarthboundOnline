"""
Apply EarthBound's event-driven map tile changes to public/assets/map/tiles.json.

The ROM's base map is the GAME-INTRO state: police sawhorse barricades block
the Onett roads (to Ness's house and around town) and Giant Step's ladders
are missing. EB swaps those tile arrangements at runtime via event flags
(eb_project/map_changes.yml, per draw-tileset {Before -> After}).

We bake in the "world open" state for free roaming. Only entries verified
against the rendered map are applied (see ALLOW below) — blindly applying all
entries would also switch unverified interiors/areas into event states.

Run AFTER tools/extract_rom.py (idempotent: re-running finds nothing to swap).
"""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets"
MAP_W_T, MAP_H_T = 256, 320
MAP_W_SEC = 32
SEC_TX, SEC_TY = 8, 4

# (draw_tileset, entry_index): why it's safe/correct to apply.
ALLOW = {
    (1, 0): "Onett police barricades -> open road (flag 0x8068); unblocks the "
            "road to Ness's/Pokey's houses at tiles (85-87,19)",
    (13, 0): "Giant Step cave ladders appear (flag 0x8137) at px (5024,320..416)",
    # (1, 1): skipped — arr 806-808 -> 0 along the map's top edge; both states
    #          are fully solid, cosmetic only.
    # (3, *), (8, 0): skipped — areas with no built atlases yet (not playable).
    # (6, *), (16, 0): skipped — flag 0x8044/0x47 areas (desert, big interior);
    #          change direction unverified, could switch rooms into event states.
}

changes = yaml.safe_load((ROOT / "eb_project" / "map_changes.yml").read_text())
sectors = json.loads((ASSETS / "map" / "sectors.json").read_text())
tiles = json.loads((ASSETS / "map" / "tiles.json").read_text())
mapping = json.loads((ASSETS / "map" / "tileset_mapping.json").read_text())

total = 0
for (draw_ts, entry_idx), why in ALLOW.items():
    entries = changes.get(draw_ts) or []
    if entry_idx >= len(entries):
        print(f"WARN: no entry {entry_idx} for draw tileset {draw_ts}")
        continue
    subst = {c["Before"]: c["After"] for c in entries[entry_idx]["Tile Changes"]}
    n = 0
    for ty in range(MAP_H_T):
        for tx in range(MAP_W_T):
            sec = sectors[(ty // SEC_TY) * MAP_W_SEC + tx // SEC_TX]
            if mapping[sec["tilesetId"]] != draw_ts:
                continue
            arr = tiles[ty * MAP_W_T + tx]
            if arr in subst:
                tiles[ty * MAP_W_T + tx] = subst[arr]
                n += 1
    total += n
    print(f"ts{draw_ts} entry {entry_idx}: swapped {n} tiles — {why}")

if total:
    (ASSETS / "map" / "tiles.json").write_text(json.dumps(tiles))
print(f"done: {total} tiles updated")
