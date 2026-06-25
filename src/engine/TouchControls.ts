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
//   • Joystick — bottom-left,  8-way → Arrow keys (also moves the menu cursor)
//   • B button — bottom-right         → field: Run (Shift, held)  |  UI: Cancel (KeyQ)
//   • A button — bottom-right, primary → UI ONLY: Accept (KeyZ)
//   • Talk     — above B, tap          → KeyE (talk/check), field only
//   • Menu     — top-right, tap        → KeyQ (open the menu), field only
//
// COMBAT IS TAP-DRIVEN (no attack button): a tap on the world swings toward it, and
// an offense-PSI hotbar tap then taps a target to aim — the mobile mirror of PC's
// click-to-aim + number-key cast. So A is purely the menu/dialogue Accept; in the
// field it's hidden (you tap to attack). B keeps its SNES B-role: Run, then Cancel.
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
let aBtn: HTMLDivElement | null = null; // attack (field) / accept (UI)
let bBtn: HTMLDivElement | null = null; // run (field) / cancel (UI)
let talkBtn: HTMLDivElement | null = null; // talk/check (field only)
let menuBtn: HTMLDivElement | null = null; // open menu (field only)
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
/* A — attack (field) / accept (UI). Bottom-right, primary face button. */
#touch-controls .tc-a {
  right: calc(env(safe-area-inset-right) + 6vmin);
  bottom: calc(env(safe-area-inset-bottom) + 7vmin);
  width: 22vmin; height: 22vmin; max-width: 120px; max-height: 120px;
  min-width: 80px; min-height: 80px; font-size: 6vmin;
  background: rgba(220,60,60,.24); border-color: rgba(255,120,120,.55);
}
/* B — run (field) / cancel (UI). Left of A, slightly raised (pad diagonal). The
   right offset clears A even when both hit their min-size on a small phone. */
#touch-controls .tc-b {
  right: calc(env(safe-area-inset-right) + 33vmin);
  bottom: calc(env(safe-area-inset-bottom) + 11vmin);
  width: 18vmin; height: 18vmin; max-width: 100px; max-height: 100px;
  min-width: 66px; min-height: 66px; font-size: 5vmin;
  background: rgba(90,180,110,.24); border-color: rgba(150,230,170,.55);
}
/* Talk / Check — field only, above the A·B cluster (cleared from A's top edge). */
#touch-controls .tc-talk {
  right: calc(env(safe-area-inset-right) + 12vmin);
  bottom: calc(env(safe-area-inset-bottom) + 33vmin);
  width: 14vmin; height: 14vmin; max-width: 80px; max-height: 80px;
  min-width: 54px; min-height: 54px; font-size: 3.4vmin;
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

/** True while a menu or dialogue owns the screen — the face buttons switch from
 *  their field roles (attack / run) to their UI roles (accept / cancel). */
function inUI(): boolean {
  return ctx.menuOpen || ctx.dialogueOpen;
}

/** Wire a CONTEXTUAL face button (A / B): in the field the `fieldCode` is HELD
 *  down while the finger rests (attack / run); in a menu or dialogue a press fires
 *  the momentary `uiCode` (accept / cancel). The role is locked at touch-down, and
 *  whatever field key it held is always released on lift. */
function wireDual(el: HTMLDivElement, fieldCode: string, uiCode: string): void {
  let id: number | null = null;
  let held: string | null = null; // field code currently held (null in UI/idle)
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    id = e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('pressed');
    if (inUI()) {
      pressVirtualKey(uiCode); // momentary accept/cancel
    } else {
      held = fieldCode;
      setVirtualKey(fieldCode, true); // hold attack/run
    }
  });
  const up = (e: PointerEvent) => {
    if (id !== e.pointerId) return;
    id = null;
    el.classList.remove('pressed');
    if (held) {
      setVirtualKey(held, false);
      held = null;
    }
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

  // A — accept (KeyZ). UI-only: shown in a menu/dialogue (advance/confirm). In the
  // field combat is tap-driven, so there's no attack button to wire here.
  aBtn = makeButton('tc-a', 'A');
  wireTap(aBtn, () => pressVirtualKey('KeyZ'));

  // B — run (held Shift) in the field, cancel/back (KeyQ) in a menu/dialogue.
  bBtn = makeButton('tc-b', 'B');
  wireDual(bBtn, 'ShiftLeft', 'KeyQ');

  // Talk / Check (tap → KeyE) — field only; advancing dialogue uses A (accept).
  talkBtn = makeButton('tc-talk', '✦');
  wireTap(talkBtn, () => pressVirtualKey('KeyE'));

  // Menu (tap → KeyQ opens it) — field only; inside a menu, B cancels/closes.
  menuBtn = makeButton('tc-menu', '☰');
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
  // The A·B face buttons are always present while playing — they just change role
  // (attack/run → accept/cancel) via wireDual + the labels below. Talk and Menu are
  // field-only: meaningless in a menu/dialogue (A accepts, B cancels there), so we
  // hide them to keep the UI clean. Downed shows only A·B (hold to give up).
  const ui = ctx.menuOpen || ctx.dialogueOpen;
  const fieldOnly = ctx.playing && !ui && !ctx.downed;
  // A is the menu/dialogue Accept only — hidden in the field (tap-to-attack). B is
  // always present (Run in the field, Cancel in UI). Talk + Menu are field-only.
  if (aBtn) aBtn.style.display = ui ? 'flex' : 'none';
  if (talkBtn) talkBtn.style.display = fieldOnly ? 'flex' : 'none';
  if (menuBtn) menuBtn.style.display = fieldOnly ? 'flex' : 'none';
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
  if (!next.playing) {
    // Leaving play (transition / menu boot): drop any held movement AND any held
    // face-button field key, so the player can't slide into the next screen still
    // walking, running, or swinging.
    if (heldArrows.size) clearArrows();
    setVirtualKey('KeyF', false);
    setVirtualKey('ShiftLeft', false);
  }
  if (changed) applyContext();
}
