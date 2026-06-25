/**
 * XpBar — a slim experience bar pinned to the top-middle of the screen during
 * normal field play. A NARROW gold progress bar with the level on its left and
 * the EXP remaining to the next level on its right. Both labels use the EB pixel
 * font at half scale (8px, like the nameplates / buff HUD) on a dark strip the
 * same height as the bar, so they read over the world AND match the game's UI
 * font instead of a browser monospace.
 *
 * Stats come from StatusModal.getStatus(), which the server keeps live
 * (onPlayerStats → setStatus). `exp` is the player's total EXP; `expToNext` is
 * the EXP still owed to reach the next level. To draw progress WITHIN the level
 * we need the level's full span — that's expCost(level), mirrored from the
 * server (gameHost.js): a geometric ramp 30, 45, 67, 101, … . fraction =
 * (span - remaining) / span.
 *
 * Drawn in logical screen coords (256x224) like the rest of the HUD.
 */
import { SCREEN_WIDTH } from '../types';
import { getStatus } from './StatusModal';
import { drawText, measureText } from './TextRenderer';

// EXP to go from `level` to `level+1` — must match gameHost.js `expCost`.
const expCost = (level: number): number => Math.floor(30 * Math.pow(1.5, level - 1));

const BAR_W = 80; // narrow (was 120) so the top corners (money / mute) have room
const BAR_H = 6;
const TOP = 4; // margin from the top edge
const LABEL_SCALE = 0.5; // EB 16px font drawn at 8px to match the nameplates
const LABEL_INK_MID = 7.5; // vertical centre of the inked rows (3..12) in the cell
const GAP = 2; // px between the bar and each label strip

// Bottom edge of the bar in logical screen coords — so other top-center HUD
// elements (e.g. the event timer) can stack right beneath it.
export const XP_BAR_BOTTOM = TOP + BAR_H;

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

  // Level on the left, EXP-to-next on the right.
  label(ctx, `Lv${st.level}`, x - GAP, y, 'right');
  label(ctx, `${st.expToNext}`, x + BAR_W + GAP, y, 'left');
}

/** Draw a half-scale EB-font label vertically centred on the bar, anchored at
 *  the bar edge `ax`, on a dark strip the same height as the bar so it reads
 *  over the world. */
function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  ax: number,
  y: number,
  align: 'left' | 'right'
): void {
  const w = Math.ceil(measureText(text, 0) * LABEL_SCALE);
  const lx = align === 'right' ? ax - w : ax;
  // Dark strip behind the text (matches the bar track) for contrast.
  ctx.fillStyle = 'rgba(8,12,40,0.85)';
  ctx.fillRect(lx - 1, y, w + 2, BAR_H);
  // Text at half scale, centred on the bar's vertical midline. drawText places
  // the cell top-left at the given (scaled) coords; offset up by the ink centre
  // so the visible glyphs land on the bar line.
  const cy = y + BAR_H / 2;
  ctx.save();
  ctx.scale(LABEL_SCALE, LABEL_SCALE);
  drawText(
    ctx,
    text,
    Math.round(lx / LABEL_SCALE),
    Math.round(cy / LABEL_SCALE - LABEL_INK_MID),
    0
  );
  ctx.restore();
}
