import { Direction } from '../types';

// Procedural attack/hurt pose generation for ANY sprite group, at load time.
// EB has no overworld combat art, so we re-pose each direction's standing
// frame by shearing body bands (head / torso / legs-planted) — the same trick
// the player template uses (SpriteEditor's seeding; keep the shear shapes in
// sync). Running this in the ENGINE (on the player's own extracted sprites)
// rather than baking frames into override files keeps the overrides layer
// purely hand-painted — no ROM-derived pixels ship (CLAUDE.md).
//
// Output layout = sheet v3 (13 rows): walk 0-3 (copied), climb 4 (copied if
// the source has it, else empty), attack 5-8 (generated: f0 wind-up, f1
// swing), hurt 9-12 (generated: f0 recoil, f1 settle). Bands are proportional
// thirds of the frame height, so any frame size works (16x16 cats included).

export const POSE_SHEET_ROWS = 13;
export const ATTACK_ROW_START = 5;
export const HURT_ROW_START = 9;

// The four walk rows' frame-pair cells with each direction's facing vector.
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

interface Band {
  y0: number;
  y1: number;
  dx: number;
  dy: number;
}

function bands(h: number, sx: number, head: [number, number], torso: [number, number]): Band[] {
  const third = Math.floor(h / 3);
  return [
    { y0: third * 2, y1: h - 1, dx: 0, dy: 0 }, // legs stay planted
    { y0: third, y1: third * 2 - 1, dx: torso[0] * (sx || 1), dy: torso[1] },
    { y0: 0, y1: third - 1, dx: head[0] * (sx || 1), dy: head[1] },
  ];
}

// Shear shapes per pose frame. Horizontal facings lean along sx; straight
// N/S facings (sx=0) read through vertical motion instead.
function poseBands(h: number, sx: number, fy: number, pose: 'windup' | 'swing' | 'recoil' | 'settle'): Band[] {
  if (sx !== 0) {
    switch (pose) {
      case 'windup': return bands(h, sx, [-2, 0], [-1, 0]);
      case 'swing': return bands(h, sx, [3, 1], [1, 1]);
      case 'recoil': return bands(h, sx, [-2, 2], [-1, 1]);
      case 'settle': return bands(h, sx, [-1, 1], [-1, 1]);
    }
  }
  const lean = fy > 0 ? 1 : -1; // S leans down-screen, N reaches away
  switch (pose) {
    case 'windup': return bands(h, 0, [0, 1], [0, 1]);
    case 'swing': return bands(h, 0, [0, lean * 2], [0, lean]);
    case 'recoil': return bands(h, 0, [0, 2], [0, 1]);
    case 'settle': return bands(h, 0, [0, 1], [0, 1]);
  }
}

function drawPosed(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  srcRow: number,
  srcCol: number,
  dstRow: number,
  dstCol: number,
  bandList: Band[]
): void {
  const cellX = dstCol * w;
  const cellY = dstRow * h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, w, h);
  ctx.clip();
  for (const b of bandList) {
    const bh = b.y1 - b.y0 + 1;
    if (bh <= 0) continue;
    ctx.drawImage(src, srcCol * w, srcRow * h + b.y0, w, bh, cellX + b.dx, cellY + b.y0 + b.dy, w, bh);
  }
  ctx.restore();
}

/**
 * Build a 13-row pose sheet from a ROM walk sheet (4+ rows). The returned
 * canvas is the LIVE drawable sheet; callers may paint authored override
 * patches on top of the generated bands.
 */
export function generatePoseSheet(src: CanvasImageSource, w: number, h: number, srcRows: number): HTMLCanvasElement {
  const sheet = document.createElement('canvas');
  sheet.width = w * 4;
  sheet.height = h * POSE_SHEET_ROWS;
  const ctx = sheet.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  // Walk rows (and climb row 4 if the source carries one).
  const copyRows = Math.min(srcRows, 5);
  ctx.drawImage(src, 0, 0, w * 4, h * copyRows, 0, 0, w * 4, h * copyRows);

  for (const d of DIR_CELLS) {
    const sx = Math.sign(d.fx);
    // Attack: wind-up (f0) + swing (f1), posed from the standing frame.
    drawPosed(ctx, src, w, h, d.row, d.col, d.row + ATTACK_ROW_START, d.col, poseBands(h, sx, d.fy, 'windup'));
    drawPosed(ctx, src, w, h, d.row, d.col, d.row + ATTACK_ROW_START, d.col + 1, poseBands(h, sx, d.fy, 'swing'));
    // Hurt: recoil (f0) + settle (f1).
    drawPosed(ctx, src, w, h, d.row, d.col, d.row + HURT_ROW_START, d.col, poseBands(h, sx, d.fy, 'recoil'));
    drawPosed(ctx, src, w, h, d.row, d.col, d.row + HURT_ROW_START, d.col + 1, poseBands(h, sx, d.fy, 'settle'));
  }
  return sheet;
}
