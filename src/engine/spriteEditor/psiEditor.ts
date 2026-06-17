// PSI-animation editing surface: a variable-length flipbook of PSI_W×PSI_H
// effect frames per PSI ability (catalog from PsiCatalog / psi.json), authored
// into overrides/psi_anim.json (OUR art). Mirror of itemEditor, but frames are
// add/remove (not a fixed 3) and each ability carries a `delivery` mode
// (caster / target / projectile). Shares the pixel engine via ./pixelCanvas
// (PSI uses the "buffer surface" path at 48×48) and the global state S.
import { listPsi, getPsi, psiLabel } from '../PsiCatalog';
import {
  PSI_W,
  PSI_H,
  PsiDelivery,
  getPsiAnim,
  hasPsiAnim,
  setPsiAnim,
  psiAnimDoc,
} from '../PsiAnim';
import { createSpritePicker } from '../SpritePicker';
import { S } from './state';
import { postOverride, setSaveStatus } from './saveChannel';
import { clearSelection } from './pixelCanvas';

const MAX_FRAMES = 24; // a generous flipbook cap

/** A fresh transparent PSI_W×PSI_H frame canvas. */
function blankFrame(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = PSI_W;
  c.height = PSI_H;
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.imageSmoothingEnabled = false;
  return c;
}

/** Default delivery for a PSI before it's authored: offense → projectile (it
 *  flies at the foe), recover → target (heal on the ally), else caster (buffs). */
function defaultDelivery(id: string): PsiDelivery {
  const a = getPsi(id);
  const t = a?.type ?? [];
  // ROM type strings: 'offense', 'recovery', 'assist' (substring-match).
  if (t.some((x) => x.includes('offense'))) return 'projectile';
  if (t.some((x) => x.includes('recover'))) return 'target';
  return 'caster';
}

/** Point psiCanvas/psiCtx at the active frame's buffer. */
function aliasActiveFrame(): void {
  S.psiCanvas = S.psiFrameBuffers[S.psiEditFrame] ?? null;
  S.psiCtx = S.psiFrameCtxs[S.psiEditFrame] ?? null;
}

/** Rebuild the buffer array to `n` blank frames (drops old refs). */
function resetBuffers(n: number): void {
  S.psiFrameBuffers = [];
  S.psiFrameCtxs = [];
  for (let i = 0; i < n; i++) {
    const c = blankFrame();
    S.psiFrameBuffers.push(c);
    S.psiFrameCtxs.push(c.getContext('2d', { willReadFrequently: true })!);
  }
}

/** Draw a PNG data URL into frame buffer `i` once it loads (async). */
function fillFrameFromUrl(i: number, url: string): void {
  const img = new Image();
  img.onload = () => {
    const cx = S.psiFrameCtxs[i];
    if (!cx) return;
    cx.clearRect(0, 0, PSI_W, PSI_H);
    cx.drawImage(img, 0, 0, PSI_W, PSI_H);
    S.dirty = true;
  };
  img.src = url;
}

/** Seed the buffers from psi.json default selection on first open. */
export function buildPsiBuffer(): void {
  if (!S.psiEditId) S.psiEditId = listPsi()[0]?.id ?? '';
  if (S.psiEditId) loadPsiIntoBuffer(S.psiEditId);
  else resetBuffers(1);
}

/** Load an ability's authored animation (or a blank 1-frame start) into the buffers. */
export function loadPsiIntoBuffer(id: string): void {
  clearSelection();
  S.psiEditId = id;
  const entry = getPsiAnim(id);
  S.psiDelivery = entry?.delivery ?? defaultDelivery(id);
  const urls = entry?.frames ?? [];
  resetBuffers(Math.max(1, urls.length));
  S.psiEditFrame = 0;
  aliasActiveFrame();
  S.psiUndo = [];
  urls.forEach((u, i) => fillFrameFromUrl(i, u));
  if (S.psiDeliverySel) S.psiDeliverySel.value = S.psiDelivery;
  updatePsiNote();
  renderPsiThumb();
  S.dirty = true;
}

function updatePsiNote(): void {
  if (!S.psiNote) return;
  const label = psiLabel(S.psiEditId);
  S.psiNote.textContent = `${label} — frame ${S.psiEditFrame + 1}/${S.psiFrameBuffers.length} · ${S.psiDelivery}`;
}

/** Switch which frame is being painted. */
export function setPsiEditFrame(frame: number): void {
  if (frame < 0 || frame >= S.psiFrameBuffers.length || frame === S.psiEditFrame) return;
  clearSelection();
  S.psiEditFrame = frame;
  aliasActiveFrame();
  S.psiUndo = [];
  updatePsiNote();
  S.dirty = true;
}

