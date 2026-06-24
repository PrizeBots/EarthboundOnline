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
// 100ms is ~3 packets of headroom — enough to ride out real-world prod jitter
// (measured ~5ms) without the buffer running dry (which freezes a remote, then
// jumps it: the stutter-step we saw in prod but never on localhost), while the
// coast below (MAX_EXTRAP_MS) absorbs the occasional stalled packet. Trimmed
// from 150ms once prod jitter proved low — shaves 50ms off the visible lag of
// other players (the "way behind" complaint). Raise it again if jitter spikes.
const PLAYER_DELAY_MS = 100;
const TELEPORT_DIST = 64; // a gap this large is a door/teleport — snap, don't glide
const BUFFER_MAX_AGE_MS = 1000;
// On a buffer underrun (a packet stalled — routine on a high-latency TCP link)
// we COAST along the last known velocity instead of snapping to the newest
// snapshot. This caps how far past the newest snapshot we'll extrapolate, so a
// genuine stop/disconnect can't drift the entity forever. ~150ms covers a full
// 10Hz NPC gap and several 30Hz player gaps.
const MAX_EXTRAP_MS = 150;

// Server-time playout clock (jitter-immune interpolation). Each snapshot carries
// the server's send time (mapped onto our clock by Network.frameClientTime), so
// snapshot SPACING reflects the even server cadence, not jittery arrival. We don't
// render at `now - delay` (that anchors to the local clock, forcing `delay` to
// swallow one-way latency); instead a playout cursor rides `newest.t - delay` and
// advances by real elapsed time, so `delay` only covers packet-interval + jitter
// and latency drops out. Flip to false to fall back to the old now-anchored render.
const SERVER_TIME_PLAYOUT = true;
const PLAYOUT_SLEW = 0.08; // per-frame fraction the cursor eases toward its target
const PLAYOUT_RESYNC_MS = 250; // drift past this (long stall / tab resume) → hard re-anchor

// --- Adaptive render delay (Stage C) -----------------------------------------
// The buffer no longer sits at a fixed 100ms. It tracks measured jitter:
//   delay = clamp(packetInterval + JITTER_K * jitter, floor, ceil)
// On a clean link it settles near the floor (other players stop feeling "behind");
// when jitter spikes it widens instead of underrunning. The floor stays above one
// packet interval so two snapshots always bracket the cursor. Jitter is injected
// (setJitterSource) so this module never imports Network (no cycle).
const JITTER_K = 2;
let jitterFn: () => number = () => 0;
/** Wire the live jitter readout (Network.getJitterMs) into the adaptive delay. */
export function setJitterSource(fn: () => number): void {
  jitterFn = fn;
}
/** Build a delay() that tracks jitter, clamped to [floor, ceil] around a base
 *  packet interval. Used by both the player and NPC interpolators. */
export function adaptiveDelay(
  packetIntervalMs: number,
  floorMs: number,
  ceilMs: number
): () => number {
  return () => Math.max(floorMs, Math.min(ceilMs, packetIntervalMs + JITTER_K * jitterFn()));
}

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
// position. Used for NPCs (NPCManager) and remote players (Game).
//
// HOW THE LEAD IS RECONCILED AWAY: we do NOT bleed the offset off on a blind frame
// timer. That worked at ~0 latency (the authoritative slide arrived within a frame)
// but in PROD the slide is ~150ms+ behind, so the lead decayed back to the STALE
// position before the real knockback landed — lurch, snap back, re-slide: the
// "snap flash." Instead we CANCEL the lead by exactly how far the authoritative
// stream has caught up toward it (its position moving along the lead direction as
// the knockback propagates into the snapshots), so the entity HOLDS at the
// predicted spot until the server arrives, then they coincide. Self-tuning to any
// latency. A slow hold-then-decay backstop clears a MISPREDICT (a missed swing
// whose knockback never comes) so nothing floats displaced forever.
const PRED_HOLD_MS = 250; // hold the lead this long (covers reconcile latency) before…
const PRED_SAFETY_DECAY = 0.85; // …bleeding off a mispredict that never got caught up to

/** Anything we can predict a displacement on: a render target with an offset.
 *  The `_pred*` fields are internal reconciliation bookkeeping. */
