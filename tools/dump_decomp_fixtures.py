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


if __name__ == "__main__":
    main()
