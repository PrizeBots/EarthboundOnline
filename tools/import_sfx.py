"""
Import the EarthBound sound-effect rip into the engine.

Source: the community SFX pack (BossCrafty, via starmen.net) — 138 WAVs named
"NNN Some Name.wav". These are ROM-derived audio, so like the SPC music and the
extracted atlases they land in public/assets/ (git-ignored, dev-only, scrubbed
before launch). The pack itself is downloaded out-of-repo; this just normalizes
it in.

Outputs:
  public/assets/sfx/<id>.wav   one renamed clip per sound (id = kebab of name)
  src/data/sfxManifest.json    OUR authored index {id, num, label, file} — this
                               is pure metadata (no ROM audio), committed, and is
                               what DoorSfx.ts / the engine read to know the set.

Usage:
  python tools/import_sfx.py [SOURCE_DIR]
  default SOURCE_DIR = C:/Users/zleer/Downloads/eb_sfx/EB SFX
"""

import json
import re
import shutil
import sys
from pathlib import Path

PROJECT = Path(__file__).parent.parent
DEFAULT_SRC = Path(r"C:/Users/zleer/Downloads/eb_sfx/EB SFX")
OUT_AUDIO = PROJECT / "public" / "assets" / "sfx"
OUT_MANIFEST = PROJECT / "src" / "data" / "sfxManifest.json"


def kebab(name: str) -> str:
    """'Door open' -> 'door-open'. Strips punctuation, collapses whitespace."""
    s = name.lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def parse(stem: str):
    """'008 Door open' -> (8, 'Door open'); 'Bulldozer' -> (None, 'Bulldozer')."""
    m = re.match(r"^\s*(\d+)\s+(.*)$", stem)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return None, stem.strip()


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.is_dir():
        raise SystemExit(f"Source dir not found: {src}")

    OUT_AUDIO.mkdir(parents=True, exist_ok=True)
    wavs = sorted(src.glob("*.wav"))
    if not wavs:
        raise SystemExit(f"No .wav files in {src}")

    manifest = []
    seen_ids = {}
    for wav in wavs:
        num, label = parse(wav.stem)
        sid = kebab(label)
        # Disambiguate the rare id collision by suffixing the source number.
        if sid in seen_ids:
            sid = f"{sid}-{num}" if num is not None else f"{sid}-2"
        seen_ids[sid] = True

        shutil.copy2(wav, OUT_AUDIO / f"{sid}.wav")
        manifest.append({"id": sid, "num": num, "label": label, "file": f"{sid}.wav"})

    # Sort by song number (unnumbered last, kept in name order after).
    manifest.sort(key=lambda e: (e["num"] is None, e["num"] if e["num"] is not None else 0))

    OUT_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Imported {len(manifest)} SFX -> {OUT_AUDIO}")
    print(f"Wrote manifest -> {OUT_MANIFEST}")
    # Surface the door/movement-relevant ones so the mapping is easy to verify.
    keys = ("door", "stair", "fall", "teleport", "warp", "pressure", "locked", "pyramid")
    print("\nDoor/movement-relevant:")
    for e in manifest:
        if any(k in e["id"] for k in keys):
            print(f"  {str(e['num']):>4}  {e['id']:<24} {e['label']}")


if __name__ == "__main__":
    main()
