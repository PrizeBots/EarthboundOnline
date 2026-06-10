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
import { SCREEN_WIDTH, SCREEN_HEIGHT }             from '../types';

const MENU_STYLE = 0;          // EB "Plain" dark-blue flavor
const BORDER     = 6;
const PADDING    = 4;
const ITEM_H     = FONT_LINE_HEIGHT + 2;
const CURSOR_STR = '>';
const FONT_ID    = 0;          // regular EB dialogue font, as in the real menu
const COL_GAP    = 6;          // horizontal gap between command columns

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

// Placeholder responses until the real systems (inventory, PSI, stats,
// NPC dialogue) exist. Each shows in an EB-style bottom dialogue window.
const STUB_MESSAGES: Record<string, string> = {
  talk:   "There's nobody close enough to talk to. (Enter opens chat.)",
  goods:  "You aren't carrying anything yet.",
  psi:    "You can't use PSI yet.",
  equip:  "You have nothing to equip.",
  check:  "There's nothing unusual here.",
  status: "You're feeling fine.",
};

type MenuState = 'closed' | 'command' | 'message';

let menuState: MenuState = 'closed';
let cursorIndex = 0;
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
  const confirm = justPressed('KeyZ') || justPressed('Space') || justPressed('Enter');

  if (menuState === 'closed') {
    if (toggle) {
      menuState = 'command';
      cursorIndex = 0;
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

      if (confirm) {
        onSelect(MENU_ITEMS[cursorIndex].action);
      }
    }
  } else if (menuState === 'message') {
    // Any action/cancel key dismisses the result window.
    if (toggle || confirm || justPressed('Backspace')) {
      menuState = 'closed';
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

  // Every column is wide enough for the widest label plus the cursor slot,
  // so the grid stays aligned like EB's fixed-width command window.
  const cursorW = measureText(CURSOR_STR, FONT_ID) + 3;
  const maxLabelW = Math.max(...MENU_ITEMS.map((i) => measureText(i.label, FONT_ID)));
  const colW = cursorW + maxLabelW + COL_GAP;
  const innerW = COLS * colW - COL_GAP + PADDING * 2;
  const innerH = ROWS * ITEM_H + PADDING * 2;

  const winX = 8;
  const winY = 8;
  drawWindow(ctx, winX, winY, innerW + BORDER * 2, innerH + BORDER * 2, MENU_STYLE);

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cellX = winX + BORDER + PADDING + col * colW;
    const cellY = winY + BORDER + PADDING + row * ITEM_H;

    if (i === cursorIndex) {
      drawText(ctx, CURSOR_STR, cellX, cellY, FONT_ID);
    }
    drawText(ctx, MENU_ITEMS[i].label, cellX + cursorW, cellY, FONT_ID);
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
