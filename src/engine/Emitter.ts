/**
 * Emitter — floating world-space popups (damage/heal numbers, later text FX).
 *
 * When an entity is damaged or healed, a number pops off its body, arcs along a
 * random ballistic trajectory (launch up, peak, fall under gravity), then fades.
 * Lifecycle mirrors ChatManager's bubbles: spawn records a birth time, position
 * is computed analytically from age each frame (no per-frame integration, so it
 * survives frame drops), and updateEmitters() just culls the expired.
 *
 * Rendered in WORLD space with the small EB battle font (4), so it shares the
 * camera transform with sprites. On real SNES this maps to a handful of OAM
 * sprites per number — keep the count modest.
 */

import { drawText, measureText, getLineHeight } from './TextRenderer';
import { getCombatJuice } from './CombatJuice';

// The combat-number feel knobs (lifetime, gravity, launch speed, scaling, the
// damage/heal/crit/miss colors) are LIVE-TUNABLE — they live in CombatJuice and
// are read per spawn/frame via getCombatJuice() so the dev Combat tool can dial
// them in real time. The constants below are STRUCTURAL (not combat-feel) and
// stay fixed: XP/level-up/loot text isn't combat juice.
const FONT = 4; // small 8px battle font (matches EB damage text)
const FLOAT_RISE = 22; // px/s straight-up drift for XP / level-up text
const SPAWN_RISE = 18; // px above the feet the number pops from
const BURST_RISE = 26; // px/s upward drift for the SMAAAASH! burst
const BURST_HOLD = 0.55; // fraction of life fully opaque before the climax fade
const LEVELUP_SCALE = 1.5; // LEVEL UP! renders bigger than other popups

