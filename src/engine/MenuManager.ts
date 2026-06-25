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
  consumeWheelDelta,
} from './Input';
import { getGoods, goodsCount } from './Inventory';
import { getMoney, getBank, formatMoney } from './Wallet';
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
  psiCost,
  psiTarget,
  isPsiUnlockedById,
  PSI_TAG,
  isPsiEntry,
  drawCursor,
  cellAt,
  goodsRowAt,
  GOODS_COLS,
  equipRowAt,
  equipSelectLayout,
  equipSelectRowAt,
  psiTabAt,
  psiFamilyLayout,
  psiFamilyRowAt,
  psiTierLayout,
  psiTierRowAt,
  shopListItems,
  shopListLayout,
  shopRowAt,
  shopRootRowAt,
  hotbarBoxAt,
  wrapText,
  settingsLayout,
  settingsRowAt,
  ListLayout,
} from './menu/layout';
import { MenuName, MenuHooks, EquipRow, MenuView, ShopPreview } from './menu/types';
import {
  renderShop,
  renderCommand,
  renderGoods,
  renderEquip,
  renderEquipSelect,
  renderPsi,
  renderMessage,
  renderSettings,
  renderMoney,
  renderHotbar,
  renderDragGhost,
} from './menu/render';
import { PSI_TABS, familiesInTab, PsiMove } from './PsiTuning';
import { SETTINGS_ROWS, adjustSlider, flipToggle, showMoneyAlways } from './Settings';
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

// --- Scrollable-list mouse control (wheel + draggable scrollbar) -------------
// Scroll follows the cursor (see layout.scrollList), so the wheel and a
// scrollbar-thumb drag both work by MOVING the list cursor; the list then
// scrolls to keep it visible. scrollbarDragging latches a thumb grab so the
// drag keeps tracking even when the pointer slips off the 3px-wide bar.
let scrollbarDragging = false;
let wasPointerDown = false;
let frameWheel = 0; // wheel notches consumed at the top of this frame's update
// Last pointer position, so we only let mouse-HOVER move the cursor when the
// mouse actually moved — otherwise a stationary pointer resting on the UI would
// re-snap the cursor every frame and override keyboard (W/S / arrows) nav.
let lastPointerX = -1;
let lastPointerY = -1;

/** Map a vertical pointer position to the cursor row that puts the thumb under
 *  it. Centres the cursor in the visible window so layout.scrollList reproduces
 *  the desired first-visible row. */
function cursorFromScrollbar(lay: ListLayout, py: number): number {
  const sb = lay.scroll;
  if (!sb) return 0;
  const maxFirst = Math.max(0, lay.count - lay.visible);
  const span = sb.h - sb.thumbH; // travel range of the thumb's top edge
  const thumbTop = Math.max(sb.y, Math.min(sb.y + span, py - sb.thumbH / 2));
  const first = span > 0 ? Math.round(((thumbTop - sb.y) / span) * maxFirst) : 0;
  return Math.max(0, Math.min(lay.count - 1, first + Math.floor(lay.visible / 2)));
}

/** Apply this frame's wheel + scrollbar drag to a list, returning the new cursor
 *  and whether the mouse took control (so the caller suppresses row-hover). */
function applyListScroll(
  lay: ListLayout,
  count: number,
  cursor: number
): { cursor: number; active: boolean } {
  if (!lay.scroll || count <= 0) return { cursor, active: false };
  let active = false;
  if (frameWheel !== 0) {
    cursor = Math.max(0, Math.min(count - 1, cursor + frameWheel));
    active = true;
  }
  const p = getPointer();
  const sb = lay.scroll;
  const overBar =
    p.x >= sb.x - 4 && p.x <= sb.x + sb.w + 4 && p.y >= sb.y - 2 && p.y <= sb.y + sb.h + 2;
  const down = isPointerDown();
  if (down && !wasPointerDown && overBar) scrollbarDragging = true; // grab the thumb/track
  if (!down) scrollbarDragging = false;
  if (scrollbarDragging) {
    cursor = cursorFromScrollbar(lay, p.y);
    active = true;
  }
  return { cursor, active };
}

/** Push the current hotbar layout to the server so it persists with the
 *  character (the server re-validates + saves it). Call after any user edit. */
function persistHotbar(): void {
  sendHotbar([...hotbar]);
}

// PSI ids became tier-suffixed catalog ids (e.g. 'fire' → 'psi_fire_alpha') when
// the full canon roster landed. Map any legacy bare-family id saved in an old
// hotbar to its α-tier equivalent so existing characters keep their assignment.
const LEGACY_PSI_IDS: Record<string, string> = {
  lifeup: 'lifeup_alpha',
  healing: 'healing_alpha',
  fire: 'psi_fire_alpha',
  freeze: 'psi_freeze_alpha',
  thunder: 'psi_thunder_alpha',
  flash: 'psi_flash_alpha',
  starstorm: 'psi_starstorm_alpha',
  rockin: 'psi_alpha',
  hypnosis: 'hypnosis_alpha',
  paralysis: 'paralysis_alpha',
  brainshock: 'brainshock_alpha',
  shield: 'shield_alpha',
  psishield: 'psi_shield_alpha',
  offenseup: 'offense_up_alpha',
  defensedown: 'defense_down_alpha',
  magnet: 'psi_magnet_alpha',
  teleport: 'teleport_alpha',
};
function migrateHotbarId(id: string | null): string | null {
  if (!id || !isPsiEntry(id)) return id;
  const bare = id.slice(PSI_TAG.length);
  const mapped = LEGACY_PSI_IDS[bare];
  return mapped ? PSI_TAG + mapped : id;
}

