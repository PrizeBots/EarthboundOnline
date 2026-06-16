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

/** Build (and cache) an outlined EB-font canvas for `label` in `color`. */
function buildPlate(label: string, color: string, tracking = 1): HTMLCanvasElement {
  const key = `${color}|${tracking}|${label}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const white = ebText(label, 1, color, NAME_FONT, tracking);
  const dark = ebText(label, 1, '#101018', NAME_FONT, tracking);
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

/**
 * Cached outlined nameplate canvas (just the name, centered above the bars), or
 * null if the font isn't loaded yet. PK players render in red so everyone can
 * spot who's hostile at a glance.
 */
export function getNameplate(name: string, _level: number, pk = false): HTMLCanvasElement | null {
  if (!ready) return null;
  return buildPlate(name, pk ? '#ff4040' : '#ffffff');
}

/**
 * Cached "Lv5" plate, drawn to the LEFT of the health/stamina bars, or null if
 * the font isn't loaded yet. Matches the name's PK-red coloring.
 */
export function getLevelPlate(level: number, pk = false): HTMLCanvasElement | null {
  if (!ready) return null;
  return buildPlate(`Lv${level}`, pk ? '#ff4040' : '#ffffff', 0); // tight kerning
}
