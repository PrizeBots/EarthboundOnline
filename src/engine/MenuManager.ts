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

import { drawWindow } from './WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from './TextRenderer';
import { renderStatus, getStatus } from './StatusModal';
import {
  getPointer,
  consumePointerClick,
  isPointerDown,
  consumePointerPress,
  consumePointerRelease,
} from './Input';
import { getGoods, goodsCount } from './Inventory';
import { getMoney, getBank } from './Wallet';
import {
  sendUseItem,
  sendUsePsi,
  sendBuy,
  sendSell,
  sendHotbar,
  sendAtmWithdraw,
  sendAtmDeposit,
  sendDadCall,
} from './Network';
import { playEventSfx } from './SfxEvents';
import { getStoreItems, itemEquip, itemOffense, itemDefense } from './Shop';
import { isFoodItem } from './ItemFolders';
import { getItemName } from './Items';
import { EquipSlot, EQUIP_SLOTS } from './Equipment';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';
import {
  Cell,
  MENU_STYLE,
  BORDER,
  PADDING,
  ITEM_H,
  FONT_ID,
  CURSOR_W,
  COLS,
  ROWS,
  HOTBAR_SLOTS,
  MENU_ITEMS,
  PSI_ABILITIES,
  psiCost,
  PSI_TAG,
  isPsiEntry,
  drawCursor,
  cellAt,
  goodsRowAt,
  equipRowAt,
  equipSelectRowAt,
  psiRowAt,
  shopListLayout,
  shopRowAt,
  shopRootRowAt,
  hotbarBoxAt,
  wrapText,
} from './menu/layout';
import { MenuName, MenuHooks, EquipRow, MenuView } from './menu/types';
import {
  renderShop,
  renderCommand,
  renderGoods,
  renderEquip,
  renderEquipSelect,
  renderPsi,
  renderMessage,
  renderHotbar,
  renderDragGhost,
} from './menu/render';
export type { MenuHooks }; // public API: Game wires the equipment hooks

// Hooks into the local player's equipment, wired by Game (MenuManager has no
// player ref). getEquipped reads a slot; equip sets it (held sprite for a
// weapon + server 'equip', which applies the offense/defense). The Equip screen
// and hotbar toggle-equip both flow through these.
let hooks: MenuHooks | null = null;

// Placeholder responses until the real systems (inventory, PSI, stats,
// NPC dialogue) exist. Each shows in an EB-style bottom dialogue window.
const STUB_MESSAGES: Record<string, string> = {
  goods: "You aren't carrying anything yet.",
  psi: "You can't use PSI yet.",
  equip: 'You have nothing to equip.',
};

// --- Quick-select hotbar (2 slots, keys 1-2) ---------------------------------
// In-memory item ids assigned to each slot (a weapon to brandish, or a
// consumable to use). Visible only while the menu is open. More slots unlock
// later. Drag a gear icon from the Equip modal (or a Goods row) onto a box.
const hotbar: (string | null)[] = new Array(HOTBAR_SLOTS).fill(null);
// A drag in progress: the item id being dragged onto a hotbar box.
let drag: { id: string } | null = null;

/** Push the current hotbar layout to the server so it persists with the
 *  character (the server re-validates + saves it). Call after any user edit. */
function persistHotbar(): void {
  sendHotbar([...hotbar]);
}

/** Restore the saved hotbar from the server (welcome). Fixed length; unknown
 *  ids are kept as-is (the server already validated them on save). */
export function setHotbar(slots: (string | null)[]): void {
  for (let i = 0; i < HOTBAR_SLOTS; i++) hotbar[i] = slots[i] ?? null;
}

/** Clear any hotbar slot whose CONSUMABLE has run out (count 0) so the slot
 *  goes empty when you use the last one. Gear (re-derived from the equip set)
 *  and PSI (not an inventory item) are never auto-cleared. Persists if changed.
 *  Call after every inventory update. */
export function reconcileHotbarStock(): void {
  let changed = false;
  for (let i = 0; i < hotbar.length; i++) {
    const id = hotbar[i];
    if (!id || isPsiEntry(id) || itemEquip(id)) continue; // only plain consumables
    if (goodsCount(id) === 0) {
      hotbar[i] = null;
      changed = true;
    }
  }
  if (changed) persistHotbar();
}

// Equip screen: the slot list (Weapon / Body / Arms / Other) in the center
// third; equipCursor indexes it. Picking a slot opens the sub-modal (right
// third) for equipSlotSel, where equipSelectCursor indexes the gear list.
let equipCursor = 0;
let equipSlotSel: EquipSlot = 'weapon';
let equipSelectCursor = 0;

// EarthBound's telephone menu — pick who to call. Dad saves your game; Mom
// eases homesickness. (Escargo Express / other EB contacts can join once item
// storage exists.) WIRING ONLY: Dad's save is a stub, Mom is flavor for now.
const PHONE_CONTACTS: { name: string; action: 'save' | 'mom' }[] = [
  { name: 'Dad', action: 'save' },
  { name: 'Mom', action: 'mom' },
];
const MOM_MESSAGE =
  "It's Mom. Are you eating right and getting enough sleep? ...There, don't you feel a little less homesick now?";

