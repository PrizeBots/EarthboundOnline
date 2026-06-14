/**
 * MenuManager — EarthBound's overworld command window.
 *
 * Q (or X / Escape) opens the command window in the top-left: a 2x2 grid of
 * Goods / PSI / Equip / Status, navigated with the arrow keys (or WASD) and a
 * ">" cursor, just like pressing A in EarthBound. (Talk to / Check are gone —
 * the E button handles contextual talk/check in the field.)
 * Confirming a command that has no game system behind it yet opens a small
 * dialogue window at the bottom of the screen; any action key dismisses it.
 *
 * On real SNES this is a BG3 text window — same window/font assets, so it
 * ports directly.
 */

import { drawWindow }                              from './WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from './TextRenderer';
import { renderStatus, getStatus }                 from './StatusModal';
import { getPointer, consumePointerClick, isPointerDown,
         consumePointerPress, consumePointerRelease } from './Input';
import { getGoods }                                from './Inventory';
import { getMoney }                                from './Wallet';
import { sendUseItem, sendUsePsi, sendBuy, sendSell, sendEquip } from './Network';
import { getStoreItems, sellPrice, itemEquip, itemOffense, itemDefense } from './Shop';
import { drawItemIcon, getItemName }               from './Items';
import { EquipSlot, EQUIP_SLOTS, SLOT_LABELS }     from './Equipment';
import { SCREEN_WIDTH, SCREEN_HEIGHT }             from '../types';

// Hooks into the local player's equipment, wired by Game (MenuManager has no
// player ref). getEquipped reads a slot; equip sets it (held sprite for a
// weapon + server 'equip', which applies the offense/defense). The Equip screen
// and hotbar toggle-equip both flow through these.
export interface MenuHooks {
  getEquipped(slot: EquipSlot): string | null;
  equip(slot: EquipSlot, itemId: string | null): void;
}
let hooks: MenuHooks | null = null;

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

// Command window: 2 rows x 2 columns, read left to right. Talk to / Check were
// removed — the E button handles contextual talk/check in the field, so they'd
// just be dead menu slots here.
const MENU_ITEMS = [
  { label: 'Goods',   action: 'goods'  },
  { label: 'PSI',     action: 'psi'    },
  { label: 'Equip',   action: 'equip'  },
  { label: 'Status',  action: 'status' },
];
const COLS = 2;
const ROWS = 2;

// PSI abilities castable from the PSI command. Static for now; the server
// validates the PP cost and resolves the effect (so a client can't self-heal).
const PSI_ABILITIES = [
  { id: 'lifeup', name: 'Lifeup α' }, // Lifeup α — restores HP
];

// Placeholder responses until the real systems (inventory, PSI, stats,
// NPC dialogue) exist. Each shows in an EB-style bottom dialogue window.
const STUB_MESSAGES: Record<string, string> = {
  goods:  "You aren't carrying anything yet.",
  psi:    "You can't use PSI yet.",
  equip:  "You have nothing to equip.",
};

type MenuState =
  | 'closed' | 'command' | 'message' | 'status' | 'goods' | 'psi'
  | 'shop' | 'shop_buy' | 'shop_sell' | 'phone' | 'save' | 'equip';

// --- Quick-select hotbar (2 slots, keys 1-2) ---------------------------------
// In-memory item ids assigned to each slot (a weapon to brandish, or a
// consumable to use). Visible only while the menu is open. More slots unlock
// later. Drag a gear icon from the Equip modal (or a Goods row) onto a box.
const HOTBAR_SLOTS = 2;
const hotbar: (string | null)[] = new Array(HOTBAR_SLOTS).fill(null);
// A drag in progress: the item id being dragged onto a hotbar box.
let drag: { id: string } | null = null;

// Equip screen: one combined list — the 4 slots (each showing the equipped
// item; selecting an occupied slot takes it off) followed by the player's
// UNEQUIPPED gear (selecting equips it into its slot). A live status panel
// (Offense/Defense) sits to the right so stat changes are visible.
let equipCursor = 0;

