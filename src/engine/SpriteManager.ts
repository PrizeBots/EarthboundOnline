import { loadImage, loadJSON } from './AssetLoader';
import { generatePoseSheet, POSE_SHEET_ROWS } from './PoseGen';
import { Direction, Pose, SpriteGroupMeta } from '../types';

// Custom composited characters get synthetic group ids from this base up.
export const CUSTOM_GROUP_BASE = 100000;

const spriteImages = new Map<number, CanvasImageSource>();
let spriteMetadata: SpriteGroupMeta[] = [];
const customMetadata = new Map<number, SpriteGroupMeta>();

// Most NPC groups only have the 4 cardinal directions (sheet rows 2-3 empty).
// Like the real game, they fall back to their side-view frames when moving
// diagonally — detected once per sheet at load time.
const diagSupport = new Map<number, boolean>();

// How many frame rows each sheet actually has. ROM sheets have 4 (walk only);
// v1 custom sheets have 5 (+ climb); v2 have 10 (+ attack rows 5-8 and a
// single-row 4-cardinal hurt at row 9); v3 have 13 (hurt expanded to rows
// 9-12, full 8-dir x 2-frame). Poses a sheet lacks fall back to walk frames.
const sheetRowCount = new Map<number, number>();
const CLIMB_ROW = 4;
const ATTACK_ROW_OFFSET = 5; // attack rows mirror walk rows 0-3, shifted down
const HURT_ROW_OFFSET = 9;   // v3 hurt rows 9-12, same layout as walk/attack
const HURT_ROW_LEGACY = 9;   // v2 single-row hurt (4 cardinals)

// v2 legacy hurt row cells, one flinch frame per cardinal: | N | E | S | W |
const HURT_COL: Partial<Record<Direction, number>> = {
  [Direction.N]: 0,
  [Direction.E]: 1,
  [Direction.S]: 2,
  [Direction.W]: 3,
};

function sourceHeight(src: CanvasImageSource): number {
  return src instanceof HTMLImageElement ? src.naturalHeight : (src as HTMLCanvasElement).height;
}

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

// --- Authored sprite-frame overrides (NPC Sprite Animator) -----------------
// public/overrides/sprites.json: per-group PATCHES over the generated
// attack/hurt bands — `paint` (pixels the admin painted) and `erase` (mask of
// pixels forced transparent), each a PNG covering rows 5-12 of the v3 layout.
// Only hand-painted diffs are stored, never ROM or ROM-derived pixels: the
// base bands regenerate from the player's own extraction (PoseGen) at load.
export interface SpriteOverrides {
  version: number;
  groups?: Record<string, { paint?: string; erase?: string }>;
}

let spriteOverrides: SpriteOverrides | null = null;
let spriteOverridesLoading: Promise<void> | null = null;
// Original ROM sheets + pristine generated sheets, for the animator's diffing.
const romImages = new Map<number, HTMLImageElement>();

function loadDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('bad override image'));
    img.src = dataUrl;
  });
}

async function applySpritePatch(groupId: number, sheet: HTMLCanvasElement, frameH: number): Promise<void> {
  const ov = spriteOverrides?.groups?.[String(groupId)];
  if (!ov) return;
  const ctx = sheet.getContext('2d')!;
  const bandY = frameH * ATTACK_ROW_OFFSET;
  try {
    if (ov.erase) {
      const erase = await loadDataUrl(ov.erase);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(erase, 0, bandY);
      ctx.restore();
    }
    if (ov.paint) {
      const paint = await loadDataUrl(ov.paint);
      ctx.drawImage(paint, 0, bandY);
    }
  } catch {
    // Malformed override — generated bands still stand.
  }
}

export async function loadSpriteGroup(groupId: number): Promise<CanvasImageSource> {
  if (spriteImages.has(groupId)) return spriteImages.get(groupId)!;
  if (groupId >= CUSTOM_GROUP_BASE) {
    // Custom sheets are registered via registerCustomSprite, never fetched.
    throw new Error(`Custom sprite group ${groupId} not registered`);
  }
  if (!spriteOverridesLoading) {
    spriteOverridesLoading = loadJSON<SpriteOverrides>('/overrides/sprites.json')
      .then((ov) => {
        spriteOverrides = ov;
      })
      .catch(() => {
        spriteOverrides = null; // nothing authored yet
      });
  }
  const [img] = await Promise.all([
    loadImage(`/assets/sprites/${groupId}.png`),
    spriteOverridesLoading,
  ]);
  const meta = getSpriteGroupMeta(groupId);
  if (!meta) {
    spriteImages.set(groupId, img);
    return img;
  }
  romImages.set(groupId, img);
  diagSupport.set(groupId, sheetHasDiagonals(img, meta.width, meta.height));

  // Every group gets a full 13-row pose sheet: ROM walk/climb rows + attack
  // and hurt bands generated from the standing frames (PoseGen), with any
  // authored Animator patches composited on top. NPCs/enemies can then play
  // every pose the player can.
  const srcRows = Math.floor(sourceHeight(img) / meta.height);
  const sheet = generatePoseSheet(img, meta.width, meta.height, srcRows);
  await applySpritePatch(groupId, sheet, meta.height);
  spriteImages.set(groupId, sheet);
  sheetRowCount.set(groupId, POSE_SHEET_ROWS);
  return sheet;
}

