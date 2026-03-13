import { loadImage, loadJSON } from './AssetLoader';
import { SpriteGroupMeta, Direction, SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';

const COLS = 10;
const CELL_W = 24;
const CELL_H = 32;
const PADDING = 2;
const GRID_X = 8;
const GRID_Y = 32;
const SCALE = 2;

// Direction layout from SpriteManager — south-facing frame 0 is row 1, col 0
const SOUTH_ROW = 1;
const SOUTH_COL = 0;

// Direction cycle for preview animation
const DIR_ORDER: { row: number; col: number }[] = [
  { row: 1, col: 0 }, // S
  { row: 1, col: 2 }, // W
  { row: 0, col: 0 }, // N
  { row: 0, col: 2 }, // E
  { row: 3, col: 0 }, // SW
  { row: 3, col: 2 }, // NW
  { row: 2, col: 0 }, // NE
  { row: 2, col: 2 }, // SE
];

interface CharEntry {
  meta: SpriteGroupMeta;
  img: HTMLImageElement;
}

let characters: CharEntry[] = [];
let selectedIndex = 0;
let animFrame = 0;
let animTimer = 0;
let dirIndex = 0;
let dirTimer = 0;
let scrollY = 0;

export async function loadCharacterSelect(): Promise<void> {
  const allMeta = await loadJSON<SpriteGroupMeta[]>('/assets/sprites/metadata.json');

  // Filter to 16x24 characters only (human-sized, full 8-dir support)
  const candidates = allMeta.filter(s => s.width === 16 && s.height === 24);

  // Load all sprite sheets
  const entries: CharEntry[] = [];
  for (const meta of candidates) {
    try {
      const img = await loadImage(`/assets/sprites/${meta.id}.png`);
      entries.push({ meta, img });
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
  const rows = Math.ceil(characters.length / COLS);
  const currentRow = Math.floor(selectedIndex / COLS);
  const currentCol = selectedIndex % COLS;

  switch (key) {
    case 'ArrowRight':
    case 'd':
      selectedIndex = Math.min(selectedIndex + 1, characters.length - 1);
      break;
    case 'ArrowLeft':
    case 'a':
      selectedIndex = Math.max(selectedIndex - 1, 0);
      break;
    case 'ArrowDown':
    case 's':
      if (currentRow < rows - 1) {
        const next = (currentRow + 1) * COLS + currentCol;
        selectedIndex = Math.min(next, characters.length - 1);
      }
      break;
    case 'ArrowUp':
    case 'w':
      if (currentRow > 0) {
        selectedIndex = (currentRow - 1) * COLS + currentCol;
      }
      break;
    case 'Enter':
    case ' ':
      return 'confirm';
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

export function drawCharacterSelect(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  // Title
  ctx.fillStyle = '#fff';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SELECT YOUR CHARACTER', SCREEN_WIDTH / 2, 14);
  ctx.font = '8px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText('Arrow keys to browse, Enter to confirm', SCREEN_WIDTH / 2, 24);

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

    const { meta, img } = characters[i];

    // Highlight selected
    if (i === selectedIndex) {
      ctx.strokeStyle = '#ff0';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1, y - 1, CELL_W + 2, CELL_H + 2);
    }

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

    const { meta, img } = sel;
    const dir = DIR_ORDER[dirIndex];
    const srcX = (dir.col + animFrame) * meta.width;
    const srcY = dir.row * meta.height;

    const pw = meta.width * SCALE;
    const ph = meta.height * SCALE;
    const px = 16;
    const py = previewY + (34 - ph) / 2;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, srcX, srcY, meta.width, meta.height, px, py, pw, ph);

    // Character ID label
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Character #${meta.id}`, px + pw + 8, previewY + 14);
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText(`${meta.width}x${meta.height}`, px + pw + 8, previewY + 26);
  }

  ctx.textAlign = 'left';
}
