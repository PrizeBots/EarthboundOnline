// Constants, types, and PURE helpers for the Cast Sprite Editor. Nothing in here
// touches mutable editor state (that lives in ./state) — these are layout tables,
// geometry, and stateless pixel/image utilities, safe to import anywhere.
import { ITEM_PALETTE } from '../Items';
import { Direction } from '../../types';

export const FRAME_W = 16;
export const FRAME_H = 24;
export const SHEET_COLS = 4;
// Sheet v4: walk rows 0-3, climb row 4 (ladder f0/f1, rope f0/f1), attack
// rows 5-8, hurt rows 9-12, peace row 13 (1 frame), laying row 14 (1 frame;
// a 3x2-block 24x16 figure). Attack and hurt share the walk direction layout
// (8 dirs x 2 frames). Left/right are mirror-equal in EB, so the editor only
// lets you draw N/S/E/NE/SE and auto-fills W/NW/SW as horizontal flips.
export const SHEET_ROWS = 15;
export const SHEET_W = FRAME_W * SHEET_COLS;
export const SHEET_H = FRAME_H * SHEET_ROWS;
export const CLIMB_ROW = 4;
export const ATTACK_ROW_START = 5;
export const HURT_ROW_START = 9;
export const PEACE_ROW = 13;
export const LAYING_ROW = 14;

export const DEFAULT_GROUP = 1; // Ness — the screen opens on him
export const BAND_ROWS = SHEET_ROWS - ATTACK_ROW_START; // editable pose rows (attack + hurt)

// Drivable vehicle groups — listed in the dropdown so you can SEE them, but
// NOT editable: they're bigger, directional-only sheets with no attack/hurt
// band. Selecting one shows it in the preview + test pane (view-only). Mirrors
// the Traffic Editor's VEHICLE_SPRITES list.
export const VEHICLE_GROUPS: { id: number; name: string }[] = [
  { id: 255, name: 'Car' },
  { id: 206, name: 'Taxi' },
  { id: 459, name: 'Truck' },
  { id: 207, name: 'Delivery Truck' },
  { id: 460, name: 'Moving Van' },
  { id: 208, name: 'Camper Van' },
  { id: 243, name: 'Tour Bus' },
  { id: 254, name: 'Bulldozer' },
];
export function vehicleName(id: number): string | null {
  return VEHICLE_GROUPS.find((v) => v.id === id)?.name ?? null;
}

export const ZOOM = 16; // edit canvas: 1 sprite pixel = 16 screen pixels
export const STRIP_SCALE = 2; // frame-strip preview scale (13 rows, overlay scrolls)
export const TEST_W = 192; // WASD test pane, logical pixels
export const TEST_H = 144;
export const TEST_SCALE = 2;

// FRAMES strip layout: two 2-frame sets per display row, each with a label
// gutter to its LEFT. Only canonical directions are shown (see DISPLAY_ROWS);
// STRIP_H is derived from the display row count below.
export const STRIP_FRAME_W = FRAME_W * STRIP_SCALE;
export const STRIP_FRAME_H = FRAME_H * STRIP_SCALE;
export const STRIP_SET_W = 2 * STRIP_FRAME_W; // a 2-frame set
export const STRIP_GUTTER = 54; // label column width (fits "hurt NE")
export const STRIP_W = 2 * (STRIP_GUTTER + STRIP_SET_W);

// Light checkerboard tones for the sprite surfaces (strip + edit canvas). A
// dark field swallowed the sprites' dark outlines; light keeps them visible
// while still reading as transparent (and white highlights survive too).
export const CHECKER_A = '#d8d8e0';
export const CHECKER_B = '#bcbcc8';

export const UNDO_LIMIT = 64;

export type Tool = 'pencil' | 'eraser' | 'eyedrop' | 'fill' | 'select' | 'move' | 'rotate' | 'skew';
// The editor edits the 16x24 character sheet ('char'), a 16x16 held-item buffer
// ('item'), a 48x48 PSI effect frame ('psi'), or a custom entity's single frame
// ('entity' — variable size, Source Assets imports). Item/PSI/entity all share the
// engine's "buffer surface" path (see pixelCanvas.activeBuffer); only dims, the
// palette source, and the persist target differ. 'entity' uses the extracted
// image palette (S.palette) like 'char'; item/psi use the fixed ITEM_PALETTE.
export type EditMode = 'char' | 'item' | 'psi' | 'entity';

