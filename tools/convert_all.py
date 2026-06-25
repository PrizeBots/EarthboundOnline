#!/usr/bin/env python3
"""
convert_all.py — run the full ROM -> JSON/atlas extraction pipeline in order.

This is the one-command build referenced by `npm run extract`. It runs the six
canonical pipeline steps (see ARCHITECTURE.md "Data pipeline") from the repo root,
stopping at the first failure.

Each step is launched with THIS interpreter (sys.executable), so however you run
convert_all.py, every sub-step uses the same Python — invoke it with your full
interpreter path if the bare `python` alias hangs (see CLAUDE.md):

    C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/convert_all.py

Generators that aren't part of every build (music, traffic, char-select, menus)
are intentionally NOT run here — see tools/README.md and run them as needed.
"""
import subprocess
import sys
from pathlib import Path

# Canonical pipeline, in dependency order (ARCHITECTURE.md "Data pipeline").
STEPS = [
    "extract_rom.py",          # tilesets, map, sprites, collision
    "add_sector_settings.py",  # per-sector indoor/dungeon/town flags
    "apply_map_changes.py",    # bake open-world event state into the map
    "build_atlases.py",        # pre-render BG + FG tile atlases
    "extract_npcs.py",         # NPC/prop placements + dialogue
    "extract_shops.py",        # shop catalog + clerk->store map
    "extract_gifts.py",        # present-box catalog (contents + flags), needs npcs.json
]

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent  # scripts expect to run from the repo root


def main() -> int:
    print(f"== 199X extraction pipeline ({len(STEPS)} steps) ==")
    for i, step in enumerate(STEPS, 1):
        script = TOOLS_DIR / step
        if not script.exists():
            print(f"[{i}/{len(STEPS)}] MISSING: {step} — aborting.")
            return 1
        print(f"\n[{i}/{len(STEPS)}] {step}")
        result = subprocess.run([sys.executable, str(script)], cwd=REPO_ROOT)
        if result.returncode != 0:
            print(f"\n!! {step} failed (exit {result.returncode}). Pipeline stopped.")
            return result.returncode
    print("\n== Pipeline complete. ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
