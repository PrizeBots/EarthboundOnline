"""
Stage every ROM graphic CoilSnake decompiled into a browser-servable, GITIGNORED
location so the editor's Source Assets tool can show the FULL set — including art
we haven't imported into the game yet (battle sprites, battle backgrounds,
swirls, title/logos, town maps, cutscene animations). It's a DISCOVERY aid: scan
the ROM for anything worth turning into an entity/object later.

Copies eb_project/**/*.png -> public/assets/rom_sources/<same relative path>,
keyed by the source dir as a category, and writes an index.json the tool reads:
    { categories: [{id, name, count}], assets: [{id, folder, file, w, h}] }
where `file` is the path under /assets/rom_sources/ and `id` is it sans ".png".

This is the SAME ROM-derived, never-committed class as public/assets/* (the dir
is gitignored). eb_project/ itself isn't served by Vite, hence the copy.

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/copy_rom_sources.py
"""
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
EB = ROOT / "eb_project"
OUT = ROOT / "public" / "assets" / "rom_sources"


def main():
    if not EB.exists():
        raise SystemExit(f"eb_project not found at {EB}")
    # Fresh copy each run so deleted/renamed source art doesn't linger.
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    assets = []
    counts = {}
    for png in sorted(EB.rglob("*.png")):
        rel = png.relative_to(EB)
        folder = str(rel.parent).replace("\\", "/")
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(png, dst)
        try:
            with Image.open(png) as im:
                w, h = im.size
        except Exception:
            w = h = 0
        assets.append(
            {
                "id": str(rel.with_suffix("")).replace("\\", "/"),
                "folder": folder,
                "file": str(rel).replace("\\", "/"),
                "w": w,
                "h": h,
            }
        )
        counts[folder] = counts.get(folder, 0) + 1

    index = {
        "categories": [
            {"id": c, "name": c, "count": n} for c, n in sorted(counts.items())
        ],
        "assets": assets,
    }
    with open(OUT / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f)

    print(f"Staged {len(assets)} ROM source images into {OUT}")
    for c, n in sorted(counts.items()):
        print(f"  {c}: {n}")


if __name__ == "__main__":
    main()