// EarthBound's telephone menu — pick who to call. Dad saves your game; Mom
// eases homesickness. (Escargo Express / other EB contacts can join once item
// storage exists.) WIRING ONLY: Dad's save is a stub, Mom is flavor for now.
const PHONE_CONTACTS: { name: string; action: 'save' | 'mom' }[] = [
  { name: 'Dad', action: 'save' },
  { name: 'Mom', action: 'mom'  },
];
const MOM_MESSAGE = "It's Mom. Are you eating right and getting enough sleep? ...There, don't you feel a little less homesick now?";

// Dad's save prompt, reached from the phone menu. Real persistence (the
// progression block, keyed by an anonymous localStorage token) is still TODO
// (see TODO.md "Save system") — confirming just acknowledges for now.
const SAVE_PROMPT  = "It's Dad. You sound like you're doing great, kiddo! Want me to save your progress?";
const SAVE_DONE    = "OK, I saved your progress. Don't push yourself too hard, now!";
const SAVE_CHOICES = ['Yes', 'No'];

/** STUB — wiring only. The phone-save call site; persistence not built yet. */
function saveGame(): void {
  console.log('[save] phone save requested — persistence not implemented yet (stub)');
}

/** Open the telephone contact menu (called from Game.tryTalk for a phone). */
export function openPhoneMenu(): void {
  phoneCursor = 0;
  menuState = 'phone';
}

// Shop: opened by talking to a clerk (openShop), NOT from the command grid.
// 'shop' is the Buy/Sell chooser; the two lists hang under it. The server owns
// money + inventory, so confirming just sends a request and the resulting
// inventory/money deltas flow back through Network and re-render the lists.
const SHOP_ROOT = ['Buy', 'Sell'];

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

// --- Equip screen (EB 4-slot) + hotbar geometry/logic ------------------------

// One combined list: the 4 slots, then the player's UNEQUIPPED gear.
type EquipRow = { kind: 'slot'; slot: EquipSlot } | { kind: 'item'; id: string; name: string };

/** Equippable inventory gear that is NOT currently worn in its slot. */
function unequippedGear(): { id: string; name: string }[] {
  return getGoods().filter((g) => {
    const eq = itemEquip(g.id);
    return eq && (hooks?.getEquipped(eq.slot) ?? null) !== g.id;
  });
}

function equipRows(): EquipRow[] {
  const rows: EquipRow[] = EQUIP_SLOTS.map((slot) => ({ kind: 'slot', slot }));
  for (const it of unequippedGear()) rows.push({ kind: 'item', id: it.id, name: it.name });
  return rows;
}

const EQUIP_ROW_W = 132; // inner width (slot label + item name)

/** The combined Equip list window (slots + unequipped gear). */
function equipListLayout(): { winX: number; winY: number; winW: number; winH: number; rows: Cell[] } {
  const cmd = commandLayout();
  const winX = cmd.winX;
  const winY = cmd.winY + cmd.winH + 2;
  const n = Math.max(1, equipRows().length);
  const innerH = n * ITEM_H + PADDING * 2;
  const rows: Cell[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ x: winX + BORDER + PADDING, y: winY + BORDER + PADDING + i * ITEM_H, w: EQUIP_ROW_W, h: ITEM_H });
  }
  return { winX, winY, winW: EQUIP_ROW_W + PADDING * 2 + BORDER * 2, winH: innerH + BORDER * 2, rows };
}

