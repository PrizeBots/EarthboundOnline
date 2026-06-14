/**
 * menu/layout.ts — pure geometry for the command window and its sub-screens.
 *
 * Every window's box + per-row clickable cells live here, shared by MenuManager's
 * renderer and its mouse hit-tests so the two never drift. These functions are
 * pure: they read only the menu constants, the global data getters (goods/shop),
 * and their arguments — never MenuManager's mutable UI state. The few that need
 * runtime state (the open shop's store id, the equip-row count) take it as a
 * parameter, which is why this file has no dependency back on MenuManager.
 */
import { measureText, FONT_LINE_HEIGHT } from '../TextRenderer';
import { getGoods } from '../Inventory';
import { getStoreItems, sellPrice } from '../Shop';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../../types';

export const MENU_STYLE = 0; // EB "Plain" dark-blue window flavor
export const BORDER = 6;
export const PADDING = 4;
export const ITEM_H = FONT_LINE_HEIGHT + 2;
export const FONT_ID = 0; // regular EB dialogue font, as in the real menu
export const COL_GAP = 6; // horizontal gap between command columns
export const CURSOR_W = 9; // arrow (5px) + gap before the label

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

// EarthBound's cursor is a solid right-pointing triangle, not a text glyph
// (the EB font has curly quotes where ASCII '<'/'>' would be). Drawn as
// pixel columns so it stays crisp: heights 9,7,5,3,1.
export function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#f0f0f0';
  for (let col = 0; col < 5; col++) {
    ctx.fillRect(x + col, y + col, 1, 9 - col * 2);
  }
}

// Command window: 2 rows x 2 columns, read left to right. Talk to / Check were
// removed — the E button handles contextual talk/check in the field.
export const MENU_ITEMS = [
  { label: 'Goods', action: 'goods' },
  { label: 'PSI', action: 'psi' },
  { label: 'Equip', action: 'equip' },
  { label: 'Status', action: 'status' },
];
export const COLS = 2;
export const ROWS = 2;

// PSI abilities castable from the PSI command. Static for now; the server
// validates the PP cost and resolves the effect (so a client can't self-heal).
export const PSI_ABILITIES = [
  { id: 'lifeup', name: 'Lifeup α' }, // Lifeup α — restores HP
];

// Shop Buy/Sell chooser labels.
export const SHOP_ROOT = ['Buy', 'Sell'];

/**
 * Geometry of the command window and each item's clickable cell. Shared by the
 * renderer and the mouse hit-test so the two never drift apart.
 */
export function commandLayout(): {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  cells: Cell[];
} {
  const maxLabelW = Math.max(...MENU_ITEMS.map((i) => measureText(i.label, FONT_ID)));
  const colW = CURSOR_W + maxLabelW + COL_GAP;
  const innerW = COLS * colW - COL_GAP + PADDING * 2;
  const innerH = ROWS * ITEM_H + PADDING * 2;
  const winX = 8;
  const winY = 8;

  const cells: Cell[] = [];
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    cells.push({
      x: winX + BORDER + PADDING + col * colW,
      y: winY + BORDER + PADDING + row * ITEM_H,
      w: colW - COL_GAP,
      h: ITEM_H,
    });
  }
  return { winX, winY, winW: innerW + BORDER * 2, winH: innerH + BORDER * 2, cells };
}

/** Index of the command cell under a game-space point, or -1. */
export function cellAt(px: number, py: number): number {
  const { cells } = commandLayout();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

// The Goods list: a vertical window under the command grid, one row per item.
const GOODS_MIN_W = 96;
export function goodsLayout(): {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  rows: Cell[];
} {
  const items = getGoods();
  const labels = items.map((i) => i.name);
  const maxLabelW = labels.length ? Math.max(...labels.map((l) => measureText(l, FONT_ID))) : 0;
  const innerW = Math.max(GOODS_MIN_W, CURSOR_W + maxLabelW);
  const count = Math.max(1, items.length); // keep a non-zero box even if empty
  const innerH = count * ITEM_H + PADDING * 2;
  const cmd = commandLayout();
  const winX = cmd.winX;
  const winY = cmd.winY + cmd.winH + 2; // tucked just below the command window

  const rows: Cell[] = [];
  for (let i = 0; i < items.length; i++) {
    rows.push({
      x: winX + BORDER + PADDING,
      y: winY + BORDER + PADDING + i * ITEM_H,
      w: innerW,
      h: ITEM_H,
    });
  }
  return { winX, winY, winW: innerW + PADDING * 2 + BORDER * 2, winH: innerH + BORDER * 2, rows };
}

/** Index of the Goods row under a game-space point, or -1. */
export function goodsRowAt(px: number, py: number): number {
  const { rows } = goodsLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

const EQUIP_ROW_W = 132; // inner width (slot label + item name)

/** The combined Equip list window (slots + unequipped gear). `rowCount` is the
 *  number of rows (4 slots + unequipped gear), supplied by MenuManager. */
export function equipListLayout(rowCount: number): {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  rows: Cell[];
} {
  const cmd = commandLayout();
  const winX = cmd.winX;
  const winY = cmd.winY + cmd.winH + 2;
  const n = Math.max(1, rowCount);
  const innerH = n * ITEM_H + PADDING * 2;
  const rows: Cell[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      x: winX + BORDER + PADDING,
      y: winY + BORDER + PADDING + i * ITEM_H,
      w: EQUIP_ROW_W,
      h: ITEM_H,
    });
  }
  return {
    winX,
    winY,
    winW: EQUIP_ROW_W + PADDING * 2 + BORDER * 2,
    winH: innerH + BORDER * 2,
    rows,
  };
}

