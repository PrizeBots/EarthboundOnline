"""
Pre-render tileset atlases with correct palettes.
Each atlas = 1024 arrangements rendered at 32x32 = 1024x1024 PNG.
One atlas per (mapTileset, paletteIndex) combination.
"""

import json
import math
import os
import sys
from pathlib import Path
from PIL import Image

from coilsnake.model.common.blocks import Rom
from coilsnake.model.eb.map_tilesets import EbTileset, EbMapPalette
from coilsnake.model.eb.table import eb_table_from_offset
from coilsnake.util.eb.pointer import from_snes_address

from palette_anim import combo_animations
from tile_anim import tile_animations, anim_graphics

# Graphics tilesets whose TILE-GRAPHIC animation we bake. The frames are drawn from
# the per-tileset $7EC000 animation buffer (tile_anim.anim_graphics) — the separate
# 256-minitile asset EB DMAs into VRAM, NOT the tileset's own minitiles. {12,13} are
# the dept-store escalators (Twoson drawTS 12, Fourside drawTS 13). The water/
# waterfall tilesets (0,1,5,6,7,8,16,17,18,19) animate the same way and are now
# unblocked too — left off pending an in-game look (some target the FG layer).
ESCALATOR_DRAW_TS = {12, 13}

TILE_SIZE = 32
MINI_SIZE = 8
ATLAS_COLS = 32


def render_atlas(tileset, pal_colors, mt_remap=None, anim_tiles=None):
    """Render one (tileset, palette) into BG + FG atlas images.

    `pal_colors` = list[6] of list[16] of (r, g, b, a) — the resolved subpalette
    colors. `mt_remap` (optional) = {liveMinitileIdx: animBufferIdx} that swaps which
    minitile GRAPHICS a BG cell draws — used for tile-graphic animation frames
    (escalator steps etc.). The substitute is drawn from `anim_tiles` (the tileset's
    $7EC000 animation buffer from tile_anim.anim_graphics), NOT the tileset's own
    minitiles. The FG layer is untouched (escalator animation is BG-only).
    Returns (bg_img, fg_img, has_fg). Used for the static atlas and each
    palette/tile animation frame."""
    atlas_w = ATLAS_COLS * TILE_SIZE  # 1024
    atlas_h = ATLAS_COLS * TILE_SIZE
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

                # --- Background minitile (tile-animation frames swap which one) ---
                # A remapped cell draws from the animation buffer ($7EC000); every
                # other cell draws its normal minitile from the tileset.
                minitile = None
                if mt_remap and mt_index in mt_remap and anim_tiles is not None:
                    sub = mt_remap[mt_index]
                    if sub < len(anim_tiles):
                        minitile = anim_tiles[sub]
                if minitile is None:
                    bg_mt = mt_index
                    if bg_mt < len(tileset.minitiles.tiles):
                        minitile = tileset.minitiles.tiles[bg_mt]
                if minitile is not None:
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

    return bg_img, fg_img, has_fg


def colors_from_palette(palette):
    """Resolve an EbMapPalette into the `pal_colors` shape render_atlas wants."""
    pal_colors = []
    for sub_idx in range(6):
        sub = []
        for c_idx in range(16):
            color = palette.subpalettes[sub_idx][c_idx]
            sub.append((color.r, color.g, color.b, 255))
        pal_colors.append(sub)
    return pal_colors

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

    # ROM palette animations (the "Flash Effect" combos), keyed by (mapTS, pal).
    # Only the ~8 animated combos appear here; everything else renders static.
    anims = combo_animations(rom)
    print(f"Found {len(anims)} animated palette combos: {sorted(anims.keys())}")
    # Tile-graphic animations (escalator steps), keyed by GRAPHICS (draw) tileset.
    tile_anims = tile_animations(rom)
    print(f"Tile animations on draw tilesets: {sorted(tile_anims.keys())} (baking {sorted(ESCALATOR_DRAW_TS)})")
    # The $7EC000 animation-graphics buffer (256 minitiles) for each baked tileset —
    # the frame source the remaps index into. Decompressed once per draw tileset.
    anim_gfx = {ts: anim_graphics(rom, ts) for ts in ESCALATOR_DRAW_TS}
    anim_manifest = {}

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

        pal_anim = anims.get((map_ts_id, pal_id))  # palette cycling (water/lava/...)
        tile_anim = tile_anims.get(draw_ts_id) if draw_ts_id in ESCALATOR_DRAW_TS else None
        key = f"{map_ts_id}_{pal_id}"

        # Static atlas (the base palette). Always emitted — the fallback the renderer
        # shows until animation frames stream in, and what every static combo uses.
        base_colors = colors_from_palette(palette)
        bg_img, fg_img, has_fg = render_atlas(tileset, base_colors)
        bg_img.save(str(atlas_dir / f"{key}.png"))
        if has_fg:
            fg_img.save(str(atlas_dir / f"{key}_fg.png"))

        # Build the animation frame list. EB has TWO systems and a combo can use
        # both (Fourside, 29_3): palette cycling swaps the colors, tile animation
        # swaps which minitile graphics a cell draws (the moving escalator steps).
        # Each frame is (colors, minitile_remap); we merge to lcm(frames) and use the
        # tile delay when present (step motion is the visible thing).
        frames = []  # (colors, mt_remap_or_None)
        durations = []
        if pal_anim and tile_anim:
            pf, tf = len(pal_anim["frames"]), tile_anim["frames"]
            count = pf * tf // math.gcd(pf, tf)
            for k in range(count):
                frames.append((pal_anim["frames"][k % pf], tile_anim["remaps"][k % tf]))
                durations.append(tile_anim["delay"])
            kind = f"palette+tile ({count}f)"
        elif pal_anim:
            frames = [(fc, None) for fc in pal_anim["frames"]]
            durations = list(pal_anim["durations"])
            kind = f"palette ({len(frames)}f)"
        elif tile_anim:
            frames = [(base_colors, tile_anim["remaps"][k]) for k in range(tile_anim["frames"])]
            durations = [tile_anim["delay"]] * tile_anim["frames"]
            kind = f"tile/escalator ({len(frames)}f)"
        else:
            kind = "static"

        note = "" if kind == "static" else f"  [{kind}]"
        print(f"  Rendering atlas: mapTS={map_ts_id} pal={pal_id} (drawTS={draw_ts_id}){note}")
        if has_fg:
            print("    -> has foreground layer")

        # Bake one atlas per animation frame ({key}_f{k}.png). Frame 0 == the static
        # atlas (seamless), so the renderer can swap to it without a visible jump.
        if frames:
            anim_tiles = anim_gfx.get(draw_ts_id)
            for k, (fc, rm) in enumerate(frames):
                fbg, ffg, fhas_fg = render_atlas(tileset, fc, rm, anim_tiles)
                fbg.save(str(atlas_dir / f"{key}_f{k}.png"))
                if fhas_fg:
                    ffg.save(str(atlas_dir / f"{key}_f{k}_fg.png"))
            anim_manifest[key] = {
                "frames": len(frames),
                "durations": durations,  # per-frame, in game frames @ 60Hz
                "fg": has_fg,
            }
            print(f"    -> {len(frames)} animation frames, durations={durations}")

    # Runtime manifest: which combos animate, frame counts, per-frame durations.
    with open(atlas_dir / "anim.json", "w") as f:
        json.dump({"version": 1, "frameRateHz": 60, "combos": anim_manifest}, f, indent=2)
    print(f"\nWrote anim.json: {len(anim_manifest)} animated combos")
    print(f"Done! Atlases saved to {atlas_dir}")


if __name__ == "__main__":
    main()
