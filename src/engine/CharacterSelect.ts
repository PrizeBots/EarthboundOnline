import { loadImage, loadJSON } from './AssetLoader';
import { playEventSfx } from './SfxEvents';
import { sheetHasDiagonals } from './SpriteManager';
import { getSpriteName } from './SpriteNames';
import { SpriteGroupMeta, Direction, SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

const COLS = 9;
const CELL_W = 24;
const CELL_H = 32;
const PADDING = 2;
// Center the grid so it always fits the 256px screen (10 cols at 24px would
// run off the right edge). Derived so it stays correct if the sizes change.
const GRID_X = Math.round((SCREEN_WIDTH - (COLS * CELL_W + (COLS - 1) * PADDING)) / 2);
const GRID_Y = 32;
const SCALE = 2;

// Direction layout from SpriteManager — south-facing frame 0 is row 1, col 0
const SOUTH_ROW = 1;
const SOUTH_COL = 0;

// Dev toggle to the real TITLE/AUTH start screen (accounts; see ARCHITECTURE.md). Char select
// stays the boot screen in dev; this button opens the account overlay on top.
const ACCT_BTN = { x: SCREEN_WIDTH - 62, y: 2, w: 60, h: 11, label: 'ACCOUNTS' };

// Direction cycle for preview animation. `fallback` is the side-view cell a
// 4-direction sheet shows instead of the (empty) diagonal cell — the same
// NE,SE<-E / SW,NW<-W rule the in-game renderer uses.
const DIR_ORDER: { row: number; col: number; fallback?: { row: number; col: number } }[] = [
  { row: 1, col: 0 }, // S
  { row: 1, col: 2 }, // W
  { row: 0, col: 0 }, // N
  { row: 0, col: 2 }, // E
  { row: 3, col: 0, fallback: { row: 1, col: 2 } }, // SW <- W
  { row: 3, col: 2, fallback: { row: 1, col: 2 } }, // NW <- W
  { row: 2, col: 0, fallback: { row: 0, col: 2 } }, // NE <- E
  { row: 2, col: 2, fallback: { row: 0, col: 2 } }, // SE <- E
];

interface CharEntry {
  meta: SpriteGroupMeta;
  img: HTMLImageElement;
  hasDiag: boolean;
}

let characters: CharEntry[] = [];
let selectedIndex = 0;
let animFrame = 0;
let animTimer = 0;
let dirIndex = 0;
let dirTimer = 0;
let scrollY = 0;

export async function loadCharacterSelect(): Promise<void> {
  // characters.json is the curated roster (tools/build_char_select.py):
  // 16x24 walkable characters only — no climbing/angel pose sheets of the
  // playable cast, nothing with fewer than 4 distinct directions.
  const [allMeta, roster] = await Promise.all([
    loadJSON<SpriteGroupMeta[]>('/assets/sprites/metadata.json'),
    loadJSON<number[]>('/assets/sprites/characters.json'),
  ]);
  const metaById = new Map(allMeta.map((m) => [m.id, m]));

  const entries: CharEntry[] = [];
  for (const id of roster) {
    const meta = metaById.get(id);
    if (!meta) continue;
    try {
      const img = await loadImage(`/assets/sprites/${id}.png`);
      entries.push({ meta, img, hasDiag: sheetHasDiagonals(img, meta.width, meta.height) });
    } catch {
      // Skip missing sprites
    }
  }
  characters = entries;
}

export function getSelectedSpriteGroupId(): number {
  return characters[selectedIndex]?.meta.id ?? 1;
}

export function updateCharacterSelect(): boolean {
  // Animation timer
  animTimer++;
  if (animTimer >= 10) {
    animTimer = 0;
    animFrame = animFrame === 0 ? 1 : 0;
  }

  // Direction cycle for selected character preview
  dirTimer++;
  if (dirTimer >= 30) {
    dirTimer = 0;
    dirIndex = (dirIndex + 1) % DIR_ORDER.length;
  }

  return false; // not confirmed yet — Game checks for Enter key
}

export function handleCharSelectInput(key: string): 'confirm' | null {
  const totalCells = characters.length;
  const rows = Math.ceil(totalCells / COLS);
  const currentRow = Math.floor(selectedIndex / COLS);
  const currentCol = selectedIndex % COLS;

  const prevIndex = selectedIndex;
  let axis: 'horizontal' | 'vertical' | null = null;
  switch (key) {
    case 'ArrowRight':
    case 'd':
      selectedIndex = Math.min(selectedIndex + 1, totalCells - 1);
      axis = 'horizontal';
      break;
    case 'ArrowLeft':
    case 'a':
      selectedIndex = Math.max(selectedIndex - 1, 0);
      axis = 'horizontal';
      break;
    case 'ArrowDown':
    case 's':
      if (currentRow < rows - 1) {
        const next = (currentRow + 1) * COLS + currentCol;
        selectedIndex = Math.min(next, totalCells - 1);
      }
      axis = 'vertical';
      break;
    case 'ArrowUp':
    case 'w':
      if (currentRow > 0) {
        selectedIndex = (currentRow - 1) * COLS + currentCol;
      }
      axis = 'vertical';
      break;
    case 'Enter':
    case ' ':
    case 'e': // E — the action/confirm button (matches the in-game E binding)
    case 'E':
      return 'confirm';
  }

  // Blip only when the cursor actually moved (not at a grid edge).
  if (axis && selectedIndex !== prevIndex) {
    playEventSfx(axis === 'horizontal' ? 'cursor-horizontal' : 'cursor-vertical');
  }

  // Scroll to keep selection visible
  const selRow = Math.floor(selectedIndex / COLS);
  const selScreenY = GRID_Y + selRow * (CELL_H + PADDING) - scrollY;
  if (selScreenY < GRID_Y) {
    scrollY = selRow * (CELL_H + PADDING);
  } else if (selScreenY + CELL_H > SCREEN_HEIGHT - 40) {
    scrollY = selRow * (CELL_H + PADDING) - (SCREEN_HEIGHT - GRID_Y - CELL_H - 40);
  }

  return null;
}

/**
 * Click handling for the grid. A single click on a character selects AND
 * confirms it (one click to pick your character and start — same as pressing E
 * / Enter on it). Coords are game-space pixels (256x224), matching the draw
 * layout. Returns 'confirm' to start the game, else null.
 */
export function handleCharSelectClick(gx: number, gy: number): 'confirm' | 'startscreen' | null {
  // ACCOUNTS button (top-right) — checked first, it sits above the grid band.
  if (
    gx >= ACCT_BTN.x &&
    gx < ACCT_BTN.x + ACCT_BTN.w &&
    gy >= ACCT_BTN.y &&
    gy < ACCT_BTN.y + ACCT_BTN.h
  ) {
    return 'startscreen';
  }
  // Only the clipped grid band is clickable (mirror drawCharacterSelect's clip).
  if (gy < GRID_Y - 2 || gy > SCREEN_HEIGHT - 38) return null;
  for (let i = 0; i < characters.length; i++) {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const x = GRID_X + col * (CELL_W + PADDING);
    const y = GRID_Y + row * (CELL_H + PADDING) - scrollY;
    if (gx >= x && gx < x + CELL_W && gy >= y && gy < y + CELL_H) {
      selectedIndex = i;
      return 'confirm'; // pick-and-start in one click
    }
  }
  return null;
}

export function drawCharacterSelect(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  // Title
  ctx.fillStyle = '#fff';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SELECT YOUR CHARACTER', SCREEN_WIDTH / 2, 14);
  // Auto-shrink the hint so it never runs off the 256px screen (the wording
  // gets tweaked; this keeps it from being cut off regardless of length).
  const hint = 'Arrow keys to browse · E / Enter to select · or click a character';
  let hintSize = 8;
  ctx.font = `${hintSize}px monospace`;
  while (hintSize > 5 && ctx.measureText(hint).width > SCREEN_WIDTH - 8) {
    ctx.font = `${--hintSize}px monospace`;
  }
  ctx.fillStyle = '#888';
  ctx.fillText(hint, SCREEN_WIDTH / 2, 24);
  ctx.font = '8px monospace';

  // ACCOUNTS button (top-right) — opens the TITLE/AUTH start screen overlay.
  ctx.fillStyle = '#2b48d6';
  ctx.fillRect(ACCT_BTN.x, ACCT_BTN.y, ACCT_BTN.w, ACCT_BTN.h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(ACCT_BTN.x + 0.5, ACCT_BTN.y + 0.5, ACCT_BTN.w - 1, ACCT_BTN.h - 1);
  ctx.fillStyle = '#fff';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(ACCT_BTN.label, ACCT_BTN.x + ACCT_BTN.w / 2, ACCT_BTN.y + 8);
  ctx.textAlign = 'left';
  ctx.font = '8px monospace';

  // Grid of south-facing sprites
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, GRID_Y - 2, SCREEN_WIDTH, SCREEN_HEIGHT - GRID_Y - 38);
  ctx.clip();

  for (let i = 0; i < characters.length; i++) {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const x = GRID_X + col * (CELL_W + PADDING);
    const y = GRID_Y + row * (CELL_H + PADDING) - scrollY;

    if (y + CELL_H < GRID_Y - 2 || y > SCREEN_HEIGHT - 38) continue;

    // Highlight selected
    if (i === selectedIndex) {
      ctx.strokeStyle = '#ff0';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1, y - 1, CELL_W + 2, CELL_H + 2);
    }

    const { meta, img } = characters[i];

    // Draw south-facing frame 0
    const srcX = SOUTH_COL * meta.width;
    const srcY = SOUTH_ROW * meta.height;
    const drawX = x + (CELL_W - meta.width) / 2;
    const drawY = y + (CELL_H - meta.height) / 2;

    ctx.drawImage(img, srcX, srcY, meta.width, meta.height, drawX, drawY, meta.width, meta.height);
  }

  ctx.restore();

  // Selected character preview (larger, animated, cycling directions)
  const sel = characters[selectedIndex];
  if (sel) {
    const previewY = SCREEN_HEIGHT - 36;
    ctx.fillStyle = '#222';
    ctx.fillRect(0, previewY - 2, SCREEN_WIDTH, 38);

    const { meta, img, hasDiag } = sel;
    const order = DIR_ORDER[dirIndex];
    const dir = !hasDiag && order.fallback ? order.fallback : order;
    const srcX = (dir.col + animFrame) * meta.width;
    const srcY = dir.row * meta.height;

    const pw = meta.width * SCALE;
    const ph = meta.height * SCALE;
    const px = 16;
    const py = previewY + (34 - ph) / 2;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, srcY, meta.width, meta.height, px, py, pw, ph);

    // Character name (authored sprite-group names) + id details
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(getSpriteName(meta.id) ?? `Character #${meta.id}`, px + pw + 8, previewY + 14);
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText(`#${meta.id} · ${meta.width}x${meta.height}`, px + pw + 8, previewY + 26);
  }

  ctx.textAlign = 'left';
}
