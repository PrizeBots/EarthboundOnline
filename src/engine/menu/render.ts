/**
 * menu/render.ts — drawing for the command window and its sub-screens.
 *
 * Every function here is a pure function of (ctx, view): it reads the immutable
 * MenuView snapshot MenuManager builds each frame and never mutates state. All
 * the state machine + input lives in MenuManager; this file only paints. Window
 * geometry comes from menu/layout.ts so the renderer and the mouse hit-tests
 * share one source of truth. (The phone/save screens stay in MenuManager — their
 * content constants are bound up with the input that drives them.)
 */
import { drawWindow } from '../WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from '../TextRenderer';
import { getGoods } from '../Inventory';
import { getMoney } from '../Wallet';
import { itemEquip } from '../Shop';
import { drawItemIcon, getItemName } from '../Items';
import { getPointer } from '../Input';
import { EQUIP_SLOTS, SLOT_LABELS } from '../Equipment';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../../types';
import { MenuView } from './types';
import {
  MENU_STYLE,
  BORDER,
  PADDING,
  ITEM_H,
  FONT_ID,
  CURSOR_W,
  MENU_ITEMS,
  PSI_ABILITIES,
  PSI_TAG,
  isPsiEntry,
  psiName,
  SHOP_ROOT,
  drawCursor,
  commandLayout,
  goodsLayout,
  equipListLayout,
  psiLayout,
  shopListLayout,
  hotbarLayout,
  wrapText,
} from './layout';

/** Shop UI: a Buy/Sell chooser top-left, the active list beside it, money
 *  top-right, and an optional note line at the bottom. */
export function renderShop(ctx: CanvasRenderingContext2D, v: MenuView): void {
  // Buy/Sell chooser window (top-left).
  const labelW = Math.max(...SHOP_ROOT.map((l) => measureText(l, FONT_ID)));
  const rootInnerW = CURSOR_W + labelW;
  const rootW = rootInnerW + PADDING * 2 + BORDER * 2;
  const rootH = SHOP_ROOT.length * ITEM_H + PADDING * 2 + BORDER * 2;
  const rootX = 8;
  const rootY = 8;
  drawWindow(ctx, rootX, rootY, rootW, rootH, MENU_STYLE);
  for (let i = 0; i < SHOP_ROOT.length; i++) {
    const x = rootX + BORDER + PADDING;
    const y = rootY + BORDER + PADDING + i * ITEM_H;
    if (v.state === 'shop' && i === v.shopRootCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, SHOP_ROOT[i], x + CURSOR_W, y, FONT_ID);
  }

  renderMoney(ctx);

  // The active list (Buy: store stock; Sell: player Goods), placed to the right
  // of the chooser, at the layout's own coords so rows line up with shopRowAt.
  if (v.state === 'shop_buy' || v.state === 'shop_sell') {
    const mode = v.state === 'shop_buy' ? 'buy' : 'sell';
    const { winX, winY, winW, winH, rows } = shopListLayout(mode, v.shopStore);
    drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
    const cursor = mode === 'buy' ? v.shopBuyCursor : v.shopSellCursor;
    for (let i = 0; i < rows.length; i++) {
      if (i === cursor) drawCursor(ctx, rows[i].x, rows[i].y + 3);
      drawText(ctx, rows[i].label, rows[i].x + CURSOR_W, rows[i].y, FONT_ID);
    }
    if (rows.length === 0) {
      drawText(
        ctx,
        mode === 'buy' ? '(nothing)' : '(empty)',
        winX + BORDER + PADDING + CURSOR_W,
        winY + BORDER + PADDING,
        FONT_ID
      );
    }
  }

  if (v.shopNote) {
    const w = measureText(v.shopNote, FONT_ID) + PADDING * 2 + BORDER * 2;
    const h = ITEM_H + PADDING * 2 + BORDER * 2;
    const x = 8;
    const y = SCREEN_HEIGHT - 8 - h;
    drawWindow(ctx, x, y, w, h, MENU_STYLE);
    drawText(ctx, v.shopNote, x + BORDER + PADDING, y + BORDER + PADDING, FONT_ID);
  }
}

export function renderCommand(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const { winX, winY, winW, winH, cells } = commandLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const { x, y } = cells[i];
    // Only the command grid shows its cursor when a sub-list is open.
    if (i === v.cursorIndex && v.state === 'command') {
      drawCursor(ctx, x, y + 3);
    }
    drawText(ctx, MENU_ITEMS[i].label, x + CURSOR_W, y, FONT_ID);
  }
  renderMoney(ctx); // EB-style cash window, shown whenever the menu is open
}

/** The money window: a small EB cash window in the top-right ("$N"). */
export function renderMoney(ctx: CanvasRenderingContext2D): void {
  const label = `$${getMoney()}`;
  const innerW = Math.max(40, measureText(label, FONT_ID));
  const winW = innerW + PADDING * 2 + BORDER * 2;
  const winH = ITEM_H + PADDING * 2 + BORDER * 2;
  const winX = SCREEN_WIDTH - 8 - winW; // right-aligned, 8px margin like the menu
  const winY = 8; // same top edge as the command window
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  drawText(ctx, label, winX + BORDER + PADDING, winY + BORDER + PADDING, FONT_ID);
}

