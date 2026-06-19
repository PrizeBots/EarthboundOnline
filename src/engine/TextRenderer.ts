/**
 * TextRenderer — EarthBound bitmap font renderer.
 *
 * Every font sheet is a 16-column x 8-row grid of 128 characters; the cell
 * size varies per font (16x16 for the dialogue fonts, 8x8 for the small
 * battle font) and is derived from the sheet dimensions at load time.
 * Character 0 in the grid = ASCII 0x20 (space).
 * The width JSON is an array of per-character advance widths (index = grid position).
 */

import { loadImage, loadJSON } from './AssetLoader';

const SHEET_COLS = 16;
const SHEET_ROWS = 8;
const ASCII_OFFSET = 0x20; // Grid position 0 = ASCII space

// EarthBound's font stores 5 PSI tier symbols right AFTER 'Z' (grid 58) — at the
// cells our plain-ASCII mapping would call [ \ ] ^ _ (grid 59–63). PSI names
// carry the real Unicode Greek letters (e.g. "Lifeup α"), whose codepoints fall
// outside the 0x20–0x9F grid and would otherwise be skipped (rendering blank, so
// every tier looked identical). Remap those codepoints onto the bitmap cells so
// the Greek tiers render in the EB font. KEEP IN SYNC with the font sheet order.
const GREEK_GLYPH_GRID: Record<number, number> = {
  0x3b1: 59, // α alpha
  0x3b2: 60, // β beta
  0x3b3: 61, // γ gamma
  0x3a3: 62, // Σ sigma
  0x3a9: 63, // Ω omega
};

/** Grid cell for a character code: a remapped Greek tier symbol, else the plain
 *  ASCII offset. -1 if it falls outside the 128-cell sheet. */
function gridIndexFor(code: number): number {
  const g = GREEK_GLYPH_GRID[code] ?? code - ASCII_OFFSET;
  return g >= 0 && g < 128 ? g : -1;
}

interface FontData {
  image: HTMLImageElement;
  widths: number[];
  cellW: number;
  cellH: number;
}

const fontCache = new Map<number, FontData>();

export async function loadFont(fontId: number = 1): Promise<void> {
  if (fontCache.has(fontId)) return;

  const [image, widths] = await Promise.all([
    loadImage(`/assets/fonts/font_${fontId}.png`),
    loadJSON<number[]>(`/assets/fonts/font_${fontId}_widths.json`),
  ]);

  fontCache.set(fontId, {
    image,
    widths,
    cellW: image.width / SHEET_COLS,
    cellH: image.height / SHEET_ROWS,
  });
}

/** Line height (cell height) of a loaded font; 16 if not loaded yet. */
export function getLineHeight(fontId: number): number {
  return fontCache.get(fontId)?.cellH ?? 16;
}

/**
 * Draw a string at (x, y) using the specified bitmap font.
 * Characters are drawn left-to-right using per-char advance widths.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontId: number = 1,
  tracking: number = 1
): void {
  const font = fontCache.get(fontId);
  if (!font) {
    // Font not loaded — fallback
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.fillText(text, x, y + 12);
    ctx.restore();
    return;
  }

  const { image, widths, cellW, cellH } = font;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  let cursorX = x;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) continue; // skip newline

    const gridIndex = gridIndexFor(code);
    if (gridIndex < 0) continue; // out of range

    const col = gridIndex % SHEET_COLS;
    const row = Math.floor(gridIndex / SHEET_COLS);
    const sx = col * cellW;
    const sy = row * cellH;

    const charWidth = widths[gridIndex] ?? cellW;
    if (charWidth === 255) continue; // undefined character

    ctx.drawImage(image, sx, sy, cellW, cellH, cursorX, y, cellW, cellH);
    cursorX += charWidth + tracking;
  }

  ctx.restore();
}

/**
 * Measure the pixel width of a string with the given font.
 */
export function measureText(text: string, fontId: number = 1, tracking: number = 1): number {
  const font = fontCache.get(fontId);
  if (!font) return text.length * 8;

  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const gridIndex = gridIndexFor(text.charCodeAt(i));
    if (gridIndex < 0) continue;
    const charWidth = font.widths[gridIndex] ?? font.cellW;
    if (charWidth === 255) continue;
    w += charWidth + tracking;
  }
  return w > 0 ? w - tracking : 0;
}

/** Cell height of the 16px dialogue fonts (0-2) — use getLineHeight for others. */
export const FONT_LINE_HEIGHT = 16;
