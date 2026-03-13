"""
Extract the musicId -> default song number mapping from CoilSnake's map_music.yml.
Outputs a JSON lookup table for the browser engine.
"""

import json
import yaml
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
MAP_MUSIC_YML = PROJECT_DIR / "eb_project" / "map_music.yml"
OUT_DIR = PROJECT_DIR / "public" / "assets" / "music"


def main():
    with open(MAP_MUSIC_YML, "r") as f:
        map_music = yaml.safe_load(f)

    # Build musicId -> default song number mapping
    # The last entry with Event Flag 0x0 is the unconditional default
    music_map = {}
    for music_id, entries in map_music.items():
        default_song = 0
        for entry in entries:
            if entry["Event Flag"] == 0x0:
                song = entry["Music"]
                # Music field is 2 bytes; song number is the value when <= 191
                if song <= 191:
                    default_song = song
                break
        music_map[str(music_id)] = default_song

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "music_map.json", "w") as f:
        json.dump(music_map, f, indent=2)

    # Report unique songs needed
    songs_needed = sorted(set(v for v in music_map.values() if v > 0))
    print(f"Mapped {len(music_map)} music IDs to {len(songs_needed)} unique songs")
    print(f"Song numbers needed: {songs_needed}")
    print(f"SPC files needed: {', '.join(f'eb-{s:03d}.spc' for s in songs_needed)}")
    print(f"\nOutput: {OUT_DIR / 'music_map.json'}")


if __name__ == "__main__":
    main()