/** Restore the saved hotbar from the server (welcome). Fixed length; legacy PSI
 *  ids are migrated to the canon catalog ids; other unknown ids are kept as-is. */
export function setHotbar(slots: (string | null)[]): void {
  for (let i = 0; i < HOTBAR_SLOTS; i++) hotbar[i] = migrateHotbarId(slots[i] ?? null);
}

// NOTE: a depleted consumable slot is intentionally KEPT (not cleared) — it
// greys to a faded "x0" icon (see renderHotbar) and works again the moment you
// restock, with no reassigning. So there's no stock-reconcile step.

// Auto-hotbar: when you ACQUIRE a new CONSUMABLE and have an open slot, drop it
// on the bar so it's usable right away (no menu trip). We track the item TYPES
// we've seen so only genuinely-new ones auto-assign — existing items you
// deliberately left off the bar, and the saved hotbar restored on join, are
// never disturbed. WEAPONS are deliberately NOT auto-slotted: a quick slot for a
// weapon is opt-in (drag it on yourself only if you want to quick-switch to it),
// so equipping a weapon never forces it onto the bar. Armor/PSI aren't
// hotbar-eligible, so they're skipped too.
let knownGoodsIds: Set<string> | null = null; // null until the first inventory

/** Auto-fill only applies to CONSUMABLES (non-gear). Weapons stay opt-in for
 *  quick-switching — see autoHotbarNewItems. `itemEquip` is non-null for any
 *  gear (weapon OR armor), so excluding it leaves exactly the consumables. */
function autoHotbarEligible(id: string): boolean {
  return hotbarEligible(id) && !itemEquip(id);
}

