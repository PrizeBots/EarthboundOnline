/**
 * The corner level-up icon. Appears (pulsing) once you have banked skill points,
 * with a counter badge that stacks as you level up without spending. Click it to
 * open the spend pentagon (LevelUpModal). Hidden when you have 0 points; it sits
 * below the Start Screen (z-index) so it's covered there.
 *
 * It's `position: fixed` but anchored to the GAME PANEL (the #game canvas), not
 * the window — the canvas is centered with letterboxing, so we sync to its
 * bounding rect on resize instead of pinning to the viewport. It sits centered
 * just below the top-middle XP bar (drawn in logical 256x224 coords).
 */
import { ensureEbFont, ebText, injectEbChrome } from './EbText';
import { SCREEN_HEIGHT } from '../types';
import { XP_BAR_BOTTOM } from './XpBar';

let el: HTMLDivElement | null = null;
let badge: HTMLDivElement | null = null;
let onClick: (() => void) | null = null;

const GAP_BELOW_XP = 16; // screen px below the XP bar (clears the chip's -14px count badge)
// Logical height of the top-center event timer (Game draws it at XP_BAR_BOTTOM+3,
// ~9px tall). When an event is active the chip drops by this much so the two
// top-center elements never overlap.
const EVENT_TIMER_H = 12;
let eventActive = false;

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
  // One reused button for BOTH sources of points — a level-up AND a used stat
  // capsule / Rock candy both bank a point and light this chip. Generic label so
  // it reads right either way.
  el.appendChild(ebText('SKILL', 3, '#1a1430')); // big dark glyphs on the gold chip

  badge = document.createElement('div');
  badge.className = 'eb-lub-badge';
  el.appendChild(badge);

  document.body.appendChild(el);
  positionToPanel();
  // The canvas re-letterboxes on window resize; keep the icon glued to its corner.
  window.addEventListener('resize', positionToPanel);
}

/** Center the icon under the top-middle XP bar (viewport coords). The XP bar is
 *  drawn in logical 256x224 coords, so convert its bottom edge to screen px via
 *  the canvas's displayed height. Horizontal centering rides the CSS transform
 *  (translateX(-50%), baked into the pulse keyframes). */
function positionToPanel(): void {
  if (!el) return;
  const canvas = document.getElementById('game');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const scaleY = rect.height / SCREEN_HEIGHT;
  // Below the XP bar — and below the event timer too, when one is showing.
  const baselineLogical = XP_BAR_BOTTOM + (eventActive ? EVENT_TIMER_H : 0);
  el.style.top = `${rect.top + baselineLogical * scaleY + GAP_BELOW_XP}px`;
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.right = 'auto';
}

/** Tell the button whether the top-center event timer is currently showing, so
 *  it can sit beneath it instead of overlapping. Called each frame by Game; only
 *  repositions on an actual change. */
export function setLevelUpBelowEvent(active: boolean): void {
  if (active === eventActive) return;
  eventActive = active;
  positionToPanel();
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
    transform-origin: top center;
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
    0%, 100% { transform: translateX(-50%) scale(1);    box-shadow: 0 0 0 3px #000, 0 5px 0 rgba(0,0,0,.45), 0 0 12px rgba(255,221,77,.45); }
    50%      { transform: translateX(-50%) scale(1.07); box-shadow: 0 0 0 3px #000, 0 5px 0 rgba(0,0,0,.45), 0 0 22px rgba(255,221,77,.85); }
  }
  `;
  const style = document.createElement('style');
  style.id = 'eb-lub-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
