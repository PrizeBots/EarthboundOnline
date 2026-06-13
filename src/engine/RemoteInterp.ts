import { Direction, Pose, RemotePlayer } from '../types';

// Snapshot interpolation for remote players. Each client sends its position
// every ~50ms (3 frames at 60Hz), so applying packets directly makes remote
// players step 3+ pixels at a time while the local player glides 1-2px every
// frame. Instead we buffer the incoming snapshots and render each remote
// player INTERP_DELAY ms in the past, interpolating between the two
// snapshots that bracket that moment — per-frame smooth, at the cost of a
// barely-perceptible display delay.

const INTERP_DELAY_MS = 100; // ~2 packets of headroom for network jitter
const TELEPORT_DIST = 64;    // a gap this large is a door/teleport — snap, don't glide
const BUFFER_MAX_AGE_MS = 1000;

interface Snapshot {
  t: number;
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  pose: Pose;
}

const buffers = new Map<string, Snapshot[]>();

/** Record an incoming position packet for a remote player. */
export function pushRemoteSnapshot(
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

/** Forget a player who left. */
export function dropRemoteBuffer(id: string): void {
  buffers.delete(id);
}

function apply(rp: RemotePlayer, s: Snapshot, x = s.x, y = s.y): void {
  rp.x = x;
  rp.y = y;
  rp.direction = s.direction;
  rp.frame = s.frame;
  rp.pose = s.pose;
}

/**
 * Advance one remote player to their interpolated position. Call every game
 * frame; consumers (renderer, chat bubbles, name tags) keep reading rp.x/y
 * as before and get smooth motion for free.
 */
export function interpolateRemotePlayer(rp: RemotePlayer): void {
  const buf = buffers.get(rp.id);
  if (!buf || buf.length === 0) return; // no packets yet — keep the join position

  const renderT = performance.now() - INTERP_DELAY_MS;

  if (renderT <= buf[0].t) {
    apply(rp, buf[0]); // joined moments ago — hold the earliest snapshot
    return;
  }
  const last = buf[buf.length - 1];
  if (renderT >= last.t) {
    apply(rp, last); // sender idle (or packets late) — hold the newest
    return;
  }

  for (let i = buf.length - 2; i >= 0; i--) {
    const a = buf[i];
    const b = buf[i + 1];
    if (renderT < a.t || renderT >= b.t) continue;
    const span = b.t - a.t;
    const k = span > 0 ? (renderT - a.t) / span : 1;
    if (Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_DIST) {
      apply(rp, a); // teleport gap: hold until renderT crosses it, then jump
    } else {
      // Position glides; direction/frame/pose switch discretely with the
      // segment's starting snapshot so the walk cycle matches the motion.
      apply(rp, a, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
    }
    return;
  }
}
