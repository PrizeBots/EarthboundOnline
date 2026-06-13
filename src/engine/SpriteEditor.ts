import { loadImage, loadJSON } from './AssetLoader';
import { registerCustomSprite, drawSprite, getSpriteGroupMeta } from './SpriteManager';
import { drawHeldItem, isItemBehind, nextHeldItem, getItemName } from './Items';
import { Direction, Pose } from '../types';

// The character creation screen: a pixel editor over the Ness sheet template.
// Opens as a DOM overlay on top of the game canvas (the 256x224 game screen
// is too small for per-pixel work). Edits live on an in-memory canvas
// persisted to localStorage — the extracted PNGs on disk are never touched.
// Confirming hands the finished sheet back as a PNG data URL.

const FRAME_W = 16;
const FRAME_H = 24;
const SHEET_COLS = 4;
// Sheet v3: walk rows 0-3, climb row 4 (ladder f0/f1, rope f0/f1), attack
// rows 5-8, hurt rows 9-12 — attack and hurt share the walk direction layout
// (8 dirs x 2 frames). Left/right are mirror-equal in EB, so the editor only
// lets you draw N/S/E/NE/SE and auto-fills W/NW/SW as horizontal flips.
const SHEET_ROWS = 13;
const SHEET_W = FRAME_W * SHEET_COLS;
const SHEET_H = FRAME_H * SHEET_ROWS;
const CLIMB_ROW = 4;
const ATTACK_ROW_START = 5;
const HURT_ROW_START = 9;

const NESS_GROUP = 1;
const LADDER_GROUP = 17;
const ROPE_GROUP = 21;

const ZOOM = 16;            // edit canvas: 1 sprite pixel = 16 screen pixels
const STRIP_SCALE = 2;      // frame-strip preview scale (13 rows, overlay scrolls)
const TEST_W = 192;         // WASD test pane, logical pixels
const TEST_H = 144;
const TEST_SCALE = 2;

// FRAMES strip layout: two 2-frame sets per display row, each with a label
// gutter to its LEFT. Only canonical directions are shown (see DISPLAY_ROWS);
// STRIP_H is derived from the display row count below.
const STRIP_FRAME_W = FRAME_W * STRIP_SCALE;
const STRIP_FRAME_H = FRAME_H * STRIP_SCALE;
const STRIP_SET_W = 2 * STRIP_FRAME_W;        // a 2-frame set
const STRIP_GUTTER = 54;                       // label column width (fits "hurt NE")
const STRIP_W = 2 * (STRIP_GUTTER + STRIP_SET_W);

// Light checkerboard tones for the sprite surfaces (strip + edit canvas). A
// dark field swallowed the sprites' dark outlines; light keeps them visible
// while still reading as transparent (and white highlights survive too).
const CHECKER_A = '#d8d8e0';
const CHECKER_B = '#bcbcc8';

// Synthetic sprite group for the live test pane — far above the ids
// registerCustomSheet hands out (CUSTOM_GROUP_BASE + small counts).
const PREVIEW_GROUP = 999999;

const STORAGE_KEY = 'eb_sprite_editor_sheet';
const UNDO_LIMIT = 64;

type Tool = 'pencil' | 'eraser' | 'eyedrop';

// ---------------------------------------------------------------------------
// Left/right mirroring. EB's west-facing frames are exact horizontal flips of
// the east-facing ones (verified pixel-for-pixel on the Ness sheet). The editor
// only EDITS — and only SHOWS — the canonical directions (N/S/E/NE/SE); each
// paint auto-fills the W/NW/SW partner cell as a flip. N/S are unique
// (front/back, not mirrorable). The full 8-direction result is visible in the
// live test pane. Applies to every direction-based block: walk, attack, hurt.
// ---------------------------------------------------------------------------

// Each direction's frame-0 cell within a block (frame 1 is col + 1). Matches
// SpriteManager's DIRECTION_LAYOUT.
const DIR_BASE: Record<string, { row: number; col: number }> = {
  N: { row: 0, col: 0 },
  E: { row: 0, col: 2 },
  S: { row: 1, col: 0 },
  W: { row: 1, col: 2 },
  NE: { row: 2, col: 0 },
  SE: { row: 2, col: 2 },
  SW: { row: 3, col: 0 },
  NW: { row: 3, col: 2 },
};
// canonical (drawn) -> derived (auto-mirrored) direction.
const MIRROR: [string, string][] = [['E', 'W'], ['NE', 'NW'], ['SE', 'SW']];
// Canonical (editable + shown) directions.
const CANON_DIRS = ['N', 'S', 'E', 'NE', 'SE'];

// Per-block layout: which sheet rows it occupies and the label prefix.
const BLOCKS = [
  { offset: 0, prefix: '' },               // walk, rows 0-3
  { offset: ATTACK_ROW_START, prefix: 'atk ' }, // rows 5-8
  { offset: HURT_ROW_START, prefix: 'hurt ' },  // rows 9-12
];

