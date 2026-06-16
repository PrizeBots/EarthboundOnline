// Dev-only save-back channel + the transient save banner. Shared by the item,
// cast, and rename save paths.
import { primeJSONCache } from '../AssetLoader';
import { S } from './state';

/** Dev-only save-back channel (Vite middleware; absent in production builds).
 *  Surfaces ANY failure as an error banner + status pip — several callers swallow
 *  the rejection, so a silent save failure must never slip past here — then
 *  rethrows so callers that do care still see it. */
export async function postOverride(name: string, data: unknown): Promise<void> {
  try {
    const res = await fetch('/__editor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    primeJSONCache(`/overrides/${name}`, data);
  } catch (err) {
    setSaveStatus('error');
    flashSaved(`⚠ Save failed (${name}) — ${String(err)}`, true);
    throw err;
  }
}

// Persistent realtime-save status pip (shown where the old Save button was).
// Reflects the auto-save state so it's always clear edits are landing. The
// element lives in the DOM (data-role=save-status); see dom.ts.
export function setSaveStatus(state: 'saving' | 'saved' | 'error'): void {
  if (!S.overlay) return;
  const el = S.overlay.querySelector<HTMLDivElement>('[data-role=save-status]');
  if (!el) return;
  if (state === 'saving') {
    el.textContent = '● saving…';
    el.style.color = '#e8c34d';
  } else if (state === 'saved') {
    el.textContent = '✓ saved';
    el.style.color = '#7c7';
  } else {
    el.textContent = '⚠ save failed';
    el.style.color = '#f99';
  }
}

// Transient save notification — a brief banner pinned to the top of the editor
// overlay (Ctrl+S has no shell toast of its own). Auto-fades; removed with the
// overlay on close. Green for success, red for failure.
export function flashSaved(msg: string, isError = false): void {
  if (!S.overlay) return;
  let el = S.overlay.querySelector<HTMLDivElement>('[data-role=save-flash]');
  if (!el) {
    el = document.createElement('div');
    el.dataset.role = 'save-flash';
    el.style.cssText =
      'position:fixed;top:74px;left:50%;transform:translateX(-50%);z-index:99;' +
      'padding:6px 16px;border-radius:5px;font:bold 13px monospace;pointer-events:none;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.5);transition:opacity .3s;';
    S.overlay.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? '#3a1f1f' : '#1f3a26';
  el.style.color = isError ? '#f99' : '#9f9';
  el.style.border = `1px solid ${isError ? '#a44' : '#4a6'}`;
  el.style.opacity = '1';
  clearTimeout(S.saveFlashTimer);
  S.saveFlashTimer = window.setTimeout(() => {
    if (el) el.style.opacity = '0';
  }, 1400);
}