export interface Predicted {
  x: number;
  y: number;
  predOffX?: number;
  predOffY?: number;
  _predAuthX?: number; // last frame's pure authoritative pos (for catch-up reconcile)
  _predAuthY?: number;
  _predHoldUntil?: number; // performance.now() deadline before the safety decay starts
}

/** Layer the predicted lead on `t`'s (already-interpolated) authoritative position,
 *  cancelling the part the authoritative stream has caught up to. Call once per
 *  frame AFTER interpolation (which sets t.x/t.y to the pure authoritative pos). */
export function applyPredOffset(t: Predicted): void {
  const authX = t.x;
  const authY = t.y;
  let ox = t.predOffX ?? 0;
  let oy = t.predOffY ?? 0;
  if (ox || oy) {
    // Cancel the lead by how far the authoritative position moved ALONG it since
    // last frame — i.e. how much the real knockback has arrived in the stream.
    const pax = t._predAuthX;
    const pay = t._predAuthY;
    if (pax !== undefined && pay !== undefined) {
      const mag = Math.hypot(ox, oy) || 1;
      const ux = ox / mag;
      const uy = oy / mag;
      const adv = (authX - pax) * ux + (authY - pay) * uy;
      if (adv > 0) {
        const m = Math.max(0, mag - adv);
        ox = ux * m;
        oy = uy * m;
      }
    }
    // Backstop: once the hold window passes with no catch-up, it was a mispredict —
    // bleed it off so the entity doesn't sit shoved forever.
    if (performance.now() > (t._predHoldUntil ?? 0)) {
      ox *= PRED_SAFETY_DECAY;
      oy *= PRED_SAFETY_DECAY;
    }
    if (Math.abs(ox) < 0.05) ox = 0;
    if (Math.abs(oy) < 0.05) oy = 0;
    t.predOffX = ox;
    t.predOffY = oy;
    t.x = authX + ox;
    t.y = authY + oy;
  }
  t._predAuthX = authX;
  t._predAuthY = authY;
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
  t._predHoldUntil = performance.now() + PRED_HOLD_MS;
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
  /** Record a snapshot. `t` is its client-clock time (server send-time mapped via
   *  the clock offset); omitted → now (pre-clock-sync / JSON frame with no ts). */
  push(
    id: string,
    x: number,
    y: number,
    direction: Direction,
    frame: number,
    pose: Pose,
    t?: number
  ): void;
  drop(id: string): void;
  has(id: string): boolean;
  ids(): IterableIterator<string>;
  /** Advance `target` to its interpolated state for this frame. */
  interpolate(id: string, target: InterpTarget): void;
  /** The render delay (ms) in effect this frame — fixed, or adaptive (Stage C). */
  delayMs(): number;
}

/** Options for createInterpolator. A function `delay` is resolved live each frame
 *  (so it can track measured jitter); `now` is injectable for tests. */
export interface InterpOpts {
  delay?: number | (() => number);
  now?: () => number;
}

/**
 * Make an independent snapshot interpolator. `delayMs` is how far in the past
 * to render: larger = smoother under jitter, at the cost of more visible lag.
 * NPCs broadcast at a lower rate than players, so they use a larger delay.
 */
