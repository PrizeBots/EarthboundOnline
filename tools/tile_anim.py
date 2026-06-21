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

The anim graphics buffer (EB decompresses it to $7EC000) is the tileset's own
minitiles: at frame 0 source==destination (identity), and each later frame advances
the source by `transfer size`. So a live minitile M shows minitile M + k*stride on
frame k, where stride = transfer_size/32 (32 bytes = one 4bpp minitile). We verified
this against the ROM (ts12 minitiles 1/19/37 are distinct escalator-step frames).
"""

MINITILE_BYTES = 32  # one 4bpp 8x8 minitile
ANIM_TABLE = 0x2F126B  # unheadered US 1.0 file offset
NUM_TILESETS = 20


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
