"""
Slice the 16x24 character sprite sheets into layered, mixable body parts for
the character creator.

Layers (composite order, bottom -> top):
    shadow -> head (bald skin base) -> body (skin mannequin) -> shoes ->
    pants -> shirt -> face (eyes/mouth/chin) -> hair (incl. hats)

Pixel classification per frame (palettes 5/6 share these exact colors):
    - shadow colors        -> dropped (a single standard shadow layer is kept)
    - skin colors          -> head base (y <= HEAD_MAX_Y) or body mannequin
    - non-skin, y 0..10    -> face if it's a dark/white pixel hugging skin
                              (eyes, mouth, chin/ear outline), else hair
    - non-skin, y 11..16   -> shirt
    - non-skin, y 17..20   -> pants
    - non-skin, y 21..23   -> shoes
Clothing pixels are additionally repainted as skin into the head/body base
layers so a smaller garment from another character reveals skin, not holes.

Frame template (the full set of Ness frames in the ROM, per
playable_char_gfx_table.yml): 16 walk frames (8 directions x 2) plus a pose
row with the ladder-climb pair and the rope-climb pair. The ROM stores each
climb group as 8 frames but they are the same 2 frames repeated 4x, so the
template keeps the 2 unique frames of each. The remaining table entries
(dead = ghost form, robot, tiny) are whole-body transformations with their
own palettes — they cannot be layered as parts and are NOT part of the
template; their sprite groups are excluded from part extraction entirely
(as are the ladder/rope sheets themselves, which are poses of an existing
character, not characters).

Characters missing frames keep those cells EMPTY in their part sheets
(diagonals for 4-direction characters, the climb row for everyone but the
playable cast); the engine fills the blanks at composite time and the
catalog flags what is real art via `diag` / `climb`.

Output:
    public/assets/charparts/{category}/{partId}.png  (64x120: 4x4 walk grid
        + row 4 = ladder f0, ladder f1, rope f0, rope f1)
    public/assets/charparts/catalog.json
    public/assets/charparts/shadow.png

Run: C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/extract_char_parts.py
"""
import json
import hashlib
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPRITES = ROOT / "public" / "assets" / "sprites"
OUT = ROOT / "public" / "assets" / "charparts"

FRAME_W, FRAME_H = 16, 24
GRID = 4       # 4x4 walk frames per source sheet
OUT_ROWS = 5   # output adds row 4: ladder f0, ladder f1, rope f0, rope f1
CLIMB_ROW = 4
GFX_TABLE = ROOT / "eb_project" / "playable_char_gfx_table.yml"

SKIN = {(240, 176, 144), (200, 152, 120), (240, 144, 144)}
# The drop-shadow greens double as clothing colors (army jackets etc.) —
# only treat them as shadow near the feet (y >= SHADOW_MIN_Y).
SHADOW = {(80, 112, 96), (144, 160, 128)}
SHADOW_MIN_Y = 20
OUTLINE = (48, 32, 32)
# Colors eligible to be "face features" when surrounded by skin
FACE_FEATURE = {OUTLINE, (240, 240, 240), (200, 200, 200), (152, 152, 152)}

LIGHT_SKIN = (240, 176, 144, 255)
SHADE_SKIN = (200, 152, 120, 255)
OUTLINE_RGBA = (48, 32, 32, 255)

HEAD_MAX_Y = 10   # head band: rows 0..10
SHIRT_MAX_Y = 16  # shirt band: rows 11..16
PANTS_MAX_Y = 20  # pants band: rows 17..20  (shoes: 21..23)

CATEGORIES = ["head", "body", "shirt", "pants", "shoes", "face", "hair"]

# Diagonal frames live in grid rows 2-3. Most characters (195 of 228) only
# have the 4 cardinal directions; their sheets keep these cells EMPTY and the
# engine fills diagonals from E/W cells at composite time. Mixing a true-
# diagonal part (3/4 view) with a side-view fill misaligns, so the engine
# only uses true diagonals when every selected part has them — the catalog
# records that per part as `diag`.
DIAG_CELLS = [(2, 0), (2, 1), (2, 2), (2, 3), (3, 0), (3, 1), (3, 2), (3, 3)]


