/**
 * ChatManager — multiplayer chat: a typing box (bottom-left) and floating
 * speech bubbles above players that rise and fade.
 *
 * Flow: press Enter to open the input box, type, press Enter again to send.
 * The local bubble shows immediately; the message is broadcast so every other
 * client raises a bubble over the sender's sprite. Escape cancels typing.
 *
 * Uses the game's EB-style window UI (WindowRenderer) and bitmap font
 * (TextRenderer). On real SNES this maps to a windowed text box plus per-NPC
 * speech windows, so it ports cleanly.
 */

import { drawWindow } from './WindowRenderer';
import { drawText, measureText, getLineHeight, FONT_LINE_HEIGHT } from './TextRenderer';
import { getSpriteGroupMeta } from './SpriteManager';
import { hotbarLayout } from './menu/layout';
import { sendChat } from './Network';
import { Camera } from './Camera';
import { Player } from './Player';
import { RemotePlayer, SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

// Input-box font. Default is the regular EB dialogue font (0). The Mr. Saturn
// font (1) is a backlogged player-settings option — swap via setChatFont().
// Bubbles over players always use the small 8px battle font so they stay
// compact on the 256x224 screen.
let chatFontId = 0;
const BUBBLE_FONT = 4;
const LINE_H = FONT_LINE_HEIGHT; // input box line height (16px font cell)
const INSET = 5; // padding from window border to text
const BUBBLE_INSET = 4; // tighter padding inside speech bubbles
const WINDOW_STYLE = 0; // EB "Plain" dark-blue flavor

const MAX_INPUT_LEN = 80;
const BUBBLE_INNER_W = 88; // wrap width inside a speech bubble
const INPUT_MARGIN = 8; // gap from screen edges for the input box

const BUBBLE_LIFETIME = 5000; // ms a bubble stays before vanishing
const BUBBLE_FADE = 1200; // ms of fade-out at the end of life
const BUBBLE_RISE = 14; // px the bubble floats up over its life
const BUBBLE_GAP = 4; // px between sprite head and bubble bottom
const CURSOR_BLINK = 500; // ms per caret on/off phase

const DEFAULT_SPRITE_H = 24; // fallback sprite height for bubble anchor

interface Bubble {
  lines: string[];
  boxW: number;
  born: number;
  // World anchor, captured the first time the bubble is drawn. The bubble
  // belongs to the WORLD at the spot the speaker stood when they chatted — it
  // does not follow them as they walk away. Undefined until first render.
  x?: number;
  y?: number;
  spriteH?: number;
}

let typing = false;
let input = '';
let keySet: Set<string> | null = null;

let localBubble: Bubble | null = null;
const remoteBubbles = new Map<string, Bubble>();

function now(): number {
  return performance.now();
}

export function initChat(keys: Set<string>): void {
  keySet = keys;
}

/** Set the chat font (0 = regular, 1 = Mr. Saturn). Font must be loaded first. */
export function setChatFont(fontId: number): void {
  chatFontId = fontId;
}

export function isChatTyping(): boolean {
  return typing;
}

/**
 * Handle a keydown while in the playing phase. Returns true if the key was
 * consumed by chat (caller should stop further processing).
 */
export function handleChatKey(e: KeyboardEvent): boolean {
  if (!typing) {
    if (e.key === 'Enter') {
      typing = true;
      input = '';
      e.preventDefault();
      consumeActionKeys();
      return true;
    }
    return false;
  }

  // --- Typing ---
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = input.trim();
    typing = false;
    input = '';
    consumeActionKeys();
    if (text) {
      sendChat(text);
      localBubble = makeBubble(text, BUBBLE_INNER_W);
    }
    return true;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    typing = false;
    input = '';
    return true;
  }

  if (e.key === 'Backspace') {
    e.preventDefault();
    input = input.slice(0, -1);
    return true;
  }

  // Printable character (ignore modifier combos)
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (input.length < MAX_INPUT_LEN) input += e.key;
    return true;
  }

  return false;
}

/** Drop action keys from the shared input set so sending doesn't trigger a door/menu. */
function consumeActionKeys(): void {
  if (!keySet) return;
  keySet.delete('Enter');
  keySet.delete('Space');
  keySet.delete('KeyZ');
}

/** Raise a bubble over a remote player's sprite (called from the network layer). */
export function addRemoteBubble(id: string, text: string): void {
  const clean = String(text || '')
    .slice(0, 100)
    .trim();
  if (!clean) return;
  remoteBubbles.set(id, makeBubble(clean, BUBBLE_INNER_W));
}

/** Remove a player's bubble (e.g. on disconnect). */
export function removeBubble(id: string): void {
  remoteBubbles.delete(id);
}

/** Expire bubbles past their lifetime. Call once per frame. */
export function updateChatBubbles(): void {
  const t = now();
  if (localBubble && t - localBubble.born >= BUBBLE_LIFETIME) localBubble = null;
  for (const [id, b] of remoteBubbles) {
    if (t - b.born >= BUBBLE_LIFETIME) remoteBubbles.delete(id);
  }
}

