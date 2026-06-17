/**
 * The corner level-up icon. Appears (pulsing) once you have banked skill points,
 * with a counter badge that stacks as you level up without spending. Click it to
 * open the spend pentagon (LevelUpModal). Hidden when you have 0 points; it sits
 * below the Start Screen (z-index) so it's covered there.
 *
 * It's `position: fixed` but anchored to the top-right corner of the GAME PANEL
 * (the #game canvas), not the window — the canvas is centered with letterboxing,
 * so we sync to its bounding rect on resize instead of pinning to the viewport.
 */
import { ensureEbFont, ebText, injectEbChrome } from './EbText';

let el: HTMLDivElement | null = null;
let badge: HTMLDivElement | null = null;
let onClick: (() => void) | null = null;

const PANEL_INSET = 12; // gap from the canvas's top/right edges

/** Build the (hidden) icon once and set its click handler. */
export function initLevelUpButton(handler: () => void): void {
  onClick = handler;
  if (el) return;
  injectEbChrome();
  injectStyles();
  void ensureEbFont().then(() => paintBadge());

  el = document.createElement('div');
  el.className = 'eb-lub';
  el.style.display = 'none';
  el.title = 'Spend skill points';
  el.addEventListener('click', () => onClick?.());
  el.appendChild(ebText('LV UP', 3, '#1a1430')); // big dark glyphs on the gold chip

  badge = document.createElement('div');
  badge.className = 'eb-lub-badge';
  el.appendChild(badge);

  document.body.appendChild(el);
  positionToPanel();
  // The canvas re-letterboxes on window resize; keep the icon glued to its corner.
  window.addEventListener('resize', positionToPanel);
}

/** Snap the icon to the top-right corner of the game canvas (viewport coords). */
function positionToPanel(): void {
  if (!el) return;
  const canvas = document.getElementById('game');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  el.style.top = `${rect.top + PANEL_INSET}px`;
  el.style.right = `${window.innerWidth - rect.right + PANEL_INSET}px`;
}

let points = 0;
/** Update the banked-points count; shows the icon when > 0, hides it at 0. */
export function setLevelUpPoints(n: number): void {
  points = n;
  if (!el) return;
  el.style.display = n > 0 ? 'flex' : 'none';
  if (n > 0) positionToPanel(); // re-sync in case the window resized while hidden
  paintBadge();
}

function paintBadge(): void {
  if (!badge) return;
  badge.innerHTML = '';
  badge.appendChild(ebText(String(points), 2, '#ffffff'));
}

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const css = `
  /* Chunky EarthBound battle-UI chip: golden gradient, fat white border, hard
     black outline + drop shadow, and a soft gold glow that breathes. */
  .eb-lub {
    position: fixed; z-index: 900;
    display: flex; align-items: center;
    background: linear-gradient(#ffef6b, #f3c012);
    border: 3px solid #fff; border-radius: 12px;
    box-shadow: 0 0 0 3px #000, 0 5px 0 rgba(0,0,0,.45), 0 0 16px rgba(255,221,77,.6);
    padding: 9px 16px; cursor: pointer;
    transform-origin: top right;
    animation: eb-lub-pulse 1.1s ease-in-out infinite;
  }
  .eb-lub:hover { filter: brightness(1.1); }
  .eb-lub canvas { image-rendering: pixelated; }
  .eb-lub-badge {
    position: absolute; top: -14px; right: -14px;
    min-width: 30px; height: 30px; padding: 0 6px;
    background: #e02424; border: 3px solid #fff; border-radius: 16px;
    box-shadow: 0 0 0 2px #000;
    display: flex; align-items: center; justify-content: center; line-height: 0;
  }
  @keyframes eb-lub-pulse {
    0%, 100% { transform: scale(1);    box-shadow: 0 0 0 3px #000, 0 5px 0 rgba(0,0,0,.45), 0 0 12px rgba(255,221,77,.45); }
    50%      { transform: scale(1.07); box-shadow: 0 0 0 3px #000, 0 5px 0 rgba(0,0,0,.45), 0 0 22px rgba(255,221,77,.85); }
  }
  `;
  const style = document.createElement('style');
  style.id = 'eb-lub-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
