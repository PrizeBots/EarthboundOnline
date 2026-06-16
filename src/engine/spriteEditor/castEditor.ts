// The character-sheet surface: roster + per-group loading (live ROM/PoseGen
// sheet + pristine diff copy), custom-frame authoring (Sheet panel), the FRAMES
// strip render, save-diffing to overrides/sprites.json, rename, and the labeled
// PNG export/import artist handoff. Shares the pixel engine via ./pixelCanvas and
// global state S.
import { loadJSON } from '../AssetLoader';
import {
  getSpriteGroupMeta,
  loadSpriteGroup,
  getLiveSheet,
  getPristineSheet,
  getSourceSheet,
  refreshDiagSupport,
  SpriteOverrides,
} from '../SpriteManager';
import { getSpriteName, setSpriteNameOverride, getNameOverrides } from '../SpriteNames';
import { getItemName, ITEM_W, ITEM_H, ITEM_FRAMES } from '../Items';
import { Direction } from '../../types';
import {
  FRAME_W,
  FRAME_H,
  SHEET_W,
  SHEET_H,
  SHEET_COLS,
  SHEET_ROWS,
  ATTACK_ROW_START,
  DEFAULT_GROUP,
  STRIP_W,
  STRIP_SCALE,
  STRIP_FRAME_W,
  STRIP_FRAME_H,
  DIR_BASE,
  DISPLAY_ROWS,
  DisplaySet,
  CustomFrame,
  FramesDoc,
  StripCell,
  BAND_Y,
  BAND_H,
  EXPORT_ORIG_ROWS,
  EXPORT_CUST_ROWS,
  EXPORT_ORIG_H,
  EXPORT_CUST_H,
  EXPORT_CUST_SRC_Y,
  EXPORT_HDR_W,
  EXPORT_HDR_H,
  EXPORT_ORIG_Y,
  EXPORT_MID_Y,
  EXPORT_CUST_Y,
  EXPORT_W,
  EXPORT_H,
  SHEET_PANEL_SCALE,
  SHEET_DRAG_PAD,
  SRC_CELL_LABEL,
  vehicleName,
  setSrc,
  snap8,
  exportRowY,
  cellHasContent,
  safeName,
  downloadCanvasPNG,
  snapImageToPalette,
  cropImageData,
  imageToData,
  fillChecker,
  stripGutterX,
  stripFramesX,
} from './constants';
import { S } from './state';
import { postOverride } from './saveChannel';
import {
  sheetReady,
  pushUndo,
  syncMirrorCell,
  clearSelection,
  renderSwatches,
} from './pixelCanvas';
import { itemStripCells, applyImportedItemImage } from './itemEditor';

// ---------------------------------------------------------------------------
// Cast roster + per-character loading
// ---------------------------------------------------------------------------

/** Load the char-select roster (the 16x24 cast) for the character dropdown. */
export async function loadRoster(): Promise<void> {
  if (S.roster.length) return;
  try {
    S.roster = await loadJSON<number[]>('/assets/sprites/characters.json');
  } catch {
    S.roster = [DEFAULT_GROUP];
  }
}

/** Load any saved attack/hurt overrides so edits start from the live state. */
export async function loadOverridesDoc(): Promise<void> {
  try {
    S.overridesDoc = await loadJSON<SpriteOverrides>('/overrides/sprites.json');
    S.overridesDoc.groups ??= {};
  } catch {
    S.overridesDoc = { version: 1, groups: {} };
  }
  try {
    S.framesDoc = await loadJSON<FramesDoc>('/overrides/sprite_frames.json');
    S.framesDoc.groups ??= {};
  } catch {
    S.framesDoc = { version: 1, groups: {} };
  }
}

async function loadGroupPalette(palIdx: number): Promise<void> {
  const palettes = await loadJSON<number[][][]>('/assets/sprites/palettes.json');
  const pal = palettes[palIdx] ?? palettes[5] ?? [];
  S.palette = pal.map((c) => [c[0], c[1], c[2]]);
}

/**
 * Point the editor at a cast character. Loads the group's live pose sheet
 * (ROM walk/climb + PoseGen attack/hurt + any saved overrides) plus a pristine
 * copy for diffing. The editor paints straight into the live sheet, so the
 * test pane and the running world both update as you draw.
 */
