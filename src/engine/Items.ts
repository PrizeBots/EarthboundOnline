import { Direction, Pose } from '../types';
import { loadJSON } from './AssetLoader';
import { itemName as catalogItemName } from './Shop';

// Held item overlays: small sprites drawn at the character's hand so everyone
// can see what a player is carrying. The art here is OUR OWN pixel art (16x16
// grids authored below) — never ROM-derived, so it ships with the site. On
// SNES hardware each item is one extra 16x16 OAM sprite next to the player.

export const ITEM_W = 16;
export const ITEM_H = 16;

// A general-purpose 16-color palette for the item editor. Items are OUR OWN
// art (not ROM-derived) and become a standalone OAM palette on SNES, so they
// are NOT tied to the EB sprite palette — this is a hand-picked spread. Index
// 0 is transparent (empty string), matching the character editor's color 0.
export const ITEM_PALETTE: string[] = [
  '',        // 0: transparent
  '#000000', // 1: black (outline)
  '#ffffff', // 2: white
  '#7a4a20', // 3: wood dark
  '#c08850', // 4: wood light
  '#502800', // 5: wood outline
  '#a8a8b0', // 6: metal light
  '#484850', // 7: metal dark
  '#d82820', // 8: red
  '#208040', // 9: green
  '#2860d8', // 10: blue
  '#f0d020', // 11: yellow
  '#e07820', // 12: orange
  '#902080', // 13: purple
  '#d8d8d8', // 14: silver
  '#181818', // 15: near-black
];

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

// Legacy hand-authored art ids (bat/pan/yoyo) — kept as seed/defaults. Real
// held gear is now keyed by CATALOG item id (shops.json) via the data store
// below; the Item Manager + Sprite Editor author per-item art shared by all.
export const HELD_ITEM_IDS = Object.keys(ITEM_DEFS);

/** Where the hand grips an item if its art carries no grip. Bottom-ish center. */
const DEFAULT_GRIP = { x: 3, y: 13 };

// --- Per-item held sprites, keyed by catalog item id (shops.json) ---------
// OUR authored pixel art (ITEM_PALETTE indices), shared across clients so
// everyone sees the same held gear. Loaded from overrides/item_sprites.json,
// edited in the Sprite Editor, listed/managed in the Item Manager.
export interface ItemSpriteData {
  /** 16 rows of 16 hex chars ('0'..'f'), each an ITEM_PALETTE index (0 = clear). */
  pixels: string[];
  /** Hand grip point; defaults applied if absent. */
  grip?: { x: number; y: number };
}
const itemSprites = new Map<string, ItemSpriteData>();

/** Load the shared per-item art (call once at startup, before rendering gear). */
export async function loadItemSprites(): Promise<void> {
  itemSprites.clear();
  itemCanvases.clear();
  const data = await loadJSON<Record<string, ItemSpriteData>>('/overrides/item_sprites.json').catch(
    () => null,
  );
  if (data) for (const [id, d] of Object.entries(data)) if (d && Array.isArray(d.pixels)) itemSprites.set(id, d);
}

/** The authored data for an item id (Item Manager / Sprite Editor save path). */
export function getItemSpriteData(id: string): ItemSpriteData | null {
  return itemSprites.get(id) ?? null;
}

/** All item ids that currently have authored art (for export / status). */
export function itemSpriteIds(): string[] {
  return [...itemSprites.keys()];
}

/** True if the item has art to draw (authored data, a live edit, or a legacy def). */
export function hasItemSprite(id: string): boolean {
  return itemSprites.has(id) || itemOverrides.has(id) || !!ITEM_DEFS[id];
}

/** Update the in-memory art for an item (the Sprite Editor's save path). The
 * caller persists the full map to overrides/item_sprites.json separately. */
export function setItemSpriteData(id: string, data: ItemSpriteData): void {
  itemSprites.set(id, data);
  itemOverrides.delete(id); // authored data now wins over any stale live canvas
  itemCanvases.delete(id);
  itemCanvases.delete(`${id}:f`);
}

