/**
 * Recolor engine for character creation. Auto-detects the ~3 dominant color
 * groups in a sprite sheet (clothes / skin / hair, roughly) and lets the player
 * hue-shift each group with a slider. Output is a recolored PNG data URL used as
 * the character's `appearance` sheet.
 *
 * Per-pixel group assignment is computed ONCE; each slider change just re-applies
 * the per-group hue rotation (cheap enough to run live on input).
 */

const GROUPS = 3;
// Two opaque colors are "the same region" if within this RGB distance² of an
// anchor. Anchors are the most-frequent colors that are far enough apart.
const ANCHOR_MIN_DIST2 = 60 * 60;

export interface RecolorGroup {
  /** The anchor color (the group's representative RGB), for the slider swatch. */
  anchor: [number, number, number];
}

export class Recolorer {
  readonly width: number;
  readonly height: number;
  readonly groups: RecolorGroup[] = [];
  private readonly src: Uint8ClampedArray; // original pixels (RGBA)
  private readonly assign: Int8Array; // per-pixel group index, -1 = transparent/unmatched
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly out: ImageData;
  private readonly hue: number[] = new Array(GROUPS).fill(0); // degrees per group

  constructor(img: HTMLImageElement) {
    this.width = img.naturalWidth;
    this.height = img.naturalHeight;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(img, 0, 0);
    this.out = this.ctx.getImageData(0, 0, this.width, this.height);
    this.src = new Uint8ClampedArray(this.out.data); // pristine copy

    const anchors = this.findAnchors();
    for (const a of anchors) this.groups.push({ anchor: a });
    this.assign = this.assignPixels(anchors);
    this.render();
  }

  /** Pick up to GROUPS frequent, mutually-distant opaque colors as anchors. */
  private findAnchors(): [number, number, number][] {
    const counts = new Map<number, number>();
    for (let i = 0; i < this.src.length; i += 4) {
      if (this.src[i + 3] < 128) continue; // transparent
      const key = (this.src[i] << 16) | (this.src[i + 1] << 8) | this.src[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const anchors: [number, number, number][] = [];
    for (const key of sorted) {
      const c: [number, number, number] = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
      if (anchors.every((a) => dist2(a, c) >= ANCHOR_MIN_DIST2)) anchors.push(c);
      if (anchors.length === GROUPS) break;
    }
    // Pad if the sprite has fewer than 3 distinct regions (reuse the last).
    while (anchors.length && anchors.length < GROUPS) anchors.push(anchors[anchors.length - 1]);
    return anchors;
  }

  /** Assign each opaque pixel to its nearest anchor. */
  private assignPixels(anchors: [number, number, number][]): Int8Array {
    const a = new Int8Array(this.width * this.height).fill(-1);
    for (let p = 0, i = 0; i < this.src.length; i += 4, p++) {
      if (this.src[i + 3] < 128) continue;
      const c: [number, number, number] = [this.src[i], this.src[i + 1], this.src[i + 2]];
      let best = -1;
      let bestD = Infinity;
      for (let g = 0; g < anchors.length; g++) {
        const d = dist2(anchors[g], c);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
      a[p] = best;
    }
    return a;
  }

  /** Set a group's hue rotation in degrees and re-render. */
  setHue(group: number, degrees: number): void {
    this.hue[group] = degrees;
    this.render();
  }

  getHue(group: number): number {
    return this.hue[group];
  }

  /** Rebuild the output pixels from the source + current per-group hue shifts. */
  private render(): void {
    const out = this.out.data;
    const src = this.src;
    for (let p = 0, i = 0; i < src.length; i += 4, p++) {
      const g = this.assign[p];
      if (g < 0 || this.hue[g] === 0) {
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
        out[i + 3] = src[i + 3];
        continue;
      }
      const [h, s, l] = rgbToHsl(src[i], src[i + 1], src[i + 2]);
      const [r, gg, b] = hslToRgb((h + this.hue[g] / 360 + 1) % 1, s, l);
      out[i] = r;
      out[i + 1] = gg;
      out[i + 2] = b;
      out[i + 3] = src[i + 3];
    }
    this.ctx.putImageData(this.out, 0, 0);
  }

  /** The anchor color as it currently appears (with its hue shift), for swatches. */
  shiftedAnchor(group: number): string {
    const [r, g, b] = this.groups[group].anchor;
    const [h, s, l] = rgbToHsl(r, g, b);
    const [rr, gg, bb] = hslToRgb((h + this.hue[group] / 360 + 1) % 1, s, l);
    return `rgb(${rr},${gg},${bb})`;
  }

  /** The current recolored canvas (e.g. to draw a live preview frame). */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** The recolored full sheet as a PNG data URL (the character `appearance`). */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }
}

function dist2(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

// Standard RGB<->HSL (0..1). Hue shift in HSL preserves each pixel's shading.
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) =>
    Math.round(v * 255)
  ) as [number, number, number];
}

function hue(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
