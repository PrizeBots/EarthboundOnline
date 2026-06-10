"""
Merge the per-sector "Setting" flag from the CoilSnake project (map_sectors.yml)
into public/assets/map/sectors.json as an `indoor` boolean.

The ROM extractor (extract_rom.py) only pulls tileset/palette/music. The "Setting"
byte (none / indoors / exit mouse usable / ...) lives in the decompiled project.
Rooms with Setting == "indoors" are interiors that must be camera-cropped to the
current room (see Camera.roomBounds / Renderer room masking).

Run after extract_rom.py:
    C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/add_sector_settings.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECTORS_YML = ROOT / "eb_project" / "map_sectors.yml"
SECTORS_JSON = ROOT / "public" / "assets" / "map" / "sectors.json"


def parse_settings(yml_path: Path) -> dict:
    """Minimal parser: maps sector index -> Setting string (no YAML dependency)."""
    settings = {}
    idx = None
    index_re = re.compile(r"^(\d+):\s*$")
    setting_re = re.compile(r"^\s+Setting:\s*(.+?)\s*$")
    with open(yml_path, "r", encoding="utf-8") as f:
        for line in f:
            m = index_re.match(line)
            if m:
                idx = int(m.group(1))
                continue
            s = setting_re.match(line)
            if s and idx is not None:
                settings[idx] = s.group(1)
    return settings


def main():
    settings = parse_settings(SECTORS_YML)
    sectors = json.loads(SECTORS_JSON.read_text())

    indoor_count = 0
    for i, sector in enumerate(sectors):
        is_indoor = settings.get(i) == "indoors"
        sector["indoor"] = is_indoor
        if is_indoor:
            indoor_count += 1

    SECTORS_JSON.write_text(json.dumps(sectors))
    print(f"Tagged {indoor_count}/{len(sectors)} sectors as indoor")


if __name__ == "__main__":
    main()
