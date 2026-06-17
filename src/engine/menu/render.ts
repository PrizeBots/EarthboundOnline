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
import { getGoods, goodsCount } from '../Inventory';
import { getMoney } from '../Wallet';
import { itemEquip } from '../Shop';
import { drawItemIcon } from '../Items';
import { drawPsiIcon } from '../PsiFx';
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
  psiAnimId,
  SHOP_ROOT,
  drawCursor,
  commandLayout,
  goodsLayout,
  equipListLayout,
  equipSelectLayout,
  psiLayout,
  shopListLayout,
  shopListItems,
  hotbarLayout,
  wrapText,
  ListLayout,
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
    const cursor = mode === 'buy' ? v.shopBuyCursor : v.shopSellCursor;
    const lay = shopListLayout(mode, v.shopStore, cursor);
    const items = shopListItems(mode, v.shopStore);
    drawWindow(ctx, lay.winX, lay.winY, lay.winW, lay.winH, MENU_STYLE);
    for (const r of lay.rows) {
      const it = items[r.index];
      if (!it) continue;
      if (r.index === cursor) drawCursor(ctx, r.x, r.y + 3);
      drawText(ctx, fitText(it.label, r.w - CURSOR_W), r.x + CURSOR_W, r.y, FONT_ID);
    }
    if (items.length === 0) {
      drawText(
        ctx,
        mode === 'buy' ? '(nothing)' : '(empty)',
        lay.winX + BORDER + PADDING + CURSOR_W,
        lay.winY + BORDER + PADDING,
        FONT_ID
      );
    }
    drawScrollbar(ctx, lay.scroll);

    // Stat preview for the highlighted Buy item (gear only): "Offense 12->17 (+5)"
    // so the player sees the +/- before spending. Sits under the list window.
    if (v.shopPreview && v.shopPreview.lines.length) {
      const texts = v.shopPreview.lines.map((ln) => {
        const d = ln.to - ln.from;
        const sign = d >= 0 ? `+${d}` : `${d}`;
        return `${ln.label}  ${ln.from}->${ln.to} (${sign})`;
      });
      const innerW = Math.max(...texts.map((t) => measureText(t, FONT_ID)));
      const pw = innerW + PADDING * 2 + BORDER * 2;
      const ph = texts.length * FONT_LINE_HEIGHT + PADDING * 2 + BORDER * 2;
      const px = lay.winX;
      const py = lay.winY + lay.winH + 4;
      drawWindow(ctx, px, py, pw, ph, MENU_STYLE);
      texts.forEach((t, i) => {
        drawText(
          ctx,
          t,
          px + BORDER + PADDING,
          py + BORDER + PADDING + i * FONT_LINE_HEIGHT,
          FONT_ID
        );
      });
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
  const lay = goodsLayout();
  drawWindow(ctx, lay.winX, lay.winY, lay.winW, lay.winH, MENU_STYLE);
  for (const r of lay.rows) {
    const it = items[r.index];
    if (!it) continue;
    if (r.index === v.goodsCursor) drawCursor(ctx, r.x, r.y + 3);
    drawText(ctx, fitText(it.name, r.w - CURSOR_W), r.x + CURSOR_W, r.y, FONT_ID);
  }
}

/** Trim `text` so it fits in `maxW` px, adding ".." if it had to be cut. */
function fitText(text: string, maxW: number): string {
  if (measureText(text, FONT_ID) <= maxW) return text;
  let s = text;
  while (s.length > 1 && measureText(s + '..', FONT_ID) > maxW) s = s.slice(0, -1);
  return s + '..';
}

/** Draw a scroll-list's scrollbar (track + thumb), or nothing if it fits. */
function drawScrollbar(ctx: CanvasRenderingContext2D, sb: ListLayout['scroll']): void {
  if (!sb) return;
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(sb.x, sb.y, sb.w, sb.h);
  ctx.fillStyle = '#aebbd6';
  ctx.fillRect(sb.x, sb.thumbY, sb.w, sb.thumbH);
}

/** The Equip slot list (center third): Weapon / Body / Arms / Other, each
 *  showing the equipped item's icon at the right. A small Offense/Defense panel
 *  sits below. The right-third sub-modal is drawn separately (renderEquipSelect). */
