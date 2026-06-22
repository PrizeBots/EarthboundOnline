// Physical gamepad support — Steam Deck, Retroid Pocket and other handhelds, plus
// any Xbox/PlayStation/Switch controller, all surface through the browser Gamepad
// API (navigator.getGamepads). Like the touch overlay, this does NOT add a parallel
// input path: it polls the pad each frame and writes the SAME key codes the
// keyboard uses (Input.setVirtualKey / pressVirtualKey), so movement, menu,
// dialogue and the hotbar work unchanged.
//
// We rely on the W3C "standard mapping" (Gamepad.mapping === 'standard'), which the
// Steam Deck and Retroid's built-in pad both report:
//   axes[0/1] = left stick X/Y · buttons 12-15 = D-pad up/down/left/right
//   0=A 1=B 2=X 3=Y · 4/5 = LB/RB · 9 = Start
// A non-standard pad that maps its D-pad to a hat axis won't drive buttons 12-15,
// but the left-stick fallback below still moves the player — remap support is TODO.

import { setVirtualKey, pressVirtualKey } from './Input';

const DEADZONE = 0.3; // left-stick magnitude before a direction registers
const DAS_DELAY = 16; // frames a menu direction is held before it auto-repeats
const DAS_RATE = 6; // frames between auto-repeats once it kicks in

// Keys we are currently holding down on the pad's behalf, so we only ever clear
// what we set (never a key the keyboard is holding at the same time).
const heldKeys = new Set<string>();
// Previous pressed-state per button index, for rising-edge (tap) detection.
const prevBtn = new Map<number, boolean>();
// Frames each direction has been held — drives menu-cursor auto-repeat.
const dirHold = new Map<string, number>();
// Discrete navigation events (e.key strings) produced this frame for screens that
// read DOM-style keys rather than the virtual key set — currently char-select.
const navQueue: string[] = [];
let hadGamepad = false;

/** True once a gamepad has been seen this session (after the first button press —
 *  browsers hide pads until the user interacts). */
export function gamepadConnected(): boolean {
  return hadGamepad;
}

/** Take the discrete pad nav events queued this frame (e.key strings like
 *  'ArrowLeft' / 'Enter'), clearing the queue. Used by char-select, which reads
 *  DOM-style keys instead of the shared virtual key set. */
export function consumeGamepadNav(): string[] {
  if (!navQueue.length) return [];
  const out = navQueue.slice();
  navQueue.length = 0;
  return out;
}

function setHeld(code: string, on: boolean): void {
  if (on) {
    if (!heldKeys.has(code)) {
      heldKeys.add(code);
      setVirtualKey(code, true);
    }
  } else if (heldKeys.has(code)) {
    heldKeys.delete(code);
    setVirtualKey(code, false);
  }
}

function releaseAllHeld(): void {
  for (const code of heldKeys) setVirtualKey(code, false);
  heldKeys.clear();
}

/** Fire a one-frame press on the rising edge of button `index`. The code is
 *  passed per-call so the same physical button can be contextual (A = attack in
 *  the field, confirm in a menu). */
function edge(buttons: readonly GamepadButton[], index: number, code: string): void {
  const pressed = !!buttons[index]?.pressed;
  const was = prevBtn.get(index) ?? false;
  if (pressed && !was) pressVirtualKey(code);
  prevBtn.set(index, pressed);
}

/** Rising-edge of button `index` as a plain boolean (no virtual-key side effect).
 *  Shares prevBtn with edge(); only one of the two runs for a given index per
 *  frame, so they don't fight over the stored state. */
function edgeRaw(buttons: readonly GamepadButton[], index: number): boolean {
  const pressed = !!buttons[index]?.pressed;
  const was = prevBtn.get(index) ?? false;
  prevBtn.set(index, pressed);
  return pressed && !was;
}

/** Auto-repeat a held direction as a discrete nav event (for char-select), using
 *  the same DAS timing as repeatDir but emitting an e.key string instead of a
 *  virtual key press. */
function navRepeat(code: string, on: boolean): void {
  if (!on) {
    dirHold.set(code, 0);
    return;
  }
  const frames = dirHold.get(code) ?? 0;
  if (frames === 0 || (frames >= DAS_DELAY && (frames - DAS_DELAY) % DAS_RATE === 0)) {
    navQueue.push(code);
  }
  dirHold.set(code, frames + 1);
}

/** Auto-repeat a held direction for menu navigation (a held synthesized arrow
 *  only yields one justPressed edge — there's no OS key-repeat to lean on). */
function repeatDir(code: string, on: boolean): void {
  if (!on) {
    dirHold.set(code, 0);
    return;
  }
  const frames = dirHold.get(code) ?? 0;
  if (frames === 0 || (frames >= DAS_DELAY && (frames - DAS_DELAY) % DAS_RATE === 0)) {
    pressVirtualKey(code);
  }
  dirHold.set(code, frames + 1);
}

/**
 * Poll the active gamepad and translate it into virtual key presses. Call once
 * per frame (top of Game.update). `ctx` lets the action buttons adapt to whether
 * a menu/dialogue is up. getGamepads() must be re-read every frame — Chrome's
 * snapshots are not live.
 */