/** Serialize a 16x16 edit canvas to ITEM_PALETTE-index rows for JSON storage. */
export function canvasToItemPixels(canvas: HTMLCanvasElement): string[] {
  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, ITEM_W, ITEM_H);
  const rows: string[] = [];
  for (let y = 0; y < ITEM_H; y++) {
    let row = '';
    for (let x = 0; x < ITEM_W; x++) {
      const i = (y * ITEM_W + x) * 4;
      const a = data[i + 3];
      row += a < 8 ? '0' : nearestPaletteIndex(data[i], data[i + 1], data[i + 2]).toString(16);
    }
    rows.push(row);
  }
  return rows;
}

const ITEM_PAL_RGB: [number, number, number][] = ITEM_PALETTE.map((hex) => {
  if (!hex) return [0, 0, 0];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
});
function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < ITEM_PAL_RGB.length; i++) {
    const [pr, pg, pb] = ITEM_PAL_RGB[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// --- Admin-authored custom items (overrides/custom_items.json) -------------
// shops.json is ROM-derived and can't grow, so brand-new items the admin makes
// in the Sprite Editor live here: an id + display name. Their pixel art is stored
// in item_sprites.json like any other item. The legacy ITEM_DEFS seeds
// (bat/pan/yoyo) also show under the editor's "Custom" tab, but they're built in
// (HELD_ITEM_IDS), not stored here.
export interface CustomItem { id: string; name: string; }
const customItems = new Map<string, string>(); // id -> name

export async function loadCustomItems(): Promise<void> {
  customItems.clear();
  const data = await loadJSON<{ items?: CustomItem[] }>('/overrides/custom_items.json').catch(() => null);
  for (const it of data?.items ?? []) if (it?.id) customItems.set(it.id, it.name ?? it.id);
}

export function customItemIds(): string[] {
  return [...customItems.keys()];
}

export function customItemsDoc(): { items: CustomItem[] } {
  return { items: [...customItems].map(([id, name]) => ({ id, name })) };
}

/** Mint a new custom item with `name`, returning its fresh id (`custom-N`). */
export function addCustomItem(name: string): string {
  let n = 1;
  while (customItems.has(`custom-${n}`)) n++;
  const id = `custom-${n}`;
  customItems.set(id, name.trim() || id);
  return id;
}

// EarthBound item Type bits: 0x10..0x1F are the equip categories (weapon, body,
// arms, other/headgear); 0x20+ are consumables/key items. Only equippable gear
// gets a held sprite slot in the Item Manager.
export function isEquippable(type: number): boolean {
  return type >= 0x10 && type < 0x20;
}

/** Cycle helper for the placeholder equip key: none -> bat -> ... -> none. */
export function nextHeldItem(current: string | null): string | null {
  if (current === null) return HELD_ITEM_IDS[0] ?? null;
  const i = HELD_ITEM_IDS.indexOf(current);
  return i === -1 || i === HELD_ITEM_IDS.length - 1 ? null : HELD_ITEM_IDS[i + 1];
}

/** Display name: custom name, then catalog (shops.json), then legacy def. */
export function getItemName(itemId: string): string | null {
  const custom = customItems.get(itemId);
  if (custom) return custom;
  const n = catalogItemName(itemId);
  if (n && !n.startsWith('Item ')) return n;
  return ITEM_DEFS[itemId]?.name ?? n ?? null;
}

/** The hand grip for an item id (authored grip, legacy def, or default). */
function gripFor(id: string): { x: number; y: number } {
  return itemSprites.get(id)?.grip ?? ITEM_DEFS[id]?.grip ?? DEFAULT_GRIP;
}

// Rendered item canvases, normal + horizontally flipped.
const itemCanvases = new Map<string, HTMLCanvasElement>();

// Runtime art overrides (the sprite editor). When an item has an override its
// pixels come from the supplied ITEM_W x ITEM_H canvas instead of ITEM_DEFS.
const itemOverrides = new Map<string, HTMLCanvasElement>();

/**
 * Replace an item's art at runtime with a 16x16 canvas (the editor's buffer).
 * Busts the render cache so the new pixels show on the very next draw — the
 * game/test-pane render path (drawHeldItem) picks it up with no other plumbing.
 */
export function setItemOverride(itemId: string, canvas: HTMLCanvasElement): void {
  itemOverrides.set(itemId, canvas);
  itemCanvases.delete(itemId);
  itemCanvases.delete(`${itemId}:f`);
}

/**
 * Render an item's CURRENT art (override if present, else the base def) into a
 * fresh 16x16 canvas. The editor uses this to seed its edit buffer so you start
 * from the existing pixels.
 */
export function renderItemArt(itemId: string): HTMLCanvasElement | null {
  const base = getItemCanvas(itemId, false);
  if (!base) return null;
  const c = document.createElement('canvas');
  c.width = ITEM_W;
  c.height = ITEM_H;
  c.getContext('2d')!.drawImage(base, 0, 0);
  return c;
}

/**
 * Draw an item's held art centered into a picker/preview thumb canvas (the
 * shared sprite-preview dropdown). Clears first; draws a faint dot grid when the
 * item has no art yet so "needs a sprite" reads at a glance.
 */
export function drawItemThumb(canvas: HTMLCanvasElement, id: string): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const art = getItemCanvas(id, false);
  if (art) {
    const s = Math.max(1, Math.floor(Math.min(canvas.width / ITEM_W, canvas.height / ITEM_H)));
    const w = ITEM_W * s;
    const h = ITEM_H * s;
    ctx.drawImage(art, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2), w, h);
  } else {
    ctx.fillStyle = '#333';
    for (let y = 2; y < canvas.height; y += 4) for (let x = 2; x < canvas.width; x += 4) ctx.fillRect(x, y, 1, 1);
  }
}

