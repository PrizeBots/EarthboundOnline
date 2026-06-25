/**
 * Pentagon stat allocator for character creation. Five axes (Muscle / Mental /
 * Spirit / Speed / Knowledge) radiate from the center; each has a draggable dot,
 * and the dots are joined into a web polygon. Every stat starts at STAT_MIN; the
 * player spends ALLOC_POINTS by dragging dots outward (capped at STAT_MAX, and by
 * the remaining point pool). Drag a dot back in to refund points.
 *
 * Mirrors the server's constants (server/charStats.js) — keep them in sync; the
 * server re-validates the allocation on create, so drift is caught, not trusted.
 */

// Keep in sync with server/charStats.js.
export const STAT_KEYS = ['muscle', 'mental', 'spirit', 'speed', 'knowledge'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
const STAT_LABELS: Record<StatKey, string> = {
  muscle: 'MUSCLE',
  mental: 'MENTAL',
  spirit: 'SPIRIT',
  speed: 'SPEED',
  knowledge: 'KNOWLEDGE',
};
export const STAT_MIN = 1;
export const STAT_MAX = 10;
export const ALLOC_POINTS = 10;

export type Alloc = Record<StatKey, number>;

const SVG = 'http://www.w3.org/2000/svg';
const SIZE = 300; // viewBox px
const C = SIZE / 2;
const R = 108; // axis length (value displayMax sits here)
const LABEL_GAP = 22; // distance from axis tip to the stat name

export interface StatRadar {
  el: SVGSVGElement;
  getAlloc: () => Alloc;
  pointsLeft: () => number;
}

/**
 * Options let the same widget serve creation (start at the base, spend 10) and
 * the level-up spend (start at the saved alloc, can't drop below it, spend the
 * banked points, axis scaled to fit higher stats).
 */
export interface RadarOpts {
  initial?: Partial<Alloc>; // starting values (default STAT_MIN each)
  floor?: Partial<Alloc>; // can't drag below these (default STAT_MIN each)
  budget?: number; // points available to spend (default ALLOC_POINTS)
  displayMax?: number; // value that sits at the axis tip (default STAT_MAX)
  statMax?: number; // per-stat hard cap (default STAT_MAX)
}

/**
 * Build the radar into nothing (returns the <svg>); `onChange(alloc, pointsLeft)`
 * fires on every edit so the host can update the "points left" readout + gate the
 * Create/Confirm button.
 */
export function createStatRadar(
  onChange: (alloc: Alloc, pointsLeft: number) => void,
  opts: RadarOpts = {}
): StatRadar {
  injectRadarStyles();
  const fill = (src: Partial<Alloc> | undefined, fallback: number): Alloc =>
    STAT_KEYS.reduce((o, k) => ((o[k] = src?.[k] ?? fallback), o), {} as Alloc);
  const values: Alloc = fill(opts.initial, STAT_MIN);
  const floor: Alloc = fill(opts.floor, STAT_MIN);
  const budget = opts.budget ?? ALLOC_POINTS;
  const displayMax = opts.displayMax ?? STAT_MAX;
  const statMax = opts.statMax ?? STAT_MAX;
  const valTexts: SVGTextElement[] = []; // per-axis value labels, filled below

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  // Explicit intrinsic size so the SVG can't collapse to 0 height in the flex
  // column (CSS below scales it down responsively).
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('class', 'eb-radar');

  // Axis unit vectors (start straight up, go clockwise).
  const axis = STAT_KEYS.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / STAT_KEYS.length;
    return { dx: Math.cos(a), dy: Math.sin(a) };
  });

  // Each dot sits at `v/displayMax` of its axis — but a heavily specialized build
  // (e.g. Mental 50, everything else 1) would render the four low dots ~2px from
  // center, stacked on top of each other so only the top one is grabbable. Floor
  // the RENDERED radius at MIN_DOT_FRAC so all five stay on their own spokes and
  // separated enough to grab. The value label still shows the true value, and the
  // drag is relative (see bindDrag), so this visual floor never distorts the value.
  const MIN_DOT_FRAC = 0.19;
  const point = (i: number, v: number) => {
    const frac = Math.max(MIN_DOT_FRAC, v / displayMax);
    return { x: C + axis[i].dx * frac * R, y: C + axis[i].dy * frac * R };
  };

  // --- static scaffolding: rings + spokes + labels ---
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const ring = document.createElementNS(SVG, 'polygon');
    ring.setAttribute(
      'points',
      STAT_KEYS.map((_, i) => {
        const x = C + axis[i].dx * frac * R;
        const y = C + axis[i].dy * frac * R;
        return `${x},${y}`;
      }).join(' ')
    );
    ring.setAttribute('class', 'eb-radar-ring');
    svg.appendChild(ring);
  }
  for (let i = 0; i < STAT_KEYS.length; i++) {
    const spoke = document.createElementNS(SVG, 'line');
    spoke.setAttribute('x1', String(C));
    spoke.setAttribute('y1', String(C));
    spoke.setAttribute('x2', String(C + axis[i].dx * R));
    spoke.setAttribute('y2', String(C + axis[i].dy * R));
    spoke.setAttribute('class', 'eb-radar-spoke');
    svg.appendChild(spoke);

    const label = document.createElementNS(SVG, 'text');
    const lx = C + axis[i].dx * (R + LABEL_GAP);
    const ly = C + axis[i].dy * (R + LABEL_GAP);
    label.setAttribute('x', String(lx));
    label.setAttribute('y', String(ly));
    label.setAttribute('class', 'eb-radar-label');
    label.setAttribute(
      'text-anchor',
      Math.abs(axis[i].dx) < 0.3 ? 'middle' : axis[i].dx > 0 ? 'start' : 'end'
    );
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = STAT_LABELS[STAT_KEYS[i]];
    svg.appendChild(label);

    const val = document.createElementNS(SVG, 'text');
    val.setAttribute('x', String(lx));
    val.setAttribute('y', String(ly + 17));
    val.setAttribute('class', 'eb-radar-val');
    val.setAttribute('text-anchor', label.getAttribute('text-anchor')!);
    val.setAttribute('dominant-baseline', 'middle');
    valTexts.push(val);
    svg.appendChild(val);
  }

  // --- the editable web + dots ---
  const web = document.createElementNS(SVG, 'polygon');
  web.setAttribute('class', 'eb-radar-web');
  svg.appendChild(web);

  const dots: SVGCircleElement[] = [];
  for (let i = 0; i < STAT_KEYS.length; i++) {
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('r', '8');
    dot.setAttribute('class', 'eb-radar-dot');
    dot.style.cursor = 'grab';
    bindDrag(dot, i);
    dots.push(dot);
    svg.appendChild(dot);
  }

  function pool(): number {
    const spent = STAT_KEYS.reduce((s, k) => s + (values[k] - floor[k]), 0);
    return budget - spent;
  }

  // notify=false for the initial draw at construction: the host's onChange may
  // reference state it hasn't declared yet (it runs before createStatRadar
  // returns), so we draw the dots/web silently and let the host seed its own
  // initial readout. Drags (setValue) redraw WITH notify.
  function redraw(notify = true): void {
    web.setAttribute(
      'points',
      STAT_KEYS.map((k, i) => {
        const p = point(i, values[k]);
        return `${p.x},${p.y}`;
      }).join(' ')
    );
    STAT_KEYS.forEach((k, i) => {
      const p = point(i, values[k]);
      dots[i].setAttribute('cx', String(p.x));
      dots[i].setAttribute('cy', String(p.y));
      valTexts[i].textContent = String(values[k]);
      // Pulse any dot the player has pushed ABOVE its floor (i.e. unconfirmed
      // spend) — a cue that those points are removable/reallocatable.
      dots[i].classList.toggle('eb-radar-dot-spent', values[k] > floor[k]);
    });
    if (notify) onChange({ ...values }, pool());
  }

  function setValue(i: number, v: number): void {
    const k = STAT_KEYS[i];
    v = Math.round(v);
    const maxByPool = values[k] + pool(); // can't spend more than is left
    v = Math.max(floor[k], Math.min(statMax, Math.min(v, maxByPool)));
    if (v === values[k]) return;
    values[k] = v;
    redraw();
  }

  // Project the pointer onto axis i and convert distance from center to a value.
  // MUST use displayMax (the value at the axis tip), NOT STAT_MAX — the dots are
  // rendered on the displayMax scale (see point()), so reading the pointer on a
  // different scale miscalibrates the drag. At creation displayMax === STAT_MAX so
  // it was hidden; at level-up displayMax grows to fit higher stats, and using the
  // old STAT_MAX pinned every dot to a phantom ~10 cap (statMax/budget are the real
  // limits, applied in setValue).
  function valueFromPointer(i: number, clientX: number, clientY: number): number {
    const rect = svg.getBoundingClientRect();
    const scale = SIZE / rect.width;
    const px = (clientX - rect.left) * scale - C;
    const py = (clientY - rect.top) * scale - C;
    const proj = px * axis[i].dx + py * axis[i].dy; // distance along the axis
    return (proj / R) * displayMax;
  }

  function bindDrag(dot: SVGCircleElement, i: number): void {
    // RELATIVE drag: track the value + pointer-projection at grab time and apply the
    // delta, so grabbing a dot whose RENDERED spot is floored (MIN_DOT_FRAC) above
    // its true value doesn't snap it — a low dot you grab stays put until you move,
    // then moves by exactly how far you drag.
    let grabVal = 0;
    let grabProj = 0;
    const onMove = (e: PointerEvent) =>
      setValue(i, grabVal + (valueFromPointer(i, e.clientX, e.clientY) - grabProj));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dot.style.cursor = 'grab';
    };
    dot.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grabVal = values[STAT_KEYS[i]];
      grabProj = valueFromPointer(i, e.clientX, e.clientY);
      dot.style.cursor = 'grabbing';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  redraw(false); // initial draw without firing onChange (host not ready yet)

  return {
    el: svg,
    getAlloc: () => ({ ...values }),
    pointsLeft: () => pool(),
  };
}

