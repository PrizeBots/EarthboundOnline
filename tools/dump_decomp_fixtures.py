"""
Dump EB-decompression PARITY FIXTURES for the TypeScript extraction port.

For a spread of real compressed blocks in the player's ROM, writes:
  - the raw COMPRESSED input bytes (sliced from the ROM)
  - the CoilSnake/native DECOMPRESSED output (ground truth)

The TS parity test (src/extract/decompress.test.ts) feeds each compressed input
through our TS decompress() and asserts byte-equality with the native output.

Output is ROM-DERIVED -> written under tools/_parity/ which is gitignored
(tools/_*). NEVER commit these. Run locally against your own EarthBound.sfc.

Usage:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/dump_decomp_fixtures.py
"""

import json
from pathlib import Path

from coilsnake.model.common.blocks import Rom
from coilsnake.model.eb.blocks import EbCompressibleBlock
from coilsnake.model.eb.table import eb_table_from_offset
from coilsnake.util.eb.pointer import from_snes_address
from coilsnake.modules.eb.EbModule import decomp

ROM_PATH = Path(__file__).parent.parent / "EarthBound.sfc"
OUT_DIR = Path(__file__).parent / "_parity"

# Compressed graphics pointer tables (same ones extract_rom.py reads). Each entry
# points at a compressed block; gives us a varied, real corpus to test against.
GRAPHICS_PTR_TABLE = 0xEF105B
ARRANGEMENTS_PTR_TABLE = 0xEF10AB

# how many entries to sample from each table
SAMPLE = 24


def block_end(rom, start):
    """Walk the exhal command stream to find the compressed block's length
    (up to and including the 0xFF terminator), so we can slice the exact input."""
    pos = start
    while True:
        b = rom[pos]
        pos += 1
        if b == 0xFF:
            break
        if (b & 0xE0) == 0xE0:
            command = (b >> 2) & 0x07
            length = (((b & 0x03) << 8) | rom[pos]) + 1
            pos += 1
        else:
            command = b >> 5
            length = (b & 0x1F) + 1
        if command == 0:
            pos += length          # raw bytes inline
        elif command in (1, 3):
            pos += 1               # one data byte
        elif command == 2:
            pos += 2               # two data bytes
        else:
            pos += 2               # backref: 2 offset bytes
    return pos


def main():
    rom = Rom()
    rom.from_file(str(ROM_PATH))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    fixtures = []
    for table_addr in (GRAPHICS_PTR_TABLE, ARRANGEMENTS_PTR_TABLE):
        table = eb_table_from_offset(table_addr)
        table.from_block(rom, from_snes_address(table_addr))
        n = min(SAMPLE, table.num_rows)
        for i in range(n):
            snes_ptr = table[i][0]
            if snes_ptr == 0:
                continue
            start = from_snes_address(snes_ptr)
            # native ground-truth decompression
            block = EbCompressibleBlock()
            block.from_compressed_block(rom, start)
            expected = list(block.data)
            # exact compressed input slice
            end = block_end(rom, start)
            compressed = [rom[start + k] for k in range(end - start)]
            fixtures.append(
                {
                    "label": f"{hex(table_addr)}#{i}",
                    "compressed": compressed,
                    "expected": expected,
                }
            )

    out = OUT_DIR / "decomp_fixtures.json"
    out.write_text(json.dumps(fixtures))
    print(f"Wrote {len(fixtures)} fixtures -> {out}")
    total = sum(len(f["expected"]) for f in fixtures)
    print(f"Total decompressed bytes covered: {total}")

    dump_table_fixtures(rom)


# Pointer/value tables read by extract_rom.py. (rows, entry_bytes) per table.
TABLES = {
    "graphics": (GRAPHICS_PTR_TABLE, 20, 4),
    "arrangements": (ARRANGEMENTS_PTR_TABLE, 20, 4),
    "collisions": (0xEF117B, 20, 4),
    "map_tileset": (0xEF101B, 32, 2),
    "palette": (0xEF10FB, 32, 4),
    "sprite_group": (0xEF133F, 464, 4),
}


def dump_table_fixtures(rom):
    """Ground-truth table values (via CoilSnake) for the TS Rom.readTable parity
    test, plus the ROM size so the loader's header logic can be sanity-checked."""
    tables = {}
    for name, (addr, rows, entry_bytes) in TABLES.items():
        t = eb_table_from_offset(addr)
        t.from_block(rom, from_snes_address(addr))
        tables[name] = {
            "snesAddr": addr,
            "rows": rows,
            "entryBytes": entry_bytes,
            "values": [t[i][0] for i in range(rows)],
        }
    out = OUT_DIR / "table_fixtures.json"
    out.write_text(json.dumps({"romSize": rom.size, "tables": tables}))
    print(f"Wrote {len(tables)} table fixtures -> {out}")

    dump_tileset_fixtures(rom)


