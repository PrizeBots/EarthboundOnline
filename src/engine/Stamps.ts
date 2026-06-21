// Shared tile-stamp library — the single source of truth for Room Builder stamps,
// used by BOTH the Room Builder tool (sample/paint/folders) and the Sprite Editor
// (pixel cleanup of a stamp). Persists to the DB (world_docs['stamps']) via Auth;
// falls back to the legacy overrides/stamps.json once. Stamps store pure
// arrangement/minitile INDICES (never ROM pixels); an EDITED stamp slices into
// our own custom-tile minitiles (CustomTiles), so it stays commit-safe.
import { loadWorldDoc, saveWorldDoc } from './Auth';
import { loadAtlas, drawTile, drawMinitile } from './TilesetManager';
import { unpackRef } from './CompositeTiles';
import {
  isCustomRef,
  customRefId,
  customRef,
  mintCustomTile,
  setCustomTile,
  drawCustomMinitile,
} from './CustomTiles';
import { TILE_SIZE, MINITILE_SIZE } from '../types';

export interface Stamp {
  id: string;
  label: string;
  w: number; // bounding size in TILES (arrangement stamps)
  h: number;
  tilesetId: number;
  paletteId: number;
  tiles: number[]; // arrangement grid (w*h), empty for minitile stamps
  // Minitile stamp: a grid of 8x8 pieces. refs are packed minitile refs OR custom
  // refs (CUSTOM_REF_BASE+id); −1 = empty/transparent (skipped on paint).
  mini?: boolean;
  mw?: number;
  mh?: number;
  refs?: number[];
  folder?: string; // parent folder id; absent = Uncategorized
}
export interface StampFolder {
  id: string;
  name: string;
}
export interface StampsDoc {
  version: number;
  stamps: Stamp[];
  folders?: StampFolder[];
}

let _stamps: Stamp[] = [];
let _folders: StampFolder[] = [];

export function getStamps(): Stamp[] {
  return _stamps;
}
export function getStampFolders(): StampFolder[] {
  return _folders;
}
export function setStamps(s: Stamp[]): void {
  _stamps = s;
}
export function setStampFolders(f: StampFolder[]): void {
  _folders = f;
}
export function getStamp(id: string): Stamp | undefined {
  return _stamps.find((s) => s.id === id);
}

/** Load the library from the DB (falling back to the legacy override file once).
 *  Engine-only — no editor imports — so the Sprite Editor can load it too. */
export async function loadStamps(): Promise<void> {
  let doc = await loadWorldDoc<StampsDoc>('stamps').catch(() => null);
  if (!doc?.stamps?.length && !doc?.folders?.length) {
    doc = await fetch('/overrides/stamps.json', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<StampsDoc>) : null))
      .catch(() => null);
  }
  if (doc?.stamps) _stamps = doc.stamps;
  if (doc?.folders) _folders = doc.folders;
}

/** Persist the current library to the DB. */
export async function saveStamps(): Promise<void> {
  await saveWorldDoc('stamps', { version: 2, stamps: _stamps, folders: _folders });
}

/** Pixel dimensions of a stamp's rendered art. */
export function stampPxSize(s: Stamp): { w: number; h: number } {
  return s.mini
    ? { w: (s.mw ?? 1) * MINITILE_SIZE, h: (s.mh ?? 1) * MINITILE_SIZE }
    : { w: s.w * TILE_SIZE, h: s.h * TILE_SIZE };
}

/** Render a stamp to a fresh transparent canvas (awaits the source atlases).
 *  Shared by the Room Builder thumbnail/pixel-edit paths and the Sprite Editor. */
