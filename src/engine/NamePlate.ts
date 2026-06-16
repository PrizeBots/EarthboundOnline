/**
 * In-world player nameplates — "Name  Lv5" in the EarthBound font, drawn above
 * each player's health bar. White EB text with a 1px dark outline so it reads
 * over any background. Built canvases are cached per label (rebuilt only on a
 * name/level change), so drawing one each frame is just a drawImage.
 */
import { ebText } from './EbText';
import { loadFont } from './TextRenderer';

// The small 8x8 EB font (battle font) — compact enough to tuck above the bar.
const NAME_FONT = 4;

let ready = false;
/** Kick off the small-font load; nameplates render once it resolves. */
export function initNameplates(): void {
  void loadFont(NAME_FONT).then(() => {
    ready = true;
  });
}

const cache = new Map<string, HTMLCanvasElement>();
// 8-neighbour offsets for the outline pass.
const OUTLINE: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Cached outlined nameplate canvas, or null if the font isn't loaded yet. PK
 * players render in red so everyone can spot who's hostile at a glance.
 */
export function getNameplate(name: string, level: number, pk = false): HTMLCanvasElement | null {
  if (!ready) return null;
  const label = `Lv${level} ${name}`;
  const key = pk ? `pk:${label}` : label;
  const hit = cache.get(key);
  if (hit) return hit;

  const white = ebText(label, 1, pk ? '#ff4040' : '#ffffff', NAME_FONT);
  const dark = ebText(label, 1, '#101018', NAME_FONT);
  const cv = document.createElement('canvas');
  cv.width = white.width + 2;
  cv.height = white.height + 2;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (const [dx, dy] of OUTLINE) ctx.drawImage(dark, 1 + dx, 1 + dy);
  ctx.drawImage(white, 1, 1);

  cache.set(key, cv);
  return cv;
}
