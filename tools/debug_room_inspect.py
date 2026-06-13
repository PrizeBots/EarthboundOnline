"""
Inspect a single room-crop computation: flood size, why it failed (seed vs
cap), sectors/styles claimed, mask size, holes, seams.

    python tools/debug_room_inspect.py px py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from debug_room_crop_check import (  # noqa: E402
    compute_room, make_croppable, solid, sector_at, MAP_W_SEC,
    SEC_MTX, SEC_MTY, MAX_ROOM_MT,
)

px, py = int(sys.argv[1]), int(sys.argv[2])
croppable = make_croppable(indoor_only=False)

print(f"dest pixel ({px},{py}) tile ({px//32},{py//32}) sector ({px//256},{py//128})")
sec = sector_at(px // 256, py // 128)
print(f"sector meta: {sec}")

if not croppable(px // 32, py // 32):
    print("NOT croppable at entry gate")
    sys.exit()

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
        print("SEED FAILED: no walkable minitile within radius 6")
        sys.exit()

visited = set()
stack = [(sx, sy)]
capped = False
while stack:
    x, y = stack.pop()
    if (x, y) in visited or solid(x, y):
        continue
    if not croppable(x >> 2, y >> 2):
        continue
    visited.add((x, y))
    if len(visited) > MAX_ROOM_MT:
        capped = True
        break
    stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])

print(f"flood size: {len(visited)} minitiles{' (CAPPED)' if capped else ''}")
secs = {(x // SEC_MTX, y // SEC_MTY) for (x, y) in visited}
xs = sorted(s[0] for s in secs)
ys = sorted(s[1] for s in secs)
print(f"flood sectors: {len(secs)} spanning x {xs[0]}-{xs[-1]}, y {ys[0]}-{ys[-1]}")

res = compute_room(px, py, croppable)
if res is None:
    print("compute_room: NULL")
else:
    tiles, vis, holes = res
    print(f"mask tiles: {len(tiles)}, holes: {len(holes)}")
