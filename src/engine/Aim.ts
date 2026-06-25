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
import { getCrosshairColor, getCrosshairType, getCursorScale } from './Settings';

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

/** Unit facing vector for a Direction (mirror of the server PSI_DIR / DIR_VEC). */
export function dirToVector(dir: Direction): { vx: number; vy: number } {
  const v = DIR_VEC[dir] ?? DIR_VEC[Direction.S];
  return { vx: v[0], vy: v[1] };
}

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

/** Aim from the player toward an explicit SCREEN point (game-space px, e.g. a
 *  touch tap) instead of the live cursor — mobile tap-to-attack. Returns the unit
 *  vector + snapped facing; always "aimed" (the caller only calls it on a real
 *  tap). Mirrors computeAim's chest-origin + world conversion so a tap and a mouse
 *  click at the same spot produce the identical swing. */
export function aimFromScreen(
  camera: Camera,
  player: AimTarget,
  screenX: number,
  screenY: number
): { vx: number; vy: number; dir: Direction } {
  const wx = camera.x + screenX / camera.zoom;
  const wy = camera.y + screenY / camera.zoom;
  const dx = wx - player.x;
  const dy = wy - (player.y + ATTACK_OY);
  const len = Math.hypot(dx, dy) || 1;
  return { vx: dx / len, vy: dy / len, dir: snapToDirection(dx, dy) };
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

// Pointing-glove UI cursor (our own pixel art — NOT ROM-derived). EB-flavored: a
// white glove with a dark outline, soft right-edge shading for volume, and a gold
// wrist cuff. It's the POINTER for menus/UI (a CSS cursor, below) — combat uses the
// reticle instead. Char → color via GLOVE_PALETTE: ' ' transparent, 'o' outline,
// 'w' white, 's' shadow, 'c' cuff. The fingertip (hotspot) is at GLOVE_HOT so it
// lands on the click.
const GLOVE = [
  '   oo        ',
  '  owwo       ',
  '  owso       ',
  '  owso       ',
  '  owso       ',
  '  owso       ',
  '  owwoooo    ',
  '  owwwwwso   ',
  ' oowwwwwso   ',
  'owwwwwwwso   ',
  'owwwwwwsso   ',
  ' owwwwwsso   ',
  ' owwwwwso    ',
  ' occcccco    ',
  ' occcccco    ',
  '  oooooo     ',
];
const GLOVE_PALETTE: Record<string, string> = {
  o: '#14100c', // outline
  w: '#f8f8f8', // white fill
  s: '#bcb8b0', // shadow (right-edge volume)
  c: '#e4aa3c', // gold wrist cuff
};
const GLOVE_HOT_X = 4; // fingertip column
const GLOVE_HOT_Y = 0;

// Built data-URL cursors cached per upscale factor (the player picks the size in
// Settings → Cursor Size). 13×16 art at 2×/3×/4× = 26×32 / 39×48 / 52×64, all well
// within the 128px cursor cap modern browsers (Chrome/Firefox/Safari) honor.
const gloveCursorCache = new Map<number, string>();

/** The glove as a ready-to-use CSS `cursor` value, sized to the player's Cursor
 *  Size setting (built once per size, then cached). Use as the pointer for UI/menus
 *  so it sits over buttons and every layer, while combat hides it for the reticle.
 *  Returns 'auto' if the canvas isn't available (e.g. SSR/tests). Mouse-only —
 *  touch devices never request it. */
export function gloveCursor(): string {
  const scale = getCursorScale();
  const cached = gloveCursorCache.get(scale);
  if (cached) return cached;
  const w = Math.max(...GLOVE.map((r) => r.length));
  const cv = document.createElement('canvas');
  cv.width = w * scale;
  cv.height = GLOVE.length * scale;
  const g = cv.getContext('2d');
  if (!g) return 'auto';
  for (let r = 0; r < GLOVE.length; r++) {
    const row = GLOVE[r];
    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const color = GLOVE_PALETTE[row[cIdx]];
      if (!color) continue; // ' ' (or any unmapped char) = transparent
      g.fillStyle = color;
      g.fillRect(cIdx * scale, r * scale, scale, scale);
    }
  }
  const css = `url(${cv.toDataURL('image/png')}) ${GLOVE_HOT_X * scale} ${
    GLOVE_HOT_Y * scale
  }, auto`;
  gloveCursorCache.set(scale, css);
  return css;
}

/** Draw a crosshair of `type` (0 Cross / 1 Dot / 2 Scope) in `color`, centered on
 *  the integer pixel (cx,cy). Shared by the in-world cursor AND the Settings preview
 *  so they always match. A contrasting 1px backing keeps it readable on any tile. */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  type: number,
  color: string
): void {
  const sx = cx + 0.5;
  const sy = cy + 0.5;
  const TAU = Math.PI * 2;

  // Both passes (backing + color) paint the same shape; the caller sets the style.
  const paint = () => {
    ctx.beginPath();
    if (type === 1) {
      // Dot: a ring with a filled center dot (centered on the exact pixel).
      ctx.arc(sx, sy, 3, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4, 0, TAU);
      ctx.fill();
    } else if (type === 2) {
      // Scope: ring + 4 outer ticks + a single filled center dot.
      const r = 4;
      const tick = 3;
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.moveTo(sx - r - tick, sy);
      ctx.lineTo(sx - r, sy);
      ctx.moveTo(sx + r, sy);
      ctx.lineTo(sx + r + tick, sy);
      ctx.moveTo(sx, sy - r - tick);
      ctx.lineTo(sx, sy - r);
      ctx.moveTo(sx, sy + r);
      ctx.lineTo(sx, sy + r + tick);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4, 0, TAU);
      ctx.fill();
    } else {
      // Cross (default): 4 arms with a center gap.
      const ARM = 7;
      const GAP = 2;
      ctx.moveTo(sx - ARM, sy);
      ctx.lineTo(sx - GAP, sy);
      ctx.moveTo(sx + GAP, sy);
      ctx.lineTo(sx + ARM, sy);
      ctx.moveTo(sx, sy - ARM);
      ctx.lineTo(sx, sy - GAP);
      ctx.moveTo(sx, sy + GAP);
      ctx.lineTo(sx, sy + ARM);
      ctx.stroke();
    }
  };

  const backing = color === '#000000' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = backing;
  ctx.fillStyle = backing;
  ctx.save();
  ctx.translate(0.6, 0.6);
  paint();
  ctx.restore();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  paint();
  ctx.restore();
}

/** Draw the aim cursor at the mouse, replacing the OS arrow. Color + style come
 *  from Settings (Crosshair Color / Style). Gameplay only (zoom 1) and only while a
 *  mouse is aiming. Returns true if it drew. Screen space = world - camera. */
export function drawReticle(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  player: AimTarget
): boolean {
  if (camera.zoom !== 1) return false;
  const aim = computeAim(camera, player);
  if (!aim.active) return false;
  const c = cursorWorld(camera);
  drawCrosshair(
    ctx,
    Math.round(c.x - camera.x),
    Math.round(c.y - camera.y),
    getCrosshairType(),
    getCrosshairColor()
  );
  return true;
}