// Dad's save prompt, reached from the phone menu. Real persistence (the
// progression block, keyed by an anonymous localStorage token) is still TODO
// (see TODO.md "Save system") — confirming just acknowledges for now.
const SAVE_PROMPT =
  "It's Dad. You sound like you're doing great, kiddo! Want me to save your progress?";
const SAVE_DONE = "OK, I saved your progress. Don't push yourself too hard, now!";
const SAVE_CHOICES = ['Yes', 'No'];

// The save-prompt TEXT is dynamic: while the call connects it shows the ringing
// line; once the server's dad_report arrives, applyDadReport swaps in Dad's
// "I put $X in your account…" summary. Mutable so the same Yes/No window can
// re-render with the new text in place (layout + hit-test read this too).
const DAD_RINGING = "It's Dad. Let me check your account...";
let savePrompt = SAVE_PROMPT;

/**
 * Build Dad's report line from the server tallies and show it over the Yes/No
 * save prompt. `earned` = money he banked from your kills, `spent` = cash you
 * spent at shops, `bank` = current account total — all since your last call.
 * Wired from Game.ts onDadReport. No-op unless we're on the save screen (the
 * report is only requested when calling Dad).
 */
export function applyDadReport(earned: number, spent: number, bank: number): void {
  if (menuState !== 'save') return; // call was cancelled before the reply landed
  let line = `It's Dad. Since we last chatted, I put $${earned} in your account`;
  if (spent > 0) line += `, minus the $${spent} you spent`;
  line += `. You have $${bank} in your account. Want me to save your progress?`;
  savePrompt = line;
}

/** STUB — wiring only. The phone-save call site; persistence not built yet. */
function saveGame(): void {
  console.log('[save] phone save requested — persistence not implemented yet (stub)');
}

/** Open the telephone contact menu (called from Game.tryTalk for a phone). */
export function openPhoneMenu(): void {
  phoneCursor = 0;
  menuState = 'phone';
}

// ATM — move money between your bank account and on-hand cash. Up/Down pick the
// action (Withdraw / Deposit); Left/Right size the amount (clamped to what's
// available); confirm sends the request. The server is authoritative and re-clamps,
// so nothing here can mint or overdraw money — see GameHost atm_withdraw/deposit.
const ATM_ACTIONS = ['Withdraw', 'Deposit'] as const;
let atmCursor = 0; // 0 = Withdraw, 1 = Deposit
let atmAmount = 0; // currently dialed-in amount

/** Max amount the selected action can move (bank for withdraw, cash for deposit). */
function atmMax(): number {
  return atmCursor === 0 ? getBank() : getMoney();
}
/** Step the dialed amount by ~1/10 of the available max (min $1), clamped. */
function atmStep(): number {
  return Math.max(1, Math.round(atmMax() / 10));
}

/** Open the ATM/bank menu (called from Game.tryTalk for an ATM sprite). */
export function openAtmMenu(): void {
  atmCursor = 0;
  atmAmount = 0;
  menuState = 'atm';
}

// Shop: opened by talking to a clerk (openShop), NOT from the command grid.
// 'shop' is the Buy/Sell chooser; the two lists hang under it. The server owns
// money + inventory, so confirming just sends a request and the resulting
// inventory/money deltas flow back through Network and re-render the lists.
// Shop state (shopStore etc.) is declared below; the Buy/Sell labels and all
// window geometry live in ./menu/layout.

// --- Equip screen (EB 4-slot) + hotbar geometry/logic ------------------------

// The Equip screen is a slot list (Weapon / Body / Arms / Other) in the center
// third. Picking a slot opens a sub-modal in the right third listing the gear
// the player owns for that slot; picking an item there equips it.

function equipRows(): EquipRow[] {
  return EQUIP_SLOTS.map((slot) => ({ kind: 'slot', slot }));
}

/** Gear the player owns that fits `slot` (deduped by id). */
function equipItemsForSlot(slot: EquipSlot): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const g of getGoods()) {
    if (itemEquip(g.id)?.slot === slot && !seen.has(g.id)) {
      seen.add(g.id);
      out.push({ id: g.id, name: g.name });
    }
  }
  return out;
}

/** Rows for the open sub-modal: a "(Take off)" option (id '') then the gear. */
function equipSelectItems(): { id: string; name: string }[] {
  return [{ id: '', name: '(Take off)' }, ...equipItemsForSlot(equipSlotSel)];
}

/** Open the sub-modal for the slot under the equip cursor. */
function openEquipSelect(): void {
  equipSlotSel = EQUIP_SLOTS[equipCursor];
  equipSelectCursor = 0;
  menuState = 'equip_select';
}

/** Act on a sub-modal row: equip the chosen item, or take off (id ''). */
function activateEquipSelect(i: number): void {
  const sel = equipSelectItems()[i];
  if (!sel) return;
  hooks?.equip(equipSlotSel, sel.id === '' ? null : sel.id);
  playEventSfx('cursor-vertical');
  menuState = 'equip'; // back to the slot list
}