export async function loadGroupIntoEditor(id: number): Promise<void> {
  await loadSpriteGroup(id);
  const meta = getSpriteGroupMeta(id);
  const live = getLiveSheet(id);
  if (!meta || !live || meta.width !== FRAME_W || meta.height !== FRAME_H) {
    // Non-cast sprite (vehicles): show it in the preview + test pane, but keep
    // the 16x24 paint pipeline off. sheet=null gates every editing path.
    S.viewOnly = true;
    S.groupId = id;
    S.sheet = null;
    S.sheetCtx = null;
    S.pristineSheet = null;
    S.undoStack = [];
    S.walkerPose = 'walk';
    S.walkerDir = Direction.S;
    S.walkerFrame = 0;
    S.walkerItem = null;
    S.charPicker?.setValue(String(id));
    if (S.nameInput) S.nameInput.value = getSpriteName(id) ?? '';
    const nm = getSpriteName(id) ?? vehicleName(id) ?? `#${id}`;
    if (S.charNote) {
      S.charNote.textContent = meta
        ? `View only — ${nm} (${meta.width}×${meta.height})`
        : `#${id} has no sprite metadata`;
    }
    renderCharThumb();
    S.dirty = true;
    return;
  }
  S.viewOnly = false;
  S.groupId = id;
  S.sheet = live;
  S.sheetCtx = live.getContext('2d', { willReadFrequently: true })!;
  S.pristineSheet = getPristineSheet(id);
  S.undoStack = [];
  await loadGroupPalette(meta.palette);
  loadCustomFrames(id); // grows the sheet + repaints any saved custom frames
  // Land on the south-facing attack frame — the first editable cell.
  S.selRow = ATTACK_ROW_START + DIR_BASE.S.row;
  S.selCol = DIR_BASE.S.col;
  S.selW = FRAME_W;
  S.selH = FRAME_H;
  S.selOX = S.selCol * FRAME_W;
  S.selOY = S.selRow * FRAME_H;
  S.walkerPose = 'walk';
  S.walkerDir = Direction.S;
  S.walkerClimb = null;
  S.addingFrame = false;
  S.frameDrag = null;
  S.charPicker?.setValue(String(id));
  if (S.nameInput) S.nameInput.value = getSpriteName(id) ?? '';
  updateCharNote();
  renderCharThumb();
  renderSwatches();
  S.dirty = true;
}

// ---------------------------------------------------------------------------
// Custom frames (Sheet panel)
// ---------------------------------------------------------------------------

/** Grow the live sheet canvas in place (preserving pixels) to at least w x h. */
function growSheetCanvas(w: number, h: number): void {
  if (!S.sheet) return;
  if (S.sheet.width >= w && S.sheet.height >= h) return;
  const nw = Math.max(S.sheet.width, w);
  const nh = Math.max(S.sheet.height, h);
  const tmp = document.createElement('canvas');
  tmp.width = S.sheet.width;
  tmp.height = S.sheet.height;
  tmp.getContext('2d')!.drawImage(S.sheet, 0, 0);
  S.sheet.width = nw; // resizing clears the canvas...
  S.sheet.height = nh;
  S.sheetCtx = S.sheet.getContext('2d', { willReadFrequently: true })!;
  S.sheetCtx.imageSmoothingEnabled = false;
  S.sheetCtx.drawImage(tmp, 0, 0); // ...so restore the old pixels
}

/** Load + repaint this group's saved custom frames, growing the sheet to fit. */
function loadCustomFrames(id: number): void {
  S.customFrames = (S.framesDoc.groups ??= {})[String(id)] ?? [];
  S.sheetPxW = SHEET_W;
  S.sheetPxH = SHEET_H;
  for (const f of S.customFrames) {
    S.sheetPxW = Math.max(S.sheetPxW, f.x + f.w);
    S.sheetPxH = Math.max(S.sheetPxH, f.y + f.h);
  }
  growSheetCanvas(S.sheetPxW, S.sheetPxH);
  for (const f of S.customFrames) {
    if (!f.pixels) continue;
    const img = new Image();
    img.onload = () => {
      S.sheetCtx?.drawImage(img, f.x, f.y);
      S.dirty = true;
    };
    img.src = f.pixels;
  }
}