export async function renderStampToCanvas(s: Stamp): Promise<HTMLCanvasElement> {
  const { w: pxW, h: pxH } = stampPxSize(s);
  if (s.mini) {
    const combos = new Set(
      (s.refs ?? [])
        .filter((n) => n >= 0 && !isCustomRef(n))
        .map((n) => {
          const r = unpackRef(n);
          return `${r.ts},${r.pal}`;
        })
    );
    await Promise.all(
      [...combos].map((k) => {
        const [ts, pal] = k.split(',').map(Number);
        return loadAtlas(ts, pal);
      })
    );
  } else {
    await loadAtlas(s.tilesetId, s.paletteId);
  }
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, pxW);
  cv.height = Math.max(1, pxH);
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  c.imageSmoothingEnabled = false;
  if (s.mini) {
    const mw = s.mw ?? 1;
    const mh = s.mh ?? 1;
    const refs = s.refs ?? [];
    for (let ly = 0; ly < mh; ly++) {
      for (let lx = 0; lx < mw; lx++) {
        const n = refs[ly * mw + lx] ?? -1;
        if (n < 0) continue;
        if (isCustomRef(n))
          drawCustomMinitile(c, customRefId(n), lx * MINITILE_SIZE, ly * MINITILE_SIZE);
        else {
          const r = unpackRef(n);
          drawMinitile(c, r.ts, r.pal, r.arr, r.mi, lx * MINITILE_SIZE, ly * MINITILE_SIZE);
        }
      }
    }
  } else {
    for (let ly = 0; ly < s.h; ly++) {
      for (let lx = 0; lx < s.w; lx++) {
        drawTile(
          c,
          s.tilesetId,
          s.paletteId,
          s.tiles[ly * s.w + lx] ?? 0,
          lx * TILE_SIZE,
          ly * TILE_SIZE
        );
      }
    }
  }
  return cv;
}

/**
 * Slice an edited W×H RGBA frame into 8×8 custom-tile minitiles and write them
 * onto `target` IN PLACE (keeping id/label/folder) — converting it to a minitile
 * stamp. A FULLY-TRANSPARENT 8×8 block becomes an empty ref (−1) so it drops out
 * when painted (the floor shows through) instead of an opaque-void tile. When the
 * grid layout is unchanged it REUSES the target's existing custom-tile ids (so
 * repeated saves don't accumulate orphans); otherwise it mints. Mints/updates in
 * the registry; the CALLER persists custom_tiles.json + the stamp library.
 */
export function applyEditedPixels(
  target: Stamp,
  W: number,
  H: number,
  rgba: Uint8ClampedArray
): void {
  const mw = Math.max(1, Math.round(W / MINITILE_SIZE));
  const mh = Math.max(1, Math.round(H / MINITILE_SIZE));
  // Reuse prior custom-tile ids only when the grid layout matches.
  const prior = target.mini && target.mw === mw && target.mh === mh ? (target.refs ?? []) : [];
  const refs: number[] = new Array(mw * mh);
  for (let ty = 0; ty < mh; ty++) {
    for (let tx = 0; tx < mw; tx++) {
      const px = new Array<number>(MINITILE_SIZE * MINITILE_SIZE * 4);
      let opaque = false;
      for (let y = 0; y < MINITILE_SIZE; y++) {
        for (let x = 0; x < MINITILE_SIZE; x++) {
          const si = ((ty * MINITILE_SIZE + y) * W + (tx * MINITILE_SIZE + x)) * 4;
          const di = (y * MINITILE_SIZE + x) * 4;
          px[di] = rgba[si];
          px[di + 1] = rgba[si + 1];
          px[di + 2] = rgba[si + 2];
          px[di + 3] = rgba[si + 3];
          if (rgba[si + 3] >= 128) opaque = true;
        }
      }
      const i = ty * mw + tx;
      if (!opaque) {
        refs[i] = -1;
        continue;
      }
      const pr = prior[i];
      if (pr !== undefined && pr >= 0 && isCustomRef(pr)) {
        setCustomTile(customRefId(pr), px); // reuse the existing tile id
        refs[i] = pr;
      } else {
        refs[i] = customRef(mintCustomTile(px));
      }
    }
  }
  target.mini = true;
  target.mw = mw;
  target.mh = mh;
  target.refs = refs;
  target.w = Math.max(1, Math.ceil(mw / 4));
  target.h = Math.max(1, Math.ceil(mh / 4));
  target.tiles = [];
}