/** Append a frame (a copy of the current one, so you tweak the next pose). */
export function addPsiFrame(): void {
  if (S.psiFrameBuffers.length >= MAX_FRAMES) return;
  const c = blankFrame();
  const prev = S.psiFrameBuffers[S.psiEditFrame];
  if (prev) c.getContext('2d')!.drawImage(prev, 0, 0);
  const insertAt = S.psiEditFrame + 1;
  S.psiFrameBuffers.splice(insertAt, 0, c);
  S.psiFrameCtxs.splice(insertAt, 0, c.getContext('2d', { willReadFrequently: true })!);
  S.psiEditFrame = insertAt;
  aliasActiveFrame();
  S.psiUndo = [];
  persistPsi();
  updatePsiNote();
  S.dirty = true;
}

/** Delete the current frame (keeps at least one). */
export function deletePsiFrame(): void {
  if (S.psiFrameBuffers.length <= 1) return;
  S.psiFrameBuffers.splice(S.psiEditFrame, 1);
  S.psiFrameCtxs.splice(S.psiEditFrame, 1);
  S.psiEditFrame = Math.min(S.psiEditFrame, S.psiFrameBuffers.length - 1);
  aliasActiveFrame();
  S.psiUndo = [];
  persistPsi();
  updatePsiNote();
  S.dirty = true;
}

export function setPsiDelivery(d: PsiDelivery): void {
  S.psiDelivery = d;
  persistPsi();
  updatePsiNote();
}

/** Refresh the picker thumb (called after an edit). */
export function commitPsiEdit(): void {
  renderPsiThumb();
}

/** Persist the active PSI's animation (all frames + delivery) to the SHARED
 *  store + overrides/psi_anim.json. Frames are PNG data URLs (no palette coupling). */
export function persistPsi(): void {
  if (!S.psiEditId) return;
  const frames = S.psiFrameBuffers.map((c) => c.toDataURL('image/png'));
  setPsiAnim(S.psiEditId, { delivery: S.psiDelivery, frames });
  setSaveStatus('saving');
  void postOverride('psi_anim.json', psiAnimDoc())
    .then(() => setSaveStatus('saved'))
    .catch(() => {
      setSaveStatus('error');
      if (S.psiNote) S.psiNote.textContent = 'PSI save failed (dev save channel?)';
    });
}

/** Rebuild the PSI dropdown (every ability; a ✎ marks ones with authored art). */
export function rebuildPsiPicker(): void {
  if (!S.psiPickerHost) return;
  S.psiPickerHost.innerHTML = '';
  const ids = listPsi().map((a) => a.id);
  const initial = ids.includes(S.psiEditId) ? S.psiEditId : (ids[0] ?? '');
  S.psiPicker = createSpritePicker({
    sections: [{ values: ids }],
    initial,
    labelFor: (v) => `${hasPsiAnim(v) ? '✎ ' : ''}${psiLabel(v)}`,
    drawThumb: drawPsiThumb,
    searchPlaceholder: 'search PSI…',
    onSelect: (v) => {
      loadPsiIntoBuffer(v);
      S.dirty = true;
    },
  });
  S.psiPickerHost.appendChild(S.psiPicker.el);
}

/** drawThumb: the ability's first authored frame (live buffer for the active one). */
function drawPsiThumb(canvas: HTMLCanvasElement, v: string): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const src = v === S.psiEditId && S.psiFrameBuffers.length ? S.psiFrameBuffers[0] : null;
  if (!src) return;
  const s = Math.max(1, Math.floor(Math.min(canvas.width / PSI_W, canvas.height / PSI_H)));
  ctx.drawImage(
    src,
    0,
    0,
    PSI_W,
    PSI_H,
    (canvas.width - PSI_W * s) / 2,
    (canvas.height - PSI_H * s) / 2,
    PSI_W * s,
    PSI_H * s
  );
}

export function renderPsiThumb(): void {
  S.psiPicker?.setValue(S.psiEditId);
}

/** FRAMES-strip cells: one per PSI frame (clickable to edit). */
export function psiStripCells(): {
  label: string;
  w: number;
  h: number;
  draw: (ctx: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) => void;
}[] {
  return S.psiFrameBuffers.map((buf, f) => ({
    label: `frame ${f + 1}`,
    w: PSI_W,
    h: PSI_H,
    draw: (ctx, dx, dy, dw, dh) => ctx.drawImage(buf, 0, 0, PSI_W, PSI_H, dx, dy, dw, dh),
  }));
}

/** Loop the active PSI's frames in the close-up preview pane (psi mode only). */
export function drawPsiPreview(): void {
  const wrap = S.itemTestCanvas?.parentElement as HTMLElement | null;
  if (!S.itemTestCanvas || !wrap) return;
  wrap.style.display = 'flex';
  if (++S.psiPreviewTimer >= 6) {
    S.psiPreviewTimer = 0;
    S.psiPreviewFrame = (S.psiPreviewFrame + 1) % Math.max(1, S.psiFrameBuffers.length);
  }
  const ctx = S.itemTestCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, S.itemTestCanvas.width, S.itemTestCanvas.height);
  const buf = S.psiFrameBuffers[S.psiPreviewFrame];
  if (buf)
    ctx.drawImage(buf, 0, 0, PSI_W, PSI_H, 0, 0, S.itemTestCanvas.width, S.itemTestCanvas.height);
}