// A pixel-rect selection within the active target (region-local coords). When
// set, fill / transforms / copy act on it; otherwise they act on the whole frame.
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
export const DIR_BASE: Record<string, { row: number; col: number }> = {
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
export const MIRROR: [string, string][] = [
  ['E', 'W'],
  ['NE', 'NW'],
  ['SE', 'SW'],
];
// Canonical (editable + shown) directions.
export const CANON_DIRS = ['N', 'S', 'E', 'NE', 'SE'];

// Per-block layout: which sheet rows it occupies and the label prefix.
export const BLOCKS = [
  { offset: 0, prefix: '' }, // walk, rows 0-3
  { offset: ATTACK_ROW_START, prefix: 'atk ' }, // rows 5-8
  { offset: HURT_ROW_START, prefix: 'hurt ' }, // rows 9-12
];

/** The block (row offset) a sheet row belongs to, or null for climb / off-grid. */
export function blockOffsetForRow(row: number): number | null {
  for (const b of BLOCKS) {
    if (row >= b.offset && row <= b.offset + 3) return b.offset;
  }
  return null; // climb row (4) and anything else: not mirrored
}

/** The W/NW/SW cell that mirrors a canonical E/NE/SE cell, or null. */
export function mirrorTargetFor(row: number, col: number): { row: number; col: number } | null {
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

// What the FRAMES strip shows: canonical 2-frame sets packed two per display row.
// Each entry points at its sheet cell (frame 0 col). `single` marks a one-sprite
// entry of a pixel size; `px`/`py` override the sheet origin (for custom frames
// placed at arbitrary positions). Either way it's rendered + edited as ONE frame.
export type DisplaySet = {
  label: string;
  row: number;
  col: number;
  single?: { w: number; h: number };
  px?: number;
  py?: number;
};
/** Sheet-pixel origin + size of a display entry (handles built-in cells + customs). */
export function setSrc(set: DisplaySet): { x: number; y: number; w: number; h: number } {
  return {
    x: set.px ?? set.col * FRAME_W,
    y: set.py ?? set.row * FRAME_H,
    w: set.single ? set.single.w : FRAME_W,
    h: set.single ? set.single.h : FRAME_H,
  };
}
export const DISPLAY_ROWS: DisplaySet[][] = (() => {
  const rows: DisplaySet[][] = [];
  const addBlock = (prefix: string, off: number) => {
    for (let i = 0; i < CANON_DIRS.length; i += 2) {
      rows.push(
        CANON_DIRS.slice(i, i + 2).map((d) => ({
          label: prefix + d,
          row: DIR_BASE[d].row + off,
          col: DIR_BASE[d].col,
        }))
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
  // Single hero poses: peace (2x3 = 16x24) + lay E (3x2 = 24x16), each ONE sprite.
  rows.push([
    { label: 'peace', row: PEACE_ROW, col: 0, single: { w: FRAME_W, h: FRAME_H } },
    { label: 'lay E', row: LAYING_ROW, col: 0, single: { w: 24, h: 16 } },
  ]);
  return rows;
})();

// User-defined frames (Sheet panel): named rectangles carved from the sheet. They
// can sit below/right of the base pose rows; the live sheet canvas grows to fit.
// Persisted per group in overrides/sprite_frames.json (metadata + pixel snapshot).
export interface CustomFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pixels?: string; // PNG data URL of the frame's pixels (restored on load)
}
export interface FramesDoc {
  version: number;
  groups?: Record<string, CustomFrame[]>;
}

// Save: the whole live sheet is diffed vs pristine. `band:0` marks a full-sheet
// patch (BAND_Y/BAND_H below); legacy entries with no band are the old
// attack/hurt-only band, applied at row 5.
export const BAND_Y = 0;
export const BAND_H = SHEET_H;

// --- 12-wide artist sheet layout (export / import / preview) --------------------
// The native sheet is 4 frames wide x 15 rows. Everywhere a WHOLE sheet is shown
// or transferred — the bottom preview, the PNG export, and import — we re-flow it
// 12 frames wide: the walk, attack, and hurt pose blocks sit SIDE BY SIDE
// (cols 0-3 | 4-7 | 8-11), one direction-pair per row (N/E, S/W, NE/SE, SW/NW),
// with climb + the single peace/lay poses on a 5th row. A band is a pixel-rect
// copy native->wide; import runs the same bands in reverse, so the two are exact
// inverses. The preview, export, and import are ALL driven by WIDE_BANDS, so the
// three never drift. (The native 4x15 sheet stays the engine's real format — only
// this artist-facing view is 12-wide.)
export const WIDE_COLS = 12;
export const WIDE_ROWS = 5;
export const WIDE_W = WIDE_COLS * FRAME_W; // 192
export const WIDE_H = WIDE_ROWS * FRAME_H; // 120

export interface SheetBand {
  sx: number; // native sheet source rect (sx is always 0 — full sheet width)
  sy: number;
  w: number;
  h: number;
  dx: number; // top-left of this band in the 12-wide layout
  dy: number;
}
export const WIDE_BANDS: SheetBand[] = [
  { sx: 0, sy: 0, w: SHEET_W, h: 4 * FRAME_H, dx: 0, dy: 0 }, // walk  -> cols 0-3
  { sx: 0, sy: ATTACK_ROW_START * FRAME_H, w: SHEET_W, h: 4 * FRAME_H, dx: 4 * FRAME_W, dy: 0 }, // attack -> cols 4-7
  { sx: 0, sy: HURT_ROW_START * FRAME_H, w: SHEET_W, h: 4 * FRAME_H, dx: 8 * FRAME_W, dy: 0 }, // hurt  -> cols 8-11
  { sx: 0, sy: CLIMB_ROW * FRAME_H, w: SHEET_W, h: FRAME_H, dx: 0, dy: 4 * FRAME_H }, // climb -> row 4, cols 0-3
  { sx: 0, sy: PEACE_ROW * FRAME_H, w: FRAME_W, h: FRAME_H, dx: 4 * FRAME_W, dy: 4 * FRAME_H }, // peace -> row 4, col 4
  { sx: 0, sy: LAYING_ROW * FRAME_H, w: 24, h: 16, dx: 5 * FRAME_W, dy: 4 * FRAME_H }, // lay   -> row 4, col 5
];

// Pose-block headers drawn over each 4-col group on export.
export const WIDE_BLOCK_LABELS: { label: string; col: number; span: number }[] = [
  { label: 'WALK', col: 0, span: 4 },
  { label: 'ATTACK', col: 4, span: 4 },
  { label: 'HURT', col: 8, span: 4 },
];
// Left-margin label per wide row (the direction pair; row 4 holds the extras).
export const WIDE_ROW_LABELS = ['N/E', 'S/W', 'NE/SE', 'SW/NW', 'misc'];

/** Wide-layout pixel position of a native (col,row) cell, or null if that cell is
 *  not carried into the 12-wide layout (used to remap missing-frame guide boxes). */
export function wideCellPos(row: number, col: number): { x: number; y: number } | null {
  const nx = col * FRAME_W;
  const ny = row * FRAME_H;
  for (const b of WIDE_BANDS) {
    if (nx >= b.sx && nx < b.sx + b.w && ny >= b.sy && ny < b.sy + b.h) {
      return { x: b.dx + (nx - b.sx), y: b.dy + (ny - b.sy) };
    }
  }
  return null;
}

/** Re-flow the native 4-wide sheet into a fresh 12-wide canvas (WIDE_W x WIDE_H). */
export function buildWideSheet(src: CanvasImageSource): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = WIDE_W;
  out.height = WIDE_H;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (const b of WIDE_BANDS) ctx.drawImage(src, b.sx, b.sy, b.w, b.h, b.dx, b.dy, b.w, b.h);
  return out;
}

// --- Labeled export geometry: margins around the 12-wide body ------------------
export const EXPORT_HDR_W = 30; // left margin: row labels (fits "SW/NW")
export const EXPORT_HDR_H = 14; // top margin: pose-block headers
export const EXPORT_BODY_X = EXPORT_HDR_W; // x of the wide body inside the export canvas
export const EXPORT_BODY_Y = EXPORT_HDR_H; // y of the wide body
export const EXPORT_W = EXPORT_HDR_W + WIDE_W;
export const EXPORT_H = EXPORT_HDR_H + WIDE_H;

// --- SHEET panel geometry ------------------------------------------------------
export const SHEET_PANEL_SCALE = STRIP_SCALE; // same zoom as the FRAMES panel
export const SHEET_DRAG_PAD = FRAME_H * 2; // extra empty room below the sheet to drag into

/** Snap a sheet-pixel coordinate to the 8px (SNES tile) grid. */
export function snap8(v: number): number {
  return Math.max(0, Math.round(v / 8) * 8);
}

// X of the gutter / first frame of set s (0 = left, 1 = right) within a strip row.
export function stripGutterX(s: number): number {
  return s * (STRIP_GUTTER + STRIP_SET_W);
}
export function stripFramesX(s: number): number {
  return stripGutterX(s) + STRIP_GUTTER;
}

// --- Climb test props (test pane) ----------------------------------------------
export const LADDER_X = 44; // test-pane x of the ladder prop
export const ROPE_X = 150; // test-pane x of the rope prop
export const CLIMB_TOP = 14;
export const CLIMB_BOT = TEST_H - 4;

export const DIR_FROM_DELTA: Record<string, Direction> = {
  '0,-1': Direction.N,
  '0,1': Direction.S,
  '-1,0': Direction.W,
  '1,0': Direction.E,
  '1,-1': Direction.NE,
  '1,1': Direction.SE,
  '-1,1': Direction.SW,
  '-1,-1': Direction.NW,
};

// Direction label for a source-sheet cell (vehicles reuse the cast walk layout,
// so rows 0-3 / cols 0-3 map to the 8 directions × 2 frames).
export const SRC_CELL_LABEL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [dir, { row, col }] of Object.entries(DIR_BASE)) {
    m[`${row},${col}`] = dir;
    m[`${row},${col + 1}`] = dir; // second frame, same direction
  }
  return m;
})();

