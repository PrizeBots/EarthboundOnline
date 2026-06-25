/**
 * StatusModal — EarthBound's "Status" screen.
 *
 * Opened from the command window's Status command (see MenuManager). Draws the
 * classic EB status window: name + level header, HP/PP, EXP, and the seven
 * stats (Offense, Defense, Speed, Guts, Vitality, IQ, Luck), plus the current
 * condition line.
 *
 * There is no stats/leveling system yet, so the numbers come from a single
 * PlayerStats object with sensible Level-1 defaults. setStatus() lets the rest
 * of the engine feed in real values once that system exists — the layout
 * doesn't change. On SNES this is the same BG3 text window as the menu, so it
 * ports directly.
 */

import { drawWindow, windowFillColor } from './WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from './TextRenderer';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

const STYLE = 0; // EB "Plain" dark-blue flavor, matching the command window
const BORDER = 6;
const PADDING = 6;
const FONT_ID = 0;

export interface PlayerStats {
  name: string;
  level: number;
  hp: number;
  hpMax: number;
  pp: number; // CLIENT-PREDICTED between server syncs (see tickPp)
  ppMax: number;
  ppRegen: number; // points/sec, from Mental+Spirit; drives the local PP prediction
  stamina: number; // CLIENT-PREDICTED between server syncs (see tickStamina)
  staminaMax: number;
  staminaRegen: number; // points/sec, from stats; drives the local prediction
  exp: number;
  expToNext: number;
  offense: number;
  defense: number;
  speed: number;
  guts: number;
  vitality: number;
  iq: number;
  luck: number;
  condition: string;
}

// Level-1 defaults until a real stat/leveling system exists.
const stats: PlayerStats = {
  name: 'Player',
  level: 1,
  hp: 60, // mirrors the server's PLAYER_MAX_HP; live HP arrives via setStatus
  hpMax: 60,
  pp: 7,
  ppMax: 7,
  ppRegen: 0.5,
  stamina: 45,
  staminaMax: 45,
  staminaRegen: 7.5,
  exp: 0,
  expToNext: 30,
  offense: 7,
  defense: 3,
  speed: 8,
  guts: 7,
  vitality: 6,
  iq: 9,
  luck: 9,
  condition: 'Normal',
};

/** Feed in real values as systems come online; partial updates are merged. */
export function setStatus(partial: Partial<PlayerStats>): void {
  Object.assign(stats, partial);
}

export function getStatus(): Readonly<PlayerStats> {
  return stats;
}

// --- Local stamina prediction --------------------------------------------
// Stamina is server-authoritative, but it changes every frame (run drain /
// regen), so the client predicts it for a smooth yellow bar and the server
// corrects via throttled `player_stamina` syncs (reconcileStamina). KEEP the
// drain/cost constants in sync with server/gameHost.js + Player.ts.
export const STAMINA_ATTACK_COST = 8;
export const RUN_DRAIN_PER_SEC = 18;
const RUN_RECOVER_FRAC = 0.2; // winded → can run again once recharged to this (KEEP IN SYNC)

// "Winded" latch (mirror server/gameHost.js): hitting 0 stamina while running
// locks running OUT until stamina recharges to RUN_RECOVER_FRAC. Without it,
// per-frame regen tops stamina just above 0 and you'd sprint forever.
let winded = false;

/** Per-frame regen toward max (dtMs since last frame). Call from the game loop. */
export function tickStamina(dtMs: number): void {
  if (stats.staminaMax <= 0) return;
  if (stats.stamina < stats.staminaMax) {
    stats.stamina = Math.min(stats.staminaMax, stats.stamina + stats.staminaRegen * (dtMs / 1000));
  }
  if (winded && stats.stamina >= stats.staminaMax * RUN_RECOVER_FRAC) winded = false;
}

/** Spend stamina locally (predicted). Returns false if there isn't enough. */
export function spendStamina(amount: number): boolean {
  if (stats.stamina < amount) return false;
  stats.stamina = Math.max(0, stats.stamina - amount);
  return true;
}

/** Predicted drain while running; clamps at 0 and latches "winded" on empty. */
export function drainStamina(amount: number): void {
  stats.stamina = Math.max(0, stats.stamina - amount);
  if (stats.stamina <= 0) winded = true;
}

/** True if the player has enough stamina to swing (predicted gate, like PP). */
export function canAttackStamina(): boolean {
  return stats.stamina >= STAMINA_ATTACK_COST;
}

/** True if you can fuel a run: stamina left AND not winded (catching your breath). */
export function canRun(): boolean {
  return stats.stamina > 0 && !winded;
}

/**
 * Ease the predicted value toward the authoritative server value (reconcile) and
 * adopt the server's winded latch so client + server agree on when running unlocks.
 */
export function reconcileStamina(serverVal: number, max: number, serverWinded: boolean): void {
  if (max > 0) stats.staminaMax = max;
  // Snap if we're badly out of sync, otherwise ease so a sync mid-drain doesn't jolt.
  const diff = serverVal - stats.stamina;
  stats.stamina = Math.abs(diff) > 8 ? serverVal : stats.stamina + diff * 0.5;
  stats.stamina = Math.max(0, Math.min(stats.staminaMax, stats.stamina));
  winded = serverWinded;
}

