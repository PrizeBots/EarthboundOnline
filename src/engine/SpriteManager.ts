import { loadImage, loadJSON } from './AssetLoader';
import { Direction, SpriteGroupMeta } from '../types';

const spriteImages = new Map<number, HTMLImageElement>();
let spriteMetadata: SpriteGroupMeta[] = [];

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

export async function loadSpriteGroup(groupId: number): Promise<HTMLImageElement> {
  if (spriteImages.has(groupId)) return spriteImages.get(groupId)!;
  const img = await loadImage(`/assets/sprites/${groupId}.png`);
  spriteImages.set(groupId, img);
  return img;
}

export function getSpriteGroupMeta(groupId: number): SpriteGroupMeta | undefined {
  return spriteMetadata.find((s) => s.id === groupId);
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  groupId: number,
  direction: Direction,
  frame: number,
  x: number,
  y: number
) {
  const img = spriteImages.get(groupId);
  if (!img) return;

  const meta = getSpriteGroupMeta(groupId);
  if (!meta) return;

  const frameIndex = Math.min(frame, 1);
  const [row, col] = DIRECTION_LAYOUT[direction][frameIndex];

  const srcX = col * meta.width;
  const srcY = row * meta.height;

  ctx.drawImage(
    img,
    srcX,
    srcY,
    meta.width,
    meta.height,
    Math.floor(x - meta.width / 2),
    Math.floor(y - meta.height),
    meta.width,
    meta.height
  );
}
