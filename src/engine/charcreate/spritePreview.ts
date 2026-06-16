/**
 * Shared sprite helpers for the character-creation UI: load the roster + sprite
 * metadata, and draw a character's south-facing frame into a canvas. Used by the
 * slot list, the 3-sprite picker, and the recolor preview.
 *
 * Sheet layout matches CharacterSelect: frames are meta.width × meta.height in a
 * 4-column grid; the south-facing standing frame is row 1, col 0.
 */
import { loadImage, loadJSON } from '../AssetLoader';
import { SpriteGroupMeta } from '../../types';

const SOUTH_ROW = 1;
const SOUTH_COL = 0;

let metaById: Map<number, SpriteGroupMeta> | null = null;
let roster: number[] | null = null;

/** Load (once) the full sprite metadata + the curated char-select roster. */
export async function loadSpriteCatalog(): Promise<void> {
  if (metaById && roster) return;
  const [allMeta, ids] = await Promise.all([
    loadJSON<SpriteGroupMeta[]>('/assets/sprites/metadata.json'),
    loadJSON<number[]>('/assets/sprites/characters.json'),
  ]);
  metaById = new Map(allMeta.map((m) => [m.id, m]));
  // Keep only roster ids we actually have metadata for.
  roster = ids.filter((id) => metaById!.has(id));
}

export function getMeta(spriteGroupId: number): SpriteGroupMeta | undefined {
  return metaById?.get(spriteGroupId);
}

/** Pick `n` distinct random sprite-group ids from the roster. */
export function pickRandomSprites(n: number): number[] {
  const pool = [...(roster ?? [])];
  const out: number[] = [];
  while (out.length < n && pool.length) {
    // Index varies by draw count so we don't need Math.random()-free determinism;
    // this is cosmetic selection, plain Math.random() is fine in the browser.
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** The sprite image for a group: the recolored `appearance` sheet if present,
 *  else the ROM sprite PNG. Both share the source group's frame dimensions. */
export async function loadSpriteImage(
  spriteGroupId: number,
  appearance?: string | null
): Promise<HTMLImageElement> {
  if (appearance) return loadImage(appearance);
  return loadImage(`/assets/sprites/${spriteGroupId}.png`);
}

/**
 * Draw a character's south-facing frame centered in a (cw×ch) canvas region at
 * integer pixel scale. Clears the target rect first. No-op if metadata is absent.
 */
export function drawSouthFrame(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  spriteGroupId: number,
  cw: number,
  ch: number,
  scale: number
): void {
  const meta = metaById?.get(spriteGroupId);
  ctx.clearRect(0, 0, cw, ch);
  if (!meta) return;
  const sx = SOUTH_COL * meta.width;
  const sy = SOUTH_ROW * meta.height;
  const dw = meta.width * scale;
  const dh = meta.height * scale;
  const dx = Math.round((cw - dw) / 2);
  const dy = Math.round((ch - dh) / 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, meta.width, meta.height, dx, dy, dw, dh);
}