export function renderChat(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  player: Player,
  remotePlayers: Map<string, RemotePlayer>
): void {
  // World-space speech bubbles, pinned to where the speaker stood when sending.
  if (localBubble) {
    anchorBubble(localBubble, player.x, player.y, player.spriteGroupId);
    drawBubble(ctx, localBubble, camera);
  }
  for (const [id, bubble] of remoteBubbles) {
    if (bubble.x === undefined) {
      // Anchor on the first frame we know where the speaker is, then it's fixed.
      const rp = remotePlayers.get(id);
      if (!rp) continue;
      anchorBubble(bubble, rp.x, rp.y, rp.spriteGroupId);
    }
    drawBubble(ctx, bubble, camera);
  }

  // Screen-space input box (only while typing).
  if (typing) drawInputBox(ctx);
}

function makeBubble(text: string, maxW: number): Bubble {
  const lines = wrapText(text, maxW, BUBBLE_FONT);
  let boxW = 0;
  for (const line of lines) boxW = Math.max(boxW, measureText(line, BUBBLE_FONT));
  return { lines, boxW: boxW + BUBBLE_INSET * 2, born: now() };
}

/** Pin a bubble to a fixed world spot the first time it's seen (idempotent). */
function anchorBubble(bubble: Bubble, worldX: number, worldY: number, spriteGroupId: number): void {
  if (bubble.x !== undefined) return;
  bubble.x = worldX;
  bubble.y = worldY;
  bubble.spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
}

function drawBubble(ctx: CanvasRenderingContext2D, bubble: Bubble, camera: Camera): void {
  if (bubble.x === undefined || bubble.y === undefined) return; // not anchored yet
  const age = now() - bubble.born;
  const rise = (age / BUBBLE_LIFETIME) * BUBBLE_RISE;
  const alpha =
    age > BUBBLE_LIFETIME - BUBBLE_FADE
      ? Math.max(0, 1 - (age - (BUBBLE_LIFETIME - BUBBLE_FADE)) / BUBBLE_FADE)
      : 1;
  if (alpha <= 0) return;

  const spriteH = bubble.spriteH ?? DEFAULT_SPRITE_H;
  const lineH = getLineHeight(BUBBLE_FONT) + 1;
  const boxW = bubble.boxW;
  const boxH = bubble.lines.length * lineH + BUBBLE_INSET * 2;

  const headTopScreenY = Math.floor(bubble.y - spriteH - camera.y);
  const centerScreenX = Math.floor(bubble.x - camera.x);

  // The bubble is a WORLD object: draw it at its true screen position (over the
  // spot the speaker stood) and let it scroll with the map. No edge-clamping —
  // that would glue it to the view. Cull only when it's fully off-screen.
  const boxLeft = centerScreenX - Math.floor(boxW / 2);
  const boxTop = Math.floor(headTopScreenY - BUBBLE_GAP - rise - boxH);
  if (boxLeft + boxW < 0 || boxLeft > SCREEN_WIDTH || boxTop + boxH < 0 || boxTop > SCREEN_HEIGHT)
    return;

  ctx.save();
  ctx.globalAlpha = alpha;
  drawWindow(ctx, boxLeft, boxTop, boxW, boxH, WINDOW_STYLE);
  for (let i = 0; i < bubble.lines.length; i++) {
    drawText(
      ctx,
      bubble.lines[i],
      boxLeft + BUBBLE_INSET,
      boxTop + BUBBLE_INSET + i * lineH,
      BUBBLE_FONT
    );
  }
  ctx.restore();
}

function drawInputBox(ctx: CanvasRenderingContext2D): void {
  // The box lives in the bottom-left gap and fills the width between the screen's
  // left edge and hotbar slot 1, so the hotbar stays visible while you type. The
  // box bottom is flush to the screen bottom (level with the hotbar) and it grows
  // UPWARD as the message wraps to more lines.
  const slot1X = hotbarLayout()[0].x; // left edge of the leftmost hotbar slot
  const HOTBAR_GAP = 3; // breathing room so the box never touches slot 1
  const boxLeft = INPUT_MARGIN;
  const boxW = Math.max(40, slot1X - HOTBAR_GAP - boxLeft);
  const innerW = boxW - INSET * 2;

  const lines = wrapText(input, innerW, chatFontId);
  const boxH = lines.length * LINE_H + INSET * 2;
  const boxTop = SCREEN_HEIGHT - boxH;

  drawWindow(ctx, boxLeft, boxTop, boxW, boxH, WINDOW_STYLE);

  const textX = boxLeft + INSET;
  for (let i = 0; i < lines.length; i++) {
    drawText(ctx, lines[i], textX, boxTop + INSET + i * LINE_H, chatFontId);
  }

  // Blinking caret after the last line.
  if (Math.floor(now() / CURSOR_BLINK) % 2 === 0) {
    const lastLine = lines[lines.length - 1];
    const caretX = textX + measureText(lastLine, chatFontId) + 1;
    const caretY = boxTop + INSET + (lines.length - 1) * LINE_H + 1;
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(caretX, caretY, 1, LINE_H - 4);
  }
}

/** Word-wrap text to a pixel width, hard-breaking words longer than the line. */
export function wrapText(text: string, maxW: number, fontId: number): string[] {
  const lines: string[] = [];
  let cur = '';

  for (const word of text.split(' ')) {
    const test = cur ? `${cur} ${word}` : word;
    if (measureText(test, fontId) <= maxW) {
      cur = test;
      continue;
    }
    if (cur) lines.push(cur);

    if (measureText(word, fontId) > maxW) {
      // Break an over-long word character by character.
      let chunk = '';
      for (const ch of word) {
        if (measureText(chunk + ch, fontId) > maxW && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      cur = chunk;
    } else {
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