export interface StripCell {
  label: string;
  w: number;
  h: number;
  draw: (ctx: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) => void;
}

// The whole authored item-art map, for the overrides/item_sprites.json file.
export interface ItemDocEntry {
  pixels: string[];
  frames?: string[][];
  grip?: { x: number; y: number };
  offset?: { x: number; y: number };
}

export interface SpriteEditorCallbacks {
  /** Closed the editor (Esc) — return to character select. */
  onCancel?: () => void;
  /** Open straight into Item mode editing this catalog item (Item Manager handoff). */
  focusItem?: string;
  /** Open straight into PSI mode editing this ability's animation (PSI Manager handoff). */
  focusPsi?: string;
  /** Open in Character mode on this sprite group id (Entity Manager handoff). */
  focusChar?: number;
}

// ---------------------------------------------------------------------------
// Pure image/color helpers (no editor state).
// ---------------------------------------------------------------------------

/** Parse '#rrggbb' to an RGB tuple ('' / non-hex -> black). */
export function parseHexColor(hex: string): [number, number, number] {
  if (!hex || hex[0] !== '#') return [0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ITEM_PALETTE parsed to RGB for the eyedropper's nearest-color match.
export const itemPaletteRGB: [number, number, number][] = ITEM_PALETTE.map(parseHexColor);

/** Nearest palette index (>=1; index 0 is reserved transparent) to an RGB. */
export function nearestIndexIn(
  pal: [number, number, number][],
  r: number,
  g: number,
  b: number
): number {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < pal.length; i++) {
    const [pr, pg, pb] = pal[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Snap an imported image to the palette: transparent stays transparent, every
 *  opaque pixel becomes its nearest palette color. */
export function snapImageToPalette(src: ImageData, pal: [number, number, number][]): ImageData {
  const out = new ImageData(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3] < 128) {
      out.data[i + 3] = 0;
      continue;
    } // transparent
    const idx = nearestIndexIn(pal, src.data[i], src.data[i + 1], src.data[i + 2]);
    const [r, g, b] = pal[idx];
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = 255;
  }
  return out;
}

/** Copy a sub-rectangle out of an ImageData (used to pull one band out of the
 *  labeled export sheet on import, skipping the header margins). */
export function cropImageData(
  src: ImageData,
  x: number,
  y: number,
  w: number,
  h: number
): ImageData {
  const out = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * src.width + x) * 4;
    out.data.set(src.data.subarray(s, s + w * 4), row * w * 4);
  }
  return out;
}

