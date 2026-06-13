import { setMusicMuted, toggleMusicMuted, isMusicMuted } from './MusicManager';

// Browser-meta UI (not a SNES concept): a DOM overlay button in the top-right
// corner. Lives above the canvas so it's clickable in every game phase and
// needs no canvas click-coordinate math. Mute state persists in localStorage.
//
// The icon is drawn pixel-art style on a 16x16 canvas and scaled up with
// image-rendering: pixelated so it matches the game's chunky-pixel aesthetic.

const STORAGE_KEY = 'eb_muted';

const ICON_RES = 16; // native pixel grid the icon is drawn on
const ICON_SCALE = 3; // 16 * 3 = 48px on screen

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
  [9, 5, 1, 1], [10, 6, 1, 1], [11, 7, 1, 1], [12, 8, 1, 1],
  [12, 5, 1, 1], [11, 6, 1, 1], [9, 8, 1, 1], [10, 7, 1, 1],
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
  // Restore saved state before anything plays.
  setMusicMuted(localStorage.getItem(STORAGE_KEY) === '1');

  const btn = document.createElement('button');
  btn.id = 'eb-mute';
  Object.assign(btn.style, {
    position: 'fixed',
    top: '10px',
    right: '10px',
    zIndex: '1000',
    width: '52px',
    height: '52px',
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    border: '2px solid #fff',
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
    btn.title = m ? 'Unmute music' : 'Mute music';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(m));
  }

  btn.addEventListener('click', () => {
    const m = toggleMusicMuted();
    localStorage.setItem(STORAGE_KEY, m ? '1' : '0');
    render();
  });

  btn.appendChild(canvas);
  render();
  document.body.appendChild(btn);
}