function equipRowAt(px: number, py: number): number {
  const { rows } = equipListLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

/** Current Offense/Defense INCLUDING equipped gear (for the live status panel). */
function equipStats(): { offense: number; defense: number } {
  const base = getStatus();
  let offense = base.offense + itemOffense(hooks?.getEquipped('weapon') ?? '');
  let defense = base.defense;
  for (const s of ['body', 'arms', 'other'] as EquipSlot[]) {
    defense += itemDefense(hooks?.getEquipped(s) ?? '');
  }
  return { offense, defense };
}

/** Act on an equip-list row: take off an occupied slot, or equip a gear item. */
function activateEquipRow(i: number): void {
  const r = equipRows()[i];
  if (!r) return;
  if (r.kind === 'slot') {
    if (hooks?.getEquipped(r.slot)) hooks?.equip(r.slot, null); // take off
  } else {
    const eq = itemEquip(r.id);
    if (eq) hooks?.equip(eq.slot, r.id); // equip (server swaps out any occupant)
  }
}

/** Auto-equip a Good if it's gear (else use it). Shows the resulting stat. */
function useOrEquipGood(id: string): void {
  const eq = itemEquip(id);
  if (!eq) { sendUseItem(id); return; }
  hooks?.equip(eq.slot, id);
  const after = equipStats(); // hooks.equip updated the mirror synchronously
  const line = eq.slot === 'weapon' ? `Offense is now ${after.offense}.` : `Defense is now ${after.defense}.`;
  message = `Equipped ${getItemName(id) ?? 'it'}.\n${line}`;
  menuState = 'message';
}

const HOTBAR_BOX = 24;
const HOTBAR_GAP = 6;

/** The hotbar boxes, centered at the bottom of the screen. */
function hotbarLayout(): Cell[] {
  const totalW = HOTBAR_SLOTS * HOTBAR_BOX + (HOTBAR_SLOTS - 1) * HOTBAR_GAP;
  const x0 = Math.floor((SCREEN_WIDTH - totalW) / 2);
  const y = SCREEN_HEIGHT - HOTBAR_BOX - 6;
  const boxes: Cell[] = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    boxes.push({ x: x0 + i * (HOTBAR_BOX + HOTBAR_GAP), y, w: HOTBAR_BOX, h: HOTBAR_BOX });
  }
  return boxes;
}

function hotbarBoxAt(px: number, py: number): number {
  const boxes = hotbarLayout();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) return i;
  }
  return -1;
}

/** Toggle-equip any gear (weapon or armor) into its own slot. */
function equipToggle(id: string): void {
  const eq = itemEquip(id);
  if (!eq) return;
  const cur = hooks?.getEquipped(eq.slot) ?? null;
  hooks?.equip(eq.slot, cur === id ? null : id);
}

/** Trigger a hotbar slot: toggle-equip gear, or use a consumable. */
function activateSlot(i: number): void {
  const id = hotbar[i];
  if (!id) return;
  if (itemEquip(id)) equipToggle(id);
  else sendUseItem(id);
}

