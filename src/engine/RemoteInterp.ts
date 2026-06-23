import { Direction, Pose } from '../types';

// Snapshot interpolation for networked entities (remote players AND server NPCs
// /enemies). Senders broadcast positions every ~50-100ms, so applying packets
// directly makes entities step several pixels at a time while the local player
// glides 1-2px every frame. Instead we buffer incoming snapshots and render
// each entity INTERP_DELAY ms in the past, interpolating between the two
// snapshots that bracket that moment — per-frame smooth, at the cost of a
// barely-perceptible display delay.
//
// createInterpolator() makes one independent buffer set, so players and NPCs
// (whose ids would otherwise collide — player "1" vs npc 1) stay separate.

// Render this far in the past so we always have two snapshots bracketing the
// render time. The server sims/broadcasts player movement at ~30Hz (33ms), so
// 150ms is ~4 packets of headroom — enough to ride out real-world prod jitter
// without the buffer running dry (which freezes a remote, then jumps it: the
// stutter-step we saw in prod but never on localhost). Costs ~50ms more visible
// lag on others, imperceptible next to the jitter it removes.
const PLAYER_DELAY_MS = 150;
const TELEPORT_DIST = 64; // a gap this large is a door/teleport — snap, don't glide
const BUFFER_MAX_AGE_MS = 1000;
// On a buffer underrun (a packet stalled — routine on a high-latency TCP link)
// we COAST along the last known velocity instead of snapping to the newest
// snapshot. This caps how far past the newest snapshot we'll extrapolate, so a
// genuine stop/disconnect can't drift the entity forever. ~150ms covers a full
// 10Hz NPC gap and several 30Hz player gaps.
const MAX_EXTRAP_MS = 150;

interface Snapshot {
  t: number;
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  pose: Pose;
}

/** Anything the renderer draws by reading x/y/direction/frame/pose. */
export interface InterpTarget {
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  pose?: Pose;
}

// --- Client-side prediction (predict-then-reconcile) -------------------------
// A server-authoritative REACTION to the local player's action (a walk-push, a
// melee knockback) only reaches us a broadcast + interp-delay later (~150-250ms)
// — long enough to feel "loose." So we predict it locally: nudge the target NOW
// via a `predOff` displacement layered on top of its interpolated authoritative
// position, then DECAY that offset every frame so the authoritative stream
// reconciles it away. Equal-handed: with no prediction predOff is 0 and these
// are no-ops. Used for NPCs (NPCManager) and remote players (Game).
const PRED_DECAY = 0.8; // per-frame bleed-off of the predicted lead (~5 frames)

/** Anything we can predict a displacement on: a render target with an offset. */
export interface Predicted {
  x: number;
  y: number;
  predOffX?: number;
  predOffY?: number;
}

/** Add the live predicted offset on top of `t`'s (already-interpolated) position,
 *  then decay it toward zero. Call once per frame AFTER interpolation. */
export function applyPredOffset(t: Predicted): void {
  if (!t.predOffX && !t.predOffY) return;
  t.x += t.predOffX ?? 0;
  t.y += t.predOffY ?? 0;
  t.predOffX = (t.predOffX ?? 0) * PRED_DECAY;
  t.predOffY = (t.predOffY ?? 0) * PRED_DECAY;
  if (Math.abs(t.predOffX) < 0.05) t.predOffX = 0;
  if (Math.abs(t.predOffY) < 0.05) t.predOffY = 0;
}

/** Grow `t`'s predicted offset by `dist` px along unit dir (dx,dy) — a push nudge
 *  or a hit recoil — and show it THIS frame. Capped at `maxLead` so the prediction
 *  can't run too far ahead of the authoritative result (a big snap-back on
 *  reconcile). Returns whether it applied. */
export function injectPredOffset(
  t: Predicted,
  dx: number,
  dy: number,
  dist: number,
  maxLead: number
): boolean {
  const ox = (t.predOffX ?? 0) + dx * dist;
  const oy = (t.predOffY ?? 0) + dy * dist;
  if (Math.hypot(ox, oy) > maxLead) return false;
  t.predOffX = ox;
  t.predOffY = oy;
  t.x += dx * dist;
  t.y += dy * dist;
  return true;
}

// --- Remote melee-swing replay ----------------------------------------------
// The server broadcasts every player's pose as 'walk' (the authoritative sim in
// gameHost._stepPlayer hardcodes it), so a swinging player's 'attack' pose never
// reaches other clients on the position stream. Instead the server broadcasts the
// swing START (player_attack) and we replay the 3-frame wind-up→swing→follow-
// through locally, so it animates smoothly at any snapshot rate and clears itself.
// Frame thresholds MIRROR Player.ts (ATTACK_WINDUP / ATTACK_SWING / ATTACK_TOTAL).
const SWING_WINDUP = 6; // f0 (wind-up) ends here, in game frames @60fps
const SWING_MID = 11; // f1 (swing) ends here; f2 (follow-through) runs to total
const SWING_TOTAL = 16; // whole swing length

/** Drive a remote player's swing pose/frame from `attackStart`. Call each frame
 *  AFTER interpolate() so it overrides the always-'walk' snapshot pose. Clears
 *  `attackStart` (back to walk) once the swing completes. No-op when not swinging. */
