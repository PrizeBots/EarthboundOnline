"""
Map Zophar's EarthBound SPC files to ROM song numbers.
Uses the track number from the filename prefix as a sequential index,
then maps to ROM song numbers by matching the Zophar ordering to the
ROM's song table.

The Zophar rip uses track numbers 001-206 which correspond to the ROM's
song table entries (some songs have multiple variants a/b/c).
We take the first variant for each track number.
"""

import json
import os
import shutil
from pathlib import Path

SPC_DIR = Path(os.environ.get("TEMP", "/tmp")) / "eb_spc_extracted"
OUT_DIR = Path(__file__).parent.parent / "public" / "assets" / "music" / "spc"


def parse_spc_id666(spc_path: Path) -> dict:
    """Read ID666 tags from SPC header."""
    with open(spc_path, "rb") as f:
        data = f.read(256)

    return {
        "title": data[0x2E:0x4E].split(b"\x00")[0].decode("ascii", errors="replace").strip(),
        "game": data[0x4E:0x6E].split(b"\x00")[0].decode("ascii", errors="replace").strip(),
        "dumper": data[0x6E:0x7E].split(b"\x00")[0].decode("ascii", errors="replace").strip(),
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Group SPC files by their track number prefix (001, 002, etc.)
    # Files like "016a Onett Buzz Buzz 1.spc" and "016b ..." share track 016
    tracks = {}
    for spc_file in sorted(SPC_DIR.glob("*.spc")):
        name = spc_file.stem
        # Extract leading digits
        num_str = ""
        for c in name:
            if c.isdigit():
                num_str += c
            else:
                break
        if not num_str:
            continue
        track_num = int(num_str)
        # Take first variant (a) for each track
        if track_num not in tracks:
            tracks[track_num] = spc_file

    print(f"Found {len(tracks)} unique tracks in SPC archive")

    # The Zophar track numbers map 1:1 to ROM song numbers.
    # Track 001 = song 0x01 (1), track 002 = song 0x02 (2), etc.
    # Some tracks are sound effects (900+), skip those.
    matched = 0
    for track_num, spc_file in sorted(tracks.items()):
        if track_num > 191:  # Max song number is 0xBF = 191
            continue
        song_num = track_num
        out_name = f"eb-{song_num:03d}.spc"
        out_path = OUT_DIR / out_name
        shutil.copy2(spc_file, out_path)
        tags = parse_spc_id666(spc_file)
        print(f"  Track {track_num:03d} -> {out_name}: {tags['title']}")
        matched += 1

    print(f"\nCopied {matched} SPC files")

    # Check which songs we still need
    music_map_path = Path(__file__).parent.parent / "public" / "assets" / "music" / "music_map.json"
    with open(music_map_path) as f:
        music_map = json.load(f)
    needed = sorted(set(v for v in music_map.values() if v > 0))
    have = sorted(int(f.stem.split("-")[1]) for f in OUT_DIR.glob("eb-*.spc"))
    missing = [n for n in needed if n not in have]
    if missing:
        print(f"\nStill missing songs needed for map music: {missing}")
    else:
        print(f"\nAll {len(needed)} map music songs are present!")


if __name__ == "__main__":
    main()