/** The block (row offset) a sheet row belongs to, or null for climb / off-grid. */
function blockOffsetForRow(row: number): number | null {
  for (const b of BLOCKS) {
    if (row >= b.offset && row <= b.offset + 3) return b.offset;
  }
  return null; // climb row (4) and anything else: not mirrored
}

/** The W/NW/SW cell that mirrors a canonical E/NE/SE cell, or null. */
function mirrorTargetFor(row: number, col: number): { row: number; col: number } | null {
  const off = blockOffsetForRow(row);
  if (off === null) return null;
  const local = row - off;
  for (const [canon, derived] of MIRROR) {
    const c = DIR_BASE[canon];
    if (local === c.row && (col === c.col || col === c.col + 1)) {
      const frame = col - c.col;
      const d = DIR_BASE[derived];
      return { row: d.row + off, col: d.col + frame };
    }
  }
  return null;
}

// What the FRAMES strip shows: only canonical 2-frame sets, packed two per
// display row and never mixing blocks (a block of 5 dirs takes 3 rows, the last
// holding a single set). Each entry points at its sheet cell (frame 0 col).
type DisplaySet = { label: string; row: number; col: number };
const DISPLAY_ROWS: DisplaySet[][] = (() => {
  const rows: DisplaySet[][] = [];
  const addBlock = (prefix: string, off: number) => {
    for (let i = 0; i < CANON_DIRS.length; i += 2) {
      rows.push(
        CANON_DIRS.slice(i, i + 2).map((d) => ({
          label: prefix + d,
          row: DIR_BASE[d].row + off,
          col: DIR_BASE[d].col,
        })),
      );
    }
  };
  addBlock('', 0);
  rows.push([
    { label: 'ladder', row: CLIMB_ROW, col: 0 },
    { label: 'rope', row: CLIMB_ROW, col: 2 },
  ]);
  addBlock('atk ', ATTACK_ROW_START);
  addBlock('hurt ', HURT_ROW_START);
  return rows;
})();
const STRIP_H = DISPLAY_ROWS.length * STRIP_FRAME_H;

let open = false;
let overlay: HTMLDivElement | null = null;
let sheet: HTMLCanvasElement | null = null;
let sheetCtx: CanvasRenderingContext2D | null = null;
let palette: [number, number, number][] = [];

let tool: Tool = 'pencil';
let colorIndex = 1;
let selRow = 1; // start on the south-facing frame — the classic editing view
let selCol = 0;
let painting = false;
let strokeChanged = false;
let undoStack: ImageData[] = [];
let dirty = true;
// One copied frame (16x24 pixels), pasted into any selected cell. Survives
// reselection so you can author one direction and copy it across the others.
let frameClipboard: ImageData | null = null;

let editCanvas: HTMLCanvasElement;
let stripCanvas: HTMLCanvasElement;
let testCanvas: HTMLCanvasElement;
let itemNote: HTMLDivElement | null = null;
let copyNote: HTMLDivElement | null = null;
let toolButtons = new Map<Tool, HTMLButtonElement>();
let swatchEls: HTMLDivElement[] = [];
let rafId = 0;

// --- WASD walker state for the test pane ---
const heldKeys = new Set<string>();
let walkerX = TEST_W / 2;
let walkerY = TEST_H / 2 + 12;
let walkerDir = Direction.S;
let walkerFrame = 0;
let walkerTimer = 0;
let walkerPose: Pose = 'walk';
let walkerPoseTimer = 0;
let walkerItem: string | null = null;

export interface SpriteEditorCallbacks {
  /** Player confirmed their character — receives the sheet as a PNG data URL. */
  onConfirm?: (sheetDataUrl: string) => void;
  /** Player backed out (Esc). */
  onCancel?: () => void;
}

let editorCallbacks: SpriteEditorCallbacks = {};

export function isSpriteEditorOpen(): boolean {
  return open;
}

export async function openSpriteEditor(callbacks: SpriteEditorCallbacks = {}): Promise<void> {
  if (open) return;
  open = true;
  editorCallbacks = callbacks;

  await loadPalette();
  await buildSheet();

  registerCustomSprite(PREVIEW_GROUP, sheet!, FRAME_W, FRAME_H);
  buildDom();
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mouseup', onGlobalMouseUp);
  dirty = true;
  rafId = requestAnimationFrame(tick);
}

function closeSpriteEditor(): void {
  if (!open) return;
  open = false;
  cancelAnimationFrame(rafId);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('mouseup', onGlobalMouseUp);
  heldKeys.clear();
  overlay?.remove();
  overlay = null;
  toolButtons.clear();
  swatchEls = [];
  copyNote = null;
  frameClipboard = null;
}

/** Enter / Start button: hand the finished sheet to the game. */
function confirmEditor(): void {
  if (!open || painting) return;
  if (!sheetHasAnyPixels()) return; // an empty sheet would be invisible in-game
  const dataUrl = sheet!.toDataURL();
  persistSheet();
  const cb = editorCallbacks.onConfirm;
  closeSpriteEditor();
  cb?.(dataUrl);
}

