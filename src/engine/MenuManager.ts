/**
 * MenuManager — EarthBound's overworld command window.
 *
 * E (or X / Escape) opens the command window in the top-left: a 3x2 grid of
 * Talk to / Goods / PSI / Equip / Check / Status, navigated with the arrow
 * keys (or WASD) and a ">" cursor, just like pressing A in EarthBound.
 * Confirming a command that has no game system behind it yet opens a small
 * dialogue window at the bottom of the screen; any action key dismisses it.
 *
 * On real SNES this is a BG3 text window — same window/font assets, so it
 * ports directly.
 */

import { drawWindow }                              from './WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from './TextRenderer';
import { renderStatus }                            from './StatusModal';
import { getPointer, consumePointerClick }         from './Input';
import { getGoods }                                from './Inventory';
import { getMoney }                                from './Wallet';
import { sendUseItem, sendUsePsi }                 from './Network';
import { SCREEN_WIDTH, SCREEN_HEIGHT }             from '../types';

const MENU_STYLE = 0;          // EB "Plain" dark-blue flavor
const BORDER     = 6;
const PADDING    = 4;
const ITEM_H     = FONT_LINE_HEIGHT + 2;
const FONT_ID    = 0;          // regular EB dialogue font, as in the real menu
const COL_GAP    = 6;          // horizontal gap between command columns
const CURSOR_W   = 9;          // arrow (5px) + gap before the label

// EarthBound's cursor is a solid right-pointing triangle, not a text glyph
// (the EB font has curly quotes where ASCII '<'/'>' would be). Drawn as
// pixel columns so it stays crisp: heights 9,7,5,3,1.
function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#f0f0f0';
  for (let col = 0; col < 5; col++) {
    ctx.fillRect(x + col, y + col, 1, 9 - col * 2);
  }
}

// EarthBound's command window: 2 rows x 3 columns, read left to right.
const MENU_ITEMS = [
  { label: 'Talk to', action: 'talk'   },
  { label: 'Goods',   action: 'goods'  },
  { label: 'PSI',     action: 'psi'    },
  { label: 'Equip',   action: 'equip'  },
  { label: 'Check',   action: 'check'  },
  { label: 'Status',  action: 'status' },
];
const COLS = 3;
const ROWS = 2;

// PSI abilities castable from the PSI command. Static for now; the server
// validates the PP cost and resolves the effect (so a client can't self-heal).
const PSI_ABILITIES = [
  { id: 'lifeup', name: 'Lifeup α' }, // Lifeup α — restores HP
];

// Placeholder responses until the real systems (inventory, PSI, stats,
// NPC dialogue) exist. Each shows in an EB-style bottom dialogue window.
const STUB_MESSAGES: Record<string, string> = {
  talk:   "There's nobody close enough to talk to. (Enter opens chat.)",
  goods:  "You aren't carrying anything yet.",
  psi:    "You can't use PSI yet.",
  equip:  "You have nothing to equip.",
  check:  "There's nothing unusual here.",
};

type MenuState = 'closed' | 'command' | 'message' | 'status' | 'goods' | 'psi';

interface Cell { x: number; y: number; w: number; h: number; }

/**
 * Geometry of the command window and each item's clickable cell. Shared by the
 * renderer and the mouse hit-test so the two never drift apart.
 */
