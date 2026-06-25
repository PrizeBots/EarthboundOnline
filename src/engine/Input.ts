import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

const keys = new Set<string>();
// Left mouse click acts as an attack press (same as F). Latched on mousedown,
// consumed by isAttackPressed like a key.
let mouseAttack = false;

// Pointer position in game space (256x224), plus a one-shot click latch the
// UI (e.g. MenuManager) consumes. The canvas is CSS-upscaled by an integer
// factor, so we map through its bounding rect to stay scale-independent.
let canvas: HTMLCanvasElement | null = null;
let pointerX = 0;
let pointerY = 0;
// True when the pointer is being driven by a real MOUSE (set on mousemove/down,
// cleared on touch). Gameplay reads this to decide whether to mouse-aim attacks
// vs. fall back to movement-facing (touch / keyboard-only). See Aim.ts.
let pointerIsMouse = false;
let clickPending: { x: number; y: number } | null = null;
// Drag support (for canvas UI like the hotbar): a one-shot press latch, a live
// held flag, and a one-shot release latch. Distinct from clickPending so the
// menu's click handling and its drag handling don't consume each other.
let pointerHeld = false;
let pressPending: { x: number; y: number } | null = null;
let releasePending: { x: number; y: number } | null = null;
// Mouse-wheel notches accumulated since the last consume (+down / -up). Read by
// the menu to scroll its lists; clamped so a fast spin can't pile up unbounded.
let wheelAccum = 0;

/** Expose the live key set so other systems (e.g. MenuManager) can read it. */
export function getKeySet(): Set<string> {
  return keys;
}

// --- Virtual keys (on-screen touch controls) --------------------------------
// The mobile overlay (TouchControls.ts) drives the game by writing into the SAME
// key set the keyboard uses, so every downstream reader (movement, menu toggle,
// dialogue advance, hotbar) works unchanged. Held controls (joystick, attack)
// use setVirtualKey(down); momentary controls (menu/talk/confirm) use
// pressVirtualKey, which injects a one-frame press released by
// releaseVirtualTaps() once per frame.
const virtualTaps = new Set<string>();

/** Press/release a held virtual key (joystick directions, attack button). */
export function setVirtualKey(code: string, down: boolean): void {
  if (down) keys.add(code);
  else keys.delete(code);
}

/** Inject a momentary virtual key press (menu/talk/confirm buttons). Lives for
 *  exactly one frame — released at the next releaseVirtualTaps() — so it reads
 *  as a single press to both edge-detected (menu toggle) and consume-once
 *  (talk/action) readers without lingering as a stale key. */
export function pressVirtualKey(code: string): void {
  keys.add(code);
  virtualTaps.add(code);
}

/** Clear last frame's momentary virtual presses. Call once per frame (top of
 *  render, after update has had its chance to read them). */
export function releaseVirtualTaps(): void {
  if (!virtualTaps.size) return;
  for (const code of virtualTaps) keys.delete(code);
  virtualTaps.clear();
}

/**
 * Drop all currently-held keys. Called when the game transitions into play so a
 * key still down from the previous screen (e.g. the E that confirmed character
 * select) isn't read as an in-game press on the first playing frame — otherwise
 * that confirm-E leaks straight into the Talk/Check action ("no problem here").
 */
export function flushKeys() {
  keys.clear();
  mouseAttack = false;
}

function toGameCoords(clientX: number, clientY: number): { x: number; y: number } {
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * SCREEN_WIDTH,
    y: ((clientY - rect.top) / rect.height) * SCREEN_HEIGHT,
  };
}