// Pointer drag/drop. Goods: drag a row to a hotbar box to assign it, or release
// on the same row to use/equip it. Equip: drag a gear ITEM row (ghost only —
// the equip itself fires from the click latch, since each item has exactly one
// valid slot). Press/release use their own Input latches, distinct from clicks.
function updateHotbarDrag(): void {
  const press = consumePointerPress();
  if (press && !drag) {
    if (menuState === 'goods') {
      const items = getGoods();
      const i = goodsRowAt(press.x, press.y);
      if (i >= 0 && items[i]) drag = { id: items[i].id };
    } else if (menuState === 'equip') {
      const r = equipRows()[equipRowAt(press.x, press.y)];
      if (r && r.kind === 'item') drag = { id: r.id };
    }
  }
  const rel = consumePointerRelease();
  if (rel && drag) {
    if (menuState === 'goods') {
      const box = hotbarBoxAt(rel.x, rel.y);
      if (box >= 0) {
        hotbar[box] = drag.id; // dropped on a hotbar slot — assign
      } else {
        const i = goodsRowAt(rel.x, rel.y);
        const items = getGoods();
        if (i >= 0 && items[i] && items[i].id === drag.id) useOrEquipGood(items[i].id); // click
      }
    }
    // Equip: the click latch performs the equip; drag here is purely the ghost.
    drag = null;
  }
  if (drag && !isPointerDown()) drag = null; // safety: never get stuck dragging
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

// Shop rows render "Name......$Cost" right-aligned price; the list is wide
// enough for the longest such line. Rows come from the store (Buy) or the
// player's Goods (Sell, priced at half). Returned rows include the wire id and
// price so input can act without re-deriving them.
interface ShopRow extends Cell { id: string; label: string; }
const SHOP_MIN_W = 120;
function shopListLayout(mode: 'buy' | 'sell'): {
  winX: number; winY: number; winW: number; winH: number; rows: ShopRow[];
} {
  const src =
    mode === 'buy'
      ? getStoreItems(shopStore).map((i) => ({ id: i.id, name: i.name, price: i.cost }))
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

function shopRowAt(mode: 'buy' | 'sell', px: number, py: number): number {
  const { rows } = shopListLayout(mode);
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

/** Index of the Buy/Sell chooser row (top-left window) under a point, or -1. */
function shopRootRowAt(px: number, py: number): number {
  const labelW = Math.max(...SHOP_ROOT.map((l) => measureText(l, FONT_ID)));
  const w = CURSOR_W + labelW;
  for (let i = 0; i < SHOP_ROOT.length; i++) {
    const x = 8 + BORDER + PADDING;
    const y = 8 + BORDER + PADDING + i * ITEM_H;
    if (px >= x && px < x + w && py >= y && py < y + ITEM_H) return i;
  }
  return -1;
}

/** Open a clerk's shop (called from Game.tryTalk for a shop-clerk NPC). */
export function openShop(store: number): void {
  shopStore = store;
  shopRootCursor = 0;
  shopBuyCursor = 0;
  shopSellCursor = 0;
  shopNote = '';
  menuState = 'shop';
}

let menuState: MenuState = 'closed';
let cursorIndex = 0;
let goodsCursor = 0;
let psiCursor = 0;
let message = '';
let shopStore = -1;     // store id of the clerk being talked to
let shopRootCursor = 0; // 0 = Buy, 1 = Sell
let shopBuyCursor = 0;
let shopSellCursor = 0;
let shopNote = '';      // transient line under the shop (e.g. "Not enough money")
let phoneCursor = 0;    // selected contact in the telephone menu
let saveCursor = 0;     // 0 = Yes, 1 = No, on the phone-save prompt

const prevKeys = new Set<string>();
let liveKeys: Set<string>;

export function initMenu(keySet: Set<string>, h?: MenuHooks): void {
  liveKeys = keySet;
  hooks = h ?? null;
}

export function updateMenu(): void {
  if (!liveKeys) return;

  const justPressed = (code: string) =>
    liveKeys.has(code) && !prevKeys.has(code);
  const toggle  = justPressed('KeyQ') || justPressed('KeyX') || justPressed('Escape');
  // Confirm/activate a command: Z, Space, Enter, or E (the contextual button).
  const confirm = justPressed('KeyZ') || justPressed('Space') ||
                  justPressed('Enter') || justPressed('KeyE');
  // A left-click anywhere this frame (game-space coords), consumed once.
  const click = menuState === 'closed' ? null : consumePointerClick();

  // Hotbar (any open state): number keys 1-2 trigger their slot (toggle-equip
  // gear / use a consumable). Drag-drop assignment is in updateHotbarDrag.
  if (menuState !== 'closed') {
    for (let n = 0; n < HOTBAR_SLOTS; n++) {
      if (justPressed(`Digit${n + 1}`)) activateSlot(n);
    }
    updateHotbarDrag();
  }

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

      // Use via keyboard confirm. Mouse use (and drag-to-hotbar) is handled by
      // updateHotbarDrag on pointer release, so a drag doesn't also use the item.
      const use = confirm ? goodsCursor : -1;
      if (use >= 0 && items[use]) {
        // Equippable gear auto-equips (and pops a status line); everything else
        // is used. Server-authoritative either way.
        useOrEquipGood(items[use].id);
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
  } else if (menuState === 'equip') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'command'; // back to the command grid
    } else {
      const n = equipRows().length;
      if (n > 0) {
        if (justPressed('ArrowUp')   || justPressed('KeyW')) equipCursor = (equipCursor + n - 1) % n;
        if (justPressed('ArrowDown') || justPressed('KeyS')) equipCursor = (equipCursor + 1) % n;
        if (equipCursor >= n) equipCursor = n - 1;
        const p = getPointer();
        const hov = equipRowAt(p.x, p.y);
        if (hov >= 0) equipCursor = hov;
        // E/Enter on the cursor, or a click on any row: equip a gear item into
        // its slot / take off an equipped slot.
        if (confirm) activateEquipRow(equipCursor);
        if (click) {
          const ci = equipRowAt(click.x, click.y);
          if (ci >= 0) activateEquipRow(ci);
        }
      }
    }
  } else if (menuState === 'shop') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'closed'; // leave the shop entirely
    } else {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) shopRootCursor = (shopRootCursor + 1) % 2;
      if (justPressed('ArrowDown') || justPressed('KeyS')) shopRootCursor = (shopRootCursor + 1) % 2;
      // Mouse: hover highlights, click chooses Buy/Sell.
      const p = getPointer();
      const hov = shopRootRowAt(p.x, p.y);
      if (hov >= 0) shopRootCursor = hov;
      let choose = confirm ? shopRootCursor : -1;
      if (click) {
        const c = shopRootRowAt(click.x, click.y);
        if (c >= 0) choose = c;
      }
      if (choose >= 0) {
        shopNote = '';
        menuState = choose === 0 ? 'shop_buy' : 'shop_sell';
      }
    }
  } else if (menuState === 'shop_buy') {
    const rows = shopListLayout('buy').rows;
    if (toggle || justPressed('Backspace')) {
      menuState = 'shop';
    } else if (rows.length) {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) shopBuyCursor = (shopBuyCursor + rows.length - 1) % rows.length;
      if (justPressed('ArrowDown') || justPressed('KeyS')) shopBuyCursor = (shopBuyCursor + 1) % rows.length;
      const p = getPointer();
      const hovered = shopRowAt('buy', p.x, p.y);
      if (hovered >= 0) shopBuyCursor = hovered;
      let pick = confirm ? shopBuyCursor : -1;
      if (click) {
        const clicked = shopRowAt('buy', click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && rows[pick]) {
        const item = getStoreItems(shopStore)[pick];
        // Pre-check affordability for instant feedback; the server re-validates.
        if (item && getMoney() < item.cost) shopNote = 'Not enough money.';
        else {
          sendBuy(shopStore, rows[pick].id);
          shopNote = `Bought ${item?.name ?? 'item'}!`; // the money window confirms the spend
        }
      }
    }
  } else if (menuState === 'shop_sell') {
    const rows = shopListLayout('sell').rows;
    if (toggle || justPressed('Backspace')) {
      menuState = 'shop';
    } else if (getGoods().length) {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) shopSellCursor = (shopSellCursor + rows.length - 1) % rows.length;
      if (justPressed('ArrowDown') || justPressed('KeyS')) shopSellCursor = (shopSellCursor + 1) % rows.length;
      const p = getPointer();
      const hovered = shopRowAt('sell', p.x, p.y);
      if (hovered >= 0) shopSellCursor = hovered;
      let pick = confirm ? shopSellCursor : -1;
      if (click) {
        const clicked = shopRowAt('sell', click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && rows[pick]) {
        shopNote = '';
        sendSell(rows[pick].id);
        if (shopSellCursor >= rows.length - 1) shopSellCursor = Math.max(0, rows.length - 2);
      }
    } else {
      menuState = 'shop'; // sold the last item
    }
  } else if (menuState === 'phone') {
    // Telephone contact list — pick who to call.
    if (toggle || justPressed('Backspace')) {
      menuState = 'closed'; // hang up
    } else {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) phoneCursor = (phoneCursor + PHONE_CONTACTS.length - 1) % PHONE_CONTACTS.length;
      if (justPressed('ArrowDown') || justPressed('KeyS')) phoneCursor = (phoneCursor + 1) % PHONE_CONTACTS.length;

      const p = getPointer();
      const hovered = phoneRowAt(p.x, p.y);
      if (hovered >= 0) phoneCursor = hovered;

      let pick = confirm ? phoneCursor : -1;
      if (click) {
        const clicked = phoneRowAt(click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && PHONE_CONTACTS[pick]) {
        if (PHONE_CONTACTS[pick].action === 'save') {
          saveCursor = 0;
          menuState = 'save';          // Dad → save prompt
        } else {
          message = MOM_MESSAGE;        // Mom → homesickness flavor
          menuState = 'message';
        }
      }
    }
  } else if (menuState === 'save') {
    // Dad's Yes/No save prompt. Cancel (Esc/Backspace) returns to the contacts.
    if (toggle || justPressed('Backspace')) {
      menuState = 'phone';
    } else {
      if (justPressed('ArrowUp')   || justPressed('KeyW')) saveCursor = (saveCursor + SAVE_CHOICES.length - 1) % SAVE_CHOICES.length;
      if (justPressed('ArrowDown') || justPressed('KeyS')) saveCursor = (saveCursor + 1) % SAVE_CHOICES.length;

      const p = getPointer();
      const hovered = saveChoiceAt(p.x, p.y);
      if (hovered >= 0) saveCursor = hovered;

      let pick = confirm ? saveCursor : -1;
      if (click) {
        const clicked = saveChoiceAt(click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick === 0) {
        saveGame();            // STUB: wiring only — persistence is TODO
        message = SAVE_DONE;
        menuState = 'message';
      } else if (pick === 1) {
        menuState = 'closed';  // hung up without saving
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
  renderMenuBody(ctx);
  // The hotbar (and any in-flight drag) overlay every open menu state.
  renderHotbar(ctx);
  renderDragGhost(ctx);
}

function renderMenuBody(ctx: CanvasRenderingContext2D): void {
  if (menuState === 'message') {
    renderMessage(ctx);
    return;
  }
  if (menuState === 'equip') {
    renderCommand(ctx); // command grid stays visible behind the modal
    renderEquip(ctx);
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
  if (menuState === 'shop' || menuState === 'shop_buy' || menuState === 'shop_sell') {
    renderShop(ctx);
    return;
  }
  if (menuState === 'phone') {
    renderPhone(ctx);
    return;
  }
  if (menuState === 'save') {
    renderSave(ctx);
    return;
  }

  renderCommand(ctx);
}

// Shop UI: a Buy/Sell chooser top-left, the active list beside it, money
// top-right, and an optional note line at the bottom. Mouse + keyboard share
// the same shopListLayout() geometry as the hit-test.
function renderShop(ctx: CanvasRenderingContext2D): void {
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
    if (menuState === 'shop' && i === shopRootCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, SHOP_ROOT[i], x + CURSOR_W, y, FONT_ID);
  }

  renderMoney(ctx);

  // The active list (Buy: store stock; Sell: player Goods), placed to the right
  // of the chooser. Re-uses shopListLayout for sizing, then shifts it across.
  if (menuState === 'shop_buy' || menuState === 'shop_sell') {
    const mode = menuState === 'shop_buy' ? 'buy' : 'sell';
    // Draw at the layout's own coords so the rows line up with shopRowAt's
    // hit-test (they used to diverge, so clicks landed on empty space).
    const { winX, winY, winW, winH, rows } = shopListLayout(mode);
    drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
    const cursor = mode === 'buy' ? shopBuyCursor : shopSellCursor;
    for (let i = 0; i < rows.length; i++) {
      if (i === cursor) drawCursor(ctx, rows[i].x, rows[i].y + 3);
      drawText(ctx, rows[i].label, rows[i].x + CURSOR_W, rows[i].y, FONT_ID);
    }
    if (rows.length === 0) {
      drawText(ctx, mode === 'buy' ? '(nothing)' : '(empty)',
        winX + BORDER + PADDING + CURSOR_W, winY + BORDER + PADDING, FONT_ID);
    }
  }

  if (shopNote) {
    const w = measureText(shopNote, FONT_ID) + PADDING * 2 + BORDER * 2;
    const h = ITEM_H + PADDING * 2 + BORDER * 2;
    const x = 8;
    const y = SCREEN_HEIGHT - 8 - h;
    drawWindow(ctx, x, y, w, h, MENU_STYLE);
    drawText(ctx, shopNote, x + BORDER + PADDING, y + BORDER + PADDING, FONT_ID);
  }
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

function renderEquip(ctx: CanvasRenderingContext2D): void {
  const rows = equipRows();
  const { winX, winY, winW, winH, rows: cells } = equipListLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < rows.length; i++) {
    const { x, y } = cells[i];
    if (i === equipCursor) drawCursor(ctx, x, y + 3);
    const r = rows[i];
    if (r.kind === 'slot') {
      const id = hooks?.getEquipped(r.slot) ?? null;
      drawText(ctx, SLOT_LABELS[r.slot], x + CURSOR_W, y, FONT_ID);
      drawText(ctx, id ? (getItemName(id) ?? '?') : '-', x + CURSOR_W + 42, y, FONT_ID);
    } else {
      const eq = itemEquip(r.id);
      const tag = eq
        ? (eq.slot === 'weapon' ? `+${eq.offense ?? 0} off` : `+${eq.defense ?? 0} def`)
        : '';
      drawText(ctx, r.name, x + CURSOR_W, y, FONT_ID);
      drawText(ctx, tag, x + CURSOR_W + 84, y, FONT_ID);
    }
  }
  // Faint divider between the slots and the gear list.
  if (rows.length > EQUIP_SLOTS.length) {
    const sepY = cells[EQUIP_SLOTS.length].y - 1;
    ctx.fillStyle = '#4a5a78';
    ctx.fillRect(cells[0].x, sepY, EQUIP_ROW_W, 1);
  }

  // Live status panel (Offense/Defense incl. equipped gear) to the right.
  const st = equipStats();
  const lines: [string, number][] = [['Offense', st.offense], ['Defense', st.defense]];
  const sx = winX + winW + 2;
  const sw = 76;
  const sh = lines.length * ITEM_H + PADDING * 2 + BORDER * 2;
  drawWindow(ctx, sx, winY, sw, sh, MENU_STYLE);
  for (let i = 0; i < lines.length; i++) {
    const yy = winY + BORDER + PADDING + i * ITEM_H;
    drawText(ctx, lines[i][0], sx + BORDER + PADDING, yy, FONT_ID);
    const v = String(lines[i][1]);
    drawText(ctx, v, sx + sw - BORDER - PADDING - measureText(v, FONT_ID), yy, FONT_ID);
  }
}

function renderHotbar(ctx: CanvasRenderingContext2D): void {
  const boxes = hotbarLayout();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    // Small dark box (drawWindow's 6px border would crowd a 24px slot).
    ctx.fillStyle = 'rgba(8,12,40,0.85)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = '#8898c8';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    const id = hotbar[i];
    if (id) {
      drawItemIcon(ctx, id, b.x + (b.w - 16) / 2, b.y + (b.h - 16) / 2, 16);
      // Green ring if this slot's gear is currently equipped in its slot.
      const eq = itemEquip(id);
      if (eq && hooks?.getEquipped(eq.slot) === id) {
        ctx.strokeStyle = '#7ee07e';
        ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
      }
    }
    drawText(ctx, String(i + 1), b.x + 2, b.y + 1, FONT_ID); // number-key label
  }
}

function renderDragGhost(ctx: CanvasRenderingContext2D): void {
  if (!drag) return;
  const p = getPointer();
  ctx.globalAlpha = 0.8;
  drawItemIcon(ctx, drag.id, p.x - 8, p.y - 8, 16);
  ctx.globalAlpha = 1;
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

// Telephone contact list — a vertical window top-left, same layout family as
// the Goods/PSI lists, with a "Call who?" prompt window beneath the command
// area. Shares geometry with phoneRowAt for the mouse hit-test.
const PHONE_MIN_W = 80;
function phoneLayout(): { winX: number; winY: number; winW: number; winH: number; rows: Cell[] } {
  const maxLabelW = Math.max(...PHONE_CONTACTS.map((c) => measureText(c.name, FONT_ID)));
  const innerW = Math.max(PHONE_MIN_W, CURSOR_W + maxLabelW);
  const innerH = PHONE_CONTACTS.length * ITEM_H + PADDING * 2;
  const winX = 8;
  const winY = 8;
  const rows: Cell[] = PHONE_CONTACTS.map((_, i) => ({
    x: winX + BORDER + PADDING,
    y: winY + BORDER + PADDING + i * ITEM_H,
    w: innerW,
    h: ITEM_H,
  }));
  return { winX, winY, winW: innerW + PADDING * 2 + BORDER * 2, winH: innerH + BORDER * 2, rows };
}

/** Index of the phone contact under a game-space point, or -1. */
function phoneRowAt(px: number, py: number): number {
  const { rows } = phoneLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

function renderPhone(ctx: CanvasRenderingContext2D): void {
  const { winX, winY, winW, winH, rows } = phoneLayout();
  drawWindow(ctx, winX, winY, winW, winH, MENU_STYLE);
  for (let i = 0; i < PHONE_CONTACTS.length; i++) {
    const { x, y } = rows[i];
    if (i === phoneCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, PHONE_CONTACTS[i].name, x + CURSOR_W, y, FONT_ID);
  }
}

// Phone-save UI: Dad's question in a full-width window at the bottom (same as a
// dialogue message) with a small Yes/No chooser tucked just above its right end.
function saveLayout(): {
  lines: string[];
  promptX: number; promptY: number; promptW: number; promptH: number;
  chX: number; chY: number; chW: number; chH: number; chInnerW: number;
} {
  const innerW = SCREEN_WIDTH - 16 - BORDER * 2 - PADDING * 2;
  const lines = wrapText(SAVE_PROMPT, innerW);
  const promptW = SCREEN_WIDTH - 16;
  const promptH = lines.length * FONT_LINE_HEIGHT + PADDING * 2 + BORDER * 2;
  const promptX = 8;
  const promptY = SCREEN_HEIGHT - 8 - promptH;

  const labelW = Math.max(...SAVE_CHOICES.map((l) => measureText(l, FONT_ID)));
  const chInnerW = CURSOR_W + labelW;
  const chW = chInnerW + PADDING * 2 + BORDER * 2;
  const chH = SAVE_CHOICES.length * ITEM_H + PADDING * 2 + BORDER * 2;
  const chX = promptX + promptW - chW; // right-aligned over the prompt
  const chY = promptY - chH - 2;       // sits just above the prompt

  return { lines, promptX, promptY, promptW, promptH, chX, chY, chW, chH, chInnerW };
}

/** Index of the Yes/No choice under a game-space point, or -1. */
function saveChoiceAt(px: number, py: number): number {
  const { chX, chY, chInnerW } = saveLayout();
  for (let i = 0; i < SAVE_CHOICES.length; i++) {
    const x = chX + BORDER + PADDING;
    const y = chY + BORDER + PADDING + i * ITEM_H;
    if (px >= x && px < x + chInnerW && py >= y && py < y + ITEM_H) return i;
  }
  return -1;
}

function renderSave(ctx: CanvasRenderingContext2D): void {
  const { lines, promptX, promptY, promptW, promptH, chX, chY, chW, chH } = saveLayout();
  drawWindow(ctx, promptX, promptY, promptW, promptH, MENU_STYLE);
  for (let i = 0; i < lines.length; i++) {
    drawText(ctx, lines[i], promptX + BORDER + PADDING, promptY + BORDER + PADDING + i * FONT_LINE_HEIGHT, FONT_ID);
  }
  drawWindow(ctx, chX, chY, chW, chH, MENU_STYLE);
  for (let i = 0; i < SAVE_CHOICES.length; i++) {
    const x = chX + BORDER + PADDING;
    const y = chY + BORDER + PADDING + i * ITEM_H;
    if (i === saveCursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, SAVE_CHOICES[i], x + CURSOR_W, y, FONT_ID);
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
  if (action === 'equip') {
    equipCursor = 0;
    menuState = 'equip';
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
