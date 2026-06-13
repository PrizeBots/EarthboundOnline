import { Direction, Pose } from '../types';

// Held item overlays: small sprites drawn at the character's hand so everyone
// can see what a player is carrying. The art here is OUR OWN pixel art (16x16
// grids authored below) — never ROM-derived, so it ships with the site. On
// SNES hardware each item is one extra 16x16 OAM sprite next to the player.

const ITEM_W = 16;
const ITEM_H = 16;

interface ItemDef {
  name: string;
  /** Pixel the character "grips" — aligned to the hand anchor when drawn. */
  grip: { x: number; y: number };
  /** char -> CSS color; '.' (or missing) = transparent. */
  palette: Record<string, string>;
  /** Up to 16 rows of up to 16 chars; short rows pad with transparency. */
  pixels: string[];
}

// Placeholder starter set — tune the art freely, it's plain text.
const ITEM_DEFS: Record<string, ItemDef> = {
  bat: {
    name: 'Baseball Bat',
    grip: { x: 3, y: 13 },
    palette: { o: '#502800', b: '#c08850', h: '#7a4a20' },
    pixels: [
      '................',
      '............oo..',
      '...........obbo.',
      '..........obbbo.',
      '.........obbbbo.',
      '........obbbbo..',
      '.......obbbbo...',
      '......obbbbo....',
      '.....obbbbo.....',
      '....obbbbo......',
      '...obbbbo.......',
      '..obbbbo........',
      '..obbo..........',
      '.ohho...........',
      '.oo.............',
      '................',
    ],
  },
  pan: {
    name: 'Frying Pan',
    grip: { x: 14, y: 8 },
    palette: { o: '#181818', g: '#a8a8b0', d: '#484850', h: '#7a4a20' },
    pixels: [
      '................',
      '................',
      '................',
      '................',
      '...oooooo.......',
      '..oggggggo......',
      '.odddddddo......',
      '.odddddddooooooo',
      '.odddddddhhhhhho',
      '..ooooooo..oooo.',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  yoyo: {
    name: 'Yo-yo',
    grip: { x: 8, y: 0 },
    palette: { s: '#d8d8d8', o: '#400808', r: '#d82820', w: '#f8f8f8' },
    pixels: [
      '........s.......',
      '........s.......',
      '........s.......',
      '........s.......',
      '......ooooo.....',
      '....oorrrrroo...',
      '...orrrrrrrrro..',
      '...orrrwwrrrro..',
      '...orrrwwrrrro..',
      '...orrrrrrrrro..',
      '....oorrrrroo...',
      '......ooooo.....',
      '................',
      '................',
      '................',
      '................',
    ],
  },
};

export const HELD_ITEM_IDS = Object.keys(ITEM_DEFS);

/** Cycle helper for the placeholder equip key: none -> bat -> ... -> none. */
export function nextHeldItem(current: string | null): string | null {
  if (current === null) return HELD_ITEM_IDS[0] ?? null;
  const i = HELD_ITEM_IDS.indexOf(current);
  return i === -1 || i === HELD_ITEM_IDS.length - 1 ? null : HELD_ITEM_IDS[i + 1];
}

export function getItemName(itemId: string): string | null {
  return ITEM_DEFS[itemId]?.name ?? null;
}

// Rendered item canvases, normal + horizontally flipped.
const itemCanvases = new Map<string, HTMLCanvasElement>();

function getItemCanvas(itemId: string, flip: boolean): HTMLCanvasElement | null {
  const def = ITEM_DEFS[itemId];
  if (!def) return null; // unknown id from the network — draw nothing
  const key = flip ? `${itemId}:f` : itemId;
  let canvas = itemCanvases.get(key);
  if (canvas) return canvas;

  canvas = document.createElement('canvas');
  canvas.width = ITEM_W;
  canvas.height = ITEM_H;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < Math.min(def.pixels.length, ITEM_H); y++) {
    const row = def.pixels[y];
    for (let x = 0; x < Math.min(row.length, ITEM_W); x++) {
      const color = def.palette[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(flip ? ITEM_W - 1 - x : x, y, 1, 1);
    }
  }
  itemCanvases.set(key, canvas);
  return canvas;
}

// Hand anchor per facing, relative to the entity anchor (center-x, feet-y).
// `behind` = the holding hand is on the character's far side, so the item
// draws underneath the body sprite. `flip` mirrors the item so it points
// outward. Values are eyeballed for 16x24 EB-style sprites — tune freely.
const HAND_ANCHORS: Record<Direction, { dx: number; dy: number; flip: boolean; behind: boolean }> = {
  [Direction.S]:  { dx: -6, dy: -10, flip: true,  behind: false },
  [Direction.N]:  { dx: 6,  dy: -10, flip: false, behind: true },
  [Direction.E]:  { dx: 6,  dy: -10, flip: false, behind: false },
  [Direction.W]:  { dx: -6, dy: -10, flip: true,  behind: false },
  [Direction.NE]: { dx: 7,  dy: -10, flip: false, behind: true },
  [Direction.SE]: { dx: 6,  dy: -10, flip: false, behind: false },
  [Direction.SW]: { dx: -6, dy: -10, flip: true,  behind: false },
  [Direction.NW]: { dx: -7, dy: -10, flip: true,  behind: true },
};

// Swing push direction for attack frame 1, per facing.
const SWING: Record<Direction, [number, number]> = {
  [Direction.S]:  [0, 4],
  [Direction.N]:  [0, -4],
  [Direction.E]:  [4, 0],
  [Direction.W]:  [-4, 0],
  [Direction.NE]: [3, -3],
  [Direction.SE]: [3, 3],
  [Direction.SW]: [-3, 3],
  [Direction.NW]: [-3, -3],
};

/** True if the held item should draw BEHIND the body for this facing. */
export function isItemBehind(direction: Direction): boolean {
  return HAND_ANCHORS[direction].behind;
}

/**
 * Draw a held item at the hand of an entity anchored at (x = center, y = feet)
 * in screen space. Call before the body sprite when isItemBehind(), after it
 * otherwise.
 */
export function drawHeldItem(
  ctx: CanvasRenderingContext2D,
  itemId: string,
  direction: Direction,
  frame: number,
  pose: Pose,
  x: number,
  y: number
): void {
  const def = ITEM_DEFS[itemId];
  if (!def) return;
  const anchor = HAND_ANCHORS[direction];
  const img = getItemCanvas(itemId, anchor.flip);
  if (!img) return;

  let handX = x + anchor.dx;
  let handY = y + anchor.dy;
  if (pose === 'attack') {
    if (frame === 0) {
      handY -= 5; // wind-up: raised
    } else {
      const [sx, sy] = SWING[direction]; // swing: pushed toward the facing
      handX += sx;
      handY += sy;
    }
  } else if (frame === 1) {
    handY += 1; // walk bob
  }

  const gripX = anchor.flip ? ITEM_W - 1 - def.grip.x : def.grip.x;
  ctx.drawImage(img, Math.floor(handX - gripX), Math.floor(handY - def.grip.y));
}
