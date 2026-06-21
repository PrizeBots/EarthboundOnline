// The shared pixel-editing engine: tool state, selection / move / transform,
// undo, flood fill, copy/paste, and the EDIT-canvas render. It operates on
// `activeTarget()` — the selected character sheet cell (16x24) in char mode, or
// the 16x16 item buffer in item mode — so the same drawing code serves both
// surfaces. State lives in ./state (S); item-side commits route back through
// ./itemEditor.
import { drawSprite, getSpriteGroupMeta, refreshDiagSupport } from '../SpriteManager';
import { ITEM_W, ITEM_H, ITEM_PALETTE } from '../Items';
import { Direction } from '../../types';
import {
  ZOOM,
  FRAME_W,
  FRAME_H,
  SHEET_W,
  SHEET_H,
  UNDO_LIMIT,
  CHECKER_A,
  CHECKER_B,
  DISPLAY_ROWS,
  Tool,
  PixelRect,
  mirrorTargetFor,
  MIRROR,
  DIR_BASE,
  ATTACK_ROW_START,
  HURT_ROW_START,
  parseHexColor,
  itemPaletteRGB,
  strokeRectAnts,
} from './constants';
import { S } from './state';
import { commitItemEdit, persistItem } from './itemEditor';
import { commitPsiEdit, persistPsi } from './psiEditor';
import { commitEntityEdit, persistEntity, recolorEntityPalette } from './entityEditor';
import { PSI_W, PSI_H } from '../PsiAnim';
import { requestAutosave } from './autosave';

/** True once a paintable character sheet is loaded (false for view-only groups). */
export function sheetReady(): boolean {
  return !!S.sheet && !!S.sheetCtx && !!S.pristineSheet;
}

// The canvas + cell origin + dimensions currently being painted. Character mode
// targets the selected sheet cell (16x24); item mode targets the 16x16 buffer.
export function activeTarget(): {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  ox: number;
  oy: number;
} {
  if (S.editMode !== 'char') {
    const b = activeBuffer();
    return { ctx: b.ctx, w: b.w, h: b.h, ox: 0, oy: 0 };
  }
  return { ctx: S.sheetCtx!, w: S.selW, h: S.selH, ox: S.selOX, oy: S.selOY };
}

// The active non-char "buffer surface": the held-item buffer (16×16, fixed 3
// frames) or a PSI effect frame (48×48, variable count). Both paint through the
// same engine and use the item palette — only dims, the undo stack, and the
// persist/commit target differ.
export function activeBuffer(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  undo: ImageData[];
  w: number;
  h: number;
} {
  if (S.editMode === 'psi') {
    return { canvas: S.psiCanvas!, ctx: S.psiCtx!, undo: S.psiUndo, w: PSI_W, h: PSI_H };
  }
  // 'stamp' reuses the entity buffer surface (single variable-size frame).
  if (S.editMode === 'entity' || S.editMode === 'stamp') {
    return {
      canvas: S.entityCanvas!,
      ctx: S.entityCtx!,
      undo: S.entityUndo,
      w: S.entityW,
      h: S.entityH,
    };
  }
  return { canvas: S.itemCanvas!, ctx: S.itemCtx!, undo: S.itemUndo, w: ITEM_W, h: ITEM_H };
}

/** True for the modes whose colors come from the EXTRACTED image palette
 *  (S.palette): the cast sheet and custom entities. Item/PSI use ITEM_PALETTE. */
function usesImagePalette(): boolean {
  return S.editMode === 'char' || S.editMode === 'entity' || S.editMode === 'stamp';
}

/** CSS color for a palette index in the active mode, or null for transparent. */
export function colorFor(i: number): string | null {
  if (i === 0) return null;
  if (!usesImagePalette()) return ITEM_PALETTE[i] || null; // item + psi share the palette
  const c = S.palette[i];
  return c ? `rgb(${c[0]},${c[1]},${c[2]})` : null;
}

