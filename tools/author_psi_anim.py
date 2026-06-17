"""
author_psi_anim.py — procedural PSI effect animations for every ability.

OUR OWN art (no ROM-derived pixels): 48x48 RGBA flipbooks, one effect style per
PSI family (fire / freeze / thunder / flash / stars / heal / shield / buff /
hypnosis / magnet / teleport / paralysis / default), tier-scaled (α<β<γ<Ω), each
frame emitted as a PNG data URL into public/overrides/psi_anim.json — the exact
shape PsiAnim.ts / the Sprite Editor's PSI mode read & write.

These are PROCEDURAL placeholders in the spirit of author_item_sprites.py: good
enough to read at a glance and to wire the cast system against, and fully editable
frame-by-frame in the PSI editor. Hand-polish over them there; re-running this
regenerates every entry, so do refinements in the editor (or extend the
generators here), not by hand-editing the JSON.

delivery is chosen from the PSI's type (offense→projectile, recover→target,
else caster), matching psiEditor.defaultDelivery.

Run:
  C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe tools/author_psi_anim.py
"""
import base64
import io
import json
import math
import os
import random

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PSI_JSON = os.path.join(ROOT, "public", "assets", "map", "psi.json")
OUT = os.path.join(ROOT, "public", "overrides", "psi_anim.json")

W = H = 48
CX = CY = 24
FRAMES = 6
TIER_SCALE = {"none": 1.0, "alpha": 0.8, "beta": 1.0, "gamma": 1.2, "omega": 1.5}