// --- Local PP prediction (mirror of stamina) -------------------------------
// PP regenerates server-side (Mental+Spirit), throttled briefly after a cast or a
// hit. Like stamina it'd otherwise only jump on server pushes, so the client
// predicts it for a smooth real-time bar (tickPp) and the server corrects via
// throttled `player_pp` syncs (reconcilePp). KEEP the throttle constants in sync
// with server/gameHost.js (PP_COMBAT_WINDOW_MS / PP_COMBAT_FRAC).
const PP_COMBAT_WINDOW_MS = 4000;
const PP_COMBAT_FRAC = 0.35;
let ppCombatUntil = 0;

/** Mark recent combat (a cast or a hit) so regen slows for a few seconds, matching
 *  the server — keeps the predicted bar from over-filling then snapping back. */
export function notePpCombat(): void {
  ppCombatUntil = Date.now() + PP_COMBAT_WINDOW_MS;
}

/** Per-frame PP regen toward max (dtMs since last frame). Call from the game loop. */
export function tickPp(dtMs: number): void {
  if (stats.ppMax <= 0 || stats.pp >= stats.ppMax) return;
  const rate = stats.ppRegen * (Date.now() < ppCombatUntil ? PP_COMBAT_FRAC : 1);
  stats.pp = Math.min(stats.ppMax, stats.pp + rate * (dtMs / 1000));
}

/** Spend PP locally (predicted) on a cast, so the bar drops immediately. */
export function spendPp(amount: number): void {
  stats.pp = Math.max(0, stats.pp - amount);
}

/** Ease the predicted PP toward the authoritative server value (reconcile), like
 *  stamina — snap if badly out of sync, else ease so a sync mid-regen doesn't jolt. */
export function reconcilePp(serverVal: number, max: number): void {
  if (max > 0) stats.ppMax = max;
  const diff = serverVal - stats.pp;
  stats.pp = Math.abs(diff) > 4 ? serverVal : stats.pp + diff * 0.5;
  stats.pp = Math.max(0, Math.min(stats.ppMax, stats.pp));
}

/**
 * Render the status screen, laid out like EarthBound's:
 *   - left column: name, level, condition, then full-label vitals + experience
 *   - right column: the seven stats stacked top-down, values flush right
 *   - footer: the game's iconic PSI-info prompt, centered
 * The window is centered rather than full-screen, matching the real game's box.
 */
export function renderStatus(ctx: CanvasRenderingContext2D): void {
  const winW = 248;
  const winH = 168;
  const winX = (SCREEN_WIDTH - winW) >> 1;
  const winY = (SCREEN_HEIGHT - winH) >> 1;
  drawWindow(ctx, winX, winY, winW, winH, STYLE);

  const x = winX + BORDER + PADDING;
  const top = winY + BORDER + PADDING + 6;
  const innerRight = winX + winW - (BORDER + PADDING);
  const lh = FONT_LINE_HEIGHT;

  // Name plate on the top border (like the game) — notch the border with the
  // window fill, then draw the name sitting on the top edge. The plate stays
  // within the window: its top is the window's top, never above it.
  const nameX = winX + 14;
  const nameW = measureText(stats.name, FONT_ID);
  ctx.fillStyle = windowFillColor(STYLE);
  ctx.fillRect(nameX - 4, winY, nameW + 8, 8);
  drawText(ctx, stats.name, nameX, winY - 2, FONT_ID);

  // --- Right column: the seven stats, in EB order, values flush to the edge. ---
  const statRows: [string, number][] = [
    ['Offense', stats.offense],
    ['Defense', stats.defense],
    ['Speed', stats.speed],
    ['Guts', stats.guts],
    ['Vitality', stats.vitality],
    ['IQ', stats.iq],
    ['Luck', stats.luck],
  ];
  let statLabelW = 0;
  for (const [label] of statRows) {
    statLabelW = Math.max(statLabelW, measureText(`${label}:`, FONT_ID));
  }
  const valColW = measureText('000', FONT_ID); // reserve up to 3 digits
  const statLabelX = innerRight - statLabelW - 6 - valColW;
  let sy = top;
  for (const [label, value] of statRows) {
    drawText(ctx, `${label}:`, statLabelX, sy, FONT_ID);
    const v = `${value}`;
    drawText(ctx, v, innerRight - measureText(v, FONT_ID), sy, FONT_ID);
    sy += lh;
  }

  // --- Left column: level, condition, vitals, experience (name is on the border). ---
  let y = top;
  drawText(ctx, `Level: ${stats.level}`, x, y, FONT_ID);
  y += lh; // level
  drawText(ctx, stats.condition, x, y, FONT_ID);
  y += lh + 8; // condition

  // Vitals + EXP — numbers align in a sub-column after the longest label.
  const valX = x + measureText('Experience Points: ', FONT_ID);
  drawText(ctx, 'Hit Points:', x, y, FONT_ID);
  drawText(ctx, `${stats.hp} / ${stats.hpMax}`, valX, y, FONT_ID);
  y += lh;
  drawText(ctx, 'Psychic Points:', x, y, FONT_ID);
  // pp is a client-PREDICTED float (see tickPp) — floor it for the integer readout.
  drawText(ctx, `${Math.floor(stats.pp)} / ${stats.ppMax}`, valX, y, FONT_ID);
  y += lh + 2;
  drawText(ctx, 'Experience Points:', x, y, FONT_ID);
  drawText(ctx, `${stats.exp}`, valX, y, FONT_ID);
  y += lh;
  drawText(ctx, `${stats.expToNext} Exp. for next level.`, x, y, FONT_ID);
  y += lh + 8;

  // Footer: the game's iconic centered prompt.
  const footer = 'Press the -A- Button for PSI info.';
  drawText(ctx, footer, winX + (winW - measureText(footer, FONT_ID)) / 2, y, FONT_ID);
}