def load_pose_table():
    """playable_char_gfx_table.yml maps each playable character's walking
    group to its pose/transformation groups.

    Returns (poses, exclude):
        poses:   {default_group_id: (ladder_group_id, rope_group_id)}
                 only when the char has REAL climb art (group != default)
        exclude: every non-default group in the table (ladder/rope poses,
                 ghost "dead" form, robot, tiny) — never sliced as a
                 standalone character.
    """
    import yaml

    table = yaml.safe_load(open(GFX_TABLE))
    poses, exclude = {}, set()
    for entry in table.values():
        default = entry["Default Sprite Group"]
        ladder = entry["Ladder Sprite Group"]
        rope = entry["Rope Sprite Group"]
        if ladder != default and rope != default:
            poses[default] = (ladder, rope)
        for key in (
            "Ladder Sprite Group",
            "Rope Sprite Group",
            "Dead Sprite Group",
            "Robot Sprite Group",
            "Tiny Sprite Group",
            "Tiny Dead Sprite Group",
        ):
            exclude.add(entry[key])
    # A group can be both someone's pose and someone else's walking sheet
    # (entry 4 lists group 44 for everything) — defaults stay characters.
    exclude -= {entry["Default Sprite Group"] for entry in table.values()}
    return poses, exclude


def get_px(frame, x, y):
    if x < 0 or y < 0 or x >= FRAME_W or y >= FRAME_H:
        return (0, 0, 0, 0)
    return frame[y * FRAME_W + x]


def classify_frame(frame):
    """frame: list of RGBA tuples (16x24). Returns {category: 16x24 RGBA list}."""
    layers = {c: [(0, 0, 0, 0)] * (FRAME_W * FRAME_H) for c in CATEGORIES}

    def is_skin(p):
        return p[3] > 0 and p[:3] in SKIN

    def is_shadow(p, y):
        return p[:3] in SHADOW and y >= SHADOW_MIN_Y

    for y in range(FRAME_H):
        for x in range(FRAME_W):
            p = get_px(frame, x, y)
            if p[3] == 0 or is_shadow(p, y):
                continue
            i = y * FRAME_W + x

            if p[:3] in SKIN:
                layers["head" if y <= HEAD_MAX_Y else "body"][i] = p
                continue

            if y <= HEAD_MAX_Y:
                # Face feature: dark/white pixel with >=2 skin pixels in the
                # 8-neighborhood (eyes, mouth, glasses, chin/ear outlines).
                # Everything else up here is hair/hat mass and its outline.
                if p[:3] in FACE_FEATURE:
                    n = sum(
                        1
                        for dx in (-1, 0, 1)
                        for dy in (-1, 0, 1)
                        if (dx or dy) and is_skin(get_px(frame, x + dx, y + dy))
                    )
                    if n >= 2:
                        layers["face"][i] = p
                        continue
                layers["hair"][i] = p
            elif y <= SHIRT_MAX_Y:
                layers["shirt"][i] = p
            elif y <= PANTS_MAX_Y:
                layers["pants"][i] = p
            else:
                layers["shoes"][i] = p

    # Repaint clothing/hair coverage into the base layers so swapped garments
    # can't leave holes: head becomes a bald skull, body a skin mannequin.
    for y in range(FRAME_H):
        for x in range(FRAME_W):
            p = get_px(frame, x, y)
            if p[3] == 0 or is_shadow(p, y) or p[:3] in SKIN:
                continue
            i = y * FRAME_W + x
            base = "head" if y <= HEAD_MAX_Y else "body"
            # Keep the outline where the sprite meets transparency so the
            # mannequin silhouette stays crisp; flesh-fill the interior.
            on_edge = any(
                get_px(frame, x + dx, y + dy)[3] == 0
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            )
            layers[base][i] = OUTLINE_RGBA if on_edge else LIGHT_SKIN

    return layers


def load_frames(img):
    """Returns 4x4 list of frames; each frame a flat list of RGBA tuples."""
    img = img.convert("RGBA")
    frames = []
    for row in range(GRID):
        r = []
        for col in range(GRID):
            crop = img.crop(
                (col * FRAME_W, row * FRAME_H, (col + 1) * FRAME_W, (row + 1) * FRAME_H)
            )
            r.append(list(crop.getdata()))
        frames.append(r)
    return frames


def frame_pixel_count(frame):
    return sum(1 for p in frame if p[3] > 0)


def is_humanoid(frames):
    """South frame must have a face (skin in rows 3-10) and real mass."""
    s = frames[1][0]
    skin = sum(
        1
        for y in range(3, 11)
        for x in range(FRAME_W)
        if get_px(s, x, y)[3] > 0 and get_px(s, x, y)[:3] in SKIN
    )
    return skin >= 8 and frame_pixel_count(s) >= 120


