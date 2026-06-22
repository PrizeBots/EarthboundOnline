// Custom-entity editing surface: paints a single variable-size frame for a
// standalone custom sprite group (a Source Assets import). Unlike the cast editor
// (16x24 ROM-diff pose sheets), an entity is one image shown for every facing, so
// this mirrors the ITEM editor's model: a standalone paint buffer + the shared
// pixel engine + its own persistence (overrides/custom_sprites.json `png` layer).
// The palette is EXTRACTED from the art into S.palette so painting stays paletted
// (SNES-honest) while letting the artist recolor any swatch to any RGB.
import { getSpriteGroupMeta } from '../SpriteManager';
import {
  getCustomSprite,
  getCustomSpriteImage,
  registerFromCanvas,
  setCustomSpritePng,
  customSpritesDoc,
} from '../CustomSprites';
import { getSpriteName } from '../SpriteNames';
import { parseHexColor, StripCell } from './constants';
import { S } from './state';
import { postOverride } from './saveChannel';
import { clearSelection, renderSwatches, setColor } from './pixelCanvas';

const MAX_PALETTE = 48; // pick-list cap; the buffer itself stays full RGBA
const MAX_DIM = 256; // scale guard — keep frames sane

/** SNES palettes are 5-bit/channel, so genuine colors land on multiples of 8 once
 *  expanded to 8-bit (c5<<3). The ROM→atlas render pipeline leaves ±1 rounding
 *  noise, which surfaces as near-duplicate swatches AND splits the fill tool —
 *  every noisy variant becomes its own palette index, so a fill stops at the seam
 *  between (80,128,96) and (80,128,97). Snapping each channel to the nearest /8
 *  level collapses that noise losslessly (true colors are already on-grid). */
export function snapToSnesGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    d[i] = Math.min(248, Math.round(d[i] / 8) * 8);
    d[i + 1] = Math.min(248, Math.round(d[i + 1] / 8) * 8);
    d[i + 2] = Math.min(248, Math.round(d[i + 2] / 8) * 8);
  }
  ctx.putImageData(img, 0, 0);
}

/** Distinct opaque colors in a frame → a palette (index 0 = transparent). */
export function extractPalette(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): [number, number, number][] {
  const { data } = ctx.getImageData(0, 0, w, h);
  const pal: [number, number, number][] = [[0, 0, 0]]; // 0 = transparent (colorFor returns null)
  const seen = new Set<string>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const key = `${r},${g},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pal.push([r, g, b]);
    if (pal.length >= MAX_PALETTE) break;
  }
  // Always leave a couple of free slots so the artist can add new colors.
  if (pal.length < 4) pal.push([255, 255, 255], [0, 0, 0]);
  return pal;
}

/** Point the engine at the entity buffer (analogous to aliasActiveFrame). */
function aliasBuffer(canvas: HTMLCanvasElement): void {
  S.entityCanvas = canvas;
  S.entityCtx = canvas.getContext('2d', { willReadFrequently: true })!;
  S.entityCtx.imageSmoothingEnabled = false;
}

/** Load a custom entity's current art into the paint buffer + extract its palette.
 *  Async (decodes the png/source image). Caller switches editMode to 'entity'. */
export async function loadEntityIntoBuffer(id: number): Promise<void> {
  if (!getCustomSprite(id)) return;
  const meta = getSpriteGroupMeta(id);
  const w = meta?.width ?? 16;
  const h = meta?.height ?? 16;
  const img = await getCustomSpriteImage(id);
  const buf = document.createElement('canvas');
  buf.width = w;
  buf.height = h;
  const ctx = buf.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, w, h);

  S.entityEditId = id;
  S.groupId = id; // so the picker highlights it + the test pane previews it
  S.entityW = w;
  S.entityH = h;
  S.entityUndo = [];
  aliasBuffer(buf);
  snapToSnesGrid(ctx, w, h); // scrub ROM ±1 rounding near-dupes (clean palette + working fill)
  S.palette = extractPalette(ctx, w, h);
  clearSelection();
  renderSwatches();
  setColor(1);
  updateEntityNote();
  S.dirty = true;
}

function updateEntityNote(suffix = ''): void {
  if (!S.entityNote) return;
  const name = getSpriteName(S.entityEditId) ?? `#${S.entityEditId}`;
  S.entityNote.textContent = `Editing ${name} — ${S.entityW}×${S.entityH}px${suffix}`;
}

/** Re-register the drawable sheet from the live buffer so the world + previews
 *  update as you paint (the entity counterpart of commitItemEdit). */
export function commitEntityEdit(): void {
  if (S.entityCanvas) registerFromCanvas(S.entityEditId, S.entityCanvas);
}

/** Persist the edited frame as the entity's authored png layer + save the doc. */
export function persistEntity(): void {
  if (!S.entityCanvas) return;
  setCustomSpritePng(S.entityEditId, S.entityCanvas.toDataURL('image/png'));
  void postOverride('custom_sprites.json', customSpritesDoc()).catch(() => {
    updateEntityNote(' — save failed (dev save channel?)');
  });
}

/** Scale the current frame by `percent` (nearest-neighbour, keeps pixels crisp).
 *  Resizes the buffer + the registered sheet, so the entity's frame dimensions
 *  change. Palette is unaffected. */
export function scaleEntity(percent: number): void {
  if (!S.entityCanvas || !Number.isFinite(percent) || percent <= 0) return;
  const nw = Math.max(1, Math.min(MAX_DIM, Math.round(S.entityW * (percent / 100))));
  const nh = Math.max(1, Math.min(MAX_DIM, Math.round(S.entityH * (percent / 100))));
  if (nw === S.entityW && nh === S.entityH) return;
  const next = document.createElement('canvas');
  next.width = nw;
  next.height = nh;
  const nctx = next.getContext('2d', { willReadFrequently: true })!;
  nctx.imageSmoothingEnabled = false;
  nctx.drawImage(S.entityCanvas, 0, 0, S.entityW, S.entityH, 0, 0, nw, nh);
  S.entityW = nw;
  S.entityH = nh;
  S.entityUndo = [];
  aliasBuffer(next);
  clearSelection();
  commitEntityEdit();
  persistEntity();
  updateEntityNote(' — scaled');
  S.dirty = true;
}

/** The single entity frame, for the FRAMES strip (entity mode). */
export function entityStripCells(): StripCell[] {
  const buf = S.entityCanvas;
  if (!buf) return [];
  const w = S.entityW;
  const h = S.entityH;
  return [
    {
      label: getSpriteName(S.entityEditId) ?? 'entity',
      w,
      h,
      draw: (ctx, dx, dy, dw, dh) => ctx.drawImage(buf, 0, 0, w, h, dx, dy, dw, dh),
    },
  ];
}

/** Recolor palette entry `i` to `hex` — a palette swap: every pixel of the old
 *  color in the buffer is repainted the new color (the SNES palette-swap model). */
export function recolorEntityPalette(i: number, hex: string): void {
  if (!S.entityCtx || i <= 0 || i >= S.palette.length) return;
  const [or, og, ob] = S.palette[i];
  const [nr, ng, nb] = parseHexColor(hex);
  const img = S.entityCtx.getImageData(0, 0, S.entityW, S.entityH);
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] !== 0 && d[p] === or && d[p + 1] === og && d[p + 2] === ob) {
      d[p] = nr;
      d[p + 1] = ng;
      d[p + 2] = nb;
    }
  }
  S.entityCtx.putImageData(img, 0, 0);
  S.palette[i] = [nr, ng, nb];
  renderSwatches();
  setColor(i);
  commitEntityEdit();
  persistEntity();
  S.dirty = true;
}
