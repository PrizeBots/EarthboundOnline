/**
 * HealthRoll — EarthBound-style "rolling" HP for any health-bar holder.
 *
 * The authoritative `hp` (server-driven) snaps instantly, but the bar renders
 * from `displayHp`, which LAGS behind: on a hit the lost chunk is held + flashed
 * briefly, then drains away in increments toward the real value — the EB rolling
 * counter, applied to the bar. Heals roll the other way (fill grows up to `hp`).
 *
 * Pure presentation: this never changes `hp`, so it can't affect the simulation
 * (death/down is still server-authoritative). Works structurally on the Player,
 * remote players, and NPCs alike — anything carrying {hp, maxHp}.
 */

export interface HpHolder {
  hp: number;
  maxHp: number;
  /** Visually-shown HP, chases `hp`. Lazily seeded to `hp` on first roll. */
  displayHp?: number;
  /** While now < this, the pending (lost) chunk is held + flashed before it
   *  starts draining — so the damage reads on the bar before it's taken away. */
  dmgPendUntil?: number;
  /** Per-holder timestamp of the last roll step, for frame-independent drain. */
  rollTs?: number;
  // --- Mortal roll (server-timed): the EB rolling-HP death. The meter slides
  // from mortalFrom → 0 over mortalMs (authoritative, from the server) while the
  // player can still heal to survive. Drives BOTH hp + displayHp so the whole bar
  // visibly empties. Cleared on survive / down / revive. ---
  mortalFrom?: number;
  mortalStart?: number;
  mortalMs?: number;
}

const HIGHLIGHT_MS = 450; // hold + flash the lost chunk before it drains
const DRAIN_MS = 4000; // time to drain a FULL bar (partial chunks scale linearly)
const HEAL_MS = 1200; // time to fill a FULL bar on a heal
const PEND_HZ = 7; // flash speed of the pending-damage chunk

/** Register a hit: hold the pre-hit fill (`fromHp`) so the lost chunk shows
 *  before it drains. Call right after lowering `h.hp`. */
export function noteHealthDamage(h: HpHolder, fromHp: number, now: number): void {
  h.displayHp = Math.max(h.displayHp ?? fromHp, fromHp);
  h.dmgPendUntil = now + HIGHLIGHT_MS;
}

/** Advance one holder's rolling fill toward its real `hp`. Call every frame. */
export function rollHealth(h: HpHolder, now: number): void {
  if (h.displayHp === undefined) {
    h.displayHp = h.hp;
    h.rollTs = now;
    return;
  }
  const dt = Math.min(100, now - (h.rollTs ?? now)); // clamp so a tab-out doesn't jump
  h.rollTs = now;
  if (h.displayHp > h.hp) {
    // Damage: hold (and flash) the chunk briefly, then drain it away.
    if (now < (h.dmgPendUntil ?? 0)) return;
    const rate = Math.max(1, h.maxHp) / DRAIN_MS;
    h.displayHp = Math.max(h.hp, h.displayHp - rate * dt);
  } else if (h.displayHp < h.hp) {
    // Heal: grow the fill up to the new value.
    const rate = Math.max(1, h.maxHp) / HEAL_MS;
    h.displayHp = Math.min(h.hp, h.displayHp + rate * dt);
  }
}

/** 0..1 brightness for the pending chunk's flash (1 = brightest). */
export function pendFlash(now: number): number {
  return 0.5 + 0.5 * Math.sin((now / 1000) * PEND_HZ * Math.PI * 2);
}

/** Begin a server-timed mortal roll: the whole bar slides from `fromHp` to 0 over
 *  `ms`. Seeds hp + displayHp so the bar reads `fromHp` on frame one. */
export function startMortalRoll(h: HpHolder, fromHp: number, ms: number, now: number): void {
  h.mortalFrom = fromHp;
  h.mortalStart = now;
  h.mortalMs = Math.max(1, ms);
  h.hp = fromHp;
  h.displayHp = fromHp;
}

/** Drive a mortal roll one frame: set hp + displayHp to the slid value (→0 at end).
 *  No-op if no roll is active. Call every frame for any holder that can be dying. */
export function tickMortalRoll(h: HpHolder, now: number): void {
  if (h.mortalStart === undefined || h.mortalMs === undefined || h.mortalFrom === undefined) return;
  const t = Math.min(1, (now - h.mortalStart) / h.mortalMs);
  const v = Math.max(0, h.mortalFrom * (1 - t));
  h.hp = v;
  h.displayHp = v;
}

/** End a mortal roll (survived / downed / revived). The caller sets the real hp. */
export function clearMortalRoll(h: HpHolder): void {
  h.mortalFrom = undefined;
  h.mortalStart = undefined;
  h.mortalMs = undefined;
}

/** Is a mortal roll currently animating on this holder? */
export function isMortalRolling(h: HpHolder): boolean {
  return h.mortalStart !== undefined;
}