export function equipRowAt(px: number, py: number, rowCount: number): number {
  const { rows } = equipListLayout(rowCount);
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

// The PSI ability list — same vertical-window layout as Goods, tucked under the
// command grid. Static list, so no inventory lookup.
export function psiLayout(): {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  rows: Cell[];
} {
  const maxLabelW = Math.max(...PSI_ABILITIES.map((a) => measureText(a.name, FONT_ID)));
  const innerW = Math.max(GOODS_MIN_W, CURSOR_W + maxLabelW);
  const innerH = PSI_ABILITIES.length * ITEM_H + PADDING * 2;
  const cmd = commandLayout();
  const winX = cmd.winX;
  const winY = cmd.winY + cmd.winH + 2;
  const rows: Cell[] = PSI_ABILITIES.map((_, i) => ({
    x: winX + BORDER + PADDING,
    y: winY + BORDER + PADDING + i * ITEM_H,
    w: innerW,
    h: ITEM_H,
  }));
  return { winX, winY, winW: innerW + PADDING * 2 + BORDER * 2, winH: innerH + BORDER * 2, rows };
}

/** Index of the PSI row under a game-space point, or -1. */
export function psiRowAt(px: number, py: number): number {
  const { rows } = psiLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

// Shop rows render "Name......$Cost"; the list is wide enough for the longest
// such line. Rows come from the store (Buy) or the player's Goods (Sell, half
// price). `store` is the open clerk's store id (MenuManager's shopStore).
export interface ShopRow extends Cell {
  id: string;
  label: string;
}
const SHOP_MIN_W = 120;
export function shopListLayout(
  mode: 'buy' | 'sell',
  store: number
): {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  rows: ShopRow[];
} {
  const src =
    mode === 'buy'
      ? getStoreItems(store).map((i) => ({ id: i.id, name: i.name, price: i.cost }))
      : getGoods().map((g) => ({ id: g.id, name: g.name, price: sellPrice(g.id) }));
  const labels = src.map((r) => `${r.name}  $${r.price}`);
  const maxLabelW = labels.length ? Math.max(...labels.map((l) => measureText(l, FONT_ID))) : 0;
  const innerW = Math.max(SHOP_MIN_W, CURSOR_W + maxLabelW);
  const count = Math.max(1, src.length);
  const innerH = count * ITEM_H + PADDING * 2;
  // Sit to the RIGHT of the Buy/Sell chooser — the hit-test (shopRowAt) and the
  // renderer BOTH use this, so clicks land where the rows are drawn.
  const chooserLabelW = Math.max(...SHOP_ROOT.map((l) => measureText(l, FONT_ID)));
  const chooserW = CURSOR_W + chooserLabelW + PADDING * 2 + BORDER * 2;
  const winX = 8 + chooserW + 4;
  const winY = 8;
  const rows: ShopRow[] = src.map((r, i) => ({
    x: winX + BORDER + PADDING,
    y: winY + BORDER + PADDING + i * ITEM_H,
    w: innerW,
    h: ITEM_H,
    id: r.id,
    label: labels[i],
  }));
  return { winX, winY, winW: innerW + PADDING * 2 + BORDER * 2, winH: innerH + BORDER * 2, rows };
}

export function shopRowAt(mode: 'buy' | 'sell', store: number, px: number, py: number): number {
  const { rows } = shopListLayout(mode, store);
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

/** Index of the Buy/Sell chooser row (top-left window) under a point, or -1. */
export function shopRootRowAt(px: number, py: number): number {
  const labelW = Math.max(...SHOP_ROOT.map((l) => measureText(l, FONT_ID)));
  const w = CURSOR_W + labelW;
  for (let i = 0; i < SHOP_ROOT.length; i++) {
    const x = 8 + BORDER + PADDING;
    const y = 8 + BORDER + PADDING + i * ITEM_H;
    if (px >= x && px < x + w && py >= y && py < y + ITEM_H) return i;
  }
  return -1;
}

// --- Quick-select hotbar geometry (2 slots, bottom-center) -------------------
export const HOTBAR_SLOTS = 2;
const HOTBAR_BOX = 24;
const HOTBAR_GAP = 6;

/** The hotbar boxes, centered at the bottom of the screen. */
export function hotbarLayout(): Cell[] {
  const totalW = HOTBAR_SLOTS * HOTBAR_BOX + (HOTBAR_SLOTS - 1) * HOTBAR_GAP;
  const x0 = Math.floor((SCREEN_WIDTH - totalW) / 2);
  const y = SCREEN_HEIGHT - HOTBAR_BOX - 6;
  const boxes: Cell[] = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    boxes.push({ x: x0 + i * (HOTBAR_BOX + HOTBAR_GAP), y, w: HOTBAR_BOX, h: HOTBAR_BOX });
  }
  return boxes;
}

export function hotbarBoxAt(px: number, py: number): number {
  const boxes = hotbarLayout();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) return i;
  }
  return -1;
}

/** Word-wrap text to a pixel width (same approach as chat bubbles). */
export function wrapText(text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const test = cur ? `${cur} ${word}` : word;
    if (measureText(test, FONT_ID) <= maxW) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