/** Current Offense/Defense INCLUDING equipped gear (for the live status panel). */
function equipStats(): { offense: number; defense: number } {
  const base = getStatus();
  const offense = base.offense + itemOffense(hooks?.getEquipped('weapon') ?? '');
  let defense = base.defense;
  for (const s of ['body', 'arms', 'other'] as EquipSlot[]) {
    defense += itemDefense(hooks?.getEquipped(s) ?? '');
  }
  return { offense, defense };
}

/** Auto-equip a Good if it's gear (else use it). Shows the resulting stat. */
/** Use a consumable from EITHER the Goods menu or a hotbar slot: ask the server
 *  to apply it, and — only for FOOD (the item's category folder, see
 *  ItemFolders) that can actually be eaten — play the eat SFX. At full HP the
 *  server refuses a heal item (and floats "HP is full"), so we skip the chomp
 *  for a bite that won't happen. getStatus().hp is kept live by onPlayerHp.
 *  Non-food consumables (sprays, key items…) use the same path but never chomp. */
function useConsumable(id: string): void {
  const st = getStatus();
  if (isFoodItem(id) && st.hp < st.hpMax) playEventSfx('eat');
  sendUseItem(id);
}

function useOrEquipGood(id: string): void {
  const eq = itemEquip(id);
  if (!eq) {
    useConsumable(id);
    return;
  }
  hooks?.equip(eq.slot, id);
  const after = equipStats(); // hooks.equip updated the mirror synchronously
  const line =
    eq.slot === 'weapon' ? `Offense is now ${after.offense}.` : `Defense is now ${after.defense}.`;
  message = `Equipped ${getItemName(id) ?? 'it'}.\n${line}`;
  menuState = 'message';
}

/** Equip any gear (weapon or armor) into its own slot (no-op if already worn). */
function equipToggle(id: string): void {
  const eq = itemEquip(id);
  if (!eq) return;
  if ((hooks?.getEquipped(eq.slot) ?? null) !== id) hooks?.equip(eq.slot, id);
}

/** Cast a PSI ability (server-authoritative) + its cast/heal SFX. Shared by the
 *  PSI menu and the hotbar so both paths sound and behave identically. */
function usePsi(abilityId: string): void {
  // "Can't concentrate" (noPsi) disables ALL PSI regardless of PP — blocks here
  // for instant feedback; the server enforces it too (gameHost use_psi).
  if (hooks?.psiBlocked?.()) {
    hooks?.notify?.("Can't concentrate!");
    return;
  }
  // Gate on PP up front (the server enforces it too — gameHost use_psi — but
  // without this the client would play the cast FX/SFX and only be SILENTLY
  // rejected, so it looked like the move worked). getStatus().pp is the
  // server-authoritative value (refreshed after every cast via onPlayerStats).
  if (getStatus().pp < psiCost(abilityId)) {
    hooks?.notify?.('Not enough PP');
    return; // no send, no FX, no SFX — the move simply doesn't happen
  }
  // Server checks PP, applies the effect, and pushes back player_hp (heal) +
  // player_stats (PP decrease) so the bars redraw.
  sendUsePsi(abilityId);
  playEventSfx('player-try-psi');
  // Lifeup layers its heal chime on top of the generic PSI cast sound.
  if (abilityId === 'lifeup') playEventSfx('heal');
  // The cast ANIMATION is server-driven (psi_cast → onPsiCast), so everyone —
  // including us — sees it at the authoritative caster/target positions.
}

/** Trigger a hotbar slot. Weapon → swap to / equip it; consumable → use it
 *  (cookie, etc.); PSI → cast it. Equipping never toggles off — an already-worn
 *  weapon just stays equipped, so the key reads as "make this my weapon". */
function activateSlot(i: number): void {
  const id = hotbar[i];
  if (!id) return;
  if (isPsiEntry(id)) {
    usePsi(id.slice(PSI_TAG.length));
    return;
  }
  const eq = itemEquip(id);
  if (eq?.slot === 'weapon')
    equipToggle(id); // swap to this weapon
  else useConsumable(id); // consumable (food → eat SFX + server use)
}

/** Trigger hotbar slot `n` (0-based) — keys 1/2 in the field. Toggle-brandishes
 *  the assigned weapon or uses the assigned consumable. Public so Game can fire
 *  it during overworld play (the old G "cycle weapon" key is gone). */
export function triggerHotbarSlot(n: number): void {
  activateSlot(n);
}

/** Hotbar-eligible = a weapon (held/brandished) or a consumable (non-gear).
 *  Armor slots (body/arms/other) are excluded — they live only on Equip. */
function hotbarEligible(id: string): boolean {
  if (isPsiEntry(id)) return true; // PSI moves are always quick-castable
  const eq = itemEquip(id);
  return !eq || eq.slot === 'weapon';
}

/**
 * Make the equipped weapon quick-selectable: if it's not already on the hotbar,
 * drop it into the first EMPTY slot, else swap out an OLD weapon (you only carry
 * one). It NEVER evicts a consumable/PSI the player deliberately placed — if both
 * slots are full of non-weapons, the weapon just isn't on the bar until a slot
 * frees up (the player's layout wins). Call whenever the equipped weapon changes.
 * Non-evicting is also what keeps a saved PSI intact when this runs on restore.
 */