const XP_COLOR = '#7fd0ff'; // cyan, matches the EB "you won the battle" EXP text
const LEVELUP_COLOR = '#ffd23d'; // gold
const SHADOW_COLOR = '#000000';
// 8-way unit offsets for the black outline ring drawn under every popup (scaled
// by the popup's render scale so big numbers get a proportional outline).
const OUTLINE_OFFSETS: readonly [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

const MAX_POPUPS = 64; // hard cap; oldest dropped past this

// arc   = ballistic launch + gravity + late fade (damage/miss)
// float = drift straight up, centered, fade over life (XP / loot / level-up)
// burst = drift up while scaling up, fades away at its scale climax (SMAAAASH!)
// heal  = drift up while swaying on a sine curve, fade over life (heal numbers)
type PopupStyle = 'arc' | 'float' | 'burst' | 'heal';

interface Popup {
  text: string;
  x0: number; // world origin x (number is centered here)
  y0: number; // world origin y
  vx: number; // px/s horizontal (0 for float/burst style)
  color: string;
  born: number; // performance.now() at spawn
  style: PopupStyle;
  life: number; // ms this popup lives
  scale: number; // base render scale (burst grows from this)
  top: boolean; // draw above every other popup (level-up)
  riseRate?: number; // float style: px/s upward drift (defaults to FLOAT_RISE)
  holdFrac?: number; // float style: fraction of life fully opaque before fading (0 = fade from birth)
}

const popups: Popup[] = [];

// Offscreen scratch buffers. `mask` renders one recolored glyph; `tint` composes
// the black outline ring + colored fill at SOURCE resolution, then we scale-blit
// the result once — so the outline is baked a fixed 1 source-px from the fill and
// stays welded to the digit at any (even fractional/growing) scale.
const maskCanvas = document.createElement('canvas');
const mctx = maskCanvas.getContext('2d')!;
const tintCanvas = document.createElement('canvas');
const tctx = tintCanvas.getContext('2d')!;

function now(): number {
  return performance.now();
}

// Bigger hits/heals pop bigger numbers — size ramps from numScaleMin (1 damage)
// to numScaleMax (numScaleCap damage, the FF-style 9999 ceiling). The map is
// LOGARITHMIC so the low-to-mid range — where real EB-scale damage lives —
// still varies visibly instead of pinning to min against the huge ceiling.
// (log: 1→min, cap→max, and e.g. sqrt(cap)≈half-scale.) All three are tunable.
function magnitudeScale(amount: number): number {
  const j = getCombatJuice();
  const cap = Math.max(2, j.numScaleCap); // >1 so log(cap) is a safe, nonzero divisor
  const v = Math.min(cap, Math.max(1, amount));
  const t = Math.log(v) / Math.log(cap); // 0 at 1 damage, 1 at the cap
  return j.numScaleMin + (j.numScaleMax - j.numScaleMin) * t;
}

/** Pop a damage number off an entity at world (x, y = feet). The heaviest hits
 *  ramp toward the bigHit color when that's enabled in CombatJuice. */
export function spawnDamageNumber(x: number, y: number, amount: number): void {
  const j = getCombatJuice();
  let color = j.colDamage;
  if (j.bigHitRamp && j.bigHitThreshold > 0 && amount > j.bigHitThreshold) {
    // Ramp from the normal color at the threshold to full bigHit color at 2×.
    const t = Math.min(1, (amount - j.bigHitThreshold) / j.bigHitThreshold);
    color = lerpHex(j.colDamage, j.colBigHit, t);
  }
  spawn(String(Math.round(amount)), x, y, color, { scale: magnitudeScale(amount) });
}

/** Pop a RED damage number for the LOCAL player getting hit. Each client renders
 *  its own popups, so only that player sees their own damage in red; everyone
 *  else's hits stay white (spawnDamageNumber). */
export function spawnOwnDamageNumber(x: number, y: number, amount: number): void {
  spawn(String(Math.round(amount)), x, y, getCombatJuice().colOwnDamage, {
    scale: magnitudeScale(amount),
  });
}

/** Pop a green heal number off an entity — drifts up while swaying on a sine
 *  curve and fades, so healing reads as soothing vs the punchy damage arc. */
export function spawnHealNumber(x: number, y: number, amount: number): void {
  spawn(`+${Math.round(amount)}`, x, y, getCombatJuice().colHeal, {
    style: 'heal',
    life: getCombatJuice().healLife,
    scale: magnitudeScale(amount),
  });
}

/** Pop a cyan "+N XP" that floats straight up off the player and fades. */
export function spawnXpNumber(x: number, y: number, amount: number): void {
  spawn(`+${Math.round(amount)} XP`, x, y, XP_COLOR, { style: 'float', life: 1000 });
}

/** Pop a gold "LEVEL UP!" — centered, bigger, lives the LONGEST, and always
 *  renders on top of every other popup. */
export function spawnLevelUp(x: number, y: number): void {
  spawn('LEVEL UP!', x, y, LEVELUP_COLOR, {
    style: 'float',
    riseExtra: 18,
    life: 2200,
    scale: LEVELUP_SCALE,
    top: true,
  });
}

/** Pop a red "SMAAAASH!" off a crit — centered, rises while scaling up, then
 *  fades away at its climax (no arc). */
export function spawnCritText(x: number, y: number): void {
  spawn('SMAAAASH!', x, y, getCombatJuice().colCrit, {
    style: 'burst',
    riseExtra: 6,
    life: getCombatJuice().critLife,
  });
}

/** Pop a dim "MISS" off a whiffed/dodged swing. */
export function spawnMissText(x: number, y: number): void {
  spawn('MISS', x, y, getCombatJuice().colMiss, { life: 750 });
}

const MORTAL_COLOR = '#ff2a2a'; // blood red — a KO is dire (not combat juice, fixed)

/** Pop a dire "MORTAL DAMAGE!" off a player who's been KO'd + knocked over.
 *  Server-broadcast (player_downed) so EVERY client raises it over that player.
 *  Tight + fixed size (no balloon), barely drifts off the head, and holds opaque
 *  well past a second before fading. Always renders above other popups. */
export function spawnMortalText(x: number, y: number): void {
  spawn('MORTAL DAMAGE!', x, y, MORTAL_COLOR, {
    style: 'float',
    riseExtra: 6,
    riseRate: 6, // barely climbs — stays right over the player
    holdFrac: 0.6, // fully opaque the first ~60% of life, then fade
    life: 1700, // ~1.0s solid + ~0.7s fade
    scale: 1.25, // tight; no growth
    top: true,
  });
}

/** Pop a gold loot toast (e.g. "Found Cookie!", "Got $40") off the player. */
export function spawnLootText(x: number, y: number, label: string): void {
  spawn(label, x, y, LEVELUP_COLOR, { style: 'float', riseExtra: 10, life: 1300 });
}

const NOTICE_COLOR = '#ff4d4d'; // red — UI notice (not combat juice, stays fixed)

/** Pop a red notice (e.g. "Your bag is full!") off the player. */
export function spawnNoticeText(x: number, y: number, label: string): void {
  spawn(label, x, y, NOTICE_COLOR, { style: 'float', riseExtra: 10, life: 1300 });
}

interface SpawnOpts {
  riseExtra?: number; // px to start above the default pop height
  style?: PopupStyle; // arc (default) | float | burst
  life?: number; // ms lifetime
  scale?: number; // base render scale
  top?: boolean; // draw above all other popups
  riseRate?: number; // float style: px/s upward drift (defaults to FLOAT_RISE)
  holdFrac?: number; // float style: fraction of life held fully opaque before fading
}

function spawn(text: string, x: number, y: number, color: string, opts: SpawnOpts = {}): void {
  const j = getCombatJuice();
  const { riseExtra = 0, style = 'arc', life = j.lifetime, scale = 1, top = false } = opts;
  const isArc = style === 'arc';
  popups.push({
    text,
    // Float/burst center straight above the entity (no jitter / drift) so the
    // text reads cleanly; arc scatters so stacked hits don't overlap.
    x0: x + (isArc ? (Math.random() * 2 - 1) * j.spawnJitter : 0),
    y0: y - SPAWN_RISE - riseExtra,
    vx: isArc ? (Math.random() * 2 - 1) * j.launchVx : 0,
    color,
    born: now(),
    style,
    life,
    scale,
    top,
    riseRate: opts.riseRate,
    holdFrac: opts.holdFrac,
  });
  if (popups.length > MAX_POPUPS) popups.shift();
}

/** Cull expired popups. Call once per frame. */
export function updateEmitters(): void {
  const t = now();
  for (let i = popups.length - 1; i >= 0; i--) {
    if (t - popups[i].born >= popups[i].life) popups.splice(i, 1);
  }
}

/** Drop every live popup at once. Called on tab-resume so the floating numbers
 *  that piled up while the rAF loop was paused (the WS kept delivering hits) don't
 *  all replay in one burst when rendering comes back. */
export function clearEmitters(): void {
  popups.length = 0;
}

/** Quadratic ease-out (fast then settling) for the burst's rise + scale. */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Linear blend between two "#rrggbb" colors (t: 0 → a, 1 → b). Used for the
 *  big-hit damage color ramp. Returns "#rrggbb"; falls back to `a` on bad input. */
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const k = Math.max(0, Math.min(1, t));
  const mix = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * k);
  return `#${[mix(0), mix(1), mix(2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(s: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Draw all live popups in world space. Call inside the camera/zoom transform.
 *
 *  `inRoom` (optional) gates each popup by the tile its SPAWN ORIGIN sits in: in
 *  interiors, rooms are packed edge-to-edge, and a damage number arcs DOWN under
 *  gravity — so a hit in the room above would otherwise fall across the seam and
 *  render inside this room (the spatial clip can't stop it, the number is now
 *  genuinely over our tiles). Gating on the origin keeps a popup in the room it
 *  was born in. Pass null/undefined in the overworld (no rooms). */
export function renderEmitters(
  ctx: CanvasRenderingContext2D,
  camera: { x: number; y: number },
  inRoom?: (x: number, y: number) => boolean
): void {
  if (popups.length === 0) return;
  const t = now();
  const j = getCombatJuice();

  // Two passes so `top` popups (level-up) always render above everything else,
  // regardless of spawn order.
  for (const pass of [false, true]) {
    for (const p of popups) {
      if (p.top !== pass) continue;
      // Stay in the room we were born in — never fall across a packed seam.
      if (inRoom && !inRoom(p.x0, p.y0)) continue;
      const age = t - p.born;
      const ts = age / 1000; // seconds
      const prog = Math.min(1, age / p.life); // 0..1 over the lifetime

      let worldX = p.x0;
      let worldY: number;
      let alpha: number;
      let scale = p.scale;
      if (p.style === 'burst') {
        // SMAAAASH!: drift up, scale from small to large, and fade out exactly as
        // it reaches its climax (held opaque, then a quick fade over the tail).
        worldY = p.y0 - BURST_RISE * ts;
        const e = easeOut(prog);
        scale = p.scale * (j.critScaleFrom + (j.critScaleTo - j.critScaleFrom) * e);
        alpha = prog < BURST_HOLD ? 1 : Math.max(0, 1 - (prog - BURST_HOLD) / (1 - BURST_HOLD));
      } else if (p.style === 'float') {
        // XP / loot / level-up: drift straight up and fade over the lifetime.
        // riseRate slows the drift (stay near the head); holdFrac keeps it fully
        // opaque for the first part of life before fading (so it lingers, readable).
        worldY = p.y0 - (p.riseRate ?? FLOAT_RISE) * ts;
        const hold = p.holdFrac ?? 0;
        alpha = prog < hold ? 1 : Math.max(0, 1 - (prog - hold) / (1 - hold));
      } else if (p.style === 'heal') {
        // Heal: drift up while swaying side-to-side on a sine curve, fading out.
        worldY = p.y0 - j.healRise * ts;
        worldX = p.x0 + j.healWobbleAmp * Math.sin(2 * Math.PI * j.healWobbleHz * ts);
        alpha = Math.max(0, 1 - prog);
      } else {
        // Ballistic arc: launch up, gravity pulls back down (y grows downward).
        const yOff = -j.launchVy * ts + 0.5 * j.gravity * ts * ts;
        worldX = p.x0 + p.vx * ts;
        worldY = p.y0 + yOff;
        alpha = age > p.life - j.fade ? Math.max(0, 1 - (age - (p.life - j.fade)) / j.fade) : 1;
      }
      if (alpha <= 0) continue;

      // (worldX, worldY) is the popup CENTER; blitTinted scales around it.
      const cx = worldX - camera.x;
      const cy = worldY - camera.y;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      // Never render BELOW native size — nearest-neighbor mangles a 1px-stroke
      // pixel-font glyph at sub-1 scale (a "1" loses its stem).
      blitOutlined(ctx, p.text, cx, cy, p.color, Math.max(1, scale));
      ctx.restore();
    }
  }
}

// Render the bitmap-font `text` recolored to `col` into the mask scratch (the
// glyph pixels carry a baked color; source-atop floods the tint over just them).
// 1px padding all round leaves room for the outline ring.
function renderGlyph(text: string, col: string, w: number, h: number): void {
  mctx.globalCompositeOperation = 'source-over';
  mctx.clearRect(0, 0, w, h);
  mctx.imageSmoothingEnabled = false;
  drawText(mctx, text, 1, 1, FONT);
  mctx.globalCompositeOperation = 'source-atop';
  mctx.fillStyle = col;
  mctx.fillRect(0, 0, w, h);
  mctx.globalCompositeOperation = 'source-over';
}

/**
 * Draw `text` centered on (centerX, centerY) as a colored fill inside a black
 * outline, scaled by `scale`. The outline + fill are composed at SOURCE resolution
 * (black glyph stamped at the 8 surrounding 1px offsets, colored glyph on top),
 * then the whole thing is scaled and blitted ONCE — so the outline is always
 * exactly 1 source-px from the fill and never drifts off it, at any scale.
 */
function blitOutlined(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  color: string,
  scale = 1
): void {
  const w = Math.max(1, measureText(text, FONT) + 2);
  const h = getLineHeight(FONT) + 2;
  maskCanvas.width = w;
  maskCanvas.height = h;
  tintCanvas.width = w;
  tintCanvas.height = h;
  tctx.clearRect(0, 0, w, h);
  tctx.imageSmoothingEnabled = false;
  // Black silhouette ring: one black glyph stamped at every surrounding offset.
  renderGlyph(text, SHADOW_COLOR, w, h);
  for (const [dx, dy] of OUTLINE_OFFSETS) tctx.drawImage(maskCanvas, dx, dy);
  // Colored fill on top, centered.
  renderGlyph(text, color, w, h);
  tctx.drawImage(maskCanvas, 0, 0);
  // Scale-blit the composed glyph once.
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(tintCanvas, Math.round(centerX - dw / 2), Math.round(centerY - dh / 2), dw, dh);
}
