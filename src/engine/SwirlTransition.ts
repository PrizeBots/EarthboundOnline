/**
 * SwirlTransition — EarthBound's battle-swirl used as a screen-wipe mask for
 * event warps. The ROM swirl frames (Swirls/1) are full-screen 256x224, 2-color
 * images that progress from all-white (000) to all-black (022). Drawn over the
 * already-rendered frame with the `multiply` blend, white pixels keep the game
 * and black pixels go to black — so the swirl "eats" the screen to black, then
 * (played in reverse) reveals it again. Faithful to the SNES, and cheap: one
 * blended drawImage per frame, no per-pixel work.
 *
 * ROM-pipeline note: these frames are ROM-derived pixels currently read from the
 * dev staging dir (public/assets/rom_sources, gitignored). For production they
 * must come through the client-side extraction cache like every other asset; the
 * effect degrades gracefully to a plain black fade until the frames are loaded
 * (see Game.transitionStyle), so prod stays correct.
 */
import { loadImage } from './AssetLoader';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

const FRAME_COUNT = 23; // Swirls/1 = 000..022
const BASE = '/assets/rom_sources/Swirls/1/';

let frames: HTMLImageElement[] = [];
let loading = false;
let ready = false;

/** Kick off loading the swirl frames (idempotent). Call when a countdown starts
 *  so they're cached by the time the warp fires. */
export function preloadSwirl(): void {
  if (loading || ready) return;
  loading = true;
  const imgs: (HTMLImageElement | null)[] = new Array(FRAME_COUNT).fill(null);
  let done = 0;
  for (let i = 0; i < FRAME_COUNT; i++) {
    const name = String(i).padStart(3, '0');
    loadImage(`${BASE}${name}.png`)
      .then((img) => {
        imgs[i] = img;
      })
      .catch(() => {
        /* missing frame (e.g. prod, where rom_sources isn't served) */
      })
      .finally(() => {
        if (++done === FRAME_COUNT) {
          loading = false;
          if (imgs.every(Boolean)) {
            frames = imgs as HTMLImageElement[];
            ready = true;
          }
        }
      });
  }
}

/** True once every frame is loaded — gate the swirl on this, else fall back. */
export function swirlReady(): boolean {
  return ready;
}

/**
 * Draw the swirl mask over the current frame for progress `t` in [0,1]:
 * 0 = fully clear (game visible), 1 = fully black. The caller drives `t` the
 * same way it drives a fade alpha (out 0→1, in 1→0), so reversing it replays
 * the swirl as a reveal.
 */
export function drawSwirl(ctx: CanvasRenderingContext2D, t: number): void {
  if (!ready) return;
  const idx = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(t * (FRAME_COUNT - 1))));
  const img = frames[idx];
  if (!img) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  ctx.restore();
}