/** True if any pixel in the (col,row) sheet cell of ctx is non-transparent. */
export function cellHasContent(ctx: CanvasRenderingContext2D, col: number, row: number): boolean {
  const d = ctx.getImageData(col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
  return false;
}

/** Filesystem-safe slug for an export filename. */
export function safeName(s: string): string {
  return s.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'sprite';
}

/** Trigger a browser download of a canvas as a native-size (1x) PNG. */
export function downloadCanvasPNG(canvas: HTMLCanvasElement, filename: string): void {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Rasterize an image to raw RGBA pixels at the given native size. */
export function imageToData(img: HTMLImageElement, w: number, h: number): ImageData {
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Dashed black/white "marching ants" rectangle around a pixel rect (edit-canvas px). */
export function strokeRectAnts(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const rx = x * ZOOM + 0.5;
  const ry = y * ZOOM + 0.5;
  const rw = w * ZOOM - 1;
  const rh = h * ZOOM - 1;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#000';
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.lineDashOffset = 3;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.restore();
}

/** Light transparency checker filling a device-pixel rect of a strip/grid cell. */
export function fillChecker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const C = 8;
  for (let yy = 0; yy < h; yy += C) {
    for (let xx = 0; xx < w; xx += C) {
      ctx.fillStyle = (xx / C + yy / C) & 1 ? CHECKER_B : CHECKER_A;
      ctx.fillRect(x + xx, y + yy, Math.min(C, w - xx), Math.min(C, h - yy));
    }
  }
}
