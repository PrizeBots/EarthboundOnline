"""
extract_enemies.py — build the enemy catalog (public/assets/map/enemies.json)
from the CoilSnake decomp tables.

The ROM is the single source of truth for enemy stats. This reads
`enemy_configuration_table.yml` (231 enemies) and keys each by its "Overworld
Sprite" field, which — verified — IS our in-game sprite group id (direct
equality, no transform: Spiteful Crow = 282, Coil Snake = 283, ...).

Output `enemies.json` is the DEFAULTS layer the runtime merges UNDER the authored
`enemy_spawns.json` overrides:  DEFAULT_ENTITY_STATS  <  enemies.json (ROM)  <  overrides (hand-tuned).
So every enemy is ROM-faithful out of the box and designers only store *changes*.

ROM->realtime mapping notes:
  * hp / xp / level / money  -> map 1:1 (clean).
  * drop item + rarity       -> from "Item Dropped" / "Item Rarity" (e.g. 1/128).
  * damage                   -> DERIVED from battle "Offense" (see OFFENSE_TO_DAMAGE).
                                ROM Offense is a turn-based battle stat, not a
                                per-hit value, so this is a tunable starting
                                point — adjust the divisor or override per-entity
                                in the Entity Manager.
  * speed / ranges / crit / dodge -> NOT in the ROM as realtime values; left to
                                engine defaults, tuned per-entity in the editor.
  * offense/defense/romSpeed/vuln/boss -> emitted as reference (not read by combat).

This is dev-side extraction into public/assets/ (ROM-derived, never committed),
consistent with the rest of tools/. A client-side TS port (reading these tables
straight from EarthBound.sfc) is part of the broader extraction-port backlog.

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_enemies.py
"""
import json
import os
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EB_PROJECT = os.path.join(ROOT, "eb_project")
ENEMY_TABLE = os.path.join(EB_PROJECT, "enemy_configuration_table.yml")
ITEM_TABLE = os.path.join(EB_PROJECT, "item_configuration_table.yml")
OUT_PATH = os.path.join(ROOT, "public", "assets", "map", "enemies.json")

# Offense -> per-hit melee damage. Early EarthBound enemies have small Offense
# values (single/low-double digits), so damage maps ~1:1 from Offense (this
# reproduces the existing hand-tuned values, e.g. Skate Punk offense 7 -> dmg 7).
# Bosses have Offense in the hundreds, so we clamp. All tunable per-entity in the
# Entity Manager (override layer wins).
OFFENSE_DIVISOR = 1
DAMAGE_MIN = 1
DAMAGE_MAX = 60


def parse_rarity(raw):
    """'1/128' -> (0.0078125, '1/128'). 0 / blank -> (0.0, raw)."""
    s = str(raw).strip()
    if "/" in s:
        num, den = s.split("/", 1)
        try:
            num, den = float(num), float(den)
            return (num / den if den else 0.0), s
        except ValueError:
            return 0.0, s
    try:
        return float(s), s
    except ValueError:
        return 0.0, s


def is_real_name(name):
    n = str(name).strip()
    return n and n.lower() != "null"


