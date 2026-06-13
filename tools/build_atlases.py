"""
Pre-render tileset atlases with correct palettes.
Each atlas = 1024 arrangements rendered at 32x32 = 1024x1024 PNG.
One atlas per (mapTileset, paletteIndex) combination.
"""

import json
import os
import sys
from pathlib import Path
from PIL import Image

from coilsnake.model.common.blocks import Rom
from coilsnake.model.eb.map_tilesets import EbTileset, EbMapPalette
from coilsnake.model.eb.table import eb_table_from_offset
from coilsnake.util.eb.pointer import from_snes_address

# ROM constants
GRAPHICS_PTR_TABLE = 0xEF105B
ARRANGEMENTS_PTR_TABLE = 0xEF10AB
COLLISIONS_PTR_TABLE = 0xEF117B
MAP_TILESET_TABLE = 0xEF101B
PALETTE_PTR_TABLE = 0xEF10FB
SECTOR_TILESETS_PALETTES = 0xD7A800
NUM_TILESETS = 20

ROM_PATH = Path(__file__).parent.parent / "EarthBound.sfc"
OUT_DIR = Path(__file__).parent.parent / "public" / "assets"


def main():
    print("Loading ROM...")
    rom = Rom()
    rom.from_file(str(ROM_PATH))

    # Load tables
    graphics_table = eb_table_from_offset(GRAPHICS_PTR_TABLE)
    arrangements_table = eb_table_from_offset(ARRANGEMENTS_PTR_TABLE)
    collisions_table = eb_table_from_offset(COLLISIONS_PTR_TABLE)
    map_tileset_table = eb_table_from_offset(MAP_TILESET_TABLE)
    palette_table = eb_table_from_offset(PALETTE_PTR_TABLE)

    graphics_table.from_block(rom, from_snes_address(GRAPHICS_PTR_TABLE))
    arrangements_table.from_block(rom, from_snes_address(ARRANGEMENTS_PTR_TABLE))
    collisions_table.from_block(rom, from_snes_address(COLLISIONS_PTR_TABLE))
    map_tileset_table.from_block(rom, from_snes_address(MAP_TILESET_TABLE))
    palette_table.from_block(rom, from_snes_address(PALETTE_PTR_TABLE))

    # Load all tilesets
    print("Loading tilesets...")
    tilesets = []
    for ts_id in range(NUM_TILESETS):
        tileset = EbTileset()
        tileset.minitiles_from_block(rom, from_snes_address(graphics_table[ts_id][0]))
        tileset.arrangements_from_block(rom, from_snes_address(arrangements_table[ts_id][0]))
        tileset.collisions_from_block(rom, from_snes_address(collisions_table[ts_id][0]))
        tilesets.append(tileset)

    # Load all palettes
    print("Loading palettes...")
    for map_ts_idx in range(32):
        draw_tileset = map_tileset_table[map_ts_idx][0]
        if map_ts_idx == 31:
            num_palettes = 8
        else:
            num_palettes = (palette_table[map_ts_idx + 1][0] - palette_table[map_ts_idx][0]) // 0xc0

        palette_offset = from_snes_address(palette_table[map_ts_idx][0])
        for pal_idx in range(num_palettes):
            palette = EbMapPalette()
            palette.from_block(block=rom, offset=palette_offset)
            tilesets[draw_tileset].add_palette(map_ts_idx, pal_idx, palette)
            palette_offset += 0xc0

    # Figure out which (mapTileset, palette) combos are actually used.
    # The game renders public/assets/map/sectors.json — our authored/expanded
    # map, which is LARGER than the ROM's 32x40 base sector table and so
    # references combos that table never lists. Drive the atlas set from that
    # JSON (unioned with the ROM base as a safety net) or whole areas render
    # blank in-game while NPCs still draw — the "missing maps" bug.
    used_combos = set()

    sectors_json = OUT_DIR / "map" / "sectors.json"
    if sectors_json.exists():
        with open(sectors_json) as f:
            for s in json.load(f):
                if s is None:
                    continue
                used_combos.add((s["tilesetId"], s["paletteId"]))
        print(f"Found {len(used_combos)} combos referenced by sectors.json")
    else:
        print("WARNING: sectors.json not found — falling back to ROM base table")

    # Union with the ROM's base 32x40 sector table so nothing regresses.
    for i in range(32 * 40):
        addr = from_snes_address(SECTOR_TILESETS_PALETTES) + i
        val = rom[addr]
        used_combos.add((val >> 3, val & 7))  # (mapTilesetId, paletteId)

    print(f"Rendering {len(used_combos)} unique (mapTileset, palette) combos")

    # Build tileset mapping
    tileset_mapping = []
    for i in range(32):
        tileset_mapping.append(map_tileset_table[i][0])

    # Render atlases
    atlas_dir = OUT_DIR / "atlases"
    atlas_dir.mkdir(parents=True, exist_ok=True)

    for map_ts_id, pal_id in sorted(used_combos):
        draw_ts_id = tileset_mapping[map_ts_id]
        tileset = tilesets[draw_ts_id]

        # Find the matching palette
        palette = None
        for mt, mp, p in tileset.palettes:
            if mt == map_ts_id and mp == pal_id:
                palette = p
                break

        if palette is None:
            # Try palette 0 as fallback
            for mt, mp, p in tileset.palettes:
                if mt == map_ts_id and mp == 0:
                    palette = p
                    break

        if palette is None:
            # Use any palette from this tileset
            if tileset.palettes:
                palette = tileset.palettes[0][2]
            else:
                print(f"  WARNING: No palette for mapTS={map_ts_id} pal={pal_id}, skipping")
                continue

        print(f"  Rendering atlas: mapTS={map_ts_id} pal={pal_id} (drawTS={draw_ts_id})")

        # Build palette lookup: subpalette index -> 16 RGBA colors
        # EbMapPalette has 6 subpalettes of 16 colors each
        pal_colors = []
        for sub_idx in range(6):
            sub = []
            for c_idx in range(16):
                color = palette.subpalettes[sub_idx][c_idx]
                # Color 0 in each subpalette is the BG color — render it solid
                sub.append((color.r, color.g, color.b, 255))
            pal_colors.append(sub)

        # Render 1024 arrangements into a 32x32 grid atlas
        TILE_SIZE = 32
        MINI_SIZE = 8
        ATLAS_COLS = 32
        atlas_w = ATLAS_COLS * TILE_SIZE  # 1024
        atlas_h = ATLAS_COLS * TILE_SIZE  # 1024

        bg_img = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
        bg_pixels = bg_img.load()
        fg_img = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
        fg_pixels = fg_img.load()
        has_fg = False

        for arr_idx in range(1024):
            arrangement = tileset.arrangements[arr_idx]
            if arrangement is None:
                continue

            atlas_x = (arr_idx % ATLAS_COLS) * TILE_SIZE
            atlas_y = (arr_idx // ATLAS_COLS) * TILE_SIZE

            for cy in range(4):
                for cx in range(4):
                    cell_val = arrangement[cy][cx]

                    # Decode 16-bit SNES tilemap entry: vhopppnn nnnnnnnn
                    mt_index = cell_val & 0x3FF         # bits 0-9: tile number
                    sub_pal = (cell_val >> 10) & 0x7    # bits 10-12: palette
                    flip_h = bool(cell_val & 0x4000)    # bit 14: h-flip
                    flip_v = bool(cell_val & 0x8000)    # bit 15: v-flip

                    # SNES BG palette slots 0-1 are reserved (UI/text)
                    # EbMapPalette subpalettes 0-5 map to SNES slots 2-7
                    pal_idx = max(0, sub_pal - 2)
                    sp = pal_colors[pal_idx] if pal_idx < len(pal_colors) else pal_colors[0]

                    # --- Background minitile ---
                    if mt_index < len(tileset.minitiles.tiles) and tileset.minitiles.tiles[mt_index] is not None:
                        minitile = tileset.minitiles.tiles[mt_index]
                        dx = atlas_x + cx * MINI_SIZE
                        dy = atlas_y + cy * MINI_SIZE

                        for py in range(8):
                            for px in range(8):
                                src_x = (7 - px) if flip_h else px
                                src_y = (7 - py) if flip_v else py
                                ci = minitile[src_y][src_x]
                                color = sp[ci] if ci < len(sp) else (255, 0, 255, 255)
                                bg_pixels[dx + px, dy + py] = color

                    # --- Foreground minitile (paired at index + 512) ---
                    if mt_index < 384:
                        fg_index = mt_index + 512
                        if fg_index < len(tileset.minitiles.tiles) and tileset.minitiles.tiles[fg_index] is not None:
                            fg_minitile = tileset.minitiles.tiles[fg_index]
                            dx = atlas_x + cx * MINI_SIZE
                            dy = atlas_y + cy * MINI_SIZE

                            for py in range(8):
                                for px in range(8):
                                    src_x = (7 - px) if flip_h else px
                                    src_y = (7 - py) if flip_v else py
                                    ci = fg_minitile[src_y][src_x]
                                    if ci != 0:  # color 0 = transparent
                                        has_fg = True
                                        color = sp[ci] if ci < len(sp) else (255, 0, 255, 255)
                                        fg_pixels[dx + px, dy + py] = color

        bg_img.save(str(atlas_dir / f"{map_ts_id}_{pal_id}.png"))
        if has_fg:
            fg_img.save(str(atlas_dir / f"{map_ts_id}_{pal_id}_fg.png"))
            print(f"    -> has foreground layer")

    print(f"\nDone! Atlases saved to {atlas_dir}")


if __name__ == "__main__":
    main()