let stylesInjected = false;
/** Inject the radar's SVG styles once (shared by the creator + level-up modal). */
function injectRadarStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  .eb-radar { display: block; max-width: 100%; height: auto; align-self: center; overflow: visible; }
  .eb-radar-ring { fill: none; stroke: #2a2a3e; stroke-width: 1.2; }
  .eb-radar-spoke { stroke: #2a2a3e; stroke-width: 1.2; }
  .eb-radar-web { fill: rgba(248,232,90,0.22); stroke: #f8e85a; stroke-width: 2.5; }
  .eb-radar-dot { fill: #f8e85a; stroke: #fff; stroke-width: 2; }
  /* Unconfirmed spend: pulse the dot (grow + warm glow) so the player sees which
     points they just added and can drag back to reallocate before confirming. */
  .eb-radar-dot-spent {
    fill: #ffd23f; transform-box: fill-box; transform-origin: center;
    animation: eb-radar-dot-pulse 0.85s ease-in-out infinite;
  }
  @keyframes eb-radar-dot-pulse {
    0%, 100% { transform: scale(1);   filter: drop-shadow(0 0 1px #ffae3a); }
    50%      { transform: scale(1.55); filter: drop-shadow(0 0 4px #ffae3a); }
  }
  /* Bigger, brighter labels with a hard dark halo (paint-order: stroke) so they
     stay legible over the web/rings — EarthBound's chunky-outlined readout look. */
  .eb-radar-label {
    fill: #e6edff; font: bold 15px 'Courier New', monospace; letter-spacing: 0.5px;
    paint-order: stroke; stroke: #0a0a12; stroke-width: 3.5px; stroke-linejoin: round;
  }
  .eb-radar-val {
    fill: #fff; font: bold 14px 'Courier New', monospace;
    paint-order: stroke; stroke: #0a0a12; stroke-width: 3.5px; stroke-linejoin: round;
  }
  `;
  const style = document.createElement('style');
  style.id = 'eb-radar-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