def dump_tileset_fixtures(rom):
    """Ground-truth decoded tilesets (via CoilSnake) for the TS tileset parity
    test — minitiles, arrangement cells, collision bytes, and assigned palettes,
    all 20 drawing tilesets. ROM-derived; gitignored."""
    from coilsnake.model.eb.map_tilesets import EbTileset, EbMapPalette

    NUM_TILESETS = 20
    graphics = eb_table_from_offset(0xEF105B); graphics.from_block(rom, from_snes_address(0xEF105B))
    arrange = eb_table_from_offset(0xEF10AB); arrange.from_block(rom, from_snes_address(0xEF10AB))
    coll = eb_table_from_offset(0xEF117B); coll.from_block(rom, from_snes_address(0xEF117B))
    mapts = eb_table_from_offset(0xEF101B); mapts.from_block(rom, from_snes_address(0xEF101B))
    pal = eb_table_from_offset(0xEF10FB); pal.from_block(rom, from_snes_address(0xEF10FB))

    tilesets = []
    for ts in range(NUM_TILESETS):
        t = EbTileset()
        t.minitiles_from_block(rom, from_snes_address(graphics[ts][0]))
        t.arrangements_from_block(rom, from_snes_address(arrange[ts][0]))
        t.collisions_from_block(rom, from_snes_address(coll[ts][0]))
        tilesets.append(t)

    # palette assignment (same loop as extract_rom.py)
    for map_ts_idx in range(mapts.num_rows):
        draw_ts = mapts[map_ts_idx][0]
        if map_ts_idx == 31:
            num_pal = 8
        else:
            num_pal = (pal[map_ts_idx + 1][0] - pal[map_ts_idx][0]) // 0xC0
        off = from_snes_address(pal[map_ts_idx][0])
        for pal_idx in range(num_pal):
            p = EbMapPalette(); p.from_block(block=rom, offset=off)
            tilesets[draw_ts].add_palette(map_ts_idx, pal_idx, p)
            off += 0xC0

    result = []
    for t in tilesets:
        minitiles = [[[t.minitiles.tiles[n][y][x] for x in range(8)] for y in range(8)]
                     for n in range(896)]
        arrangements = []
        for arr in t.arrangements:
            if arr is None:
                cells = [{"minitileIndex": 0, "subPalette": 0, "flipH": False, "flipV": False}] * 16
            else:
                cells = []
                for row in arr:
                    for val in row:
                        cells.append({
                            "minitileIndex": val & 0x3FF,
                            "flipH": bool(val & 0x400),
                            "flipV": bool(val & 0x800),
                            "subPalette": (val >> 12) & 0xF,
                        })
            arrangements.append({"cells": cells})
        collisions = [([c[j] for j in range(16)] if c is not None else [0] * 16)
                      for c in t.collisions]
        palettes = {}
        for map_ts, map_pal, p in t.palettes:
            palettes[f"{map_ts}_{map_pal}"] = [[[c.r, c.g, c.b, 255] for c in sub]
                                               for sub in p.subpalettes]
        result.append({
            "minitiles": minitiles,
            "arrangements": arrangements,
            "collisions": collisions,
            "palettes": palettes,
        })

    out = OUT_DIR / "tileset_fixtures.json"
    out.write_text(json.dumps(result))
    print(f"Wrote {len(result)} tileset fixtures -> {out}")

    dump_map_fixtures(rom)


