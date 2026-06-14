"""Extract human song titles for the Sound Manager.

EarthBound's music is addressed by SPC song NUMBER (eb-NNN.spc). The numbers
mean nothing to an admin drawing music zones, so we surface real titles instead.
Each ripped SPC carries an ID666 tag whose first field (offset 0x2E, 32 bytes)
is the song title — we read those into src/data/songNames.json, OUR authored
metadata table (text only, shippable; parallels src/data/spriteNames.json).

It then relabels the auto-generated zone names in public/overrides/music.json
("song29 (12,0)") to use the title ("Onett Night 1 (12,0)") so the existing
sound zones read clearly the moment you open the tool.

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_song_names.py
"""
import json
import os
import re
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPC_DIR = os.path.join(ROOT, "public", "assets", "music", "spc")
NAMES_OUT = os.path.join(ROOT, "src", "data", "songNames.json")
MUSIC = os.path.join(ROOT, "public", "overrides", "music.json")

# ID666 tag layout (text variant): song title is 32 bytes at 0x2E.
TITLE_OFF, TITLE_LEN = 0x2E, 32


def read_title(path):
    with open(path, "rb") as fh:
        head = fh.read(0x100)
    raw = head[TITLE_OFF:TITLE_OFF + TITLE_LEN]
    return raw.split(b"\x00")[0].decode("latin1").strip()


def extract_names():
    names = {}
    for path in sorted(glob.glob(os.path.join(SPC_DIR, "eb-*.spc"))):
        num = int(os.path.basename(path)[3:6])
        title = read_title(path)
        if title:
            names[str(num)] = title
    return names


def relabel_music(names):
    if not os.path.exists(MUSIC):
        return 0
    data = json.load(open(MUSIC, encoding="utf-8"))
    n = 0
    for area in data.get("areas", []):
        song = area.get("song", 0)
        title = names.get(str(song))
        if not title:
            continue
        # Preserve the trailing "(sx,sy)" tag if the name already carries one.
        m = re.search(r"\(\d+,\d+\)\s*$", area.get("name", ""))
        suffix = (" " + m.group(0)) if m else ""
        new = f"{title}{suffix}"
        if new != area.get("name"):
            area["name"] = new
            n += 1
    if os.path.exists(MUSIC):
        os.replace(MUSIC, MUSIC + ".bak")
    json.dump(data, open(MUSIC, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    return n


def main():
    names = extract_names()
    os.makedirs(os.path.dirname(NAMES_OUT), exist_ok=True)
    json.dump(names, open(NAMES_OUT, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"Wrote {len(names)} song names -> {os.path.relpath(NAMES_OUT, ROOT)}")
    relabeled = relabel_music(names)
    print(f"Relabeled {relabeled} music zones -> {os.path.relpath(MUSIC, ROOT)}")


if __name__ == "__main__":
    main()
