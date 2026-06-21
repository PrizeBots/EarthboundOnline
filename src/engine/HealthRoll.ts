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
}

const HIGHLIGHT_MS = 450; // hold + flash the lost chunk before it drains
const DRAIN_MS = 2800; // time to drain a FULL bar (partial chunks scale linearly)
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