export function applyRemoteSwing(
  t: { pose?: Pose; frame: number; attackStart?: number; attackSpeed?: number },
  now: number
): void {
  if (!t.attackStart) return;
  const spd = t.attackSpeed && t.attackSpeed > 0 ? t.attackSpeed : 1;
  // Elapsed game frames, speed-scaled so a fast weapon's swing reads as fast as
  // it does for its owner (matches Player.ts scaling the thresholds by 1/spd).
  const f = ((now - t.attackStart) / (1000 / 60)) * spd;
  if (f >= SWING_TOTAL) {
    t.attackStart = undefined;
    return;
  }
  t.pose = 'attack';
  t.frame = f < SWING_WINDUP ? 0 : f < SWING_MID ? 1 : 2;
}

const HURT_TOTAL = 20; // flinch length in game frames @60fps (mirror Player.ts)

/** Drive a remote player's hurt flinch from `hurtStart`. Call each frame AFTER
 *  interpolate() AND applyRemoteSwing (a hit interrupts a swing — hurt wins).
 *  Clears `hurtStart` once the flinch completes. No-op when not flinching. */
export function applyRemoteHurt(
  t: { pose?: Pose; frame: number; hurtStart?: number },
  now: number
): void {
  if (!t.hurtStart) return;
  const f = (now - t.hurtStart) / (1000 / 60);
  if (f >= HURT_TOTAL) {
    t.hurtStart = undefined;
    return;
  }
  t.pose = 'hurt';
  t.frame = 0; // mirror Player.hurt(): a single recoil frame held for the flinch
}

export interface Interpolator {
  push(id: string, x: number, y: number, direction: Direction, frame: number, pose: Pose): void;
  drop(id: string): void;
  has(id: string): boolean;
  ids(): IterableIterator<string>;
  /** Advance `target` to its interpolated state for this frame. */
  interpolate(id: string, target: InterpTarget): void;
}

/**
 * Make an independent snapshot interpolator. `delayMs` is how far in the past
 * to render: larger = smoother under jitter, at the cost of more visible lag.
 * NPCs broadcast at a lower rate than players, so they use a larger delay.
 */
export function createInterpolator(delayMs: number = PLAYER_DELAY_MS): Interpolator {
  const buffers = new Map<string, Snapshot[]>();

  function push(
    id: string,
    x: number,
    y: number,
    direction: Direction,
    frame: number,
    pose: Pose
  ): void {
    let buf = buffers.get(id);
    if (!buf) {
      buf = [];
      buffers.set(id, buf);
    }
    buf.push({ t: performance.now(), x, y, direction, frame, pose });
    const cutoff = performance.now() - BUFFER_MAX_AGE_MS;
    while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
  }

  function apply(target: InterpTarget, s: Snapshot, x = s.x, y = s.y): void {
    target.x = x;
    target.y = y;
    target.direction = s.direction;
    target.frame = s.frame;
    target.pose = s.pose;
  }

  function interpolate(id: string, target: InterpTarget): void {
    const buf = buffers.get(id);
    if (!buf || buf.length === 0) return; // no packets yet — hold current position

    const renderT = performance.now() - delayMs;

    if (renderT <= buf[0].t) {
      apply(target, buf[0]); // appeared moments ago — hold the earliest snapshot
      return;
    }
    const last = buf[buf.length - 1];
    if (renderT >= last.t) {
      // Buffer underran: renderT caught up to the newest snapshot (a packet
      // stalled). Holding `last` here froze the entity, then SNAPPED it forward
      // when the next packet landed — the "jumping" we saw in prod. Instead COAST
      // along the last segment's velocity for up to MAX_EXTRAP_MS, so a brief
      // stall reads as smooth motion. A standing-still sender has ~0 velocity (we
      // just hold), and we never coast across a teleport segment.
      const prev = buf.length >= 2 ? buf[buf.length - 2] : null;
      const span = prev ? last.t - prev.t : 0;
      const dx = prev ? last.x - prev.x : 0;
      const dy = prev ? last.y - prev.y : 0;
      if (prev && span > 0 && Math.hypot(dx, dy) <= TELEPORT_DIST) {
        const ahead = Math.min(renderT - last.t, MAX_EXTRAP_MS);
        apply(target, last, last.x + (dx / span) * ahead, last.y + (dy / span) * ahead);
      } else {
        apply(target, last); // no usable velocity (idle / just appeared) — hold
      }
      return;
    }

    for (let i = buf.length - 2; i >= 0; i--) {
      const a = buf[i];
      const b = buf[i + 1];
      if (renderT < a.t || renderT >= b.t) continue;
      const span = b.t - a.t;
      const k = span > 0 ? (renderT - a.t) / span : 1;
      if (Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_DIST) {
        apply(target, a); // teleport gap: hold until renderT crosses it, then jump
      } else {
        // Position glides; direction/frame/pose switch discretely with the
        // segment's starting snapshot so the walk cycle matches the motion.
        apply(target, a, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
      }
      return;
    }
  }

  return {
    push,
    drop: (id) => void buffers.delete(id),
    has: (id) => buffers.has(id),
    ids: () => buffers.keys(),
    interpolate,
  };
}

// --- Default instance for remote players (the original module API) ---

const players = createInterpolator(PLAYER_DELAY_MS);

/** Record an incoming position packet for a remote player. */
export function pushRemoteSnapshot(
  id: string,
  x: number,
  y: number,
  direction: Direction,
  frame: number,
  pose: Pose
): void {
  players.push(id, x, y, direction, frame, pose);
}

/** Forget a player who left. */
export function dropRemoteBuffer(id: string): void {
  players.drop(id);
}

/**
 * Advance one remote player to their interpolated position. Call every game
 * frame; consumers (renderer, chat bubbles, name tags) keep reading rp.x/y as
 * before and get smooth motion for free.
 */
export function interpolateRemotePlayer(rp: InterpTarget & { id: string }): void {
  players.interpolate(rp.id, rp);
}
