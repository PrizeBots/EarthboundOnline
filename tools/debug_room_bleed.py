"""
Render the masked view (exactly what Renderer.ts shows) for interior rooms
reached via doors, to find rooms whose mask leaks neighboring-room graphics.

Usage:
  python tools/debug_room_bleed.py            # rooms reachable from Onett-area doors
  python tools/debug_room_bleed.py all        # every unique indoor room, bleed-suspects only
"""
import json
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
OUT = ROOT / "tools" / "debug_rooms"
OUT.mkdir(exist_ok=True)

sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles_arr = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())
doors_raw = json.loads((A / "map" / "doors.json").read_text())

MAP_W_SEC, MAP_H_SEC = 32, 80
SEC_TX, SEC_TY = 8, 4
MAP_W_T, MAP_H_T = MAP_W_SEC * SEC_TX, MAP_H_SEC * SEC_TY
MAP_W_MT, MAP_H_MT = MAP_W_T * 4, MAP_H_T * 4
TILE = 32

collisions = {}
def get_collisions(ts):
    if ts not in collisions:
        collisions[ts] = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
    return collisions[ts]

atlases = {}
def get_atlas(ts, pal):
    key = (ts, pal)
    if key not in atlases:
        p = A / "atlases" / f"{ts}_{pal}.png"
        atlases[key] = Image.open(p).convert("RGB") if p.exists() else None
    return atlases[key]

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
        if not indoor(x >> 2, y >> 2):
            continue  # mirrors Collision.ts: never leave indoor sectors
        visited.add((x, y))
        if len(visited) > MAX_ROOM_MT:
            return None
        stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    return visited