def dump_map_fixtures(rom):
    """Ground-truth map plane + sectors + tileset mapping, via the exact logic in
    extract_rom.py's extract_map(). ROM-derived; gitignored."""
    MAP_POINTERS_OFFSET = 0xA1DB
    LOCAL_TILESETS_OFFSET = 0x175000
    MAP_HEIGHT, MAP_WIDTH = 320, 256
    SECTOR_TILESETS_PALETTES = 0xD7A800
    SECTOR_MUSIC = 0xDCD637
    NUM_SECTORS = 32 * 80

    map_ptrs_addr = from_snes_address(rom.read_multi(MAP_POINTERS_OFFSET, 3))
    map_addrs = [from_snes_address(rom.read_multi(map_ptrs_addr + x * 4, 4)) for x in range(8)]

    tiles = []
    for row_num in range(MAP_HEIGHT):
        offset = map_addrs[row_num % 8] + ((row_num >> 3) << 8)
        tiles.append(list(rom[offset:offset + MAP_WIDTH].to_list()))

    k = LOCAL_TILESETS_OFFSET
    for i in range(MAP_HEIGHT >> 3):
        for j in range(MAP_WIDTH):
            tiles[i << 3][j] |= (rom[k] & 3) << 8
            tiles[(i << 3) | 1][j] |= ((rom[k] >> 2) & 3) << 8
            tiles[(i << 3) | 2][j] |= ((rom[k] >> 4) & 3) << 8
            tiles[(i << 3) | 3][j] |= ((rom[k] >> 6) & 3) << 8
            tiles[(i << 3) | 4][j] |= (rom[k + 0x3000] & 3) << 8
            tiles[(i << 3) | 5][j] |= ((rom[k + 0x3000] >> 2) & 3) << 8
            tiles[(i << 3) | 6][j] |= ((rom[k + 0x3000] >> 4) & 3) << 8
            tiles[(i << 3) | 7][j] |= ((rom[k + 0x3000] >> 6) & 3) << 8
            k += 1

    flat = [v for row in tiles for v in row]

    sectors = []
    for i in range(NUM_SECTORS):
        val = rom[from_snes_address(SECTOR_TILESETS_PALETTES) + i]
        sectors.append({
            "tilesetId": val >> 3,
            "paletteId": val & 7,
            "musicId": rom[from_snes_address(SECTOR_MUSIC) + i],
        })

    mapts = eb_table_from_offset(0xEF101B); mapts.from_block(rom, from_snes_address(0xEF101B))
    tileset_mapping = [mapts[i][0] for i in range(32)]

    out = OUT_DIR / "map_fixtures.json"
    out.write_text(json.dumps({
        "tiles": flat,
        "sectors": sectors,
        "tilesetMapping": tileset_mapping,
    }))
    print(f"Wrote map fixtures ({len(flat)} tiles, {len(sectors)} sectors) -> {out}")

    dump_sprite_fixtures(rom)


def dump_sprite_fixtures(rom):
    """Ground-truth sprite groups (via CoilSnake): per-group metadata + decoded
    indexed pixel grid + the 8 shared palettes. ROM-derived; gitignored."""
    from coilsnake.modules.eb.SpriteGroupModule import SpriteGroupModule

    m = SpriteGroupModule()
    m.read_from_rom(rom)

    palettes = []
    for pal_idx in range(m.palette_table.num_rows):
        ep = m.palette_table[pal_idx][0]
        palettes.append([[ep[0, c].r, ep[0, c].g, ep[0, c].b, 255]
                          for c in range(ep.subpalette_length)])

    groups = []
    for gid, group in enumerate(m.groups):
        if group is None or group.num_sprites == 0:
            continue
        pw, ph = group.width * 8, group.height * 8
        if pw == 0 or ph == 0:
            continue
        img = group.image(m.palette_table[group.palette][0])  # indexed 'P' image
        px = img.load()
        pixels = [[px[x, y] for x in range(img.width)] for y in range(img.height)]
        groups.append({
            "meta": {"id": gid, "width": pw, "height": ph, "palette": group.palette},
            "pixels": pixels,
        })

    out = OUT_DIR / "sprite_fixtures.json"
    out.write_text(json.dumps({"groups": groups, "palettes": palettes}))
    print(f"Wrote {len(groups)} sprite groups + {len(palettes)} palettes -> {out}")

    dump_sector_settings_fixtures(rom)


def dump_sector_settings_fixtures(rom):
    """Ground-truth indoor/dungeon/town per sector, produced by add_sector_settings.py's
    OWN yml parser — so the TS ROM-based bake is verified to reproduce it."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "add_sector_settings", Path(__file__).parent / "add_sector_settings.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    info = mod.parse_settings(Path(__file__).parent.parent / "eb_project" / "map_sectors.yml")
    NUM_SECTORS = 32 * 80
    out = []
    for i in range(NUM_SECTORS):
        entry = info.get(i, {})
        setting = entry.get("setting", "none")
        town = entry.get("town", "none")
        rec = {
            "indoor": setting == "indoors",
            "dungeon": setting not in ("none", "indoors"),
        }
        if town and town != "none":
            rec["town"] = town
        out.append(rec)

    p = OUT_DIR / "sector_settings_fixtures.json"
    p.write_text(json.dumps(out))
    n_in = sum(1 for r in out if r["indoor"])
    n_dun = sum(1 for r in out if r["dungeon"])
    print(f"Wrote sector-settings fixtures ({n_in} indoor, {n_dun} dungeon) -> {p}")


if __name__ == "__main__":
    main()