/** Nearest palette index to an RGB color in the active mode (for eyedrop). */
function nearestActiveIndex(r: number, g: number, b: number): number {
  if (usesImagePalette()) return nearestPaletteIndex(r, g, b);
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < itemPaletteRGB.length; i++) {
    const [pr, pg, pb] = itemPaletteRGB[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < S.palette.length; i++) {
    const [pr, pg, pb] = S.palette[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Mouse → region-local pixel coords. `clampInside` keeps a drag in-bounds; else
 *  returns null when the cursor is outside the frame. */
function pixelAt(e: MouseEvent, clampInside = false): { px: number; py: number } | null {
  const { w, h } = activeTarget();
  const r = S.editCanvas.getBoundingClientRect();
  let px = Math.floor((e.clientX - r.left) / ZOOM);
  let py = Math.floor((e.clientY - r.top) / ZOOM);
  if (clampInside) {
    px = Math.max(0, Math.min(w - 1, px));
    py = Math.max(0, Math.min(h - 1, py));
  } else if (px < 0 || py < 0 || px >= w || py >= h) {
    return null;
  }
  return { px, py };
}

/** Inclusive pixel rect from two corners. */
function normRect(x0: number, y0: number, x1: number, y1: number): PixelRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0) + 1,
    h: Math.abs(y1 - y0) + 1,
  };
}