def minitile_sector(mtx, mty):
    return ((mty >> 2) // SEC_TY) * MAP_W_SEC + ((mtx >> 2) // SEC_TX)

def merge_pockets(visited):
    """Merge enclosed walkable pockets (e.g. clerk areas behind counters) that
    the player flood can't reach but that lie wholly inside the room's sectors."""
    flood_secs = {minitile_sector(mtx, mty) for (mtx, mty) in visited}
    processed = set()
    merged = 0
    for sec_idx in sorted(flood_secs):
        sy, sx = divmod(sec_idx, MAP_W_SEC)
        for mty in range(sy * SEC_TY * 4, (sy + 1) * SEC_TY * 4):
            for mtx in range(sx * SEC_TX * 4, (sx + 1) * SEC_TX * 4):
                m = (mtx, mty)
                if m in visited or m in processed or solid(*m):
                    continue
                region = set()
                stack = [m]
                ok = True
                while stack:
                    x, y = stack.pop()
                    if (x, y) in region or (x, y) in visited or solid(x, y):
                        continue
                    region.add((x, y))
                    if minitile_sector(x, y) not in flood_secs:
                        ok = False  # leaks out of the room's sectors: foreign
                    stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
                processed |= region
                if ok:
                    visited |= region
                    merged += len(region)
    return merged

def compute_mask(visited):
    """Replicates computeRoomBounds dilation. Returns (tiles, floor_tiles)."""
    tiles = set()
    for (mtx, mty) in visited:
        tiles.add((mtx >> 2, mty >> 2))
    floor_tiles = set(tiles)

    flood_sectors = set()
    flood_styles = set()
    for (tx, ty) in floor_tiles:
        sx, sy = tx // SEC_TX, ty // SEC_TY
        flood_sectors.add(sy * MAP_W_SEC + sx)
        s = sectors[sy * MAP_W_SEC + sx]
        flood_styles.add((s["tilesetId"], s["paletteId"]))

    def is_own_wall(tx, ty):
        if not (0 <= tx < MAP_W_T and 0 <= ty < MAP_H_T):
            return False
        if tile_at(tx, ty) == 0:
            return False
        sx, sy = tx // SEC_TX, ty // SEC_TY
        if sy * MAP_W_SEC + sx not in flood_sectors:
            s = sectors[sy * MAP_W_SEC + sx]
            if (s["tilesetId"], s["paletteId"]) not in flood_styles:
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
    return tiles, floor_tiles

def foreign_floor_tiles_near(tiles, visited, radius=5):
    """Tiles near the mask containing walkable minitiles NOT in our flood."""
    foreign = set()
    txs = [t[0] for t in tiles]; tys = [t[1] for t in tiles]
    for ty in range(min(tys) - radius, max(tys) + radius + 1):
        for tx in range(min(txs) - radius, max(txs) + radius + 1):
            for my in range(4):
                for mx in range(4):
                    m = (tx * 4 + mx, ty * 4 + my)
                    if not solid(*m) and m not in visited:
                        foreign.add((tx, ty))
                        break
                else:
                    continue
                break
    return foreign

def suspects(tiles, floor_tiles, visited):
    """Dilated tiles that sit closer to a foreign room's floor than to ours."""
    foreign = foreign_floor_tiles_near(tiles, visited)
    out = set()
    for (tx, ty) in tiles - floor_tiles:
        d_own = min(max(abs(tx - fx), abs(ty - fy)) for (fx, fy) in floor_tiles)
        d_for = min((max(abs(tx - fx), abs(ty - fy)) for (fx, fy) in foreign), default=99)
        if d_for < d_own:
            out.add((tx, ty))
    return out

def render_room(visited, tiles, floor_tiles, sus, dest_px, name):
    txs = [t[0] for t in tiles]; tys = [t[1] for t in tiles]
    pad = 3
    x0, x1 = min(txs) - pad, max(txs) + pad
    y0, y1 = min(tys) - pad, max(tys) + pad
    w, h = (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE
    # two panels: raw map | masked view (what the player sees)
    img = Image.new("RGB", (w * 2 + 8, h), (40, 40, 40))
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            sec = sector_for_tile(tx, ty)
            if sec is None:
                continue
            atlas = get_atlas(sec["tilesetId"], sec["paletteId"])
            if atlas is None:
                continue
            arr = tile_at(tx, ty)
            sx, sy = (arr % 32) * TILE, (arr // 32) * TILE
            tile_img = atlas.crop((sx, sy, sx + TILE, sy + TILE))
            dx, dy = (tx - x0) * TILE, (ty - y0) * TILE
            img.paste(tile_img, (dx, dy))  # raw panel
            if (tx, ty) in tiles:
                img.paste(tile_img, (w + 8 + dx, dy))  # masked panel
                # holes: foreign/solid-free minitiles blacked out by renderer
                for my in range(4):
                    for mx in range(4):
                        m = (tx * 4 + mx, ty * 4 + my)
                        if not solid(*m) and m not in visited:
                            for py_ in range(8):
                                for px_ in range(8):
                                    img.putpixel((w + 8 + dx + mx * 8 + px_, dy + my * 8 + py_), (0, 0, 0))
                # tint suspects red on the masked panel
                if (tx, ty) in sus:
                    for py_ in range(TILE):
                        for px_ in range(TILE):
                            r, g, b = img.getpixel((w + 8 + dx + px_, dy + py_))
                            img.putpixel((w + 8 + dx + px_, dy + py_), (min(255, r + 120), g // 2, b // 2))
    # mark the door destination with a green dot on both panels
    mx_, my_ = dest_px[0] // TILE - x0, dest_px[1] // TILE - y0
    for off in (0, w + 8):
        for py_ in range(6):
            for px_ in range(6):
                X = off + mx_ * TILE + (dest_px[0] % TILE) - 3 + px_
                Y = my_ * TILE + (dest_px[1] % TILE) - 3 + py_
                if 0 <= X < img.width and 0 <= Y < img.height:
                    img.putpixel((X, Y), (0, 255, 0))
    img = img.resize((img.width * 2, img.height * 2), Image.NEAREST)
    img.save(OUT / f"{name}.png")

# ---- collect door destinations ----
def all_doors():
    """Yield (src_px, dest_px) for every warp door."""
    for idx, area in enumerate(doors_raw):
        ax, ay = idx % 32, idx // 32
        for d in area:
            if d.get("type") != "door":
                continue
            src = (ax * 256 + d["x"] * 8 + 8, ay * 256 + d["y"] * 8 + 4)
            dest = (d.get("destX", 0) * 8, d.get("destY", 0) * 8)
            yield src, dest

mode = sys.argv[1] if len(sys.argv) > 1 else "onett"

if mode not in ("onett", "all"):
    # single room: debug_room_bleed.py <px> <py>
    targets = [(int(sys.argv[1]), int(sys.argv[2]))]
    mode = "onett"  # force render
elif mode == "onett":
    # doors whose SOURCE is in the Onett overworld region near spawn (1296,1168)
    first_hop = [(s, t) for (s, t) in all_doors()
                 if 700 <= s[0] <= 2200 and 600 <= s[1] <= 2200
                 and indoor(t[0] // 32, t[1] // 32)]
    dests = {t for (_, t) in first_hop}
    # second hop: doors INSIDE those interiors (e.g. hotel lobby -> bedrooms)
    interiors = set()
    for t in list(dests):
        seed = find_seed(*t)
        if seed:
            v = flood(*seed)
            if v:
                interiors.add(min(v))
                for (s2, t2) in all_doors():
                    if (s2[0] // 8, s2[1] // 8) in v or \
                       any((s2[0] // 8 + dx, s2[1] // 8 + dy) in v for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2)):
                        if indoor(t2[0] // 32, t2[1] // 32):
                            dests.add(t2)
    targets = sorted(dests)
else:
    targets = sorted({t for (_, t) in all_doors() if indoor(t[0] // 32, t[1] // 32)})

seen = {}
report = []
for t in targets:
    seed = find_seed(*t)
    if seed is None:
        continue
    v = flood(*seed)
    if v is None:
        continue
    sig = min(v)
    if sig in seen:
        continue
    seen[sig] = t
    pocket = merge_pockets(v)
    tiles, floor_tiles = compute_mask(v)
    name = f"room_{t[0]}_{t[1]}{'_POCKET' if pocket else ''}"
    if mode == "onett" or pocket:
        render_room(v, tiles, floor_tiles, set(), t, name)
    report.append((t, len(tiles), pocket, name))

report.sort(key=lambda r: -r[2])
for t, n, p, name in report:
    print(f"dest px {t}  mask {n:4d} tiles  pocket minitiles {p:4d}  -> {name}.png" if p else
          f"dest px {t}  mask {n:4d} tiles  no pockets")
