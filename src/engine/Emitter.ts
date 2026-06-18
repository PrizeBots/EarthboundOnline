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

const FONT = 4; // small 8px battle font (matches EB damage text)
const LIFETIME = 850; // ms a popup lives before vanishing
const FADE = 300; // ms of fade-out at the end of life
const GRAVITY = 480; // px/s^2 downward pull on the arc
const LAUNCH_VY = 130; // px/s initial upward speed
const LAUNCH_VX = 30; // px/s max random horizontal drift (±)
const FLOAT_RISE = 22; // px/s straight-up drift for XP / level-up text
const SPAWN_RISE = 18; // px above the feet the number pops from
const SPAWN_JITTER = 5; // px random x offset so stacked hits don't overlap
const BURST_RISE = 26; // px/s upward drift for the SMAAAASH! burst
const BURST_SCALE_FROM = 0.7; // burst starts small...
const BURST_SCALE_TO = 2.0; // ...and climaxes large right as it fades out
const BURST_HOLD = 0.55; // fraction of life fully opaque before the climax fade
const LEVELUP_SCALE = 1.5; // LEVEL UP! renders bigger than other popups

const DAMAGE_COLOR = '#ffffff';
const OWN_DAMAGE_COLOR = '#ff3b3b'; // red — the LOCAL player's OWN damage only
const HEAL_COLOR = '#5cff5c';
const XP_COLOR = '#7fd0ff'; // cyan, matches the EB "you won the battle" EXP text
const LEVELUP_COLOR = '#ffd23d'; // gold
const CRIT_COLOR = '#ff4d4d'; // red — SMAAAASH! crit
const MISS_COLOR = '#b8c0cc'; // dim slate — a whiffed swing
const SHADOW_COLOR = '#000000';

const MAX_POPUPS = 64; // hard cap; oldest dropped past this

// arc   = ballistic launch + gravity + late fade (damage/heal/miss)
// float = drift straight up, centered, fade over life (XP / loot / level-up)
// burst = drift up while scaling up, fades away at its scale climax (SMAAAASH!)
type PopupStyle = 'arc' | 'float' | 'burst';

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
}

const popups: Popup[] = [];

// Offscreen scratch buffer for tinting the bitmap font (its glyphs have a baked
// color; we recolor by compositing source-atop onto an isolated canvas).
const tintCanvas = document.createElement('canvas');
const tctx = tintCanvas.getContext('2d')!;

function now(): number {
  return performance.now();
}

/** Pop a white damage number off an entity at world (x, y = feet). */
export function spawnDamageNumber(x: number, y: number, amount: number): void {
  spawn(String(Math.round(amount)), x, y, DAMAGE_COLOR);
}

/** Pop a RED damage number for the LOCAL player getting hit. Each client renders
 *  its own popups, so only that player sees their own damage in red; everyone
 *  else's hits stay white (spawnDamageNumber). */
export function spawnOwnDamageNumber(x: number, y: number, amount: number): void {
  spawn(String(Math.round(amount)), x, y, OWN_DAMAGE_COLOR);
}

/** Pop a green heal number off an entity at world (x, y = feet). */
export function spawnHealNumber(x: number, y: number, amount: number): void {
  spawn(`+${Math.round(amount)}`, x, y, HEAL_COLOR);
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
  spawn('SMAAAASH!', x, y, CRIT_COLOR, { style: 'burst', riseExtra: 6, life: 1100 });
}

/** Pop a dim "MISS" off a whiffed/dodged swing. */
export function spawnMissText(x: number, y: number): void {
  spawn('MISS', x, y, MISS_COLOR, { life: 750 });
}

/** Pop a gold loot toast (e.g. "Found Cookie!", "Got $40") off the player. */
export function spawnLootText(x: number, y: number, label: string): void {
  spawn(label, x, y, LEVELUP_COLOR, { style: 'float', riseExtra: 10, life: 1300 });
}

/** Pop a red notice (e.g. "Your bag is full!") off the player. */
export function spawnNoticeText(x: number, y: number, label: string): void {
  spawn(label, x, y, CRIT_COLOR, { style: 'float', riseExtra: 10, life: 1300 });
}

