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
  pp: number;
  ppMax: number;
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
  drawText(ctx, `${stats.pp} / ${stats.ppMax}`, valX, y, FONT_ID);
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