function cancelEditor(): void {
  if (!open) return;
  const cb = editorCallbacks.onCancel;
  closeSpriteEditor();
  cb?.();
}

function sheetHasAnyPixels(): boolean {
  const data = sheetCtx!.getImageData(0, 0, SHEET_W, SHEET_H).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

async function loadPalette(): Promise<void> {
  if (palette.length) return;
  const palettes = await loadJSON<number[][][]>('/assets/sprites/palettes.json');
  const palIdx = getSpriteGroupMeta(NESS_GROUP)?.palette ?? 5;
  palette = palettes[palIdx].map((c) => [c[0], c[1], c[2]]);
}

/**
 * Assemble Ness's frame template into the 64x312 v3 sheet: walk sheet (4x4
 * grid, 8 directions x 2 frames — Ness has true diagonal art), the climb row
 * stitched from the ladder/rope groups (cells 0-1 only), and procedurally
 * seeded attack (rows 5-8) and hurt (rows 9-12) blocks. A saved sheet is
 * loaded and migrated forward instead.
 */
async function buildSheet(): Promise<void> {
  if (sheet) return;
  sheet = document.createElement('canvas');
  sheet.width = SHEET_W;
  sheet.height = SHEET_H;
  sheetCtx = sheet.getContext('2d', { willReadFrequently: true })!;
  sheetCtx.imageSmoothingEnabled = false;

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = saved;
    });
    sheetCtx.drawImage(img, 0, 0);
    const savedRows = Math.round(img.naturalHeight / FRAME_H);
    // Seed any pose block the saved sheet predates, preserving blocks it has.
    // v1 (5 rows): no attack/hurt. v2 (10 rows): attack + an old single-row
    // hurt (row 9) we discard for the new 8-dir x 2-frame hurt. v3 (13 rows):
    // complete — only upgrade untouched verbatim-walk copies.
    if (savedRows < ATTACK_ROW_START + 4) seedAttackRows();
    if (savedRows < HURT_ROW_START + 4) seedHurtRows();
    reseedLegacyCopies();
    return;
  }
  await resetSheetFromRom();
}

async function resetSheetFromRom(): Promise<void> {
  const [walk, ladder, rope] = await Promise.all([
    loadImage(`/assets/sprites/${NESS_GROUP}.png`),
    loadImage(`/assets/sprites/${LADDER_GROUP}.png`),
    loadImage(`/assets/sprites/${ROPE_GROUP}.png`),
  ]);
  const ctx = sheetCtx!;
  ctx.clearRect(0, 0, SHEET_W, SHEET_H);
  ctx.drawImage(walk, 0, 0);
  ctx.drawImage(ladder, 0, 0, FRAME_W * 2, FRAME_H, 0, CLIMB_ROW * FRAME_H, FRAME_W * 2, FRAME_H);
  ctx.drawImage(rope, 0, 0, FRAME_W * 2, FRAME_H, FRAME_W * 2, CLIMB_ROW * FRAME_H, FRAME_W * 2, FRAME_H);
  fillPoseDefaults();
}

// ---------------------------------------------------------------------------
// Procedural pose art. EB has no overworld attack/hurt frames, so we GENERATE
// them from each direction's standing frame by re-posing its body bands
// (head / torso / legs) — the classic trick for faking extra animation:
//   attack f0 = wind-up (upper body pulled back, opposite the facing)
//   attack f1 = swing   (upper body lunged hard into the facing)
//   hurt   f0 = recoil  (staggered hard back and crushed down)
//   hurt   f1 = settle  (partial return toward standing)
// The shears are symmetric in the facing's horizontal sign, so a derived
// (west) frame generated this way equals the flip of its canonical (east)
// frame — consistent with the editor's auto-mirroring. Only transform math
// lives in the repo; the pixels still come from the player's own sprites.
// ---------------------------------------------------------------------------

// The four walk rows' frame cells with each direction's facing vector.
const DIR_CELLS: { row: number; col: number; fx: number; fy: number }[] = [
  { row: 0, col: 0, fx: 0, fy: -1 },  // N
  { row: 0, col: 2, fx: 1, fy: 0 },   // E
  { row: 1, col: 0, fx: 0, fy: 1 },   // S
  { row: 1, col: 2, fx: -1, fy: 0 },  // W
  { row: 2, col: 0, fx: 1, fy: -1 },  // NE
  { row: 2, col: 2, fx: 1, fy: 1 },   // SE
  { row: 3, col: 0, fx: -1, fy: 1 },  // SW
  { row: 3, col: 2, fx: -1, fy: -1 }, // NW
];

/** One horizontal slice of the body, drawn with its own offset. */
type Band = { y0: number; y1: number; dx: number; dy: number };
const LEGS: Band = { y0: 16, y1: 23, dx: 0, dy: 0 }; // feet stay planted

