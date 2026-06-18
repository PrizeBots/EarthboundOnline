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
import { EQUIP_SLOTS } from '../Equipment';
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

// --- Scrollable list windows -------------------------------------------------
// A vertical list (Goods / PSI / Shop / Equip-select) must NEVER run off the
// bottom of the 224px screen. `scrollList` clamps the window to the screen and,
// when the content is taller, shows only the rows that fit + scrolls so the
// cursor stays visible, reserving a gutter for a scrollbar. Each list's layout +
// hit-test + renderer all go through it so they never drift.
const SCROLLBAR_W = 3;
const SCREEN_MARGIN = 8; // keep this much clear at the screen bottom

/** A visible row, tagged with its ITEM index (so click/render map back). */
export interface ListRow extends Cell {
  index: number;
}
export interface ListLayout {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  /** ONLY the rows currently visible in the (possibly scrolled) window. */
  rows: ListRow[];
  /** Scrollbar geometry when the list overflows, else null. */
  scroll: { x: number; y: number; w: number; h: number; thumbY: number; thumbH: number } | null;
  /** Total item count, how many fit at once, and the first visible index — used
   *  to map a scrollbar drag back to a cursor row. */
  count: number;
  visible: number;
  first: number;
}

/**
 * Build a clamped, scroll-if-needed list window. `(winX, winY, winW)` is the
 * desired box (winW fixed by the caller), `count` the item total, `cursor` the
 * selected index (kept visible). Height is clamped to the screen; when the
 * content overflows, only the rows that fit are returned (each carrying its real
 * item index) and a scrollbar gutter is reserved on the right.
 */
export function scrollList(
  winX: number,
  winY: number,
  winW: number,
  count: number,
  cursor: number
): ListLayout {
  const n = Math.max(1, count);
  const fullWinH = n * ITEM_H + PADDING * 2 + BORDER * 2;
  const maxWinH = SCREEN_HEIGHT - winY - SCREEN_MARGIN;
  const fits = fullWinH <= maxWinH;
  const winH = fits ? fullWinH : maxWinH;
  const usableH = winH - BORDER * 2 - PADDING * 2;
  const visible = fits ? n : Math.max(1, Math.floor(usableH / ITEM_H));
  // Scroll offset: keep the cursor centred-ish, clamped to the ends. Deterministic
  // from the cursor, so render + hit-test compute the same window.
  const first = fits
    ? 0
    : Math.max(0, Math.min(n - visible, (cursor || 0) - Math.floor(visible / 2)));
  const sbGutter = fits ? 0 : SCROLLBAR_W + 2;
  const rowW = winW - PADDING * 2 - BORDER * 2 - sbGutter;
  const rows: ListRow[] = [];
  for (let i = 0; i < visible && first + i < count; i++) {
    rows.push({
      x: winX + BORDER + PADDING,
      y: winY + BORDER + PADDING + i * ITEM_H,
      w: rowW,
      h: ITEM_H,
      index: first + i,
    });
  }
  let scroll = null;
  if (!fits) {
    const trackY = winY + BORDER;
    const trackH = winH - BORDER * 2;
    const thumbH = Math.max(8, (visible / n) * trackH);
    const thumbY = trackY + (trackH - thumbH) * (first / Math.max(1, n - visible));
    scroll = {
      x: winX + winW - BORDER - SCROLLBAR_W,
      y: trackY,
      w: SCROLLBAR_W,
      h: trackH,
      thumbY,
      thumbH,
    };
  }
  return { winX, winY, winW, winH, rows, scroll, count: n, visible, first };
}

/** Row index under a point for a scroll-list layout, or -1. */
export function listRowAt(layout: ListLayout, px: number, py: number): number {
  for (const r of layout.rows) {
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return r.index;
  }
  return -1;
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
  { label: 'PK', action: 'pk' },
];
export const COLS = 2;
// 5 items in a 2-wide grid → 3 rows (the last has one cell; nav guards the empty
// slot, see MenuManager). Window height uses ROWS so it sizes to all items.
export const ROWS = 3;

