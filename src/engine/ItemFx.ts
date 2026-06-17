/**
 * ItemFx — plays an item's authored "use" animation in the world when a player
 * consumes it (a Cookie's bite-by-bite chomp, a drink draining, etc.).
 *
 * The frames are the same 16x16 held-item art the engine already renders
 * (Items.renderItemArt, frames 0→1→2 — see tools/author_item_sprites.py's eat/
 * drink/use animations). On a use we flip through them once, lifted above the
 * player's head, drawn world-space like the Emitter floats / PsiFx.
 *
 * Networked: the local caster spawns it optimistically (MenuManager.useConsumable
 * → the itemUseFx hook); the server broadcasts `item_use` to everyone else, who
 * spawn it on the remote player (Game.onItemUse). So all players see each use.
 */
import { Camera } from './Camera';
import { renderItemArt, ITEM_FRAMES } from './Items';

const SCALE = 1; // draw 16px art at its true size (matches the held-item sprite)
const FRAME_HOLD = 9; // ticks per frame (~6–7fps so the chomp/drain reads)
const LIFT = 20; // px above the entity's feet (y) → over the head

interface ActiveFx {
  frames: (HTMLCanvasElement | null)[];
  x: number;
  y: number;
  frame: number;
  hold: number;
  done: boolean;
}
let active: ActiveFx[] = [];

/** Spawn an item-use effect at an entity anchor (feet world coords). Plays the
 *  item's 3 authored frames once, above the head. No-op if the item has no art. */
export function spawnItemFx(itemId: string, x: number, y: number): void {
  const frames: (HTMLCanvasElement | null)[] = [];
  for (let f = 0; f < ITEM_FRAMES; f++) frames.push(renderItemArt(itemId, f));
  if (!frames.some(Boolean)) return; // unknown / artless item
  active.push({ frames, x, y: y - LIFT, frame: 0, hold: 0, done: false });
}

/** Advance every active effect one tick; ends after one pass through the frames. */
export function updateItemFx(): void {
  if (!active.length) return;
  for (const fx of active) {
    if (++fx.hold >= FRAME_HOLD) {
      fx.hold = 0;
      fx.frame++;
      if (fx.frame >= fx.frames.length) fx.done = true; // played through → end
    }
  }
  active = active.filter((fx) => !fx.done);
}

/** Draw active item-use effects in world space (camera-relative, like PsiFx). */
export function renderItemFx(ctx: CanvasRenderingContext2D, camera: Camera): void {
  if (!active.length) return;
  const camX = Math.round(camera.x);
  const camY = Math.round(camera.y);
  ctx.imageSmoothingEnabled = false;
  for (const fx of active) {
    const c = fx.frames[Math.min(fx.frame, fx.frames.length - 1)];
    if (!c) continue;
    const dw = c.width * SCALE;
    const dh = c.height * SCALE;
    ctx.drawImage(c, Math.round(fx.x - camX - dw / 2), Math.round(fx.y - camY - dh / 2), dw, dh);
  }
}
