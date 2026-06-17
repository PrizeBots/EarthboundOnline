/**
 * PsiFx — plays authored PSI effect animations in the world (PsiAnim frames).
 *
 * On a cast, an effect is spawned per its `delivery`:
 *   - 'target' / 'caster' : the flipbook loops a couple of times at that spot,
 *   - 'projectile'        : it travels caster→target, then ends.
 * Frames are the PNG data URLs authored in overrides/psi_anim.json (PsiAnim),
 * rasterized to <img> once and cached. World-space, drawn like the Emitter
 * floats (same camera transform).
 *
 * The cast SITE (MenuManager.usePsi → the castPsiFx hook) supplies the ability id
 * + the caster/target world positions. v1 is LOCAL-only (you see your own casts);
 * a server `psi_cast` broadcast so everyone sees each other's PSI is the follow-up.
 */
import { Camera } from './Camera';
import { loadPsiCatalog } from './PsiCatalog';
import { loadPsiAnims, getPsiAnim, PsiDelivery, PSI_W, PSI_H } from './PsiAnim';

interface Loaded {
  frames: HTMLImageElement[];
  delivery: PsiDelivery;
}
// id -> rasterized frames (null = no authored anim). Built lazily on first cast.
const cache = new Map<string, Loaded | null>();

interface ActiveFx {
  frames: HTMLImageElement[];
  delivery: PsiDelivery;
  x: number; // current effect-center world position
  y: number;
  tx: number; // target (projectile destination)
  ty: number;
  frame: number;
  hold: number; // ticks the current frame has shown
  loops: number; // remaining loops (target/caster); projectile ignores
  done: boolean;
}
let active: ActiveFx[] = [];

const SCALE = 1; // 48px effect drawn at world scale
const FRAME_HOLD = 4; // ticks per frame (~15fps flipbook at 60fps)
const PROJECTILE_SPEED = 4; // px/tick
const TORSO_LIFT = 16; // raise the effect from feet (entity y) to mid-body

/** Load the PSI catalog + authored animations (call once at game start). */
export async function initPsiFx(): Promise<void> {
  await loadPsiCatalog();
  await loadPsiAnims();
  getLoaded('lifeup_alpha'); // warm the cache so the first casts are crisp
  getLoaded('psi_fire_alpha');
}

/** Resolve a cast id (e.g. 'lifeup') to an authored anim id, preferring the
 *  exact id, then its α tier, then any tier of that family. */
function resolveAnimId(id: string): string | null {
  if (getPsiAnim(id)) return id;
  if (getPsiAnim(`${id}_alpha`)) return `${id}_alpha`;
  // any '<id>_<tier>' with frames
  for (const tier of ['beta', 'gamma', 'omega', 'none']) {
    if (getPsiAnim(`${id}_${tier}`)) return `${id}_${tier}`;
  }
  return null;
}

/** Rasterize an anim's data-URL frames to <img> (cached). Null if none authored. */
function getLoaded(id: string): Loaded | null {
  const animId = resolveAnimId(id);
  if (!animId) return null;
  if (cache.has(animId)) return cache.get(animId)!;
  const anim = getPsiAnim(animId)!;
  const frames = anim.frames.map((url) => {
    const img = new Image();
    img.src = url; // decodes async; render guards on img.complete
    return img;
  });
  const loaded: Loaded = { frames, delivery: anim.delivery };
  cache.set(animId, loaded);
  return loaded;
}

/**
 * Spawn a PSI effect. Positions are world-space ENTITY anchors (feet); the effect
 * is lifted to mid-body. For 'target'/'caster' the spot is fixed; 'projectile'
 * starts at the caster and flies to the target.
 */
export function spawnPsiFx(
  id: string,
  casterX: number,
  casterY: number,
  targetX: number,
  targetY: number
): void {
  const L = getLoaded(id);
  if (!L || !L.frames.length) return;
  const onTarget = L.delivery === 'target';
  const startX = onTarget ? targetX : casterX;
  const startY = (onTarget ? targetY : casterY) - TORSO_LIFT;
  active.push({
    frames: L.frames,
    delivery: L.delivery,
    x: startX,
    y: startY,
    tx: targetX,
    ty: targetY - TORSO_LIFT,
    frame: 0,
    hold: 0,
    loops: 2, // target/caster play the flipbook twice
    done: false,
  });
}

/** Advance every active effect one tick (frame timing + projectile travel). */
export function updatePsiFx(): void {
  if (!active.length) return;
  for (const fx of active) {
    if (++fx.hold >= FRAME_HOLD) {
      fx.hold = 0;
      fx.frame++;
      if (fx.frame >= fx.frames.length) {
        fx.frame = 0;
        if (fx.delivery !== 'projectile' && --fx.loops <= 0) fx.done = true;
      }
    }
    if (fx.delivery === 'projectile') {
      const dx = fx.tx - fx.x;
      const dy = fx.ty - fx.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= PROJECTILE_SPEED)
        fx.done = true; // reached the target
      else {
        fx.x += (dx / dist) * PROJECTILE_SPEED;
        fx.y += (dy / dist) * PROJECTILE_SPEED;
      }
    }
  }
  active = active.filter((fx) => !fx.done);
}

/**
 * Draw a PSI's FIRST authored frame as an icon (e.g. a hotbar slot), like a
 * weapon/item sprite. `gameId` is the ability id ('lifeup','fire',…) — resolved
 * to its anim + frame 0. Lazily loads the frames on first call. Returns true if
 * it drew (false while the image is still decoding, or no anim authored — the
 * caller can fall back to a text label).
 */
export function drawPsiIcon(
  ctx: CanvasRenderingContext2D,
  gameId: string,
  x: number,
  y: number,
  size: number
): boolean {
  const L = getLoaded(gameId);
  const img = L && L.frames[0];
  if (!img || !img.complete || img.naturalWidth === 0) return false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, size, size);
  return true;
}

/** Draw active effects in world space (mirror of Emitter — camera-relative). */
export function renderPsiFx(ctx: CanvasRenderingContext2D, camera: Camera): void {
  if (!active.length) return;
  const camX = Math.round(camera.x);
  const camY = Math.round(camera.y);
  const dw = PSI_W * SCALE;
  const dh = PSI_H * SCALE;
  ctx.imageSmoothingEnabled = false;
  for (const fx of active) {
    const img = fx.frames[fx.frame];
    if (!img || !img.complete || img.naturalWidth === 0) continue;
    ctx.drawImage(img, Math.round(fx.x - camX - dw / 2), Math.round(fx.y - camY - dh / 2), dw, dh);
  }
}