// PSI abilities castable from the PSI command. DEV: every family is available to
// every player (no learn/level gate yet — that's wired to level + Mental later);
// the server validates PP + resolves the effect. `pp` MIRRORS the server PSI
// table (gameHost.js PSI). `anim` is the PsiAnim catalog id whose authored frames
// play on cast AND show as the hotbar icon (the game id differs, e.g. fire →
// psi_fire_alpha, so we carry the mapping explicitly).
// `target`: who the cast applies to — 'ally' (self OR a chosen friend; the game
// enters target mode), 'enemy' (auto/aim a foe), 'self' (the caster only). PP +
// effects MIRROR the server (gameHost.js PSI); both are canon (psi.json).
export const PSI_ABILITIES = [
  { id: 'lifeup', name: 'Lifeup α', pp: 5, anim: 'lifeup_alpha', target: 'ally' }, // heal
  { id: 'healing', name: 'Healing α', pp: 5, anim: 'healing_alpha', target: 'ally' }, // cure statuses
  { id: 'healing_gamma', name: 'Healing γ', pp: 20, anim: 'healing_alpha', target: 'ally' }, // cure + revive (half HP)
  { id: 'healing_omega', name: 'Healing Ω', pp: 38, anim: 'healing_alpha', target: 'ally' }, // cure + revive (full HP)
  { id: 'fire', name: 'PSI Fire α', pp: 5, anim: 'psi_fire_alpha', target: 'enemy' }, // offense (projectile)
  { id: 'freeze', name: 'PSI Freeze α', pp: 4, anim: 'psi_freeze_alpha', target: 'enemy' }, // offense
  { id: 'thunder', name: 'PSI Thunder α', pp: 3, anim: 'psi_thunder_alpha', target: 'enemy' }, // offense
  { id: 'flash', name: 'PSI Flash α', pp: 8, anim: 'psi_flash_alpha', target: 'enemy' }, // offense + paralyze
  {
    id: 'starstorm',
    name: 'PSI Starstorm α',
    pp: 24,
    anim: 'psi_starstorm_alpha',
    target: 'enemy',
  }, // big offense
  { id: 'rockin', name: 'PSI Rockin α', pp: 6, anim: 'psi_alpha', target: 'enemy' }, // offense (the ???? move)
  { id: 'hypnosis', name: 'Hypnosis α', pp: 4, anim: 'hypnosis_alpha', target: 'enemy' }, // sleep a foe
  { id: 'paralysis', name: 'Paralysis α', pp: 5, anim: 'paralysis_alpha', target: 'enemy' }, // paralyze a foe
  { id: 'brainshock', name: 'Brainshock α', pp: 6, anim: 'brainshock_alpha', target: 'enemy' }, // strange + noPsi
  { id: 'shield', name: 'Shield α', pp: 6, anim: 'shield_alpha', target: 'self' }, // (effect TODO — anim only)
  { id: 'psishield', name: 'PSI Shield α', pp: 8, anim: 'psi_shield_alpha', target: 'self' }, // (anim only)
  { id: 'offenseup', name: 'Offense up α', pp: 10, anim: 'offense_up_alpha', target: 'self' }, // (anim only)
  { id: 'defensedown', name: 'Defense down α', pp: 6, anim: 'defense_down_alpha', target: 'enemy' }, // (anim only)
  { id: 'magnet', name: 'PSI Magnet α', pp: 1, anim: 'psi_magnet_alpha', target: 'enemy' }, // (anim only)
  { id: 'teleport', name: 'Teleport α', pp: 2, anim: 'teleport_alpha', target: 'self' }, // (anim only)
];

/** Who a PSI ability targets: 'ally' (self/friend), 'enemy', or 'self'. */
export function psiTarget(abilityId: string): string {
  return PSI_ABILITIES.find((a) => a.id === abilityId)?.target ?? 'enemy';
}

/** PP cost of a PSI ability (0 if unknown). The server is authoritative; the
 *  client uses this only to gate the cast (don't fire FX/SFX with too little PP). */
export function psiCost(abilityId: string): number {
  return PSI_ABILITIES.find((a) => a.id === abilityId)?.pp ?? 0;
}

/** The PsiAnim catalog id for a PSI ability (for the cast/hotbar icon), or the
 *  id itself as a fallback. */
export function psiAnimId(abilityId: string): string {
  return PSI_ABILITIES.find((a) => a.id === abilityId)?.anim ?? abilityId;
}

