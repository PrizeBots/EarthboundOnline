"""
author_item_sprites.py — hand-authored production pixel art for catalog items.

OUR OWN 16x16 art (ITEM_PALETTE, not ROM-derived). Replaces the crude seeded
placeholders from seed_item_sprites.py with real, recognizable item icons.

Art is written with a readable char map (see CH) and emitted as the hex-index
rows the game expects. Grips are preserved per family. Re-run to regenerate
public/overrides/item_sprites.json; entries not authored here keep whatever is
already in the file (so partial waves are safe).

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/author_item_sprites.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public", "overrides", "item_sprites.json")
SHOPS = os.path.join(ROOT, "public", "assets", "map", "shops.json")

# readable char -> ITEM_PALETTE hex index (src/engine/Items.ts)
CH = {
    ".": "0",  # transparent
    "K": "1",  # black outline
    "W": "2",  # white
    "w": "3",  # wood dark
    "L": "4",  # wood light
    "D": "5",  # wood outline (deep brown)
    "m": "6",  # metal light
    "M": "7",  # metal dark
    "r": "8",  # red
    "g": "9",  # green
    "b": "a",  # blue
    "y": "b",  # yellow
    "o": "c",  # orange
    "p": "d",  # purple
    "s": "e",  # silver
    "k": "f",  # near-black
}

GRIP_WEAPON = {"x": 3, "y": 13}
GRIP_PAN = {"x": 14, "y": 9}
GRIP_GUN = {"x": 2, "y": 11}
GRIP_MID = {"x": 8, "y": 11}
GRIP_CENTER = {"x": 8, "y": 8}

# Authored art accumulates here: id -> {"rows": [16 templated rows], "grip": {}}
ART = {}

# Which 3-frame motion each item plays (see anim_frames). Ids not listed get the
# default "use pulse". Weapons swing/fire; solid foods are eaten; drinks drain.
PANS = {28, 29, 30, 31, 32, 33, 34, 248}
SWUNG = set(range(17, 36)) | {49, 50, 51, 52, 53, 212, 213, 214, 248}
FIRED = set(range(36, 49)) | {215, 132, 133, 134, 135, 136}
EAT = {
    88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104,
    109, 166, 183, 189, 190, 191, 198, 207, 211, 224, 225, 226, 227, 228, 229,
    230, 231, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245,
    247, 251,
}
DRINK = {105, 106, 107, 108, 110, 111, 112, 120, 121, 123, 126, 131, 159, 195,
         203, 204, 223, 232, 246, 252}


def add(ids, rows, grip):
    """Register one art template for one or more item ids."""
    rows = [r.ljust(16, ".")[:16] for r in rows]
    assert len(rows) == 16, f"need 16 rows, got {len(rows)}"
    if isinstance(ids, (str, int)):
        ids = [ids]
    for i in ids:
        ART[str(i)] = {"rows": rows, "grip": grip}


def encode(rows, iid="?"):
    out = []
    for y, row in enumerate(rows):
        try:
            out.append("".join(CH[c] for c in row))
        except KeyError as e:
            raise SystemExit(f"item {iid} row {y}: bad char {e} in {row!r}")
    return out


# ---------------------------------------------------------------------------
# Animation layer — frame 0 is the authored base; frames 1 & 2 are generated
# transforms so every item's 3 frames read as a motion (weapons swing, food is
# eaten, drinks drain, the rest pulse on use). Operates on template-char rows.
# ---------------------------------------------------------------------------
import math


def _grid(rows):
    return [list(r.ljust(16, ".")[:16]) for r in rows]


def _rows(g):
    return ["".join(r) for r in g]


def shift(rows, dx, dy):
    g = _grid(rows)
    out = [["."] * 16 for _ in range(16)]
    for y in range(16):
        for x in range(16):
            c = g[y][x]
            if c == ".":
                continue
            nx, ny = x + dx, y + dy
            if 0 <= nx < 16 and 0 <= ny < 16:
                out[ny][nx] = c
    return _rows(out)


def sparkle(rows, pts, ch="W"):
    g = _grid(rows)
    for (sx, sy) in pts:
        for (x, y) in [(sx, sy), (sx - 1, sy), (sx + 1, sy), (sx, sy - 1), (sx, sy + 1)]:
            if 0 <= x < 16 and 0 <= y < 16:
                g[y][x] = ch
    return _rows(g)


def bbox(rows):
    g = _grid(rows)
    xs, ys = [], []
    for y in range(16):
        for x in range(16):
            if g[y][x] != ".":
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def bite(rows, r):
    bb = bbox(rows)
    if not bb:
        return rows
    x0, y0, x1, y1 = bb
    cx, cy = x1, y0  # chomp from the upper-right corner of the food
    g = _grid(rows)
    for y in range(16):
        for x in range(16):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                g[y][x] = "."
    return _rows(g)


def drain(rows, frac):
    """Lower the 'liquid' (colored interior, not '.'/outline) per column."""
    g = _grid(rows)
    for x in range(16):
        col = [y for y in range(16) if g[y][x] not in (".", "K", "k")]
        n = int(round(frac * len(col)))
        for y in col[:n]:
            g[y][x] = "."
    return _rows(g)


def rotate(rows, deg, pivot):
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    px, py = pivot["x"], pivot["y"]
    g = _grid(rows)
    out = [["."] * 16 for _ in range(16)]
    for y in range(16):
        for x in range(16):
            dx, dy = x - px, y - py
            ix = int(round(px + ca * dx + sa * dy))
            iy = int(round(py - sa * dx + ca * dy))
            if 0 <= ix < 16 and 0 <= iy < 16 and g[iy][ix] != ".":
                out[y][x] = g[iy][ix]
    return _rows(out)


def anim_frames(iid, rows, grip):
    """Return [f0, f1, f2] template-row grids for an item's 3-frame loop."""
    n = int(iid) if str(iid).isdigit() else -1
    if n in SWUNG:                       # weapon swing: chop the tip downward
        s = -1 if n in PANS else 1       # pans grip on the far side → mirror sweep
        return [rows, rotate(rows, 20 * s, grip), rotate(rows, 42 * s, grip)]
    if n in FIRED:                       # gun/launcher: recoil + muzzle flash
        bb = bbox(rows) or (4, 6, 11, 9)
        x1, my = bb[2], (bb[1] + bb[3]) // 2
        f1 = sparkle(sparkle(shift(rows, -1, 0), [(x1 + 1, my), (x1 + 2, my)], "y"), [(x1 + 1, my)], "W")
        f2 = sparkle(rows, [(x1 + 1, my)], "y")
        return [rows, f1, f2]
    if n in EAT:                         # food: chomped down over the loop
        return [rows, bite(rows, 5), bite(rows, 8)]
    if n in DRINK:                       # container: liquid level drops
        return [rows, drain(rows, 0.34), drain(rows, 0.68)]
    # default — "use" pulse: bob up with a sparkle, then a sparkle low
    bb = bbox(rows) or (4, 4, 11, 11)
    ne, sw = (bb[2], bb[1]), (bb[0], bb[3])
    return [rows, sparkle(shift(rows, 0, -1), [ne], "W"), sparkle(rows, [sw], "W")]


# ===========================================================================
# WEAPONS — BASEBALL BATS (17-27, 212-214)  diagonal, handle bottom-left
# ===========================================================================
def bat(barrel, shade, handle, knob, accent=None, tip=None):
    """barrel/shade = light/dark of the hitting end; handle/knob = grip end.
    accent paints a ring near the taper; tip paints the very end pixel."""
    t = tip or barrel
    a = accent
    rows = [
        "..............K.",
        ".............K%K".replace("%", t),
        "............K##K".replace("#", barrel),
        "...........K##@K".replace("#", barrel).replace("@", shade),
        "..........K##@K.".replace("#", barrel).replace("@", shade),
        ".........K##@K..".replace("#", barrel).replace("@", shade),
        "........K##@K...".replace("#", barrel).replace("@", shade),
        ".......K$$@K....".replace("$", (a or barrel)).replace("@", shade if not a else a),
        "......K##@K.....".replace("#", barrel).replace("@", shade),
        ".....K#@K......".replace("#", barrel).replace("@", shade),
        "....K#@K.......".replace("#", barrel).replace("@", shade),
        "...KHH@K.......".replace("H", handle).replace("@", shade),
        "..KHHK.........".replace("H", handle),
        ".KNHK..........".replace("N", knob).replace("H", handle),
        ".KNK...........".replace("N", knob),
        ".KK............",
    ]
    return rows


