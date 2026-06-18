/**
 * XpBar — a slim experience bar pinned to the top-middle of the screen during
 * normal field play. Shows progress through the CURRENT level (fill) plus the
 * level number and the EXP remaining until the next level.
 *
 * Stats come from StatusModal.getStatus(), which the server keeps live
 * (onPlayerStats → setStatus). `exp` is the player's total EXP; `expToNext` is
 * the EXP still owed to reach the next level. To draw progress WITHIN the level
 * we need the level's full span — that's expCost(level), mirrored from the
 * server (gameHost.js): a geometric ramp 30, 45, 67, 101, … . fraction =
 * (span - remaining) / span.
 *
 * Drawn in logical screen coords (256x224) like the rest of the HUD; uses the
 * small native font (the 16px EB bitmap font is too tall for a thin bar).
 */
import { SCREEN_WIDTH } from '../types';
import { getStatus } from './StatusModal';

// EXP to go from `level` to `level+1` — must match gameHost.js `expCost`.
const expCost = (level: number): number => Math.floor(30 * Math.pow(1.5, level - 1));

const BAR_W = 120;
const BAR_H = 6;
const TOP = 4; // margin from the top edge

export function renderXpBar(ctx: CanvasRenderingContext2D): void {
  const st = getStatus();
  const span = expCost(st.level);
  // Earned within this level = full span minus what's still owed. Clamp so odd
  // data (or a level boundary mid-frame) can't push the fill past the ends.
  const frac = span > 0 ? Math.max(0, Math.min(1, (span - st.expToNext) / span)) : 0;

  const x = Math.round((SCREEN_WIDTH - BAR_W) / 2);
  const y = TOP;

  // Track (dark, like the hotbar slots) + 1px border.
  ctx.fillStyle = 'rgba(8,12,40,0.85)';
  ctx.fillRect(x, y, BAR_W, BAR_H);
  // Fill — gold, inset 1px so the border still reads at full/empty.
  const fillW = Math.round((BAR_W - 2) * frac);
  if (fillW > 0) {
    ctx.fillStyle = '#f5c542';
    ctx.fillRect(x + 1, y + 1, fillW, BAR_H - 2);
  }
  ctx.strokeStyle = '#8898c8';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BAR_W - 1, BAR_H - 1);

  // Labels: "Lv N" left of the bar, "{remaining} to next" right of it.
  ctx.save();
  ctx.font = '6px monospace';
  ctx.textBaseline = 'middle';
  const midY = y + BAR_H / 2 + 0.5;

  ctx.textAlign = 'right';
  drawLabel(ctx, `Lv${st.level}`, x - 3, midY);

  ctx.textAlign = 'left';
  drawLabel(ctx, `${st.expToNext} to next`, x + BAR_W + 3, midY);
  ctx.restore();
}

// 1px shadow under white so the text reads over any background.
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.fillStyle = '#000';
  ctx.fillText(text, x + 0.5, y + 0.5);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y);
}