// Thin shims so existing call sites keep working: point the picker at the
// current selection and redraw its sprite preview (trigger + open row).
export function renderCharThumb(): void {
  S.charPicker?.setValue(String(S.groupId));
}

export function updateCharNote(suffix = ''): void {
  if (!S.charNote) return;
  const star = S.overridesDoc.groups?.[String(S.groupId)] ? ' ★ edited' : '';
  S.charNote.textContent = `${getSpriteName(S.groupId) ?? `#${S.groupId}`}${star}${suffix}`;
}

/**
 * Every row is editable. Walk/climb frames used to be ROM-locked, but admins
 * need to author the directional frames many NPCs never got. Save still diffs
 * vs the generated/ROM pristine sheet, so only hand-painted pixels are stored.
 */
function editableRow(_row: number): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// Save: diff the WHOLE live sheet vs pristine -> overrides/sprites.json.
// ---------------------------------------------------------------------------

export function captureGroupDiff(): void {
  if (!sheetReady()) return;
  const w = SHEET_W;
  const liveD = S.sheetCtx!.getImageData(0, BAND_Y, w, BAND_H);
  const prisD = S.pristineSheet!.getContext('2d')!.getImageData(0, BAND_Y, w, BAND_H);

  const paint = document.createElement('canvas');
  const erase = document.createElement('canvas');
  paint.width = erase.width = w;
  paint.height = erase.height = BAND_H;
  const paintD = paint.getContext('2d')!.createImageData(w, BAND_H);
  const eraseD = erase.getContext('2d')!.createImageData(w, BAND_H);
  let paintCount = 0;
  let eraseCount = 0;
  for (let i = 0; i < liveD.data.length; i += 4) {
    const same =
      liveD.data[i] === prisD.data[i] &&
      liveD.data[i + 1] === prisD.data[i + 1] &&
      liveD.data[i + 2] === prisD.data[i + 2] &&
      liveD.data[i + 3] === prisD.data[i + 3];
    if (same) continue;
    if (liveD.data[i + 3] === 0) {
      eraseD.data[i + 3] = 255; // pixel removed vs the generated frame
      eraseCount++;
    } else {
      paintD.data[i] = liveD.data[i];
      paintD.data[i + 1] = liveD.data[i + 1];
      paintD.data[i + 2] = liveD.data[i + 2];
      paintD.data[i + 3] = liveD.data[i + 3];
      paintCount++;
    }
  }
  const groups = (S.overridesDoc.groups ??= {});
  const key = String(S.groupId);
  if (paintCount === 0 && eraseCount === 0) {
    delete groups[key]; // back to the generated frames — drop the entry
    return;
  }
  paint.getContext('2d')!.putImageData(paintD, 0, 0);
  erase.getContext('2d')!.putImageData(eraseD, 0, 0);
  const entry: { paint?: string; erase?: string; band?: number } = { band: 0 };
  if (paintCount > 0) entry.paint = paint.toDataURL();
  if (eraseCount > 0) entry.erase = erase.toDataURL();
  groups[key] = entry;
}

