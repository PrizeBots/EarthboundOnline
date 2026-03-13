"""
Extract EarthBound ROM data directly using CoilSnake's libraries.
Outputs web-ready JSON and PNG files to public/assets/.
"""

import json
import os
import sys
from pathlib import Path
from PIL import Image

# CoilSnake imports
from coilsnake.model.common.blocks import Rom, ROM_TYPE_NAME_EARTHBOUND
from coilsnake.model.eb.map_tilesets import EbTileset, EbMapPalette
from coilsnake.model.eb.blocks import EbCompressibleBlock
from coilsnake.util.eb.pointer import from_snes_address

# ============ ROM CONSTANTS ============

# Tileset pointers
GRAPHICS_PTR_TABLE = 0xEF105B
ARRANGEMENTS_PTR_TABLE = 0xEF10AB
COLLISIONS_PTR_TABLE = 0xEF117B
MAP_TILESET_TABLE = 0xEF101B
PALETTE_PTR_TABLE = 0xEF10FB

# Map constants
MAP_POINTERS_OFFSET = 0xa1db
LOCAL_TILESETS_OFFSET = 0x175000
MAP_HEIGHT = 320
MAP_WIDTH = 256

# Sector tables
SECTOR_TILESETS_PALETTES = 0xD7A800
SECTOR_MUSIC = 0xDCD637

NUM_TILESETS = 20
NUM_SECTORS_X = 32
NUM_SECTORS_Y = 80
NUM_SECTORS = NUM_SECTORS_X * NUM_SECTORS_Y

# ============ PATHS ============
ROM_PATH = Path(__file__).parent.parent / "EarthBound.sfc"
OUT_DIR = Path(__file__).parent.parent / "public" / "assets"


def extract_tilesets(rom):
    """Extract all 20 tilesets using CoilSnake's own table classes."""
    print("Extracting tilesets...")

    from coilsnake.model.eb.table import eb_table_from_offset

    # Use CoilSnake's table readers
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

    # Extract each tileset
    tilesets = []
    for ts_id in range(NUM_TILESETS):
        print(f"  Tileset {ts_id}...")
        tileset = EbTileset()
        tileset.minitiles_from_block(rom, from_snes_address(graphics_table[ts_id][0]))
        tileset.arrangements_from_block(rom, from_snes_address(arrangements_table[ts_id][0]))
        tileset.collisions_from_block(rom, from_snes_address(collisions_table[ts_id][0]))
        tilesets.append(tileset)

    # Read palettes and assign to tilesets
    print("  Reading palettes...")
    for map_ts_idx in range(map_tileset_table.num_rows):
        draw_tileset = map_tileset_table[map_ts_idx][0]

        # Estimate number of palettes for this map tileset
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

    return tilesets


