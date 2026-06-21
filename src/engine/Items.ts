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
  '', // 0: transparent
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

// Built-in seed art, keyed by id. Empty now: the former bat/pan/yoyo seeds were
// migrated into data-driven custom items (c002/c003/c004 in custom_items.json,
// art in item_sprites.json) so EVERY custom item follows the `cNNN` convention.
// Kept as a typed map so getItemCanvas/gripFor/getItemName can still fall back to
// a seed if we ever ship one again.
const ITEM_DEFS: Record<string, ItemDef> = {};

// Built-in seed item ids (none currently — see ITEM_DEFS). Held gear is keyed by
// CATALOG item id (shops.json) or custom item id; the Item Manager + Sprite
// Editor author per-item art shared by all clients.
export const HELD_ITEM_IDS = Object.keys(ITEM_DEFS);

/** Where the hand grips an item if its art carries no grip. Bottom-ish center. */
const DEFAULT_GRIP = { x: 3, y: 13 };

// --- Per-item held sprites, keyed by catalog item id (shops.json) ---------
// OUR authored pixel art (ITEM_PALETTE indices), shared across clients so
// everyone sees the same held gear. Loaded from overrides/item_sprites.json,
// edited in the Sprite Editor, listed/managed in the Item Manager.
// A held weapon/item animates across this many frames during a swing (wind-up →
// swing → follow-through). Authored per-frame in the Sprite Editor; the attack
// animation (Player / npc poses) drives which frame draws. KEEP IN SYNC with the
// editor's frame selector and the player attack timing.
export const ITEM_FRAMES = 3;

export interface ItemSpriteData {
  /** Frame 0 art — 16 rows of 16 hex chars ('0'..'f'), ITEM_PALETTE index (0 = clear).
   *  Kept as the canonical first frame (mirrors frames[0]) for back-compat. */
  pixels: string[];
  /** Full swing animation: up to ITEM_FRAMES pixel grids. frames[0] === pixels.
   *  Absent / short → missing frames fall back to frame 0 (a static weapon). */
  frames?: string[][];
  /** Hand grip point; defaults applied if absent. */
  grip?: { x: number; y: number };
  /** Body-mount offset from the character anchor (center-x / feet-y). When set,
   *  the item is WORN at this spot (static, no swing) instead of held in the hand
   *  — e.g. a badge on the chest. Authored by dragging in the editor's live test. */
  offset?: { x: number; y: number };
  /** Whether the held art mirrors with the body's left/right facing (default true).
   *  false = the item draws the SAME orientation every direction — for art with a
   *  baked-in direction or an asymmetric emblem that shouldn't flip. */
  mirror?: boolean;
}
const itemSprites = new Map<string, ItemSpriteData>();

/** Load the shared per-item art (call once at startup, before rendering gear). */
export async function loadItemSprites(): Promise<void> {
  itemSprites.clear();
  itemCanvases.clear();
  const data = await loadJSON<Record<string, ItemSpriteData>>('/overrides/item_sprites.json').catch(
    () => null
  );
  if (data)
    for (const [id, d] of Object.entries(data)) {
      if (!d || (!Array.isArray(d.pixels) && !Array.isArray(d.frames))) continue;
      // Normalize: ensure frame 0 (`pixels`) always exists for back-compat readers.
      const frames =
        Array.isArray(d.frames) && d.frames.length ? d.frames : d.pixels ? [d.pixels] : [];
      itemSprites.set(id, { ...d, pixels: d.pixels ?? frames[0] ?? [], frames });
    }
}

/** The authored data for an item id (Item Manager / Sprite Editor save path). */
export function getItemSpriteData(id: string): ItemSpriteData | null {
  return itemSprites.get(id) ?? null;
}

/** The authored pixel grid for one animation frame, falling back to frame 0 (so
 *  a 1-frame weapon stays static across the swing). Null if the item has no
 *  authored data at all (a legacy ITEM_DEF is resolved separately). */
function itemFrameGrid(id: string, frame: number): string[] | null {
  const d = itemSprites.get(id);
  if (!d) return null;
  const grids = d.frames && d.frames.length ? d.frames : d.pixels ? [d.pixels] : [];
  if (!grids.length) return null;
  const g = grids[frame];
  return g && g.length ? g : (grids[0] ?? null);
}

/** True if the item has its OWN authored art for this frame (not a fallback) —
 *  lets the editor seed an unauthored frame from the previous one. */
