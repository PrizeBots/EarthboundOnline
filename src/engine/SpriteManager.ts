import { loadImage, loadJSON } from './AssetLoader';
import { Direction, SpriteGroupMeta } from '../types';

// Custom composited characters get synthetic group ids from this base up.
export const CUSTOM_GROUP_BASE = 100000;

const spriteImages = new Map<number, CanvasImageSource>();
let spriteMetadata: SpriteGroupMeta[] = [];
const customMetadata = new Map<number, SpriteGroupMeta>();

// Most NPC groups only have the 4 cardinal directions (sheet rows 2-3 empty).
// Like the real game, they fall back to their side-view frames when moving
// diagonally — detected once per sheet at load time.
const diagSupport = new Map<number, boolean>();

const DIAG_REMAP: Partial<Record<Direction, Direction>> = {
  [Direction.NE]: Direction.E,
  [Direction.SE]: Direction.E,
  [Direction.SW]: Direction.W,
  [Direction.NW]: Direction.W,
};

const MIN_DIAG_PIXELS = 20; // per-cell threshold for "real" diagonal art

/** True if all 8 diagonal cells (grid rows 2-3) contain real art. */
export function sheetHasDiagonals(
  img: CanvasImageSource,
  frameW: number,
  frameH: number
): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = frameW * 4;
  canvas.height = frameH * 4;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img as CanvasImageSource, 0, 0);

  for (let row = 2; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const data = ctx.getImageData(col * frameW, row * frameH, frameW, frameH).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0 && ++opaque >= MIN_DIAG_PIXELS) break;
      }
      if (opaque < MIN_DIAG_PIXELS) return false;
    }
  }
  return true;
}

// EarthBound sprite sheet layout: 4 columns x 4 rows
// Verified by inspecting individual sprites at 6x zoom
const DIRECTION_LAYOUT: Record<Direction, [number, number][]> = {
  [Direction.N]:  [[0, 0], [0, 1]],  // pair 0: north (back view)
  [Direction.E]:  [[0, 2], [0, 3]],  // pair 1: east (facing right)
  [Direction.S]:  [[1, 0], [1, 1]],  // pair 2: south (front view)
  [Direction.W]:  [[1, 2], [1, 3]],  // pair 3: west (facing left)
  [Direction.NE]: [[2, 0], [2, 1]],  // pair 4: NE (back, angled right)
  [Direction.SE]: [[2, 2], [2, 3]],  // pair 5: SE (front, angled right)
  [Direction.SW]: [[3, 0], [3, 1]],  // pair 6: SW (front, angled left)
  [Direction.NW]: [[3, 2], [3, 3]],  // pair 7: NW (back, angled left)
};

export async function loadSpriteMetadata(): Promise<void> {
  spriteMetadata = await loadJSON<SpriteGroupMeta[]>('/assets/sprites/metadata.json');
}

export async function loadSpriteGroup(groupId: number): Promise<CanvasImageSource> {
  if (spriteImages.has(groupId)) return spriteImages.get(groupId)!;
  if (groupId >= CUSTOM_GROUP_BASE) {
    // Custom sheets are registered via registerCustomSprite, never fetched.
    throw new Error(`Custom sprite group ${groupId} not registered`);
  }
  const img = await loadImage(`/assets/sprites/${groupId}.png`);
  spriteImages.set(groupId, img);
  const meta = getSpriteGroupMeta(groupId);
  if (meta) diagSupport.set(groupId, sheetHasDiagonals(img, meta.width, meta.height));
  return img;
}

/** Register a runtime-composited sprite sheet (character creator output). */
export function registerCustomSprite(
  groupId: number,
  sheet: CanvasImageSource,
  width: number,
  height: number
): void {
  spriteImages.set(groupId, sheet);
  customMetadata.set(groupId, { id: groupId, width, height, palette: 5 });
  // Composited sheets always have their diagonal cells filled.
  diagSupport.set(groupId, true);
}

export function getSpriteGroupMeta(groupId: number): SpriteGroupMeta | undefined {
  return customMetadata.get(groupId) ?? spriteMetadata.find((s) => s.id === groupId);
}

// Which vertical slice of the sprite to draw. EarthBound's tile priority
// flags can drop just the upper or lower half of a sprite behind the map's
// foreground layer (two stacked OAM sprites on real hardware).
export type SpritePart = 'full' | 'upper' | 'lower';

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  groupId: number,
  direction: Direction,
  frame: number,
  x: number,
  y: number,
  part: SpritePart = 'full'
) {
  const img = spriteImages.get(groupId);
  if (!img) return;

  const meta = getSpriteGroupMeta(groupId);
  if (!meta) return;

  // 4-direction sheets show their side view when moving diagonally.
  const dir = diagSupport.get(groupId) === false
    ? DIAG_REMAP[direction] ?? direction
    : direction;

  const frameIndex = Math.min(frame, 1);
  const [row, col] = DIRECTION_LAYOUT[dir][frameIndex];

  const srcX = col * meta.width;
  let srcY = row * meta.height;

  const splitY = Math.floor(meta.height / 2);
  let sliceH = meta.height;
  let sliceOffset = 0;
  if (part === 'upper') {
    sliceH = splitY;
  } else if (part === 'lower') {
    sliceOffset = splitY;
    sliceH = meta.height - splitY;
  }
  srcY += sliceOffset;

  ctx.drawImage(
    img,
    srcX,
    srcY,
    meta.width,
    sliceH,
    Math.floor(x - meta.width / 2),
    Math.floor(y - meta.height - 1) + sliceOffset,
    meta.width,
    sliceH
  );
}