export function renderGoods(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const items = getGoods();
  const { winX, winY, winW, winH, rows } = goodsLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < items.length; i++) {
    const { x, y } = rows[i];
    if (i === v.goodsCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, items[i].name, x + CURSOR_W, y, FONT_ID);
  }
}

export function renderEquip(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const rows = v.equipRows;
  const { winX, winY, winW, winH, rows: cells } = equipListLayout(rows.length);
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < rows.length; i++) {
    const { x, y } = cells[i];
    if (i === v.equipCursor) drawCursor(ctx, x, y + 3);
    const r = rows[i];
    if (r.kind === 'slot') {
      const id = v.hooks?.getEquipped(r.slot) ?? null;
      drawText(ctx, SLOT_LABELS[r.slot], x + CURSOR_W, y, FONT_ID);
      drawText(ctx, id ? (getItemName(id) ?? '?') : '-', x + CURSOR_W + 42, y, FONT_ID);
    } else {
      const eq = itemEquip(r.id);
      const tag = eq
        ? eq.slot === 'weapon'
          ? `+${eq.offense ?? 0} off`
          : `+${eq.defense ?? 0} def`
        : '';
      drawText(ctx, r.name, x + CURSOR_W, y, FONT_ID);
      drawText(ctx, tag, x + CURSOR_W + 84, y, FONT_ID);
    }
  }
  // Faint divider between the slots and the gear list.
  if (rows.length > EQUIP_SLOTS.length) {
    const sepY = cells[EQUIP_SLOTS.length].y - 1;
    ctx.fillStyle = '#4a5a78';
    ctx.fillRect(cells[0].x, sepY, cells[0].w, 1);
  }

  // Live status panel (Offense/Defense incl. equipped gear) to the right.
  const st = v.equipStats;
  const lines: [string, number][] = [
    ['Offense', st.offense],
    ['Defense', st.defense],
  ];
  const sx = winX + winW + 2;
  const sw = 76;
  const sh = lines.length * ITEM_H + PADDING * 2 + BORDER * 2;
  drawWindow(ctx, sx, winY, sw, sh, MENU_STYLE);
  for (let i = 0; i < lines.length; i++) {
    const yy = winY + BORDER + PADDING + i * ITEM_H;
    drawText(ctx, lines[i][0], sx + BORDER + PADDING, yy, FONT_ID);
    const value = String(lines[i][1]);
    drawText(ctx, value, sx + sw - BORDER - PADDING - measureText(value, FONT_ID), yy, FONT_ID);
  }
}

export function renderPsi(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const { winX, winY, winW, winH, rows } = psiLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < PSI_ABILITIES.length; i++) {
    const { x, y } = rows[i];
    if (i === v.psiCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, PSI_ABILITIES[i].name, x + CURSOR_W, y, FONT_ID);
  }
}

export function renderMessage(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const innerW = SCREEN_WIDTH - 16 - BORDER * 2 - PADDING * 2;
  const lines = wrapText(v.message, innerW);
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

/** Draw a hotbar entry's glyph: an item sprite, or — for a PSI move (which has
 *  no item sprite) — its name abbreviated to fit the box. */
function drawHotbarGlyph(
  ctx: CanvasRenderingContext2D,
  id: string,
  bx: number,
  by: number,
  bw: number,
  bh: number
): void {
  if (isPsiEntry(id)) {
    let label = psiName(id.slice(PSI_TAG.length));
    while (label.length > 1 && measureText(label, FONT_ID) > bw - 2) label = label.slice(0, -1);
    const tx = bx + (bw - measureText(label, FONT_ID)) / 2;
    drawText(ctx, label, tx, by + (bh - FONT_LINE_HEIGHT) / 2, FONT_ID);
  } else {
    const s = Math.min(16, bw - 2); // fit the icon inside the (smaller) box
    drawItemIcon(ctx, id, bx + (bw - s) / 2, by + (bh - s) / 2, s);
  }
}

export function renderHotbar(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const boxes = hotbarLayout();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    // Small dark box (drawWindow's 6px border would crowd a 24px slot).
    ctx.fillStyle = 'rgba(8,12,40,0.85)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = '#8898c8';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    const id = v.hotbar[i];
    if (id) {
      drawHotbarGlyph(ctx, id, b.x, b.y, b.w, b.h);
      // Green ring if this slot's gear is currently equipped in its slot.
      const eq = itemEquip(id);
      if (eq && v.hooks?.getEquipped(eq.slot) === id) {
        ctx.strokeStyle = '#7ee07e';
        ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
      }
    }
    // Tiny number-key label in the top-left corner (native small font — the
    // bitmap menu font is too big for a 16px slot). save/restore so the font +
    // baseline don't leak into other draws.
    ctx.save();
    ctx.font = '5px monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#aebbd6';
    ctx.fillText(String(i + 1), b.x + 1, b.y + 1);
    ctx.restore();
  }
}

export function renderDragGhost(ctx: CanvasRenderingContext2D, v: MenuView): void {
  if (!v.drag) return;
  const p = getPointer();
  ctx.globalAlpha = 0.8;
  drawHotbarGlyph(ctx, v.drag.id, p.x - 12, p.y - 12, 24, 24);
  ctx.globalAlpha = 1;
}
