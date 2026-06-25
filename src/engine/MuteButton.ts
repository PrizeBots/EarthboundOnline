import { setAllMuted, toggleAllMuted, isMusicMuted } from './MusicManager';

// Browser-meta UI (not a SNES concept): a DOM overlay button glued to the top-
// right corner of the GAME CANVAS (not the viewport — the canvas is centered
// with letterboxing, so we sync to its bounding rect on resize; this also keeps
// it clear of the viewport-pinned ?netdebug overlay). Lives above the canvas so
// it's clickable in every game phase. Mute state persists in localStorage.
//
// The icon is drawn pixel-art style on a 16x16 canvas and scaled up with
// image-rendering: pixelated so it matches the game's chunky-pixel aesthetic.

const STORAGE_KEY = 'eb_muted';

const ICON_RES = 16; // native pixel grid the icon is drawn on
const ICON_SCALE = 1.5; // 16 * 1.5 = 24px on screen (half the old 48px)
const PANEL_INSET = 8; // gap from the canvas's top/right edges

// Speaker cone: narrow at the body (left), widening to the right. Each entry
// is [x, y, w, h] in the 16x16 grid.
const SPEAKER: [number, number, number, number][] = [
  [2, 6, 2, 4], // magnet/body
  [4, 6, 1, 4],
  [5, 5, 1, 6],
  [6, 4, 1, 8],
  [7, 3, 1, 10], // cone face
];
// Sound waves shown when unmuted.
const WAVES: [number, number, number, number][] = [
  [9, 6, 1, 4],
  [11, 4, 1, 8],
];
// X mark shown when muted (drawn in red).
const MUTE_X: [number, number, number, number][] = [
  [9, 5, 1, 1],
  [10, 6, 1, 1],
  [11, 7, 1, 1],
  [12, 8, 1, 1],
  [12, 5, 1, 1],
  [11, 6, 1, 1],
  [9, 8, 1, 1],
  [10, 7, 1, 1],
];

function drawIcon(ctx: CanvasRenderingContext2D, muted: boolean): void {
  ctx.clearRect(0, 0, ICON_RES, ICON_RES);
  ctx.fillStyle = '#fff';
  for (const [x, y, w, h] of SPEAKER) ctx.fillRect(x, y, w, h);
  if (muted) {
    ctx.fillStyle = '#f44';
    for (const [x, y, w, h] of MUTE_X) ctx.fillRect(x, y, w, h);
  } else {
    for (const [x, y, w, h] of WAVES) ctx.fillRect(x, y, w, h);
  }
}

/** Inject the mute toggle and restore the saved preference. Call once at boot. */
export function initMuteButton(): void {
  // Restore saved state before anything plays (mutes music AND sfx together).
  setAllMuted(localStorage.getItem(STORAGE_KEY) === '1');

  const btn = document.createElement('button');
  btn.id = 'eb-mute';
  Object.assign(btn.style, {
    position: 'fixed',
    zIndex: '1000',
    width: '26px',
    height: '26px',
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    border: '1px solid #fff',
    borderRadius: '0', // blocky, no rounded corners
    background: '#000',
    imageRendering: 'pixelated',
  } satisfies Partial<CSSStyleDeclaration>);

  const canvas = document.createElement('canvas');
  canvas.width = ICON_RES;
  canvas.height = ICON_RES;
  Object.assign(canvas.style, {
    width: `${ICON_RES * ICON_SCALE}px`,
    height: `${ICON_RES * ICON_SCALE}px`,
    imageRendering: 'pixelated',
  } satisfies Partial<CSSStyleDeclaration>);
  const ctx = canvas.getContext('2d')!;

  function render(): void {
    const m = isMusicMuted();
    drawIcon(ctx, m);
    btn.title = m ? 'Unmute sound' : 'Mute sound';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(m));
  }

  btn.addEventListener('click', () => {
    const m = toggleAllMuted();
    localStorage.setItem(STORAGE_KEY, m ? '1' : '0');
    render();
  });

  btn.appendChild(canvas);
  render();
  document.body.appendChild(btn);
  positionToPanel();
  // The canvas re-letterboxes on window resize; keep the button glued to its corner.
  window.addEventListener('resize', positionToPanel);
}

/** Snap the mute button to the top-right corner of the game canvas (viewport
 *  coords), so it tracks the letterboxed canvas instead of the window edge. The
 *  always-on money window lives BELOW the XP bar (not the corner), so the button
 *  simply owns the corner unconditionally. */
function positionToPanel(): void {
  const btn = document.getElementById('eb-mute');
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!btn || !canvas) return;
  // The Renderer sizes the canvas (sets style.width) AFTER this module's boot.
  // Until then getBoundingClientRect is a default 300x150 box sitting mid-screen,
  // which would strand the button in the middle. Skip until the canvas is sized;
  // the Renderer re-calls this from applyBackbuffer once it is.
  if (!canvas.style.width) return;
  const rect = canvas.getBoundingClientRect();
  btn.style.top = `${rect.top + PANEL_INSET}px`;
  btn.style.right = `${window.innerWidth - rect.right + PANEL_INSET}px`;
}

/** Re-anchor the mute button to the canvas corner — the Renderer calls this every
 *  time it (re)sizes the canvas, which is the only thing that moves the corner. */
export function syncMuteButtonPosition(): void {
  positionToPanel();
}

/**
 * Show/hide the mute button (the editor hides it while active, since it mutes
 * the game itself). Restores the button's flex layout when shown.
 */
export function setMuteButtonHidden(hidden: boolean): void {
  const btn = document.getElementById('eb-mute');
  if (btn) {
    btn.style.display = hidden ? 'none' : 'flex';
    if (!hidden) positionToPanel(); // re-sync in case the window resized while hidden
  }
}
