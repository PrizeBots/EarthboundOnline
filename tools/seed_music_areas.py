"""Seed overrides/music.json from the ROM's per-sector music.

The engine already plays music per sector (sectors.json `musicId` -> music_map.json
-> SPC song number). The Sound Manager editor's override layer normally starts
EMPTY (you only draw a box where the sector default is wrong). This tool instead
*materializes the current state* as editable rectangle areas, so the Sound Manager
opens with the whole map's music already listed and you fix the wrong spots in place.

Method: build the per-sector song grid (32 wide x 80 tall), then greedily cover
same-song neighbours with maximal rectangles so contiguous regions become one big
area instead of thousands of cells. Silent sectors (song 0) are skipped — they
play nothing either way, so seeding them would only clutter the list.

Output area rect is in WORLD PIXELS to match MusicManager.songForPoint:
  sector (sx, sy) -> x = sx*64, y = sy*32, each sector 64x32 px (8x4 tiles * 8px).

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/seed_music_areas.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECTORS = os.path.join(ROOT, "public", "assets", "map", "sectors.json")
MUSIC_MAP = os.path.join(ROOT, "public", "assets", "music", "music_map.json")
OUT = os.path.join(ROOT, "public", "overrides", "music.json")

W = 32                 # map is 32 sectors wide; height grows with the interiors band
# Sector pixel size MUST match the engine's units (src/types.ts): a tile is
# TILE_SIZE=32 px (4x4 minitiles of 8 px), a sector is 8x4 tiles → 256x128 px.
# (Was 64x32, assuming 8-px tiles — that put every zone at 1/4 scale, crammed
# into the top-left corner and misaligned with the world / MusicManager.)
SECTOR_W, SECTOR_H = 8 * 32, 4 * 32  # 256 x 128 px per sector


def main():
    sectors = json.load(open(SECTORS))
    music_map = json.load(open(MUSIC_MAP))
    # Height is derived: the stitched map gains rows as interiors are appended,
    # so don't hardcode it (was 80; now grows). Must divide evenly by width.
    assert len(sectors) % W == 0, f"{len(sectors)} sectors not divisible by width {W}"
    H = len(sectors) // W
    print(f"map: {W}x{H} sectors ({len(sectors)} total)")

    # Per-sector final song number (what actually plays); 0 = silence/none.
    song = [[0] * W for _ in range(H)]
    for sy in range(H):
        for sx in range(W):
            mid = sectors[sy * W + sx].get("musicId", 0)
            song[sy][sx] = int(music_map.get(str(mid), 0) or 0)

    covered = [[False] * W for _ in range(H)]
    areas = []

    def row_ok(y, x0, x1, s):
        return all(not covered[y][x] and song[y][x] == s for x in range(x0, x1 + 1))

    for sy in range(H):
        for sx in range(W):
            if covered[sy][sx]:
                continue
            s = song[sy][sx]
            if s <= 0:
                covered[sy][sx] = True   # skip silence, no area
                continue
            # Grow right along this row.
            x1 = sx
            while x1 + 1 < W and not covered[sy][x1 + 1] and song[sy][x1 + 1] == s:
                x1 += 1
            # Grow down while the whole [sx..x1] span stays same-song & free.
            y1 = sy
            while y1 + 1 < H and row_ok(y1 + 1, sx, x1, s):
                y1 += 1
            for y in range(sy, y1 + 1):
                for x in range(sx, x1 + 1):
                    covered[y][x] = True
            areas.append({
                "name": f"song{s} ({sx},{sy})",
                "x": sx * SECTOR_W,
                "y": sy * SECTOR_H,
                "w": (x1 - sx + 1) * SECTOR_W,
                "h": (y1 - sy + 1) * SECTOR_H,
                "song": s,
            })

    out = {"version": 1, "areas": areas}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.replace(OUT, OUT + ".bak")
    json.dump(out, open(OUT, "w"), indent=2)
    open(OUT, "a").write("\n")

    songs = sorted({a["song"] for a in areas})
    print(f"Wrote {len(areas)} music areas -> public/overrides/music.json")
    print(f"{len(songs)} distinct songs: {songs}")


if __name__ == "__main__":
    main()