// Side-facing poses shear the upper body along the facing; straight N/S poses
// (no horizontal axis to shear along) read through vertical motion instead.
function bandsWindup(sx: number): Band[] {
  return sx !== 0
    ? [LEGS, { y0: 8, y1: 15, dx: -sx, dy: 0 }, { y0: 0, y1: 7, dx: -2 * sx, dy: 0 }]
    : [LEGS, { y0: 8, y1: 15, dx: 0, dy: 1 }, { y0: 0, y1: 7, dx: 0, dy: 1 }]; // crouch
}

function bandsSwing(sx: number, fy: number): Band[] {
  if (sx !== 0) {
    return [LEGS, { y0: 8, y1: 15, dx: sx, dy: 1 }, { y0: 0, y1: 7, dx: 3 * sx, dy: 1 }];
  }
  return fy > 0
    ? [LEGS, { y0: 8, y1: 15, dx: 0, dy: 1 }, { y0: 0, y1: 7, dx: 0, dy: 2 }]  // S: lean over
    : [LEGS, { y0: 8, y1: 15, dx: 0, dy: -1 }, { y0: 0, y1: 7, dx: 0, dy: -1 }]; // N: reach away
}

// Hurt frame 0: hard recoil away from the facing, crushed down.
function bandsHurtRecoil(sx: number): Band[] {
  return sx !== 0
    ? [LEGS, { y0: 8, y1: 15, dx: -sx, dy: 1 }, { y0: 0, y1: 7, dx: -2 * sx, dy: 2 }]
    : [LEGS, { y0: 8, y1: 15, dx: 0, dy: 1 }, { y0: 0, y1: 7, dx: 0, dy: 2 }];
}

// Hurt frame 1: partial return toward standing (a smaller offset than recoil).
function bandsHurtSettle(sx: number): Band[] {
  return sx !== 0
    ? [LEGS, { y0: 8, y1: 15, dx: 0, dy: 0 }, { y0: 0, y1: 7, dx: -sx, dy: 1 }]
    : [LEGS, { y0: 8, y1: 15, dx: 0, dy: 0 }, { y0: 0, y1: 7, dx: 0, dy: 1 }];
}

/** Copy a frame band-by-band (legs first, head last so it overlaps the torso),
 *  clipped to the destination cell so shears can't bleed into neighbors. */
function drawPosedFrame(srcRow: number, srcCol: number, dstRow: number, dstCol: number, bands: Band[]): void {
  const ctx = sheetCtx!;
  const cellX = dstCol * FRAME_W;
  const cellY = dstRow * FRAME_H;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, FRAME_W, FRAME_H);
  ctx.clip();
  for (const b of bands) {
    const h = b.y1 - b.y0 + 1;
    ctx.drawImage(
      sheet!,
      srcCol * FRAME_W, srcRow * FRAME_H + b.y0, FRAME_W, h,
      cellX + b.dx, cellY + b.y0 + b.dy, FRAME_W, h
    );
  }
  ctx.restore();
}

// Seed a 4-row, 8-direction, 2-frame pose block at `offset`, generated from
// the matching walk frame. Each direction's two frames come from f0/f1 band
// functions taking (horizontalSign, facingY).
type BandFn = (sx: number, fy: number) => Band[];
function seedPoseRows(offset: number, f0: BandFn, f1: BandFn): void {
  sheetCtx!.clearRect(0, offset * FRAME_H, SHEET_W, FRAME_H * 4);
  for (const d of DIR_CELLS) {
    const sx = Math.sign(d.fx);
    drawPosedFrame(d.row, d.col, d.row + offset, d.col, f0(sx, d.fy));
    drawPosedFrame(d.row, d.col, d.row + offset, d.col + 1, f1(sx, d.fy));
  }
}

function seedAttackRows(): void {
  seedPoseRows(ATTACK_ROW_START, (sx) => bandsWindup(sx), (sx, fy) => bandsSwing(sx, fy));
}

function seedHurtRows(): void {
  seedPoseRows(HURT_ROW_START, (sx) => bandsHurtRecoil(sx), (sx) => bandsHurtSettle(sx));
}

function fillPoseDefaults(): void {
  seedAttackRows();
  seedHurtRows();
}

