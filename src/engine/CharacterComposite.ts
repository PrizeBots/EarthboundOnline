import { loadImage, loadJSON } from './AssetLoader';
import { registerCustomSprite, CUSTOM_GROUP_BASE } from './SpriteManager';
import { APPEARANCE_CATEGORIES, AppearanceCategory, CharacterAppearance } from '../types';

export interface PartInfo {
  id: number;
  source: number; // ROM sprite group the part was sliced from
  diag: boolean;  // has true 3/4-view diagonal frames
  climb: boolean; // has real ladder/rope climb frames (playable cast only)
}

const FRAME_W = 16;
const FRAME_H = 24;
const SHEET_W = 64;
const SHEET_H = 120; // 4 walk rows + climb row (ladder f0/f1, rope f0/f1)
const CLIMB_ROW = 4;

// Composite order, bottom -> top. The skin mannequin (head+body) goes under
// clothes; face features and hair/hats go on top.
const LAYER_ORDER: AppearanceCategory[] = [
  'head',
  'body',
  'shoes',
  'pants',
  'shirt',
  'face',
  'hair',
];

// 8-direction parts (main cast) carry true diagonal art in grid rows 2-3;
// 4-direction parts leave those cells empty. Mixing the two misaligns, so a
// composite uses true diagonals only when EVERY part has them — otherwise all
// diagonal cells are filled from the E/W cells: [destRow, destCol, srcRow, srcCol].
const DIAG_FILL: [number, number, number, number][] = [
  [2, 0, 0, 2], [2, 1, 0, 3], // NE <- E
  [2, 2, 0, 2], [2, 3, 0, 3], // SE <- E
  [3, 0, 1, 2], [3, 1, 1, 3], // SW <- W
  [3, 2, 1, 2], [3, 3, 1, 3], // NW <- W
];

// Same all-or-nothing rule for the climb row: only the playable cast has
// real ladder/rope art, so parts without it get their climb cells filled
// from the North (back-view) walk pair: [destCol, srcRow, srcCol].
const CLIMB_FILL: [number, number, number][] = [
  [0, 0, 0], [1, 0, 1], // ladder <- N
  [2, 0, 0], [3, 0, 1], // rope <- N
];

let catalog: Record<AppearanceCategory, PartInfo[]> | null = null;
let shadowImg: HTMLImageElement | null = null;

// appearance key -> synthetic sprite group id (shared between identical looks)
const registeredAppearances = new Map<string, number>();
let nextCustomId = CUSTOM_GROUP_BASE;

export async function loadPartCatalog(): Promise<void> {
  if (catalog) return;
  [catalog, shadowImg] = await Promise.all([
    loadJSON<Record<AppearanceCategory, PartInfo[]>>('/assets/charparts/catalog.json'),
    loadImage('/assets/charparts/shadow.png'),
  ]);
}

export function getPartCatalog(): Record<AppearanceCategory, PartInfo[]> {
  if (!catalog) throw new Error('Part catalog not loaded');
  return catalog;
}

/** Sentinel: no part selected for a category — nothing is drawn for it. */
export const NO_PART = -1;

/** Creator starting point: nothing selected, nothing drawn. */
export function emptyAppearance(): CharacterAppearance {
  return {
    head: NO_PART,
    body: NO_PART,
    shirt: NO_PART,
    pants: NO_PART,
    shoes: NO_PART,
    face: NO_PART,
    hair: NO_PART,
  };
}

export function appearanceKey(app: CharacterAppearance): string {
  return APPEARANCE_CATEGORIES.map((c) => app[c]).join(',');
}

/** Validate an appearance received from the network (NO_PART allowed). */
export function isValidAppearance(app: unknown): app is CharacterAppearance {
  if (!app || typeof app !== 'object' || !catalog) return false;
  return APPEARANCE_CATEGORIES.every((c) => {
    const v = (app as Record<string, unknown>)[c];
    return typeof v === 'number' && Number.isInteger(v) && v >= NO_PART && v < catalog![c].length;
  });
}

async function loadPart(category: AppearanceCategory, id: number): Promise<HTMLImageElement> {
  return loadImage(`/assets/charparts/${category}/${id}.png`);
}

