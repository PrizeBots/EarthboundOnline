import { loadImage } from './AssetLoader';
import { registerCustomSprite, nextCustomGroupId, reserveCustomGroupId } from './SpriteManager';
import { setSpriteNameOverride } from './SpriteNames';

// Standalone custom sprite groups — entities minted from a ROM SOURCE asset
// (Source Assets tool → "New Entity from this"). Unlike the character creator's
// custom groups (recolored ROM cast / painted sheets), these wrap an arbitrary
// rom_sources graphic as a static, all-directions sprite group so it can carry
// stats in the Entity Manager and render in the world like any other entity.
//
// ROM-pipeline discipline (PokeMMO model): we NEVER bake the pixels into the
// committed override. The file stores only OUR metadata — id, name, and a
// reference to the rom_sources path — and we re-load the image + rebuild the
// sheet at boot. The source graphics are the player's own client-side extraction
// (base layer); this file is the mod layer that points at them.

const SOURCE_BASE = '/assets/rom_sources/';
// Cap a cell so a stray large graphic (a town map) can't blow up the sheet.
// EB actors are <=32px; this leaves headroom for chunky battle sprites.
const MAX_CELL = 64;

export interface CustomSpriteEntry {
  id: number;
  name: string;
  /** Path under /assets/rom_sources/, e.g. "BattleSprites/123.png" — the seed art
   *  (a by-reference pointer into the player's own extraction; the source of truth
   *  until the entity is hand-edited). */
  src: string;
  /** Authored pixel layer (PNG data URL) once edited in the Sprite Editor. When
   *  present this IS the art (already our own hand-painted pixels), so the entity
   *  no longer depends on the ROM source. Sized to the entity's frame (w×h). */
  png?: string;
}

interface CustomSpritesFile {
  version?: number;
  groups?: CustomSpriteEntry[];
}

const entries = new Map<number, CustomSpriteEntry>();

/** Fit the source image into a cell (cap MAX_CELL, keep aspect, integer px). */
function cellSize(iw: number, ih: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_CELL / iw, MAX_CELL / ih);
  return { w: Math.max(1, Math.round(iw * scale)), h: Math.max(1, Math.round(ih * scale)) };
}

/**
 * Build a minimal 2-row sprite sheet (4 cols × 2 rows of w×h cells) from a single
 * source image, painted into every cardinal cell so the entity faces any
 * direction with the same art. Diagonals fall back to the side view (drawSprite's
 * DIAG_REMAP); attack/hurt/climb poses fall back to walk (only 2 rows present).
 */
function buildSheet(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : (src as HTMLCanvasElement).width;
  const sh =
    src instanceof HTMLImageElement ? src.naturalHeight : (src as HTMLCanvasElement).height;
  const sheet = document.createElement('canvas');
  sheet.width = w * 4;
  sheet.height = h * 2;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      ctx.drawImage(src, 0, 0, sw, sh, col * w, row * h, w, h);
    }
  }
  return sheet;
}

/** Load this entry's current art: the authored png layer if present (already at
 *  frame size), else the seed source graphic from rom_sources. */
export async function getCustomSpriteImage(id: number): Promise<HTMLImageElement> {
  const entry = entries.get(id);
  if (!entry) throw new Error(`No custom sprite ${id}`);
  return entry.png ? loadDataUrlImage(entry.png) : loadImage(`${SOURCE_BASE}${entry.src}`);
}

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('bad custom-sprite png'));
    img.src = dataUrl;
  });
}

/** Load + register one entry's art as a drawable custom group. An authored png
 *  layer is taken at its native size (the artist's frame); a raw source graphic is
 *  capped (cellSize) so a stray large image can't blow up the sheet. */
async function register(entry: CustomSpriteEntry): Promise<void> {
  if (entry.png) {
    const img = await loadDataUrlImage(entry.png);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    registerCustomSprite(entry.id, buildSheet(img, w, h), w, h);
  } else {
    const img = await loadImage(`${SOURCE_BASE}${entry.src}`);
    const { w, h } = cellSize(img.naturalWidth, img.naturalHeight);
    registerCustomSprite(entry.id, buildSheet(img, w, h), w, h);
  }
  setSpriteNameOverride(entry.id, entry.name);
}

/** The authored entry for a custom sprite id, or undefined. */
export function getCustomSprite(id: number): CustomSpriteEntry | undefined {
  return entries.get(id);
}

/** Re-register a custom group's drawable sheet from an edited frame canvas (the
 *  Sprite Editor's live buffer) — no cap, the artist chose the size. Updates the
 *  world/preview immediately; caller persists via setCustomSpritePng + save. */
export function registerFromCanvas(id: number, frame: HTMLCanvasElement): void {
  registerCustomSprite(id, buildSheet(frame, frame.width, frame.height), frame.width, frame.height);
}

/** Store the authored pixel layer for a custom sprite (PNG data URL). After this,
 *  the entity's art is hand-painted pixels, not the ROM source reference. */
export function setCustomSpritePng(id: number, dataUrl: string): void {
  const entry = entries.get(id);
  if (entry) entry.png = dataUrl;
}

/**
 * Load every authored custom sprite group and register it for drawing. Call once
 * at boot AFTER loadNameOverrides (we set name overrides for each). Missing file
 * or a broken source image is non-fatal — that group is just skipped.
 */
export async function loadCustomSprites(): Promise<void> {
  entries.clear();
  // Direct no-store fetch (NOT loadJSON): this is a live-authored override, so a
  // cached pre-creation miss must never shadow the file once it exists — the same
  // reason editor saveOverride/loadOverride bypass the cache. A 404 (nothing
  // authored) or HTML SPA fallback fails the ok/json guard → no custom sprites.
  const doc = await fetch('/overrides/custom_sprites.json', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<CustomSpritesFile>) : null))
    .catch(() => null);
  for (const e of doc?.groups ?? []) {
    if (!e || typeof e.id !== 'number' || !e.src) continue;
    reserveCustomGroupId(e.id); // keep the minter above persisted ids
    entries.set(e.id, {
      id: e.id,
      name: e.name ?? `Custom ${e.id}`,
      src: e.src,
      ...(e.png ? { png: e.png } : {}),
    });
    try {
      await register(entries.get(e.id)!);
    } catch {
      // Unreadable source graphic — keep the metadata, skip the art.
    }
  }
}

/**
 * Mint a new custom entity sprite from a rom_sources path: allocate an id,
 * register the art now (so it's immediately drawable), set its display name, and
 * record the entry. The caller persists the doc via saveOverride('custom_sprites.json').
 * Returns the new sprite-group id, or throws if the source image can't load.
 */
export async function addCustomSprite(name: string, src: string): Promise<number> {
  const id = nextCustomGroupId();
  const entry: CustomSpriteEntry = { id, name: name.trim() || `Custom ${id}`, src };
  await register(entry); // throws on a bad image before we record anything
  entries.set(id, entry);
  return id;
}

/** All minted custom sprite-group ids (for Entity Manager enumeration). */
export function customSpriteGroupIds(): number[] {
  return [...entries.keys()];
}

/** The persistable document (OUR metadata only — id/name/src, never pixels). */
export function customSpritesDoc(): { version: number; groups: CustomSpriteEntry[] } {
  return { version: 1, groups: [...entries.values()] };
}