function commandLayout(): { winX: number; winY: number; winW: number; winH: number; cells: Cell[] } {
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
function cellAt(px: number, py: number): number {
  const { cells } = commandLayout();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

// The Goods list: a vertical window under the command grid, one row per item.
// Width fits the longest name (with room for the cursor); height grows with the
// item count. Shares geometry with the mouse hit-test, like commandLayout().
const GOODS_MIN_W = 96;
function goodsLayout(): { winX: number; winY: number; winW: number; winH: number; rows: Cell[] } {
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
function goodsRowAt(px: number, py: number): number {
  const { rows } = goodsLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

// The PSI ability list — same vertical-window layout as Goods, tucked under the
// command grid. Static list, so no inventory lookup.
function psiLayout(): { winX: number; winY: number; winW: number; winH: number; rows: Cell[] } {
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
function psiRowAt(px: number, py: number): number {
  const { rows } = psiLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

let menuState: MenuState = 'closed';
let cursorIndex = 0;
let goodsCursor = 0;
let psiCursor = 0;
let message = '';

const prevKeys = new Set<string>();
let liveKeys: Set<string>;

export function initMenu(keySet: Set<string>): void {
  liveKeys = keySet;
}

export function updateMenu(): void {
  if (!liveKeys) return;

  const justPressed = (code: string) =>
    liveKeys.has(code) && !prevKeys.has(code);
  const toggle  = justPressed('KeyE') || justPressed('KeyX') || justPressed('Escape');
  // Confirm/activate a command: Z, Space, Enter, or Q (the contextual button).
  const confirm = justPressed('KeyZ') || justPressed('Space') ||
                  justPressed('Enter') || justPressed('KeyQ');
  // A left-click anywhere this frame (game-space coords), consumed once.
  const click = menuState === 'closed' ? null : consumePointerClick();

  if (menuState === 'closed') {
    if (toggle) {
      menuState = 'command';
      cursorIndex = 0;
      consumePointerClick(); // drop any click left over from gameplay
    }
  } else if (menuState === 'command') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'closed';
    } else {
      let col = cursorIndex % COLS;
      let row = Math.floor(cursorIndex / COLS);
      if (justPressed('ArrowLeft')  || justPressed('KeyA')) col = (col + COLS - 1) % COLS;
      if (justPressed('ArrowRight') || justPressed('KeyD')) col = (col + 1) % COLS;
      if (justPressed('ArrowUp')    || justPressed('KeyW')) row = (row + ROWS - 1) % ROWS;
      if (justPressed('ArrowDown')  || justPressed('KeyS')) row = (row + 1) % ROWS;
      cursorIndex = row * COLS + col;

      // Mouse hover moves the cursor to the item under the pointer.
      const p = getPointer();
      const hovered = cellAt(p.x, p.y);
      if (hovered >= 0) cursorIndex = hovered;

      // Activate via keyboard confirm, or by clicking directly on an item.
      let activate = confirm ? cursorIndex : -1;
      if (click) {
        const clicked = cellAt(click.x, click.y);
        if (clicked >= 0) activate = clicked;
      }
      if (activate >= 0) {
        cursorIndex = activate;
        onSelect(MENU_ITEMS[activate].action);
      }
    }
  } else if (menuState === 'message') {
    // Any action/cancel key (or a click) dismisses the result window.
    if (toggle || confirm || click || justPressed('Backspace')) {
      menuState = 'closed';
    }
  } else if (menuState === 'status') {
    // Any action/cancel key (or a click) returns to the command grid, as in EB.
    if (toggle || confirm || click || justPressed('Backspace')) {
      menuState = 'command';
    }
  } else if (menuState === 'goods') {
    const items = getGoods();
    if (toggle || justPressed('Backspace') || items.length === 0) {
      menuState = 'command'; // cancel, or nothing left to show
    } else {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) goodsCursor = (goodsCursor + items.length - 1) % items.length;
      if (justPressed('ArrowDown') || justPressed('KeyS')) goodsCursor = (goodsCursor + 1) % items.length;

      // Mouse hover moves the cursor to the row under the pointer.
      const p = getPointer();
      const hovered = goodsRowAt(p.x, p.y);
      if (hovered >= 0) goodsCursor = hovered;

      // Use via keyboard confirm, or by clicking directly on a row.
      let use = confirm ? goodsCursor : -1;
      if (click) {
        const clicked = goodsRowAt(click.x, click.y);
        if (clicked >= 0) use = clicked;
      }
      if (use >= 0 && items[use]) {
        // Server-authoritative: ask to use it; the resulting `inventory` and
        // `player_hp` deltas (Cookie heals 10) flow back through Network.
        sendUseItem(items[use].id);
        // Keep the cursor in range for the next (shorter) list.
        if (goodsCursor >= items.length - 1) goodsCursor = Math.max(0, items.length - 2);
      }
    }
  } else if (menuState === 'psi') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'command'; // cancel back to the command grid
    } else {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) psiCursor = (psiCursor + PSI_ABILITIES.length - 1) % PSI_ABILITIES.length;
      if (justPressed('ArrowDown') || justPressed('KeyS')) psiCursor = (psiCursor + 1) % PSI_ABILITIES.length;

      const p = getPointer();
      const hovered = psiRowAt(p.x, p.y);
      if (hovered >= 0) psiCursor = hovered;

      let use = confirm ? psiCursor : -1;
      if (click) {
        const clicked = psiRowAt(click.x, click.y);
        if (clicked >= 0) use = clicked;
      }
      if (use >= 0 && PSI_ABILITIES[use]) {
        // Server-authoritative: it checks PP, applies the effect, and pushes
        // back player_hp (heal) + player_stats (PP decrease) so the bar redraws.
        sendUsePsi(PSI_ABILITIES[use].id);
      }
    }
  }

  prevKeys.clear();
  for (const k of liveKeys) prevKeys.add(k);
}

