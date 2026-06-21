import { loadImage, loadJSON } from './AssetLoader';
import { TILE_SIZE } from '../types';

// Pre-rendered atlas PNGs: keyed by "{mapTilesetId}_{paletteId}"
const atlasCache = new Map<string, HTMLImageElement>();
const fgAtlasCache = new Map<string, HTMLImageElement>();
const loadingAtlases = new Set<string>();

// --- Palette animation (EB "Flash Effect" combos) ---------------------------
// A few map palettes animate by cycling the WHOLE palette through a short frame
// sequence (Fire Spring lava, water, the dept-store escalators, ...). build_atlases
// bakes one atlas per frame ({key}_f{k}.png) and emits atlases/anim.json; here we
// load those frames and swap which atlas a combo draws from, on a shared clock.
interface AnimInfo {
  frames: number;
  durMs: number[]; // per-frame on-screen time (ms)
  cumMs: number[]; // cumulative end time of each frame
  totalMs: number; // full cycle length
  fg: boolean; // combo has a foreground layer (so frames have _fg variants)
}
const animInfo = new Map<string, AnimInfo>();
const frameAtlas = new Map<string, HTMLImageElement[]>(); // bg frame atlases
const frameAtlasFg = new Map<string, HTMLImageElement[]>(); // fg frame atlases
let manifestPromise: Promise<void> | null = null;

interface AnimManifest {
  frameRateHz: number;
  combos: Record<string, { frames: number; durations: number[]; fg: boolean }>;
}

/** Load atlases/anim.json once. Maps each animated combo to its frame timing.
 *  Missing/!ok (no animations baked yet) just leaves the map empty — everything
 *  then renders static, so the game still works before atlases are regenerated. */
function ensureManifest(): Promise<void> {
  if (!manifestPromise) {
    manifestPromise = loadJSON<AnimManifest>('/assets/atlases/anim.json')
      .then((m) => {
        const hz = m.frameRateHz || 60;
        for (const [key, c] of Object.entries(m.combos || {})) {
          const durMs = c.durations.map((d) => (d * 1000) / hz);
          const cumMs: number[] = [];
          let acc = 0;
          for (const d of durMs) {
            acc += d;
            cumMs.push(acc);
          }
          animInfo.set(key, { frames: c.frames, durMs, cumMs, totalMs: acc, fg: c.fg });
        }
      })
      .catch(() => {
        /* no manifest — no animated tiles, render static */
      });
  }
  return manifestPromise;
}

export async function loadAtlas(mapTilesetId: number, paletteId: number): Promise<void> {
  const key = `${mapTilesetId}_${paletteId}`;
  if (atlasCache.has(key) || loadingAtlases.has(key)) return;
  loadingAtlases.add(key);

  try {
    await ensureManifest();
    const [bgImg, fgImg] = await Promise.all([
      loadImage(`/assets/atlases/${key}.png`),
      loadImage(`/assets/atlases/${key}_fg.png`).catch(() => null),
    ]);
    atlasCache.set(key, bgImg);
    if (fgImg) fgAtlasCache.set(key, fgImg);

    // Animated combo: pull in the per-frame atlases too (in the background — the
    // static atlas above already lets the tile draw; frames swap in once ready).
    const info = animInfo.get(key);
    if (info && !frameAtlas.has(key)) void loadFrames(key, info);
  } catch (e) {
    console.warn(`Failed to load atlas ${key}`);
  }
}

async function loadFrames(key: string, info: AnimInfo): Promise<void> {
  const bgJobs: Promise<HTMLImageElement>[] = [];
  const fgJobs: Promise<HTMLImageElement | null>[] = [];
  for (let k = 0; k < info.frames; k++) {
    bgJobs.push(loadImage(`/assets/atlases/${key}_f${k}.png`));
    if (info.fg) fgJobs.push(loadImage(`/assets/atlases/${key}_f${k}_fg.png`).catch(() => null));
  }
  const bg = await Promise.all(bgJobs).catch(() => null);
  if (bg && bg.length === info.frames) frameAtlas.set(key, bg);
  if (info.fg) {
    const fg = await Promise.all(fgJobs).catch(() => null);
    if (fg && fg.every(Boolean)) frameAtlasFg.set(key, fg as HTMLImageElement[]);
  }
}