def new_frame():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def data_url(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def disc(d, x, y, r, color):
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def star(d, x, y, r, color):
    # 4-point sparkle: two crossed thin diamonds.
    d.polygon([(x, y - r), (x + r * 0.3, y), (x, y + r), (x - r * 0.3, y)], fill=color)
    d.polygon([(x - r, y), (x, y + r * 0.3), (x + r, y), (x, y - r * 0.3)], fill=color)


# --- per-family generators: f in [0,1) over the flipbook, s = tier scale -------

def gen_fire(d, f, s, rng):
    # bold flame: a hot base glow + dense rising tongues with bright cores.
    disc(d, CX, H - 9, 13 * s, (255, 90, 20, 110))
    for _ in range(int(14 * s)):
        x = CX + rng.uniform(-11, 11) * s
        base = H - 5
        h = (16 + 18 * s) * (0.5 + 0.5 * f)
        y = base - h * rng.uniform(0.25, 1.0)
        r = rng.uniform(3.5, 8) * s
        hot = rng.random() < 0.45 + 0.4 * f
        disc(d, x, y, r, (255, 230, 110, 255) if hot else (255, 120, 30, 255))
        disc(d, x, y, max(1, r * 0.4), (255, 255, 210, 255))


def gen_freeze(d, f, s, rng):
    # bold ice: an expanding ring of solid crystals + a bright core flare.
    disc(d, CX, CY, int(15 * s), (120, 210, 255, 70))
    spread = 4 + 18 * f
    for i in range(int(9 * s)):
        a = i / max(1, int(9 * s)) * math.tau + f
        x = CX + math.cos(a) * spread * s
        y = CY + math.sin(a) * spread * s
        r = (8 - 4 * f) * s
        d.polygon([(x, y - r), (x + r * 0.55, y), (x, y + r), (x - r * 0.55, y)], fill=(150, 235, 255, 255))
        disc(d, x, y, max(1, r * 0.3), (245, 255, 255, 255))
    disc(d, CX, CY, max(1, (7 - 5 * f)) * s, (245, 255, 255, 255))


def gen_thunder(d, f, s, rng):
    # bold bolt: a thick jagged main bolt + a couple of forks + a flash head.
    def bolt(x0, w0):
        x, y = x0, 2
        while y < H - 4:
            nx = x + rng.uniform(-8, 8) * s
            ny = y + rng.uniform(6, 11)
            d.line([(x, y), (nx, ny)], fill=(255, 250, 140, 255), width=w0)
            d.line([(x, y), (nx, ny)], fill=(255, 255, 235, 255), width=max(1, w0 - 2))
            x, y = nx, ny
        return x, y
    fx, fy = bolt(CX + rng.uniform(-3, 3), max(3, int(4 * s)))
    if s >= 1.0:
        bolt(CX + rng.uniform(-12, 12) * s, max(2, int(3 * s)))
    disc(d, fx, fy, 7 * s, (255, 255, 180, 200))


def gen_flash(d, f, s, rng):
    # bold flash: a filled white burst fading out + bright rays.
    r = (6 + 24 * f) * s
    core_a = int(255 * (1 - f))
    disc(d, CX, CY, max(2, (16 - 12 * f) * s), (255, 255, 255, core_a))
    disc(d, CX, CY, max(1, (9 - 8 * f) * s), (255, 255, 220, 255))
    for i in range(8):
        a2 = i / 8 * math.tau + f
        x2 = CX + math.cos(a2) * r
        y2 = CY + math.sin(a2) * r
        d.line([(CX, CY), (x2, y2)], fill=(255, 255, 230, int(220 * (1 - f))), width=max(1, int(2 * s)))


def gen_stars(d, f, s, rng):
    # bold sparkle field: bigger solid 4-point stars with white cores.
    for _ in range(int(13 * s)):
        x = rng.uniform(4, W - 4)
        y = rng.uniform(4, H - 4)
        tw = 0.5 + 0.5 * math.sin((f + rng.random()) * math.tau)
        r = (3 + 5 * tw) * s
        c = rng.choice([(255, 240, 130), (170, 210, 255), (255, 180, 230)])
        star(d, x, y, r, c + (255,))
        disc(d, x, y, max(1, r * 0.3), (255, 255, 255, 255))


def gen_heal(d, f, s, rng):
    # bold green healing: a soft aura + a rising column of SOLID sparkles with a
    # bright core + two pulsing plus signs. Reads clearly even at tier α.
    disc(d, CX, CY, int(17 * s), (70, 240, 110, 60))  # aura glow
    disc(d, CX, CY, int(11 * s), (90, 250, 130, 70))
    for _ in range(int(16 * s)):
        x = CX + rng.uniform(-13, 13) * s
        y = (H - 3) - (H - 6) * ((f + rng.random()) % 1.0)
        r = rng.uniform(2.5, 5) * s
        disc(d, x, y, r, (150, 255, 165, 255))
        disc(d, x, y, max(1, r * 0.45), (240, 255, 240, 255))  # white-hot core
    for k in (-9, 9):
        px = CX + k * s
        py = CY - 4 + 7 * math.sin(f * math.tau + k)
        w2 = max(2, int(3 * s))
        d.line([(px - 5 * s, py), (px + 5 * s, py)], fill=(120, 255, 150, 255), width=w2)
        d.line([(px, py - 5 * s), (px, py + 5 * s)], fill=(120, 255, 150, 255), width=w2)


def gen_shield(d, f, s, rng):
    # bold barrier: two thick pulsing hex rings + node dots at the vertices.
    pulse = 13 + 6 * math.sin(f * math.tau)
    for ring in (pulse, pulse * 0.62):
        pts = []
        for i in range(7):
            a = i / 6 * math.tau + f * 0.6
            pts.append((CX + math.cos(a) * ring * s, CY + math.sin(a) * ring * s))
        d.line(pts, fill=(140, 230, 255, 255), width=max(2, int(3 * s)))
        for px, py in pts[:6]:
            disc(d, px, py, max(1, 2 * s), (235, 250, 255, 255))


def gen_buff(d, f, s, rng, up=True, color=(160, 255, 160, 255)):
    for k in range(int(6 * s)):
        x = CX + rng.uniform(-13, 13) * s
        prog = (f + k / max(1, int(6 * s))) % 1.0
        y = (H - 4 - (H - 8) * prog) if up else (4 + (H - 8) * prog)
        a = 7 * s
        d.polygon(
            [(x, y - a), (x - a * 0.7, y + a * 0.4), (x + a * 0.7, y + a * 0.4)]
            if up
            else [(x, y + a), (x - a * 0.7, y - a * 0.4), (x + a * 0.7, y - a * 0.4)],
            fill=color,
        )


def gen_spiral(d, f, s, rng, color):
    # bold spiral: thicker arm with bright cores, two interleaved arms.
    for arm in (0.0, math.pi):
        for i in range(26):
            t = i / 26
            a = t * math.tau * 2 + f * math.tau + arm
            r = t * 21 * s
            rad = max(1, 3.2 * s * (1 - t * 0.6))
            disc(d, CX + math.cos(a) * r, CY + math.sin(a) * r, rad, color)
    disc(d, CX, CY, max(1, 3 * s), color[:3] + (255,))


def gen_magnet(d, f, s, rng):
    disc(d, CX, CY, int(6 * s), (200, 130, 255, 120))
    for ring in range(3):
        r = ((ring * 7 + f * 7) % 21) * s
        a = int(255 * (1 - r / (21 * s)))
        d.ellipse([CX - r, CY - r, CX + r, CY + r], outline=(210, 150, 255, a), width=max(2, int(3 * s)))


def gen_default(d, f, s, rng):
    disc(d, CX, CY, int((6 + 8 * f) * s), (200, 200, 255, 70))
    for _ in range(int(11 * s)):
        a = rng.random() * math.tau
        r = (4 + 18 * f) * s * rng.uniform(0.3, 1.0)
        x = CX + math.cos(a) * r
        y = CY + math.sin(a) * r
        star(d, x, y, rng.uniform(2.5, 4.5) * s, (210, 210, 255, 255))
        disc(d, x, y, 1, (255, 255, 255, 255))


def pick_generator(name):
    n = name.lower()
    if "fire" in n:
        return gen_fire
    if "freeze" in n:
        return gen_freeze
    if "thunder" in n:
        return gen_thunder
    if "flash" in n:
        return gen_flash
    if "starstorm" in n or "????" in n or "(" in n:
        return gen_stars
    if "lifeup" in n or "healing" in n:
        return gen_heal
    if "shield" in n:
        return gen_shield
    if "offense" in n:
        return lambda d, f, s, rng: gen_buff(d, f, s, rng, up=True, color=(255, 210, 120, 220))
    if "defense" in n:
        return lambda d, f, s, rng: gen_buff(d, f, s, rng, up=False, color=(255, 130, 130, 220))
    if "hypnosis" in n:
        return lambda d, f, s, rng: gen_spiral(d, f, s, rng, (150, 220, 255, 200))
    if "brainshock" in n:
        return lambda d, f, s, rng: gen_spiral(d, f, s, rng, (230, 130, 255, 200))
    if "magnet" in n:
        return gen_magnet
    if "teleport" in n:
        return lambda d, f, s, rng: gen_spiral(d, f, s, rng, (180, 255, 220, 200))
    if "paralysis" in n:
        return gen_thunder  # yellow crackle reads as "numb/zap"
    return gen_default


def delivery_for(types, name):
    # ROM type strings: 'offense', 'recovery', 'assist' (substring-match to be safe).
    n = name.lower()
    # Ailment PSI land ON the foe, so they read as hitting the target.
    if any(k in n for k in ("hypnosis", "paralysis", "brainshock")):
        return "target"
    if any("offense" in t for t in types):
        return "projectile"
    if any("recover" in t for t in types):
        return "target"
    return "caster"


def main():
    with open(PSI_JSON, "r", encoding="utf-8") as f:
        catalog = json.load(f)
    abilities = catalog.get("abilities", [])

    anims = {}
    for ab in abilities:
        gen = pick_generator(ab.get("name", ""))
        s = TIER_SCALE.get(ab.get("strength", "none"), 1.0)
        rng = random.Random(ab["id"])  # stable per ability
        frames = []
        for fi in range(FRAMES):
            img = new_frame()
            d = ImageDraw.Draw(img, "RGBA")
            gen(d, fi / FRAMES, s, rng)
            frames.append(data_url(img))
        anims[ab["id"]] = {
            "delivery": delivery_for(ab.get("type", []), ab.get("name", "")),
            "frames": frames,
        }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "anims": anims}, f)

    print(f"Wrote {OUT}")
    print(f"  PSI animations: {len(anims)}  ({FRAMES} frames each, 48x48)")
    for ab in abilities:
        if ab.get("name") == "Lifeup":
            e = anims[ab["id"]]
            print(f"  [{ab['id']}] delivery={e['delivery']} frames={len(e['frames'])}")


if __name__ == "__main__":
    main()
