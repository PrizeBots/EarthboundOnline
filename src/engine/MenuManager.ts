/**
 * MenuManager — EarthBound-style pause menu.
 */

import { drawWindow }                     from './WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from './TextRenderer';
import { SCREEN_WIDTH }                   from '../types';

const MENU_STYLE = 0;
const BORDER     = 6;
const PADDING    = 4;
const ITEM_H     = FONT_LINE_HEIGHT + 2;
const CURSOR_STR = '>';
const FONT_ID    = 1;

const MENU_ITEMS = [
  { label: 'Goods',  action: 'goods'  },
  { label: 'Equip',  action: 'equip'  },
  { label: 'Check',  action: 'check'  },
  { label: 'Status', action: 'status' },
  { label: 'PSI',    action: 'psi'    },
  { label: 'Exit',   action: 'exit'   },
];

type MenuState = 'closed' | 'open';

let menuState: MenuState = 'closed';
let cursorIndex = 0;

const prevKeys = new Set<string>();
let liveKeys: Set<string>;

export function initMenu(keySet: Set<string>): void {
  liveKeys = keySet;
}

export function updateMenu(): void {
  if (!liveKeys) return;

  const justPressed = (code: string) =>
    liveKeys.has(code) && !prevKeys.has(code);

  if (justPressed('KeyX') || justPressed('Escape')) {
    menuState = menuState === 'closed' ? 'open' : 'closed';
  }

  if (menuState === 'open') {
    if (justPressed('ArrowUp') || justPressed('KeyW')) {
      cursorIndex = (cursorIndex - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
    }
    if (justPressed('ArrowDown') || justPressed('KeyS')) {
      cursorIndex = (cursorIndex + 1) % MENU_ITEMS.length;
    }
    if (justPressed('KeyZ') || justPressed('Space') || justPressed('Enter')) {
      _onSelect(MENU_ITEMS[cursorIndex].action);
    }
    if (justPressed('KeyA') || justPressed('Backspace')) {
      menuState = 'closed';
    }
  }

  prevKeys.clear();
  for (const k of liveKeys) prevKeys.add(k);
}

export function isMenuOpen(): boolean {
  return menuState === 'open';
}

export function renderMenu(ctx: CanvasRenderingContext2D): void {
  if (menuState === 'closed') return;

  // Measure widest label
  const cursorW = measureText(CURSOR_STR, FONT_ID) + 4;
  const maxLabelW = Math.max(...MENU_ITEMS.map(i => measureText(i.label, FONT_ID)));
  const innerW = cursorW + maxLabelW + PADDING * 2;
  const innerH = MENU_ITEMS.length * ITEM_H + PADDING * 2;
  const winW = innerW + BORDER * 2;
  const winH = innerH + BORDER * 2;

  const winX = SCREEN_WIDTH - winW - 8;
  const winY = 8;

  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);

  const textX  = winX + BORDER + PADDING + cursorW;
  const firstY = winY + BORDER + PADDING;

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const itemY = firstY + i * ITEM_H;

    if (i === cursorIndex) {
      drawText(ctx, CURSOR_STR, winX + BORDER + PADDING, itemY, FONT_ID);
    }

    drawText(ctx, MENU_ITEMS[i].label, textX, itemY, FONT_ID);
  }
}

function _onSelect(action: string): void {
  console.log(`[Menu] Selected: ${action}`);
  menuState = 'closed';
}
