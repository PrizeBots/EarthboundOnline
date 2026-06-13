"""
For every unique indoor room reachable via doors: replay the current
flood+dilation mask and classify each claimed WALL tile (not floor) by
whether its sector contains flood minitiles:

  in-sector      : tile's sector contains our floor -> always safe
  out-same       : foreign sector, same tileset+palette as a flood sector
  out-diff       : foreign sector, different tileset/palette -> visible bleed

If out-diff is common and out-same is rare, restricting the mask to
flood sectors (+nothing) is the right fix.
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

def sector_idx(tx, ty):
    return (ty // SEC_TY) * MAP_W_SEC + (tx // SEC_TX)

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

def find_seed(px, py):
    sx, sy = px // 8, py // 8
    if not solid(sx, sy):
        return sx, sy
    for r in range(1, 7):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if not solid(sx + dx, sy + dy):
                    return sx + dx, sy + dy
    return None

def flood(seed_x, seed_y):
    visited = set()
    stack = [(seed_x, seed_y)]
    while stack:
        x, y = stack.pop()
        if (x, y) in visited or solid(x, y):
            continue
        visited.add((x, y))
        if len(visited) > 50000:
            return None
        stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    return visited

def compute_mask(visited):
    tiles = set()
    for (mtx, mty) in visited:
        tiles.add((mtx >> 2, mty >> 2))
    floor_tiles = set(tiles)

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
                    if (tx + dx, ty + dy) not in tiles and is_own_wall(tx + dx, ty + dy):
                        added.append((tx + dx, ty + dy))
            if not added:
                break
            tiles.update(added)

    dilate(4, [(0, -1)])
    dilate(2, [(-1, 0), (1, 0)])
    return tiles, floor_tiles

dests = set()
for area in doors_raw:
    for d in area:
        if d.get("type") != "door":
            continue
        px, py = d.get("destX", 0) * 8, d.get("destY", 0) * 8
        if indoor(px // 32, py // 32):
            dests.add((px, py))

seen = set()
tot_rooms = rooms_outdiff = rooms_outsame = 0
tot_in = tot_outsame = tot_outdiff = 0
outsame_examples = []
for (px, py) in sorted(dests):
    seed = find_seed(px, py)
    if seed is None:
        continue
    v = flood(*seed)
    if v is None:
        continue
    sig = min(v)
    if sig in seen:
        continue
    seen.add(sig)
    mask, floor_t = compute_mask(v)
    flood_sectors = {sector_idx(tx, ty) for (tx, ty) in floor_t}
    flood_styles = {(sectors[i]["tilesetId"], sectors[i]["paletteId"]) for i in flood_sectors}
    n_in = n_outsame = n_outdiff = 0
    for (tx, ty) in mask - floor_t:
        si = sector_idx(tx, ty)
        if si in flood_sectors:
            n_in += 1
        else:
            s = sectors[si]
            if (s["tilesetId"], s["paletteId"]) in flood_styles:
                n_outsame += 1
            else:
                n_outdiff += 1
    tot_rooms += 1
    tot_in += n_in
    tot_outsame += n_outsame
    tot_outdiff += n_outdiff
    if n_outdiff:
        rooms_outdiff += 1
    if n_outsame:
        rooms_outsame += 1
        if len(outsame_examples) < 15:
            outsame_examples.append((px, py, n_outsame, n_outdiff))

print(f"rooms analyzed: {tot_rooms}")
print(f"wall tiles in flood sectors:        {tot_in}")
print(f"wall tiles OUT of sector, same style: {tot_outsame}  (rooms: {rooms_outsame})")
print(f"wall tiles OUT of sector, diff style: {tot_outdiff}  (rooms: {rooms_outdiff})")
print("rooms with out-same claims (px, py, outsame, outdiff):")
for e in outsame_examples:
    print("  ", e)