/**
 * Composite an appearance into a 64x96 sprite sheet canvas (same 4x4 frame
 * layout as the ROM sheets, drop shadow included).
 *
 * `isolate` renders ONLY the named category's part (no shadow, no other
 * layers) — the creator's frame grid and preview browse parts in isolation.
 */
export async function compositeAppearance(
  app: CharacterAppearance,
  isolate: AppearanceCategory | null = null
): Promise<HTMLCanvasElement> {
  await loadPartCatalog();
  const cat = catalog!;

  // Only categories with an actual selection get drawn — "none" draws nothing.
  const selected = LAYER_ORDER.filter((c) => app[c] >= 0);
  const partInfo = (c: AppearanceCategory) => cat[c][Math.min(app[c], cat[c].length - 1)];
  const images = new Map<AppearanceCategory, HTMLImageElement>();
  await Promise.all(
    selected.map(async (c) => {
      images.set(c, await loadPart(c, Math.min(app[c], cat[c].length - 1)));
    })
  );
  const useTrueDiag = selected.every((c) => partInfo(c)?.diag);
  const useTrueClimb = selected.every((c) => partInfo(c)?.climb);

  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const drawLayer = (
    img: CanvasImageSource,
    trueDiag: boolean,
    climb: 'sheet' | 'fill' | 'none'
  ) => {
    // Cardinal walk rows always come straight from the sheet.
    ctx.drawImage(img, 0, 0, SHEET_W, FRAME_H * 2, 0, 0, SHEET_W, FRAME_H * 2);
    if (trueDiag) {
      ctx.drawImage(
        img,
        0, FRAME_H * 2, SHEET_W, FRAME_H * 2,
        0, FRAME_H * 2, SHEET_W, FRAME_H * 2
      );
    } else {
      for (const [dr, dc, sr, sc] of DIAG_FILL) {
        ctx.drawImage(
          img,
          sc * FRAME_W, sr * FRAME_H, FRAME_W, FRAME_H,
          dc * FRAME_W, dr * FRAME_H, FRAME_W, FRAME_H
        );
      }
    }
    if (climb === 'sheet') {
      ctx.drawImage(
        img,
        0, CLIMB_ROW * FRAME_H, SHEET_W, FRAME_H,
        0, CLIMB_ROW * FRAME_H, SHEET_W, FRAME_H
      );
    } else if (climb === 'fill') {
      for (const [dc, sr, sc] of CLIMB_FILL) {
        ctx.drawImage(
          img,
          sc * FRAME_W, sr * FRAME_H, FRAME_W, FRAME_H,
          dc * FRAME_W, CLIMB_ROW * FRAME_H, FRAME_W, FRAME_H
        );
      }
    }
  };

  if (isolate) {
    // The creator grid shows one part by itself — use its OWN frame flags so
    // real diagonal/climb art is visible even before other parts match it.
    const img = images.get(isolate);
    if (img) {
      const info = partInfo(isolate);
      drawLayer(img, !!info?.diag, info?.climb ? 'sheet' : 'fill');
    }
  } else {
    // No drop shadow in the climb row — climbers cast none.
    if (selected.length > 0) drawLayer(shadowImg!, true, 'none');
    for (const c of LAYER_ORDER) {
      const img = images.get(c);
      if (img) drawLayer(img, useTrueDiag, useTrueClimb ? 'sheet' : 'fill');
    }
  }

  return canvas;
}

/**
 * Composite an appearance and register it as a drawable sprite group.
 * Identical appearances share one synthetic group id.
 */
export async function registerCustomAppearance(app: CharacterAppearance): Promise<number> {
  await loadPartCatalog();
  if (!isValidAppearance(app)) {
    throw new Error('Invalid appearance');
  }

  const key = appearanceKey(app);
  const existing = registeredAppearances.get(key);
  if (existing !== undefined) return existing;

  const canvas = await compositeAppearance(app);
  const groupId = nextCustomId++;
  registeredAppearances.set(key, groupId);
  registerCustomSprite(groupId, canvas, FRAME_W, FRAME_H);
  return groupId;
}
