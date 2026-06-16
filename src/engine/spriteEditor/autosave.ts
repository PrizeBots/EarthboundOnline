// Realtime auto-save for the Cast Sprite Editor. Character sheet edits used to
// persist only on an explicit Ctrl+S/Save (easy to forget — lost edits); now
// every committed edit schedules a debounced save, matching the item editor
// which already persisted on each change. One registered saver + one debounce
// timer; edit sites just call requestAutosave() after a committed change.
import { S } from './state';

const AUTOSAVE_MS = 500; // coalesce rapid edits (e.g. a paint stroke) into one save

let timer = 0;
let saver: (() => void) | null = null;

/** Register the function that persists the active surface (set on editor open). */
export function setAutosaver(fn: () => void): void {
  saver = fn;
}

/** Schedule a debounced save after a committed edit. Resets on each new edit, so
 *  a flurry of changes writes once after the user pauses. */
export function requestAutosave(): void {
  S.dirty = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    saver?.();
  }, AUTOSAVE_MS);
}

/** Save immediately if one is pending (e.g. on close) — skips the debounce wait. */
export function flushAutosave(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = 0;
  saver?.();
}
