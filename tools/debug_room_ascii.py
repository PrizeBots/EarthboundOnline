"""
ASCII tile map around a room: replay flood+mask for a door dest and print
per-tile classification to design the wall-ownership rule.

  F = our floor (flood)         W = mask wall tile (dilated)
  x = foreign floor (walkable minitiles not ours)
  m = tile MIXED: some foreign walkable + some solid (not claimable)
  S = fully solid, NOT claimed   . = void (arrangement 0)

Usage: python tools/debug_room_ascii.py 7560 992 [radius]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles_arr = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())

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
        stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    return visited

px, py = int(sys.argv[1]), int(sys.argv[2])
RAD = int(sys.argv[3]) if len(sys.argv) > 3 else 8

seed = find_seed(px, py)
visited = flood(*seed)

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

txs = [t[0] for t in floor_tiles]; tys = [t[1] for t in floor_tiles]
x0, x1 = min(txs) - RAD, max(txs) + RAD
y0, y1 = min(tys) - RAD, max(tys) + RAD

print(f"door dest px ({px},{py}) tile ({px//32},{py//32})  floor tiles {len(floor_tiles)}  mask {len(tiles)}")
print(f"tile window x {x0}..{x1}, y {y0}..{y1}")
hdr = "     " + "".join(str(tx % 10) for tx in range(x0, x1 + 1))
print(hdr)
for ty in range(y0, y1 + 1):
    row = []
    for tx in range(x0, x1 + 1):
        has_own = (tx, ty) in floor_tiles
        n_walk_foreign = 0
        n_solid = 0
        for my in range(4):
            for mx in range(4):
                m = (tx * 4 + mx, ty * 4 + my)
                if solid(*m):
                    n_solid += 1
                elif m not in visited:
                    n_walk_foreign += 1
        if has_own:
            c = "F"
        elif (tx, ty) in tiles:
            c = "W"
        elif tile_at(tx, ty) == 0:
            c = "."
        elif n_walk_foreign and n_solid:
            c = "m"
        elif n_walk_foreign:
            c = "x"
        else:
            c = "S"
        row.append(c)
    print(f"{ty:4d} " + "".join(row))