export function syncWeaponHotbar(weaponId: string | null): void {
  if (!weaponId || hotbar.includes(weaponId)) return;
  const empty = hotbar.indexOf(null);
  const weaponSlot = hotbar.findIndex((id) => id !== null && itemEquip(id)?.slot === 'weapon');
  const target = empty !== -1 ? empty : weaponSlot; // -1 = full of non-weapons → leave it
  if (target !== -1) hotbar[target] = weaponId;
}

// Pointer drag/drop. Goods: drag a row to a hotbar box to assign it, or release
// on the same row to use/equip it. PSI: drag a move onto a box to quick-cast it.
// Press/release use their own Input latches, distinct from clicks. (Equipping is
// done entirely on the Equip slot list + its sub-modal, not via drag.)
function updateHotbarDrag(): void {
  const press = consumePointerPress();
  if (press && !drag) {
    if (menuState === 'goods') {
      const items = getGoods();
      const i = goodsRowAt(press.x, press.y);
      if (i >= 0 && items[i]) drag = { id: items[i].id };
    } else if (menuState === 'psi') {
      // Drag a PSI move onto a hotbar box to quick-cast it with 1/2.
      const i = psiRowAt(press.x, press.y);
      if (i >= 0 && PSI_ABILITIES[i]) drag = { id: PSI_TAG + PSI_ABILITIES[i].id };
    }
  }
  const rel = consumePointerRelease();
  if (rel && drag) {
    const box = hotbarBoxAt(rel.x, rel.y);
    if (box >= 0) {
      // The hotbar is for things you ACT with — a weapon to brandish, a
      // consumable buff, or a PSI move. Armor (body/arms/other) belongs only on
      // the Equip screen, so reject it here.
      if (hotbarEligible(drag.id)) {
        // Save the new layout — especially an assigned PSI, which (unlike the
        // weapon) has no other anchor to be re-derived from on reload.
        hotbar[box] = drag.id;
        persistHotbar();
      }
    } else if (menuState === 'goods') {
      // Released back on a Goods row (not a box): treat as a click → use/equip.
      const i = goodsRowAt(rel.x, rel.y);
      const items = getGoods();
      if (i >= 0 && items[i] && items[i].id === drag.id) useOrEquipGood(items[i].id);
    } else if (menuState === 'psi') {
      // Released back on the same PSI row (not a box): treat as a click → cast.
      const i = psiRowAt(rel.x, rel.y);
      if (i >= 0 && PSI_ABILITIES[i] && PSI_TAG + PSI_ABILITIES[i].id === drag.id)
        usePsi(PSI_ABILITIES[i].id);
    }
    drag = null;
  }
  if (drag && !isPointerDown()) drag = null; // safety: never get stuck dragging
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

let menuState: MenuName = 'closed';

// Modal prompt screens that OWN the keyboard: the telephone, the ATM, the
// Yes/No confirms (PK warning + Dad's save), and result messages. On these the
// quick-select hotbar is suppressed — keys 1/2 and drag do nothing and the bar
// isn't drawn — so a stray hotkey can't fire an item/PSI mid-prompt. The bar
// stays live only on the browsing screens (command/goods/psi/equip/status/shop).
const HOTBAR_BLOCKED: ReadonlySet<MenuName> = new Set<MenuName>([
  'phone',
  'save',
  'confirm',
  'atm',
  'message',
]);
function hotbarActive(): boolean {
  return menuState !== 'closed' && !HOTBAR_BLOCKED.has(menuState);
}

let cursorIndex = 0;
let goodsCursor = 0;
let psiCursor = 0;
let message = '';
let shopStore = -1; // store id of the clerk being talked to
let shopRootCursor = 0; // 0 = Buy, 1 = Sell
let shopBuyCursor = 0;
let shopSellCursor = 0;
let shopNote = ''; // transient line under the shop (e.g. "Not enough money")
let phoneCursor = 0; // selected contact in the telephone menu
let saveCursor = 0; // 0 = Yes, 1 = No, on the phone-save prompt
// Generic Yes/No confirm state (currently the PK warning). The prompt text, the
// action to run on Yes, and an optional follow-up message are set by onSelect.
let confirmCursor = 0;
let confirmPrompt = '';
let confirmYesMsg = '';
let confirmOnYes: (() => void) | null = null;

const prevKeys = new Set<string>();
let liveKeys: Set<string>;

export function initMenu(keySet: Set<string>, h?: MenuHooks): void {
  liveKeys = keySet;
  hooks = h ?? null;
}

export function updateMenu(): void {
  if (!liveKeys) return;

  const justPressed = (code: string) => liveKeys.has(code) && !prevKeys.has(code);
  const toggle = justPressed('KeyQ') || justPressed('KeyX') || justPressed('Escape');
  // Confirm/activate a command: Z, Space, Enter, or E (the contextual button).
  const confirm =
    justPressed('KeyZ') || justPressed('Space') || justPressed('Enter') || justPressed('KeyE');
  // A left-click anywhere this frame (game-space coords), consumed once.
  const click = menuState === 'closed' ? null : consumePointerClick();

  // Hotbar (browsing screens only — not the modal prompts): number keys 1-2
  // trigger their slot (toggle-equip gear / use a consumable). Drag-drop
  // assignment is in updateHotbarDrag. See hotbarActive / HOTBAR_BLOCKED.
  if (hotbarActive()) {
    for (let n = 0; n < HOTBAR_SLOTS; n++) {
      if (justPressed(`Digit${n + 1}`)) activateSlot(n);
    }
    updateHotbarDrag();
  }

  if (menuState === 'closed') {
    if (toggle) {
      menuState = 'command';
      cursorIndex = 0;
      playEventSfx('menu-open');
      consumePointerClick(); // drop any click left over from gameplay
    }
  } else if (menuState === 'command') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'closed';
      playEventSfx('menu-close');
    } else {
      let col = cursorIndex % COLS;
      let row = Math.floor(cursorIndex / COLS);
      const prevCursor = cursorIndex;
      let moveAxis: 'horizontal' | 'vertical' | null = null;
      if (justPressed('ArrowLeft') || justPressed('KeyA')) {
        col = (col + COLS - 1) % COLS;
        moveAxis = 'horizontal';
      }
      if (justPressed('ArrowRight') || justPressed('KeyD')) {
        col = (col + 1) % COLS;
        moveAxis = 'horizontal';
      }
      if (justPressed('ArrowUp') || justPressed('KeyW')) {
        row = (row + ROWS - 1) % ROWS;
        moveAxis = 'vertical';
      }
      if (justPressed('ArrowDown') || justPressed('KeyS')) {
        row = (row + 1) % ROWS;
        moveAxis = 'vertical';
      }
      // The 2-wide grid has one empty trailing cell (5 items); don't let the
      // cursor land on it.
      const next = row * COLS + col;
      if (next < MENU_ITEMS.length) cursorIndex = next;
      if (moveAxis && cursorIndex !== prevCursor) {
        playEventSfx(moveAxis === 'horizontal' ? 'cursor-horizontal' : 'cursor-vertical');
      }

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
        playEventSfx('cursor-confirm');
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
      const prevGoods = goodsCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        goodsCursor = (goodsCursor + items.length - 1) % items.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        goodsCursor = (goodsCursor + 1) % items.length;
      if (goodsCursor !== prevGoods) playEventSfx('cursor-vertical');

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
      const prevPsi = psiCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        psiCursor = (psiCursor + PSI_ABILITIES.length - 1) % PSI_ABILITIES.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        psiCursor = (psiCursor + 1) % PSI_ABILITIES.length;
      if (psiCursor !== prevPsi) playEventSfx('cursor-vertical');

      const p = getPointer();
      const hovered = psiRowAt(p.x, p.y);
      if (hovered >= 0) psiCursor = hovered;

      // Cast via keyboard confirm only. Mouse cast (and drag-to-hotbar) is
      // handled by updateHotbarDrag on pointer RELEASE, so dropping a PSI move
      // onto a slot assigns it without also casting it.
      const use = confirm ? psiCursor : -1;
      if (use >= 0 && PSI_ABILITIES[use]) {
        usePsi(PSI_ABILITIES[use].id);
      }
    }
  } else if (menuState === 'equip') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'command'; // back to the command grid
    } else {
      const n = EQUIP_SLOTS.length;
      const prevEquip = equipCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW')) equipCursor = (equipCursor + n - 1) % n;
      if (justPressed('ArrowDown') || justPressed('KeyS')) equipCursor = (equipCursor + 1) % n;
      if (equipCursor !== prevEquip) playEventSfx('cursor-vertical');
      const p = getPointer();
      const hov = equipRowAt(p.x, p.y);
      if (hov >= 0) equipCursor = hov;
      // E/Enter on the cursor, or a click on a slot: open that slot's sub-modal.
      if (confirm) openEquipSelect();
      if (click) {
        const ci = equipRowAt(click.x, click.y);
        if (ci >= 0) {
          equipCursor = ci;
          openEquipSelect();
        }
      }
    }
  } else if (menuState === 'equip_select') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'equip'; // back to the slot list
    } else {
      const items = equipSelectItems();
      const n = items.length;
      const prevSel = equipSelectCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        equipSelectCursor = (equipSelectCursor + n - 1) % n;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        equipSelectCursor = (equipSelectCursor + 1) % n;
      if (equipSelectCursor !== prevSel) playEventSfx('cursor-vertical');
      if (equipSelectCursor >= n) equipSelectCursor = n - 1;
      const p = getPointer();
      const hov = equipSelectRowAt(p.x, p.y, n);
      if (hov >= 0) equipSelectCursor = hov;
      if (confirm) activateEquipSelect(equipSelectCursor);
      if (click) {
        const ci = equipSelectRowAt(click.x, click.y, n);
        if (ci >= 0) activateEquipSelect(ci);
      }
    }
  } else if (menuState === 'shop') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'closed'; // leave the shop entirely
    } else {
      const prevShopRoot = shopRootCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW')) shopRootCursor = (shopRootCursor + 1) % 2;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        shopRootCursor = (shopRootCursor + 1) % 2;
      if (shopRootCursor !== prevShopRoot) playEventSfx('cursor-vertical');
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
    const rows = shopListLayout('buy', shopStore).rows;
    if (toggle || justPressed('Backspace')) {
      menuState = 'shop';
    } else if (rows.length) {
      const prevShopBuy = shopBuyCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        shopBuyCursor = (shopBuyCursor + rows.length - 1) % rows.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        shopBuyCursor = (shopBuyCursor + 1) % rows.length;
      if (shopBuyCursor !== prevShopBuy) playEventSfx('cursor-vertical');
      const p = getPointer();
      const hovered = shopRowAt('buy', shopStore, p.x, p.y);
      if (hovered >= 0) shopBuyCursor = hovered;
      let pick = confirm ? shopBuyCursor : -1;
      if (click) {
        const clicked = shopRowAt('buy', shopStore, click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && rows[pick]) {
        const item = getStoreItems(shopStore)[pick];
        // Pre-check affordability for instant feedback; the server re-validates.
        if (item && getMoney() < item.cost) shopNote = 'Not enough money.';
        else {
          sendBuy(shopStore, rows[pick].id);
          playEventSfx('shop-purchase');
          shopNote = `Bought ${item?.name ?? 'item'}!`; // the money window confirms the spend
        }
      }
    }
  } else if (menuState === 'shop_sell') {
    const rows = shopListLayout('sell', shopStore).rows;
    if (toggle || justPressed('Backspace')) {
      menuState = 'shop';
    } else if (getGoods().length) {
      const prevShopSell = shopSellCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        shopSellCursor = (shopSellCursor + rows.length - 1) % rows.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        shopSellCursor = (shopSellCursor + 1) % rows.length;
      if (shopSellCursor !== prevShopSell) playEventSfx('cursor-vertical');
      const p = getPointer();
      const hovered = shopRowAt('sell', shopStore, p.x, p.y);
      if (hovered >= 0) shopSellCursor = hovered;
      let pick = confirm ? shopSellCursor : -1;
      if (click) {
        const clicked = shopRowAt('sell', shopStore, click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && rows[pick]) {
        shopNote = '';
        sendSell(rows[pick].id);
        playEventSfx('shop-sell');
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
      const prevPhone = phoneCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        phoneCursor = (phoneCursor + PHONE_CONTACTS.length - 1) % PHONE_CONTACTS.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        phoneCursor = (phoneCursor + 1) % PHONE_CONTACTS.length;
      if (phoneCursor !== prevPhone) playEventSfx('cursor-vertical');

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
          savePrompt = DAD_RINGING; // until the dad_report reply lands
          sendDadCall(); // server replies → applyDadReport fills in the numbers
          menuState = 'save'; // Dad → save prompt
        } else {
          message = MOM_MESSAGE; // Mom → homesickness flavor
          menuState = 'message';
        }
      }
    }
  } else if (menuState === 'save') {
    // Dad's Yes/No save prompt. Cancel (Esc/Backspace) returns to the contacts.
    if (toggle || justPressed('Backspace')) {
      menuState = 'phone';
    } else {
      const prevSave = saveCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        saveCursor = (saveCursor + SAVE_CHOICES.length - 1) % SAVE_CHOICES.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        saveCursor = (saveCursor + 1) % SAVE_CHOICES.length;
      if (saveCursor !== prevSave) playEventSfx('cursor-vertical');

      const p = getPointer();
      const hovered = saveChoiceAt(p.x, p.y);
      if (hovered >= 0) saveCursor = hovered;

      let pick = confirm ? saveCursor : -1;
      if (click) {
        const clicked = saveChoiceAt(click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick === 0) {
        saveGame(); // STUB: wiring only — persistence is TODO
        message = SAVE_DONE;
        menuState = 'message';
      } else if (pick === 1) {
        menuState = 'closed'; // hung up without saving
      }
    }
  } else if (menuState === 'atm') {
    // Bank machine: pick Withdraw/Deposit (Up/Down), size the amount (Left/Right),
    // confirm to send. Cancel leaves. The amount is always clamped to what's
    // available for the chosen action so you can't dial past your balance.
    if (toggle || justPressed('Backspace')) {
      menuState = 'closed';
    } else {
      const prevCursor = atmCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW')) atmCursor = (atmCursor + 1) % 2;
      if (justPressed('ArrowDown') || justPressed('KeyS')) atmCursor = (atmCursor + 1) % 2;
      if (atmCursor !== prevCursor) {
        atmAmount = 0; // reset the dial when switching account direction
        playEventSfx('cursor-vertical');
      }
      const max = atmMax();
      if (atmAmount > max) atmAmount = max; // a balance change may have shrunk it
      const prevAmt = atmAmount;
      if (justPressed('ArrowRight') || justPressed('KeyD'))
        atmAmount = Math.min(max, atmAmount + atmStep());
      if (justPressed('ArrowLeft') || justPressed('KeyA'))
        atmAmount = Math.max(0, atmAmount - atmStep());
      if (atmAmount !== prevAmt) playEventSfx('cursor-horizontal');

      if (confirm && atmAmount > 0) {
        if (atmCursor === 0) sendAtmWithdraw(atmAmount);
        else sendAtmDeposit(atmAmount);
        playEventSfx('cash-register');
        atmAmount = 0; // server pushes new balances; start a fresh dial
      }
    }
  } else if (menuState === 'confirm') {
    // Generic Yes/No prompt (PK warning). Cancel (Esc/Backspace) = No → command.
    if (toggle || justPressed('Backspace')) {
      menuState = 'command';
    } else {
      const prev = confirmCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        confirmCursor = (confirmCursor + SAVE_CHOICES.length - 1) % SAVE_CHOICES.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        confirmCursor = (confirmCursor + 1) % SAVE_CHOICES.length;
      if (confirmCursor !== prev) playEventSfx('cursor-vertical');

      const p = getPointer();
      const hovered = confirmChoiceAt(p.x, p.y);
      if (hovered >= 0) confirmCursor = hovered;

      let pick = confirm ? confirmCursor : -1;
      if (click) {
        const clicked = confirmChoiceAt(click.x, click.y);
        if (clicked >= 0) pick = clicked;
      }
      if (pick === 0) {
        confirmOnYes?.();
        if (confirmYesMsg) {
          message = confirmYesMsg;
          menuState = 'message';
        } else {
          menuState = 'command';
        }
      } else if (pick === 1) {
        menuState = 'command';
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
  const view = buildView();
  renderMenuBody(ctx, view);
  // The hotbar (and any in-flight drag) overlay the browsing screens only —
  // hidden on the modal prompts where its keys are suppressed (hotbarActive).
  if (hotbarActive()) {
    renderHotbar(ctx, view);
    renderDragGhost(ctx, view);
  }
}

/** Draw just the quick-select hotbar as an overworld HUD element — so the 1/2
 *  slots are always visible during play, not only while the menu is open.
 *  Game.ts calls this when the menu is CLOSED (renderMenu handles it otherwise). */
export function renderHotbarOverlay(ctx: CanvasRenderingContext2D): void {
  renderHotbar(ctx, buildView());
}

// Snapshot the mutable menu state into the immutable view the renderer reads.
// (menu/render.ts never touches state; the state machine lives here.)
function buildView(): MenuView {
  return {
    state: menuState,
    cursorIndex,
    goodsCursor,
    psiCursor,
    equipCursor,
    shopRootCursor,
    shopBuyCursor,
    shopSellCursor,
    shopStore,
    shopNote,
    message,
    hotbar,
    drag,
    hooks,
    equipRows: equipRows(),
    equipStats: equipStats(),
    equipSlotSel,
    equipSelectCursor,
    equipSelectItems: equipSelectItems(),
  };
}

function renderMenuBody(ctx: CanvasRenderingContext2D, view: MenuView): void {
  if (menuState === 'message') {
    renderMessage(ctx, view);
    return;
  }
  if (menuState === 'equip' || menuState === 'equip_select') {
    renderCommand(ctx, view); // command grid stays visible behind the modal
    renderEquip(ctx, view);
    if (menuState === 'equip_select') renderEquipSelect(ctx, view);
    return;
  }
  if (menuState === 'status') {
    renderStatus(ctx);
    return;
  }
  if (menuState === 'goods') {
    renderCommand(ctx, view); // keep the command grid visible behind the Goods list
    renderGoods(ctx, view);
    return;
  }
  if (menuState === 'psi') {
    renderCommand(ctx, view); // command grid stays visible behind the PSI list
    renderPsi(ctx, view);
    return;
  }
  if (menuState === 'shop' || menuState === 'shop_buy' || menuState === 'shop_sell') {
    renderShop(ctx, view);
    return;
  }
  if (menuState === 'phone') {
    renderPhone(ctx);
    return;
  }
  if (menuState === 'atm') {
    renderAtm(ctx);
    return;
  }
  if (menuState === 'save') {
    renderSave(ctx);
    return;
  }
  if (menuState === 'confirm') {
    renderCommand(ctx, view); // keep the command grid behind the warning
    renderPrompt(ctx, confirmPrompt, confirmCursor);
    return;
  }

  renderCommand(ctx, view);
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

// ATM/bank window — balances on top, the Withdraw/Deposit chooser with a ">"
// cursor below, and the dialed amount. Top-left, same window family as the phone.
function renderAtm(ctx: CanvasRenderingContext2D): void {
  const winX = 8;
  const winY = 8;
  const lineH = FONT_LINE_HEIGHT;
  const innerX = winX + BORDER + PADDING;
  const innerW = 96;
  const lines = 6; // Bank, Cash, gap, Withdraw, Deposit, Amount
  const winH = lines * lineH + PADDING * 2 + BORDER * 2;
  drawWindow(ctx, winX, winY, innerW + PADDING * 2 + BORDER * 2, winH, MENU_STYLE);

  let y = winY + BORDER + PADDING;
  drawText(ctx, `Bank:  $${getBank()}`, innerX, y, FONT_ID);
  y += lineH;
  drawText(ctx, `Cash:  $${getMoney()}`, innerX, y, FONT_ID);
  y += lineH * 2; // blank spacer row
  for (let i = 0; i < ATM_ACTIONS.length; i++) {
    if (i === atmCursor) drawCursor(ctx, innerX, y + 3);
    drawText(ctx, ATM_ACTIONS[i], innerX + CURSOR_W, y, FONT_ID);
    y += lineH;
  }
  drawText(ctx, `Amount: $${atmAmount}`, innerX, y, FONT_ID);
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

// Yes/No prompt UI: a full-width question window at the bottom (same as a
// dialogue message) with a small Yes/No chooser tucked just above its right end.
// Shared by the phone-save flow and the generic 'confirm' state (e.g. PK).
function promptLayout(promptText: string): {
  lines: string[];
  promptX: number;
  promptY: number;
  promptW: number;
  promptH: number;
  chX: number;
  chY: number;
  chW: number;
  chH: number;
  chInnerW: number;
} {
  const innerW = SCREEN_WIDTH - 16 - BORDER * 2 - PADDING * 2;
  const lines = wrapText(promptText, innerW);
  const promptW = SCREEN_WIDTH - 16;
  const promptH = lines.length * FONT_LINE_HEIGHT + PADDING * 2 + BORDER * 2;
  const promptX = 8;
  const promptY = SCREEN_HEIGHT - 8 - promptH;

  const labelW = Math.max(...SAVE_CHOICES.map((l) => measureText(l, FONT_ID)));
  const chInnerW = CURSOR_W + labelW;
  const chW = chInnerW + PADDING * 2 + BORDER * 2;
  const chH = SAVE_CHOICES.length * ITEM_H + PADDING * 2 + BORDER * 2;
  const chX = promptX + promptW - chW; // right-aligned over the prompt
  const chY = promptY - chH - 2; // sits just above the prompt

  return { lines, promptX, promptY, promptW, promptH, chX, chY, chW, chH, chInnerW };
}

/** Index of the Yes/No choice under a game-space point, or -1. */
function choiceAt(prompt: string, px: number, py: number): number {
  const { chX, chY, chInnerW } = promptLayout(prompt);
  for (let i = 0; i < SAVE_CHOICES.length; i++) {
    const x = chX + BORDER + PADDING;
    const y = chY + BORDER + PADDING + i * ITEM_H;
    if (px >= x && px < x + chInnerW && py >= y && py < y + ITEM_H) return i;
  }
  return -1;
}
const saveChoiceAt = (px: number, py: number) => choiceAt(savePrompt, px, py);
const confirmChoiceAt = (px: number, py: number) => choiceAt(confirmPrompt, px, py);

// Draw a Yes/No prompt (question window + chooser) with `cursor` highlighted.
function renderPrompt(ctx: CanvasRenderingContext2D, promptText: string, cursor: number): void {
  const { lines, promptX, promptY, promptW, promptH, chX, chY, chW, chH } =
    promptLayout(promptText);
  drawWindow(ctx, promptX, promptY, promptW, promptH, MENU_STYLE);
  for (let i = 0; i < lines.length; i++) {
    drawText(
      ctx,
      lines[i],
      promptX + BORDER + PADDING,
      promptY + BORDER + PADDING + i * FONT_LINE_HEIGHT,
      FONT_ID
    );
  }
  drawWindow(ctx, chX, chY, chW, chH, MENU_STYLE);
  for (let i = 0; i < SAVE_CHOICES.length; i++) {
    const x = chX + BORDER + PADDING;
    const y = chY + BORDER + PADDING + i * ITEM_H;
    if (i === cursor) drawCursor(ctx, x, y + 3);
    drawText(ctx, SAVE_CHOICES[i], x + CURSOR_W, y, FONT_ID);
  }
}

function renderSave(ctx: CanvasRenderingContext2D): void {
  renderPrompt(ctx, savePrompt, saveCursor);
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
  if (action === 'pk') {
    const pk = hooks?.getPk() ?? { on: false, lockedUntil: 0 };
    const now = Date.now();
    if (!pk.on) {
      // Enabling is a big commitment — warn, and default the cursor to "No".
      confirmPrompt =
        'Enable PK mode? Anyone will be able to attack you, and you CANNOT turn it off for 5 minutes.';
      confirmYesMsg = 'PK mode ON. Anyone can attack you now — watch your back!';
      confirmOnYes = () => hooks?.setPk(true);
      confirmCursor = 1; // default to "No"
      menuState = 'confirm';
    } else if (now < pk.lockedUntil) {
      const secs = Math.ceil((pk.lockedUntil - now) / 1000);
      const mm = Math.floor(secs / 60);
      const ss = String(secs % 60).padStart(2, '0');
      message = `PK mode is locked.\nYou can turn it off in ${mm}:${ss}.`;
      menuState = 'message';
    } else {
      // Lock expired — turning PK back off is allowed immediately (no warning).
      hooks?.setPk(false);
      message = 'PK mode OFF.\nYou are safe from other players again.';
      menuState = 'message';
    }
    return;
  }
  message = STUB_MESSAGES[action] ?? '...';
  menuState = 'message';
}