/** Snapshot every custom frame's current pixels into framesDoc (for persistence). */
export function captureCustomFramePixels(): void {
  if (!S.customFrames.length || !S.sheet) return;
  for (const f of S.customFrames) {
    const tmp = document.createElement('canvas');
    tmp.width = f.w;
    tmp.height = f.h;
    tmp.getContext('2d')!.drawImage(S.sheet, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    f.pixels = tmp.toDataURL();
  }
}

/** Create a new custom frame from a sheet-pixel rect, name it, select + persist it. */
function addCustomFrame(x: number, y: number, w: number, h: number): void {
  if (!S.sheet) return;
  const name = window.prompt('New frame name:', `frame ${S.customFrames.length + 1}`);
  if (!name) return;
  growSheetCanvas(x + w, y + h);
  S.sheetPxW = Math.max(S.sheetPxW, x + w);
  S.sheetPxH = Math.max(S.sheetPxH, y + h);
  const frame: CustomFrame = {
    name: name.trim() || `frame ${S.customFrames.length + 1}`,
    x,
    y,
    w,
    h,
  };
  S.customFrames.push(frame);
  (S.framesDoc.groups ??= {})[String(S.groupId)] = S.customFrames;
  // Select the new (blank) frame so it can be drawn immediately.
  S.selOX = x;
  S.selOY = y;
  S.selW = w;
  S.selH = h;
  S.selRow = Math.floor(y / FRAME_H);
  S.selCol = Math.floor(x / FRAME_W);
  clearSelection();
  captureCustomFramePixels();
  void postOverride('sprite_frames.json', S.framesDoc).catch(() => {});
  S.dirty = true;
}

/**
 * Rename the active character. Writes the display-name override to
 * overrides/names.json (empty / unchanged-from-base clears it) and refreshes
 * the dropdown entry + note. Names ship — no ROM data involved.
 */
export function saveCharName(): void {
  if (!S.open || !S.nameInput) return;
  const name = S.nameInput.value.trim();
  setSpriteNameOverride(S.groupId, name || null);
  // Reflect the resolved name (override or baked base) back into the field + UI.
  const resolved = getSpriteName(S.groupId) ?? '';
  S.nameInput.value = resolved;
  S.charPicker?.refresh(); // relabel the option rows + trigger with the new name
  void postOverride('names.json', getNameOverrides())
    .then(() => updateCharNote(' — renamed'))
    .catch((err) => {
      if (S.charNote) S.charNote.textContent = `rename failed: ${String(err)}`;
    });
}

/** Restore the selected frame to its generated (pristine) pixels. */
export function resetSelectedFrame(): void {
  if (!sheetReady() || !editableRow(S.selRow)) return;
  pushUndo();
  S.sheetCtx!.clearRect(S.selOX, S.selOY, S.selW, S.selH);
  // Custom frames (below the base sheet) have no pristine pixels — reset = clear.
  if (S.selOY + S.selH <= S.pristineSheet!.height && S.selOX + S.selW <= S.pristineSheet!.width) {
    S.sheetCtx!.drawImage(
      S.pristineSheet!,
      S.selOX,
      S.selOY,
      S.selW,
      S.selH,
      S.selOX,
      S.selOY,
      S.selW,
      S.selH
    );
  }
  syncMirrorCell(S.selRow, S.selCol);
  S.dirty = true;
}

// ---------------------------------------------------------------------------
// Labeled comparison PNG export / import (artist handoff)
// ---------------------------------------------------------------------------

/**
 * Faint EMPTY BOX outlining every slot — in EITHER band — that this character is
 * missing but Ness (the master) has. Boxes are low alpha (<128); import treats
 * alpha <128 as transparent, so untouched guides are never saved as art.
 */
function drawMissingFrameBoxes(ctx: CanvasRenderingContext2D): void {
  const ness = S.groupId === DEFAULT_GROUP ? null : getLiveSheet(DEFAULT_GROUP);
  const nessCtx = ness?.getContext('2d', { willReadFrequently: true }) ?? null;
  if (!nessCtx) return;
  ctx.fillStyle = 'rgba(120,150,200,0.30)'; // ~76 alpha — visible, dropped on import
  for (let r = 0; r < SHEET_ROWS; r++) {
    for (let c = 0; c < SHEET_COLS; c++) {
      if (cellHasContent(S.sheetCtx!, c, r)) continue; // char already has this frame
      if (!cellHasContent(nessCtx, c, r)) continue; // Ness lacks it too — not "missing"
      const x = EXPORT_HDR_W + c * FRAME_W;
      const y = exportRowY(r);
      ctx.fillRect(x, y, FRAME_W, 1); // top
      ctx.fillRect(x, y + FRAME_H - 1, FRAME_W, 1); // bottom
      ctx.fillRect(x, y, 1, FRAME_H); // left
      ctx.fillRect(x + FRAME_W - 1, y, 1, FRAME_H); // right
    }
  }
}

/** Paint the A/B/C column letters + row numbers into the margins. */
function drawExportLabels(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#16161e';
  ctx.fillRect(0, 0, EXPORT_HDR_W, EXPORT_H); // left row-number column
  ctx.fillRect(0, 0, EXPORT_W, EXPORT_HDR_H); // original band header strip
  ctx.fillRect(0, EXPORT_MID_Y, EXPORT_W, EXPORT_HDR_H); // custom band header strip

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // column letters A B C … across both header strips
  ctx.fillStyle = '#9af';
  ctx.font = 'bold 11px monospace';
  for (let c = 0; c < SHEET_COLS; c++) {
    const x = EXPORT_HDR_W + c * FRAME_W + FRAME_W / 2;
    const letter = String.fromCharCode(65 + c);
    ctx.fillText(letter, x, EXPORT_HDR_H / 2);
    ctx.fillText(letter, x, EXPORT_MID_Y + EXPORT_HDR_H / 2);
  }

  // row numbers — the sheet's real 1-based row index, so a frame names uniquely
  ctx.fillStyle = '#ddd';
  ctx.font = 'bold 10px monospace';
  for (let r = 0; r < EXPORT_ORIG_ROWS; r++) {
    ctx.fillText(String(r + 1), EXPORT_HDR_W / 2, EXPORT_ORIG_Y + r * FRAME_H + FRAME_H / 2);
  }
  for (let r = 0; r < EXPORT_CUST_ROWS; r++) {
    const sheetRow = ATTACK_ROW_START + r;
    ctx.fillText(String(sheetRow + 1), EXPORT_HDR_W / 2, EXPORT_CUST_Y + r * FRAME_H + FRAME_H / 2);
  }

  // band tags in the corner cells
  ctx.fillStyle = '#6c8';
  ctx.font = 'bold 7px monospace';
  ctx.fillText('ORIG', EXPORT_HDR_W / 2, EXPORT_HDR_H / 2);
  ctx.fillText('CUST', EXPORT_HDR_W / 2, EXPORT_MID_Y + EXPORT_HDR_H / 2);
}

/** Build the labeled comparison export: ROM frames (walk/climb) on top, editable
 *  attack/hurt frames below, with column-letter / row-number headers in the margins. */
function buildExportSheet(): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = EXPORT_W;
  out.height = EXPORT_H;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  // ORIGINAL band: walk + climb (rows 0-4)
  ctx.drawImage(
    S.sheet!,
    0,
    0,
    SHEET_W,
    EXPORT_ORIG_H,
    EXPORT_HDR_W,
    EXPORT_ORIG_Y,
    SHEET_W,
    EXPORT_ORIG_H
  );
  // CUSTOM band: attack + hurt (rows 5-12)
  ctx.drawImage(
    S.sheet!,
    0,
    EXPORT_CUST_SRC_Y,
    SHEET_W,
    EXPORT_CUST_H,
    EXPORT_HDR_W,
    EXPORT_CUST_Y,
    SHEET_W,
    EXPORT_CUST_H
  );
  drawMissingFrameBoxes(ctx);

  drawExportLabels(ctx);
  return out;
}

