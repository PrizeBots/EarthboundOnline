"""
Merge the per-sector "Setting" flag from the CoilSnake project (map_sectors.yml)
into public/assets/map/sectors.json as `indoor` / `dungeon` booleans.

The ROM extractor (extract_rom.py) only pulls tileset/palette/music. The "Setting"
byte (none / indoors / exit mouse usable / ...) lives in the decompiled project.
Setting == "indoors" marks house/shop interiors. Every OTHER non-"none" setting
("exit mouse usable" = caves/dungeons, plus the magicant / robot / lost
underworld sprite modes) marks an off-overworld chunk: like interiors they are
packed adjacent to unrelated map chunks on the big stitched map and must be
camera-cropped to the current room (Camera.roomBounds / Renderer room masking).
Caves without the flag showed neighboring map areas (see bugs.md). The robot
column inside the Cave of the Past cluster also means dungeon floods must be
able to cross these settings, or rooms get split mid-cave.

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
    """Minimal parser: sector index -> {setting, town} (no YAML dependency).

    `town` comes from the "Town Map Image" field (onett/twoson/.../none) — the
    overworld region each sector belongs to. Interiors/dungeons are "none".
    """
    out = {}
    idx = None
    index_re = re.compile(r"^(\d+):\s*$")
    setting_re = re.compile(r"^\s+Setting:\s*(.+?)\s*$")
    town_re = re.compile(r"^\s+Town Map Image:\s*(.+?)\s*$")
    with open(yml_path, "r", encoding="utf-8") as f:
        for line in f:
            m = index_re.match(line)
            if m:
                idx = int(m.group(1))
                continue
            if idx is None:
                continue
            s = setting_re.match(line)
            if s:
                out.setdefault(idx, {})["setting"] = s.group(1)
                continue
            t = town_re.match(line)
            if t:
                out.setdefault(idx, {})["town"] = t.group(1)
    return out


def main():
    info = parse_settings(SECTORS_YML)
    sectors = json.loads(SECTORS_JSON.read_text())

    indoor_count = dungeon_count = town_count = 0
    for i, sector in enumerate(sectors):
        entry = info.get(i, {})
        setting = entry.get("setting", "none")
        is_indoor = setting == "indoors"
        # "dungeon" = any special-setting chunk off the seamless overworld:
        # caves ("exit mouse usable"), Magicant, Cave of the Past (robot),
        # Lost Underworld. All are room-cropped exactly like interiors.
        is_dungeon = setting not in ("none", "indoors")
        sector["indoor"] = is_indoor
        sector["dungeon"] = is_dungeon
        indoor_count += is_indoor
        dungeon_count += is_dungeon

        # Overworld region name (drives the editor's location navigator). Pure
        # metadata we author from the decompile, not ROM pixels — fine to ship.
        town = entry.get("town", "none")
        if town and town != "none":
            sector["town"] = town
            town_count += 1
        else:
            sector.pop("town", None)

    SECTORS_JSON.write_text(json.dumps(sectors))
    print(
        f"Tagged {indoor_count}/{len(sectors)} sectors as indoor, "
        f"{dungeon_count} as dungeon, {town_count} with a town"
    )


if __name__ == "__main__":
    main()
