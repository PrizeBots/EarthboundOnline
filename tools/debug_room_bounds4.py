"""
Verify the tile-MASK room crop: replay flood + wall dilation (N4/EW2/S0,
wall tile joins only if it has no foreign walkable minitile and isn't void)
and count rooms whose mask exposes another room's floor minitiles.
"""
import json
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

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

def sector_for_tile(tx, ty):
    sx, sy = tx // SEC_TX, ty // SEC_TY
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
    sec = sector_for_tile(mtx >> 2, mty >> 2)
    if sec is None:
        return True
    cols = get_collisions(mapping[sec["tilesetId"]])
    arr = tile_at(mtx >> 2, mty >> 2)
    if arr >= len(cols):
        return True
    return (cols[arr][(mty & 3) * 4 + (mtx & 3)] & 0x80) != 0

def indoor(tx, ty):
    s = sector_for_tile(tx, ty)
    return s is not None and s.get("indoor") is True

MAX_ROOM_MT = 50000
WALL_N, WALL_EW, WALL_S = 4, 2, 0

def flood(seed_x, seed_y):
    visited = set()
    stack = [(seed_x, seed_y)]
    while stack:
        x, y = stack.pop()
        if (x, y) in visited or solid(x, y):
            continue
        visited.add((x, y))
        if len(visited) > MAX_ROOM_MT:
            return None
        stack.extend([(x+1, y), (x-1, y), (x, y+1), (x, y-1)])
    return visited

def compute_mask(visited):
    tiles = set()
    for (mtx, mty) in visited:
        tiles.add((mtx >> 2, mty >> 2))

    def is_own_wall(tx, ty):
        if not (0 <= tx < MAP_W_T and 0 <= ty < MAP_H_T):
            return False
        if tile_at(tx, ty) == 0:
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
                    if (tx+dx, ty+dy) not in tiles and is_own_wall(tx+dx, ty+dy):
                        added.append((tx+dx, ty+dy))
            if not added:
                break
            tiles.update(added)

    dilate(WALL_N, [(0, -1)])
    dilate(WALL_EW, [(-1, 0), (1, 0)])
    if WALL_S:
        dilate(WALL_S, [(0, 1)])
    return tiles

dests = []
for area in doors_raw:
    for d in area:
        if d.get("type") != "door":
            continue
        dx_px = d.get("destX", 0) * 8
        dy_px = d.get("destY", 0) * 8
        if indoor(dx_px // 32, dy_px // 32):
            dests.append((dx_px, dy_px))

seen = set()
bleed = clean = nobounds = 0
bleed_examples = []
sizes = []
for (px, py) in dests:
    sx, sy = px // 8, py // 8
    if solid(sx, sy):
        found = False
        for r in range(1, 7):
            for dy in range(-r, r+1):
                for dx in range(-r, r+1):
                    if not solid(sx+dx, sy+dy):
                        sx, sy = sx+dx, sy+dy
                        found = True
                        break
                if found: break
            if found: break
        if not found:
            nobounds += 1
            continue
    visited = flood(sx, sy)
    if visited is None:
        nobounds += 1
        continue
    sig = min(visited)
    if sig in seen:
        continue
    seen.add(sig)
    mask = compute_mask(visited)
    sizes.append(len(mask))

    foreign = 0
    for (tx, ty) in mask:
        for my in range(4):
            for mx in range(4):
                m = (tx * 4 + mx, ty * 4 + my)
                if m not in visited and not solid(*m):
                    foreign += 1
    if foreign > 0:
        bleed += 1
        if len(bleed_examples) < 10:
            bleed_examples.append((px, py, foreign))
    else:
        clean += 1

print(f"unique rooms: {len(seen)}; bleeding: {bleed}; clean: {clean}; no-bounds: {nobounds}")
print(f"mask sizes: min {min(sizes)}, max {max(sizes)} tiles")
for e in bleed_examples:
    print("  bleed:", e)
