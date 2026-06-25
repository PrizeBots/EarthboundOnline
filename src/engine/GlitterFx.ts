/**
 * GlitterFx — a burst of golden sparkles around a player. A cosmetic nod to the
 * EarthBound "Rock Candy + Sugar packet" recipe of the '90s: when a player uses a
 * Rock candy while carrying a Sugar packet, the server broadcasts a `glitter` so
 * EVERYONE sees the sparkle (no dupe, no stat change — pure flair).
 *
 * Procedural (no authored art): a handful of 4-point sparkle stars rise + twinkle
 * and fade over ~1s. Drawn world-space, camera-relative, like ItemFx / the Emitter
 * floats. Networked via Game.onGlitter → spawnGlitterFx (everyone, incl. the user).
 *
 * SNES-portable: a fixed pool of sprite "stars" with per-particle velocity + life
 * is exactly what an OAM-driven native build would push for a one-shot effect.
 */
import { Camera } from './Camera';

const COUNT = 12; // sparkles per burst
const LIFE = 60; // ticks a sparkle lives (~1s at 60fps)
const SPREAD = 18; // px radius the sparkles spawn within (around the torso)
const RISE = 0.35; // px/tick upward drift
const LIFT = 16; // spawn height above the feet (torso)
const COLORS = ['#fff7b0', '#ffe14d', '#ffd024', '#ffffff'];

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  phase: number; // twinkle offset so they don't pulse in lockstep
}
let sparks: Spark[] = [];

// Deterministic-enough jitter without Math.random gymnastics; varied per spawn by
// the index + the spawn coords so two bursts don't look identical.
function rand(seed: number): number {
  const s = Math.sin(seed) * 43758.5453;
  return s - Math.floor(s);
}

/** Emit one glitter burst centered on an entity anchor (feet world coords). */
export function spawnGlitterFx(x: number, y: number): void {
  const base = x * 13.7 + y * 7.3;
  for (let i = 0; i < COUNT; i++) {
    const a = rand(base + i) * Math.PI * 2;
    const r = rand(base + i * 2.1) * SPREAD;
    sparks.push({
      x: x + Math.cos(a) * r,
      y: y - LIFT + Math.sin(a) * r * 0.6,
      vx: Math.cos(a) * 0.15,
      vy: -RISE - rand(base + i * 3.3) * 0.3,
      life: LIFE,
      max: LIFE,
      size: 2 + Math.round(rand(base + i * 5.7) * 2),
      color: COLORS[i % COLORS.length],
      phase: rand(base + i * 9.1) * Math.PI * 2,
    });
  }
}

/** Advance every sparkle one tick; cull the dead. */
export function updateGlitterFx(): void {
  if (!sparks.length) return;
  for (const s of sparks) {
    s.x += s.vx;
    s.y += s.vy;
    s.life--;
  }
  sparks = sparks.filter((s) => s.life > 0);
}

/** Draw a 4-point sparkle star (a plus + diagonal accents) at screen coords. */
function drawSpark(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  size: number,
  alpha: number,
  color: string
): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  // vertical + horizontal bars (the classic twinkle)
  ctx.fillRect(sx - 0.5, sy - size, 1, size * 2);
  ctx.fillRect(sx - size, sy - 0.5, size * 2, 1);
  // soft center
  ctx.fillRect(sx - 1, sy - 1, 2, 2);
  ctx.globalAlpha = 1;
}

/** Render active glitter in world space (camera-relative, like ItemFx). */
export function renderGlitterFx(ctx: CanvasRenderingContext2D, camera: Camera): void {
  if (!sparks.length) return;
  const camX = Math.round(camera.x);
  const camY = Math.round(camera.y);
  ctx.imageSmoothingEnabled = false;
  for (const s of sparks) {
    const t = s.life / s.max;
    // twinkle: size pulses; fade out over the last third of life
    const tw = 0.6 + 0.4 * Math.abs(Math.sin(s.phase + (1 - t) * 8));
    const alpha = Math.min(1, t * 3) * tw; // quick out-fade
    drawSpark(ctx, Math.round(s.x - camX), Math.round(s.y - camY), s.size * tw, alpha, s.color);
  }
}