// Hotbar entries are normally item ids; a PSI ability is stored tagged as
// `psi:<abilityId>` so activateSlot/renderHotbar can tell them apart from items.
export const PSI_TAG = 'psi:';
export function isPsiEntry(id: string): boolean {
  return id.startsWith(PSI_TAG);
}
/** Display name for a PSI ability id (falls back to the raw id). */
export function psiName(abilityId: string): string {
  return PSI_ABILITIES.find((a) => a.id === abilityId)?.name ?? abilityId;
}

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

// The Goods panel: a big TWO-COLUMN window pinned to the top-left and spanning
// the full width, so it OVERLAPS (draws on top of) the command grid and the
// money "$N" window behind it (renderMenuBody draws those first). The 14-slot
// bag fits in 2 columns without scrolling, so every item shows at once. Items
// fill row-major: 0,1 on row 0; 2,3 on row 1; … (cursor nav is 2D in MenuManager).
const GOODS_MARGIN = 8;
export const GOODS_COLS = 2;
export function goodsLayout(): ListLayout {
  const n = Math.max(1, getGoods().length);
  const winX = GOODS_MARGIN;
  const winY = GOODS_MARGIN; // top edge = over the command + money windows
  const winW = SCREEN_WIDTH - GOODS_MARGIN * 2; // full width → covers both corners
  const rowsNeeded = Math.ceil(n / GOODS_COLS);
  const maxRows = Math.max(
    1,
    Math.floor((SCREEN_HEIGHT - winY - GOODS_MARGIN - (BORDER + PADDING) * 2) / ITEM_H)
  );
  const visibleRows = Math.min(rowsNeeded, maxRows);
  const winH = visibleRows * ITEM_H + (BORDER + PADDING) * 2;
  const innerW = winW - (BORDER + PADDING) * 2;
  const colW = Math.floor((innerW - COL_GAP) / GOODS_COLS);
  const rows: ListRow[] = [];
  for (let i = 0; i < n && Math.floor(i / GOODS_COLS) < visibleRows; i++) {
    const col = i % GOODS_COLS;
    const row = Math.floor(i / GOODS_COLS);
    rows.push({
      x: winX + BORDER + PADDING + col * (colW + COL_GAP),
      y: winY + BORDER + PADDING + row * ITEM_H,
      w: colW,
      h: ITEM_H,
      index: i,
    });
  }
  return { winX, winY, winW, winH, rows, scroll: null, count: n, visible: rows.length, first: 0 };
}

/** Item index of the Goods cell under a point, or -1. */
export function goodsRowAt(px: number, py: number): number {
  return listRowAt(goodsLayout(), px, py);
}

// Equip screen geometry: the slot list sits in the center third of the screen;
// picking a slot opens an item sub-modal in the right third.
const EQUIP_THIRD = Math.floor(SCREEN_WIDTH / 3);
const EQUIP_TOP = 8;

/** The slot list window (Weapon / Body / Arms / Other), centered third. */
export function equipListLayout(): {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  rows: Cell[];
} {
  const n = EQUIP_SLOTS.length;
  const winW = EQUIP_THIRD;
  const winX = (SCREEN_WIDTH - winW) >> 1; // centered → occupies the middle third
  const winY = EQUIP_TOP;
  const winH = n * ITEM_H + PADDING * 2 + BORDER * 2;
  const rowW = winW - (BORDER + PADDING) * 2;
  const rows: Cell[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      x: winX + BORDER + PADDING,
      y: winY + BORDER + PADDING + i * ITEM_H,
      w: rowW,
      h: ITEM_H,
    });
  }
  return { winX, winY, winW, winH, rows };
}

export function equipRowAt(px: number, py: number): number {
  const { rows } = equipListLayout();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return i;
  }
  return -1;
}

/** The item sub-modal (right third) listing gear for the chosen slot — scrolls
 *  if the player owns more gear than fits. */
export function equipSelectLayout(itemCount: number, cursor = 0): ListLayout {
  const list = equipListLayout();
  const winX = list.winX + list.winW + 4; // just right of the slot list
  const winW = SCREEN_WIDTH - winX - 6; // out to the right margin
  return scrollList(winX, EQUIP_TOP, winW, itemCount, cursor);
}