# wood tiers
add(17, bat("L", "w", "w", "D", accent="W"), GRIP_WEAPON)          # Cracked bat (white crack line)
add(18, bat("L", "w", "w", "D"), GRIP_WEAPON)                       # Tee ball bat
add(19, bat("L", "w", "w", "D", accent="r"), GRIP_WEAPON)          # Sand lot bat (red tape)
add(20, bat("L", "w", "w", "D", accent="b"), GRIP_WEAPON)          # Minor league (blue tape)
add(21, bat("L", "w", "w", "D", accent="r"), GRIP_WEAPON)          # Mr. Baseball
add(22, bat("w", "D", "D", "k", accent="y"), GRIP_WEAPON)          # Big league (dark wood, gold ring)
add(23, bat("L", "w", "w", "D", accent="y"), GRIP_WEAPON)          # Hall of fame (gold)
add(24, bat("p", "k", "p", "k", accent="W", tip="W"), GRIP_WEAPON) # Magicant bat (purple magic)
add(25, bat("s", "m", "m", "M", accent="W", tip="W"), GRIP_WEAPON) # Legendary bat (silver)
add(26, bat("o", "r", "r", "k", accent="y"), GRIP_WEAPON)          # Gutsy bat (fiery)
add(27, bat("w", "D", "D", "k", accent="W"), GRIP_WEAPON)          # Casey bat (heavy dark)
add(213, bat("L", "w", "w", "D", accent="g"), GRIP_WEAPON)         # Big league bat (dup)
add(214, bat("y", "o", "s", "M", accent="W", tip="W"), GRIP_WEAPON)# Ultimate bat (golden)

# T-rex's bat (212) — knobby bone/spiked club, its own silhouette
add(212, [
    "..............K.",
    ".............KsK",
    "............KssK",
    "...........KssK.",
    "..........KsssK.",
    ".........KsKsK..",
    "........KssKsK..",
    ".......KssKK....",
    "......KssK......",
    ".....KssK.......",
    "....KsmK........",
    "...KsmK.........",
    "..KMmK..........",
    ".KMMK...........",
    ".KMK............",
    ".KK.............",
], GRIP_WEAPON)