interface SpawnOpts {
  riseExtra?: number; // px to start above the default pop height
  style?: PopupStyle; // arc (default) | float | burst
  life?: number; // ms lifetime
  scale?: number; // base render scale
  top?: boolean; // draw above all other popups
}

function spawn(text: string, x: number, y: number, color: string, opts: SpawnOpts = {}): void {
  const { riseExtra = 0, style = 'arc', life = LIFETIME, scale = 1, top = false } = opts;
  const isArc = style === 'arc';
  popups.push({
    text,
    // Float/burst center straight above the entity (no jitter / drift) so the
    // text reads cleanly; arc scatters so stacked hits don't overlap.
    x0: x + (isArc ? (Math.random() * 2 - 1) * SPAWN_JITTER : 0),
    y0: y - SPAWN_RISE - riseExtra,
    vx: isArc ? (Math.random() * 2 - 1) * LAUNCH_VX : 0,
    color,
    born: now(),
    style,
    life,
    scale,
    top,
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

/** Quadratic ease-out (fast then settling) for the burst's rise + scale. */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Draw all live popups in world space. Call inside the camera/zoom transform. */
export function renderEmitters(
  ctx: CanvasRenderingContext2D,
  camera: { x: number; y: number }
): void {
  if (popups.length === 0) return;
  const t = now();

  // Two passes so `top` popups (level-up) always render above everything else,
  // regardless of spawn order.
  for (const pass of [false, true]) {
    for (const p of popups) {
      if (p.top !== pass) continue;
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
        scale = p.scale * (BURST_SCALE_FROM + (BURST_SCALE_TO - BURST_SCALE_FROM) * e);
        alpha = prog < BURST_HOLD ? 1 : Math.max(0, 1 - (prog - BURST_HOLD) / (1 - BURST_HOLD));
      } else if (p.style === 'float') {
        // XP / loot / level-up: drift straight up and fade over the lifetime.
        worldY = p.y0 - FLOAT_RISE * ts;
        alpha = Math.max(0, 1 - prog);
      } else {
        // Ballistic arc: launch up, gravity pulls back down (y grows downward).
        const yOff = -LAUNCH_VY * ts + 0.5 * GRAVITY * ts * ts;
        worldX = p.x0 + p.vx * ts;
        worldY = p.y0 + yOff;
        alpha = age > p.life - FADE ? Math.max(0, 1 - (age - (p.life - FADE)) / FADE) : 1;
      }
      if (alpha <= 0) continue;

      // (worldX, worldY) is the popup CENTER; blitTinted scales around it.
      const cx = worldX - camera.x;
      const cy = worldY - camera.y;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      blitTinted(ctx, p.text, cx + scale, cy + scale, SHADOW_COLOR, scale); // drop shadow
      blitTinted(ctx, p.text, cx, cy, p.color, scale); // colored fill
      ctx.restore();
    }
  }
}

/**
 * Draw `text` centered on (centerX, centerY), recolored to `color` and scaled by
 * `scale`. The font sheet pixels carry their own color, so we render glyphs onto
 * an isolated offscreen canvas, flood it with the tint using source-atop (which
 * only touches existing glyph pixels), then blit the result scaled — keeping the
 * tint off the rest of the world and the pixels crisp (no smoothing).
 */
function blitTinted(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  color: string,
  scale = 1
): void {
  const w = Math.max(1, measureText(text, FONT) + 2);
  const h = getLineHeight(FONT) + 2;
  tintCanvas.width = w;
  tintCanvas.height = h;
  tctx.clearRect(0, 0, w, h);
  tctx.imageSmoothingEnabled = false;
  drawText(tctx, text, 1, 1, FONT);
  tctx.globalCompositeOperation = 'source-atop';
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, w, h);
  tctx.globalCompositeOperation = 'source-over';
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(tintCanvas, Math.round(centerX - dw / 2), Math.round(centerY - dh / 2), dw, dh);
}
