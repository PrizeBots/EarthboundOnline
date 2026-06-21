/**
 * DeathFx — the "death throw" of a slain combatant (enemy, townsperson, car).
 * When the server reports a kill (`npc_death`), NPCManager hides the live actor
 * and hands its final visual here. We then play a detached, VISUAL-ONLY animation:
 * the body fast-rotates 90° (laying out flat, the same KO flip players get) in the
 * direction it took the killing blow, flies backward away from the attacker, hops
 * a couple times, and RICOCHETS off solid tiles (real collision — it bounces off
 * walls instead of clipping through them). Once it stops bouncing around it sinks
 * straight down past a fixed ground mask — sliding into the floor, not fading out.
 * How far it's flung is proportional to the force of the final hit (`force`).
 *
 * Mirrors Projectiles/Emitter: a live array advanced one step per frame and
 * collected into the Renderer's feet-Y sprite pass (`collectDeathSprites`) so the
 * tumbling body RESPECTS LAYER DEPTH SORTING — it Y-sorts against players/NPCs and
 * a building/canopy in front of it occludes it, instead of painting on top.
 *
 * Nothing here is authoritative: the body is gone from the sim the instant it
 * dies; this is pure cosmetics layered over the hidden slot.
 */
import { Direction, Pose } from '../types';
import { drawSprite, getSpriteGroupMeta } from './SpriteManager';
import { drawHeldItem, isItemBehind } from './Items';
import { checkCollision } from './Collision';

/** A world-space visual the Renderer interleaves into its Y-sorted sprite pass.
 *  `y` is the depth sort key (ground feet-Y); `draw` paints camera-relative. */
export interface DeathSprite {
  x: number;
  y: number;
  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number): void;
}

interface Body {
  // Captured visual (frozen at the moment of death).
  groupId: number;
  direction: Direction;
  frame: number;
  pose: Pose;
  itemId: string | null;
  spriteH: number;
  spriteW: number; // rotated body's vertical extent = the sprite's width
  // World position: x/y is the body's feet on the GROUND; `z` lifts it for the hop.
  x: number;
  y: number;
  z: number;
  vx: number; // horizontal world velocity (px/frame)
  vy: number;
  zVel: number; // vertical hop velocity (px/frame, +up)
  angle: number; // current rotation (rad)
  angTarget: number; // final flat angle (±90°)
  bounces: number; // ground hits so far
  resting: boolean; // came to rest — holding flat, then sinking
  restFrames: number; // frames spent at rest (delays the sink for a beat)
  sink: number; // px the body has descended below the ground mask
  life: number; // frames elapsed (hard cap so nothing lingers)
}

let bodies: Body[] = [];

// --- Tuning (px/frame at the 60Hz render cadence) ---------------------------
const GRAVITY = 0.6; // hop fall accel
const HOP_VEL = 4.2; // initial upward pop
const RESTITUTION = 0.5; // velocity kept per ground (hop) bounce
const STOP_VZ = 1.2; // hop velocity below which we stop bouncing
const GROUND_FRICTION = 0.9; // horizontal slide decay per frame (lower = stops sooner)
const BOUNCE_FRICTION = 0.5; // extra horizontal loss on each ground impact
const WALL_RESTITUTION = 0.5; // horizontal velocity kept when ricocheting off a solid tile
const SETTLE_SPEED = 0.35; // px/frame slide speed below which a grounded body comes to rest
// Corpse collision foot box (half-extents, px) sampled against solid tiles.
const BODY_HW = 5;
const BODY_HH = 4;
const ROT_LERP = 0.3; // how fast the body snaps to its flat angle
const SINK_DELAY = 10; // frames the body lies flat before it starts sinking
const SINK_SPEED = 0.7; // px/frame the body descends into the ground
const LIFE_CAP = 150; // frames — absolute backstop (force the body to rest/sink)
// Backward fling speed from the killing blow's force. Tuned so a ~15-dmg kill is
// a short, punchy knock (~20px) rather than a launch; FLING_MAX caps a crusher.
const FLING_BASE = 0.7;
const FLING_PER_FORCE = 0.1;
const FLING_MAX = 4.5;

/** Spawn a tumbling corpse. (dx,dy) is the unit heading the body flies (away from
 *  the attacker); `force` is the final blow's damage. dx==dy==0 → rotate in place. */
export function spawnDeathBody(opts: {
  x: number;
  y: number;
  groupId: number;
  direction: Direction;
  frame: number;
  pose: Pose;
  itemId: string | null;
  dx: number;
  dy: number;
  force: number;
}): void {
  const speed = Math.min(FLING_MAX, FLING_BASE + Math.max(0, opts.force) * FLING_PER_FORCE);
  // Lay the body flat the way it was knocked: fall toward the travel direction.
  // Sign is cosmetic — pick it from the dominant horizontal heading so a body
  // flung right lays head-right, left lays head-left (vertical/in-place → +90°).
  const angTarget = opts.dx < -0.01 ? -Math.PI / 2 : Math.PI / 2;
  bodies.push({
    groupId: opts.groupId,
    direction: opts.direction,
    frame: opts.frame,
    pose: opts.pose,
    itemId: opts.itemId,
    spriteH: getSpriteGroupMeta(opts.groupId)?.height ?? 24,
    spriteW: getSpriteGroupMeta(opts.groupId)?.width ?? 16,
    x: opts.x,
    y: opts.y,
    z: 0,
    vx: opts.dx * speed,
    vy: opts.dy * speed,
    zVel: HOP_VEL,
    angle: 0,
    angTarget,
    bounces: 0,
    resting: false,
    restFrames: 0,
    sink: 0,
    life: 0,
  });
}