function regionEquals(ax: number, ay: number, bx: number, by: number, w: number, h: number): boolean {
  const ctx = sheetCtx!;
  const a = ctx.getImageData(ax, ay, w, h).data;
  const b = ctx.getImageData(bx, by, w, h).data;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * An early migration seeded attack/hurt rows as VERBATIM copies of the walk
 * rows. If a saved sheet still carries those untouched copies (the whole block
 * equals the walk block), replace them with the procedural poses; edited rows
 * are left alone.
 */
function reseedLegacyCopies(): void {
  const isWalkCopy = (offset: number) =>
    regionEquals(0, 0, 0, offset * FRAME_H, SHEET_W, FRAME_H * 4);
  if (isWalkCopy(ATTACK_ROW_START)) seedAttackRows();
  if (isWalkCopy(HURT_ROW_START)) seedHurtRows();
}

function persistSheet(): void {
  try {
    localStorage.setItem(STORAGE_KEY, sheet!.toDataURL());
  } catch {
    // storage full/blocked — edits still live in memory for this session
  }
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDom(): void {
  overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:100;background:#16161e;color:#ddd;' +
    'font:12px monospace;display:flex;flex-direction:column;align-items:center;' +
    'overflow:auto;user-select:none;';

  const title = document.createElement('div');
  title.textContent = 'CREATE CHARACTER — pixel editor   (WASD: test walk · 1/2/3: tools · Ctrl+C/V: copy/paste frame · Ctrl+Z: undo · Enter: start · Esc: back)';
  title.style.cssText = 'padding:10px;color:#fff;letter-spacing:1px;';
  overlay.appendChild(title);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:16px;align-items:flex-start;';
  overlay.appendChild(row);

  row.appendChild(buildToolPanel());
  row.appendChild(buildStripPanel());
  row.appendChild(buildEditPanel());
  row.appendChild(buildTestPanel());

  document.body.appendChild(overlay);
}

function panel(label: string): HTMLDivElement {
  const div = document.createElement('div');
  div.style.cssText =
    'display:flex;flex-direction:column;gap:6px;background:#1f1f2a;' +
    'border:1px solid #333;border-radius:4px;padding:10px;';
  const head = document.createElement('div');
  head.textContent = label;
  head.style.cssText = 'color:#9af;font-size:11px;letter-spacing:1px;';
  div.appendChild(head);
  return div;
}

function buildToolPanel(): HTMLDivElement {
  const div = panel('TOOLS');

  const tools: [Tool, string][] = [
    ['pencil', '1 ✏ Pencil'],
    ['eraser', '2 ▭ Eraser'],
    ['eyedrop', '3 ⊕ Eyedrop'],
  ];
  for (const [t, label] of tools) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      'font:12px monospace;padding:5px 8px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;text-align:left;';
    btn.onclick = () => setTool(t);
    toolButtons.set(t, btn);
    div.appendChild(btn);
  }

  const palHead = document.createElement('div');
  palHead.textContent = 'PALETTE';
  palHead.style.cssText = 'margin-top:8px;color:#9af;font-size:11px;letter-spacing:1px;';
  div.appendChild(palHead);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,24px);gap:3px;';
  for (let i = 0; i < palette.length; i++) {
    const sw = document.createElement('div');
    sw.style.cssText = 'width:24px;height:24px;border:2px solid #444;cursor:pointer;border-radius:2px;';
    if (i === 0) {
      // Color 0 is hardware-transparent on the SNES — painting it erases.
      sw.style.background =
        'repeating-conic-gradient(#555 0% 25%, #2a2a2a 0% 50%) 0 0 / 12px 12px';
      sw.title = '0: transparent';
    } else {
      const [r, g, b] = palette[i];
      sw.style.background = `rgb(${r},${g},${b})`;
      sw.title = `${i}: rgb(${r},${g},${b})`;
    }
    sw.onclick = () => setColor(i);
    swatchEls.push(sw);
    grid.appendChild(sw);
  }
  div.appendChild(grid);

  const reset = document.createElement('button');
  reset.textContent = 'Reset to Ness';
  reset.style.cssText =
    'margin-top:10px;font:11px monospace;padding:4px 6px;background:#3a2a2a;' +
    'color:#fbb;border:1px solid #644;border-radius:3px;cursor:pointer;';
  reset.onclick = () => {
    pushUndo();
    void resetSheetFromRom().then(() => {
      localStorage.removeItem(STORAGE_KEY);
      dirty = true;
    });
  };
  div.appendChild(reset);

  const start = document.createElement('button');
  start.textContent = '▶ Start game';
  start.style.cssText =
    'margin-top:4px;font:12px monospace;padding:6px 8px;background:#1f3a26;' +
    'color:#9f9;border:1px solid #4a6;border-radius:3px;cursor:pointer;';
  start.onclick = confirmEditor;
  div.appendChild(start);

  setTool('pencil');
  setColor(colorIndex);
  return div;
}

// X of the gutter / first frame of set s (0 = left, 1 = right) within a row.
function stripGutterX(s: number): number {
  return s * (STRIP_GUTTER + STRIP_SET_W);
}
function stripFramesX(s: number): number {
  return stripGutterX(s) + STRIP_GUTTER;
}

