"""
Canonical re-implementation of Collision.computeRoomBounds (flood + pocket
merge + sector/style wall dilation + holes) for sweep-verification. Replays
the mask for EVERY door destination landing in a croppable (indoor or
dungeon) sector and reports:

  - rooms where no bounds compute (null -> NO CROP, the cave bug)
  - hole counts (foreign/unreached walkable minitiles inside the mask --
    these render as black squares; large counts deserve a visual check)
  - boundary seams: room floor minitiles adjacent to walkable NON-croppable
    minitiles (door-threshold spill; the flood correctly stops there, but a
    big seam could mean a walkable area gets cut by a black wall)
  - rooms whose flood spans multiple sector styles (tileset, palette): in
    buildings that means two unrelated rooms merged (the arcade/Tracy's-room
    bug); within dungeons cross-style areas are one cave complex and fine

With --diff-indoor, also recomputes every *indoor* destination using the
old indoor-only croppable rule and reports rooms whose mask changed (i.e.
regressions/changes to the 187 verified interior rooms).

    python tools/debug_room_crop_check.py [--diff-indoor]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles_arr = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())
doors_raw = json.loads((A / "map" / "doors.json").read_text())

MAP_W_SEC, MAP_H_SEC = 32, 80
SEC_TX, SEC_TY = 8, 4
MAP_W_T, MAP_H_T = MAP_W_SEC * SEC_TX, MAP_H_SEC * SEC_TY
MAP_W_MT, MAP_H_MT = MAP_W_T * 4, MAP_H_T * 4
SEC_MTX, SEC_MTY = SEC_TX * 4, SEC_TY * 4

MAX_ROOM_MT = 50000
WALL_N, WALL_EW, WALL_S = 4, 2, 0

collisions = {}


# Editor collision overrides (public/overrides/collision.json): per-arrangement
# "drawTs:arr" -> {idx: byte} ("edits") AND per-map-tile "tx,ty" -> {idx: byte}
# ("cells"). Applied here so the canonical room sweep sees the SAME collision
# the engine and npcSim do. KEEP IN SYNC with Collision.ts / npcSim.js.
def _load_collision_overrides():
    p = ROOT / "public" / "overrides" / "collision.json"
    try:
        doc = json.loads(p.read_text())
        return doc.get("edits") or {}, doc.get("cells") or {}
    except Exception:
        return {}, {}


COLLISION_OV, _CELL_OV_RAW = _load_collision_overrides()
# Per-map-tile overrides keyed by (tx, ty) -> {int idx: byte}.
CELL_OV = {
    tuple(int(v) for v in tk.split(",")): {int(i): b for i, b in cells.items()}
    for tk, cells in _CELL_OV_RAW.items()
}


def get_collisions(ts):
    if ts not in collisions:
        data = json.loads(
            (A / "tilesets" / str(ts) / "collisions.json").read_text()
        )
        for key, cells in COLLISION_OV.items():
            t, arr = (int(v) for v in key.split(":"))
            if t == ts and arr < len(data):
                for idx, byte in cells.items():
                    data[arr][int(idx)] = byte
        collisions[ts] = data
    return collisions[ts]


def sector_at(sx, sy):
    if not (0 <= sx < MAP_W_SEC and 0 <= sy < MAP_H_SEC):
        return None
    return sectors[sy * MAP_W_SEC + sx]


def tile_at(tx, ty):
    if not (0 <= tx < MAP_W_T and 0 <= ty < MAP_H_T):
        return 0
    return tiles_arr[ty * MAP_W_T + tx]


def solid(mtx, mty):
    if not (0 <= mtx < MAP_W_MT and 0 <= mty < MAP_H_MT):
        return True
    sec = sector_at((mtx >> 2) // SEC_TX, (mty >> 2) // SEC_TY)
    if sec is None:
        return True
    cols = get_collisions(mapping[sec["tilesetId"]])
    arr = tile_at(mtx >> 2, mty >> 2)
    idx = (mty & 3) * 4 + (mtx & 3)
    ov = CELL_OV.get((mtx >> 2, mty >> 2))
    if ov is not None and idx in ov:  # per-cell override wins
        return (ov[idx] & 0x80) != 0
    if arr >= len(cols):
        return True
    return (cols[arr][idx] & 0x80) != 0


def make_croppable(indoor_only):
    def croppable(tx, ty):
        s = sector_at(tx // SEC_TX, ty // SEC_TY)
        if s is None:
            return False
        return s.get("indoor") is True or (
            not indoor_only and s.get("dungeon") is True
        )

    return croppable


def indoor(tx, ty):
    s = sector_at(tx // SEC_TX, ty // SEC_TY)
    return s is not None and s.get("indoor") is True


def door_cells():
    """Minitile cells of every door mat + destination (raw table, like
    DoorManager.setDoorCells — inactive doors still mark real rooms)."""
    cells = set()
    for idx, area in enumerate(doors_raw):
        ox = (idx % MAP_W_SEC) * 32
        oy = (idx // MAP_W_SEC) * 32
        for d in area:
            if d.get("type") != "door":
                continue
            cells.add((ox + d["x"], oy + d["y"]))
            cells.add((ox + d["x"] + 1, oy + d["y"]))
            if "destX" in d:
                cells.add((d["destX"], d["destY"]))
    for (px, py) in DOOR_DEST_OVERRIDES.values():
        cells.add((px // 8, py // 8))
    return cells


DOOR_CELLS = None  # lazy (DOOR_DEST_OVERRIDES is defined below)


def compute_room(px, py, croppable):
    """Mirror of Collision.computeRoomBounds. Returns (tiles, visited, holes) or None."""
    global DOOR_CELLS
    if DOOR_CELLS is None:
        DOOR_CELLS = door_cells()
    if not croppable(px // 32, py // 32):
        return None

    sx, sy = px // 8, py // 8
    if solid(sx, sy):
        found = False
        for r in range(1, 7):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if not solid(sx + dx, sy + dy):
                        sx, sy = sx + dx, sy + dy
                        found = True
                        break
                if found:
                    break
            if found:
                break
        if not found:
            return None

    visited = set()
    stack = [(sx, sy)]
    while stack:
        x, y = stack.pop()
        if (x, y) in visited or solid(x, y):
            continue
        if not croppable(x >> 2, y >> 2):
            continue
        visited.add((x, y))
        if len(visited) > MAX_ROOM_MT:
            return None
        stack.append((x, y + 1))
        stack.append((x, y - 1))
        # Horizontal expansion inside building interiors may not slip under a
        # wall (1-cell-tall strips walkably join packed rooms); dungeons keep
        # free expansion (legit 1-tall squeezes/ledges).
        for nx in (x + 1, x - 1):
            if indoor(nx >> 2, y >> 2) and solid(nx, y - 1):
                continue
            stack.append((nx, y))

    flood_sectors = set()
    flood_styles = set()
    for (x, y) in visited:
        k = (y // SEC_MTY) * MAP_W_SEC + (x // SEC_MTX)
        if k not in flood_sectors:
            flood_sectors.add(k)
            sec = sectors[k]
            flood_styles.add((sec["tilesetId"] << 8) | sec["paletteId"])

    # pocket merge
    processed = set()
    for sk in flood_sectors:
        sy0, sx0 = divmod(sk, MAP_W_SEC)
        for y in range(sy0 * SEC_MTY, (sy0 + 1) * SEC_MTY):
            for x in range(sx0 * SEC_MTX, (sx0 + 1) * SEC_MTX):
                if (x, y) in visited or (x, y) in processed or solid(x, y):
                    continue
                region = []
                stk = [(x, y)]
                inside = True
                has_door = False
                while stk:
                    k = stk.pop()
                    if k in processed or k in visited:
                        continue
                    if solid(*k):
                        continue
                    ks = (k[1] // SEC_MTY) * MAP_W_SEC + (k[0] // SEC_MTX)
                    if ks not in flood_sectors:
                        inside = False
                        continue
                    processed.add(k)
                    region.append(k)
                    if k in DOOR_CELLS:
                        has_door = True  # a real neighboring room, not a pocket
                    stk.extend(
                        [(k[0] + 1, k[1]), (k[0] - 1, k[1]), (k[0], k[1] + 1), (k[0], k[1] - 1)]
                    )
                if inside and not has_door:
                    visited.update(region)

    # Guard-free fill bounded to flood_sectors, stopped by door mats: reclaims
    # floor cells orphaned on parasitic walkable strips under in-room furniture
    # (shop counters/shelves) that the guarded flood skipped, without crossing
    # into a packed neighbor room. Mirror of Collision.ts. KEEP IN SYNC.
    fill = list(visited)
    while fill:
        fx, fy = fill.pop()
        for nx, ny in ((fx + 1, fy), (fx - 1, fy), (fx, fy + 1), (fx, fy - 1)):
            if (nx, ny) in visited or solid(nx, ny):
                continue
            ks = (ny // SEC_MTY) * MAP_W_SEC + (nx // SEC_MTX)
            if ks not in flood_sectors:
                continue
            if (nx, ny) in DOOR_CELLS:
                continue
            visited.add((nx, ny))
            fill.append((nx, ny))

    tiles = {(x >> 2, y >> 2) for (x, y) in visited}

    def is_own_wall(tx, ty):
        if not (0 <= tx < MAP_W_T and 0 <= ty < MAP_H_T):
            return False
        if tile_at(tx, ty) == 0:
            return False
        sk = (ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)
        if sk not in flood_sectors:
            sec = sectors[sk]
            if ((sec["tilesetId"] << 8) | sec["paletteId"]) not in flood_styles:
                return False
        for my in range(4):
            for mx in range(4):
                m = (tx * 4 + mx, ty * 4 + my)
                if not solid(*m) and m not in visited:
                    return False
        return True

    def dilate(passes, offsets):
        for _ in range(passes):
            added = []
            for (tx, ty) in tiles:
                for (dx, dy) in offsets:
                    if (tx + dx, ty + dy) not in tiles and is_own_wall(tx + dx, ty + dy):
                        added.append((tx + dx, ty + dy))
            if not added:
                break
            tiles.update(added)

    dilate(WALL_N, [(0, -1)])
    dilate(WALL_EW, [(-1, 0), (1, 0)])
    if WALL_S:
        dilate(WALL_S, [(0, 1)])

    holes = []
    for (tx, ty) in tiles:
        for my in range(4):
            for mx in range(4):
                m = (tx * 4 + mx, ty * 4 + my)
                if not solid(*m) and m not in visited:
                    holes.append(m)
    return tiles, visited, holes


# Door overrides come from the SAME file the engine reads
# (public/overrides/doors.json — authored in the Placement Editor; the old
# hand-coded ZONE_DOOR_OVERRIDES table migrated there). Keyed by the
# "worldX,worldY" trigger anchor; dest values are pixels; null disables a door.
def _load_door_overrides():
    p = ROOT / "public" / "overrides" / "doors.json"
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"edits": {}, "additions": []}


DOOR_OVERRIDES = _load_door_overrides()
DOOR_DEST_OVERRIDES = {
    k: (v["destX"], v["destY"])
    for k, v in (DOOR_OVERRIDES.get("edits") or {}).items()
    if v is not None
}
DOOR_DISABLED = {
    k for k, v in (DOOR_OVERRIDES.get("edits") or {}).items() if v is None
}


def door_destinations():
    dests = []
    for idx, area in enumerate(doors_raw):
        ox = (idx % MAP_W_SEC) * 256
        oy = (idx // MAP_W_SEC) * 256
        for d in area:
            if d.get("type") == "door" and "destX" in d:
                key = "%d,%d" % (ox + d["x"] * 8 + 8, oy + d["y"] * 8 + 4)
                if key in DOOR_DISABLED:
                    continue
                dests.append(
                    DOOR_DEST_OVERRIDES.get(key, (d["destX"] * 8, d["destY"] * 8))
                )
    for a in DOOR_OVERRIDES.get("additions") or []:
        dests.append((a["destX"], a["destY"]))
    return dests


def setting_class(px, py):
    s = sector_at((px // 32) // SEC_TX, (py // 32) // SEC_TY)
    if s is None:
        return "?"
    if s.get("indoor"):
        return "indoor"
    if s.get("dungeon"):
        return "dungeon"
    return "outdoor"


def main():
    diff_indoor = "--diff-indoor" in sys.argv
    croppable = make_croppable(indoor_only=False)
    croppable_old = make_croppable(indoor_only=True)

    seen = {}
    nulls = []
    stats = {"indoor": [0, 0], "dungeon": [0, 0]}  # [rooms, holes-total]
    big_holes = []
    seams = []
    changed_indoor = []
    multi_style = []

    for (px, py) in door_destinations():
        cls = setting_class(px, py)
        if cls not in stats:
            continue
        res = compute_room(px, py, croppable)
        if res is None:
            nulls.append((px, py, cls))
            continue
        tiles, visited, holes = res
        sig = min(visited)
        if sig in seen:
            continue
        seen[sig] = (px, py, cls)

        stats[cls][0] += 1
        stats[cls][1] += len(holes)
        if len(holes) > 150:
            big_holes.append((px, py, cls, len(holes), len(tiles)))

        seam = 0
        for (x, y) in visited:
            for (nx, ny) in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if (nx, ny) not in visited and not solid(nx, ny) and not croppable(
                    nx >> 2, ny >> 2
                ):
                    seam += 1
        if seam > 12:  # bigger than a door threshold
            seams.append((px, py, cls, seam))

        styles = set()
        for (x, y) in visited:
            s = sectors[(y // SEC_MTY) * MAP_W_SEC + (x // SEC_MTX)]
            styles.add((s["tilesetId"], s["paletteId"]))
        if len(styles) > 1:
            multi_style.append((px, py, cls, len(visited), sorted(styles)))

        if diff_indoor and cls == "indoor":
            old = compute_room(px, py, croppable_old)
            if old is None or old[0] != tiles:
                changed_indoor.append((px, py))

    print(f"unique rooms: {len(seen)}  "
          f"(indoor {stats['indoor'][0]}, dungeon {stats['dungeon'][0]})")
    print(f"NO-CROP destinations (null): {len(nulls)}")
    for n in nulls[:20]:
        print("   null:", n)
    print(f"holes total: indoor {stats['indoor'][1]}, dungeon {stats['dungeon'][1]}")
    print(f"rooms with >150 holes: {len(big_holes)}")
    for b in big_holes[:20]:
        print("   big-holes:", b)
    print(f"rooms with walkable seam >12 mt to non-croppable: {len(seams)}")
    for s in seams[:20]:
        print("   seam:", s)
    indoor_multi = [m for m in multi_style if m[2] == "indoor"]
    print(f"multi-style rooms: {len(multi_style)} "
          f"(indoor: {len(indoor_multi)} — should be 0, see bugs.md)")
    for m in multi_style[:20]:
        print("   multi-style:", m)
    if diff_indoor:
        print(f"indoor rooms whose mask CHANGED vs indoor-only rule: {len(changed_indoor)}")
        for c in changed_indoor[:20]:
            print("   changed:", c)


if __name__ == "__main__":
    main()