/** True if the corpse's foot box at ground point (x,y) overlaps a solid tile or
 *  the map edge — the wall test that makes a flung body ricochet (checkCollision
 *  is pure world-solid, so it works for any body regardless of the local room). */
function blockedAt(x: number, y: number): boolean {
  return checkCollision(x - BODY_HW, y - BODY_HH, BODY_HW * 2, BODY_HH * 2);
}

/** Advance every dying body one frame (called once per render frame). */
export function updateDeathFx(): void {
  if (!bodies.length) return;
  for (const b of bodies) {
    b.life++;
    // Fast rotate tween toward the flat KO angle.
    b.angle += (b.angTarget - b.angle) * ROT_LERP;
    if (Math.abs(b.angTarget - b.angle) < 0.02) b.angle = b.angTarget;
    // Vertical hop (screen height): rise/fall under gravity, bounce off the floor.
    b.z += b.zVel;
    b.zVel -= GRAVITY;
    let grounded = false;
    if (b.z <= 0) {
      b.z = 0;
      if (b.zVel < -STOP_VZ && b.bounces < 2) {
        b.zVel = -b.zVel * RESTITUTION;
        b.bounces++;
        b.vx *= BOUNCE_FRICTION; // ground impact scrubs the slide
        b.vy *= BOUNCE_FRICTION;
      } else {
        b.zVel = 0;
        grounded = true; // hop is done — now it's just sliding on the floor
      }
    }
    // Horizontal slide on the GROUND PLANE, with real tile collision: move per
    // axis and REFLECT velocity off any solid tile/edge it hits, so a flung body
    // ricochets off walls with physics instead of clipping through them. Friction
    // bleeds it off so it eventually stops bouncing around.
    if (!b.resting) {
      const nx = b.x + b.vx;
      if (blockedAt(nx, b.y)) b.vx = -b.vx * WALL_RESTITUTION;
      else b.x = nx;
      const ny = b.y + b.vy;
      if (blockedAt(b.x, ny)) b.vy = -b.vy * WALL_RESTITUTION;
      else b.y = ny;
      b.vx *= GROUND_FRICTION;
      b.vy *= GROUND_FRICTION;
      // Settle only once it's down (no more hop) AND has nearly stopped sliding —
      // so it keeps ricocheting off walls until it truly comes to rest.
      if (grounded && Math.hypot(b.vx, b.vy) < SETTLE_SPEED) {
        b.vx = 0;
        b.vy = 0;
        b.resting = true;
      }
    }
    // At rest (or the hard-cap backstop): lie flat for a beat, then sink straight
    // down through the ground mask for the final exit (see drawBody) — no fade.
    if (b.resting || b.life > LIFE_CAP) {
      b.resting = true;
      b.restFrames++;
      if (b.restFrames > SINK_DELAY) b.sink += SINK_SPEED;
    }
  }
  // Gone once the whole body has descended past the mask line.
  bodies = bodies.filter((b) => b.sink < b.spriteW + 2);
}

/** Hand every live corpse to the Renderer as a depth-sortable sprite. */
export function collectDeathSprites(out: DeathSprite[]): void {
  for (const b of bodies)
    out.push({ x: b.x, y: b.y, draw: (ctx, cx, cy) => drawBody(ctx, b, cx, cy) });
}

/** Paint one tumbling body: sprite (+ held item) rotated about its mid, lifted by
 *  the hop height while airborne. For its final exit the body sinks straight down
 *  (`sink`) past a FIXED horizontal mask at the resting ground line, so it looks
 *  like it's sliding into the floor instead of fading. Mirrors
 *  Renderer.drawEntityPart's downed flip, but with a tweened angle. */
function drawBody(ctx: CanvasRenderingContext2D, b: Body, camX: number, camY: number): void {
  const sx = Math.round(b.x - camX);
  const restY = Math.round(b.y - camY) - Math.round(b.z); // resting feet (z=0 once landed)
  const feetY = restY + Math.round(b.sink); // descend for the sink exit
  const px = sx;
  const py = feetY - b.spriteH / 2; // rotate about the (sunk) body's vertical midpoint
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  // Ground mask: the flat body's bottom edge at rest. Everything that has sunk
  // below this line is clipped away — the "into the ground" illusion. Fixed at the
  // resting line so the body slides under it (drawn before the rotation transform,
  // so the clip stays a screen-space horizontal band).
  if (b.sink > 0) {
    const maskY = restY - b.spriteH / 2 + b.spriteW / 2;
    ctx.beginPath();
    ctx.rect(sx - 64, maskY - 256, 128, 256);
    ctx.clip();
  }
  ctx.translate(px, py);
  ctx.rotate(b.angle);
  ctx.translate(-px, -py);
  const itemBehind = b.itemId !== null && isItemBehind(b.direction);
  if (b.itemId !== null && itemBehind)
    drawHeldItem(ctx, b.itemId, b.direction, b.frame, b.pose, sx, feetY);
  drawSprite(ctx, b.groupId, b.direction, b.frame, sx, feetY, 'full', b.pose, false);
  if (b.itemId !== null && !itemBehind)
    drawHeldItem(ctx, b.itemId, b.direction, b.frame, b.pose, sx, feetY);
  ctx.restore();
}
