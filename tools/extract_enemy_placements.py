"""
extract_enemy_placements.py — generate enemy spawners at the ORIGINAL ROM enemy
locations.

EarthBound places enemies as REGIONAL encounter groups, not points: the overworld
is a 128x160 grid of 64x64px cells (matching our native 8192x10240 map), and each
cell references an "Enemy Map Group" → enemy groups → specific enemies. We resolve
that chain, map each placed battle-config id to our overworld SPRITE (via the
enemies.json catalog + spriteVariants), cluster each sprite's cells into contiguous
regions, and drop ONE spawner per distinct cluster — snapped onto a standable
(non-wall) tile near the cluster centroid.

Each spawner: maxActive 1 (one enemy), wanderRadius 200, enabled. Appended to
public/overrides/enemy_spawns.json (additive; sprites also added to
enemySpriteGroups so they're treated as enemies). Sprites that already have a
hand-placed spawner are SKIPPED so authored/tuned ones aren't duplicated.

The collision (`solid`) machinery is copied from tools/debug_room_crop_check.py —
keep in sync with Collision.ts / npcSim.js.

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_enemy_placements.py
"""
import json
import collections
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "public" / "assets"
EB = ROOT / "eb_project"
OVERRIDE = ROOT / "public" / "overrides" / "enemy_spawns.json"

# --- map / collision (mirrors tools/debug_room_crop_check.py) -----------------
sectors = json.loads((A / "map" / "sectors.json").read_text())
tiles_arr = json.loads((A / "map" / "tiles.json").read_text())
mapping = json.loads((A / "map" / "tileset_mapping.json").read_text())

MAP_W_SEC, MAP_H_SEC = 32, 80
SEC_TX, SEC_TY = 8, 4
MAP_W_T, MAP_H_T = MAP_W_SEC * SEC_TX, MAP_H_SEC * SEC_TY
MAP_W_MT, MAP_H_MT = MAP_W_T * 4, MAP_H_T * 4

collisions = {}


def _load_collision_overrides():
    p = ROOT / "public" / "overrides" / "collision.json"
    try:
        doc = json.loads(p.read_text())
        return doc.get("edits") or {}, doc.get("cells") or {}
    except Exception:
        return {}, {}


COLLISION_OV, _CELL_OV_RAW = _load_collision_overrides()
CELL_OV = {
    tuple(int(v) for v in tk.split(",")): {int(i): b for i, b in cells.items()}
    for tk, cells in _CELL_OV_RAW.items()
}


def get_collisions(ts):
    if ts not in collisions:
        data = json.loads((A / "tilesets" / str(ts) / "collisions.json").read_text())
        for key, cells in COLLISION_OV.items():
            t, arr = (int(v) for v in key.split(":"))
            if t == ts and arr < len(data):
                for idx, byte in cells.items():
                    data[arr][int(idx)] = byte
        collisions[ts] = data
    return collisions[ts]


def sector_at(sx, sy):
    if not (0 <= sx < MAP_W_SEC and 0 <= sy < MAP_H_SEC):
        return None
    return sectors[sy * MAP_W_SEC + sx]


def tile_at(tx, ty):
    if not (0 <= tx < MAP_W_T and 0 <= ty < MAP_H_T):
        return 0
    return tiles_arr[ty * MAP_W_T + tx]


