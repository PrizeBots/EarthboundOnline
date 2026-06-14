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

const FONT = 4;                  // small 8px battle font (matches EB damage text)
const LIFETIME = 850;            // ms a popup lives before vanishing
const FADE = 300;                // ms of fade-out at the end of life
const GRAVITY = 480;             // px/s^2 downward pull on the arc
const LAUNCH_VY = 130;           // px/s initial upward speed
const LAUNCH_VX = 30;            // px/s max random horizontal drift (±)
const FLOAT_RISE = 22;          // px/s straight-up drift for XP / level-up text
const SPAWN_RISE = 18;           // px above the feet the number pops from
const SPAWN_JITTER = 5;          // px random x offset so stacked hits don't overlap

const DAMAGE_COLOR = '#ffffff';
const HEAL_COLOR = '#5cff5c';
const XP_COLOR = '#7fd0ff';       // cyan, matches the EB "you won the battle" EXP text
const LEVELUP_COLOR = '#ffd23d';  // gold
const SHADOW_COLOR = '#000000';

const MAX_POPUPS = 64;           // hard cap; oldest dropped past this

interface Popup {
  text: string;
  x0: number;                    // world origin x (number is centered here)
  y0: number;                    // world origin y
  vx: number;                    // px/s horizontal (0 for float style)
  color: string;
  born: number;                  // performance.now() at spawn
  float: boolean;                // true = rise straight up + fade; false = ballistic arc
  life: number;                  // ms this popup lives
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

/** Pop a green heal number off an entity at world (x, y = feet). */
export function spawnHealNumber(x: number, y: number, amount: number): void {
  spawn(`+${Math.round(amount)}`, x, y, HEAL_COLOR);
}

/** Pop a cyan "+N XP" that floats straight up off the player and fades. */
export function spawnXpNumber(x: number, y: number, amount: number): void {
  spawn(`+${Math.round(amount)} XP`, x, y, XP_COLOR, { float: true, life: 1000 });
}

/** Pop a gold "LEVEL UP!" that floats up off the player — higher + longer than XP. */
export function spawnLevelUp(x: number, y: number): void {
  spawn('LEVEL UP!', x, y, LEVELUP_COLOR, { float: true, riseExtra: 14, life: 1400 });
}

interface SpawnOpts {
  riseExtra?: number; // px to start above the default pop height
  float?: boolean;    // straight rise + fade instead of the ballistic arc
  life?: number;      // ms lifetime
}

function spawn(text: string, x: number, y: number, color: string, opts: SpawnOpts = {}): void {
  const { riseExtra = 0, float = false, life = LIFETIME } = opts;
  popups.push({
    text,
    // Float style centers straight above the entity (no jitter / drift) so the
    // text reads cleanly; arc style scatters so stacked hits don't overlap.
    x0: x + (float ? 0 : (Math.random() * 2 - 1) * SPAWN_JITTER),
    y0: y - SPAWN_RISE - riseExtra,
    vx: float ? 0 : (Math.random() * 2 - 1) * LAUNCH_VX,
    color,
    born: now(),
    float,
    life,
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

/** Draw all live popups in world space. Call inside the camera/zoom transform. */
export function renderEmitters(ctx: CanvasRenderingContext2D, camera: { x: number; y: number }): void {
  if (popups.length === 0) return;
  const t = now();

  for (const p of popups) {
    const age = t - p.born;
    const ts = age / 1000; // seconds

    let worldX: number;
    let worldY: number;
    let alpha: number;
    if (p.float) {
      // XP / level-up: drift straight up and fade continuously over the lifetime.
      worldX = p.x0;
      worldY = p.y0 - FLOAT_RISE * ts;
      alpha = Math.max(0, 1 - age / p.life);
    } else {
      // Ballistic arc: launch up, gravity pulls back down (y grows downward).
      const yOff = -LAUNCH_VY * ts + 0.5 * GRAVITY * ts * ts;
      worldX = p.x0 + p.vx * ts;
      worldY = p.y0 + yOff;
      alpha = age > p.life - FADE ? Math.max(0, 1 - (age - (p.life - FADE)) / FADE) : 1;
    }
    if (alpha <= 0) continue;

    const w = measureText(p.text, FONT);
    const sx = Math.round(worldX - camera.x - w / 2);
    const sy = Math.round(worldY - camera.y);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    blitTinted(ctx, p.text, sx + 1, sy + 1, SHADOW_COLOR); // drop shadow
    blitTinted(ctx, p.text, sx, sy, p.color);              // colored fill
    ctx.restore();
  }
}

/**
 * Draw `text` at (x, y) recolored to `color`. The font sheet pixels carry their
 * own color, so we render glyphs onto an isolated offscreen canvas, flood it
 * with the tint using source-atop (which only touches existing glyph pixels),
 * then blit the result — keeping the tint off the rest of the world.
 */
function blitTinted(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
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
  ctx.drawImage(tintCanvas, x, y);
}