function buildStripPanel(): HTMLDivElement {
  const div = panel('FRAMES');
  stripCanvas = document.createElement('canvas');
  stripCanvas.width = STRIP_W;
  stripCanvas.height = STRIP_H;
  stripCanvas.style.cssText = 'image-rendering:pixelated;cursor:pointer;';
  stripCanvas.onmousedown = (e) => {
    const r = stripCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const dr = Math.floor(y / STRIP_FRAME_H);
    const displayRow = DISPLAY_ROWS[dr];
    if (!displayRow) return;
    // Select a canonical set only when x lands on it (not a label gutter).
    for (let s = 0; s < displayRow.length; s++) {
      const fx = stripFramesX(s);
      if (x >= fx && x < fx + STRIP_SET_W) {
        const set = displayRow[s];
        selRow = set.row;
        selCol = set.col + Math.floor((x - fx) / STRIP_FRAME_W); // frame 0 or 1
        dirty = true;
        break;
      }
    }
  };
  div.appendChild(stripCanvas);

  const note = document.createElement('div');
  note.textContent = 'W · NW · SW auto-mirror from E · NE · SE';
  note.style.cssText = 'color:#888;font-size:10px;margin-top:4px;';
  div.appendChild(note);
  return div;
}

function buildEditPanel(): HTMLDivElement {
  const div = panel('EDIT — 16×24');
  editCanvas = document.createElement('canvas');
  editCanvas.width = FRAME_W * ZOOM;
  editCanvas.height = FRAME_H * ZOOM;
  editCanvas.style.cssText = 'image-rendering:pixelated;cursor:crosshair;';
  editCanvas.oncontextmenu = (e) => e.preventDefault();
  editCanvas.onmousedown = (e) => {
    painting = true;
    strokeChanged = false;
    pushUndo();
    applyToolAt(e);
  };
  editCanvas.onmousemove = (e) => {
    if (painting) applyToolAt(e);
  };
  div.appendChild(editCanvas);

  // Copy the selected frame, paste it into any other selected frame. The strip
  // selection is the source on Copy and the destination on Paste.
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:2px;';
  const mkBtn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'flex:1;font:11px monospace;padding:4px 6px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;';
    b.onclick = fn;
    return b;
  };
  btnRow.appendChild(mkBtn('⧉ Copy frame', copyFrame));
  btnRow.appendChild(mkBtn('⊞ Paste frame', pasteFrame));
  div.appendChild(btnRow);

  copyNote = document.createElement('div');
  copyNote.textContent = 'Clipboard: empty';
  copyNote.style.cssText = 'color:#888;font-size:10px;';
  div.appendChild(copyNote);
  return div;
}

function buildTestPanel(): HTMLDivElement {
  const div = panel('LIVE TEST — WASD walk · F attack · H hurt · G item');
  testCanvas = document.createElement('canvas');
  testCanvas.width = TEST_W * TEST_SCALE;
  testCanvas.height = TEST_H * TEST_SCALE;
  testCanvas.style.cssText = 'image-rendering:pixelated;background:#3a6a44;';
  div.appendChild(testCanvas);

  const note = document.createElement('div');
  note.textContent = 'Compiled through the real game sprite path.';
  note.style.cssText = 'color:#888;font-size:10px;max-width:' + TEST_W * TEST_SCALE + 'px;';
  div.appendChild(note);

  itemNote = document.createElement('div');
  itemNote.textContent = 'Item: none (G cycles)';
  itemNote.style.cssText = 'color:#888;font-size:10px;';
  div.appendChild(itemNote);
  return div;
}

function setTool(t: Tool): void {
  tool = t;
  for (const [key, btn] of toolButtons) {
    btn.style.borderColor = key === t ? '#9af' : '#444';
    btn.style.color = key === t ? '#fff' : '#ddd';
  }
}

function setColor(i: number): void {
  colorIndex = i;
  swatchEls.forEach((sw, j) => {
    sw.style.borderColor = j === i ? '#fff' : '#444';
  });
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function applyToolAt(e: MouseEvent): void {
  const r = editCanvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - r.left) / ZOOM);
  const py = Math.floor((e.clientY - r.top) / ZOOM);
  if (px < 0 || py < 0 || px >= FRAME_W || py >= FRAME_H) return;

  const sx = selCol * FRAME_W + px;
  const sy = selRow * FRAME_H + py;
  const ctx = sheetCtx!;

  // Right mouse button always erases, whatever tool is active.
  const erase = tool === 'eraser' || (e.buttons & 2) !== 0;

  if (tool === 'eyedrop' && !erase) {
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    setColor(d[3] === 0 ? 0 : nearestPaletteIndex(d[0], d[1], d[2]));
    setTool('pencil');
    return;
  }

  if (erase || colorIndex === 0) {
    ctx.clearRect(sx, sy, 1, 1);
  } else {
    const [cr, cg, cb] = palette[colorIndex];
    ctx.clearRect(sx, sy, 1, 1); // replace, don't blend
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(sx, sy, 1, 1);
  }
  // Auto-mirror: keep the west/diagonal-left partner cell a flipped copy of the
  // canonical cell being edited (selection is always canonical — see strip click).
  syncMirrorCell(selRow, selCol);
  strokeChanged = true;
  dirty = true;
}