/** Export the active surface (character sheet or item buffer) as a 1x PNG. */
export function exportPNG(): void {
  if (S.editMode === 'item') {
    if (!S.itemCanvas) return;
    downloadCanvasPNG(S.itemCanvas, `${safeName(S.itemEditId)}_item.png`);
    if (S.itemNote)
      S.itemNote.textContent = `Exported ${ITEM_W}×${ITEM_H} PNG: ${getItemName(S.itemEditId) ?? S.itemEditId}`;
    return;
  }
  if (!S.sheet) {
    if (S.charNote) S.charNote.textContent = 'Nothing to export (view-only group)';
    return;
  }
  const name = safeName(getSpriteName(S.groupId) ?? `char_${S.groupId}`);
  downloadCanvasPNG(buildExportSheet(), `${name}_${S.groupId}_sheet.png`);
  updateCharNote(
    ` — exported ${EXPORT_W}×${EXPORT_H} PNG (original top · custom bottom · A–D cols · 1–${SHEET_ROWS} rows)`
  );
}

/** Open a file picker and import a PNG back into the active surface. */
export function importPNG(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/*';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      applyImportedImage(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const note = S.editMode === 'item' ? S.itemNote : S.charNote;
      if (note) note.textContent = 'Import failed: not a readable image';
    };
    img.src = url;
  };
  input.click();
}

/** Snap + write a loaded image into the active surface (dimensions must match). */
function applyImportedImage(img: HTMLImageElement): void {
  if (S.editMode === 'item') {
    applyImportedItemImage(img); // 16x16 item buffer import lives with the item editor
    return;
  }
  if (!sheetReady()) {
    if (S.charNote) S.charNote.textContent = 'Select an editable character first';
    return;
  }
  if (img.width !== EXPORT_W || img.height !== EXPORT_H) {
    if (S.charNote)
      S.charNote.textContent = `Import needs ${EXPORT_W}×${EXPORT_H} sheet (got ${img.width}×${img.height})`;
    return;
  }
  // Pull both sprite bands out of the labeled sheet (skipping the header margins)
  // and write each onto its rows. ROM frames re-imported match pristine, so Save
  // still won't re-save them — only the artist's hand-painted blanks persist.
  const full = imageToData(img, EXPORT_W, EXPORT_H);
  const origBand = cropImageData(full, EXPORT_HDR_W, EXPORT_ORIG_Y, SHEET_W, EXPORT_ORIG_H);
  const custBand = cropImageData(full, EXPORT_HDR_W, EXPORT_CUST_Y, SHEET_W, EXPORT_CUST_H);
  pushUndo();
  S.sheetCtx!.putImageData(snapImageToPalette(origBand, S.palette), 0, 0);
  S.sheetCtx!.putImageData(snapImageToPalette(custBand, S.palette), 0, EXPORT_CUST_SRC_Y);
  refreshDiagSupport(S.groupId); // import may add/remove diagonal frames
  updateCharNote(' — imported (auto-saved)'); // pushUndo above schedules the save
  S.dirty = true;
}

// ---------------------------------------------------------------------------
// FRAMES strip render
// ---------------------------------------------------------------------------

/** Built-in pose rows plus one row per user-defined custom frame. */
export function allDisplayRows(): DisplaySet[][] {
  const custom: DisplaySet[][] = S.customFrames.map((f) => [
    { label: f.name, row: 0, col: 0, single: { w: f.w, h: f.h }, px: f.x, py: f.y },
  ]);
  return [...DISPLAY_ROWS, ...custom];
}
/** Current strip canvas height (grows with custom-frame rows). */
export function stripHeight(): number {
  return allDisplayRows().length * STRIP_FRAME_H;
}

/** Read-only frame grid (vehicles, items): every frame the object has, scaled
 *  to fit, labeled. Resizes the strip canvas to the content. */
function drawFramesGrid(cells: StripCell[], cols: number): void {
  const ctx = S.stripCanvas.getContext('2d')!;
  S.stripCellRects = [];
  if (cells.length === 0) {
    S.stripCanvas.width = STRIP_W;
    S.stripCanvas.height = 36;
    ctx.fillStyle = '#1f1f2a';
    ctx.fillRect(0, 0, S.stripCanvas.width, S.stripCanvas.height);
    ctx.fillStyle = '#8895aa';
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('no frames', 8, 18);
    return;
  }
  const fw = Math.max(...cells.map((c) => c.w));
  const fh = Math.max(...cells.map((c) => c.h));
  // Integer scale toward a ~52px target: small cast frames enlarge, big vehicle
  // frames sit at 1x.
  const scale = Math.max(1, Math.round(52 / Math.max(fw, fh)));
  const PAD = 4;
  const LABEL = 12;
  const GAP = 4;
  const cw = fw * scale + PAD * 2;
  const ch = fh * scale + PAD * 2 + LABEL;
  const rows = Math.ceil(cells.length / cols);
  S.stripCanvas.width = cols * cw + GAP * (cols + 1);
  S.stripCanvas.height = rows * ch + GAP * (rows + 1);
  ctx.imageSmoothingEnabled = false; // resize reset context state
  ctx.fillStyle = '#1f1f2a';
  ctx.fillRect(0, 0, S.stripCanvas.width, S.stripCanvas.height);
  ctx.font = '9px monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const selectable = S.editMode === 'item'; // item frames are clickable to edit
  cells.forEach((cell, i) => {
    const cx = GAP + (i % cols) * (cw + GAP);
    const cy = GAP + Math.floor(i / cols) * (ch + GAP);
    S.stripCellRects.push({ x: cx, y: cy, w: cw, h: ch });
    const active = selectable && i === S.itemEditFrame;
    if (active) {
      // Tint the whole cell so the frame being edited stands out.
      ctx.fillStyle = '#26314a';
      ctx.fillRect(cx, cy, cw, ch);
    }
    ctx.fillStyle = active ? '#fff' : '#cdd6e6';
    ctx.fillText(cell.label, cx + cw / 2, cy + LABEL / 2 + 1);
    const bx = cx + PAD;
    const by = cy + LABEL;
    const bw = fw * scale;
    const bh = fh * scale;
    fillChecker(ctx, bx, by, bw, bh);
    const dw = cell.w * scale;
    const dh = cell.h * scale;
    cell.draw(ctx, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh); // center smaller frames
    ctx.strokeStyle = active ? '#9af' : '#888';
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  });
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
}

/** Every source frame of the current (view-only) group, in sheet order. */
function vehicleStripCells(): StripCell[] {
  const src = getSourceSheet(S.groupId);
  if (!src) return [];
  const { img, frameW, frameH, cols, rows } = src;
  const cells: StripCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        label: SRC_CELL_LABEL[`${r},${c}`] ?? `${r},${c}`,
        w: frameW,
        h: frameH,
        draw: (ctx, dx, dy, dw, dh) =>
          ctx.drawImage(img, c * frameW, r * frameH, frameW, frameH, dx, dy, dw, dh),
      });
    }
  }
  return cells;
}