export function itemHasFrame(id: string, frame: number): boolean {
  const d = itemSprites.get(id);
  if (!d) return false;
  if (d.frames && d.frames[frame] && d.frames[frame].length) return true;
  return frame === 0 && !!d.pixels && d.pixels.length > 0;
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
  for (let f = 0; f < ITEM_FRAMES; f++) itemOverrides.delete(`${id}:${f}`); // authored wins now
  clearItemCache(id);
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

/**
 * Quantize an arbitrary source image into a 16x16 ITEM_PALETTE grid — fit
 * (aspect-preserving) and centered. Lets the Source Assets tool turn any ROM
 * graphic into held-item art that renders through the normal item pipeline.
 * NOTE: the result is re-quantized to OUR own 16-color item palette, so it is
 * transformed art, not a verbatim ROM rip.
 */
export function itemPixelsFromImage(img: CanvasImageSource, iw: number, ih: number): string[] {
  const c = document.createElement('canvas');
  c.width = ITEM_W;
  c.height = ITEM_H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const scale = Math.min(ITEM_W / iw, ITEM_H / ih);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  ctx.drawImage(
    img,
    0,
    0,
    iw,
    ih,
    Math.floor((ITEM_W - w) / 2),
    Math.floor((ITEM_H - h) / 2),
    w,
    h
  );
  return canvasToItemPixels(c);
}

/** Serialize every in-memory item sprite back to the item_sprites.json shape
 *  (for save-after-mint: load at boot → add one → write the whole map back). */
export function itemSpritesDoc(): Record<string, ItemSpriteData> {
  const out: Record<string, ItemSpriteData> = {};
  for (const [id, d] of itemSprites) out[id] = d;
  return out;
}

const ITEM_PAL_RGB: [number, number, number][] = ITEM_PALETTE.map((hex) => {
  if (!hex) return [0, 0, 0];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
});
function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < ITEM_PAL_RGB.length; i++) {
    const [pr, pg, pb] = ITEM_PAL_RGB[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// --- Admin-authored custom items (overrides/custom_items.json) -------------
// shops.json is ROM-derived and can't grow, so brand-new items the admin makes
// in the Sprite Editor live here: an id + display name. Their pixel art is stored
// in item_sprites.json like any other item. (The old bat/pan/yoyo seeds are now
// regular custom items here too — c002/c003/c004 — not built-in ITEM_DEFS.)
export interface CustomItem {
  id: string;
  name: string;
}
const customItems = new Map<string, string>(); // id -> name

export async function loadCustomItems(): Promise<void> {
  customItems.clear();
  const data = await loadJSON<{ items?: CustomItem[] }>('/overrides/custom_items.json').catch(
    () => null
  );
  for (const it of data?.items ?? []) if (it?.id) customItems.set(it.id, it.name ?? it.id);
}

export function customItemIds(): string[] {
  return [...customItems.keys()];
}

export function customItemsDoc(): { items: CustomItem[] } {
  return { items: [...customItems].map(([id, name]) => ({ id, name })) };
}

/** Mint a new custom item with `name`, returning its fresh id (`cNNN`, e.g. c001). */
export function addCustomItem(name: string): string {
  let n = 1;
  const pad = (k: number) => `c${String(k).padStart(3, '0')}`;
  while (customItems.has(pad(n))) n++;
  const id = pad(n);
  customItems.set(id, name.trim() || id);
  return id;
}

// EarthBound item Type bits: 0x10..0x1F are the equip categories (weapon, body,
// arms, other/headgear); 0x20+ are consumables/key items. Only equippable gear
// gets a held sprite slot in the Item Manager.
export function isEquippable(type: number): boolean {
  return type >= 0x10 && type < 0x20;
}

/** Cycle helper for the placeholder equip key, over the built-in seed ids
 *  (HELD_ITEM_IDS). Currently empty, so this just returns null. */
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

/** Body-mount offset for an item, or null if it's hand-held (a weapon). */
export function offsetFor(id: string): { x: number; y: number } | null {
  return itemSprites.get(id)?.offset ?? null;
}

/** Set (or clear, with null) an item's body-mount offset. Updates the shared
 *  art entry in place — pixels are untouched, so no cache bust is needed. The
 *  editor calls this while dragging; persistItem writes it to the file. */
export function setItemOffset(id: string, offset: { x: number; y: number } | null): void {
  const cur = itemSprites.get(id) ?? { pixels: [] as string[], frames: [] as string[][] };
  if (offset) cur.offset = offset;
  else delete cur.offset;
  itemSprites.set(id, cur);
}

/** The default hand position (vs the entity anchor) for a facing — the spot a
 *  freshly-dragged item lifts off from before you reposition it. */
export function defaultHeldOffset(direction: Direction): { x: number; y: number } {
  const a = HAND_ANCHORS[direction];
  // Canonical (right-facing) space: drawHeldItem mirrors x back for flipped
  // facings, so pre-negate it here when this facing is one of them.
  return { x: a.flip ? -a.dx : a.dx, y: a.dy };
}

// Rendered item canvases, keyed `${id}:${frame}` (+ ':f' for the flipped
// variant), normal + horizontally flipped, per animation frame.
const itemCanvases = new Map<string, HTMLCanvasElement>();

// Runtime art overrides (the sprite editor), keyed `${id}:${frame}`. When a
// frame has an override its pixels come from the supplied canvas (the editor's
// live buffer) instead of the authored data / ITEM_DEFS.
const itemOverrides = new Map<string, HTMLCanvasElement>();

/** Drop every cached frame canvas for an item (after its art changes). */
function clearItemCache(id: string): void {
  for (let f = 0; f < ITEM_FRAMES; f++) {
    itemCanvases.delete(`${id}:${f}`);
    itemCanvases.delete(`${id}:${f}:f`);
  }
}

/**
 * Replace one animation frame of an item's art at runtime with a 16x16 canvas
 * (the editor's per-frame buffer). Busts the render cache so the new pixels show
 * on the very next draw — drawHeldItem picks it up with no other plumbing.
 */
export function setItemOverride(itemId: string, frame: number, canvas: HTMLCanvasElement): void {
  itemOverrides.set(`${itemId}:${frame}`, canvas);
  clearItemCache(itemId);
}

/**
 * Render an item frame's CURRENT art (override if present, else authored data,
 * else the base def) into a fresh 16x16 canvas. The editor uses this to seed its
 * per-frame edit buffer so you start from the existing pixels.
 */
export function renderItemArt(itemId: string, frame = 0): HTMLCanvasElement | null {
  const base = getItemCanvas(itemId, frame, false);
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
  const art = getItemCanvas(id, 0, false);
  if (art) {
    const s = Math.max(1, Math.floor(Math.min(canvas.width / ITEM_W, canvas.height / ITEM_H)));
    const w = ITEM_W * s;
    const h = ITEM_H * s;
    ctx.drawImage(
      art,
      Math.floor((canvas.width - w) / 2),
      Math.floor((canvas.height - h) / 2),
      w,
      h
    );
  } else {
    ctx.fillStyle = '#333';
    for (let y = 2; y < canvas.height; y += 4)
      for (let x = 2; x < canvas.width; x += 4) ctx.fillRect(x, y, 1, 1);
  }
}

/**
 * Draw an item's 16x16 held art straight into a game/menu ctx at (x,y), scaled
 * to `size` px (nearest-neighbour). For the hotbar + Equip modal icons. Returns
 * false if the item has no art yet (caller can draw a placeholder).
 */
export function drawItemIcon(
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  size = ITEM_W
): boolean {
  const art = getItemCanvas(id, 0, false);
  if (!art) return false;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art, Math.round(x), Math.round(y), size, size);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

function getItemCanvas(itemId: string, frame: number, flip: boolean): HTMLCanvasElement | null {
  const fr = Math.max(0, Math.min(frame | 0, ITEM_FRAMES - 1));
  // Live edit buffer (Sprite Editor) for this frame; fall back to frame 0's
  // buffer so a half-authored animation still previews.
  const override = itemOverrides.get(`${itemId}:${fr}`) ?? itemOverrides.get(`${itemId}:0`);
  const grid = itemFrameGrid(itemId, fr); // authored ITEM_PALETTE rows (→ frame 0 fallback)
  const def = ITEM_DEFS[itemId]; // legacy hand-authored seed (single frame)
  if (!override && !grid && !def) return null; // unknown id — draw nothing
  const key = flip ? `${itemId}:${fr}:f` : `${itemId}:${fr}`;
  const cached = itemCanvases.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = ITEM_W;
  canvas.height = ITEM_H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  if (override) {
    // Edited art: blit the override canvas, mirrored for the flipped variant.
    if (flip) {
      ctx.translate(ITEM_W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(override, 0, 0);
  } else if (grid) {
    // Authored data: ITEM_PALETTE-index rows for this frame.
    for (let y = 0; y < Math.min(grid.length, ITEM_H); y++) {
      const row = grid[y];
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
const HAND_ANCHORS: Record<Direction, { dx: number; dy: number; flip: boolean; behind: boolean }> =
  {
    [Direction.S]: { dx: -6, dy: -10, flip: true, behind: false },
    [Direction.N]: { dx: 6, dy: -10, flip: false, behind: true },
    [Direction.E]: { dx: 6, dy: -10, flip: false, behind: false },
    [Direction.W]: { dx: -6, dy: -10, flip: true, behind: false },
    [Direction.NE]: { dx: 7, dy: -10, flip: false, behind: true },
    [Direction.SE]: { dx: 6, dy: -10, flip: false, behind: false },
    [Direction.SW]: { dx: -6, dy: -10, flip: true, behind: false },
    [Direction.NW]: { dx: -7, dy: -10, flip: true, behind: true },
  };

// Swing push direction for attack frame 1, per facing.
const SWING: Record<Direction, [number, number]> = {
  [Direction.S]: [0, 4],
  [Direction.N]: [0, -4],
  [Direction.E]: [4, 0],
  [Direction.W]: [-4, 0],
  [Direction.NE]: [3, -3],
  [Direction.SE]: [3, 3],
  [Direction.SW]: [-3, 3],
  [Direction.NW]: [-3, -3],
};

/** True if the held item should draw BEHIND the body for this facing. */
export function isItemBehind(direction: Direction): boolean {
  return HAND_ANCHORS[direction].behind;
}

/** True if an item's art mirrors for this facing — the same left/right axis the
 *  body sprite mirrors on (W/NW/SW + S). Worn-item offsets are stored in canonical
 *  (right-facing) space, so an editor authoring a position must mirror its drag
 *  delta when this is true. Honors the item's own mirror flag (off = never flips). */
export function isItemFlipped(direction: Direction, itemId?: string): boolean {
  if (itemId && !itemMirrors(itemId)) return false;
  return HAND_ANCHORS[direction].flip;
}

/** Whether an item's held art flips with the body's facing. Default true (mirrors
 *  like the character); false = same orientation no matter which way the player
 *  faces. Stored per item in overrides/item_sprites.json. */
export function itemMirrors(itemId: string): boolean {
  return itemSprites.get(itemId)?.mirror !== false;
}

/** Live-set an item's mirror flag in memory so the editor's test pane + the world
 *  reflect a toggle immediately (the editor also persists it via persistItem). */
export function setItemMirror(itemId: string, on: boolean): void {
  const d = itemSprites.get(itemId);
  if (d) d.mirror = on;
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
  // Authored body position (badge → chest), else the per-direction hand. EVERY
  // item mirrors on the body sprite's left/right axis: the art h-flips and, for a
  // worn item, its mount point mirrors across center too — so it swaps sides
  // exactly as the character does. Offsets are authored in canonical (right-
  // facing) space, so negate x for a flipped facing. Swing still plays normally.
  const off = offsetFor(itemId);
  // Item may opt out of mirroring — then it keeps one orientation every facing.
  const flip = anchor.flip && itemMirrors(itemId);

  // During a swing the weapon plays its 3 authored frames; otherwise it rests on
  // frame 0. The body sprite only has 2 attack frames (it clamps), but the
  // weapon animates across all three.
  const weaponFrame = pose === 'attack' ? Math.max(0, Math.min(frame | 0, ITEM_FRAMES - 1)) : 0;
  const img = getItemCanvas(itemId, weaponFrame, flip);
  if (!img) return; // no art for this id — draw nothing
  const grip = gripFor(itemId);

  let handX = x + (off ? (flip ? -off.x : off.x) : anchor.dx);
  let handY = y + (off ? off.y : anchor.dy);
  if (pose === 'attack') {
    // A subtle hand nudge per frame so the swing reads even on minimal art: the
    // 3 drawn frames carry the animation, this traces the arc the hand follows.
    const [sx, sy] = SWING[direction];
    if (weaponFrame === 0) {
      handX -= sx * 0.4; // wind-up: raised and pulled back
      handY -= sy * 0.4 + 5;
    } else if (weaponFrame === 1) {
      handX += sx; // swing: full push toward the facing
      handY += sy;
    } else {
      handX += sx * 0.8; // follow-through: past the strike, settling lower
      handY += sy * 0.8 + 2;
    }
  } else if (frame === 1) {
    handY += 1; // walk bob
  }

  const gripX = flip ? ITEM_W - 1 - grip.x : grip.x;
  ctx.drawImage(img, Math.floor(handX - gripX), Math.floor(handY - grip.y));
}