def solid(mtx, mty):
    """Solid at minitile (8px) coords."""
    if not (0 <= mtx < MAP_W_MT and 0 <= mty < MAP_H_MT):
        return True
    sec = sector_at((mtx >> 2) // SEC_TX, (mty >> 2) // SEC_TY)
    if sec is None:
        return True
    cols = get_collisions(mapping[sec["tilesetId"]])
    arr = tile_at(mtx >> 2, mty >> 2)
    idx = (mty & 3) * 4 + (mtx & 3)
    ov = CELL_OV.get((mtx >> 2, mty >> 2))
    if ov is not None and idx in ov:
        return (ov[idx] & 0x80) != 0
    if arr >= len(cols):
        return True
    return (cols[arr][idx] & 0x80) != 0


def solid_px(px, py):
    return solid(px // 8, py // 8)


def snap_standable(px, py, max_r=320):
    """Nearest non-solid minitile center to (px,py), spiraling out to max_r px."""
    if not solid_px(px, py):
        return (px // 8) * 8 + 4, (py // 8) * 8 + 4
    mtx0, mty0 = px // 8, py // 8
    for r in range(1, max_r // 8 + 1):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                mtx, mty = mtx0 + dx, mty0 + dy
                if not solid(mtx, mty):
                    return mtx * 8 + 4, mty * 8 + 4
    return None


# --- ROM enemy placement chain ------------------------------------------------
placement = yaml.safe_load((EB / "map_enemy_placement.yml").read_text(encoding="utf-8"))
mgroups = yaml.safe_load((EB / "map_enemy_groups.yml").read_text(encoding="utf-8"))
egroups = yaml.safe_load((EB / "enemy_groups.yml").read_text(encoding="utf-8"))

# Validated grid: 128 cells wide x 160 tall, 64x64px each (97% town-purity).
GRID_W = 128
CELL = 64

# Catalog: battle-config id -> our overworld SPRITE id (primary + variants).
cat = json.loads((A / "map" / "enemies.json").read_text(encoding="utf-8"))
bySprite = cat["bySprite"]
spriteVariants = cat.get("spriteVariants", {})
cfg2sprite = {}
sprite_name = {}
for sid_s, e in bySprite.items():
    sid = int(sid_s)
    sprite_name[sid] = e.get("name") or f"enemy {sid}"
    cid = e.get("configId")
    if cid is not None:
        cfg2sprite.setdefault(cid, sid)
for sid_s, variants in spriteVariants.items():
    sid = int(sid_s)
    sprite_name.setdefault(sid, f"enemy {sid}")
    for v in variants:
        cid = v.get("configId")
        if cid is not None:
            cfg2sprite.setdefault(cid, sid)


def configs_of_mapgroup(mg):
    g = mgroups.get(mg) or {}
    out = set()
    for sgk in ("Sub-Group 1", "Sub-Group 2"):
        for _, ent in (g.get(sgk) or {}).items():
            eg = egroups.get(ent.get("Enemy Group")) or {}
            for en in eg.get("Enemies") or []:
                out.add(en.get("Enemy"))
    return out


# Per-sprite set of grid cells (col,row) where it appears.
sprite_cells = collections.defaultdict(set)
unmapped_cfgs = set()
for i, c in placement.items():
    mg = c.get("Enemy Map Group") if c else 0
    if not mg:
        continue
    col, row = i % GRID_W, i // GRID_W
    for cfg in configs_of_mapgroup(mg):
        sid = cfg2sprite.get(cfg)
        if sid is None:
            unmapped_cfgs.add(cfg)  # battle-only enemy with no overworld sprite
        else:
            sprite_cells[sid].add((col, row))


def cluster(cells):
    """8-connected components of a cell set."""
    cells = set(cells)
    seen = set()
    out = []
    for start in cells:
        if start in seen:
            continue
        comp = []
        stack = [start]
        seen.add(start)
        while stack:
            cx, cy = stack.pop()
            comp.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in cells and n not in seen:
                        seen.add(n)
                        stack.append(n)
        out.append(comp)
    return out


# --- generate spawners --------------------------------------------------------
ov = json.loads(OVERRIDE.read_text(encoding="utf-8"))
spawners = ov.setdefault("spawners", [])
existing_sprites = {s.get("sprite") for s in spawners}

new_spawners = []
skipped_existing = []
no_standable = 0

for sid in sorted(sprite_cells):
    cells = sprite_cells[sid]
    if sid in existing_sprites:
        skipped_existing.append(sid)
        continue
    name = sprite_name.get(sid, f"enemy {sid}")
    slug = "".join(ch if ch.isalnum() else "-" for ch in name.lower()).strip("-")
    # ONE spawner per enemy: place it in the enemy's LARGEST cluster (where it
    # most appears), at the standable cell nearest that cluster's centroid.
    comp = max(cluster(cells), key=len)
    cx = sum(col for col, _ in comp) / len(comp)
    cy = sum(row for _, row in comp) / len(comp)
    cpx = int(cx * CELL + CELL / 2)
    cpy = int(cy * CELL + CELL / 2)
    best = None
    best_d = 1e18
    for col, row in comp:
        px = col * CELL + CELL // 2
        py = row * CELL + CELL // 2
        if solid_px(px, py):
            continue
        d = (px - cpx) ** 2 + (py - cpy) ** 2
        if d < best_d:
            best_d, best = d, (px, py)
    spot = best or snap_standable(cpx, cpy)
    if spot is None:
        no_standable += 1
        continue
    new_spawners.append({
        "name": f"rom-{slug}",
        "sprite": sid,
        "x": spot[0],
        "y": spot[1],
        "wanderRadius": 200,
        "maxActive": 1,
        "spawnIntervalMs": 3500,
        "respawnDelayMs": 9000,
        "enabled": True,
    })

spawners.extend(new_spawners)
esg = set(ov.get("enemySpriteGroups", []))
esg |= {s["sprite"] for s in new_spawners}
ov["enemySpriteGroups"] = sorted(esg)
OVERRIDE.write_text(json.dumps(ov, indent=2) + "\n", encoding="utf-8")

# --- report -------------------------------------------------------------------
by_sprite = collections.Counter(s["sprite"] for s in new_spawners)
print(f"Wrote {OVERRIDE}")
print(f"  generated {len(new_spawners)} spawners across {len(by_sprite)} enemy sprites")
print(f"  skipped {len(skipped_existing)} sprites already hand-placed: {sorted(skipped_existing)}")
print(f"  {len(unmapped_cfgs)} placed battle-config ids have no overworld sprite (bosses/battle-only) — not spawnable")
if no_standable:
    print(f"  {no_standable} clusters had no standable tile nearby — skipped")
print("  per-sprite cluster counts:")
for sid, n in sorted(by_sprite.items(), key=lambda kv: -kv[1]):
    print(f"    {sid:>4} {sprite_name.get(sid,'?'):<22} {n} spawner(s)")
