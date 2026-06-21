"""
EarthBound map palette animation (the "Flash Effect" system).

EB animates a handful of map palettes by swapping the WHOLE palette for a short
sequence of pre-baked frames (Fire Spring lava, water, Moonside, the dept-store
escalators, ...). It is data, not a formula — the frames live in the ROM:

  Palette Animation Pointer Table   file 0x1FE4E1, 31 x 4-byte SNES long ptrs,
                                    indexed by (Flash Effect - 1).
  Secondary / Data Table            each entry: 4-byte ptr to compressed frames,
                                    1 byte = frame count (0..8),
                                    then one duration byte per frame (game frames @60Hz).
  Compressed frames                 decompress to count x 0xC0 bytes; each 0xC0
                                    block is one full map palette (6 subpalettes
                                    x 16 colors, SNES BGR555).

A map (tileset, palette) combo is animated when its "Flash Effect" in
map_palette_settings.yml is non-zero; that value IS the animation index.

NOTE: 0x1FE4E1 is the UNHEADERED US 1.0 offset (DataCrystal lists the headered
0x1FE6E1; we subtract the 0x200 SMC header). We sanity-check every decode, so a
wrong ROM/region fails loudly instead of baking garbage.
"""

from pathlib import Path

import yaml

from coilsnake.model.eb.blocks import EbCompressibleBlock
from coilsnake.model.eb.graphics import EbPalette
from coilsnake.util.eb.pointer import from_snes_address

# Unheadered US 1.0 file offset of the Palette Animation Pointer Table.
PALETTE_ANIM_PTR_TABLE = 0x1FE4E1
PALETTE_BYTES = 0xC0  # one full map palette: 6 subpalettes x 16 colors x 2 bytes
NUM_SUBPALETTES = 6
SUBPALETTE_LEN = 16

_SETTINGS_YML = Path(__file__).parent.parent / "eb_project" / "map_palette_settings.yml"


def _read_long(rom, offset):
    return rom[offset] | (rom[offset + 1] << 8) | (rom[offset + 2] << 16) | (rom[offset + 3] << 24)


def flash_effects():
    """{(mapTileset, paletteId): flashEffect} for every combo whose Flash Effect
    is non-zero (i.e. is animated). Read from the CoilSnake project."""
    with open(_SETTINGS_YML, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    out = {}
    for ts, pals in data.items():
        for pal, info in pals.items():
            fx = info.get("Flash Effect", 0) or 0
            if fx:
                out[(int(ts), int(pal))] = int(fx)
    return out


def _read_animation(rom, flash_effect):
    """Decode one animation index -> (durations, [frame_palettes]).

    Each frame_palette is a list[6] of list[16] of (r, g, b, 255) — exactly the
    `pal_colors` shape build_atlases renders from."""
    idx = flash_effect - 1  # Flash Effect 1..8 -> pointer table index 0..7
    sec_ptr = _read_long(rom, PALETTE_ANIM_PTR_TABLE + idx * 4) & 0xFFFFFF
    sec = from_snes_address(sec_ptr)
    data_ptr = _read_long(rom, sec) & 0xFFFFFF
    n_frames = rom[sec + 4]
    durations = [rom[sec + 5 + i] for i in range(n_frames)]

    blk = EbCompressibleBlock()
    blk.from_compressed_block(rom, from_snes_address(data_ptr))
    if len(blk) != n_frames * PALETTE_BYTES:
        raise ValueError(
            f"Flash Effect {flash_effect}: decompressed {len(blk)} bytes, "
            f"expected {n_frames * PALETTE_BYTES} ({n_frames} frames). "
            f"Wrong ROM region/offset?"
        )

    frames = []
    for f in range(n_frames):
        pal = EbPalette(num_subpalettes=NUM_SUBPALETTES, subpalette_length=SUBPALETTE_LEN)
        pal.from_block(blk, f * PALETTE_BYTES)
        frames.append(
            [
                [(c.r, c.g, c.b, 255) for c in pal.subpalettes[s]]
                for s in range(NUM_SUBPALETTES)
            ]
        )
    return durations, frames


def combo_animations(rom):
    """{(mapTileset, paletteId): {"durations": [...], "frames": [pal_colors, ...]}}
    for every animated combo in the ROM. `frames` are full-palette frame variants
    (same shape as build_atlases' pal_colors); `durations` are game frames @ 60Hz."""
    out = {}
    for combo, fx in flash_effects().items():
        durations, frames = _read_animation(rom, fx)
        out[combo] = {"durations": durations, "frames": frames}
    return out