export function autoHotbarNewItems(): void {
  const ids = getGoods().map((g) => g.id);
  const idSet = new Set(ids);
  if (knownGoodsIds === null) {
    // First inventory (join): just record what we start with — the saved hotbar
    // restores right after, so don't auto-fill from the starting bag.
    knownGoodsIds = idSet;
    return;
  }
  let changed = false;
  for (const id of ids) {
    if (knownGoodsIds.has(id)) continue; // not newly acquired this update
    if (hotbar.includes(id) || !autoHotbarEligible(id)) continue; // already slotted / not auto-fillable (weapons are opt-in)
    const empty = hotbar.indexOf(null);
    if (empty === -1) break; // no open slots — leave the rest for manual placement
    hotbar[empty] = id;
    changed = true;
  }
  knownGoodsIds = idSet;
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
  let line = `It's Dad. Since we last chatted, I put $${formatMoney(earned)} in your account`;
  if (spent > 0) line += `, minus the $${formatMoney(spent)} you spent`;
  line += `. You have $${formatMoney(bank)} in your account. Want me to save your progress?`;
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

// ATM — move money between your bank account and on-hand cash, OG EarthBound style.
// Two steps: (1) pick the action (Withdraw / Deposit) with Up/Down, confirm; then
// (2) an odometer amount entry — Up/Down roll the selected digit, Left/Right move
// between digit places, confirm sends. The server is authoritative and re-clamps,
// so nothing here can mint or overdraw money — see GameHost atm_withdraw/deposit.
const ATM_ACTIONS = ['Withdraw', 'Deposit'] as const;
let atmCursor = 0; // 0 = Withdraw, 1 = Deposit
let atmAmount = 0; // assembled amount
let atmStage: 'action' | 'amount' = 'action'; // pick the action, then enter the amount
let atmDigit = 0; // selected odometer place, from the RIGHT (0 = ones, 1 = tens, …)

/** Max amount the selected action can move (bank for withdraw, cash for deposit). */
function atmMax(): number {
  return atmCursor === 0 ? getBank() : getMoney();
}

/** How many digit places the odometer shows — enough for the current balance
 *  (min 1), so you can never even dial a place past what you have. String length
 *  is exact (Math.log10 has float edges, e.g. log10(1000) = 2.9999…). */
function atmPlaces(): number {
  const max = atmMax();
  return max <= 0 ? 1 : String(max).length;
}

/** Open the ATM/bank menu (called from Game.tryTalk for an ATM sprite). */
export function openAtmMenu(): void {
  atmCursor = 0;
  atmStage = 'action';
  atmAmount = 0;
  atmDigit = 0;
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

/** Stat-change preview for the item under the Buy cursor: how Offense (weapon)
 *  or Defense (armor) would read AFTER buying it and wearing it — accounting for
 *  the piece it would replace in that slot. null for consumables (no stat to
 *  show). Lets the player see the +/- before spending. */
function shopBuyPreview(): ShopPreview | null {
  const row = shopListItems('buy', shopStore)[shopBuyCursor];
  if (!row) return null;
  const eq = itemEquip(row.id);
  if (!eq) return null; // consumable / key item — no stat preview
  const cur = equipStats(); // current totals INCLUDING worn gear
  if (eq.slot === 'weapon') {
    const wornNow = itemOffense(hooks?.getEquipped('weapon') ?? '');
    return {
      lines: [
        { label: 'Offense', from: cur.offense, to: cur.offense - wornNow + itemOffense(row.id) },
      ],
    };
  }
  const wornNow = itemDefense(hooks?.getEquipped(eq.slot) ?? '');
  return {
    lines: [
      { label: 'Defense', from: cur.defense, to: cur.defense - wornNow + itemDefense(row.id) },
    ],
  };
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
  const food = isFoodItem(id);
  // A heal food at full HP heals 0 and the server refuses it, so don't cue an
  // eat/use that won't happen. Otherwise: eat SFX (food only) + the item's "use"
  // animation on the player. The FX is also networked (server broadcasts the use
  // so other players see it) — this is the local caster's optimistic copy.
  const refused = food && st.hp >= st.hpMax;
  if (!refused) {
    if (food) playEventSfx('eat');
    hooks?.itemUseFx?.(id);
  }
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
  // Unlock gate: must be LEARNED (Mental >= unlockMental), unless a dev. Instant
  // client feedback; the server enforces it too (gameHost use_psi). No FX/send.
  if (!isPsiUnlockedById(abilityId)) {
    hooks?.notify?.("You haven't learned that PSI yet.");
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
  // Party-target PSI (Lifeup/Healing/revive): hand off to the game's target
  // picker (self or an ally). If it takes over, don't cast here — the picker
  // sends the cast (with a targetId) once a target is chosen.
  if (psiTarget(abilityId) === 'ally' && hooks?.beginPsiTarget?.(abilityId)) {
    return;
  }
  // Server checks PP, applies the effect, and pushes back player_hp (heal) +
  // player_stats (PP decrease) so the bars redraw.
  sendUsePsi(abilityId);
  playEventSfx('player-try-psi');
  // Lifeup layers its heal chime on top of the generic PSI cast sound (any tier).
  if (abilityId.startsWith('lifeup')) playEventSfx('heal');
  // The cast ANIMATION is server-driven (psi_cast → onPsiCast), so everyone —
  // including us — sees it at the authoritative caster/target positions.
}

/** The move currently highlighted in the PSI menu: the selected tier when the
 *  tier popup is open, else the highlighted family's first (α) tier. */
function currentPsiMove(): PsiMove | null {
  const fam = familiesInTab(PSI_TABS[psiTab])[psiFamilyCursor];
  if (!fam) return null;
  return psiTierOpen ? (fam.moves[psiTierCursor] ?? null) : fam.moves[0];
}

/** Assign a PSI move to a hotbar slot (tagged), persist, and confirm. Shared by
 *  the number-key and drag-to-slot equip paths in the PSI menu. */
function equipPsiToSlot(move: PsiMove, slot: number): void {
  if (slot < 0 || slot >= HOTBAR_SLOTS) return;
  hotbar[slot] = PSI_TAG + move.id;
  persistHotbar();
  hooks?.notify?.(`${move.name} → slot ${slot + 1}`);
  playEventSfx('cursor-horizontal');
}

/** Trigger a hotbar slot. Weapon → swap to / equip it; consumable → use it
 *  (cookie, etc.); PSI → cast it. Equipping never toggles off — an already-worn
 *  weapon just stays equipped, so the key reads as "make this my weapon". */
function activateSlot(i: number, consumableOnly = false): void {
  const id = hotbar[i];
  if (!id) return;
  if (isPsiEntry(id)) {
    if (consumableOnly) return; // KO'd: PSI is locked, only a consumable can save you
    usePsi(id.slice(PSI_TAG.length));
    return;
  }
  const eq = itemEquip(id);
  if (eq?.slot === 'weapon') {
    if (consumableOnly) return; // KO'd: can't brandish a weapon while down
    equipToggle(id); // swap to this weapon
    return;
  }
  // Consumable: a depleted slot stays ASSIGNED but does nothing (the faded x0
  // icon shows it's empty). Restock the item and the same slot works again with
  // no reassigning.
  if (goodsCount(id) === 0) return;
  useConsumable(id); // food → eat SFX + server use
}

/** Trigger hotbar slot `n` (0-based) — keys 1/2 in the field. Toggle-brandishes
 *  the assigned weapon or uses the assigned consumable. Public so Game can fire
 *  it during overworld play (the old G "cycle weapon" key is gone). */
export function triggerHotbarSlot(n: number): void {
  activateSlot(n);
}

/** Trigger hotbar slot `n` but ONLY if it's a consumable — used while KO'd, when
 *  a last-ditch healing/revive item is the one thing you're allowed to use to
 *  claw back up (weapons + PSI stay locked). The server re-validates + revives. */
export function triggerHotbarConsumable(n: number): void {
  activateSlot(n, true);
}

/** Hotbar-eligible = a weapon (held/brandished) or a consumable (non-gear).
 *  Armor slots (body/arms/other) are excluded — they live only on Equip. */
function hotbarEligible(id: string): boolean {
  if (isPsiEntry(id)) return true; // PSI moves are always quick-castable
  const eq = itemEquip(id);
  return !eq || eq.slot === 'weapon';
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
      // Drag a PSI move onto a hotbar box to assign it (cast later with 1-6). The
      // source is the selected tier when the popup is open, else the family's α.
      if (psiTierOpen) {
        const fam = familiesInTab(PSI_TABS[psiTab])[psiFamilyCursor];
        const i = psiTierRowAt(PSI_TABS[psiTab], psiFamilyCursor, press.x, press.y, psiTierCursor);
        if (fam && fam.moves[i]) drag = { id: PSI_TAG + fam.moves[i].id };
      } else {
        const fams = familiesInTab(PSI_TABS[psiTab]);
        const i = psiFamilyRowAt(PSI_TABS[psiTab], press.x, press.y, psiFamilyCursor);
        if (i >= 0 && fams[i]) drag = { id: PSI_TAG + fams[i].moves[0].id };
      }
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
      if (psiTierOpen) {
        // Released on the same tier row (not a box): treat as a click → cast.
        const fam = familiesInTab(PSI_TABS[psiTab])[psiFamilyCursor];
        const i = psiTierRowAt(PSI_TABS[psiTab], psiFamilyCursor, rel.x, rel.y, psiTierCursor);
        if (fam && fam.moves[i] && PSI_TAG + fam.moves[i].id === drag.id) usePsi(fam.moves[i].id);
      } else {
        // Released on a family row: open its tier popup (mouse equivalent of Enter).
        const i = psiFamilyRowAt(PSI_TABS[psiTab], rel.x, rel.y, psiFamilyCursor);
        if (i >= 0) {
          psiFamilyCursor = i;
          psiTierOpen = true;
          psiTierCursor = 0;
          playEventSfx('cursor-vertical');
        }
      }
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
let settingsCursor = 0; // highlighted row on the Settings screen
// PSI menu (canon-style): active tab → family in that tab → tier popup.
let psiTab = 0; // index into PSI_TABS
let psiFamilyCursor = 0; // family row within the active tab
let psiTierOpen = false; // is the α/β/γ/Ω/Σ popup open for the selected family?
let psiTierCursor = 0; // tier row within the opened family
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
// Where No / a message-less Yes returns to (the screen the confirm popped over).
// PK warns from the command grid; the shop's "Equip now?" pops over shop_buy.
let confirmReturn: MenuName = 'command';

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
  // Wheel notches for this frame — consumed unconditionally so idle frames can't
  // let scroll pile up; only the active list's handler reads frameWheel.
  frameWheel = consumeWheelDelta();
  // Did the mouse move this frame? Hover only steals the cursor when it did, so
  // keyboard nav works even while the pointer rests on the UI.
  const ptr = getPointer();
  const mouseMoved = ptr.x !== lastPointerX || ptr.y !== lastPointerY;
  lastPointerX = ptr.x;
  lastPointerY = ptr.y;

  // Hotbar (browsing screens only — not the modal prompts): number keys 1-2
  // trigger their slot (toggle-equip gear / use a consumable). Drag-drop
  // assignment is in updateHotbarDrag. See hotbarActive / HOTBAR_BLOCKED.
  if (hotbarActive()) {
    for (let n = 0; n < HOTBAR_SLOTS; n++) {
      if (!justPressed(`Digit${n + 1}`)) continue;
      // In the PSI menu the number keys EQUIP the highlighted move to that slot
      // (you opened PSI to assign one); everywhere else they trigger the slot.
      if (menuState === 'psi') {
        const m = currentPsiMove();
        if (m) equipPsiToSlot(m, n);
      } else {
        activateSlot(n);
      }
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
      const hovered = mouseMoved ? cellAt(p.x, p.y) : -1;
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
  } else if (menuState === 'settings') {
    if (toggle || justPressed('Backspace')) {
      menuState = 'command';
    } else {
      const n = SETTINGS_ROWS.length;
      const prev = settingsCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        settingsCursor = (settingsCursor + n - 1) % n;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        settingsCursor = (settingsCursor + 1) % n;
      if (settingsCursor !== prev) playEventSfx('cursor-vertical');

      // Mouse: wheel + scrollbar (future-proofs a longer list), then hover-select.
      const lay = settingsLayout(settingsCursor);
      const sc = applyListScroll(lay, n, settingsCursor);
      settingsCursor = sc.cursor;
      const p = getPointer();
      const hov =
        lay.scroll || sc.active || !mouseMoved ? -1 : settingsRowAt(p.x, p.y, settingsCursor);
      if (hov >= 0) settingsCursor = hov;

      // ←/→ adjust the highlighted row: ±10% for a slider, flip for a toggle.
      // Confirm (Z/Space/Enter) flips a toggle too; sliders ignore it.
      const row = SETTINGS_ROWS[settingsCursor];
      const left = justPressed('ArrowLeft') || justPressed('KeyA');
      const right = justPressed('ArrowRight') || justPressed('KeyD');
      if (row.kind === 'slider') {
        if (left) {
          adjustSlider(row.key, -1);
          playEventSfx('cursor-horizontal');
        }
        if (right) {
          adjustSlider(row.key, 1);
          playEventSfx('cursor-horizontal');
        }
      } else if (left || right || confirm) {
        flipToggle(row.key);
        playEventSfx('cursor-confirm');
      }
      // Click a row to select it; clicking a toggle row also flips it.
      if (click) {
        const ci = settingsRowAt(click.x, click.y, settingsCursor);
        if (ci >= 0) {
          settingsCursor = ci;
          if (SETTINGS_ROWS[ci].kind === 'toggle') {
            flipToggle(SETTINGS_ROWS[ci].key);
            playEventSfx('cursor-confirm');
          }
        }
      }
    }
  } else if (menuState === 'goods') {
    const items = getGoods();
    if (toggle || justPressed('Backspace') || items.length === 0) {
      menuState = 'command'; // cancel, or nothing left to show
    } else {
      // 2-column grid (row-major): ↑/↓ jump a whole row (±GOODS_COLS), ←/→ step
      // a column, all clamped to the list (no wrap, so the cursor can't land on
      // an empty cell past the last item).
      if (goodsCursor >= items.length) goodsCursor = items.length - 1;
      const prevGoods = goodsCursor;
      let horiz = false;
      if ((justPressed('ArrowUp') || justPressed('KeyW')) && goodsCursor - GOODS_COLS >= 0)
        goodsCursor -= GOODS_COLS;
      if (
        (justPressed('ArrowDown') || justPressed('KeyS')) &&
        goodsCursor + GOODS_COLS < items.length
      )
        goodsCursor += GOODS_COLS;
      if ((justPressed('ArrowLeft') || justPressed('KeyA')) && goodsCursor % GOODS_COLS !== 0) {
        goodsCursor -= 1;
        horiz = true;
      }
      if (
        (justPressed('ArrowRight') || justPressed('KeyD')) &&
        goodsCursor % GOODS_COLS !== GOODS_COLS - 1 &&
        goodsCursor + 1 < items.length
      ) {
        goodsCursor += 1;
        horiz = true;
      }
      if (goodsCursor !== prevGoods) playEventSfx(horiz ? 'cursor-horizontal' : 'cursor-vertical');

      // Mouse hover moves the cursor to the cell under the pointer.
      const p = getPointer();
      const hovered = !mouseMoved ? -1 : goodsRowAt(p.x, p.y);
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
    // Canon-style: a tab bar (←/→) → a family list (↑/↓) → a tier popup (↑/↓).
    // Enter opens a family / casts the chosen tier; the number keys 1-6 equip the
    // highlighted move to a hotbar slot (handled in the global hotbar block). Mouse
    // open/cast/equip is in updateHotbarDrag so a drag-to-slot never also casts.
    if (toggle || justPressed('Backspace')) {
      if (psiTierOpen) {
        psiTierOpen = false; // close the tier popup, back to the family list
        playEventSfx('cursor-vertical');
      } else {
        menuState = 'command'; // cancel back to the command grid
      }
    } else if (!psiTierOpen) {
      // ←/→ switch tab (resets the family cursor).
      const prevTab = psiTab;
      if (justPressed('ArrowLeft') || justPressed('KeyA'))
        psiTab = (psiTab + PSI_TABS.length - 1) % PSI_TABS.length;
      if (justPressed('ArrowRight') || justPressed('KeyD')) psiTab = (psiTab + 1) % PSI_TABS.length;
      const p = getPointer();
      if (click) {
        const ti = psiTabAt(click.x, click.y);
        if (ti >= 0) psiTab = ti;
      }
      if (psiTab !== prevTab) {
        psiFamilyCursor = 0;
        psiTierCursor = 0;
        playEventSfx('cursor-horizontal');
      }

      const fams = familiesInTab(PSI_TABS[psiTab]);
      const prevFam = psiFamilyCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        psiFamilyCursor = (psiFamilyCursor + fams.length - 1) % fams.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        psiFamilyCursor = (psiFamilyCursor + 1) % fams.length;
      if (psiFamilyCursor !== prevFam) playEventSfx('cursor-vertical');

      const lay = psiFamilyLayout(PSI_TABS[psiTab], psiFamilyCursor);
      const sc = applyListScroll(lay, fams.length, psiFamilyCursor);
      psiFamilyCursor = sc.cursor;
      const hovered =
        lay.scroll || sc.active || !mouseMoved
          ? -1
          : psiFamilyRowAt(PSI_TABS[psiTab], p.x, p.y, psiFamilyCursor);
      if (hovered >= 0) psiFamilyCursor = hovered;

      // Enter opens the highlighted family's tier popup. (A mouse click on a
      // family opens it via updateHotbarDrag's release handler.)
      if (confirm && fams[psiFamilyCursor]) {
        psiTierOpen = true;
        psiTierCursor = 0;
        playEventSfx('cursor-vertical');
      }
    } else {
      const fam = familiesInTab(PSI_TABS[psiTab])[psiFamilyCursor];
      if (!fam) {
        psiTierOpen = false;
      } else {
        const prevTier = psiTierCursor;
        if (justPressed('ArrowUp') || justPressed('KeyW'))
          psiTierCursor = (psiTierCursor + fam.moves.length - 1) % fam.moves.length;
        if (justPressed('ArrowDown') || justPressed('KeyS'))
          psiTierCursor = (psiTierCursor + 1) % fam.moves.length;
        if (psiTierCursor !== prevTier) playEventSfx('cursor-vertical');

        const lay = psiTierLayout(PSI_TABS[psiTab], psiFamilyCursor, psiTierCursor);
        const sc = applyListScroll(lay, fam.moves.length, psiTierCursor);
        psiTierCursor = sc.cursor;
        const p = getPointer();
        const hovered =
          lay.scroll || sc.active || !mouseMoved
            ? -1
            : psiTierRowAt(PSI_TABS[psiTab], psiFamilyCursor, p.x, p.y, psiTierCursor);
        if (hovered >= 0) psiTierCursor = hovered;

        // Cast via keyboard confirm. Mouse cast (release on the row) + drag-to-slot
        // equip are in updateHotbarDrag.
        if (confirm && fam.moves[psiTierCursor]) usePsi(fam.moves[psiTierCursor].id);
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
      const hov = mouseMoved ? equipRowAt(p.x, p.y) : -1;
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

      const lay = equipSelectLayout(n, equipSelectCursor);
      const sc = applyListScroll(lay, n, equipSelectCursor);
      equipSelectCursor = sc.cursor;

      const p = getPointer();
      // Hover only selects when the list fits; a scrolling list scrolls via the bar.
      const hov =
        lay.scroll || sc.active || !mouseMoved
          ? -1
          : equipSelectRowAt(p.x, p.y, n, equipSelectCursor);
      if (hov >= 0) equipSelectCursor = hov;
      if (confirm) activateEquipSelect(equipSelectCursor);
      if (click) {
        const ci = equipSelectRowAt(click.x, click.y, n, equipSelectCursor);
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
      const hov = mouseMoved ? shopRootRowAt(p.x, p.y) : -1;
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
    const items = shopListItems('buy', shopStore); // ALL rows (the list scrolls)
    if (toggle || justPressed('Backspace')) {
      menuState = 'shop';
    } else if (items.length) {
      const prevShopBuy = shopBuyCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        shopBuyCursor = (shopBuyCursor + items.length - 1) % items.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        shopBuyCursor = (shopBuyCursor + 1) % items.length;
      if (shopBuyCursor !== prevShopBuy) playEventSfx('cursor-vertical');

      const lay = shopListLayout('buy', shopStore, shopBuyCursor);
      const sc = applyListScroll(lay, items.length, shopBuyCursor);
      shopBuyCursor = sc.cursor;

      const p = getPointer();
      // Hover only selects when the list fits; a scrolling list scrolls via the bar.
      const hovered =
        lay.scroll || sc.active || !mouseMoved
          ? -1
          : shopRowAt('buy', shopStore, p.x, p.y, shopBuyCursor);
      if (hovered >= 0) shopBuyCursor = hovered;
      let pick = confirm ? shopBuyCursor : -1;
      if (click) {
        const clicked = shopRowAt('buy', shopStore, click.x, click.y, shopBuyCursor);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && items[pick]) {
        const item = getStoreItems(shopStore)[pick];
        // Pre-check affordability for instant feedback; the server re-validates.
        if (item && getMoney() < item.cost) shopNote = 'Not enough money.';
        else {
          const boughtId = items[pick].id;
          sendBuy(shopStore, boughtId);
          playEventSfx('shop-purchase');
          shopNote = `Bought ${item?.name ?? 'item'}!`; // the money window confirms the spend
          // Equippable gear (weapon/body/arms/other) → offer to wear it now. The
          // buy round-trips well before the player picks Yes, so the server has
          // the item in Goods by the time the equip lands.
          const eq = itemEquip(boughtId);
          if (eq) {
            confirmPrompt = `Equip ${item?.name ?? 'it'} now?`;
            confirmYesMsg = '';
            confirmReturn = 'shop_buy'; // back to the store after either choice
            confirmOnYes = () => hooks?.equip(eq.slot, boughtId);
            confirmCursor = 0; // default to Yes
            menuState = 'confirm';
          }
        }
      }
    }
  } else if (menuState === 'shop_sell') {
    const items = shopListItems('sell', shopStore); // ALL rows (the list scrolls)
    if (toggle || justPressed('Backspace')) {
      menuState = 'shop';
    } else if (getGoods().length) {
      const prevShopSell = shopSellCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        shopSellCursor = (shopSellCursor + items.length - 1) % items.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        shopSellCursor = (shopSellCursor + 1) % items.length;
      if (shopSellCursor !== prevShopSell) playEventSfx('cursor-vertical');

      const lay = shopListLayout('sell', shopStore, shopSellCursor);
      const sc = applyListScroll(lay, items.length, shopSellCursor);
      shopSellCursor = sc.cursor;

      const p = getPointer();
      // Hover only selects when the list fits; a scrolling list scrolls via the bar.
      const hovered =
        lay.scroll || sc.active || !mouseMoved
          ? -1
          : shopRowAt('sell', shopStore, p.x, p.y, shopSellCursor);
      if (hovered >= 0) shopSellCursor = hovered;
      let pick = confirm ? shopSellCursor : -1;
      if (click) {
        const clicked = shopRowAt('sell', shopStore, click.x, click.y, shopSellCursor);
        if (clicked >= 0) pick = clicked;
      }
      if (pick >= 0 && items[pick]) {
        shopNote = '';
        sendSell(items[pick].id);
        playEventSfx('shop-sell');
        if (shopSellCursor >= items.length - 1) shopSellCursor = Math.max(0, items.length - 2);
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
      const hovered = mouseMoved ? phoneRowAt(p.x, p.y) : -1;
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
      const hovered = mouseMoved ? saveChoiceAt(p.x, p.y) : -1;
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
    if (atmStage === 'action') {
      // Step 1: pick Withdraw / Deposit. Cancel (Esc/Q/X) leaves the ATM.
      if (toggle) {
        menuState = 'closed';
      } else {
        const prevCursor = atmCursor;
        if (justPressed('ArrowUp') || justPressed('KeyW')) atmCursor = (atmCursor + 1) % 2;
        if (justPressed('ArrowDown') || justPressed('KeyS')) atmCursor = (atmCursor + 1) % 2;
        if (atmCursor !== prevCursor) playEventSfx('cursor-vertical');
        if (confirm) {
          atmStage = 'amount'; // proceed to the odometer
          atmAmount = 0;
          atmDigit = 0;
          playEventSfx('cursor-horizontal');
        }
      }
    } else {
      // Step 2: odometer amount entry. Cancel (Esc/Q/X/Backspace) goes back to the
      // action chooser. Up/Down roll the selected digit; Left/Right move places.
      if (toggle || justPressed('Backspace')) {
        atmStage = 'action';
        playEventSfx('cursor-vertical');
      } else {
        const places = atmPlaces();
        if (atmDigit > places - 1) atmDigit = places - 1; // balance shrank the field
        const prevDigit = atmDigit;
        if (justPressed('ArrowRight') || justPressed('KeyD')) atmDigit = Math.max(0, atmDigit - 1);
        if (justPressed('ArrowLeft') || justPressed('KeyA'))
          atmDigit = Math.min(places - 1, atmDigit + 1);
        if (atmDigit !== prevDigit) playEventSfx('cursor-horizontal');

        const placeVal = Math.pow(10, atmDigit);
        const cur = Math.floor(atmAmount / placeVal) % 10;
        const prevAmt = atmAmount;
        if (justPressed('ArrowUp') || justPressed('KeyW'))
          atmAmount += (((cur + 1) % 10) - cur) * placeVal; // roll this digit up (9→0)
        if (justPressed('ArrowDown') || justPressed('KeyS'))
          atmAmount += (((cur + 9) % 10) - cur) * placeVal; // roll this digit down (0→9)
        atmAmount = Math.max(0, Math.min(atmMax(), atmAmount)); // never past the balance
        if (atmAmount !== prevAmt) playEventSfx('cursor-vertical');

        if (confirm && atmAmount > 0) {
          if (atmCursor === 0) sendAtmWithdraw(atmAmount);
          else sendAtmDeposit(atmAmount);
          playEventSfx('cash-register');
          atmStage = 'action'; // done — back to the chooser (balances refresh from server)
        }
      }
    }
  } else if (menuState === 'confirm') {
    // Generic Yes/No prompt (PK warning, shop "Equip now?"). Cancel = No → return
    // to whatever screen opened the prompt (confirmReturn).
    if (toggle || justPressed('Backspace')) {
      menuState = confirmReturn;
    } else {
      const prev = confirmCursor;
      if (justPressed('ArrowUp') || justPressed('KeyW'))
        confirmCursor = (confirmCursor + SAVE_CHOICES.length - 1) % SAVE_CHOICES.length;
      if (justPressed('ArrowDown') || justPressed('KeyS'))
        confirmCursor = (confirmCursor + 1) % SAVE_CHOICES.length;
      if (confirmCursor !== prev) playEventSfx('cursor-vertical');

      const p = getPointer();
      const hovered = mouseMoved ? confirmChoiceAt(p.x, p.y) : -1;
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
          menuState = confirmReturn;
        }
      } else if (pick === 1) {
        menuState = confirmReturn;
      }
    }
  }

  wasPointerDown = isPointerDown(); // for next frame's scrollbar grab edge-detect

  prevKeys.clear();
  for (const k of liveKeys) prevKeys.add(k);
}

export function isMenuOpen(): boolean {
  return menuState !== 'closed';
}

export function renderMenu(ctx: CanvasRenderingContext2D): void {
  if (menuState === 'closed') return;
  const view = buildView();
  // The hot-slot bar is the BOTTOM of the UI depth stack: draw it FIRST so every
  // modal window (command grid, lists, prompts) renders ON TOP of it. Only the
  // drag ghost (which follows the cursor) sits above the modals.
  if (hotbarActive()) renderHotbar(ctx, view);
  renderMenuBody(ctx, view);
  if (hotbarActive()) renderDragGhost(ctx, view);
}

/** Draw just the quick-select hotbar as an overworld HUD element — so the 1/2
 *  slots are always visible during play, not only while the menu is open.
 *  Game.ts calls this when the menu is CLOSED (renderMenu handles it otherwise). */
export function renderHotbarOverlay(ctx: CanvasRenderingContext2D): void {
  renderHotbar(ctx, buildView());
}

/** Draw the always-on "$N" money window when the player enables "Show $ in
 *  corner" in Settings. Game calls this when the menu is CLOSED (the menu's own
 *  screens draw the money window themselves). Sits on the top row, right-aligned
 *  but left of the mute button — tucked into the gap between the XP bar and the
 *  mute (renderMoney reserves the mute's width). */
export function renderMoneyOverlay(ctx: CanvasRenderingContext2D): void {
  if (showMoneyAlways()) renderMoney(ctx);
}

// Snapshot the mutable menu state into the immutable view the renderer reads.
// (menu/render.ts never touches state; the state machine lives here.)
function buildView(): MenuView {
  return {
    state: menuState,
    cursorIndex,
    goodsCursor,
    psiTab,
    psiFamilyCursor,
    psiTierOpen,
    psiTierCursor,
    equipCursor,
    shopRootCursor,
    shopBuyCursor,
    shopSellCursor,
    shopStore,
    shopNote,
    shopPreview: menuState === 'shop_buy' ? shopBuyPreview() : null,
    message,
    hotbar,
    drag,
    hooks,
    equipRows: equipRows(),
    equipStats: equipStats(),
    equipSlotSel,
    equipSelectCursor,
    equipSelectItems: equipSelectItems(),
    settingsCursor,
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
  if (menuState === 'settings') {
    renderCommand(ctx, view); // keep the command grid + money window behind it
    renderSettings(ctx, view);
    return;
  }
  if (menuState === 'goods') {
    renderCommand(ctx, view); // keep the command grid visible behind the Goods list
    renderGoods(ctx, view);
    return;
  }
  if (menuState === 'psi') {
    renderPsi(ctx, view); // its own top-left screen (tab bar + family list + tier popup)
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
    // Keep the originating screen behind the prompt (shop for "Equip now?",
    // command grid for the PK warning).
    if (confirmReturn === 'shop' || confirmReturn === 'shop_buy' || confirmReturn === 'shop_sell')
      renderShop(ctx, view);
    else renderCommand(ctx, view);
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

// A small pixel-drawn vertical arrow (the EB font has no caret glyph — '_' renders
// as Ω). `up` apexes at the top; widths 1/3/5 (or reversed) over 3 rows.
function drawVArrow(ctx: CanvasRenderingContext2D, cx: number, y: number, up: boolean): void {
  ctx.fillStyle = '#f0f0f0';
  for (let r = 0; r < 3; r++) {
    const w = up ? r * 2 + 1 : 5 - r * 2;
    ctx.fillRect(cx - Math.floor(w / 2), y + r, w, 1);
  }
}

// ATM/bank window — balances on top, then either the Withdraw/Deposit chooser
// (action stage) or the odometer amount entry (amount stage: Up/Down roll the
// arrowed digit, Left/Right move places). Top-left, same family as the phone.
function renderAtm(ctx: CanvasRenderingContext2D): void {
  const winX = 8;
  const winY = 8;
  const lineH = FONT_LINE_HEIGHT;
  const innerX = winX + BORDER + PADDING;
  const innerW = 96;
  const lines = 6; // Bank, Cash, gap, then 2 rows of either chooser or label+odometer
  const winH = lines * lineH + PADDING * 2 + BORDER * 2;
  drawWindow(ctx, winX, winY, innerW + PADDING * 2 + BORDER * 2, winH, MENU_STYLE);

  let y = winY + BORDER + PADDING;
  drawText(ctx, `Bank:  $${formatMoney(getBank())}`, innerX, y, FONT_ID);
  y += lineH;
  drawText(ctx, `Cash:  $${formatMoney(getMoney())}`, innerX, y, FONT_ID);
  y += lineH * 2; // blank spacer row

  if (atmStage === 'action') {
    for (let i = 0; i < ATM_ACTIONS.length; i++) {
      if (i === atmCursor) drawCursor(ctx, innerX, y + 3);
      drawText(ctx, ATM_ACTIONS[i], innerX + CURSOR_W, y, FONT_ID);
      y += lineH;
    }
    return;
  }

  // Amount stage: chosen action, then the zero-padded odometer with up/down
  // arrows flanking the selected place.
  drawText(ctx, ATM_ACTIONS[atmCursor], innerX, y, FONT_ID);
  y += lineH;
  const places = atmPlaces();
  const padded = String(atmAmount).padStart(places, '0');
  const formatted = padded.replace(/\B(?=(\d{3})+(?!\d))/g, ','); // commas for legibility
  const prefix = '$';
  drawText(ctx, prefix, innerX, y, FONT_ID);
  const digitsX = innerX + measureText(prefix, FONT_ID) + 1;
  drawText(ctx, formatted, digitsX, y, FONT_ID);
  // Find the selected digit's index in the FORMATTED string (atmDigit-th digit
  // from the right, skipping commas) so the arrows land on it, not on a comma.
  let seen = -1;
  let fi = 0;
  for (let i = formatted.length - 1; i >= 0; i--) {
    if (formatted[i] !== ',' && ++seen === atmDigit) {
      fi = i;
      break;
    }
  }
  const offset = fi === 0 ? 0 : measureText(formatted.slice(0, fi), FONT_ID) + 1;
  const cx = digitsX + offset + Math.floor(measureText(formatted[fi], FONT_ID) / 2);
  drawVArrow(ctx, cx, y - 4, true); // ▲ above — Up raises this digit
  drawVArrow(ctx, cx, y + lineH - 4, false); // ▼ below — Down lowers it
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
    psiTab = 0;
    psiFamilyCursor = 0;
    psiTierOpen = false;
    psiTierCursor = 0;
    menuState = 'psi';
    return;
  }
  if (action === 'equip') {
    equipCursor = 0;
    menuState = 'equip';
    return;
  }
  if (action === 'settings') {
    settingsCursor = 0;
    menuState = 'settings';
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
      confirmReturn = 'command'; // No / dismissed → back to the command grid
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