export function createInterpolator(opts: number | InterpOpts = PLAYER_DELAY_MS): Interpolator {
  const o: InterpOpts = typeof opts === 'number' ? { delay: opts } : opts;
  const resolveDelay: () => number =
    typeof o.delay === 'function' ? o.delay : () => (o.delay as number) ?? PLAYER_DELAY_MS;
  const now: () => number = o.now ?? (() => performance.now());
  const buffers = new Map<string, Snapshot[]>();

  // Shared playout clock — all entities ride the SAME server broadcast timeline, so
  // one cursor (newest snapshot's t, minus delay, advanced by real elapsed time)
  // drives every buffer. `latest` is the freshest t across all buffers.
  let playoutT = NaN;
  let lastWall = NaN;
  let latest = -Infinity;
  let curDelay = resolveDelay();

  function push(
    id: string,
    x: number,
    y: number,
    direction: Direction,
    frame: number,
    pose: Pose,
    t: number = now()
  ): void {
    let buf = buffers.get(id);
    if (!buf) {
      buf = [];
      buffers.set(id, buf);
    }
    buf.push({ t, x, y, direction, frame, pose });
    if (t > latest) latest = t;
    // Keep each buffer time-ordered: ordered WS never reorders, but the Stage-D
    // unreliable RTC channel can, and a single late packet must not invert a
    // segment (which would briefly run interpolation backwards).
    if (buf.length > 1 && t < buf[buf.length - 2].t) buf.sort((p, q) => p.t - q.t);
    const cutoff = latest - BUFFER_MAX_AGE_MS;
    while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
  }

  function apply(target: InterpTarget, s: Snapshot, x = s.x, y = s.y): void {
    target.x = x;
    target.y = y;
    target.direction = s.direction;
    target.frame = s.frame;
    target.pose = s.pose;
  }

  // Advance the shared playout cursor at most once per render frame (entities all
  // call interpolate() within <1ms of each other; only the first advances).
  function advancePlayout(): void {
    const wall = now();
    if (!Number.isNaN(lastWall) && wall - lastWall < 1) return; // already advanced this frame
    const dt = Number.isNaN(lastWall) ? 0 : Math.min(250, Math.max(0, wall - lastWall));
    lastWall = wall;
    curDelay = resolveDelay();
    const targetT = latest - curDelay;
    if (Number.isNaN(playoutT) || Math.abs(playoutT - targetT) > PLAYOUT_RESYNC_MS) {
      playoutT = targetT; // first frame, or recovered from a long stall — hard anchor
      return;
    }
    playoutT += dt; // ride real time forward...
    playoutT += (targetT - playoutT) * PLAYOUT_SLEW; // ...and ease toward the target lag
  }

  function interpolate(id: string, target: InterpTarget): void {
    const buf = buffers.get(id);
    if (!buf || buf.length === 0) return; // no packets yet — hold current position

    let renderT: number;
    if (SERVER_TIME_PLAYOUT) {
      advancePlayout();
      renderT = playoutT;
    } else {
      curDelay = resolveDelay();
      renderT = now() - curDelay;
    }

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
        coastEvents++; // buffer underran on a MOVING entity — the key buffer-too-small signal
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
    delayMs: () => curDelay,
  };
}

// --- Default instance for remote players (the original module API) ---

// Players broadcast at ~30Hz (~33ms — the player sim went back to 30Hz to unload the
// prod box). Floor ~66ms keeps ~2 snapshots bracketing the cursor with WAN headroom;
// ceil 150ms is the safety ceiling. PLAYER_DELAY_MS is the legacy fixed fallback.
const players = createInterpolator({ delay: adaptiveDelay(33, 66, PLAYER_DELAY_MS + 50) });

// The NPC interpolator (NPCManager) registers itself here so the rest of the app —
// crucially Network's ping, which reports the enemy render-delay for melee lag-comp
// — can read the live NPC interp delay without importing NPCManager (no cycle).
let npcDelayGetter: () => number = () => PLAYER_DELAY_MS;
export function registerNpcInterp(i: Interpolator): void {
  npcDelayGetter = () => i.delayMs();
}
/** How far in the past the client renders ENEMIES this frame (ms). The server
 *  rewinds its melee hitbox by exactly this so swings land where you aimed. */
export function getNpcInterpDelayMs(): number {
  return npcDelayGetter();
}

// Buffer-underrun telemetry: counts every frame a MOVING entity had to coast/
// extrapolate because the interp buffer ran dry. The netdebug overlay diffs this
// into a per-second rate — the primary signal for sizing the adaptive delay: a
// nonzero, sustained rate means the buffer is too small for that player's jitter/
// loss (raise the floor/K); a flat 0 means there's headroom to trim for less lag.
let coastEvents = 0;
/** Total interp coast/underrun events since load (overlay diffs it into a rate). */
export function getCoastEvents(): number {
  return coastEvents;
}

/** Record an incoming position packet for a remote player. `t` is its client-clock
 *  snapshot time (server send-time mapped via the clock offset); omitted → now. */
export function pushRemoteSnapshot(
  id: string,
  x: number,
  y: number,
  direction: Direction,
  frame: number,
  pose: Pose,
  t?: number
): void {
  players.push(id, x, y, direction, frame, pose, t);
}

/** The remote-player render delay (ms) in effect this frame — for the net overlay. */
export function getInterpDelayMs(): number {
  return players.delayMs();
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