/** Which animation frame an animated combo shows right now (shared wall clock so
 *  all tiles of a combo — and roughly all clients — animate in lockstep). */
function currentFrame(info: AnimInfo): number {
  const t = Date.now() % info.totalMs;
  for (let k = 0; k < info.cumMs.length; k++) {
    if (t < info.cumMs[k]) return k;
  }
  return info.frames - 1;
}

/** The BG atlas a combo should draw from this instant — the live animation frame
 *  if one is loaded, else the static atlas. */
function bgAtlasFor(key: string): HTMLImageElement | undefined {
  const info = animInfo.get(key);
  if (info) {
    const frames = frameAtlas.get(key);
    if (frames) return frames[currentFrame(info)];
  }
  return atlasCache.get(key);
}

/** The FG atlas a combo should draw from this instant (animation frame or static). */
function fgAtlasFor(key: string): HTMLImageElement | undefined {
  const info = animInfo.get(key);
  if (info && info.fg) {
    const frames = frameAtlasFg.get(key);
    if (frames) return frames[currentFrame(info)];
  }
  return fgAtlasCache.get(key);
}

/**
 * Draw a single 32x32 tile from the background atlas.
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  destX: number,
  destY: number
) {
  const key = `${mapTilesetId}_${paletteId}`;
  const atlas = bgAtlasFor(key);
  if (!atlas) return;

  const cols = 32;
  const srcX = (arrangementId % cols) * TILE_SIZE;
  const srcY = Math.floor(arrangementId / cols) * TILE_SIZE;

  ctx.drawImage(atlas, srcX, srcY, TILE_SIZE, TILE_SIZE, destX, destY, TILE_SIZE, TILE_SIZE);
}

/**
 * Check if a foreground atlas exists for this tileset/palette combo.
 */
export function hasForegroundTile(mapTilesetId: number, paletteId: number): boolean {
  return fgAtlasCache.has(`${mapTilesetId}_${paletteId}`);
}

const MINI = 8; // one minitile = 8x8 px (the SNES BG tile)

/** Draw a single 8x8 minitile (sub-tile of an arrangement) from the BG atlas. */
export function drawMinitile(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  minitileIdx: number, // 0..15, row-major within the 4x4 arrangement
  destX: number,
  destY: number
) {
  const atlas = bgAtlasFor(`${mapTilesetId}_${paletteId}`);
  if (!atlas) return;
  const srcX = (arrangementId % 32) * TILE_SIZE + (minitileIdx % 4) * MINI;
  const srcY = Math.floor(arrangementId / 32) * TILE_SIZE + (minitileIdx >> 2) * MINI;
  ctx.drawImage(atlas, srcX, srcY, MINI, MINI, destX, destY, MINI, MINI);
}

/** Same as drawMinitile but from the FG atlas (transparent except FG pixels). */
export function drawMinitileFg(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  minitileIdx: number,
  destX: number,
  destY: number
) {
  const atlas = fgAtlasFor(`${mapTilesetId}_${paletteId}`);
  if (!atlas) return;
  const srcX = (arrangementId % 32) * TILE_SIZE + (minitileIdx % 4) * MINI;
  const srcY = Math.floor(arrangementId / 32) * TILE_SIZE + (minitileIdx >> 2) * MINI;
  ctx.drawImage(atlas, srcX, srcY, MINI, MINI, destX, destY, MINI, MINI);
}

/**
 * Draw a single 32x32 tile from the foreground atlas (in front of sprites).
 */
export function drawForegroundTile(
  ctx: CanvasRenderingContext2D,
  mapTilesetId: number,
  paletteId: number,
  arrangementId: number,
  destX: number,
  destY: number
) {
  const atlas = fgAtlasFor(`${mapTilesetId}_${paletteId}`);
  if (!atlas) return;

  const cols = 32;
  const srcX = (arrangementId % cols) * TILE_SIZE;
  const srcY = Math.floor(arrangementId / cols) * TILE_SIZE;

  ctx.drawImage(atlas, srcX, srcY, TILE_SIZE, TILE_SIZE, destX, destY, TILE_SIZE, TILE_SIZE);
}