# ===========================================================================
# WEAPONS — FRY PANS (28-34, 248)  round pan, handle to the right
# ===========================================================================
def frypan(bowl, rim, handle, hi="W"):
    """bowl = inner cook surface, rim = bright outer edge, handle = grip color."""
    rows = [
        "................",
        "................",
        "...KKKKKK.......",
        "..K@@@@@@K......".replace("@", rim),
        ".K@######@K.....".replace("@", rim).replace("#", bowl),
        ".K@##H###@KKKKKK".replace("@", rim).replace("#", bowl).replace("H", hi),
        ".K@######@MMMMMK".replace("@", rim).replace("#", bowl).replace("M", handle),
        ".K@######@KKKKKK".replace("@", rim).replace("#", bowl),
        ".K@######@K.....".replace("@", rim).replace("#", bowl),
        "..K@@@@@@K......".replace("@", rim),
        "...KKKKKK.......",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(28, frypan("M", "m", "w"), GRIP_PAN)                 # Fry pan
add(29, frypan("M", "m", "w"), GRIP_PAN)                 # Thick fry pan
add(30, frypan("M", "s", "M"), GRIP_PAN)                 # Deluxe fry pan
add(31, frypan("k", "M", "M"), GRIP_PAN)                 # Chef's fry pan (black steel)
add(32, frypan("o", "y", "w"), GRIP_PAN)                 # French fry pan
add(33, frypan("p", "W", "M"), GRIP_PAN)                 # Magic fry pan (purple)
add(34, frypan("y", "W", "w"), GRIP_PAN)                 # Holy fry pan (golden)
add(248, frypan("k", "s", "M"), GRIP_PAN)               # Non-stick frypan


# ===========================================================================
# WEAPONS — GUNS / RAY GUNS (36-48, 215)  pistol, barrel to the right
# ===========================================================================
def gun(body, shade, barrel, muzzle=None):
    m = muzzle or barrel
    rows = [
        "................",
        "................",
        "................",
        "....KKKKKKKK....",
        "...K######@KK...".replace("#", body).replace("@", shade),
        "..K#######BBBK..".replace("#", body).replace("B", barrel),
        "..K##@@###BBBMK.".replace("#", body).replace("@", shade).replace("B", barrel).replace("M", m),
        "..K######@KKKK..".replace("#", body).replace("@", shade),
        "..KK##@@@K......".replace("#", body).replace("@", shade),
        "...KK##K@K......".replace("#", body).replace("@", shade),
        "....K#@K.......".replace("#", body).replace("@", shade),
        "....K@@K........".replace("@", shade),
        "....KKK.........",
        "................",
        "................",
        "................",
    ]
    return rows


add(36, gun("M", "k", "w", "m"), GRIP_GUN)         # Pop gun (toy, wood barrel)
add(37, gun("y", "o", "M", "b"), GRIP_GUN)         # Stun gun
add(38, gun("m", "M", "M", "m"), GRIP_GUN)         # Toy air gun
add(39, gun("M", "k", "M", "s"), GRIP_GUN)         # Magnum air gun
add(40, gun("M", "k", "m", "m"), GRIP_GUN)         # Zip gun
add(41, gun("s", "M", "r", "y"), GRIP_GUN)         # Laser gun
add(42, gun("m", "M", "b", "W"), GRIP_GUN)         # Hyper beam
add(43, gun("M", "k", "r", "y"), GRIP_GUN)         # Crusher beam
add(44, gun("s", "m", "p", "W"), GRIP_GUN)         # Spectrum beam
add(45, gun("k", "K", "r", "W"), GRIP_GUN)         # Death ray
add(46, gun("M", "k", "g", "W"), GRIP_GUN)         # Baddest beam
add(47, gun("s", "m", "b", "W"), GRIP_GUN)         # Moon beam gun
add(48, gun("y", "o", "g", "W"), GRIP_GUN)         # Gaia beam
add(215, gun("s", "m", "p", "W"), GRIP_GUN)        # Double beam


# ===========================================================================
# WEAPONS — YO-YOS (49,52,53) and SLINGSHOTS (50,51)
# ===========================================================================
def yoyo(disc, shade, hub="W"):
    """Round disc seen face-on: disc fill, shade ring, bright center axle, string."""
    rows = [
        ".......K........",
        ".......K........",
        ".....KKKKK......",
        "....K#####K.....".replace("#", disc),
        "...K##@@@##K....".replace("#", disc).replace("@", shade),
        "...K#@###@#K....".replace("#", disc).replace("@", shade),
        "..K##@#H#@##K...".replace("#", disc).replace("@", shade).replace("H", hub),
        "..K##@###@##K...".replace("#", disc).replace("@", shade),
        "...K#@###@#K....".replace("#", disc).replace("@", shade),
        "...K##@@@##K....".replace("#", disc).replace("@", shade),
        "....K#####K.....".replace("#", disc),
        ".....KKKKK......",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(49, yoyo("r", "k"), {"x": 8, "y": 0})    # Yo-yo
add(52, yoyo("p", "k"), {"x": 8, "y": 0})    # Trick yo-yo
add(53, yoyo("M", "k"), {"x": 8, "y": 0})    # Combat yo-yo

def slingshot(fork, band):
    rows = [
        "..K........K....",
        "..KH......HK....".replace("H", fork),
        "..KH......HK....".replace("H", fork),
        "..%KH....HK%....".replace("H", fork).replace("%", band),
        "...KH....HK.....".replace("H", fork),
        "....KH..HK......".replace("H", fork),
        "....KHHHHK......".replace("H", fork),
        ".....KHHK.......".replace("H", fork),
        ".....KHHK.......".replace("H", fork),
        ".....KHHK.......".replace("H", fork),
        ".....KHHK.......".replace("H", fork),
        "......KK........",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(50, slingshot("w", "r"), {"x": 6, "y": 11})   # Slingshot
add(51, slingshot("M", "y"), {"x": 6, "y": 11})   # Bionic slingshot


# Sword of kings (35) — diagonal blade up-right, gold guard + pommel bottom-left
add(35, [
    "..............K.",
    ".............KWK",
    "............KsmK",
    "...........KsmK.",
    "..........KsmK..",
    ".........KsmK...",
    "........KsmK....",
    ".......KsmK.....",
    "......KsmK......",
    ".....KymK......",
    "...KKyKK.......",
    "..KyyyyyK......",
    "...KKwKK.......",
    "...KwwK........",
    "..KyyK.........",
    "..KK...........",
], GRIP_WEAPON)


# ===========================================================================
# EQUIP — PENDANTS & CHARMS (54-63, 194)  gem on a cord
# ===========================================================================
def pendant(fill, hi="W"):
    rows = [
        "....K.....K.....",
        "....sK...Ks.....",
        ".....sK.Ks......",
        "......sKs.......",
        "......KKK.......",
        ".....K###K......".replace("#", fill),
        "....K##H##K.....".replace("#", fill).replace("H", hi),
        "....K#####K.....".replace("#", fill),
        "....K#####K.....".replace("#", fill),
        ".....K###K......".replace("#", fill),
        "......KKK.......",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(54, pendant("g"), GRIP_CENTER)   # Travel charm
add(55, pendant("b"), GRIP_CENTER)   # Great charm
add(56, pendant("s"), GRIP_CENTER)   # Crystal charm
add(58, pendant("r"), GRIP_CENTER)   # Flame pendant
add(59, pendant("b"), GRIP_CENTER)   # Rain pendant
add(60, pendant("p"), GRIP_CENTER)   # Night pendant
add(61, pendant("b"), GRIP_CENTER)   # Sea pendant
add(62, pendant("y"), GRIP_CENTER)   # Star pendant
add(194, pendant("g"), GRIP_CENTER)  # Earth pendant

# Rabbit's foot (57) — lucky paw on a chain
add(57, [
    "......K.........",
    ".....sK.........",
    "......sK........",
    "......KLK.......",
    ".....KLLLK......",
    ".....KLLLK......",
    "....KLLLLK......",
    "....KLLLLK......",
    "....KLLLLLK.....",
    "...KWLWLWLK.....",
    "...KWKWKWKK.....",
    "....KKKKK.......",
    "................",
    "................",
    "................",
    "................",
], GRIP_CENTER)

# Cloak of kings (63) — royal cape
add(63, [
    "................",
    "....KKKKKK......",
    "...KyybbyyK.....",
    "..KKbbbbbbKK....",
    "..KbbbbbbbbK....",
    "..KbbbbbbbbK....",
    ".KbbbbbbbbbbK...",
    ".KbbbbbbbbbbK...",
    ".KbbbbbbbbbbK...",
    ".KbbbbbbbbbbK...",
    ".KbbbbbbbbbbK...",
    ".KbbbbbbbbbbK...",
    ".KKbbbbbbKK....",
    "..KKKKKKKK.....",
    "................",
    "................",
], GRIP_CENTER)


# ===========================================================================
# EQUIP — BRACELETS / BANDS (64-73, 216-217)  oval band, gem variants
# ===========================================================================
def band(metal, hi="W", gem=None):
    g = gem or metal
    top = ".....KKKK......." if not gem else "....KK@@KK......".replace("@", g)
    gemrow = "...KK####KK...." if not gem else "...KKG@@GKK....".replace("@", g).replace("G", "K")
    rows = [
        "................",
        "................",
        top,
        gemrow.replace("#", metal),
        "..K##KKKK##K....".replace("#", metal),
        ".K##K....K##K...".replace("#", metal),
        ".K#H......K#K...".replace("#", metal).replace("H", hi),
        ".K#K......K#K...".replace("#", metal),
        ".K##K....K##K...".replace("#", metal),
        "..K##KKKK##K....".replace("#", metal),
        "...KK####KK....".replace("#", metal),
        ".....KKKK.......",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(64, band("M"), GRIP_CENTER)            # Cheap bracelet
add(65, band("o"), GRIP_CENTER)            # Copper bracelet
add(66, band("s"), GRIP_CENTER)            # Silver bracelet
add(67, band("y"), GRIP_CENTER)            # Gold bracelet
add(68, band("s", gem="W"), GRIP_CENTER)   # Platinum band
add(69, band("s", gem="b"), GRIP_CENTER)   # Diamond band
add(70, band("y", gem="g"), GRIP_CENTER)   # Pixie's bracelet
add(71, band("y", gem="r"), GRIP_CENTER)   # Cherub's band
add(72, band("y", gem="p"), GRIP_CENTER)   # Goddess band
add(73, band("s", gem="r"), GRIP_CENTER)   # Bracer of kings
add(216, band("s", gem="W"), GRIP_CENTER)  # Platinum band (dup)
add(217, band("s", gem="b"), GRIP_CENTER)  # Diamond band (dup)


# ===========================================================================
# EQUIP — HATS / CAPS (74-77)
# ===========================================================================
def cap(col, hi="W", brim=None):
    b = brim or col
    rows = [
        "................",
        "................",
        ".....KKKKK......",
        "...KK#####KK....".replace("#", col),
        "..K###H####K....".replace("#", col).replace("H", hi),
        "..K########K....".replace("#", col),
        "..K########KKKK.".replace("#", col),
        "..K########B##K.".replace("#", col).replace("B", b),
        "..KKKKKKKKKKKKK.",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(74, cap("b"), GRIP_CENTER)   # Baseball cap (blue)
add(76, cap("r"), GRIP_CENTER)   # Mr. Baseball cap (red)

# Holmes hat (75) — deerstalker, tan with ear flaps + bill both sides
add(75, [
    "................",
    "................",
    "....KKKKKK......",
    "...KLLLLLLK.....",
    "..KLLWLLLLLK....",
    "..KLLLLLLLLK....",
    ".KLLLLLLLLLLK...",
    "KKLLLLLLLLLLKK..",
    "KwKKKKKKKKKKwK..",
    ".KK........KK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_CENTER)

# Hard hat (77) — yellow safety helmet with ridge
add(77, [
    "................",
    "................",
    "......KK........",
    ".....KyyK.......",
    "....KyyyyK......",
    "...KyyWyyyK.....",
    "..KyyyyyyyyK....",
    "..KyyyyyyyyK....",
    ".KKyyyyyyyyKK...",
    ".KyyyyyyyyyyK...",
    ".KKKKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_CENTER)


# ===========================================================================
# EQUIP — RIBBONS / BOWS (78-80, 218-220)
# ===========================================================================
def ribbon(col, hi="W"):
    rows = [
        "................",
        "................",
        "..KKK.....KKK...",
        ".K###KK.KK###K..".replace("#", col),
        "K##H##K.K##H##K.".replace("#", col).replace("H", hi),
        "K#####KKK#####K.".replace("#", col),
        "K####K###K####K.".replace("#", col),
        ".K##K#####K##K..".replace("#", col),
        "..KK#######KK...".replace("#", col),
        "....K#####K.....".replace("#", col),
        "...K##K#K##K....".replace("#", col),
        "..K##K.K.K##K...".replace("#", col),
        "..K#K...K.K#K...".replace("#", col),
        "..KK.....K.KK...",
        "................",
        "................",
    ]
    return rows


add(78, ribbon("b"), GRIP_CENTER)   # Ribbon
add(79, ribbon("r"), GRIP_CENTER)   # Red ribbon
add(80, ribbon("y"), GRIP_CENTER)   # Goddess ribbon
add(218, ribbon("g"), GRIP_CENTER)  # Defense ribbon
add(219, ribbon("p"), GRIP_CENTER)  # Talisman ribbon
add(220, ribbon("b"), GRIP_CENTER)  # Saturn ribbon


# ===========================================================================
# EQUIP — COINS (81-86, 221-222, 249)
# ===========================================================================
def coin(fill, edge, mark=None):
    m = mark or fill
    rows = [
        "................",
        "................",
        ".....KKKKK......",
        "...KK@@@@@KK....".replace("@", edge),
        "..K@WW###@@K....".replace("#", fill).replace("@", edge),
        "..K@W####@@K....".replace("#", fill).replace("@", edge),
        "..K@##P##@@K....".replace("#", fill).replace("@", edge).replace("P", m),
        "..K@#####@@K....".replace("#", fill).replace("@", edge),
        "..K@#####@@K....".replace("#", fill).replace("@", edge),
        "...KK@@@@@KK....".replace("@", edge),
        ".....KKKKK......",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(81, coin("y", "o"), GRIP_CENTER)   # Coin of slumber
add(82, coin("y", "o"), GRIP_CENTER)   # Coin of defense
add(83, coin("y", "o"), GRIP_CENTER)   # Lucky coin
add(84, coin("s", "M"), GRIP_CENTER)   # Talisman coin
add(85, coin("y", "o"), GRIP_CENTER)   # Shiny coin
add(86, coin("o", "w"), GRIP_CENTER)   # Souvenir coin (copper)
add(221, coin("s", "M"), GRIP_CENTER)  # Coin of silence
add(222, coin("y", "o"), GRIP_CENTER)  # Charm coin
add(249, coin("s", "M", mark="r"), GRIP_CENTER)  # Mr. Saturn coin

# Diadem of kings (87) — golden crown
add(87, [
    "................",
    "................",
    "..K..K..K..K....",
    "..Ky.Ky.yK.Ky...",
    "..KyKKyKKyKKy...",
    "..KyyyyyyyyyK...",
    "..KyrKyrKyrKy...",
    "..KyyyyyyyyyK...",
    "..KKKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_CENTER)


# ===========================================================================
# FOOD & DRINK PRIMITIVES (88-130, 223-252, etc.)
# ===========================================================================
def bottle(liq, cap="m"):
    rows = [
        "......KKK.......",
        "......K@K.......".replace("@", cap),
        "......K@K.......".replace("@", cap),
        "......K#K.......".replace("#", liq),
        ".....KK#KK.....".replace("#", liq),
        "....K##W##K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        "....K#####K....".replace("#", liq),
        ".....KKKKK.....",
        "................",
        "................",
    ]
    return rows


def can(body, rim="s"):
    rows = [
        "................",
        ".....KKKKK......",
        "....K@@@@@K.....".replace("@", rim),
        "....K#####K.....".replace("#", body),
        "....K#WWW#K.....".replace("#", body),
        "....K#####K.....".replace("#", body),
        "....K#####K.....".replace("#", body),
        "....K#####K.....".replace("#", body),
        "....K#####K.....".replace("#", body),
        "....K#####K.....".replace("#", body),
        "....K@@@@@K.....".replace("@", rim),
        ".....KKKKK......",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


def jar(content, lid="r"):
    rows = [
        "................",
        ".....KKKKK......",
        "....K@@@@@K.....".replace("@", lid),
        "....KKKKKKK.....",
        "...K#######K....".replace("#", content),
        "...K###W###K....".replace("#", content),
        "...K#######K....".replace("#", content),
        "...K#######K....".replace("#", content),
        "...K#######K....".replace("#", content),
        "...K#######K....".replace("#", content),
        "...KK#####KK....".replace("#", content),
        "....KKKKKKK.....",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


def vial(liq, cork="w"):
    rows = [
        ".......KK.......",
        ".......K@K......".replace("@", cork),
        ".......KK.......",
        "......KWWK......",
        "......KW#K......".replace("#", liq),
        "......KW#K......".replace("#", liq),
        "......KW#K......".replace("#", liq),
        "......KW#K......".replace("#", liq),
        "......KW#K......".replace("#", liq),
        "......KW#K......".replace("#", liq),
        "......KKWK......",
        ".......KK.......",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


def pill(c1, c2):
    rows = [
        "................",
        "................",
        "................",
        "....KKKKKKKK....",
        "...K@@@W####K...".replace("@", c1).replace("#", c2),
        "...K@@@@####K...".replace("@", c1).replace("#", c2),
        "...K@@@@####K...".replace("@", c1).replace("#", c2),
        "....KKKKKKKK....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


def bowl(soup, bowlc="s"):
    rows = [
        "................",
        "................",
        "..KKKKKKKKKK....",
        "..K########K...".replace("#", soup),
        ".KW########WK..".replace("#", soup).replace("W", "W"),
        ".K@########@K..".replace("#", soup).replace("@", bowlc),
        ".K@########@K..".replace("#", soup).replace("@", bowlc),
        "..K@######@K...".replace("#", soup).replace("@", bowlc),
        "...K@@@@@@K....".replace("@", bowlc),
        "....KKKKKK.....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


def packet(col):
    rows = [
        "................",
        "................",
        ".....KKKKKK.....",
        "....K######K....".replace("#", col),
        "....K#WWWW#K....".replace("#", col),
        "....K######K....".replace("#", col),
        "....K######K....".replace("#", col),
        "....K######K....".replace("#", col),
        "....KKKKKKKK....",
        ".....K.KK.K.....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(105, jar("o", "r"), GRIP_MID)    # Jar of Fly Honey
add(106, can("o"), GRIP_MID)         # Can of fruit juice
add(108, bottle("r"), GRIP_MID)      # Protein drink
add(109, bowl("o"), GRIP_MID)        # Kraken soup
add(110, bottle("b"), GRIP_MID)      # Bottle of water
add(111, bottle("g"), GRIP_MID)      # Cold remedy
add(112, vial("p"), GRIP_MID)        # Vial of serum
add(113, pill("b", "W"), GRIP_MID)   # IQ capsule
add(114, pill("r", "y"), GRIP_MID)   # Guts capsule
add(115, pill("g", "W"), GRIP_MID)   # Speed capsule
add(116, pill("o", "y"), GRIP_MID)   # Vital capsule
add(117, pill("y", "W"), GRIP_MID)   # Luck capsule
add(118, packet("r"), GRIP_MID)      # Ketchup packet
add(119, packet("W"), GRIP_MID)      # Sugar packet
add(120, can("w"), GRIP_MID)         # Tin of Cocoa
add(123, bottle("r"), GRIP_MID)      # Jar of hot sauce
add(124, packet("W"), GRIP_MID)      # Salt packet
add(126, jar("o", "y"), GRIP_MID)    # Jar of delisauce
add(131, can("p"), GRIP_MID)         # Counter-PSI unit
add(159, pill("r", "W"), GRIP_MID)   # Sudden guts pill
add(161, can("g"), GRIP_MID)         # Defense spray
add(195, vial("g"), GRIP_MID)        # Neutralizer
add(203, bottle("p"), GRIP_MID)      # Video relaxant
add(204, bottle("y"), GRIP_MID)      # Suporma
add(232, can("w"), GRIP_MID)         # Cup of coffee
add(241, bowl("W"), GRIP_MID)        # Plain yogurt
add(189, bowl("p"), GRIP_MID)        # Trout yogurt
add(246, bottle("b"), GRIP_MID)      # Bottle of DXwater
add(107, [  # Royal iced tea — glass
    "................",
    "................",
    "....KKKKKK......",
    "...KooooooK.....",
    "...KoWooooK.....",
    "...KoWWoooK.....",
    "...KooooooK.....",
    "....KooooK......",
    "....KooooK......",
    ".....KoooK......",
    ".....KooK.......",
    "......KK........",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Cookie (88) — round with choc chips
add(88, [
    "................",
    ".....KKKKK......",
    "...KKLLLLLKK....",
    "..KLLkLLLkLK....",
    "..KLLLLLLLLLK...",
    "..KLkLLLLkLLK...",
    "..KLLLLLLLLLK...",
    "..KLLkLLLLLkK...",
    "...KLLLLkLLK....",
    "....KKLLLKK.....",
    ".....KKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Bag of fries (89) — red carton + fries
add(89, [
    "................",
    "....y.y.y.y.....",
    "....y.y.y.y.....",
    "...Ky.y.y.yK....",
    "...KyKyKyKyK....",
    "..KKKKKKKKKK....",
    "..Krrrrrrrr K...".replace(" ", "r"),
    "..KrWrWrWrWrK...",
    "..Krrrrrrrr K...".replace(" ", "r"),
    "..KKrrrrrrKK....",
    "...KKKKKKKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Hamburger (90) and Double burger (233), Mammoth (243)
def burger(extra=False):
    mid = (
        ".KrrrrrrrrrrK..\n"
        ".KwwwwwwwwwwK..\n"
        ".KooooooooooK..\n"
    ) if not extra else (
        ".KwwwwwwwwwwK..\n"
        ".KooooooooooK..\n"
        ".KwwwwwwwwwwK..\n"
    )
    base = [
        "................",
        "....KKKKKKKK....",
        "..KKLLLLLLLLKK..",
        ".KLLWLLWLLWLLLK.",
        ".KLLLLLLLLLLLLK.",
        ".KggggggggggggK.",
    ]
    base += [r for r in mid.strip("\n").split("\n")]
    base += [
        ".KLLLLLLLLLLLLK.",
        "..KKKKKKKKKKKK..",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return base[:16]


add(90, burger(False), GRIP_MID)     # Hamburger
add(233, burger(True), GRIP_MID)     # Double burger
add(243, burger(True), GRIP_MID)     # Mammoth burger

# Eggs (91 boiled, 92 fresh)
add([91, 92], [
    "................",
    ".......KK.......",
    "......KWWK......",
    ".....KWWWWK.....",
    ".....KWWWWK.....",
    "....KWWWWWWK....",
    "....KWWWWWWK....",
    "....KWWWWWWK....",
    "....KWWWWWWK....",
    ".....KWWWWK.....",
    "......KKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Pizza slice (95 small, 97 large, 96 chef's special)
def pizza():
    return [
        "................",
        "..KKKKKKKKKK....",
        "..KLLLLLLLLLK...",
        "..KooooooooKK...",
        "..KorooorooK....",
        "...KoooorooK....",
        "...KooooooK.....",
        "....KorookK.....",
        "....KooooK......",
        ".....KrooK......",
        ".....KooK.......",
        "......KoK.......",
        "......KK........",
        "................",
        "................",
        "................",
    ]


add([95, 96, 97], pizza(), GRIP_MID)

# Bread roll (103), Plain roll (239), Croissant (102)
add([103, 239], [
    "................",
    "................",
    ".....KKKKK......",
    "...KKLLLLLKK....",
    "..KLLLLLLLLLK...",
    "..KLWLLWLLWLK...",
    "..KLLLLLLLLLK...",
    "..KLLLLLLLLLK...",
    "...KLLLLLLLK....",
    "....KKKKKKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

add(102, [  # Croissant — crescent
    "................",
    "................",
    "......KKKK......",
    "....KKLLLLKK....",
    "...KLLLLLLLLK...",
    "..KLLLWLLLLLK...",
    "..KLLLLLLLLLK...",
    "..KKLLLLLLLKK...",
    "....KKLLLKK.....",
    "......KKK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Sandwiches (224,225 skip; 226-231 lucky; 100 brain food; 93 picnic)
def sandwich(f1, f2):
    rows = [
        "................",
        "................",
        "..KKKKKKKKKK....",
        ".KLLLLLLLLLLK...",
        ".KL@@@@@@@@LK...".replace("@", f1),
        ".K##########K...".replace("#", f2),
        ".K@@@@@@@@@@K...".replace("@", f1),
        ".KLLLLLLLLLLK...",
        "..KKKKKKKKKK....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add([224, 225], sandwich("g", "r"), GRIP_MID)        # Skip sandwich
add([226, 227, 228, 229, 230, 231], sandwich("g", "y"), GRIP_MID)  # Lucky sandwich
add(100, sandwich("p", "b"), GRIP_MID)               # Brain food lunch
add(94, bowl("y"), GRIP_MID)                         # Pasta di Summers
add(238, bowl("g"), GRIP_MID)                        # Molokheiya soup
add(236, bowl("W"), GRIP_MID)                        # Bowl of rice gruel
add(223, [  # Cup of noodles
    "................",
    ".....KKKKKK.....",
    "....K@@@@@@K....".replace("@", "r"),
    "....KWWWWWWK....",
    "...K########K...".replace("#", "r"),
    "...K#WWWWW#K....".replace("#", "r"),
    "...K########K...".replace("#", "r"),
    "...K########K...".replace("#", "r"),
    "....K######K....".replace("#", "r"),
    "....K######K....".replace("#", "r"),
    ".....KKKKKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(252, [  # Cup of Lifenoodles — golden cup
    "................",
    ".....KKKKKK.....",
    "....K@@@@@@K....".replace("@", "y"),
    "....KWWWWWWK....",
    "...K########K...".replace("#", "y"),
    "...K#WWWWW#K....".replace("#", "y"),
    "...K########K...".replace("#", "y"),
    "...K########K...".replace("#", "y"),
    "....K######K....".replace("#", "y"),
    "....K######K....".replace("#", "y"),
    ".....KKKKKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Picnic lunch (93) / Brain food box already; picnic = basket
add(93, [
    "................",
    "................",
    "...KKKKKKKK.....",
    "..K#KK##KK#K....".replace("#", "w"),
    "..KwwwwwwwwK....",
    "..KwLwLwLwLK....",
    "..KLwLwLwLwK....",
    "..KwLwLwLwLK....",
    "..KLwLwLwLwK....",
    "..KKKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Candy: PSI caramel (98), Magic tart (207), gum (104), Peanut bar (234)
add(98, [  # PSI caramel — wrapped candy
    "................",
    "................",
    "..K.........K...",
    ".KrK.......KrK..",
    ".KrrKKKKKKKrrK..",
    ".KroooooooorK..",
    ".KroWooWooorK..",
    ".KroooooooorK..",
    ".KrrKKKKKKKrrK..",
    "..KK.......KK..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add([104], [  # Pak of bubble gum
    "................",
    "................",
    "....KKKKKKK.....",
    "...KrrrrrrrK....",
    "...KrWWWWrrK....",
    "...KrrrrrrrK....",
    "...KrbbbbrrK....",
    "...KrrrrrrrK....",
    "...KKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(234, [  # Peanut cheese bar
    "................",
    "................",
    "................",
    "...KKKKKKKKKK...",
    "..K@oooooooo@K.".replace("@", "w").replace("o", "o"),
    "..KooWooWoooK..",
    "..KooooooooooK.",
    "..K@oooooooo@K.".replace("@", "w"),
    "...KKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Rock candy (101), Magic truffle (99), Magic tart (207)
add(101, [  # Rock candy — crystal
    "................",
    "......KK........",
    ".....KpK........",
    "....KppK........",
    "...KpWppK.......",
    "..KppppppK......",
    "..KpppppppK.....",
    "...KppppppK.....",
    "....KppppK......",
    ".....KppK.......",
    "......KK........",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(99, [  # Magic truffle — mushroom
    "................",
    "................",
    "....KKKKKK......",
    "..KKrrrrrrKK....",
    ".KrrWrrrWrrrK...",
    ".KrrrrrrrrrrK...",
    "..KKKKKKKKKK....",
    "....KLLLLK......",
    "....KLLLLK......",
    "....KLLLLK......",
    ".....KKKK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(207, [  # Magic tart
    "................",
    "................",
    "...KKKKKKKK.....",
    "..KLLLLLLLLK....",
    "..KLpppppppLK...",
    "..KLpWppWppLK...",
    "..KLpppppppLK...",
    "..KLLLLLLLLLK...",
    "...KKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(247, [  # Magic pudding
    "................",
    "................",
    "....KKKKKK......",
    "...KoooooooK....",
    "..KooooooooK....",
    "..KoWWoooooK....",
    "..KooooooooK....",
    "..KooooooooK....",
    "...KrrrrrrK.....",
    "....KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(235, [  # Piggy jelly — wobbly red jelly
    "................",
    "................",
    "....KKKKKK......",
    "...KrrrrrrK.....",
    "..KrrWrrrrK.....",
    "..KrrrrrrrrK....",
    "..KrrrrrrrrK....",
    ".KrrrrrrrrrrK...",
    ".KrrrrrrrrrrK...",
    ".KKKKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(198, [  # Gelato de resort — ice cream cone
    "................",
    "....KKK.........",
    "...KrrrK.......",
    "..KrWrbrK......",
    "..KbbrbbK......",
    "..KbbbbbbK.....",
    "...KLLLLK......",
    "....KLLK.......",
    "....KLLK.......",
    ".....KK........",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(251, [  # Popsicle
    "................",
    ".....KKKK.......",
    "....KbbbbK......",
    "....KbWbbK......",
    "....KbbbbK......",
    "....KbbbbK......",
    "....KbbbbK......",
    ".....KwwK.......",
    ".....KwwK.......",
    ".....KwwK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Bananas (190, 166 king, 183 signed), Calorie stick (191), Kabob (240)
add([190, 166, 183], [
    "................",
    "............KK..",
    "..........KKyK..",
    ".........KyyK...",
    ".......KKyyK....",
    ".....KKyyyK.....",
    "....KyyyyK......",
    "...Kyyyyk.......",
    "...Kyyyk........",
    "....KKKK........",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(191, [  # Calorie stick — granola/chocolate bar
    "................",
    "................",
    "...KKKKKKKKKK...",
    "..KwwwwwwwwwwK..",
    "..KwoWwwoWwwwK..",
    "..KwwwwwwwwwwK..",
    "..KwoWwwoWwwwK..",
    "..KwwwwwwwwwwK..",
    "...KKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(240, [  # Kabob — skewer
    ".......K........",
    ".......K........",
    "......KrK.......",
    ".....KrrrK......",
    "......KrK.......",
    "......KgK.......",
    ".....KgggK......",
    "......KoK.......",
    ".....KoooK......",
    "......KrK.......",
    ".....KrrrK......",
    ".......K........",
    ".......K........",
    "................",
    "................",
    "................",
], GRIP_MID)

# Jerky (242 beef, 244 spicy, 245 luxury), Bean croquette (237)
def jerky(meat):
    rows = [
        "................",
        "................",
        "....KKKKK.......",
        "...K@@@o@K......".replace("@", meat),
        "..K@oo@@o@K.....".replace("@", meat),
        "..K@@oo@@@K.....".replace("@", meat),
        "..K@o@@oo@K.....".replace("@", meat),
        "...K@@oo@K......".replace("@", meat),
        "....K@@@K.......".replace("@", meat),
        ".....KKK........",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(242, jerky("w"), GRIP_MID)   # Beef jerky
add(244, jerky("r"), GRIP_MID)   # Spicy jerky
add(245, jerky("o"), GRIP_MID)   # Luxury jerky
add(237, [  # Bean croquette — fried oval
    "................",
    "................",
    "....KKKKKK......",
    "...KoooooooK....",
    "..KooWoooooK....",
    "..KoooooooooK...",
    "..KoooooooooK...",
    "..KooooWoooK....",
    "...KoooooooK....",
    "....KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Herbs (122 parsley, 128 refreshing, 129 secret), Tendakraut (211)
add([122, 128, 129, 211], [  # leafy herb sprig
    "................",
    "................",
    "......KgK.K.....",
    ".....KgggKgK....",
    "....KggKgggK....",
    "....KgKggKgK....",
    ".....KgKgK......",
    "......KgK.......",
    "......KgK.......",
    "......KwK.......",
    "......KwK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Horn of life (130) — golden horn
add(130, [
    "................",
    "..............K.",
    ".............KyK",
    "............KyK.",
    "...........KyK..",
    "..KKK.....KyK...",
    ".KyyyKK..KyK....",
    ".KyWyyyKKyK.....",
    ".KyyyyyyyK......",
    "..KyyyyyK.......",
    "...KKKKK........",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(120, can("w"), GRIP_MID)         # Tin of Cocoa (reassert)
add(121, [  # Carton of cream — milk carton
    "................",
    "......KK........",
    ".....KKKK.......",
    "....K####K......".replace("#", "W"),
    "...K######K.....".replace("#", "W"),
    "...KWWWWWWK.....",
    "...KWbbbbWK.....",
    "...KWWWWWWK.....",
    "...KWWWWWWK.....",
    "...KWWWWWWK.....",
    "...KWWWWWWK.....",
    "...KKKKKKKK.....",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(160, jar("y", "r"), GRIP_MID)    # Bag of Dragonite
add(125, [  # Backstage pass — ticket
    "................",
    "................",
    "...KKKKKKKKKK...",
    "..KyyyyyyyyyyK..",
    "..KyKKyyyKKyyK..",
    "..KyyyyyyyyyyK..",
    "..KyWWyyyWWyyK..",
    "..KyyyyyyyyyyK..",
    "..KyKKyyyKKyyK..",
    "..KyyyyyyyyyyK..",
    "...KKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(127, [  # Wet towel — folded cloth
    "................",
    "................",
    "...KKKKKKKKK....",
    "..KbbbbbbbbbK...",
    "..KbWWWWWWWbK...",
    "..KbbbbbbbbbK...",
    "..KbWWWWWWWbK...",
    "..KbbbbbbbbbK...",
    "..KbWWWWWWWbK...",
    "..KbbbbbbbbbK...",
    "...KKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)


# ===========================================================================
# KEY ITEMS, TOOLS & MISC (1-16, 132-210, 250-253)
# ===========================================================================
# Broken gadgets (4-16) — junk gizmo, color-varied
def brokeng(col):
    rows = [
        "................",
        "................",
        "...KKKKKKKK.....",
        "..K@##KK###K....".replace("#", col).replace("@", col),
        "..K#KK#k##KK....".replace("#", col),
        "..K##k#KK#yK....".replace("#", col),  # spark (yellow)
        "..K#KK###k#K....".replace("#", col),
        "..K###kKK##K....".replace("#", col),
        "..KK######KK....".replace("#", col),
        "...KKKKKKKK.....",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


for i, c in zip(range(4, 17), ["M", "6", "M", "s", "r", "M", "M", "7", "M", "y", "6", "M", "s"]):
    add(i, brokeng(c if c in CH else "M"), GRIP_MID)

# Teddy bears (2 teddy, 3 super plush)
def teddy(fur):
    rows = [
        "................",
        "..KK......KK....",
        ".K@@K....K@@K...".replace("@", fur),
        ".K@@KKKKKK@@K...".replace("@", fur),
        "..K@@@@@@@@K....".replace("@", fur),
        ".K@@K@@@K@@@K...".replace("@", fur),
        ".K@@@@@@@@@@K...".replace("@", fur),
        ".K@@@KKKK@@@K...".replace("@", fur),
        ".K@@@@@@@@@@K...".replace("@", fur),
        "..K@@@@@@@@K....".replace("@", fur),
        "..K@@K@@K@@K....".replace("@", fur),
        "..KK@@@@@@KK....".replace("@", fur),
        "...KK....KK....",
        "................",
        "................",
        "................",
    ]
    return rows


add(2, teddy("w"), GRIP_MID)   # Teddy bear
add(3, teddy("o"), GRIP_MID)   # Super plush bear

# Keys (170,171,192,205,253 carrot key)
def key(col):
    rows = [
        "................",
        "....KKK.........",
        "...K@@@K........".replace("@", col),
        "..K@@K@@K.......".replace("@", col),
        "..K@K.K@K.......".replace("@", col),
        "..K@@K@@K.......".replace("@", col),
        "...K@@@K........".replace("@", col),
        "....K@K.........".replace("@", col),
        "....K@K.........".replace("@", col),
        "....K@KK........".replace("@", col),
        "....K@@K........".replace("@", col),
        "....K@KK........".replace("@", col),
        "....K@@K........".replace("@", col),
        "....KKK.........",
        "................",
        "................",
    ]
    return rows


add([170, 171, 192, 205, 172], key("y"), GRIP_MID)   # metal keys + bad key machine
add(253, [  # Carrot key — orange carrot with green top
    "................",
    "..........KgK...",
    "........KKgKgK..",
    ".......KgKgKK...",
    ".......KoKK.....",
    "......KooK......",
    ".....KooK.......",
    "....KooK........",
    "...KooK.........",
    "..KooK..........",
    "..KoK...........",
    ".KK.............",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Letters / postcards (158,167,179,165 postcard, 174 zombie paper, 164 book)
def envelope(col="W"):
    rows = [
        "................",
        "................",
        "..KKKKKKKKKKK...",
        "..K#########K..".replace("#", col),
        "..K#KK###KK#K..".replace("#", col),
        "..K##KK#KK##K..".replace("#", col),
        "..K###KKK###K..".replace("#", col),
        "..K#########K..".replace("#", col),
        "..K#########K..".replace("#", col),
        "..KKKKKKKKKKK...",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add([158, 167, 179], envelope("W"), GRIP_MID)   # letters
add(165, envelope("y"), GRIP_MID)               # picture postcard
add(174, envelope("g"), GRIP_MID)               # zombie paper
add(164, [  # Shyness book
    "................",
    "................",
    "...KKKKKKKK.....",
    "..KrWrrrrrrK....",
    "..KrrrrrrrrK....",
    "..KrWrrrrrrK....",
    "..KrrrrrrrrK....",
    "..KrWrrrrrrK....",
    "..KrrrrrrrrK....",
    "..KrWrrrrrrK....",
    "..KKKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Gems / rocks (182 diamond, 208 tiny ruby, 186 meteotite, 193 meteorite, 250 meteornium, 201 brain stone, 196 sound stone)
def gem(col, hi="W"):
    rows = [
        "................",
        "................",
        "....KKKKKK......",
        "...K@@@@@@K.....".replace("@", col),
        "..K@HH@@@@@K....".replace("@", col).replace("H", hi),
        "..K@@@@@@@@K....".replace("@", col),
        "...K@@@@@@K.....".replace("@", col),
        "....K@@@@K......".replace("@", col),
        ".....K@@K.......".replace("@", col),
        "......KK........",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(182, gem("b"), GRIP_MID)   # Diamond
add(208, gem("r"), GRIP_MID)   # Tiny ruby
add(201, gem("p"), GRIP_MID)   # Brain stone
def rock(col):
    rows = [
        "................",
        "................",
        "....KKKKK.......",
        "...K@@@@@KK.....".replace("@", col),
        "..K@@WW@@@@K....".replace("@", col),
        "..K@@@@@@@@K....".replace("@", col),
        "..K@@@@@@@@K....".replace("@", col),
        "...K@@@@@@K.....".replace("@", col),
        "....KKKKKK......",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add([186, 193, 250], rock("M"), GRIP_MID)   # meteorite rocks
add(196, rock("b"), GRIP_MID)               # Sound Stone (blue glowing)

# Bombs (147,148) and bottle rockets (144-146)
def bomb(col="k"):
    rows = [
        "................",
        "........KyK.....",
        ".......Ky.K.....",
        "......Ky.K......",
        ".....KK.K.......",
        "...KK#####KK....".replace("#", col),
        "..K#########K...".replace("#", col),
        "..K##WW#####K...".replace("#", col),
        "..K#########K...".replace("#", col),
        "..K#########K...".replace("#", col),
        "...K#######K....".replace("#", col),
        "....KKKKKKK.....",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add([147, 148], bomb("k"), GRIP_MID)   # Bomb, Super bomb
def rocket(col):
    rows = [
        "................",
        "......KK........",
        ".....K@@K.......".replace("@", "r"),
        ".....K@@K.......".replace("@", "r"),
        ".....K##K.......".replace("#", col),
        ".....K##K.......".replace("#", col),
        ".....K##K.......".replace("#", col),
        ".....KWWK.......",
        ".....K##K.......".replace("#", col),
        "....K#KK#K......".replace("#", col),
        "....KK..KK......",
        ".....Koo K......".replace(" ", "o"),
        "......KK........",
        "................",
        "................",
        "................",
    ]
    return rows


add([144, 145, 146], rocket("b"), GRIP_MID)   # bottle rockets

# Spray cans (137,149,157,161 done, 138,139 dispensers)
def spray(col):
    rows = [
        "......KK........",
        ".....K..K.......",
        "....K....K......",
        ".....KKKK.......",
        ".....K@@K.......".replace("@", "M"),
        "....KKKKKK......",
        "...K######K.....".replace("#", col),
        "...K#WWWW#K.....".replace("#", col),
        "...K######K.....".replace("#", col),
        "...K######K.....".replace("#", col),
        "...K######K.....".replace("#", col),
        "...K######K.....".replace("#", col),
        "...KKKKKKKK.....",
        "................",
        "................",
        "................",
    ]
    return rows


add(137, spray("g"), GRIP_MID)   # Xterminator spray
add(149, spray("g"), GRIP_MID)   # Insecticide spray
add(157, spray("b"), GRIP_MID)   # Defense shower
add(138, spray("p"), GRIP_MID)   # Slime generator
add(139, spray("W"), GRIP_MID)   # Yogurt dispenser
add(150, spray("o"), GRIP_MID)   # Rust promoter
add(151, spray("r"), GRIP_MID)   # Rust promoter DX

# Bazookas (133,134), HP-sucker (135,136), Shield killer (132), Counter (131 done)
def launcher(col):
    rows = [
        "................",
        "................",
        "................",
        "..KKKKKKKKKKKK..",
        ".K@##########@K.".replace("#", col).replace("@", "M"),
        ".K#WW#######BBK.".replace("#", col).replace("B", "k"),
        ".K##########BBK.".replace("#", col).replace("B", "k"),
        ".K@#########@KK.".replace("#", col).replace("@", "M"),
        "..KKKK#KKKKKK...".replace("#", col),
        "....K##K........".replace("#", col),
        "....KKKK........",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]
    return rows


add(133, launcher("g"), GRIP_GUN)   # Bazooka
add(134, launcher("M"), GRIP_GUN)   # Heavy bazooka
add([135, 136], launcher("p"), GRIP_GUN)   # HP-sucker
add(132, launcher("r"), GRIP_GUN)   # Shield killer

# Measuring tools: Ruler (140), Protractor (143)
add(140, [  # Ruler
    "................",
    "................",
    "................",
    "..KKKKKKKKKKKK..",
    "..KyKyKyKyKyKK..",
    "..KyyyyyyyyyyK..",
    "..KKKKKKKKKKKK..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(143, [  # Protractor — half disc
    "................",
    "................",
    "................",
    "....KKKKKK......",
    "..KKbbbbbbKK....",
    ".KbbbWWWWbbbK...",
    ".KbbWKKKKWbbK...",
    ".KbbbbbbbbbbK...",
    ".KKKKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Snakes (199,200,141 snake bag, 153 stag beetle)
def snake(col):
    rows = [
        "................",
        "................",
        "....KKK.........",
        "...K@@@K.KK.....".replace("@", col),
        "...K@W@KK@@K....".replace("@", col),
        "...K@@@@@@@K....".replace("@", col),
        "....KKK@@@@K....".replace("@", col),
        "......K@@@@K....".replace("@", col),
        ".....K@@@K......".replace("@", col),
        "....K@@@K.......".replace("@", col),
        "...K@@@K....KK..".replace("@", col),
        "...K@@K...KK@@K.".replace("@", col),
        "....KKK..K@@@@K.".replace("@", col),
        "..........KKKK..",
        "................",
        "................",
    ]
    return rows


add([199, 200], snake("g"), GRIP_MID)   # Snake, Viper
add(141, [  # Snake bag
    "................",
    ".....KKKK.......",
    "....K@@@@K......".replace("@", "w"),
    "...KwwwwwwK.....",
    "..KwwggwgwwK....",
    "..KwgwwwgwwK....",
    "..KwwwgwwwwK....",
    "..KwggwwgwwK....",
    "..KwwwwwwwwK....",
    "..KwwwwwwwwK....",
    "...KKKKKKKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(153, [  # Stag beetle
    "................",
    "...K......K.....",
    "..KyK....KyK....",
    "...KyK..KyK.....",
    "....KKkkKK......",
    "...KkkkkkkK.....",
    "..Kkkkkkkkk K...".replace(" ", "k"),
    "..KkkWkkWkkK...",
    "..Kkkkkkkkk K...".replace(" ", "k"),
    "...KkkkkkkK.....",
    "....KkkkkK......",
    ".....KkkK.......",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Tech / cards: ATM card(177), Show ticket(178), Receiver phone(181),
# Town map(202), Bicycle(176), Hawk eye(175), For Sale sign(163)
add(177, [  # ATM card
    "................",
    "................",
    "..KKKKKKKKKKK...",
    "..KbbbbbbbbbK..",
    "..KbyyyyyyybK..",
    "..KbbbbbbbbbK..",
    "..KbWWWbbbbbK..",
    "..KbbbbbbbbbK..",
    "..KbbbbbKKKKK..",
    "..KKKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(178, [  # Show ticket
    "................",
    "................",
    "...KKKKKKKKKK...",
    "..KyyyyyyyyyyK..",
    "..KyKKyyyyKyyK..",
    "..KyyyyyyyyyyK..",
    "..KyWWWWWWyyyK..",
    "..KyyyyyyyyyyK..",
    "..KyKKyyyyKyyK..",
    "...KKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(181, [  # Receiver phone
    "................",
    "...KK.....KK....",
    "..K@@K...K@@K...".replace("@", "k"),
    "..K@@@K.K@@@K...".replace("@", "k"),
    "...K@@@K@@@K....".replace("@", "k"),
    "....K@@@@@K.....".replace("@", "k"),
    ".....K@@@K......".replace("@", "k"),
    ".....K@@@K......".replace("@", "k"),
    "......KKK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(202, [  # Town map
    "................",
    "................",
    "..KKKKKKKKKKK...",
    "..KLLLLLLLLLK..",
    "..KLgKLLbbLLK..",
    "..KLgggLbbLLK..",
    "..KLLgLLLLrLK..",
    "..KLLLLwwLrLK..",
    "..KLbbLwwLLLK..",
    "..KLbbLLLgLLK..",
    "..KLLLLLLgLLK..",
    "..KKKKKKKKKKK...",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(176, [  # Bicycle — two wheels + frame
    "................",
    "................",
    "...........KKK..",
    "..........KbbbK.",
    "....KKK....KKK..",
    "..KKrrKKKKKKrK..",
    ".KrKKrrrrrKrrK..",
    ".KrK.KrrrKr.K...",
    "KrrrK.KrK.KrrrK.",
    "KrKrK.....KrKrK.",
    "KrKrK.....KrKrK.",
    "KrrrK.....KrrrK.",
    ".KrK.......KrK..",
    "..K.........K...",
    "................",
    "................",
], GRIP_MID)
add(175, [  # Hawk eye — eye device
    "................",
    "................",
    "...KKKKKKKK.....",
    "..K########K....".replace("#", "M"),
    ".KWWWWWWWWWWK...",
    ".KW#bbbbbb#WK..".replace("#", "W"),
    ".KWb K bbbbWK..".replace(" ", "b").replace("K b", "Kkb"),
    ".KW#bbbbbb#WK..".replace("#", "W"),
    ".KWWWWWWWWWWK...",
    "..K########K....".replace("#", "M"),
    "...KKKKKKKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(163, [  # For Sale sign
    "................",
    "..KKKKKKKKKK....",
    "..KWWWWWWWWK....",
    "..KWrrWWrrWK....",
    "..KWrWWWWrWK....",
    "..KWWWWWWWWK....",
    "..KWrrWWWWWK....",
    "..KWrWWWWWWK....",
    "..KKKKKKKKKK....",
    "......KwK.......",
    "......KwK.......",
    "......KwK.......",
    "......KwK.......",
    "......KwK.......",
    "................",
    "................",
], GRIP_MID)

# Erasers (184 pencil eraser, 210 eraser eraser)
add([184, 210], [
    "................",
    "................",
    "................",
    "....KKKKKK......",
    "...KaaaaaaK....".replace("a", "r"),
    "...KrWrrrrK....",
    "...KrrrrrrK....",
    "...KbbbbbbK....",
    "...KbbbbbbK....",
    "...KKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)

# Misc single items
add(154, [  # Toothbrush
    "................",
    "................",
    "..KKKKK.........",
    ".KWWWWWKKKKKKK..",
    ".KWWWWWbbbbbbK..",
    ".KWWWWWKKKKKKK..",
    "..KKKKK.........",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(162, [  # Piggy nose
    "................",
    "................",
    "....KKKKKK......",
    "...KppppppK.....",
    "..KppppppppK....",
    "..KpKppppKpK....",
    "..KpKppppKpK....",
    "..KppppppppK....",
    "...KpppppppK....",
    "....KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(152, [  # Pair of dirty socks
    "................",
    "................",
    "..KK...KK.......",
    "..KWK..KWK......",
    "..KWK..KWK......",
    "..KWK..KWK......",
    "..KWKK.KWKK.....",
    "..KWWKKKWWWK....",
    "..KWWWKKWWWK....",
    "...KKK..KKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(168, [  # Chick
    "................",
    "................",
    "......KKK.......",
    ".....KyyyK......",
    ".....KyKyK......",
    "....oKyyyK......",
    ".....KyyyKK.....",
    "....KyyyyyyK....",
    "....KyyyyyyK....",
    ".....KyyyyK.....",
    "......KooK......",
    "......K.K.......",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(169, [  # Chicken
    "................",
    "....rr..........",
    "...KrrK.........",
    "...KWWKKK.......",
    "..oKWWWWK.......",
    "...KWWWWWKK.....",
    "..KWWWWWWWWK....",
    "..KWWWWWWWWK....",
    "..KWWWWWWWWK....",
    "...KWWWWWWK.....",
    "....KWKKWK......",
    "....KK..KK......",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(188, [  # Hand-Aid — bandage
    "................",
    "................",
    "................",
    "....KKKKKKKK....",
    "...KLLLLLLLLK...",
    "...KLWWLLWWLK...",
    "...KLWWLLWWLK...",
    "...KLLLLLLLLK...",
    "....KKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(187, [  # Contact lens
    "................",
    "................",
    "................",
    "....KKKKKK......",
    "..KKbWWWbKK....",
    ".KbbWWWWWbbK...",
    ".KbWWWWWWWbK...",
    ".KbbWWWWWbbK...",
    "..KKbbbbbKK....",
    "....KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(142, [  # Mummy wrap — bandage roll
    "................",
    "................",
    "....KKKKKK......",
    "...KLLLLLLK.....",
    "..KLWLLWLLLK....",
    "..KLLWLLWLLK....",
    "..KLWLLWLLLK....",
    "..KLLWLLWLLK....",
    "..KLWLLWLLLK....",
    "...KLLLLLLK.....",
    "....KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(155, [  # Handbag strap
    "................",
    "...KKKKKKK......",
    "..K@.....@K.....".replace("@", "w"),
    "..K@.....@K.....".replace("@", "w"),
    "..KwK...KwK.....",
    "..KwK...KwK.....",
    "..KwK...KwK.....",
    "..KwK...KwK.....",
    "..KwK...KwK.....",
    "..KKK...KKK.....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(156, [  # Pharaoh's curse — ankh
    "................",
    ".....KKKK.......",
    "....Ky..yK......",
    "....Ky..yK......",
    "....Ky..yK......",
    ".....KyyK.......",
    "...KKKyyKKK.....",
    "...KyyyyyyK.....",
    "...KKKyyKKK.....",
    "......KyK.......",
    "......KyK.......",
    "......KyK.......",
    "......KKK.......",
    "................",
    "................",
    "................",
], GRIP_MID)
add(185, [  # Hieroglyph copy — papyrus
    "................",
    "................",
    "..KKKKKKKKKK....",
    "..KLLLLLLLLK....",
    "..KLKLLwLwLK....",
    "..KLwLwLLLLK....",
    "..KLLLKLwwLK....",
    "..KLwwLLLLLK....",
    "..KLLLwLKwLK....",
    "..KLwLLLLLLK....",
    "..KKKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(173, [  # Temporary goods — cardboard box
    "................",
    "................",
    "...KKKKKKKK.....",
    "..KLwLLLLwLK....",
    "..KLLLLLLLLK....",
    "..KLLwwwwLLK....",
    "..KLLLLLLLLK....",
    "..KLLLLLLLLK....",
    "..KLwLLLLwLK....",
    "..KKKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(180, [  # Wad of bills
    "................",
    "................",
    "...KKKKKKKKK....",
    "..KgggggggggK...",
    "..KgKgggggKgK...",
    "..KgKgWWgKKgK...",
    "..KgKgggggKgK...",
    "..KgggggggggK...",
    "...KKKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(197, [  # Exit mouse
    "................",
    "................",
    "..KK....KK.....",
    ".K@@K..K@@K.....".replace("@", "m"),
    ".K@@@KK@@@K.....".replace("@", "m"),
    "..K@@@@@@K......".replace("@", "m"),
    ".K@@KW@K@@K.....".replace("@", "m"),
    ".K@@@@@@@@K.....".replace("@", "m"),
    ".K@@@@@@@@K....r".replace("@", "m"),
    "..K@@@@@@KKKKrr.".replace("@", "m"),
    "...KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(209, [  # Monkey's love — heart
    "................",
    "................",
    "..KK...KK......",
    ".KrrKKKrrK.....",
    "KrrrrrrrrrK....",
    "KrrWrrrrrrK....",
    "KrrrrrrrrrK....",
    ".KrrrrrrrK.....",
    "..KrrrrrK......",
    "...KrrrK.......",
    "....KrK........",
    ".....K.........",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(206, [  # Insignificant item — tiny speck
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    ".......KK.......",
    "......KssK......",
    "......KssK......",
    ".......KK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)
add(1, [  # Franklin badge — lightning pendant
    "................",
    "................",
    "....KKKKKK......",
    "...KbbbbbbK.....",
    "..KbbyybbbbK....",
    "..KbbybbbbbK....",
    "..Kbbyyybbb K...".replace(" ", "b"),
    "..Kbbbbybbb K...".replace(" ", "b"),
    "..Kbbbbybbb K...".replace(" ", "b"),
    "...Kbbbbbb K....".replace(" ", "b"),
    "....KKKKKK......",
    "................",
    "................",
    "................",
    "................",
    "................",
], GRIP_MID)


def emit():
    existing = {}
    if os.path.exists(OUT):
        existing = json.load(open(OUT, encoding="utf-8"))
    out = dict(existing)
    bad = []
    for iid, a in ART.items():
        for y, row in enumerate(a["rows"]):
            for c in row:
                if c not in CH:
                    bad.append(f"  item {iid} row {y}: bad char {c!r} in {row!r}")
                    break
    if bad:
        raise SystemExit("BAD CHARS:\n" + "\n".join(bad))
    for iid, a in ART.items():
        f0, f1, f2 = anim_frames(iid, a["rows"], a["grip"])
        frames = [encode(f0, iid), encode(f1, iid), encode(f2, iid)]
        out[iid] = {"pixels": frames[0], "frames": frames, "grip": a["grip"]}
    json.dump(out, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"Wrote {OUT}: authored {len(ART)} items (3 frames each), file now {len(out)} entries")


if __name__ == "__main__":
    emit()