let listenersAttached = false;
export function initInput(gameCanvas?: HTMLCanvasElement) {
  if (gameCanvas) canvas = gameCanvas;
  // Attach the window listeners exactly once — initInput is called both at
  // character select (so clicks/keys work there) and again on game start.
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    // Prevent arrow keys from scrolling the page
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });
  window.addEventListener('mousemove', (e) => {
    const p = toGameCoords(e.clientX, e.clientY);
    pointerX = p.x;
    pointerY = p.y;
    pointerIsMouse = true;
  });
  // Left mouse button = attack. Ignore clicks on UI controls (buttons, inputs,
  // the editor overlay) so they don't trigger a swing. The click is also
  // latched as a UI pointer event so menus can hit-test it.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('button, input, textarea, select, [data-ui]')) return;
    mouseAttack = true;
    pointerIsMouse = true;
    const c = toGameCoords(e.clientX, e.clientY);
    clickPending = c;
    pressPending = c;
    pointerHeld = true;
  });
  // Track release globally (a drag can end off-canvas).
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    pointerHeld = false;
    releasePending = toGameCoords(e.clientX, e.clientY);
  });
  // Right-click over the game canvas shouldn't pop the browser's native context
  // menu ("Save image as" / "Copy image") — it's just a game surface. Scoped to
  // the canvas so DOM UI (ROM picker, account forms, inputs) keeps its menu.
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t === canvas || t.tagName === 'CANVAS')) e.preventDefault();
  });
  // Mouse wheel over the game canvas scrolls menu lists (and must not scroll the
  // page). One notch per event; accumulate so a fast flick moves several rows.
  window.addEventListener(
    'wheel',
    (e) => {
      const t = e.target as HTMLElement | null;
      const onCanvas = t && (t === canvas || t.tagName === 'CANVAS');
      if (!onCanvas) return;
      e.preventDefault();
      wheelAccum += e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      wheelAccum = Math.max(-8, Math.min(8, wheelAccum));
    },
    { passive: false }
  );

  // Touch → pointer bridge. A tap on the GAME CANVAS feeds the same pointer
  // latches a left mouse click does, so on-canvas UI (hotbar, menu items, shops,
  // dialogue "tap to continue", character select) is tappable on mobile. The
  // on-screen movement/attack/menu controls are separate DOM elements layered
  // ABOVE the canvas, so their touches target those elements, not this handler —
  // and unlike a mouse click we DON'T latch mouseAttack, so a UI tap never leaks
  // through as a sword swing (attack is its own button). preventDefault stops the
  // browser from also firing a synthetic mouse event / scrolling the page.
  if (canvas) {
    canvas.addEventListener(
      'touchstart',
      (e) => {
        const t = e.changedTouches[0];
        if (!t) return;
        e.preventDefault();
        const c = toGameCoords(t.clientX, t.clientY);
        pointerX = c.x;
        pointerY = c.y;
        pointerIsMouse = false; // touch, not mouse → attacks keep movement-facing
        clickPending = c;
        pressPending = c;
        pointerHeld = true;
      },
      { passive: false }
    );
    canvas.addEventListener(
      'touchmove',
      (e) => {
        const t = e.changedTouches[0];
        if (!t) return;
        e.preventDefault();
        const c = toGameCoords(t.clientX, t.clientY);
        pointerX = c.x;
        pointerY = c.y;
        pointerIsMouse = false;
      },
      { passive: false }
    );
    const endTouch = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      pointerHeld = false;
      if (t) releasePending = toGameCoords(t.clientX, t.clientY);
    };
    canvas.addEventListener('touchend', endTouch);
    canvas.addEventListener('touchcancel', endTouch);
  }
}

/** True while the left button is held down (for drag interactions). */
export function isPointerDown(): boolean {
  return pointerHeld;
}

/** Take the pending press (mousedown) once, else null. */
export function consumePointerPress(): { x: number; y: number } | null {
  const p = pressPending;
  pressPending = null;
  return p;
}

/** Take the pending release (mouseup) once, else null. */
export function consumePointerRelease(): { x: number; y: number } | null {
  const r = releasePending;
  releasePending = null;
  return r;
}

/** Pointer position in game-space pixels (256x224). */
export function getPointer(): { x: number; y: number } {
  return { x: pointerX, y: pointerY };
}

/** True when a real mouse last drove the pointer (not touch). Gameplay uses this
 *  to gate mouse-aim — touch / keyboard-only players keep movement-facing. */
export function isMouseAimActive(): boolean {
  return pointerIsMouse;
}

/** Take the accumulated wheel notches (+down / -up) since the last call, reset
 *  to 0. Call once per frame so stale scroll can't build up while idle. */
export function consumeWheelDelta(): number {
  const w = wheelAccum;
  wheelAccum = 0;
  return w;
}

/**
 * Take the pending left-click (game-space coords) if there is one, else null.
 * Consuming a click also clears the attack latch, so a click the UI handled
 * never leaks through as a sword swing once the menu closes.
 */
export function consumePointerClick(): { x: number; y: number } | null {
  const c = clickPending;
  clickPending = null;
  if (c) mouseAttack = false;
  return c;
}

export function isActionPressed(): boolean {
  if (keys.has('Space') || keys.has('Enter') || keys.has('KeyZ')) {
    // Consume the press so it doesn't repeat
    keys.delete('Space');
    keys.delete('Enter');
    keys.delete('KeyZ');
    return true;
  }
  return false;
}

/** E — the contextual "Talk to / Check" button. */
export function isTalkPressed(): boolean {
  if (keys.has('KeyE')) {
    keys.delete('KeyE');
    return true;
  }
  return false;
}

/** F or left mouse click — swing the held item / attack. */
export function isAttackPressed(): boolean {
  if (keys.has('KeyF') || mouseAttack) {
    keys.delete('KeyF');
    mouseAttack = false;
    return true;
  }
  return false;
}

/** 1 or 2 — trigger that hotbar slot (toggle-brandish the assigned weapon / use
 *  the assigned consumable). Returns the 0-based slot just pressed, or -1.
 *  Consumes the key so a single press fires once. Replaces the old G cycle key. */
export function consumeHotbarSlot(): number {
  // Scan number keys 1-9 → slot index 0-8. We don't import HOTBAR_SLOTS here;
  // the hotbar array length bounds it (a press past the last slot hits an empty
  // slot and no-ops), so adding/removing slots needs no change in this file.
  for (let i = 0; i < 9; i++) {
    const code = `Digit${i + 1}`;
    if (keys.has(code)) {
      keys.delete(code);
      return i;
    }
  }
  return -1;
}
/** H — play the hurt animation (debug hook until combat deals damage). */
export function isHurtPressed(): boolean {
  if (keys.has('KeyH')) {
    keys.delete('KeyH');
    return true;
  }
  return false;
}

/** B — toggle the debug hit/hurt box overlay. */
export function isToggleBoxesPressed(): boolean {
  if (keys.has('KeyB')) {
    keys.delete('KeyB');
    return true;
  }
  return false;
}

export function getDirection(): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;

  if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;

  return { dx, dy };
}