/** Redraw the derived (mirrored) partner of a canonical cell as its h-flip. */
function syncMirrorCell(row: number, col: number): void {
  const t = mirrorTargetFor(row, col);
  if (!t) return;
  const ctx = sheetCtx!;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(t.col * FRAME_W, t.row * FRAME_H, FRAME_W, FRAME_H);
  ctx.translate(t.col * FRAME_W + FRAME_W, t.row * FRAME_H);
  ctx.scale(-1, 1);
  ctx.drawImage(sheet!, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
  ctx.restore();
}

function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function pushUndo(): void {
  undoStack.push(sheetCtx!.getImageData(0, 0, SHEET_W, SHEET_H));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo(): void {
  const snap = undoStack.pop();
  if (!snap) return;
  sheetCtx!.putImageData(snap, 0, 0);
  persistSheet();
  dirty = true;
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

/** Grab the selected frame's 16x24 pixels into the clipboard. */
function copyFrame(): void {
  frameClipboard = sheetCtx!.getImageData(selCol * FRAME_W, selRow * FRAME_H, FRAME_W, FRAME_H);
  if (copyNote) copyNote.textContent = `Clipboard: ${labelForCell(selRow, selCol)}`;
}

/** Replace the selected frame with the clipboard (undoable; re-mirrors). */
function pasteFrame(): void {
  if (!frameClipboard) return;
  pushUndo();
  // putImageData overwrites the cell wholesale (incl. transparency) — a true
  // frame replace, not an alpha blend.
  sheetCtx!.putImageData(frameClipboard, selCol * FRAME_W, selRow * FRAME_H);
  // Selection is canonical, so refresh its W/NW/SW mirror partner if it has one.
  syncMirrorCell(selRow, selCol);
  persistSheet();
  dirty = true;
}

function onGlobalMouseUp(): void {
  if (painting && strokeChanged) {
    persistSheet();
  } else if (painting && !strokeChanged) {
    undoStack.pop(); // stroke did nothing (e.g. eyedrop) — drop its snapshot
  }
  painting = false;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  e.stopPropagation();
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    cancelEditor();
    return;
  }
  if (k === 'enter') {
    confirmEditor();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'c') {
    e.preventDefault();
    copyFrame();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'v') {
    e.preventDefault();
    pasteFrame();
    return;
  }
  if (k === '1') setTool('pencil');
  else if (k === '2') setTool('eraser');
  else if (k === '3') setTool('eyedrop');
  else if (k === 'w' || k === 'a' || k === 's' || k === 'd') heldKeys.add(k);
  else if (k === 'f' && walkerPose === 'walk') {
    walkerPose = 'attack'; // preview the attack rows
    walkerPoseTimer = 0;
  } else if (k === 'h' && walkerPose === 'walk') {
    walkerPose = 'hurt'; // preview the hurt row
    walkerPoseTimer = 0;
  } else if (k === 'g') {
    walkerItem = nextHeldItem(walkerItem); // preview held-item overlays
    if (itemNote) itemNote.textContent = `Item: ${walkerItem ? getItemName(walkerItem) : 'none'} (G cycles)`;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  e.stopPropagation();
  heldKeys.delete(e.key.toLowerCase());
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function tick(): void {
  if (!open) return;
  updateWalker();
  if (dirty) {
    drawEditCanvas();
    drawStrip();
    dirty = false;
  }
  drawTestPane();
  rafId = requestAnimationFrame(tick);
}

const DIR_FROM_DELTA: Record<string, Direction> = {
  '0,-1': Direction.N,
  '0,1': Direction.S,
  '-1,0': Direction.W,
  '1,0': Direction.E,
  '1,-1': Direction.NE,
  '1,1': Direction.SE,
  '-1,1': Direction.SW,
  '-1,-1': Direction.NW,
};

function updateWalker(): void {
  // Attack/hurt previews play out like in-game: brief, movement-locked.
  if (walkerPose === 'attack') {
    walkerPoseTimer++;
    walkerFrame = walkerPoseTimer < 8 ? 0 : 1;
    if (walkerPoseTimer >= 16) {
      walkerPose = 'walk';
      walkerFrame = 0;
    }
    return;
  }
  if (walkerPose === 'hurt') {
    walkerPoseTimer++;
    walkerFrame = walkerPoseTimer < 8 ? 0 : 1; // recoil then settle
    if (walkerPoseTimer >= 20) {
      walkerPose = 'walk';
      walkerFrame = 0;
    }
    return;
  }

  const dx = (heldKeys.has('d') ? 1 : 0) - (heldKeys.has('a') ? 1 : 0);
  const dy = (heldKeys.has('s') ? 1 : 0) - (heldKeys.has('w') ? 1 : 0);
  if (dx === 0 && dy === 0) {
    walkerFrame = 0;
    walkerTimer = 0;
    return;
  }
  walkerDir = DIR_FROM_DELTA[`${dx},${dy}`];
  const speed = dx !== 0 && dy !== 0 ? 1.06 : 1.5; // EB-style diagonal slowdown
  walkerX = clamp(walkerX + dx * speed, FRAME_W / 2, TEST_W - FRAME_W / 2);
  walkerY = clamp(walkerY + dy * speed, FRAME_H + 2, TEST_H - 2);
  if (++walkerTimer >= 8) {
    walkerTimer = 0;
    walkerFrame = walkerFrame === 0 ? 1 : 0;
  }
}

function drawTestPane(): void {
  const ctx = testCanvas.getContext('2d')!;
  ctx.setTransform(TEST_SCALE, 0, 0, TEST_SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // Simple grass checker so motion is visible.
  ctx.fillStyle = '#3a6a44';
  ctx.fillRect(0, 0, TEST_W, TEST_H);
  ctx.fillStyle = '#35613e';
  for (let ty = 0; ty < TEST_H; ty += 16) {
    for (let tx = (ty / 16) % 2 === 0 ? 0 : 16; tx < TEST_W; tx += 32) {
      ctx.fillRect(tx, ty, 16, 16);
    }
  }

  // Same overlay ordering as the in-game renderer: far-hand items go under
  // the body, near-hand items on top.
  const itemBehind = walkerItem !== null && isItemBehind(walkerDir);
  if (walkerItem && itemBehind) {
    drawHeldItem(ctx, walkerItem, walkerDir, walkerFrame, walkerPose, walkerX, walkerY);
  }
  drawSprite(ctx, PREVIEW_GROUP, walkerDir, walkerFrame, walkerX, walkerY, 'full', walkerPose);
  if (walkerItem && !itemBehind) {
    drawHeldItem(ctx, walkerItem, walkerDir, walkerFrame, walkerPose, walkerX, walkerY);
  }
}

function drawEditCanvas(): void {
  const ctx = editCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Light transparency checkerboard under the frame, so the sprite's dark
  // outline stays visible (a dark field hid it).
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, editCanvas.width, editCanvas.height);
  ctx.fillStyle = CHECKER_B;
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = (y % 2 === 0 ? 0 : 1); x < FRAME_W; x += 2) {
      ctx.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
    }
  }

  ctx.drawImage(
    sheet!,
    selCol * FRAME_W, selRow * FRAME_H, FRAME_W, FRAME_H,
    0, 0, FRAME_W * ZOOM, FRAME_H * ZOOM
  );

  // Pixel grid (dark, to read on the light checker), heavier on 8x8 SNES tiles.
  for (let x = 0; x <= FRAME_W; x++) {
    ctx.fillStyle = x % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(x * ZOOM, 0, 1, editCanvas.height);
  }
  for (let y = 0; y <= FRAME_H; y++) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, y * ZOOM, editCanvas.width, 1);
  }
}