/** The live composited sheet canvas for a loaded ROM group (animator edits
 *  paint directly into this — the world shows changes immediately). */
export function getLiveSheet(groupId: number): HTMLCanvasElement | null {
  const img = spriteImages.get(groupId);
  return img instanceof HTMLCanvasElement ? img : null;
}

/** Pristine generated sheet (no authored patches), for override diffing. */
export function getPristineSheet(groupId: number): HTMLCanvasElement | null {
  const rom = romImages.get(groupId);
  const meta = getSpriteGroupMeta(groupId);
  if (!rom || !meta) return null;
  const srcRows = Math.floor(sourceHeight(rom) / meta.height);
  return generatePoseSheet(rom, meta.width, meta.height, srcRows);
}

/** Register a runtime-built sprite sheet (sprite editor output / previews). */
export function registerCustomSprite(
  groupId: number,
  sheet: CanvasImageSource,
  width: number,
  height: number
): void {
  spriteImages.set(groupId, sheet);
  customMetadata.set(groupId, { id: groupId, width, height, palette: 5 });
  // Editor sheets start from Ness, who has real diagonal art.
  diagSupport.set(groupId, true);
  sheetRowCount.set(groupId, Math.floor(sourceHeight(sheet) / height));
}

// Pixel-edited character sheets, 16x24 frames, 4 columns. v3 = 13 rows
// (walk 0-3, climb 4, attack 5-8, hurt 9-12); v2 = 10 rows (single-row hurt);
// legacy v1 = 5 rows (walk + climb).
const SHEET_FRAME_W = 16;
const SHEET_FRAME_H = 24;
const SHEET_W = SHEET_FRAME_W * 4;
const SHEET_ROWS_V1 = 5;
const SHEET_ROWS_V2 = 10;
const SHEET_ROWS_V3 = 13;
// A 64x312 indexed PNG is ~3-6KB; anything near this cap isn't a real sheet.
const MAX_SHEET_DATA_URL = 64 * 1024;

// sheet data URL -> synthetic group id (identical sheets share one id)
const registeredSheets = new Map<string, number>();
let nextCustomId = CUSTOM_GROUP_BASE;

/**
 * Register a pixel-edited character sheet (the sprite editor's output, or a
 * remote player's appearance from the network) as a drawable sprite group.
 */
export async function registerCustomSheet(dataUrl: string): Promise<number> {
  const existing = registeredSheets.get(dataUrl);
  if (existing !== undefined) return existing;
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_SHEET_DATA_URL) {
    throw new Error('Invalid character sheet');
  }
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Unreadable character sheet'));
    img.src = dataUrl;
  });
  const validHeights = [SHEET_ROWS_V1, SHEET_ROWS_V2, SHEET_ROWS_V3].map((r) => r * SHEET_FRAME_H);
  if (img.width !== SHEET_W || !validHeights.includes(img.height)) {
    throw new Error(`Character sheet must be ${SHEET_W}px wide with 5, 10, or 13 frame rows`);
  }
  const groupId = nextCustomId++;
  registeredSheets.set(dataUrl, groupId);
  registerCustomSprite(groupId, img, SHEET_FRAME_W, SHEET_FRAME_H);
  // The editor lets players erase the diagonal cells — detect like ROM sheets
  // so a 4-direction custom character falls back to side views.
  diagSupport.set(groupId, sheetHasDiagonals(img, SHEET_FRAME_W, SHEET_FRAME_H));
  return groupId;
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
  part: SpritePart = 'full',
  pose: Pose = 'walk'
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
  const rows = sheetRowCount.get(groupId) ?? 4;

  // Pose -> sheet cell. Sheets without the pose's rows (ROM sprites, legacy
  // custom sheets) fall back to the walk frame so everyone stays drawable.
  let row: number;
  let col: number;
  if (pose === 'attack' && rows >= SHEET_ROWS_V2) {
    [row, col] = DIRECTION_LAYOUT[dir][frameIndex];
    row += ATTACK_ROW_OFFSET;
  } else if (pose === 'hurt' && rows >= SHEET_ROWS_V3) {
    // v3: full 8-direction, 2-frame hurt sharing the walk layout.
    [row, col] = DIRECTION_LAYOUT[dir][frameIndex];
    row += HURT_ROW_OFFSET;
  } else if (pose === 'hurt' && rows >= SHEET_ROWS_V2) {
    // v2 legacy: one flinch frame per cardinal; diagonals use their side view.
    row = HURT_ROW_LEGACY;
    col = HURT_COL[DIAG_REMAP[dir] ?? dir]!;
  } else if (pose === 'climb' && rows > CLIMB_ROW) {
    row = CLIMB_ROW;
    col = frameIndex; // ladder pair; rope pair (cols 2-3) not wired up yet
  } else {
    [row, col] = DIRECTION_LAYOUT[dir][frameIndex];
  }

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
