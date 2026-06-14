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

import { drawWindow }                              from './WindowRenderer';
import { drawText, measureText, FONT_LINE_HEIGHT } from './TextRenderer';
import { SCREEN_WIDTH }                            from '../types';

const STYLE   = 0;   // EB "Plain" dark-blue flavor, matching the command window
const BORDER  = 6;
const PADDING = 6;
const FONT_ID = 0;

export interface PlayerStats {
  name:      string;
  level:     number;
  hp:        number;
  hpMax:     number;
  pp:        number;
  ppMax:     number;
  exp:       number;
  expToNext: number;
  offense:   number;
  defense:   number;
  speed:     number;
  guts:      number;
  vitality:  number;
  iq:        number;
  luck:      number;
  condition: string;
}

// Level-1 defaults until a real stat/leveling system exists.
const stats: PlayerStats = {
  name:      'Player',
  level:     1,
  hp:        60,   // mirrors the server's PLAYER_MAX_HP; live HP arrives via setStatus
  hpMax:     60,
  pp:        7,
  ppMax:     7,
  exp:       0,
  expToNext: 30,
  offense:   7,
  defense:   3,
  speed:     8,
  guts:      7,
  vitality:  6,
  iq:        9,
  luck:      9,
  condition: 'Normal',
};

/** Feed in real values as systems come online; partial updates are merged. */
export function setStatus(partial: Partial<PlayerStats>): void {
  Object.assign(stats, partial);
}

export function getStatus(): Readonly<PlayerStats> {
  return stats;
}

/** Draw "Label" left-aligned and "value" right-aligned within [x, x+w]. */
function drawRow(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  x: number,
  y: number,
  w: number,
): void {
  drawText(ctx, label, x, y, FONT_ID);
  drawText(ctx, value, x + w - measureText(value, FONT_ID), y, FONT_ID);
}

export function renderStatus(ctx: CanvasRenderingContext2D): void {
  const winX = 8;
  const winY = 8;
  const winW = SCREEN_WIDTH - 16;
  const winH = 208;
  drawWindow(ctx, winX, winY, winW, winH, STYLE);

  const x  = winX + BORDER + PADDING;
  const w  = winW - (BORDER + PADDING) * 2;
  const lh = FONT_LINE_HEIGHT;
  let y    = winY + BORDER + PADDING;

  // Header: name on the left, level on the right.
  drawRow(ctx, stats.name, `LV ${stats.level}`, x, y, w);
  y += lh + 4;

  // Vitals.
  drawRow(ctx, 'HP', `${stats.hp} / ${stats.hpMax}`, x, y, w); y += lh;
  drawRow(ctx, 'PP', `${stats.pp} / ${stats.ppMax}`, x, y, w); y += lh + 2;

  // EXP / next level.
  drawRow(ctx, 'EXP',          `${stats.exp}`,       x, y, w); y += lh;
  drawRow(ctx, 'To next level', `${stats.expToNext}`, x, y, w); y += lh + 4;

  // Stats, in EB's order — two columns so all seven fit without overflowing.
  const left: [string, number][] = [
    ['Offense', stats.offense],
    ['Defense', stats.defense],
    ['Speed',   stats.speed],
    ['Guts',    stats.guts],
  ];
  const right: [string, number][] = [
    ['Vitality', stats.vitality],
    ['IQ',       stats.iq],
    ['Luck',     stats.luck],
  ];
  const gap  = 12;
  const colW = (w - gap) / 2;
  const rightX = x + colW + gap;
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    if (left[i])  drawRow(ctx, left[i][0],  `${left[i][1]}`,  x,      y, colW);
    if (right[i]) drawRow(ctx, right[i][0], `${right[i][1]}`, rightX, y, colW);
    y += lh;
  }
  y += 2;

  // Condition (status ailment) line.
  drawRow(ctx, 'Condition', stats.condition, x, y, w);
}