export function equipSelectRowAt(px: number, py: number, itemCount: number, cursor = 0): number {
  return listRowAt(equipSelectLayout(itemCount, cursor), px, py);
}

// The PSI ability list — sits to the RIGHT of the command grid at the top edge,
// and scrolls (every PSI is dev-available, so the list is long).
export function psiLayout(cursor = 0): ListLayout {
  const PSI_MIN_W = 96;
  const maxLabelW = Math.max(...PSI_ABILITIES.map((a) => measureText(a.name, FONT_ID)));
  const innerW = Math.max(PSI_MIN_W, CURSOR_W + maxLabelW);
  const cmd = commandLayout();
  const winX = cmd.winX + cmd.winW + 4;
  const winY = cmd.winY;
  // +scrollbar gutter so labels keep their room when the list scrolls.
  const winW = innerW + PADDING * 2 + BORDER * 2 + SCROLLBAR_W + 2;
  return scrollList(winX, winY, winW, PSI_ABILITIES.length, cursor);
}

/** Item index of the PSI row under a point (scroll-aware), or -1. */
export function psiRowAt(px: number, py: number, cursor = 0): number {
  return listRowAt(psiLayout(cursor), px, py);
}

// Shop rows render "Name......$Cost"; the list is wide enough for the longest
// such line. Rows come from the store (Buy) or the player's Goods (Sell, half
// price). `store` is the open clerk's store id (MenuManager's shopStore).
export interface ShopRow extends Cell {
  id: string;
  label: string;
}
const SHOP_MIN_W = 120;
/** The Buy/Sell list rows (id + display label) for the items in `mode`. The
 *  renderer reads this by row index; the layout window comes from shopListLayout. */
export function shopListItems(
  mode: 'buy' | 'sell',
  store: number
): { id: string; label: string }[] {
  const src =
    mode === 'buy'
      ? getStoreItems(store).map((i) => ({ id: i.id, name: i.name, price: i.cost }))
      : getGoods().map((g) => ({ id: g.id, name: g.name, price: sellPrice(g.id) }));
  return src.map((r) => ({ id: r.id, label: `${r.name}  $${r.price}` }));
}

export function shopListLayout(mode: 'buy' | 'sell', store: number, cursor = 0): ListLayout {
  const items = shopListItems(mode, store);
  const maxLabelW = items.length ? Math.max(...items.map((r) => measureText(r.label, FONT_ID))) : 0;
  const innerW = Math.max(SHOP_MIN_W, CURSOR_W + maxLabelW);
  // Sit to the RIGHT of the Buy/Sell chooser; scroll if the store is large.
  const chooserLabelW = Math.max(...SHOP_ROOT.map((l) => measureText(l, FONT_ID)));
  const chooserW = CURSOR_W + chooserLabelW + PADDING * 2 + BORDER * 2;
  const winX = 8 + chooserW + 4;
  const winW = innerW + PADDING * 2 + BORDER * 2 + SCROLLBAR_W + 2;
  return scrollList(winX, 8, winW, items.length, cursor);
}

export function shopRowAt(
  mode: 'buy' | 'sell',
  store: number,
  px: number,
  py: number,
  cursor = 0
): number {
  return listRowAt(shopListLayout(mode, store, cursor), px, py);
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

// --- Quick-select hotbar geometry (bottom-center) ----------------------------
// 6 slots, keys 1-6. Reachable while the left hand is on WASD; 6*16 + 5*3 = 111px
// wide, centered on the 256px screen. KEEP IN SYNC with server HOTBAR_SLOTS
// (gameHost.js) so the saved/validated hotbar array is the same length.
export const HOTBAR_SLOTS = 6;
const HOTBAR_BOX = 16;
const HOTBAR_GAP = 3;

/** The hotbar boxes, centered along the bottom edge of the screen. */
export function hotbarLayout(): Cell[] {
  const totalW = HOTBAR_SLOTS * HOTBAR_BOX + (HOTBAR_SLOTS - 1) * HOTBAR_GAP;
  const x0 = Math.floor((SCREEN_WIDTH - totalW) / 2);
  const y = SCREEN_HEIGHT - HOTBAR_BOX; // flush to the bottom edge
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