def sheet_from_layers(layer_frames):
    """layer_frames: OUT_ROWS x GRID grid of flat RGBA lists (None = empty
    cell) -> 64x120 PIL image."""
    sheet = Image.new("RGBA", (FRAME_W * GRID, FRAME_H * OUT_ROWS), (0, 0, 0, 0))
    for row in range(OUT_ROWS):
        for col in range(GRID):
            data = layer_frames[row][col]
            if data is None:
                continue
            f = Image.new("RGBA", (FRAME_W, FRAME_H))
            f.putdata(data)
            sheet.paste(f, (col * FRAME_W, row * FRAME_H))
    return sheet


def sheet_hash(img):
    return hashlib.md5(img.tobytes()).hexdigest()


def main():
    meta = json.load(open(SPRITES / "metadata.json"))
    chars = [
        m
        for m in meta
        if m["width"] == 16 and m["height"] == 24 and m["palette"] in (5, 6)
    ]

    poses, exclude = load_pose_table()

    for c in CATEGORIES:
        d = OUT / c
        d.mkdir(parents=True, exist_ok=True)
        # Re-runs can shrink the catalog; stale ids must not linger.
        for old in d.glob("*.png"):
            old.unlink()

    catalog = {c: [] for c in CATEGORIES}
    seen = {c: {} for c in CATEGORIES}  # hash -> partId (dedupe)
    shadow_saved = False
    processed = 0

    for ch in chars:
        # Pose/transformation sheets (ladder, rope, ghost, robot) belong to
        # an existing character — never slice them as characters themselves.
        if ch["id"] in exclude:
            continue
        path = SPRITES / f"{ch['id']}.png"
        if not path.exists():
            continue
        frames = load_frames(Image.open(path))
        has_diag = all(frame_pixel_count(frames[r][c]) >= 20 for r, c in DIAG_CELLS)

        if not is_humanoid(frames):
            continue
        processed += 1

        # Climb row: the 2 unique ladder frames + 2 unique rope frames (the
        # ROM repeats each pair 4x; cells (0,0)/(0,1) hold the unique pair).
        climb_frames = None
        if ch["id"] in poses:
            ladder_path = SPRITES / f"{poses[ch['id']][0]}.png"
            rope_path = SPRITES / f"{poses[ch['id']][1]}.png"
            if ladder_path.exists() and rope_path.exists():
                ladder = load_frames(Image.open(ladder_path))
                rope = load_frames(Image.open(rope_path))
                climb_frames = [ladder[0][0], ladder[0][1], rope[0][0], rope[0][1]]
        has_climb = climb_frames is not None

        # Standard drop shadow, taken once from the first humanoid (Ness).
        # No shadow in the climb row — characters on a ladder/rope cast none.
        if not shadow_saved:
            shadow_frames = [
                [
                    [
                        p
                        if p[3] > 0
                        and p[:3] in SHADOW
                        and (i // FRAME_W) >= SHADOW_MIN_Y
                        else (0, 0, 0, 0)
                        for i, p in enumerate(f)
                    ]
                    for f in row
                ]
                for row in frames
            ] + [[None] * GRID]
            sheet_from_layers(shadow_frames).save(OUT / "shadow.png")
            shadow_saved = True

        per_cat = {c: [[None] * GRID for _ in range(OUT_ROWS)] for c in CATEGORIES}
        for row in range(GRID):
            for col in range(GRID):
                layers = classify_frame(frames[row][col])
                for c in CATEGORIES:
                    per_cat[c][row][col] = layers[c]
        if has_climb:
            for col, frame in enumerate(climb_frames):
                layers = classify_frame(frame)
                for c in CATEGORIES:
                    per_cat[c][CLIMB_ROW][col] = layers[c]

        for c in CATEGORIES:
            sheet = sheet_from_layers(per_cat[c])
            # Skip parts with almost no pixels (e.g. shoes hidden by pants)
            total = sum(1 for p in sheet.getdata() if p[3] > 0)
            if total < 16:
                continue
            h = sheet_hash(sheet)
            if h in seen[c]:
                continue
            part_id = len(catalog[c])
            seen[c][h] = part_id
            sheet.save(OUT / c / f"{part_id}.png")
            catalog[c].append(
                {"id": part_id, "source": ch["id"], "diag": has_diag, "climb": has_climb}
            )

    with open(OUT / "catalog.json", "w") as f:
        json.dump(catalog, f)

    print(f"Processed {processed} humanoid characters")
    for c in CATEGORIES:
        print(f"  {c}: {len(catalog[c])} unique parts")


if __name__ == "__main__":
    main()