def load_yaml(path):
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def main():
    enemies = load_yaml(ENEMY_TABLE)
    items = load_yaml(ITEM_TABLE)
    item_name = {int(k): str(v.get("Name", "")).strip() for k, v in items.items()}

    # Group every real overworld enemy config under its sprite id first, so we
    # can choose the primary across all variants (not just first-seen).
    by_sprite_cfgs = {}   # sprite id (str) -> [(config id, cfg), ...]
    for cid in sorted(enemies.keys(), key=lambda k: int(k)):
        cfg = enemies[cid]
        sprite = int(cfg.get("Overworld Sprite", 0) or 0)
        if sprite == 0 or not is_real_name(cfg.get("Name")):
            continue  # non-overworld / placeholder rows
        by_sprite_cfgs.setdefault(str(sprite), []).append((int(cid), cfg))

    by_sprite = {}        # sprite id (str) -> primary enemy entry
    variants = {}         # sprite id (str) -> [{configId,name,level,hp}] non-primary

    for key, cfgs in by_sprite_cfgs.items():
        # Primary = the lowest-level (earliest/common) variant on this sprite;
        # tie-break by HP then config id. The tougher palette-swaps that reuse
        # the same overworld sprite are listed under spriteVariants for the editor.
        ordered = sorted(
            cfgs,
            key=lambda t: (int(t[1].get("Level", 0) or 0), int(t[1].get("HP", 0) or 0), t[0]),
        )
        cid, cfg = ordered[0]
        if len(ordered) > 1:
            variants[key] = [
                {
                    "configId": vc,
                    "name": str(vcfg.get("Name")).strip(),
                    "level": int(vcfg.get("Level", 0) or 0),
                    "hp": int(vcfg.get("HP", 0) or 0),
                }
                for vc, vcfg in ordered[1:]
            ]

        drop_item = int(cfg.get("Item Dropped", 0) or 0)
        drop = None
        if drop_item:
            rate, raw = parse_rarity(cfg.get("Item Rarity", 0))
            drop = {
                "item": drop_item,
                "itemName": item_name.get(drop_item, ""),
                "rate": round(rate, 6),
                "raw": raw,
            }

        offense = int(cfg.get("Offense", 0) or 0)
        defense = int(cfg.get("Defense", 0) or 0)
        damage = max(DAMAGE_MIN, min(DAMAGE_MAX, round(offense / OFFENSE_DIVISOR)))

        entry = {
            "name": str(cfg.get("Name")).strip(),
            "configId": int(cid),
            "hp": int(cfg.get("HP", 0) or 0),
            "xp": int(cfg.get("Experience points", 0) or 0),
            "level": int(cfg.get("Level", 0) or 0),
            "money": int(cfg.get("Money", 0) or 0),
            "damage": damage,
            # reference fields (not read by the realtime combat sim):
            "offense": offense,
            "defense": defense,
            "romSpeed": int(cfg.get("Speed", 0) or 0),
            "boss": str(cfg.get("Boss Flag", "false")).lower() == "true",
            "vuln": {
                "fire": str(cfg.get("Fire vulnerability", "")),
                "freeze": str(cfg.get("Freeze vulnerability", "")),
                "flash": str(cfg.get("Flash vulnerability", "")),
                "paralysis": str(cfg.get("Paralysis vulnerability", "")),
                "hypnosis": str(cfg.get("Hypnosis/Brainshock vulnerability", "")),
            },
        }
        if drop:
            entry["drop"] = drop

        by_sprite[key] = entry

    out = {
        "version": 1,
        "_note": "ROM-derived enemy catalog (defaults). Merged UNDER enemy_spawns.json overrides.",
        "bySprite": by_sprite,
        # spriteVariants: sprites whose overworld appearance is shared by >1 battle
        # enemy; the primary (lowest level) is in bySprite, the tougher swaps here.
        "spriteVariants": variants,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {OUT_PATH}")
    print(f"  enemies mapped to sprites: {len(by_sprite)}")
    print(f"  sprites with multiple enemy variants: {len(variants)}")
    with_drops = sum(1 for e in by_sprite.values() if "drop" in e)
    print(f"  enemies with an item drop: {with_drops}")
    # spot-check the known anchors
    for sid, name in [
        ("282", "Spiteful Crow"),
        ("283", "Coil Snake"),
        ("284", "Skate Punk"),
        ("330", "Runaway Dog"),
    ]:
        e = by_sprite.get(sid)
        got = f'{e["name"]} hp={e["hp"]} xp={e["xp"]} lv={e["level"]}' if e else "MISSING"
        print(f"  [{sid}] expect {name}: {got}")


if __name__ == "__main__":
    sys.exit(main())