export function pollGamepads(ctx: {
  menuOpen: boolean;
  dialogueOpen: boolean;
  charSelect?: boolean;
}): void {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp: Gamepad | null = null;
  for (const p of pads) {
    if (p && p.connected) {
      gp = p;
      break;
    }
  }
  if (!gp) {
    // Pad unplugged mid-hold: drop everything so the player doesn't walk forever.
    if (hadGamepad) {
      releaseAllHeld();
      prevBtn.clear();
      dirHold.clear();
      hadGamepad = false;
    }
    return;
  }
  hadGamepad = true;

  const b = gp.buttons;
  const ax = gp.axes;
  const lx = ax[0] ?? 0;
  const ly = ax[1] ?? 0;
  // D-pad OR left stick → the same four arrows (8-way: axes are independent).
  const left = !!b[14]?.pressed || lx < -DEADZONE;
  const right = !!b[15]?.pressed || lx > DEADZONE;
  const up = !!b[12]?.pressed || ly < -DEADZONE;
  const down = !!b[13]?.pressed || ly > DEADZONE;

  if (ctx.charSelect) {
    // Char-select grid: discrete cursor steps (with auto-repeat) + confirm.
    // It reads DOM-style e.key strings, not the virtual key set, so we queue
    // nav events here for Game to forward to handleCharSelectInput — rather
    // than latching arrows like field movement does.
    releaseAllHeld();
    navRepeat('ArrowLeft', left);
    navRepeat('ArrowRight', right);
    navRepeat('ArrowUp', up);
    navRepeat('ArrowDown', down);
    // A (0) or Start (9) confirm the highlighted character.
    if (edgeRaw(b, 0) || edgeRaw(b, 9)) navQueue.push('Enter');
    return;
  }

  const uiMode = ctx.menuOpen || ctx.dialogueOpen;
  if (ctx.menuOpen) {
    // Cursor nav: discrete steps with auto-repeat, not a latched arrow.
    releaseAllHeld();
    repeatDir('ArrowLeft', left);
    repeatDir('ArrowRight', right);
    repeatDir('ArrowUp', up);
    repeatDir('ArrowDown', down);
  } else {
    // Field movement: hold the arrow so walking is smooth and continuous.
    dirHold.clear();
    setHeld('ArrowLeft', left);
    setHeld('ArrowRight', right);
    setHeld('ArrowUp', up);
    setHeld('ArrowDown', down);
  }

  // A = attack in the field / confirm·advance in a menu or dialogue box.
  edge(b, 0, uiMode ? 'KeyZ' : 'KeyF');
  // B = talk·check in the field / cancel·close in UI.
  edge(b, 1, uiMode ? 'Escape' : 'KeyE');
  // Start = toggle the menu.
  edge(b, 9, 'KeyQ');
  // X · Y · LB · RB = quick-select hotbar slots 1-4.
  edge(b, 2, 'Digit1');
  edge(b, 3, 'Digit2');
  edge(b, 4, 'Digit3');
  edge(b, 5, 'Digit4');
}

/**
 * Live on-screen gamepad readout for diagnosing handhelds (Retroid, etc.) where
 * we can't open a console. Enabled by adding `?gpdebug` to the URL. Runs its own
 * rAF loop independent of the game so it reports even if the game didn't boot.
 * Shows every pad the browser exposes plus its mapping, live axes and pressed
 * button indices — so we can see exactly how THIS device presents its controls.
 */
export function mountGamepadDebug(): void {
  if (!/[?&]gpdebug/i.test(location.search)) return;
  const el = document.createElement('pre');
  el.style.cssText =
    'position:fixed;left:4px;top:4px;z-index:99999;margin:0;padding:6px 8px;' +
    'background:rgba(0,0,0,.78);color:#3cff6a;font:11px/1.35 monospace;' +
    'white-space:pre-wrap;max-width:96vw;pointer-events:none;border-radius:4px;';
  document.body.appendChild(el);

  let connectedEver = false;
  window.addEventListener('gamepadconnected', () => {
    connectedEver = true;
  });

  // Many Android handhelds (Retroid, etc.) DON'T surface their pad through the
  // Gamepad API — the d-pad/buttons arrive as keyboard events instead, often
  // with non-Arrow codes. Log the last few so we can see exactly what to map.
  const keyLog: string[] = [];
  window.addEventListener(
    'keydown',
    (e) => {
      keyLog.unshift(`code=${e.code || '?'} key=${e.key || '?'} kc=${e.keyCode}`);
      if (keyLog.length > 6) keyLog.length = 6;
    },
    true
  );

  const tick = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const lines: string[] = ['GAMEPAD DEBUG (?gpdebug)'];
    let any = false;
    for (const p of pads) {
      if (!p) continue;
      any = true;
      const ax = Array.from(p.axes, (a) => a.toFixed(2)).join(', ');
      const down = p.buttons
        .map((bb, i) => (bb.pressed || bb.value > 0.3 ? i : -1))
        .filter((i) => i >= 0)
        .join(',');
      lines.push(`#${p.index} "${p.id}"`);
      lines.push(`  mapping=${p.mapping || '(none/non-standard)'}`);
      lines.push(`  axes[${p.axes.length}]: ${ax}`);
      lines.push(`  buttons down: ${down || '-'}`);
    }
    if (!any) {
      lines.push(
        connectedEver ? '(connected event fired, but no live pad)' : 'No gamepad seen yet.'
      );
      lines.push('Press a face button / move a stick');
      lines.push('with this page focused.');
    }
    lines.push('');
    lines.push('KEYBOARD EVENTS (press d-pad/buttons):');
    lines.push(...(keyLog.length ? keyLog : ['(none yet)']));
    el.textContent = lines.join('\n');
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
