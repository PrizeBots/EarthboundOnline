/**
 * Projectiles — renders the flying shots of ranged weapons (guns, slingshots,
 * beam weapons). VISUAL ONLY: the server (npcSim.stepProjectiles) owns travel,
 * collision, and damage. A `projectile` broadcast spawns the on-screen shot, a
 * `proj_end` broadcast snaps it to its impact point and pops a spark. If the end
 * message is ever dropped, a projectile self-retires once it has flown its full
 * range (`dist`), so nothing can linger forever.
 *
 * Mirrors PsiFx/Emitter: a live array advanced one step per frame (60Hz, same
 * cadence as the server tick). Unlike those flat overlays, shots + sparks are
 * fed into the Renderer's feet-Y sprite pass via `collectProjectileSprites` so
 * they respect layer depth sorting — a building/canopy or a sprite in front of a
 * shot occludes it instead of the shot always painting on top.
 *
 * `look` is the weapon's `projSprite` — a built-in style keyword (no art asset
 * needed yet). Unknown/absent → 'bullet'. Per-weapon PNG art can layer on later
 * by resolving a real image here without touching the call sites.
 */
import { drawPsiFrame } from './PsiFx';

type Look = 'pellet' | 'bullet' | 'beam' | 'psi';
const PSI_FRAME_HOLD = 4; // ticks per flipbook frame (mirror PsiFx FRAME_HOLD)

/** A world-space visual the Renderer can interleave into its Y-sorted sprite
 *  pass. `y` is the depth sort key; `draw` paints camera-relative (rounds the
 *  world position against the same integer camera origin the world pass uses). */
export interface ProjectileSprite {
  x: number;
  y: number;
  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number): void;
}

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
  psiId?: string; // anim id when look==='psi' (the 'psi:<anim>' sprite)
  frame: number; // flipbook frame (psi look)
  hold: number; // ticks the current frame has shown (psi look)
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
  // 'psi:<animId>' → draw the PSI flipbook on the shot (a Fire-cone pellet); any
  // other sprite keyword falls back to the built-in streak looks.
  const isPsi = typeof opts.sprite === 'string' && opts.sprite.startsWith('psi:');
  shots.push({
    id: opts.id,
    x: opts.x,
    y: opts.y,
    vx: opts.vx / len,
    vy: opts.vy / len,
    speed: opts.speed > 0 ? opts.speed : 6,
    traveled: 0,
    maxDist: opts.dist,
    look: isPsi ? 'psi' : asLook(opts.sprite),
    psiId: isPsi ? opts.sprite!.slice(4) : undefined,
    frame: 0,
    hold: 0,
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
      if (s.look === 'psi' && ++s.hold >= PSI_FRAME_HOLD) {
        s.hold = 0;
        s.frame++;
      }
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

/**
 * Hand the Renderer every live shot + impact spark as a depth-sortable sprite
 * (world Y = sort key), pushed onto its job list so they Y-sort and FG-occlude
 * with players/NPCs. Each `draw` sets up + tears down its own ctx state, since
 * the renderer interleaves these with sprite draws (no shared save/restore).
 */
export function collectProjectileSprites(out: ProjectileSprite[]): void {
  for (const s of shots)
    out.push({ x: s.x, y: s.y, draw: (ctx, cx, cy) => drawShot(ctx, s, cx, cy) });
  for (const s of sparks)
    out.push({ x: s.x, y: s.y, draw: (ctx, cx, cy) => drawSpark(ctx, s, cx, cy) });
}

/** Paint one flying shot, camera-relative. */
function drawShot(ctx: CanvasRenderingContext2D, s: Shot, camX: number, camY: number): void {
  const px = Math.round(s.x - camX);
  const py = Math.round(s.y - camY);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.lineCap = 'round';
  if (s.look === 'psi' && s.psiId) {
    // Traveling PSI cone pellet: draw the authored flipbook frame at the shot.
    drawPsiFrame(ctx, s.psiId, s.frame, px, py);
  } else if (s.look === 'pellet') {
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
  ctx.restore();
}

/** Paint one impact spark, camera-relative. */
function drawSpark(ctx: CanvasRenderingContext2D, s: Spark, camX: number, camY: number): void {
  const px = Math.round(s.x - camX);
  const py = Math.round(s.y - camY);
  const t = s.life / SPARK_LIFE;
  const r = (s.big ? 7 : 4) * (1 - t) + 1;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = t;
  ctx.strokeStyle = s.big ? '#fff1b0' : '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.stroke();
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
