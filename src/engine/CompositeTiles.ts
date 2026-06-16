import { drawMinitile, drawMinitileFg } from './TilesetManager';
import { isCustomRef, customRefId, drawCustomMinitile } from './CustomTiles';
import { MINITILE_SIZE } from '../types';

// Composite tiles — author-built 32x32 tiles assembled from individual 8x8
// MINITILES sampled from anywhere (the Room Builder's sub-tile stamping). They
// let rooms hold detail finer than one ROM arrangement while still rendering and
// colliding through the normal per-cell pipeline.
//
// A custom-room cell normally holds a ROM arrangement id (0..1023). A cell whose
// id is >= COMPOSITE_BASE is a COMPOSITE: its 16 minitiles are looked up here and
// drawn individually, each from its OWN source tileset/palette atlas. So a
// composite can mix minitiles from different tilesets — exactly what sub-tile
// authoring needs. On real SNES the 8x8 minitile IS the BG tile, so this ports
// cleanly (each composite becomes 16 BG-tilemap entries / one arrangement slot).
//
// A minitile reference is packed into one integer (compact JSON, no per-cell
// objects): ts(tileset) · pal(palette) · arr(arrangement) · mi(0..15). -1 = empty.

export const COMPOSITE_BASE = 1_000_000; // cell ids at/above this are composites
const EMPTY = -1;

export function isComposite(id: number): boolean {
  return id >= COMPOSITE_BASE;
}

export function packRef(ts: number, pal: number, arr: number, mi: number): number {
  return ((ts * 16 + pal) * 1024 + arr) * 16 + mi;
}

export interface MinitileRef {
  ts: number;
  pal: number;
  arr: number;
  mi: number;
}

export function unpackRef(n: number): MinitileRef {
  const mi = n % 16;
  let r = (n - mi) / 16;
  const arr = r % 1024;
  r = (r - arr) / 1024;
  const pal = r % 16;
  const ts = (r - pal) / 16;
  return { ts, pal, arr, mi };
}

// id -> 16 packed minitile refs (row-major within the 4x4 cell). Rebuilt from the
// rooms whenever the band is rebuilt (MapManager.buildCustomRoomBand).
let registry: Map<number, number[]> = new Map();

export function setComposites(map: Map<number, number[]>): void {
  registry = map;
}

export function getComposite(id: number): number[] | undefined {
  return registry.get(id);
}

/** Draw a composite's background minitiles at screen (dx,dy). */
export function drawComposite(
  ctx: CanvasRenderingContext2D,
  id: number,
  dx: number,
  dy: number
): void {
  const refs = registry.get(id);
  if (!refs) return;
  for (let mi = 0; mi < 16; mi++) {
    const n = refs[mi] ?? EMPTY;
    if (n === EMPTY) continue;
    const px = dx + (mi % 4) * MINITILE_SIZE;
    const py = dy + (mi >> 2) * MINITILE_SIZE;
    if (isCustomRef(n)) {
      drawCustomMinitile(ctx, customRefId(n), px, py);
      continue;
    }
    const r = unpackRef(n);
    drawMinitile(ctx, r.ts, r.pal, r.arr, r.mi, px, py);
  }
}

/** Draw a composite's foreground minitiles (transparent except FG pixels). */
export function drawCompositeFg(
  ctx: CanvasRenderingContext2D,
  id: number,
  dx: number,
  dy: number
): void {
  const refs = registry.get(id);
  if (!refs) return;
  for (let mi = 0; mi < 16; mi++) {
    const n = refs[mi] ?? EMPTY;
    if (n === EMPTY || isCustomRef(n)) continue; // custom tiles have no FG layer
    const r = unpackRef(n);
    drawMinitileFg(
      ctx,
      r.ts,
      r.pal,
      r.arr,
      r.mi,
      dx + (mi % 4) * MINITILE_SIZE,
      dy + (mi >> 2) * MINITILE_SIZE
    );
  }
}
