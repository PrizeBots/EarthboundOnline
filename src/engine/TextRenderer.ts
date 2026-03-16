/**
 * TextRenderer — EarthBound bitmap font renderer.
 *
 * Font PNGs are 256×128 with 16×16-pixel character cells.
 * Grid: 16 columns × 8 rows = 128 characters.
 * Character 0 in the grid = ASCII 0x20 (space).
 * The width JSON is an array of per-character advance widths (index = grid position).
 */

import { loadImage, loadJSON } from './AssetLoader';

const CHAR_CELL_W = 16;
const CHAR_CELL_H = 16;
const SHEET_COLS  = 16;   // 256px / 16px = 16 chars per row
const ASCII_OFFSET = 0x20; // Grid position 0 = ASCII space

interface FontData {
  image:  HTMLImageElement;
  widths: number[];
}

const fontCache = new Map<number, FontData>();

export async function loadFont(fontId: number = 1): Promise<void> {
  if (fontCache.has(fontId)) return;

  const [image, widths] = await Promise.all([
    loadImage(`/assets/fonts/font_${fontId}.png`),
    loadJSON<number[]>(`/assets/fonts/font_${fontId}_widths.json`),
  ]);

  fontCache.set(fontId, { image, widths });
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

  const { image, widths } = font;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  let cursorX = x;
  for (let i = 0; i < text.length; i++) {
    const ascii = text.charCodeAt(i);
    if (ascii === 0x0a) continue; // skip newline

    const gridIndex = ascii - ASCII_OFFSET;
    if (gridIndex < 0 || gridIndex >= 128) continue; // out of range

    const col = gridIndex % SHEET_COLS;
    const row = Math.floor(gridIndex / SHEET_COLS);
    const sx  = col * CHAR_CELL_W;
    const sy  = row * CHAR_CELL_H;

    const charWidth = widths[gridIndex] ?? CHAR_CELL_W;
    if (charWidth === 255) continue; // undefined character

    ctx.drawImage(image, sx, sy, CHAR_CELL_W, CHAR_CELL_H, cursorX, y, CHAR_CELL_W, CHAR_CELL_H);
    cursorX += charWidth + 1;
  }

  ctx.restore();
}

/**
 * Measure the pixel width of a string with the given font.
 */
export function measureText(text: string, fontId: number = 1): number {
  const font = fontCache.get(fontId);
  if (!font) return text.length * 8;

  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const gridIndex = text.charCodeAt(i) - ASCII_OFFSET;
    if (gridIndex < 0 || gridIndex >= 128) continue;
    const charWidth = font.widths[gridIndex] ?? CHAR_CELL_W;
    if (charWidth === 255) continue;
    w += charWidth + 1;
  }
  return w > 0 ? w - 1 : 0;
}

export const FONT_LINE_HEIGHT = CHAR_CELL_H;
