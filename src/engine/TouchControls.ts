// On-screen touch controls for mobile / tablet play.
//
// Philosophy: this overlay does NOT add a parallel input path. It writes into the
// exact same key set the keyboard uses (via Input.setVirtualKey / pressVirtualKey),
// so movement, the menu, dialogue and the hotbar all behave identically whether
// driven by a physical keyboard or a thumb. The only mobile-specific wiring is the
// touch→pointer bridge in Input.ts (canvas taps) for on-canvas UI.
//
// Layout (thumb-reachable, viewport corners — independent of the letterboxed
// canvas so it stays comfortable on any aspect ratio):
//   • Joystick  — bottom-left,  8-way → Arrow keys (also moves the menu cursor)
//   • Attack    — bottom-right, held  → KeyF
//   • Action    — above Attack, tap   → KeyZ (advance/confirm) or KeyE (talk)
//   • Menu      — top-right,    tap   → KeyQ (toggle the menu)
//
// SNES note: a real controller has none of this — these are a browser-only input
// surface, so they live entirely client-side and synthesize the same button codes.

import { setVirtualKey, pressVirtualKey } from './Input';
import { gamepadConnected } from './Gamepad';

/** True on phones/tablets (coarse pointer, no hover) where we want touch controls.
 *  We gate on a coarse primary pointer rather than mere touch capability, so a
 *  laptop with a touchscreen + mouse still gets the desktop experience. */
export function isTouchDevice(): boolean {
  try {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const noHover = window.matchMedia?.('(hover: none)').matches;
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    return !!(hasTouch && (coarse || noHover));
  } catch {
    return 'ontouchstart' in window;
  }
}

// --- Context fed by the game each frame -------------------------------------
type TouchContext = {
  playing: boolean; // in active field play (not char-select / boot)
  menuOpen: boolean;
  dialogueOpen: boolean;
  downed: boolean;
};
let ctx: TouchContext = { playing: false, menuOpen: false, dialogueOpen: false, downed: false };

let root: HTMLDivElement | null = null;
let actionBtn: HTMLDivElement | null = null;
let attackBtn: HTMLDivElement | null = null;
let mounted = false;
// Last-seen gamepad presence, so we re-apply visibility the frame a pad appears
// or disconnects (setTouchContext otherwise only reacts to game-state changes).
let lastGamepad = false;

/** Currently-held joystick arrow keys, so we can release exactly what we set. */
const heldArrows = new Set<string>();
function setArrow(code: string, on: boolean): void {
  if (on === heldArrows.has(code)) return;
  if (on) heldArrows.add(code);
  else heldArrows.delete(code);
  setVirtualKey(code, on);
}
function clearArrows(): void {
  for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) setArrow(code, false);
}

const STYLE = `
#touch-controls {
  position: fixed; inset: 0; z-index: 50;
  pointer-events: none; touch-action: none; user-select: none;
  -webkit-user-select: none; -webkit-touch-callout: none;
  font-family: 'Trebuchet MS', system-ui, sans-serif;
  display: none;
}
#touch-controls.visible { display: block; }
#touch-controls .tc-btn, #touch-controls .tc-stick-base {
  position: absolute; pointer-events: auto; touch-action: none;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-weight: 800; text-shadow: 0 1px 3px rgba(0,0,0,.7);
  border-radius: 50%;
  background: rgba(255,255,255,.10);
  border: 2px solid rgba(255,255,255,.35);
  backdrop-filter: blur(1px);
  transition: background .05s, transform .05s;
}
#touch-controls .tc-btn.pressed { background: rgba(255,216,74,.45); transform: scale(.94); }
/* Joystick — bottom-left */
#touch-controls .tc-stick-base {
  left: calc(env(safe-area-inset-left) + 5vmin);
  bottom: calc(env(safe-area-inset-bottom) + 6vmin);
  width: 34vmin; height: 34vmin; max-width: 180px; max-height: 180px;
  min-width: 110px; min-height: 110px;
}
#touch-controls .tc-stick-knob {
  position: absolute; width: 44%; height: 44%; border-radius: 50%;
  background: rgba(255,255,255,.55); border: 2px solid rgba(255,255,255,.7);
  left: 28%; top: 28%; pointer-events: none;
  transition: transform .03s linear;
}
/* Attack — bottom-right */
#touch-controls .tc-attack {
  right: calc(env(safe-area-inset-right) + 6vmin);
  bottom: calc(env(safe-area-inset-bottom) + 8vmin);
  width: 22vmin; height: 22vmin; max-width: 120px; max-height: 120px;
  min-width: 78px; min-height: 78px; font-size: 4.2vmin;
  background: rgba(220,60,60,.22); border-color: rgba(255,120,120,.5);
}
/* Action / Talk — up-left of attack */
#touch-controls .tc-action {
  right: calc(env(safe-area-inset-right) + 28vmin);
  bottom: calc(env(safe-area-inset-bottom) + 16vmin);
  width: 16vmin; height: 16vmin; max-width: 88px; max-height: 88px;
  min-width: 58px; min-height: 58px; font-size: 3.4vmin;
  background: rgba(90,160,255,.22); border-color: rgba(140,190,255,.5);
}
/* Menu — top-right */
#touch-controls .tc-menu {
  right: calc(env(safe-area-inset-right) + 4vmin);
  top: calc(env(safe-area-inset-top) + 4vmin);
  width: 12vmin; height: 12vmin; max-width: 60px; max-height: 60px;
  min-width: 44px; min-height: 44px; font-size: 4.5vmin;
}
`;