/** Light transparency checker filling a device-pixel rect of the strip. */
function fillChecker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const C = 8;
  for (let yy = 0; yy < h; yy += C) {
    for (let xx = 0; xx < w; xx += C) {
      ctx.fillStyle = (((xx / C) + (yy / C)) & 1) ? CHECKER_B : CHECKER_A;
      ctx.fillRect(x + xx, y + yy, Math.min(C, w - xx), Math.min(C, h - yy));
    }
  }
}

function drawStrip(): void {
  const ctx = stripCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Panel-dark fill so the label gutters blend in; frame sets get a light
  // checker drawn over them below.
  ctx.fillStyle = '#1f1f2a';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);
  ctx.textBaseline = 'middle';
  ctx.font = '10px monospace';

  for (let dr = 0; dr < DISPLAY_ROWS.length; dr++) {
    const y = dr * STRIP_FRAME_H;
    DISPLAY_ROWS[dr].forEach((set, s) => {
      const fx = stripFramesX(s);

      // Label in the gutter to the LEFT of this 2-frame set.
      ctx.fillStyle = '#cdd6e6';
      ctx.fillText(set.label, stripGutterX(s) + 4, y + STRIP_FRAME_H / 2);

      // Light checker, then the set's two frames over it.
      fillChecker(ctx, fx, y, STRIP_SET_W, STRIP_FRAME_H);
      for (let i = 0; i < 2; i++) {
        ctx.drawImage(
          sheet!,
          (set.col + i) * FRAME_W, set.row * FRAME_H, FRAME_W, FRAME_H,
          fx + i * STRIP_FRAME_W, y, STRIP_FRAME_W, STRIP_FRAME_H
        );
      }

      // Per-frame cell borders.
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      for (let i = 0; i < 2; i++) {
        ctx.strokeRect(fx + i * STRIP_FRAME_W + 0.5, y + 0.5, STRIP_FRAME_W - 1, STRIP_FRAME_H - 1);
      }

      // Selection highlight if the active sheet cell lives in this set.
      if (selRow === set.row && (selCol === set.col || selCol === set.col + 1)) {
        const selX = fx + (selCol - set.col) * STRIP_FRAME_W;
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 2;
        ctx.strokeRect(selX + 1, y + 1, STRIP_FRAME_W - 2, STRIP_FRAME_H - 2);
      }
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
