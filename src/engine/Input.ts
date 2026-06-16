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
let clickPending: { x: number; y: number } | null = null;
// Drag support (for canvas UI like the hotbar): a one-shot press latch, a live
// held flag, and a one-shot release latch. Distinct from clickPending so the
// menu's click handling and its drag handling don't consume each other.
let pointerHeld = false;
let pressPending: { x: number; y: number } | null = null;
let releasePending: { x: number; y: number } | null = null;

/** Expose the live key set so other systems (e.g. MenuManager) can read it. */
export function getKeySet(): Set<string> {
  return keys;
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
  });
  // Left mouse button = attack. Ignore clicks on UI controls (buttons, inputs,
  // the editor overlay) so they don't trigger a swing. The click is also
  // latched as a UI pointer event so menus can hit-test it.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('button, input, textarea, select, [data-ui]')) return;
    mouseAttack = true;
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
  for (let i = 0; i < 2; i++) {
    const code = `Digit${i + 1}`;
    if (keys.has(code)) {
      keys.delete(code);
      return i;
    }
  }
  return -1;
}

/** G — cycle the held/equipped weapon through your inventory (+ none). Coexists
 *  with the 1/2 hotbar (consumeHotbarSlot); Game.ts still drives equip via this. */
export function isCycleItemPressed(): boolean {
  if (keys.has('KeyG')) {
    keys.delete('KeyG');
    return true;
  }
  return false;
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
