/**
 * Projectiles — renders the flying shots of ranged weapons (guns, slingshots,
 * beam weapons). VISUAL ONLY: the server (npcSim.stepProjectiles) owns travel,
 * collision, and damage. A `projectile` broadcast spawns the on-screen shot, a
 * `proj_end` broadcast snaps it to its impact point and pops a spark. If the end
 * message is ever dropped, a projectile self-retires once it has flown its full
 * range (`dist`), so nothing can linger forever.
 *
 * Mirrors PsiFx/Emitter: a live array advanced one step per frame (60Hz, same
 * cadence as the server tick) and drawn in world space with the camera transform.
 *
 * `look` is the weapon's `projSprite` — a built-in style keyword (no art asset
 * needed yet). Unknown/absent → 'bullet'. Per-weapon PNG art can layer on later
 * by resolving a real image here without touching the call sites.
 */
import { Camera } from './Camera';

type Look = 'pellet' | 'bullet' | 'beam';

interface Shot {
  id: number;
  x: number;
  y: number;
  vx: number; // unit direction
  vy: number;
  speed: number; // px/tick
  traveled: number;
  maxDist: number;
  look: Look;
  done: boolean;
}

interface Spark {
  x: number;
  y: number;
  life: number; // frames remaining
  big: boolean; // a connecting hit pops a fatter spark than a wall/whiff
}

let shots: Shot[] = [];
let sparks: Spark[] = [];

const SPARK_LIFE = 8; // frames an impact spark shows

function asLook(s: string | null | undefined): Look {
  return s === 'pellet' || s === 'beam' ? s : 'bullet';
}

/** Spawn a flying shot from the server `projectile` broadcast. */
export function spawnProjectile(opts: {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  dist: number;
  sprite?: string | null;
}): void {
  const len = Math.hypot(opts.vx, opts.vy) || 1;
  shots.push({
    id: opts.id,
    x: opts.x,
    y: opts.y,
    vx: opts.vx / len,
    vy: opts.vy / len,
    speed: opts.speed > 0 ? opts.speed : 6,
    traveled: 0,
    maxDist: opts.dist,
    look: asLook(opts.sprite),
    done: false,
  });
}

/** End a shot (server `proj_end`): snap to the real impact point + pop a spark. */
export function endProjectile(id: number, x: number, y: number, hit: boolean): void {
  const s = shots.find((p) => p.id === id);
  if (s) {
    s.x = x;
    s.y = y;
    s.done = true;
  }
  sparks.push({ x, y, life: SPARK_LIFE, big: hit });
}

/** Advance every shot + spark one frame (called once per render frame). */
export function updateProjectiles(): void {
  if (shots.length) {
    for (const s of shots) {
      s.x += s.vx * s.speed;
      s.y += s.vy * s.speed;
      s.traveled += s.speed;
      // Self-retire if the end broadcast never arrived (dropped/late).
      if (s.traveled >= s.maxDist) s.done = true;
    }
    shots = shots.filter((s) => !s.done);
  }
  if (sparks.length) {
    for (const s of sparks) s.life--;
    sparks = sparks.filter((s) => s.life > 0);
  }
}

/** Draw shots + impact sparks in world space (camera-relative, like PsiFx). */
export function renderProjectiles(ctx: CanvasRenderingContext2D, camera: Camera): void {
  if (!shots.length && !sparks.length) return;
  const camX = Math.round(camera.x);
  const camY = Math.round(camera.y);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.lineCap = 'round';
  for (const s of shots) {
    const px = Math.round(s.x - camX);
    const py = Math.round(s.y - camY);
    if (s.look === 'pellet') {
      // Slingshot pellet: a small gray stone with a dark rim.
      ctx.fillStyle = '#3a2f25';
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#cdbfae';
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.look === 'beam') {
      // Energy beam: a long cyan streak with a white-hot core + soft glow.
      drawStreak(ctx, px, py, s.vx, s.vy, 16, 5, 'rgba(120,240,255,0.35)');
      drawStreak(ctx, px, py, s.vx, s.vy, 14, 3, '#3fd9ff');
      drawStreak(ctx, px, py, s.vx, s.vy, 11, 1.4, '#eaffff');
    } else {
      // Bullet/pellet shot: a short yellow tracer with a bright tip.
      drawStreak(ctx, px, py, s.vx, s.vy, 7, 2.6, '#7a5a18');
      drawStreak(ctx, px, py, s.vx, s.vy, 6, 1.4, '#ffe57a');
      ctx.fillStyle = '#fffceb';
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const s of sparks) {
    const px = Math.round(s.x - camX);
    const py = Math.round(s.y - camY);
    const t = s.life / SPARK_LIFE;
    const r = (s.big ? 7 : 4) * (1 - t) + 1;
    ctx.globalAlpha = t;
    ctx.strokeStyle = s.big ? '#fff1b0' : '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A streak centered on (px,py) drawn back along the travel direction. */
function drawStreak(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  vx: number,
  vy: number,
  len: number,
  width: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px - vx * len, py - vy * len);
  ctx.stroke();
}
