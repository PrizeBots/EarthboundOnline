import {
  loadPartCatalog,
  getPartCatalog,
  emptyAppearance,
  compositeAppearance,
  NO_PART,
} from './CharacterComposite';
import {
  APPEARANCE_CATEGORIES,
  AppearanceCategory,
  CharacterAppearance,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
} from '../types';

const FRAME_W = 16;
const FRAME_H = 24;

// Frame grid layout: rows A-E (sheet rows), columns 1-4 (sheet columns).
// Rows A-D each hold two directions x two walk frames; row E is the climb
// row (ladder pair + rope pair).
const GRID_X = 22;
const GRID_Y = 36;
const CELL_W = 22;
const CELL_H = 30;
const ROW_LABELS = ['A', 'B', 'C', 'D', 'E'];
const GRID_ROWS = ROW_LABELS.length;

// Category menu
const MENU_X = 126;
const MENU_Y = 40;
const MENU_ROW_H = 16;

let appearance: CharacterAppearance = emptyAppearance();
let categoryIndex = 0;
// Frame grid: the browsed part rendered in isolation (no other layers).
let gridSheet: HTMLCanvasElement | null = null;
// Walk preview: the full assembled character as currently selected.
let previewSheet: HTMLCanvasElement | null = null;
let compositeToken = 0;
let animFrame = 0;
let animTimer = 0;
let loaded = false;

export async function loadCharacterCreate(): Promise<void> {
  await loadPartCatalog();
  if (!loaded) {
    loaded = true;
    appearance = emptyAppearance();
    await recomposite();
  }
}

export function getCreatedAppearance(): CharacterAppearance {
  return { ...appearance };
}

async function recomposite(): Promise<void> {
  const token = ++compositeToken;
  const cat = APPEARANCE_CATEGORIES[categoryIndex];
  const [isolated, full] = await Promise.all([
    compositeAppearance(appearance, cat),
    compositeAppearance(appearance),
  ]);
  if (token === compositeToken) {
    // drop stale results from rapid cycling
    gridSheet = isolated;
    previewSheet = full;
  }
}

function cyclePart(dir: 1 | -1) {
  const cat = APPEARANCE_CATEGORIES[categoryIndex];
  const count = getPartCatalog()[cat].length;
  // Cycle through: none (-1), 0, 1, ..., count-1, back to none.
  const states = count + 1;
  appearance[cat] = ((appearance[cat] + 1 + dir + states) % states) - 1;
  void recomposite();
}

export function handleCharCreateInput(key: string): 'confirm' | 'back' | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
      categoryIndex = (categoryIndex + APPEARANCE_CATEGORIES.length - 1) % APPEARANCE_CATEGORIES.length;
      void recomposite(); // grid emphasis follows the selected category
      break;
    case 'ArrowDown':
    case 's':
      categoryIndex = (categoryIndex + 1) % APPEARANCE_CATEGORIES.length;
      void recomposite();
      break;
    case 'ArrowLeft':
    case 'a':
      cyclePart(-1);
      break;
    case 'ArrowRight':
    case 'd':
      cyclePart(1);
      break;
    case 'Enter':
      // An entirely empty character would be invisible — require some part.
      if (APPEARANCE_CATEGORIES.every((c) => appearance[c] === NO_PART)) return null;
      return 'confirm';
    case 'Escape':
      return 'back';
  }
  return null;
}

export function updateCharacterCreate() {
  animTimer++;
  if (animTimer >= 10) {
    animTimer = 0;
    animFrame = animFrame === 0 ? 1 : 0;
  }
}

export function drawCharacterCreate(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#fff';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('CREATE CHARACTER', SCREEN_WIDTH / 2, 14);
  ctx.font = '8px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText('Arrows: pick & change   Enter: done   Esc: back', SCREEN_WIDTH / 2, 24);

  // --- Frame grid: all 20 frames of the composited character ---
  ctx.fillStyle = '#aaa';
  ctx.font = '8px monospace';
  for (let col = 0; col < 4; col++) {
    ctx.fillText(String(col + 1), GRID_X + col * CELL_W + CELL_W / 2, GRID_Y - 4);
  }
  ctx.textAlign = 'left';
  for (let row = 0; row < GRID_ROWS; row++) {
    ctx.fillText(ROW_LABELS[row], GRID_X - 12, GRID_Y + row * CELL_H + CELL_H / 2 + 3);
  }

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < 4; col++) {
      const x = GRID_X + col * CELL_W;
      const y = GRID_Y + row * CELL_H;
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 2, CELL_H - 2);
      if (gridSheet) {
        ctx.drawImage(
          gridSheet,
          col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H,
          x + (CELL_W - 2 - FRAME_W) / 2, y + (CELL_H - 2 - FRAME_H) / 2,
          FRAME_W, FRAME_H
        );
      }
    }
  }

  // --- Category menu ---
  const catalog = loaded ? getPartCatalog() : null;
  ctx.font = '8px monospace';
  for (let i = 0; i < APPEARANCE_CATEGORIES.length; i++) {
    const cat = APPEARANCE_CATEGORIES[i];
    const y = MENU_Y + i * MENU_ROW_H;
    const selected = i === categoryIndex;

    if (selected) {
      ctx.fillStyle = '#234';
      ctx.fillRect(MENU_X - 4, y - 9, SCREEN_WIDTH - MENU_X - 4, 13);
    }

    ctx.fillStyle = selected ? '#ff0' : '#ccc';
    ctx.fillText(cat.toUpperCase(), MENU_X, y);

    if (catalog) {
      const count = catalog[cat].length;
      const cur = appearance[cat];
      const label = cur === NO_PART ? 'none' : `${cur + 1}/${count}`;
      ctx.fillStyle = selected ? '#fff' : '#777';
      ctx.textAlign = 'right';
      ctx.fillText(`${selected ? '< ' : ''}${label}${selected ? ' >' : ''}`, SCREEN_WIDTH - 10, y);
      ctx.textAlign = 'left';
    }
  }

  // --- Animated walk preview: the full assembled character ---
  if (previewSheet) {
    const px = MENU_X + 16;
    const py = MENU_Y + APPEARANCE_CATEGORIES.length * MENU_ROW_H + 8;
    ctx.fillStyle = '#222';
    ctx.fillRect(px - 6, py - 4, FRAME_W * 2 + 12, FRAME_H * 2 + 8);
    ctx.drawImage(
      previewSheet,
      animFrame * FRAME_W, 1 * FRAME_H, FRAME_W, FRAME_H,
      px, py, FRAME_W * 2, FRAME_H * 2
    );
  }
}