/**
 * Draw an item's 16x16 held art straight into a game/menu ctx at (x,y), scaled
 * to `size` px (nearest-neighbour). For the hotbar + Equip modal icons. Returns
 * false if the item has no art yet (caller can draw a placeholder).
 */
export function drawItemIcon(
  ctx: CanvasRenderingContext2D, id: string, x: number, y: number, size = ITEM_W
): boolean {
  const art = getItemCanvas(id, false);
  if (!art) return false;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art, Math.round(x), Math.round(y), size, size);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

function getItemCanvas(itemId: string, flip: boolean): HTMLCanvasElement | null {
  const override = itemOverrides.get(itemId); // live edit buffer (Sprite Editor)
  const data = itemSprites.get(itemId);       // authored, shared art
  const def = ITEM_DEFS[itemId];              // legacy hand-authored seed
  if (!override && !data && !def) return null; // unknown id — draw nothing
  const key = flip ? `${itemId}:f` : itemId;
  const cached = itemCanvases.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = ITEM_W;
  canvas.height = ITEM_H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  if (override) {
    // Edited art: blit the override canvas, mirrored for the flipped variant.
    if (flip) { ctx.translate(ITEM_W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(override, 0, 0);
  } else if (data) {
    // Authored data: ITEM_PALETTE-index rows.
    for (let y = 0; y < Math.min(data.pixels.length, ITEM_H); y++) {
      const row = data.pixels[y];
      for (let x = 0; x < Math.min(row.length, ITEM_W); x++) {
        const idx = parseInt(row[x], 16);
        const color = ITEM_PALETTE[idx];
        if (!idx || !color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(flip ? ITEM_W - 1 - x : x, y, 1, 1);
      }
    }
  } else {
    for (let y = 0; y < Math.min(def!.pixels.length, ITEM_H); y++) {
      const row = def!.pixels[y];
      for (let x = 0; x < Math.min(row.length, ITEM_W); x++) {
        const color = def!.palette[row[x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(flip ? ITEM_W - 1 - x : x, y, 1, 1);
      }
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
  const anchor = HAND_ANCHORS[direction];
  const img = getItemCanvas(itemId, anchor.flip);
  if (!img) return; // no art for this id — draw nothing
  const grip = gripFor(itemId);

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

  const gripX = anchor.flip ? ITEM_W - 1 - grip.x : grip.x;
  ctx.drawImage(img, Math.floor(handX - gripX), Math.floor(handY - grip.y));
}
