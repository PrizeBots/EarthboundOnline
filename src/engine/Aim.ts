/**
 * Mouse aiming + target reticles (combat upgrade, Phase 1).
 *
 * Attacks used to fire in the player's 8-way movement facing. Now the cursor
 * decides: we build a 360° aim vector from the player toward the pointer, snap it
 * to the nearest sprite facing for orientation, and hand the RAW vector to the
 * server (it already resolves the melee box / projectile from a unit vector, so
 * true-angle aim is a drop-in). Two reticles visualize the aim by weapon type:
 *   - melee  → the actual hit box, drawn REACH ahead in the aim direction
 *   - ranged → a crosshair at the cursor (clamped to weapon range) + a trajectory
 *
 * Aim is only "active" when a real mouse is driving it (see Input.isMouseAimActive)
 * — touch / keyboard-only players fall back to movement-facing, so nothing breaks.
 * Stays SNES-honest: the sprite still faces one of 8 ways; only the hit math is
 * continuous.
 */
import { Camera } from './Camera';
import { Direction } from '../types';
import { getPointer, isMouseAimActive } from './Input';

// Facing unit vectors indexed by Direction. MIRRORS server npcSim DIR_VEC and the
// src/types Direction order (S,N,W,E,NW,SW,SE,NE) so the snapped index IS the enum.
const DIAG = Math.SQRT1_2;
const DIR_VEC: [number, number][] = [
  [0, 1], // S
  [0, -1], // N
  [-1, 0], // W
  [1, 0], // E
  [-DIAG, -DIAG], // NW
  [-DIAG, DIAG], // SW
  [DIAG, DIAG], // SE
  [DIAG, -DIAG], // NE
];

// The attack origin is the chest (feet y - 10), matching where the server anchors
// the hitbox/muzzle — used to build the aim vector.
const ATTACK_OY = -10;

/** Nearest 8-way Direction to a vector (max dot product). */
export function snapToDirection(vx: number, vy: number): Direction {
  let best = Direction.S;
  let bestDot = -Infinity;
  for (let i = 0; i < 8; i++) {
    const dot = vx * DIR_VEC[i][0] + vy * DIR_VEC[i][1];
    if (dot > bestDot) {
      bestDot = dot;
      best = i as Direction;
    }
  }
  return best;
}

export interface Aim {
  /** Normalized aim vector from the player toward the cursor. */
  vx: number;
  vy: number;
  /** That vector snapped to the nearest sprite facing. */
  dir: Direction;
  /** True when a live mouse is aiming; false → caller keeps movement-facing. */
  active: boolean;
}

interface AimTarget {
  x: number;
  y: number;
  direction: Direction;
}

/** Cursor position in WORLD pixels (pointer is game-space; add the camera origin;
 *  zoom is 1 in gameplay but divide anyway to stay correct). */
function cursorWorld(camera: Camera): { x: number; y: number } {
  const p = getPointer();
  return { x: camera.x + p.x / camera.zoom, y: camera.y + p.y / camera.zoom };
}

/** Compute the current aim from the live cursor relative to the player. Returns
 *  active:false (and the current facing as the vector) when there's no mouse aim
 *  or the cursor sits on the player — callers then keep movement-facing. */
export function computeAim(camera: Camera, player: AimTarget): Aim {
  const c = cursorWorld(camera);
  const dx = c.x - player.x;
  const dy = c.y - (player.y + ATTACK_OY);
  const len = Math.hypot(dx, dy);
  if (!isMouseAimActive() || len < 1) {
    const v = DIR_VEC[player.direction] ?? DIR_VEC[Direction.S];
    return { vx: v[0], vy: v[1], dir: player.direction, active: false };
  }
  return { vx: dx / len, vy: dy / len, dir: snapToDirection(dx, dy), active: true };
}

/** Draw the target cursor for the equipped weapon (range > 0 = ranged), pinned to
 *  the mouse position so it REPLACES the OS arrow. Small + crisp. Gameplay only
 *  (zoom 1) and only while a mouse is aiming. Returns true if it drew (the caller
 *  then hides the native cursor). Screen space = world - camera. */
export function drawReticle(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  player: AimTarget,
  range: number
): boolean {
  if (camera.zoom !== 1) return false;
  const aim = computeAim(camera, player);
  if (!aim.active) return false;

  const c = cursorWorld(camera);
  const hx = c.x - camera.x; // hit point (cursor) in screen space
  const hy = c.y - camera.y;
  // Three shrinking boxes stepping back from the hit point toward the player along
  // the aim vector — a tapered line that points from the target back to you. aim.v
  // points player→cursor, so SUBTRACT it to walk toward the player. [back px, half].
  const boxes: [number, number][] = [
    [0, 4], // largest, at the hit point
    [9, 2.5], // middle
    [16, 1.5], // smallest, nearest the player
  ];
  const color = range > 0 ? 'rgba(255,70,70,0.95)' : 'rgba(255,255,255,0.95)';

  const drawBoxes = () => {
    for (const [back, half] of boxes) {
      const bx = hx - aim.vx * back;
      const by = hy - aim.vy * back;
      ctx.strokeRect(
        Math.round(bx - half) + 0.5,
        Math.round(by - half) + 0.5,
        Math.round(half * 2),
        Math.round(half * 2)
      );
    }
  };

  ctx.save();
  ctx.lineWidth = 1;
  // 1px dark backing so the cursor stays visible on light tiles; save/restore keeps
  // the renderer's base scale transform (resetting it would fling it to the corner).
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.save();
  ctx.translate(0.6, 0.6);
  drawBoxes();
  ctx.restore();
  ctx.strokeStyle = color;
  drawBoxes();
  ctx.restore();
  return true;
}