function pointInRect(x: number, y: number, r: PixelRect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** A real (drag-made) marquee, not a stray 1×1 click selection. */
function isDraggableSelection(r: PixelRect | null): r is PixelRect {
  return !!r && (r.w > 1 || r.h > 1);
}

/** Edit-canvas mousedown: dispatch by tool (marquee / move / fill / paint). */
export function onEditDown(e: MouseEvent): void {
  if (S.editMode === 'char' && !sheetReady()) return; // view-only group: no editing
  const p = pixelAt(e);
  if (!p) return;
  if (S.tool === 'select') {
    // Click INSIDE an existing selection → drag it (move), like any image editor.
    // Click outside → start a fresh marquee.
    if (isDraggableSelection(S.selection) && pointInRect(p.px, p.py, S.selection)) {
      beginMove(p.px, p.py);
      return;
    }
    S.marqueeAnchor = { x: p.px, y: p.py };
    S.selection = { x: p.px, y: p.py, w: 1, h: 1 };
    S.dirty = true;
    return;
  }
  if (S.tool === 'move') {
    beginMove(p.px, p.py);
    return;
  }
  if (S.tool === 'rotate' || S.tool === 'skew') {
    const { fx, fy } = pointerFrac(e);
    beginXform(S.tool, fx, fy);
    return;
  }
  if (S.tool === 'fill') {
    floodFill(p.px, p.py);
    return;
  }
  S.painting = true; // pencil / eraser / eyedrop
  S.strokeChanged = false;
  pushUndo();
  applyToolAt(e);
}

export function onEditMove(e: MouseEvent): void {
  // Hover hint: a move cursor over a draggable selection signals you can grab it.
  if (!S.marqueeAnchor && !S.xformState && !S.moveState && !S.painting && S.editCanvas) {
    const hp = pixelAt(e, true);
    const overSel =
      S.tool === 'select' &&
      isDraggableSelection(S.selection) &&
      !!hp &&
      pointInRect(hp.px, hp.py, S.selection);
    S.editCanvas.style.cursor = overSel ? 'move' : '';
  }
  if (S.marqueeAnchor) {
    const p = pixelAt(e, true);
    if (p) {
      S.selection = normRect(S.marqueeAnchor.x, S.marqueeAnchor.y, p.px, p.py);
      S.dirty = true;
    }
    return;
  }
  if (S.xformState) {
    updateXform(e);
    return;
  }
  if (S.moveState) {
    const p = pixelAt(e, true);
    if (p) {
      S.moveState.x = p.px - S.moveState.grabX;
      S.moveState.y = p.py - S.moveState.grabY;
      S.dirty = true;
    }
    return;
  }
  if (S.painting) applyToolAt(e);
}

/** Lift the selection (or whole frame) into a floating buffer to drag around. */
function beginMove(px: number, py: number): void {
  if (S.editMode === 'char' && !sheetReady()) return;
  const { ctx, ox, oy } = activeTarget();
  const r = opRegion();
  pushUndo();
  const lift = document.createElement('canvas');
  lift.width = r.w;
  lift.height = r.h;
  const lctx = lift.getContext('2d')!;
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(ctx.canvas, ox + r.x, oy + r.y, r.w, r.h, 0, 0, r.w, r.h);
  ctx.clearRect(ox + r.x, oy + r.y, r.w, r.h); // lift leaves a hole until dropped
  S.moveState = { pixels: lift, w: r.w, h: r.h, grabX: px - r.x, grabY: py - r.y, x: r.x, y: r.y };
  S.selection = { x: r.x, y: r.y, w: r.w, h: r.h };
  S.dirty = true;
}

/** Stamp the floating pixels at their dropped position (clipped to the frame). */
function finishMove(): void {
  if (!S.moveState) return;
  const { ctx, ox, oy, w, h } = activeTarget();
  const dx = S.moveState.x;
  const dy = S.moveState.y;
  const sx = Math.max(0, -dx);
  const sy = Math.max(0, -dy);
  const cw = Math.min(S.moveState.w, w - dx) - sx;
  const ch = Math.min(S.moveState.h, h - dy) - sy;
  if (cw > 0 && ch > 0) {
    ctx.drawImage(S.moveState.pixels, sx, sy, cw, ch, ox + dx + sx, oy + dy + sy, cw, ch);
  }
  const nx = Math.max(0, Math.min(w - 1, dx));
  const ny = Math.max(0, Math.min(h - 1, dy));
  S.selection = {
    x: nx,
    y: ny,
    w: Math.min(S.moveState.w, w - nx),
    h: Math.min(S.moveState.h, h - ny),
  };
  S.moveState = null;
  afterRegionEdit();
}

function applyToolAt(e: MouseEvent): void {
  if (S.editMode === 'char' && !sheetReady()) return; // view-only group: nothing to paint
  const { ctx, w, h, ox, oy } = activeTarget();
  const r = S.editCanvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - r.left) / ZOOM);
  const py = Math.floor((e.clientY - r.top) / ZOOM);
  if (px < 0 || py < 0 || px >= w || py >= h) return;

  const sx = ox + px;
  const sy = oy + py;

  // Right mouse button always erases, whatever tool is active.
  const erase = S.tool === 'eraser' || (e.buttons & 2) !== 0;

  // Alt+click samples a color without switching off the active tool; the
  // eyedrop tool does the same but then drops back to the pencil.
  if ((S.tool === 'eyedrop' || e.altKey) && !erase) {
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    setColor(d[3] === 0 ? 0 : nearestActiveIndex(d[0], d[1], d[2]));
    if (S.tool === 'eyedrop') setTool('pencil');
    return;
  }

  const color = colorFor(S.colorIndex);
  if (erase || color === null) {
    ctx.clearRect(sx, sy, 1, 1);
  } else {
    ctx.clearRect(sx, sy, 1, 1); // replace, don't blend
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, 1, 1);
  }

  if (S.editMode !== 'char') {
    commitActive(); // push the buffer to its live preview (item override / PSI thumb)
  } else if (S.mirrorLR) {
    // Auto-mirror: keep the west/diagonal-left partner cell a flipped copy of the
    // canonical cell being edited (selection is always canonical — see strip click).
    // Skipped when this group authors its west frames independently (mirror OFF).
    syncMirrorCell(S.selRow, S.selCol);
  }
  S.strokeChanged = true;
  S.dirty = true;
}

