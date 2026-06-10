/**
 * WindowRenderer — Programmatic EarthBound-style window borders.
 *
 * Draws the classic EB window: dark fill with a multi-tone border and the
 * rounded pixel corners of the real game's window tiles. Everything is
 * 1px fillRect runs (no stroked paths), so edges stay crisp at integer
 * scale — exactly how the corner tiles look on hardware.
 *
 * Border pattern from outside in: bright edge → medium → bright → fill,
 * with a soft drop shadow under the whole window.
 */

// EarthBound window flavors (outer, bright, medium, fill colors)
const FLAVORS: [string, string, string, string][] = [
  ['#000', '#f0f0f0', '#6070a0', '#101828'], // 0: Plain (dark blue)
  ['#000', '#f0f0f0', '#a08060', '#281810'], // 1: Live (brown)
  ['#000', '#f0e0c0', '#907050', '#201008'], // 2: Dark (warm brown)
  ['#000', '#c0f0c0', '#508060', '#082010'], // 3: Peanut (green)
  ['#000', '#f0c0f0', '#906090', '#200828'], // 4: Plain (purple)
  ['#000', '#f0f0c0', '#908060', '#282010'], // 5: Banana (yellow)
  ['#000', '#c0c0f0', '#606090', '#101028'], // 6: Strawberry (blue-purple)
];

// "loaded" is always true since this is programmatic
export async function loadWindowStyle(_styleId: number = 0): Promise<void> {
  // No-op — purely programmatic, no assets to load
}

/**
 * Trace a 1px rounded outline along the inside of rect (x, y, w, h).
 * `edge` is where the straight edges start; `corner` lists the quarter-arc
 * pixels for the top-left, which get mirrored to the other three corners.
 */
function traceRoundOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  edge: number,
  corner: [number, number][],
  color: string
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x + edge, y, w - edge * 2, 1);          // top
  ctx.fillRect(x + edge, y + h - 1, w - edge * 2, 1);  // bottom
  ctx.fillRect(x, y + edge, 1, h - edge * 2);          // left
  ctx.fillRect(x + w - 1, y + edge, 1, h - edge * 2);  // right
  for (const [cx, cy] of corner) {
    ctx.fillRect(x + cx, y + cy, 1, 1);                // top-left
    ctx.fillRect(x + w - 1 - cx, y + cy, 1, 1);        // top-right
    ctx.fillRect(x + cx, y + h - 1 - cy, 1, 1);        // bottom-left
    ctx.fillRect(x + w - 1 - cx, y + h - 1 - cy, 1, 1); // bottom-right
  }
}

/** Fill the rounded (radius-4) interior of rect (x, y, w, h). */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y + 4, w - 2, h - 8);
  ctx.fillRect(x + 4, y + 1, w - 8, h - 2);
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
}

// Quarter-arc pixels (top-left corner) for each nested outline radius.
const ARC_R4: [number, number][] = [[2, 1], [3, 1], [1, 2], [1, 3]];
const ARC_R3: [number, number][] = [[1, 1], [2, 1], [1, 2]];
const ARC_R2: [number, number][] = [[1, 1]];

/**
 * Draw a bordered window at (x, y) with the given total dimensions.
 * Minimum sensible size is about 12x12.
 */
export function drawWindow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  styleId: number = 0,
): void {
  const [, bright, medium, fill] = FLAVORS[styleId] ?? FLAVORS[0];

  ctx.save();

  // Drop shadow (offset by 2px), same rounded silhouette.
  fillRoundRect(ctx, x + 2, y + 2, width, height, 'rgba(0,0,0,0.5)');

  fillRoundRect(ctx, x, y, width, height, fill);

  // Outer bright edge on the boundary, medium line inside it, then a second
  // bright line — each one step in, with a one-smaller corner radius.
  traceRoundOutline(ctx, x, y, width, height, 4, ARC_R4, bright);
  traceRoundOutline(ctx, x + 1, y + 1, width - 2, height - 2, 3, ARC_R3, medium);
  traceRoundOutline(ctx, x + 2, y + 2, width - 4, height - 4, 2, ARC_R2, bright);

  ctx.restore();
}

export function drawWindowFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  styleId: number = 0,
): void {
  fillRoundRect(ctx, x, y, width, height, (FLAVORS[styleId] ?? FLAVORS[0])[3]);
}
