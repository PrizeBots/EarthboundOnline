/**
 * KoThrow — the player KO "death throw". When a player takes their downing blow
 * they shouldn't just snap flat in place; they get flung back from the hit and
 * tumble into the laying pose, the same rotate + bounce + wall-ricochet physics a
 * slain NPC gets (DeathFx) — only WITHOUT the sink, since a downed player stays in
 * the world (revivable) for the 30s window.
 *
 * Pure-visual + deterministic: the state rides on the Player/RemotePlayer as a
 * render OFFSET (`offX/offY`, hop `z`, rotation `angle`); the authoritative
 * position never moves. It's seeded from the server `player_downed` dir/force, so
 * every client computes the identical throw for that player. The Renderer draws
 * the downed body (and its countdown/vignette) at this offset; once it settles the
 * body simply rests at `offX/offY` until revive/standup clears the state.
 */
import { KoThrowState } from '../types';
import { checkCollision } from './Collision';

// Body that can carry a throw — both Player (class) and RemotePlayer (interface).
interface KoBody {
  x: number;
  y: number;
  koThrow?: KoThrowState;
}

// --- Tuning (px/frame at 60Hz) — mirrors DeathFx so NPC + player throws match ---
const GRAVITY = 0.6;
const HOP_VEL = 4.2;
const RESTITUTION = 0.5; // hop bounce
const STOP_VZ = 1.2;
const GROUND_FRICTION = 0.9;
const BOUNCE_FRICTION = 0.5;
const WALL_RESTITUTION = 0.5; // ricochet off a solid tile
const SETTLE_SPEED = 0.35; // slide speed below which a grounded body rests
const ROT_LERP = 0.3;
const BODY_HW = 5;
const BODY_HH = 4;
// Backward fling from the killing blow's force (matches DeathFx tuning).
const FLING_BASE = 0.7;
const FLING_PER_FORCE = 0.1;
const FLING_MAX = 4.5;

function blockedAt(x: number, y: number): boolean {
  return checkCollision(x - BODY_HW, y - BODY_HH, BODY_HW * 2, BODY_HH * 2);
}

/** Seed a KO throw on `e`, flung along unit (dx,dy) by `force`. dx==dy==0 (e.g. a
 *  poison death) → rotate in place with just a small hop. */
export function spawnKoThrow(e: KoBody, dx: number, dy: number, force: number): void {
  const speed = Math.min(FLING_MAX, FLING_BASE + Math.max(0, force) * FLING_PER_FORCE);
  e.koThrow = {
    angle: 0,
    // Lay the head toward the travel direction (sign cosmetic; default +90°).
    angTarget: dx < -0.01 ? -Math.PI / 2 : Math.PI / 2,
    offX: 0,
    offY: 0,
    z: 0,
    vx: dx * speed,
    vy: dy * speed,
    zVel: HOP_VEL,
    bounces: 0,
    resting: false,
  };
}

/** Advance one frame. No-op once the throw has settled (offsets frozen) or absent. */
export function advanceKoThrow(e: KoBody): void {
  const k = e.koThrow;
  if (!k || k.resting) return;
  // Fast rotate tween toward the flat KO angle.
  k.angle += (k.angTarget - k.angle) * ROT_LERP;
  if (Math.abs(k.angTarget - k.angle) < 0.02) k.angle = k.angTarget;
  // Vertical hop.
  k.z += k.zVel;
  k.zVel -= GRAVITY;
  let grounded = false;
  if (k.z <= 0) {
    k.z = 0;
    if (k.zVel < -STOP_VZ && k.bounces < 2) {
      k.zVel = -k.zVel * RESTITUTION;
      k.bounces++;
      k.vx *= BOUNCE_FRICTION;
      k.vy *= BOUNCE_FRICTION;
    } else {
      k.zVel = 0;
      grounded = true;
    }
  }
  // Horizontal slide as a render offset, ricocheting off solid tiles around the
  // body's true (offset) world position — same wall physics as DeathFx.
  const nx = k.offX + k.vx;
  if (blockedAt(e.x + nx, e.y + k.offY)) k.vx = -k.vx * WALL_RESTITUTION;
  else k.offX = nx;
  const ny = k.offY + k.vy;
  if (blockedAt(e.x + k.offX, e.y + ny)) k.vy = -k.vy * WALL_RESTITUTION;
  else k.offY = ny;
  k.vx *= GROUND_FRICTION;
  k.vy *= GROUND_FRICTION;
  // Rest once it's down and has nearly stopped — the body then lies at offX/offY.
  if (grounded && Math.hypot(k.vx, k.vy) < SETTLE_SPEED) {
    k.vx = 0;
    k.vy = 0;
    k.resting = true;
  }
}

/** Drop the throw (revive / stand-up / respawn): body returns to its base spot. */
export function clearKoThrow(e: KoBody): void {
  e.koThrow = undefined;
}