/** Redraw the derived (mirrored) partner of a canonical cell as its h-flip. */
export function syncMirrorCell(row: number, col: number): void {
  const t = mirrorTargetFor(row, col);
  if (!t) return;
  const ctx = S.sheetCtx!;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(t.col * FRAME_W, t.row * FRAME_H, FRAME_W, FRAME_H);
  ctx.translate(t.col * FRAME_W + FRAME_W, t.row * FRAME_H);
  ctx.scale(-1, 1);
  ctx.drawImage(S.sheet!, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
  ctx.restore();
}

/** Re-flip every west/diagonal-left cell from its east partner across all pose
 *  blocks. Used when mirroring is switched back ON, so the W frames snap back to
 *  exact flips of E (discarding any independent west art). */
export function remirrorAll(): void {
  if (!S.sheetCtx) return;
  for (const off of [0, ATTACK_ROW_START, HURT_ROW_START]) {
    for (const [canon] of MIRROR) {
      const c = DIR_BASE[canon];
      syncMirrorCell(c.row + off, c.col); // frame 0
      syncMirrorCell(c.row + off, c.col + 1); // frame 1
    }
  }
}

export function pushUndo(): void {
  if (S.editMode !== 'char') {
    const b = activeBuffer();
    b.undo.push(b.ctx.getImageData(0, 0, b.w, b.h));
    if (b.undo.length > UNDO_LIMIT) b.undo.shift();
    return;
  }
  if (!S.sheetCtx) return; // view-only group: no sheet to snapshot
  S.undoStack.push(S.sheetCtx.getImageData(0, 0, SHEET_W, SHEET_H));
  if (S.undoStack.length > UNDO_LIMIT) S.undoStack.shift();
  requestAutosave(); // realtime save of character sheet edits (item art self-saves)
}

export function undo(): void {
  if (S.editMode !== 'char') {
    const b = activeBuffer();
    const snap = b.undo.pop();
    if (!snap) return;
    b.ctx.putImageData(snap, 0, 0);
    commitActive();
    persistActive();
    S.dirty = true;
    return;
  }
  const snap = S.undoStack.pop();
  if (!snap) return;
  S.sheetCtx!.putImageData(snap, 0, 0);
  refreshDiagSupport(S.groupId); // an undo may add/remove diagonal frames
  S.dirty = true;
  requestAutosave(); // persist the undone state too
}

/** Persist whichever surface is currently being edited. Item + PSI art autosave;
 *  character anim edits persist only via the explicit Save. */
export function persistActive(): void {
  if (S.editMode === 'item') persistItem();
  else if (S.editMode === 'psi') persistPsi();
  else if (S.editMode === 'entity') persistEntity();
}

/** Re-commit the active buffer to its live preview (item / PSI / entity). */
function commitActive(): void {
  if (S.editMode === 'item') commitItemEdit();
  else if (S.editMode === 'psi') commitPsiEdit();
  else if (S.editMode === 'entity') commitEntityEdit();
}

/** Human label for a sheet cell (selection is always a canonical strip cell). */
function labelForCell(row: number, col: number): string {
  for (const dr of DISPLAY_ROWS) {
    for (const set of dr) {
      if (set.row === row && (col === set.col || col === set.col + 1)) {
        return `${set.label} f${col - set.col}`;
      }
    }
  }
  return `r${row}c${col}`;
}

// ---------------------------------------------------------------------------
// Selection, copy/paste, fill, and transforms. All operate on the active target
// region; if a marquee `selection` is set they act on it, otherwise on the frame.
// ---------------------------------------------------------------------------

/** The region operations act on: the marquee selection, or the whole frame. */
function opRegion(): PixelRect {
  const { w, h } = activeTarget();
  if (S.selection) return S.selection;
  return { x: 0, y: 0, w, h };
}

/** Current paint color as RGBA bytes (alpha 0 for the transparent clear index). */
function fillRGBA(): [number, number, number, number] {
  if (S.colorIndex === 0) return [0, 0, 0, 0];
  if (!usesImagePalette()) {
    const hex = ITEM_PALETTE[S.colorIndex];
    if (!hex) return [0, 0, 0, 0];
    const [r, g, b] = parseHexColor(hex);
    return [r, g, b, 255];
  }
  const c = S.palette[S.colorIndex];
  return c ? [c[0], c[1], c[2], 255] : [0, 0, 0, 0];
}

/** Re-commit / re-mirror / persist after a non-stroke pixel edit, and redraw. */
function afterRegionEdit(): void {
  if (S.editMode !== 'char') commitActive();
  else {
    syncMirrorCell(S.selRow, S.selCol);
    refreshDiagSupport(S.groupId);
  }
  persistActive();
  S.dirty = true;
}

/** Copy the selection (or whole frame) into the clipboard. */
export function copySelection(): void {
  if (S.editMode === 'char' && !sheetReady()) return; // view-only group
  const { ctx, ox, oy } = activeTarget();
  const r = opRegion();
  S.clipboard = ctx.getImageData(ox + r.x, oy + r.y, r.w, r.h);
  if (S.copyNote) {
    const what = S.selection ? `selection ${r.w}×${r.h}` : labelForCell(S.selRow, S.selCol);
    S.copyNote.textContent = `Clipboard: ${S.editMode === 'item' ? `item ${r.w}×${r.h}` : what}`;
  }
}

/** Paste the clipboard at the selection's top-left (or the frame origin). */
export function pasteClipboard(): void {
  if (S.editMode === 'char' && !sheetReady()) return;
  if (!S.clipboard) return;
  const { ctx, ox, oy, w, h } = activeTarget();
  const px = S.selection ? S.selection.x : 0;
  const py = S.selection ? S.selection.y : 0;
  const cw = Math.min(S.clipboard.width, w - px);
  const ch = Math.min(S.clipboard.height, h - py);
  if (cw <= 0 || ch <= 0) return;
  pushUndo();
  const tmp = document.createElement('canvas');
  tmp.width = S.clipboard.width;
  tmp.height = S.clipboard.height;
  tmp.getContext('2d')!.putImageData(S.clipboard, 0, 0);
  ctx.clearRect(ox + px, oy + py, cw, ch); // overwrite, not alpha-blend
  ctx.drawImage(tmp, 0, 0, cw, ch, ox + px, oy + py, cw, ch);
  afterRegionEdit();
}

/** Flood-fill the contiguous same-color region at (px,py) with the current
 *  color, bounded by the frame (and clipped to the selection if one is set).
 *
 *  Region membership is by PALETTE INDEX, not raw RGBA: this is an indexed
 *  editor, so two pixels belong to the same region when they map to the same
 *  palette color (or are both transparent). Matching raw bytes instead made
 *  fills stop at any imported/anti-aliased pixel that was a hair off the
 *  start color — the "fills only some pixels" bug. */
function floodFill(px: number, py: number): void {
  const { ctx, w, h, ox, oy } = activeTarget();
  const bound = opRegion();
  if (px < bound.x || px >= bound.x + bound.w || py < bound.y || py >= bound.y + bound.h) return;
  const img = ctx.getImageData(ox, oy, w, h);
  const data = img.data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  // The palette index a pixel reads as: alpha<128 => transparent (0).
  const indexAt = (i: number) =>
    data[i + 3] < 128 ? 0 : nearestActiveIndex(data[i], data[i + 1], data[i + 2]);
  const target = indexAt(at(px, py));
  const [fr, fg, fb, fa] = fillRGBA(); // current color (transparent if clear index)
  const isFillExact = (i: number) =>
    data[i] === fr && data[i + 1] === fg && data[i + 2] === fb && data[i + 3] === fa;
  if (isFillExact(at(px, py))) return; // start pixel already the exact fill color
  pushUndo();
  // Match the start region by index, but skip pixels already written to the
  // exact fill color so the scan terminates even when fill index == target.
  const match = (i: number) => indexAt(i) === target && !isFillExact(i);
  const stack = [[px, py]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < bound.x || x >= bound.x + bound.w || y < bound.y || y >= bound.y + bound.h) continue;
    const i = at(x, y);
    if (!match(i)) continue;
    data[i] = fr;
    data[i + 1] = fg;
    data[i + 2] = fb;
    data[i + 3] = fa;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  ctx.putImageData(img, ox, oy);
  afterRegionEdit();
}

/** Apply a matrix transform (centered on the region) to the selection-or-frame,
 *  nearest-neighbour so palette colors never blend. Shared by mirror/rotate/skew. */
function transformRegion(
  set: (rctx: CanvasRenderingContext2D, w: number, h: number) => void
): void {
  if (S.editMode === 'char' && !sheetReady()) return;
  const { ctx, ox, oy } = activeTarget();
  const r = opRegion();
  pushUndo();
  const src = document.createElement('canvas');
  src.width = r.w;
  src.height = r.h;
  const sctx = src.getContext('2d')!;
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(ctx.canvas, ox + r.x, oy + r.y, r.w, r.h, 0, 0, r.w, r.h);
  const res = document.createElement('canvas');
  res.width = r.w;
  res.height = r.h;
  const rctx = res.getContext('2d')!;
  rctx.imageSmoothingEnabled = false;
  set(rctx, r.w, r.h);
  rctx.drawImage(src, 0, 0);
  rctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(ox + r.x, oy + r.y, r.w, r.h);
  ctx.drawImage(res, ox + r.x, oy + r.y);
  afterRegionEdit();
}

export function flipH(): void {
  transformRegion((rctx, w) => {
    rctx.translate(w, 0);
    rctx.scale(-1, 1);
  });
}
export function flipV(): void {
  transformRegion((rctx, _w, h) => {
    rctx.translate(0, h);
    rctx.scale(1, -1);
  });
}
/** Rotate ±90° about the region center (clips for non-square regions). */
export function rotate90(cw: boolean): void {
  transformRegion((rctx, w, h) => {
    rctx.translate(w / 2, h / 2);
    rctx.rotate((cw ? 90 : -90) * (Math.PI / 180));
    rctx.translate(-w / 2, -h / 2);
  });
}

// --- Interactive free-rotate / drag-skew --------------------------------------

/** Mouse → fractional region-local pixel coords (no clamp; can be off-region). */
function pointerFrac(e: MouseEvent): { fx: number; fy: number } {
  const rect = S.editCanvas.getBoundingClientRect();
  return { fx: (e.clientX - rect.left) / ZOOM, fy: (e.clientY - rect.top) / ZOOM };
}

/** Lift the selection-or-frame and begin an interactive rotate/skew drag. */
function beginXform(kind: 'rotate' | 'skew', fx: number, fy: number): void {
  if (S.editMode === 'char' && !sheetReady()) return;
  const { ctx, ox, oy } = activeTarget();
  const r = opRegion();
  pushUndo();
  const src = document.createElement('canvas');
  src.width = r.w;
  src.height = r.h;
  const sctx = src.getContext('2d')!;
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(ctx.canvas, ox + r.x, oy + r.y, r.w, r.h, 0, 0, r.w, r.h);
  ctx.clearRect(ox + r.x, oy + r.y, r.w, r.h); // lift (hole until baked)
  S.xformState = { kind, src, r: { ...r }, startX: fx, startY: fy, angle: 0, shearX: 0, shearY: 0 };
  S.selection = { ...r };
  S.dirty = true;
}

/** Update the live rotate angle / skew shear from the current pointer. */
function updateXform(e: MouseEvent): void {
  const st = S.xformState;
  if (!st) return;
  const { fx, fy } = pointerFrac(e);
  if (st.kind === 'rotate') {
    const cx = st.r.x + st.r.w / 2;
    const cy = st.r.y + st.r.h / 2;
    let a = Math.atan2(fy - cy, fx - cx) - Math.atan2(st.startY - cy, st.startX - cx);
    if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // 15° snap
    st.angle = a;
  } else {
    const clamp2 = (v: number) => Math.max(-2, Math.min(2, v));
    st.shearX = clamp2((fx - st.startX) / st.r.h);
    st.shearY = clamp2((fy - st.startY) / st.r.w);
  }
  S.dirty = true;
}

/** Paint the lifted source through the live matrix, clipped to the region. The
 *  caller positions the context so 1 unit = 1 region pixel at the region origin. */
export function paintXform(
  dctx: CanvasRenderingContext2D,
  st: NonNullable<typeof S.xformState>
): void {
  dctx.beginPath();
  dctx.rect(0, 0, st.r.w, st.r.h); // clip to the region (no spill into neighbours)
  dctx.clip();
  dctx.imageSmoothingEnabled = false;
  dctx.translate(st.r.w / 2, st.r.h / 2);
  if (st.kind === 'rotate') dctx.rotate(st.angle);
  else dctx.transform(1, st.shearY, st.shearX, 1, 0, 0);
  dctx.translate(-st.r.w / 2, -st.r.h / 2);
  dctx.drawImage(st.src, 0, 0);
}

/** Bake the in-progress transform into the base surface and finish. */
function finishXform(): void {
  const st = S.xformState;
  if (!st) return;
  const { ctx, ox, oy } = activeTarget();
  ctx.save();
  ctx.translate(ox + st.r.x, oy + st.r.y);
  paintXform(ctx, st);
  ctx.restore();
  S.selection = { ...st.r };
  S.xformState = null;
  afterRegionEdit();
}

/** Drop any active selection / in-progress marquee, move, or transform. */
export function clearSelection(): void {
  S.selection = null;
  S.marqueeAnchor = null;
  S.moveState = null;
  S.xformState = null;
}

/** Global mouseup: finish whatever interaction is in progress on the edit canvas. */
export function finishEditInteraction(): boolean {
  if (S.marqueeAnchor) {
    // A click with no drag (1×1) deselects; any real drag keeps the rectangle.
    if (S.selection && S.selection.w === 1 && S.selection.h === 1) S.selection = null;
    S.marqueeAnchor = null;
    S.dirty = true;
    return true;
  }
  if (S.moveState) {
    finishMove();
    return true;
  }
  if (S.xformState) {
    finishXform();
    return true;
  }
  if (S.painting && S.strokeChanged) {
    persistActive();
    // A finished character stroke may have filled (or cleared) diagonal frames;
    // refresh diag support so the test pane + world show them immediately.
    if (S.editMode === 'char') refreshDiagSupport(S.groupId);
  } else if (S.painting && !S.strokeChanged) {
    // stroke did nothing (e.g. eyedrop) — drop its snapshot from the active stack
    if (S.editMode !== 'char') activeBuffer().undo.pop();
    else S.undoStack.pop();
  }
  S.painting = false;
  return false;
}

export function setTool(t: Tool): void {
  S.tool = t;
  for (const [key, btn] of S.toolButtons) {
    btn.style.borderColor = key === t ? '#9af' : '#444';
    btn.style.color = key === t ? '#fff' : '#ddd';
  }
}

export function setColor(i: number): void {
  S.colorIndex = i;
  S.swatchEls.forEach((sw, j) => {
    sw.style.borderColor = j === i ? '#fff' : '#444';
  });
}

/** Rebuild the palette swatches for the active edit mode (char vs item). */
export function renderSwatches(): void {
  if (!S.paletteGrid) return;
  S.paletteGrid.innerHTML = '';
  S.swatchEls = [];
  const count = usesImagePalette() ? S.palette.length : ITEM_PALETTE.length;
  // In entity mode a swatch is also a recolor target: double-click opens an RGB
  // picker; the whole palette entry swaps (every pixel using it repaints).
  const editable = S.editMode === 'entity';
  for (let i = 0; i < count; i++) {
    const sw = document.createElement('div');
    sw.style.cssText =
      'width:24px;height:24px;border:2px solid #444;cursor:pointer;border-radius:2px;';
    const color = colorFor(i);
    if (color === null) {
      // Color 0 is hardware-transparent on the SNES — painting it erases.
      sw.style.background = 'repeating-conic-gradient(#555 0% 25%, #2a2a2a 0% 50%) 0 0 / 12px 12px';
      sw.title = '0: transparent';
    } else {
      sw.style.background = color;
      sw.title = editable ? `${i}: ${color} — double-click to recolor` : `${i}: ${color}`;
    }
    sw.onclick = () => setColor(i);
    if (editable && i > 0) {
      sw.ondblclick = () => {
        const inp = document.createElement('input');
        inp.type = 'color';
        const [r, g, b] = S.palette[i] ?? [0, 0, 0];
        inp.value = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        inp.style.cssText = 'position:fixed;left:-9999px;';
        document.body.appendChild(inp);
        inp.oninput = () => recolorEntityPalette(i, inp.value);
        inp.onchange = () => inp.remove();
        inp.click();
      };
    }
    S.swatchEls.push(sw);
    S.paletteGrid.appendChild(sw);
  }
  setColor(Math.min(S.colorIndex, count - 1));
}

// ---------------------------------------------------------------------------
// EDIT-canvas render
// ---------------------------------------------------------------------------

/** Edit-area stand-in for view-only groups: the sprite scaled to fit + a flag. */
function drawViewOnlyPreview(): void {
  const cv = S.editCanvas;
  if (cv.width !== FRAME_W * ZOOM || cv.height !== FRAME_H * ZOOM) {
    cv.width = FRAME_W * ZOOM;
    cv.height = FRAME_H * ZOOM;
  }
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = CHECKER_B;
  for (let y = 0; y < cv.height; y += 16) {
    for (let x = (y / 16) % 2 === 0 ? 0 : 16; x < cv.width; x += 32) ctx.fillRect(x, y, 16, 16);
  }
  const meta = getSpriteGroupMeta(S.groupId);
  const w = meta?.width ?? FRAME_W;
  const h = meta?.height ?? FRAME_H;
  const s = Math.max(1, Math.floor(Math.min((cv.width - 24) / w, (cv.height - 24) / h)));
  ctx.save();
  ctx.scale(s, s);
  drawSprite(ctx, S.groupId, Direction.S, 0, cv.width / s / 2, cv.height / s / 2 + h / 2);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('VIEW ONLY', cv.width / 2, 16);
  ctx.textAlign = 'left';
}

export function drawEditCanvas(): void {
  // Edit grid follows the active target (16x24 char cell, 16x16 item, 48x48 PSI).
  const buf = S.editMode !== 'char';
  // View-only group (vehicle): there's no editable cell — show a scaled preview.
  if (!buf && S.viewOnly) {
    drawViewOnlyPreview();
    return;
  }
  const b = buf ? activeBuffer() : null;
  const gw = b ? b.w : S.selW;
  const gh = b ? b.h : S.selH;
  if (S.editCanvas.width !== gw * ZOOM || S.editCanvas.height !== gh * ZOOM) {
    S.editCanvas.width = gw * ZOOM;
    S.editCanvas.height = gh * ZOOM;
  }

  const ctx = S.editCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Light transparency checkerboard under the frame, so the sprite's dark
  // outline stays visible (a dark field hid it).
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, S.editCanvas.width, S.editCanvas.height);
  ctx.fillStyle = CHECKER_B;
  for (let y = 0; y < gh; y++) {
    for (let x = y % 2 === 0 ? 0 : 1; x < gw; x += 2) {
      ctx.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
    }
  }

  if (b) {
    ctx.drawImage(b.canvas, 0, 0, b.w, b.h, 0, 0, gw * ZOOM, gh * ZOOM);
  } else {
    ctx.drawImage(S.sheet!, S.selOX, S.selOY, S.selW, S.selH, 0, 0, gw * ZOOM, gh * ZOOM);
  }

  // Pixel grid (dark, to read on the light checker), heavier on 8x8 SNES tiles.
  for (let x = 0; x <= gw; x++) {
    ctx.fillStyle = x % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(x * ZOOM, 0, 1, S.editCanvas.height);
  }
  for (let y = 0; y <= gh; y++) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, y * ZOOM, S.editCanvas.width, 1);
  }

  // Live rotate/skew preview rides above the (lifted) base, clipped to its region.
  if (S.xformState) {
    ctx.save();
    ctx.translate(S.xformState.r.x * ZOOM, S.xformState.r.y * ZOOM);
    ctx.scale(ZOOM, ZOOM);
    paintXform(ctx, S.xformState);
    ctx.restore();
    strokeRectAnts(ctx, S.xformState.r.x, S.xformState.r.y, S.xformState.r.w, S.xformState.r.h);
  } else if (S.moveState) {
    // Floating (being-moved) pixels ride above the base; selection draws as ants.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      S.moveState.pixels,
      0,
      0,
      S.moveState.w,
      S.moveState.h,
      S.moveState.x * ZOOM,
      S.moveState.y * ZOOM,
      S.moveState.w * ZOOM,
      S.moveState.h * ZOOM
    );
    strokeRectAnts(ctx, S.moveState.x, S.moveState.y, S.moveState.w, S.moveState.h);
  } else if (S.selection) {
    strokeRectAnts(ctx, S.selection.x, S.selection.y, S.selection.w, S.selection.h);
  }
}
