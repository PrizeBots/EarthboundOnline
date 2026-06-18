/**
 * DialogueManager — the EB-style NPC talk/check text window.
 *
 * openDialogue() takes the decoded pages from npc_text.json (each page is
 * what the game showed between button prompts; '\n' separates the original
 * `@` speech lines). Pages are word-wrapped and re-split into fixed
 * 3-line boxes, revealed with a typewriter effect. The action keys
 * (Q/Space/Enter/Z) OR a left mouse click skip the reveal, then advance boxes,
 * then close.
 *
 * On real SNES this is just the standard dialogue window — text prints via
 * the same fixed-width font tiles, so it ports cleanly.
 */

import { drawWindow } from './WindowRenderer';
import { drawText } from './TextRenderer';
import { wrapText } from './ChatManager';
import { consumePointerClick } from './Input';
import { getStatus } from './StatusModal';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

const FONT = 0; // regular EB dialogue font
const LINE_H = 16; // font 0 cell height
const LINES_PER_BOX = 3;
const INSET = 6;
const BOX_W = 240;
const BOX_LEFT = (SCREEN_WIDTH - BOX_W) / 2;
const INNER_W = BOX_W - INSET * 2;
const BOX_H = LINES_PER_BOX * LINE_H + INSET * 2;
const BOX_TOP = SCREEN_HEIGHT - 8 - BOX_H;
const WINDOW_STYLE = 0;
const CHARS_PER_FRAME = 2; // typewriter speed
const PROMPT_BLINK = 400; // ms per ▼ blink phase

let keySet: Set<string> | null = null;
let boxes: string[][] = []; // wrapped lines, LINES_PER_BOX per box
let boxIndex = 0;
let revealed = 0; // characters shown of the current box
let open = false;

export function initDialogue(keys: Set<string>): void {
  keySet = keys;
}

export function isDialogueOpen(): boolean {
  return open;
}

/**
 * Expand dialogue tokens before display. `$name` → the local player's name
 * (the EB equivalent of the ROM's {stat(8)} lead-member code). Case-sensitive,
 * word-boundary-safe so "$names" stays literal. Add more tokens here as needed.
 */
function substituteVars(pages: string[]): string[] {
  const playerName = getStatus().name || 'you';
  return pages.map((p) => p.replace(/\$name\b/g, playerName));
}

export function openDialogue(pages: string[]): void {
  boxes = [];
  for (const page of substituteVars(pages)) {
    const lines: string[] = [];
    for (const para of page.split('\n')) lines.push(...wrapText(para, INNER_W, FONT));
    for (let i = 0; i < lines.length; i += LINES_PER_BOX) {
      boxes.push(lines.slice(i, i + LINES_PER_BOX));
    }
  }
  boxIndex = 0;
  revealed = 0;
  open = boxes.length > 0;
}

/** Advance typewriter/boxes. Call once per frame while open. */
export function updateDialogue(): void {
  if (!open) return;
  const total = boxes[boxIndex].reduce((n, line) => n + line.length, 0);
  if (revealed < total) revealed = Math.min(total, revealed + CHARS_PER_FRAME);

  // Advance on an action key OR a left mouse click. Evaluate BOTH (no
  // short-circuit) so a pending click is always consumed while a box is open —
  // that also clears the attack latch (see Input.consumePointerClick), so the
  // click that dismisses the last box never leaks through as a sword swing.
  const keyAdvance = actionPressed();
  const clickAdvance = consumePointerClick() !== null;
  if (keyAdvance || clickAdvance) {
    if (revealed < total) {
      revealed = total;
    } else if (boxIndex + 1 < boxes.length) {
      boxIndex++;
      revealed = 0;
    } else {
      open = false;
    }
  }
}

/** Consume an action-key press (also eaten so doors/menu don't fire). */
function actionPressed(): boolean {
  if (!keySet) return false;
  let pressed = false;
  for (const code of ['KeyE', 'Space', 'Enter', 'KeyZ']) {
    if (keySet.has(code)) {
      keySet.delete(code);
      pressed = true;
    }
  }
  return pressed;
}

export function renderDialogue(ctx: CanvasRenderingContext2D): void {
  if (!open) return;

  drawWindow(ctx, BOX_LEFT, BOX_TOP, BOX_W, BOX_H, WINDOW_STYLE);

  const lines = boxes[boxIndex];
  let budget = revealed;
  let done = true;
  for (let i = 0; i < lines.length && budget > 0; i++) {
    const text = lines[i].slice(0, budget);
    budget -= lines[i].length;
    if (text.length < lines[i].length) done = false;
    drawText(ctx, text, BOX_LEFT + INSET, BOX_TOP + INSET + i * LINE_H, FONT);
  }

  // Blinking ▼ prompt once the box is fully revealed and more is waiting.
  const more = boxIndex + 1 < boxes.length;
  if (done && more && Math.floor(performance.now() / PROMPT_BLINK) % 2 === 0) {
    const cx = BOX_LEFT + BOX_W - 10;
    const cy = BOX_TOP + BOX_H - 8;
    ctx.fillStyle = '#f0f0f0';
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy);
    ctx.lineTo(cx + 3, cy);
    ctx.lineTo(cx, cy + 4);
    ctx.closePath();
    ctx.fill();
  }
}