export function drawStrip(): void {
  // Item / view-only groups show a read-only grid of every frame they have.
  if (S.editMode === 'item') {
    drawFramesGrid(itemStripCells(), ITEM_FRAMES); // the 3 swing frames, side by side
    return;
  }
  if (S.viewOnly) {
    drawFramesGrid(vehicleStripCells(), getSourceSheet(S.groupId)?.cols ?? 4);
    return;
  }

  // Editable character: the canonical walk/climb/attack/hurt pose strip.
  const sh = stripHeight();
  if (S.stripCanvas.width !== STRIP_W || S.stripCanvas.height !== sh) {
    S.stripCanvas.width = STRIP_W;
    S.stripCanvas.height = sh;
  }
  const ctx = S.stripCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Panel-dark fill so the label gutters blend in; frame sets get a light
  // checker drawn over them below.
  ctx.fillStyle = '#1f1f2a';
  ctx.fillRect(0, 0, STRIP_W, sh);
  ctx.textBaseline = 'middle';
  ctx.font = '10px monospace';

  if (!S.sheet) {
    ctx.fillStyle = '#8895aa';
    ctx.fillText('no frames', 8, 18);
    return;
  }

  const rows = allDisplayRows();
  for (let dr = 0; dr < rows.length; dr++) {
    const y = dr * STRIP_FRAME_H;
    rows[dr].forEach((set, s) => {
      const fx = stripFramesX(s);

      // Label in the gutter to the LEFT of this set.
      ctx.fillStyle = '#cdd6e6';
      ctx.fillText(set.label, stripGutterX(s) + 4, y + STRIP_FRAME_H / 2);

      fillChecker(ctx, fx, y, STRIP_FRAME_W * 2, STRIP_FRAME_H);

      if (set.single) {
        // ONE sprite (e.g. lay E 24x16, or a custom frame) — drawn whole.
        const src = setSrc(set);
        const dw = set.single.w * STRIP_SCALE;
        const dh = set.single.h * STRIP_SCALE;
        ctx.drawImage(S.sheet!, src.x, src.y, set.single.w, set.single.h, fx, y, dw, dh);
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 1;
        ctx.strokeRect(fx + 0.5, y + 0.5, dw - 1, dh - 1);
        if (S.selOX === src.x && S.selOY === src.y) {
          ctx.strokeStyle = '#ff0';
          ctx.lineWidth = 2;
          ctx.strokeRect(fx + 1, y + 1, dw - 2, dh - 2);
        }
        return;
      }

      // 2-frame set: two 16x24 cells side by side.
      for (let i = 0; i < 2; i++) {
        ctx.drawImage(
          S.sheet!,
          (set.col + i) * FRAME_W,
          set.row * FRAME_H,
          FRAME_W,
          FRAME_H,
          fx + i * STRIP_FRAME_W,
          y,
          STRIP_FRAME_W,
          STRIP_FRAME_H
        );
      }
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      for (let i = 0; i < 2; i++) {
        ctx.strokeRect(fx + i * STRIP_FRAME_W + 0.5, y + 0.5, STRIP_FRAME_W - 1, STRIP_FRAME_H - 1);
      }
      if (S.selRow === set.row && (S.selCol === set.col || S.selCol === set.col + 1)) {
        const selX = fx + (S.selCol - set.col) * STRIP_FRAME_W;
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 2;
        ctx.strokeRect(selX + 1, y + 1, STRIP_FRAME_W - 2, STRIP_FRAME_H - 2);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// SHEET panel: the whole sheet, scaled. "New Frame" drag-selects a region.
// ---------------------------------------------------------------------------

export function syncNewFrameBtn(): void {
  if (!S.newFrameBtn) return;
  S.newFrameBtn.textContent = S.addingFrame ? '✕ Cancel new frame' : '+ New Frame';
  S.newFrameBtn.style.background = S.addingFrame ? '#553030' : '#2a3550';
}

/** Sheet-canvas pixel (snapped) from a mouse event. */
function sheetEventPx(e: MouseEvent): { x: number; y: number } {
  const r = S.sheetCanvas!.getBoundingClientRect();
  return {
    x: snap8((e.clientX - r.left) / SHEET_PANEL_SCALE),
    y: snap8((e.clientY - r.top) / SHEET_PANEL_SCALE),
  };
}

export function onSheetDown(e: MouseEvent): void {
  if (!S.addingFrame || !S.sheet) return;
  const p = sheetEventPx(e);
  S.frameDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  S.dirty = true;
}

export function onSheetMove(e: MouseEvent): void {
  if (!S.addingFrame || !S.frameDrag) return;
  const p = sheetEventPx(e);
  S.frameDrag.x1 = p.x;
  S.frameDrag.y1 = p.y;
  S.dirty = true;
}

export function onSheetUp(): void {
  if (!S.addingFrame || !S.frameDrag) return;
  const x = Math.min(S.frameDrag.x0, S.frameDrag.x1);
  const y = Math.min(S.frameDrag.y0, S.frameDrag.y1);
  const w = Math.abs(S.frameDrag.x1 - S.frameDrag.x0);
  const h = Math.abs(S.frameDrag.y1 - S.frameDrag.y0);
  S.frameDrag = null;
  S.addingFrame = false;
  syncNewFrameBtn();
  if (w >= 8 && h >= 8) addCustomFrame(x, y, w, h);
  S.dirty = true;
}

export function drawSheetPanel(): void {
  if (!S.sheetCanvas || !S.sheet) return;
  const sc = SHEET_PANEL_SCALE;
  const wPx = Math.max(S.sheetPxW, S.sheet.width);
  const hPx = Math.max(S.sheetPxH, S.sheet.height) + SHEET_DRAG_PAD;
  if (S.sheetCanvas.width !== wPx * sc || S.sheetCanvas.height !== hPx * sc) {
    S.sheetCanvas.width = wPx * sc;
    S.sheetCanvas.height = hPx * sc;
  }
  const ctx = S.sheetCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // backing + the drag-zone band below the sheet
  ctx.fillStyle = '#15151c';
  ctx.fillRect(0, 0, S.sheetCanvas.width, S.sheetCanvas.height);
  ctx.fillStyle = '#1b1b24';
  ctx.fillRect(
    0,
    S.sheet.height * sc,
    S.sheetCanvas.width,
    S.sheetCanvas.height - S.sheet.height * sc
  );

  ctx.drawImage(
    S.sheet,
    0,
    0,
    S.sheet.width,
    S.sheet.height,
    0,
    0,
    S.sheet.width * sc,
    S.sheet.height * sc
  );

  // Outline + label each custom frame.
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.textBaseline = 'bottom';
  for (const f of S.customFrames) {
    ctx.strokeStyle = S.selOX === f.x && S.selOY === f.y ? '#ff0' : '#6cf';
    ctx.strokeRect(f.x * sc + 0.5, f.y * sc + 0.5, f.w * sc - 1, f.h * sc - 1);
    ctx.fillStyle = '#9cf';
    ctx.fillText(f.name, f.x * sc + 2, f.y * sc - 1);
  }

  // In-progress drag rect.
  if (S.frameDrag) {
    const x = Math.min(S.frameDrag.x0, S.frameDrag.x1) * sc;
    const y = Math.min(S.frameDrag.y0, S.frameDrag.y1) * sc;
    const w = Math.abs(S.frameDrag.x1 - S.frameDrag.x0) * sc;
    const h = Math.abs(S.frameDrag.y1 - S.frameDrag.y0) * sc;
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}