export function isMenuOpen(): boolean {
  return menuState !== 'closed';
}

export function renderMenu(ctx: CanvasRenderingContext2D): void {
  if (menuState === 'closed') return;
  if (menuState === 'message') {
    renderMessage(ctx);
    return;
  }
  if (menuState === 'status') {
    renderStatus(ctx);
    return;
  }
  if (menuState === 'goods') {
    renderCommand(ctx);  // keep the command grid visible behind the Goods list
    renderGoods(ctx);
    return;
  }
  if (menuState === 'psi') {
    renderCommand(ctx);  // command grid stays visible behind the PSI list
    renderPsi(ctx);
    return;
  }

  renderCommand(ctx);
}

function renderCommand(ctx: CanvasRenderingContext2D): void {
  // Window + per-item cells share commandLayout() with the mouse hit-test, so
  // the grid stays aligned like EB's fixed-width command window.
  const { winX, winY, winW, winH, cells } = commandLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const { x, y } = cells[i];
    // Only the command grid shows its cursor when the Goods list is open.
    if (i === cursorIndex && menuState === 'command') {
      drawCursor(ctx, x, y + 3);
    }
    drawText(ctx, MENU_ITEMS[i].label, x + CURSOR_W, y, FONT_ID);
  }

  renderMoney(ctx); // EB-style cash window, shown whenever the menu is open
}

/**
 * The money window: a small EB cash window in the top-right, mirroring the
 * command window's top edge. Shows the server-authoritative balance as "$N".
 */
function renderMoney(ctx: CanvasRenderingContext2D): void {
  const label = `$${getMoney()}`;
  const innerW = Math.max(40, measureText(label, FONT_ID));
  const winW = innerW + PADDING * 2 + BORDER * 2;
  const winH = ITEM_H + PADDING * 2 + BORDER * 2;
  const winX = SCREEN_WIDTH - 8 - winW; // right-aligned, 8px margin like the menu
  const winY = 8;                        // same top edge as the command window
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  drawText(ctx, label, winX + BORDER + PADDING, winY + BORDER + PADDING, FONT_ID);
}

function renderGoods(ctx: CanvasRenderingContext2D): void {
  const items = getGoods();
  const { winX, winY, winW, winH, rows } = goodsLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);

  for (let i = 0; i < items.length; i++) {
    const { x, y } = rows[i];
    if (i === goodsCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, items[i].name, x + CURSOR_W, y, FONT_ID);
  }
}

function renderPsi(ctx: CanvasRenderingContext2D): void {
  const { winX, winY, winW, winH, rows } = psiLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < PSI_ABILITIES.length; i++) {
    const { x, y } = rows[i];
    if (i === psiCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, PSI_ABILITIES[i].name, x + CURSOR_W, y, FONT_ID);
  }
}

function renderMessage(ctx: CanvasRenderingContext2D): void {
  const innerW = SCREEN_WIDTH - 16 - BORDER * 2 - PADDING * 2;
  const lines = wrapText(message, innerW);
  const winW = SCREEN_WIDTH - 16;
  const winH = lines.length * FONT_LINE_HEIGHT + PADDING * 2 + BORDER * 2;
  const winX = 8;
  const winY = SCREEN_HEIGHT - 8 - winH;

  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < lines.length; i++) {
    drawText(
      ctx,
      lines[i],
      winX + BORDER + PADDING,
      winY + BORDER + PADDING + i * FONT_LINE_HEIGHT,
      FONT_ID
    );
  }
}

function onSelect(action: string): void {
  if (action === 'status') {
    menuState = 'status';
    return;
  }
  if (action === 'goods') {
    if (getGoods().length === 0) {
      message = STUB_MESSAGES.goods; // "You aren't carrying anything yet."
      menuState = 'message';
    } else {
      goodsCursor = 0;
      menuState = 'goods';
    }
    return;
  }
  if (action === 'psi') {
    psiCursor = 0;
    menuState = 'psi';
    return;
  }
  message = STUB_MESSAGES[action] ?? '...';
  menuState = 'message';
}

/** Word-wrap text to a pixel width (same approach as chat bubbles). */
function wrapText(text: string, maxW: number): string[] {
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