def save_tileset_data(tilesets):
    """Save tileset data as PNG minitile sheets, arrangement JSON, collision JSON, and palette JSON."""
    print("Saving tileset data...")

    for ts_id, tileset in enumerate(tilesets):
        ts_dir = OUT_DIR / "tilesets" / str(ts_id)
        ts_dir.mkdir(parents=True, exist_ok=True)

        # --- Save minitiles as PNG ---
        # 896 minitiles, each 8x8 pixels, arranged in a grid
        cols = 32
        rows = (896 + cols - 1) // cols  # 28 rows
        img_w = cols * 8
        img_h = rows * 8

        # Get the first available palette for this tileset
        # We need a palette to render the minitiles
        default_palette = None
        for mt, mp, pal in tileset.palettes:
            default_palette = pal
            break

        if default_palette is None:
            # Use a grayscale palette
            img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
            pixels = img.load()
            for tile_idx in range(896):
                tile = tileset.minitiles[tile_idx] if tile_idx < len(tileset.minitiles.tiles) else None
                if tile is None:
                    continue
                bx = (tile_idx % cols) * 8
                by = (tile_idx // cols) * 8
                for y in range(8):
                    for x in range(8):
                        v = tile[y][x] * 17  # scale 0-15 to 0-255
                        pixels[bx + x, by + y] = (v, v, v, 255)
        else:
            img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
            pixels = img.load()
            # Use subpalette 0 as default
            sub_pal = default_palette.subpalettes[0]
            for tile_idx in range(min(896, len(tileset.minitiles.tiles))):
                tile = tileset.minitiles.tiles[tile_idx]
                if tile is None:
                    continue
                bx = (tile_idx % cols) * 8
                by = (tile_idx // cols) * 8
                for y in range(8):
                    for x in range(8):
                        ci = tile[y][x]
                        if ci == 0:
                            pixels[bx + x, by + y] = (0, 0, 0, 0)
                        else:
                            c = sub_pal[ci]
                            pixels[bx + x, by + y] = (c.r, c.g, c.b, 255)

        img.save(str(ts_dir / "minitiles.png"))

        # --- Save all palette subpalettes for each map_tileset/palette combo ---
        palettes_out = {}
        for map_ts, map_pal, palette in tileset.palettes:
            key = f"{map_ts}_{map_pal}"
            pal_data = []
            for sub_idx, subpalette in enumerate(palette.subpalettes):
                sub_colors = []
                for color in subpalette:
                    sub_colors.append([color.r, color.g, color.b, 255])
                pal_data.append(sub_colors)
            palettes_out[key] = pal_data
        with open(str(ts_dir / "palettes.json"), "w") as f:
            json.dump(palettes_out, f)

        # --- Save arrangements ---
        arrangements_out = []
        for arr in tileset.arrangements:
            if arr is None:
                arrangements_out.append({
                    "cells": [{"minitileIndex": 0, "subPalette": 0, "flipH": False, "flipV": False}] * 16,
                })
            else:
                cells = []
                for row in arr:
                    for val in row:
                        # 16-bit value encoding:
                        # bits 0-9: minitile index
                        # bit 10: h flip
                        # bit 11: v flip
                        # bits 12-15: subpalette
                        mt_index = val & 0x3FF
                        flip_h = bool(val & 0x400)
                        flip_v = bool(val & 0x800)
                        sub_pal = (val >> 12) & 0xF
                        cells.append({
                            "minitileIndex": mt_index,
                            "subPalette": sub_pal,
                            "flipH": flip_h,
                            "flipV": flip_v,
                        })
                arrangements_out.append({"cells": cells})

        with open(str(ts_dir / "arrangements.json"), "w") as f:
            json.dump(arrangements_out, f)

        # --- Save collisions ---
        collisions_out = []
        for coll in tileset.collisions:
            if coll is None:
                collisions_out.append([0] * 16)
            else:
                collisions_out.append([coll[j] for j in range(16)])

        with open(str(ts_dir / "collisions.json"), "w") as f:
            json.dump(collisions_out, f)

        print(f"  Tileset {ts_id}: {len(arrangements_out)} arrangements, {len(palettes_out)} palette sets")


def extract_map(rom):
    """Extract the full 256x320 tile map and sector metadata."""
    print("Extracting map data...")

    # Read map tile data
    map_ptrs_addr = from_snes_address(rom.read_multi(MAP_POINTERS_OFFSET, 3))
    map_addrs = [from_snes_address(rom.read_multi(map_ptrs_addr + x * 4, 4)) for x in range(8)]

    tiles = []
    for row_num in range(MAP_HEIGHT):
        offset = map_addrs[row_num % 8] + ((row_num >> 3) << 8)
        row = list(rom[offset:offset + MAP_WIDTH].to_list())
        tiles.append(row)

    # Apply local tileset high bits
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

    # Flatten to a single array for efficient loading
    flat_tiles = []
    for row in tiles:
        flat_tiles.extend(row)

    map_dir = OUT_DIR / "map"
    map_dir.mkdir(parents=True, exist_ok=True)

    with open(str(map_dir / "tiles.json"), "w") as f:
        json.dump(flat_tiles, f)

    print(f"  Map: {MAP_WIDTH}x{MAP_HEIGHT} = {len(flat_tiles)} tiles")

    # Read sector data
    sectors = []
    for i in range(NUM_SECTORS):
        addr = from_snes_address(SECTOR_TILESETS_PALETTES) + i
        val = rom[addr]
        tileset_id = val >> 3
        palette_id = val & 7

        music_addr = from_snes_address(SECTOR_MUSIC) + i
        music_id = rom[music_addr]

        sectors.append({
            "tilesetId": tileset_id,
            "paletteId": palette_id,
            "musicId": music_id,
        })

    with open(str(map_dir / "sectors.json"), "w") as f:
        json.dump(sectors, f)

    # Save the map_tileset -> drawing_tileset mapping
    from coilsnake.model.eb.table import eb_table_from_offset
    map_tileset_table = eb_table_from_offset(MAP_TILESET_TABLE)
    map_tileset_table.from_block(rom, from_snes_address(MAP_TILESET_TABLE))
    tileset_mapping = []
    for i in range(32):
        tileset_mapping.append(map_tileset_table[i][0])
    with open(str(map_dir / "tileset_mapping.json"), "w") as f:
        json.dump(tileset_mapping, f)

    print(f"  Sectors: {len(sectors)} ({NUM_SECTORS_X}x{NUM_SECTORS_Y})")
    print(f"  Tileset mapping: {tileset_mapping}")
    return tiles, sectors


def extract_sprites(rom):
    """Extract sprite groups from ROM."""
    print("Extracting sprites...")

    sprites_dir = OUT_DIR / "sprites"
    sprites_dir.mkdir(parents=True, exist_ok=True)

    # Sprite group pointer table at 0xEF133F
    # Each entry is 4 bytes (CoilSnake table format)
    SPRITE_GROUP_PTR_TABLE = 0xEF133F
    ptr_table_offset = from_snes_address(SPRITE_GROUP_PTR_TABLE)

    try:
        from coilsnake.modules.eb.SpriteGroupModule import SpriteGroupModule
        from coilsnake.model.eb.palettes import EbPalette

        sprite_module = SpriteGroupModule()
        sprite_module.read_from_rom(rom)

        # Read palettes from CoilSnake's palette table (at 0xC30000)
        sprite_palettes = []
        for pal_idx in range(sprite_module.palette_table.num_rows):
            eb_pal = sprite_module.palette_table[pal_idx][0]
            colors = []
            for c_idx in range(eb_pal.subpalette_length):
                c = eb_pal[0, c_idx]
                colors.append([c.r, c.g, c.b, 255])
            sprite_palettes.append(colors)

        # Save palettes
        with open(str(sprites_dir / "palettes.json"), "w") as f:
            json.dump(sprite_palettes, f)

        metadata = []
        for group_id, group in enumerate(sprite_module.groups):
            if group is None or group.num_sprites == 0:
                continue

            # Width/height are in 8px units
            pixel_w = group.width * 8
            pixel_h = group.height * 8

            if pixel_w == 0 or pixel_h == 0:
                continue

            meta = {
                "id": group_id,
                "width": pixel_w,
                "height": pixel_h,
                "palette": group.palette,
            }
            metadata.append(meta)

            # Get the correct palette from CoilSnake's table
            pal_idx = group.palette if group.palette < len(sprite_palettes) else 0
            pal_colors = sprite_palettes[pal_idx]
            eb_palette = sprite_module.palette_table[pal_idx][0]

            indexed_img = group.image(eb_palette)

            # Convert indexed to RGBA
            rgba_img = Image.new("RGBA", indexed_img.size, (0, 0, 0, 0))
            indexed_data = indexed_img.load()
            rgba_data = rgba_img.load()
            for py in range(indexed_img.height):
                for px in range(indexed_img.width):
                    ci = indexed_data[px, py]
                    if ci == 0:
                        continue
                    c = pal_colors[ci] if ci < len(pal_colors) else [255, 0, 255, 255]
                    rgba_data[px, py] = tuple(c)

            rgba_img.save(str(sprites_dir / f"{group_id}.png"))

        with open(str(sprites_dir / "metadata.json"), "w") as f:
            json.dump(metadata, f)

        print(f"  Sprites: {len(metadata)} groups extracted")

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"  Sprite extraction failed: {e}")
        print("  Creating placeholder sprite for Ness...")

        # Create a simple placeholder Ness sprite
        create_placeholder_sprite(sprites_dir)


def extract_doors(rom):
    """Extract door/warp data from ROM using CoilSnake's DoorModule."""
    print("Extracting doors...")

    from coilsnake.modules.eb.DoorModule import DoorModule
    from coilsnake.model.eb.doors import (
        Door, SwitchDoor, RopeOrLadderDoor,
        EscalatorOrStairwayDoor, NpcDoor,
    )

    door_module = DoorModule()
    door_module.read_from_rom(rom)

    doors_out = []  # 2560 entries, one per sector (32x80)
    total_doors = 0

    for area_idx, door_area in enumerate(door_module.door_areas):
        sector_x = area_idx % 32
        sector_y = area_idx // 32

        area_doors = []
        if door_area:
            for door in door_area:
                door_data = {
                    "x": door.x,  # minitile coords within sector
                    "y": door.y,
                }

                if isinstance(door, Door):
                    door_data["type"] = "door"
                    door_data["destX"] = door.destination_x
                    door_data["destY"] = door.destination_y
                    door_data["destDir"] = door.destination_direction
                    door_data["style"] = door.destination_style
                    door_data["flag"] = door.flag
                elif isinstance(door, EscalatorOrStairwayDoor):
                    door_data["type"] = "stair"
                    door_data["direction"] = door.direction
                elif isinstance(door, RopeOrLadderDoor):
                    door_data["type"] = "ladder" if door.climbable_type == 0 else "rope"
                elif isinstance(door, SwitchDoor):
                    door_data["type"] = "switch"
                    door_data["flag"] = door.flag
                elif isinstance(door, NpcDoor):
                    door_data["type"] = "npc"
                else:
                    door_data["type"] = "unknown"

                area_doors.append(door_data)
                total_doors += 1

        doors_out.append(area_doors)

    map_dir = OUT_DIR / "map"
    map_dir.mkdir(parents=True, exist_ok=True)

    with open(str(map_dir / "doors.json"), "w") as f:
        json.dump(doors_out, f)

    print(f"  Doors: {total_doors} across {len(doors_out)} sectors")
    return doors_out


def create_placeholder_sprite(sprites_dir):
    """Create a simple placeholder sprite sheet for Ness."""
    w, h = 16, 24
    img = Image.new("RGBA", (w * 4, h * 4), (0, 0, 0, 0))
    pixels = img.load()

    # Draw a simple character shape for each direction
    for row in range(4):
        for col in range(4):
            ox, oy = col * w, row * h
            # Body
            for y in range(8, 20):
                for x in range(4, 12):
                    pixels[ox + x, oy + y] = (200, 50, 50, 255)
            # Head
            for y in range(2, 10):
                for x in range(4, 12):
                    pixels[ox + x, oy + y] = (255, 200, 150, 255)

    img.save(str(sprites_dir / "1.png"))
    metadata = [{"id": 1, "width": 16, "height": 24, "palette": 0}]
    with open(str(sprites_dir / "metadata.json"), "w") as f:
        json.dump(metadata, f)
    print("  Created placeholder Ness sprite")


def main():
    print(f"Loading ROM: {ROM_PATH}")

    # Load the ROM using CoilSnake's Rom class
    rom = Rom()
    rom.from_file(str(ROM_PATH))

    # Extract everything
    tilesets = extract_tilesets(rom)
    save_tileset_data(tilesets)
    tiles, sectors = extract_map(rom)
    extract_sprites(rom)
    extract_doors(rom)

    print("\nDone! Assets saved to public/assets/")
    print("Run 'npm run dev' to start the game.")


if __name__ == "__main__":
    main()