export function renderEquip(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const { winX, winY, winW, winH, rows } = equipListLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < EQUIP_SLOTS.length; i++) {
    const slot = EQUIP_SLOTS[i];
    const { x, y, w } = rows[i];
    if (i === v.equipCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, SLOT_LABELS[slot], x + CURSOR_W, y, FONT_ID);
    // Equipped item's icon flush right (so the narrow modal still shows it).
    const id = v.hooks?.getEquipped(slot) ?? null;
    if (id) drawItemIcon(ctx, id, x + w - ITEM_H, y - 1, ITEM_H);
    else drawText(ctx, '-', x + w - measureText('-', FONT_ID), y, FONT_ID);
  }

  // Offense/Defense (incl. equipped gear) just below the slot list.
  const st = v.equipStats;
  const lines: [string, number][] = [
    ['Offense', st.offense],
    ['Defense', st.defense],
  ];
  const sy0 = winY + winH + 2;
  const sh = lines.length * ITEM_H + PADDING * 2 + BORDER * 2;
  drawWindow(ctx, winX, sy0, winW, sh, MENU_STYLE);
  for (let i = 0; i < lines.length; i++) {
    const yy = sy0 + BORDER + PADDING + i * ITEM_H;
    drawText(ctx, lines[i][0], winX + BORDER + PADDING, yy, FONT_ID);
    const value = String(lines[i][1]);
    drawText(ctx, value, winX + winW - BORDER - PADDING - measureText(value, FONT_ID), yy, FONT_ID);
  }
}

/** The Equip sub-modal (right third): the gear the player owns for the chosen
 *  slot, plus a "(Take off)" row. The currently-equipped item is marked. */
export function renderEquipSelect(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const items = v.equipSelectItems;
  const lay = equipSelectLayout(items.length, v.equipSelectCursor);
  drawWindow(ctx, lay.winX, lay.winY, lay.winW, lay.winH, MENU_STYLE);
  const equippedId = v.hooks?.getEquipped(v.equipSlotSel) ?? null;
  for (const r of lay.rows) {
    const it = items[r.index];
    if (!it) continue;
    if (r.index === v.equipSelectCursor) drawCursor(ctx, r.x, r.y + 3);
    const worn = it.id !== '' && it.id === equippedId;
    drawText(
      ctx,
      fitText((worn ? '*' : '') + it.name, r.w - CURSOR_W),
      r.x + CURSOR_W,
      r.y,
      FONT_ID
    );
  }
  drawScrollbar(ctx, lay.scroll);
}

export function renderPsi(ctx: CanvasRenderingContext2D, v: MenuView): void {
  const lay = psiLayout(v.psiCursor);
  drawWindow(ctx, lay.winX, lay.winY, lay.winW, lay.winH, MENU_STYLE);
  for (const r of lay.rows) {
    const a = PSI_ABILITIES[r.index];
    if (!a) continue;
    if (r.index === v.psiCursor) drawCursor(ctx, r.x, r.y + 3);
    drawText(ctx, fitText(a.name, r.w - CURSOR_W), r.x + CURSOR_W, r.y, FONT_ID);
  }
  drawScrollbar(ctx, lay.scroll);
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
    const abilityId = id.slice(PSI_TAG.length);
    // Use the PSI's first animation frame as the slot icon, like weapons/items.
    // The hotbar stores the game id (e.g. 'fire'), whose anim is 'psi_fire_alpha'
    // — resolve through psiAnimId rather than guessing the catalog id.
    const s = Math.min(16, bw - 2);
    if (drawPsiIcon(ctx, psiAnimId(abilityId), bx + (bw - s) / 2, by + (bh - s) / 2, s)) return;
    // Fallback (frames still decoding / no art authored): abbreviated name.
    let label = psiName(abilityId);
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
      const eq = itemEquip(id);
      const isConsumable = !isPsiEntry(id) && !eq;
      const count = isConsumable ? goodsCount(id) : -1; // live stock; -1 = gear/PSI
      const empty = count === 0; // used them all — slot STAYS assigned, just greys out
      // Glyph, faded when the consumable is out of stock so the slot reads as
      // empty without losing the assignment (pick more up → usable again).
      if (empty) ctx.globalAlpha = 0.35;
      drawHotbarGlyph(ctx, id, b.x, b.y, b.w, b.h);
      if (empty) ctx.globalAlpha = 1;
      // Green ring if this slot's gear is currently equipped in its slot.
      if (eq && v.hooks?.getEquipped(eq.slot) === id) {
        ctx.strokeStyle = '#7ee07e';
        ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
      }
      // Stack count for a CONSUMABLE (not gear/PSI): "x12" bottom-right. Shown
      // when you hold more than one OR when the slot is EMPTY ("x0", reddish), so
      // a depleted-but-still-assigned slot is obvious. Reads getGoods live, so it
      // ticks down as you use them and reappears the moment you restock.
      if (isConsumable && count !== 1) {
        const label = `x${count}`;
        ctx.save();
        ctx.font = '5px monospace';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        const rx = b.x + b.w - 1;
        const ry = b.y + b.h;
        ctx.fillStyle = '#000'; // 1px shadow so it reads over the icon
        ctx.fillText(label, rx + 0.5, ry);
        ctx.fillStyle = empty ? '#f88' : '#fff'; // reddish at x0 to flag empty
        ctx.fillText(label, rx, ry - 0.5);
        ctx.restore();
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
