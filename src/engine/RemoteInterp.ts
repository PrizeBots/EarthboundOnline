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

const PLAYER_DELAY_MS = 100; // ~2 packets of headroom at the player send rate
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

/** Anything the renderer draws by reading x/y/direction/frame/pose. */
export interface InterpTarget {
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  pose?: Pose;
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
    pose: Pose,
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
      apply(target, last); // sender idle (or packets late) — hold the newest
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
  pose: Pose,
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
