/**
 * The corner level-up icon. Appears (pulsing) once you have banked skill points,
 * with a counter badge that stacks as you level up without spending. Click it to
 * open the spend pentagon (LevelUpModal). Hidden when you have 0 points; it sits
 * below the Start Screen (z-index) so it's covered there.
 */
import { ensureEbFont, ebText, injectEbChrome } from './EbText';

let el: HTMLDivElement | null = null;
let badge: HTMLDivElement | null = null;
let onClick: (() => void) | null = null;

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
  el.appendChild(ebText('LV+', 2, '#101018')); // dark glyphs on the yellow chip

  badge = document.createElement('div');
  badge.className = 'eb-lub-badge';
  el.appendChild(badge);

  document.body.appendChild(el);
}

let points = 0;
/** Update the banked-points count; shows the icon when > 0, hides it at 0. */
export function setLevelUpPoints(n: number): void {
  points = n;
  if (!el) return;
  el.style.display = n > 0 ? 'flex' : 'none';
  paintBadge();
}

function paintBadge(): void {
  if (!badge) return;
  badge.innerHTML = '';
  badge.appendChild(ebText(String(points), 1, '#ffffff'));
}

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const css = `
  .eb-lub {
    position: fixed; top: 12px; right: 12px; z-index: 900;
    display: flex; align-items: center;
    background: #f8e85a; border: 2px solid #fff; box-shadow: 0 0 0 2px #000;
    border-radius: 8px; padding: 6px 9px; cursor: pointer;
    animation: eb-lub-pulse 1.2s ease-in-out infinite;
  }
  .eb-lub:hover { filter: brightness(1.12); }
  .eb-lub canvas { image-rendering: pixelated; }
  .eb-lub-badge {
    position: absolute; top: -9px; right: -9px;
    min-width: 18px; height: 18px; padding: 0 3px;
    background: #d02020; border: 2px solid #fff; border-radius: 10px;
    display: flex; align-items: center; justify-content: center; line-height: 0;
  }
  @keyframes eb-lub-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
  `;
  const style = document.createElement('style');
  style.id = 'eb-lub-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
