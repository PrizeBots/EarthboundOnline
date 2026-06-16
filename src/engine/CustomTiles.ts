// Custom author-drawn 8x8 tiles — the pixels the ROM doesn't have. Composites and
// stamps reference them through the SAME minitile-ref integer as ROM minitiles,
// distinguished by a large CUSTOM_REF_BASE offset (ROM packRef values top out
// ~8.4M, so 100M is safely above them). Each tile is a flat RGBA pixel grid
// (8x8 = 256 values, 0–255), stored self-contained so rendering needs no runtime
// palette (the engine only has pre-colored atlases).
//
// Stored in overrides/custom_tiles.json (a SHIPPED override, like rooms.json) so
// custom rooms render in-game, not just in the editor. SNES note: these are RGBA
// now; quantise to 4bpp + a CGRAM subpalette at ROM-build time.

export const CUSTOM_REF_BASE = 100_000_000;

export function isCustomRef(n: number): boolean {
  return n >= CUSTOM_REF_BASE;
}
export function customRefId(n: number): number {
  return n - CUSTOM_REF_BASE;
}
export function customRef(id: number): number {
  return CUSTOM_REF_BASE + id;
}

interface CustomTilesDoc {
  version: number;
  tiles: Record<string, number[]>; // id -> 256 RGBA values (8x8, row-major)
}

const pixels = new Map<number, number[]>(); // id -> 256 RGBA
const rendered = new Map<number, HTMLCanvasElement>(); // id -> cached 8x8 canvas
let nextId = 1;

/** Load the custom-tile library (overrides/custom_tiles.json). 404 = none yet. */
export async function loadCustomTiles(): Promise<void> {
  let doc: CustomTilesDoc | null = null;
  try {
    const res = await fetch('/overrides/custom_tiles.json', { cache: 'no-store' });
    if (res.ok) doc = (await res.json()) as CustomTilesDoc;
  } catch {
    /* none authored yet */
  }
  pixels.clear();
  rendered.clear();
  nextId = 1;
  for (const [k, px] of Object.entries(doc?.tiles ?? {})) {
    const id = Number(k);
    pixels.set(id, px);
    nextId = Math.max(nextId, id + 1);
  }
}

function canvasFor(id: number): HTMLCanvasElement | null {
  const cached = rendered.get(id);
  if (cached) return cached;
  const px = pixels.get(id);
  if (!px) return null;
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(8, 8);
  for (let i = 0; i < 256; i++) img.data[i] = px[i] ?? 0;
  ctx.putImageData(img, 0, 0);
  rendered.set(id, c);
  return c;
}

/** Draw a custom 8x8 tile at screen (dx,dy). Camera zoom is applied by the ctx. */
export function drawCustomMinitile(
  ctx: CanvasRenderingContext2D,
  id: number,
  dx: number,
  dy: number
): void {
  const c = canvasFor(id);
  if (c) ctx.drawImage(c, dx, dy);
}

// ── editor-facing helpers ────────────────────────────────────────────────
export function getCustomPixels(id: number): number[] | undefined {
  return pixels.get(id);
}

/** Add a new custom tile from 256 RGBA values; returns its stable id. */
export function mintCustomTile(px: number[]): number {
  const id = nextId++;
  pixels.set(id, px.slice());
  rendered.delete(id);
  return id;
}

/** Serialize the whole library for saving to overrides/custom_tiles.json. */
export function customTilesDoc(): CustomTilesDoc {
  return {
    version: 1,
    tiles: Object.fromEntries([...pixels].map(([id, px]) => [String(id), px])),
  };
}
