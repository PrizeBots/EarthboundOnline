/**
 * WindowRenderer — Programmatic EarthBound-style window borders.
 *
 * Draws the classic EB window: dark fill with a multi-tone border.
 * The border pattern (from outside in): shadow → bright edge → medium → fill.
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

const BORDER_W = 3; // total border thickness in pixels

// "loaded" is always true since this is programmatic
export async function loadWindowStyle(_styleId: number = 0): Promise<void> {
  // No-op — purely programmatic, no assets to load
}

/**
 * Draw a bordered window at (x, y) with the given total dimensions.
 */
export function drawWindow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  styleId: number = 0,
): void {
  const [shadow, bright, medium, fill] = FLAVORS[styleId] ?? FLAVORS[0];

  ctx.save();

  // Shadow (offset by 2px)
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x + 2, y + 2, width, height);

  // Fill
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);

  // Outer border (bright)
  ctx.strokeStyle = bright;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  // Inner border (medium)
  ctx.strokeStyle = medium;
  ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);

  // Second inner line (slightly brighter)
  ctx.strokeStyle = bright;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 2.5, y + 2.5, width - 5, height - 5);

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
  const fill = (FLAVORS[styleId] ?? FLAVORS[0])[3];
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
}
