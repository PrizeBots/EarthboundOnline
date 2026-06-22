"""
EarthBound map TILE-GRAPHIC animation (the Tile Animation Properties Table).

EB's SECOND animation system (the first is palette cycling — see palette_anim.py).
This one swaps minitile GRAPHICS in VRAM each frame: escalator/conveyor steps,
waterfalls, churning water. It's keyed per GRAPHICS tileset (0-19, the .fts), not
per map palette.

  Tile Animation Properties Table   file 0x2F126B (US 1.0, unheadered; DataCrystal
                                    lists the +0x200 headered 0x2F146B). 20 entries
                                    (one per graphics tileset), variable length:
    1 byte  Num Subentries (0-8 concurrent animations)
    per subentry, 8 bytes:
      0x00 1  Num frames (animation cycles)
      0x01 1  Frame delay (game frames @60Hz per frame)
      0x02 2  Transfer size (bytes of tile chars swapped per cycle)
      0x04 2  Initial source offset into the anim graphics buffer
      0x06 2  VRAM word destination (where the live minitiles sit)

The anim graphics buffer EB decompresses to $7EC000 is a SEPARATE per-tileset asset
(256 minitiles), NOT the tileset's own 896 minitiles. Its pointer table is
`TILE_ANIM_GFX_PTR_TABLE` (20 entries). Frame 0 of the buffer == the live tileset's
animated minitiles (the steps at rest — verified ts12 mt1-18, ts13 mt1-2), and each
later frame advances the source by `transfer size`. So the live minitile at VRAM dst
`D+i` shows BUFFER minitile `src/32 + i + k*stride` on frame k, where
stride = transfer_size/32 (32 bytes = one 4bpp minitile). `remaps[k]` carries that
index; the caller draws it from the buffer returned by `anim_graphics`, not from the
tileset. (The earlier bug read these indices out of the tileset's own minitiles,
which past mt18 are unrelated furniture — hence the in-game garbage flashing.)
"""

from coilsnake.model.eb.blocks import EbCompressibleBlock
from coilsnake.model.eb.graphics import EbGraphicTileset
from coilsnake.util.eb.pointer import from_snes_address

MINITILE_BYTES = 32  # one 4bpp 8x8 minitile
ANIM_TABLE = 0x2F126B  # unheadered US 1.0 file offset (the properties table)
# Per-tileset tile-animation GRAPHICS pointer table (MAP_DATA_TILE_ANIMATION_PTR_TABLE).
# 20 entries; each points to a compressed 256-minitile buffer EB loads to $7EC000.
TILE_ANIM_GFX_PTR_TABLE = 0x2F11CB
ANIM_GFX_NUM_TILES = 256
NUM_TILESETS = 20


def anim_graphics(rom, ts):
    """Decompress tileset `ts`'s tile-animation graphics buffer — the 256 minitiles
    EB loads to $7EC000 and the properties table's src/dst index into. Returns the
    EbGraphicTileset `.tiles` list (256 minitiles, each an 8x8 grid of palette
    indices). The remap values from `tile_animations` index into THIS list."""
    o = TILE_ANIM_GFX_PTR_TABLE + ts * 4
    ptr = rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16)  # 24-bit SNES address
    with EbCompressibleBlock() as block:
        block.from_compressed_block(block=rom, offset=from_snes_address(ptr))
        gfx = EbGraphicTileset(num_tiles=ANIM_GFX_NUM_TILES, tile_width=8, tile_height=8)
        gfx.from_block(block=block, bpp=4)
    return gfx.tiles


def _u8(rom, o):
    return rom[o]


def _u16(rom, o):
    return rom[o] | (rom[o + 1] << 8)


def tile_animations(rom):
    """{drawTilesetId: {"frames": N, "delay": d, "remaps": [ {M: M'} per frame ]}}
    for every graphics tileset that animates minitiles. `remaps[k]` maps each live
    minitile index to the minitile whose graphics it shows on frame k (frame 0 is
    identity). Tilesets with no animation are absent.

    Multiple concurrent sub-animations are merged; if they disagree on frame count
    we use the max and let shorter ones hold their last frame (none do in the ROM —
    every sub-entry of a given tileset shares a frame count)."""
    out = {}
    off = ANIM_TABLE
    for ts in range(NUM_TILESETS):
        n_sub = _u8(rom, off)
        off += 1
        subs = []
        for _ in range(n_sub):
            frames = _u8(rom, off)
            delay = _u8(rom, off + 1)
            transfer = _u16(rom, off + 2)
            src = _u16(rom, off + 4)
            dst = _u16(rom, off + 6)
            off += 8
            subs.append((frames, delay, transfer, src, dst))
        if not subs:
            continue

        n_frames = max(s[0] for s in subs)
        delay = subs[0][1]
        remaps = [dict() for _ in range(n_frames)]
        for (frames, _d, transfer, src, dst) in subs:
            stride = transfer // MINITILE_BYTES   # live minitiles in this band
            src_mt = src // MINITILE_BYTES         # frame-0 source minitile
            dst_mt = dst // 16                      # VRAM word -> minitile (16 words each)
            for i in range(stride):
                live = dst_mt + i
                for k in range(n_frames):
                    fk = k % frames                 # short anims loop within the merged count
                    remaps[k][live] = src_mt + i + fk * stride
        out[ts] = {"frames": n_frames, "delay": delay, "remaps": remaps}
    return out
