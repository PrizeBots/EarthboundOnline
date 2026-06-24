// The Stage-B payoff, verified headless: with snapshots stamped on the SERVER's
// even send cadence, the playout clock reproduces motion that depends ONLY on the
// snapshot timeline and the (injected) wall clock — never on when packets actually
// arrived. So network arrival jitter (and even reordering) cannot warp playback.
// We can't eyeball two browser tabs in CI, but we CAN prove that invariant here.
import { describe, it, expect, vi } from 'vitest';
import {
  createInterpolator,
  applyPredOffset,
  injectPredOffset,
  type InterpTarget,
} from '../src/engine/RemoteInterp';
import { Direction } from '../src/types';

type Snap = { t: number; x: number };

/** Drive an interpolator with an injectable wall clock; push snapshots in the
 *  given order, then sample interpolate() at each wall in `sampleWalls`. */
function run(snaps: Snap[], pushAtWall: number[], sampleWalls: number[]): number[] {
  let wall = 0;
  const interp = createInterpolator({ delay: 50, now: () => wall });
  const target: InterpTarget = { x: 0, y: 0, direction: Direction.S, frame: 0 };
  // Push every snapshot (explicit t = server send-time; arrival wall varies).
  snaps.forEach((s, i) => {
    wall = pushAtWall[i];
    interp.push('1', s.x, 0, Direction.S, 0, 'walk', s.t);
  });
  const out: number[] = [];
  for (const w of sampleWalls) {
    wall = w;
    interp.interpolate('1', target);
    out.push(target.x);
  }
  return out;
}

describe('RemoteInterp server-time playout', () => {
  // An entity moving at 1px/16ms, snapshots on an even 16ms server cadence.
  const snaps: Snap[] = Array.from({ length: 12 }, (_, i) => ({ t: i * 16, x: i }));
  const sampleWalls = [200, 208, 216, 224, 232, 240, 248, 256];

  it('arrival jitter does not change the trajectory', () => {
    // Run A: every packet "arrives" evenly. Run B: same server timestamps, but
    // wildly jittery (and out-of-order) arrival walls. Output must be identical.
    const even = snaps.map((_, i) => 100 + i * 16);
    const jittery = snaps.map((_, i) => 100 + i * 16 + (i % 3 === 0 ? 40 : i % 2 === 0 ? -12 : 5));
    const a = run(snaps, even, sampleWalls);
    const b = run(snaps, jittery, sampleWalls);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 6);
  });

  it('plays back monotonically and smoothly (constant-ish velocity)', () => {
    const xs = run(
      snaps,
      snaps.map((_, i) => 100 + i * 16),
      sampleWalls
    );
    // Strictly increasing (no freeze-then-snap), and each step is a small,
    // bounded advance rather than a packet-sized jump.
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
      expect(xs[i] - xs[i - 1]).toBeLessThan(2); // ~0.5px/sample at this cadence
    }
  });

  it('reports a delay and brackets within the snapshot span', () => {
    const interp = createInterpolator({ delay: 50, now: () => 0 });
    expect(interp.delayMs()).toBe(50);
    const out = run(
      snaps,
      snaps.map(() => 50),
      [200]
    );
    // Rendered strictly inside the [0, 11] position range — interpolating, not
    // snapping to an endpoint.
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(11);
  });
});

// The prod knockback fix: the predicted lead must HOLD at the target until the
// authoritative slide arrives (any latency), instead of decaying on a blind timer
// that snaps back early in prod (the "snap flash"). Proven headless by mocking the
// clock and feeding the authoritative position in by hand.
describe('predicted-offset reconciliation (knockback)', () => {
  it('holds the predicted lead until authoritative catches up — no snap-back', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const t: { x: number; y: number; predOffX?: number } = { x: 0, y: 0 };

    injectPredOffset(t, 1, 0, 10, 100); // predict a 10px knockback in +x
    expect(t.x).toBe(10); // lurches to the target immediately

    // Frame with authoritative still STALE (interpolate would reset x to 0).
    t.x = 0;
    t.y = 0;
    applyPredOffset(t);
    expect(t.x).toBeCloseTo(10, 5); // held at the predicted spot, not snapped back

    // Authoritative slide arrives halfway (auth = 5): rendered must STILL hold at 10.
    t.x = 5;
    applyPredOffset(t);
    expect(t.x).toBeCloseTo(10, 5);

    // Authoritative fully arrives (auth = 10): lead is spent, they coincide.
    t.x = 10;
    applyPredOffset(t);
    expect(t.x).toBeCloseTo(10, 5);
    expect(Math.abs(t.predOffX ?? 0)).toBeLessThan(0.1);
    vi.restoreAllMocks();
  });

  it('bleeds off a mispredict (no knockback ever lands) after the hold window', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const t: { x: number; y: number } = { x: 0, y: 0 };

    injectPredOffset(t, 1, 0, 10, 100);
    t.x = 0;
    applyPredOffset(t);
    expect(t.x).toBeCloseTo(10, 5); // within the hold window the lead persists

    now = 1000 + 300; // past PRED_HOLD_MS, authoritative never moved → mispredict
    for (let i = 0; i < 80; i++) {
      t.x = 0;
      applyPredOffset(t);
    }
    expect(t.x).toBeLessThan(1); // bled off, entity no longer floats shoved
    vi.restoreAllMocks();
  });
});