function makeButton(cls: string, label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `tc-btn ${cls}`;
  el.textContent = label;
  root!.appendChild(el);
  return el;
}

/** Wire a momentary (tap) button: pressed visual + fire on down. */
function wireTap(el: HTMLDivElement, onPress: () => void): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('pressed');
    onPress();
  });
  const up = (e: PointerEvent) => {
    el.classList.remove('pressed');
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/** Wire a held button (attack): code is down while a pointer rests on it. */
function wireHold(el: HTMLDivElement, code: string): void {
  let id: number | null = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    id = e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('pressed');
    setVirtualKey(code, true);
  });
  const up = (e: PointerEvent) => {
    if (id !== e.pointerId) return;
    id = null;
    el.classList.remove('pressed');
    setVirtualKey(code, false);
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function wireStick(base: HTMLDivElement, knob: HTMLDivElement): void {
  let id: number | null = null;
  const DEAD = 0.34; // fraction of radius before a direction registers (8-way)

  const update = (clientX: number, clientY: number) => {
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = r.width / 2;
    let nx = (clientX - cx) / radius;
    let ny = (clientY - cy) / radius;
    const mag = Math.hypot(nx, ny);
    if (mag > 1) {
      nx /= mag;
      ny /= mag;
    }
    // Visually clamp the knob to ~70% of the radius for a natural throw.
    knob.style.transform = `translate(${nx * radius * 0.7}px, ${ny * radius * 0.7}px)`;
    // 8-way: each axis independent so diagonals come for free.
    setArrow('ArrowLeft', nx < -DEAD);
    setArrow('ArrowRight', nx > DEAD);
    setArrow('ArrowUp', ny < -DEAD);
    setArrow('ArrowDown', ny > DEAD);
  };
  const reset = () => {
    knob.style.transform = 'translate(0px, 0px)';
    clearArrows();
  };

  base.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    id = e.pointerId;
    base.setPointerCapture?.(e.pointerId);
    update(e.clientX, e.clientY);
  });
  base.addEventListener('pointermove', (e) => {
    if (id !== e.pointerId) return;
    update(e.clientX, e.clientY);
  });
  const end = (e: PointerEvent) => {
    if (id !== e.pointerId) return;
    id = null;
    reset();
    try {
      base.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  base.addEventListener('pointerup', end);
  base.addEventListener('pointercancel', end);
}

/** Build the overlay (once) if this is a touch device. Safe to call repeatedly. */
export function mountTouchControls(): void {
  if (mounted || !isTouchDevice()) return;
  mounted = true;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.id = 'touch-controls';
  document.body.appendChild(root);

  // Joystick
  const base = document.createElement('div');
  base.className = 'tc-stick-base';
  const knob = document.createElement('div');
  knob.className = 'tc-stick-knob';
  base.appendChild(knob);
  root.appendChild(base);
  wireStick(base, knob);

  // Attack (held → KeyF)
  attackBtn = makeButton('tc-attack', '⚔');
  wireHold(attackBtn, 'KeyF');

  // Action / Talk — contextual: confirm/advance (Z) inside a box or menu, else
  // talk/check (E) in the field. One button covers all three so the player never
  // hunts for the right control.
  actionBtn = makeButton('tc-action', '✦');
  wireTap(actionBtn, () => {
    pressVirtualKey(ctx.menuOpen || ctx.dialogueOpen ? 'KeyZ' : 'KeyE');
  });

  // Menu (tap → KeyQ toggles open/closed)
  const menuBtn = makeButton('tc-menu', '☰');
  wireTap(menuBtn, () => pressVirtualKey('KeyQ'));

  applyContext();
}

function applyContext(): void {
  if (!root) return;
  // A physical gamepad (Retroid / Steam Deck / any controller) supersedes the
  // on-screen overlay — hide it once a pad is active so handhelds aren't cluttered
  // with thumb controls they'll never use. Pads only surface after the first
  // button press, so the overlay shows until then, then disappears.
  root.classList.toggle('visible', ctx.playing && !gamepadConnected());
  // Attack is meaningless inside a menu/dialogue — hide it to cut clutter and
  // avoid a stray swing-intent. Joystick + action + menu stay (cursor nav,
  // confirm, close).
  const fieldOnly = ctx.playing && !ctx.menuOpen && !ctx.dialogueOpen && !ctx.downed;
  if (attackBtn) attackBtn.style.display = fieldOnly ? 'flex' : 'none';
  // Action button label hints its current job.
  if (actionBtn) actionBtn.textContent = ctx.menuOpen || ctx.dialogueOpen ? '✓' : '✦';
}

/** Push the current game state in once per frame. Toggles overlay visibility,
 *  hides the attack button in menus, and retargets the action button. If play
 *  isn't active, any held joystick direction is released so the player can't get
 *  stuck walking through a screen transition. */
export function setTouchContext(next: TouchContext): void {
  const gp = gamepadConnected();
  const changed =
    next.playing !== ctx.playing ||
    next.menuOpen !== ctx.menuOpen ||
    next.dialogueOpen !== ctx.dialogueOpen ||
    next.downed !== ctx.downed ||
    gp !== lastGamepad;
  ctx = next;
  lastGamepad = gp;
  if (!next.playing && heldArrows.size) clearArrows();
  if (changed) applyContext();
}
