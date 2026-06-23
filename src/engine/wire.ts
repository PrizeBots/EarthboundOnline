/**
 * Binary wire codec for the high-rate position firehose (NETWORK_REMODEL.md §5).
 *
 * Byte-for-byte MIRROR of `server/wire.js`. Hand-packed, little-endian, fixed
 * layout. The client primarily DECODES (server→client) but encode is included
 * for symmetry + tests. Wired in behind the server's `BINARY_WIRE` flag at the
 * receive site (separate step); the client detects a binary frame by its type
 * (ArrayBuffer/Blob) vs a JSON string.
 *
 * Coordinates ride as round(v*2) in a uint16 (half-pixel fixed point); decode
 * divides by 2. See server/wire.js for the full layout + golden vector.
 */

import type { NpcUpdate } from './Network';
import { POSES, type Pose, type Direction } from '../types';

export const TAG = {
  NPC_UPDATE: 0x01,
  PLAYER_MOVE: 0x02,
  NPC_DELTA: 0x03,
  PLAYER_DELTA: 0x04,
} as const;
const NPC_ROW_BYTES = 11;
const NPC_HEADER_BYTES = 5;
const PLAYER_MOVE_BYTES = 12;
const TS_BYTES = 4; // trailing uint32 server-send timestamp on every frame (see server/wire.js)
const F_KEY = 1;
const F_DIR = 2;
const F_FRAME = 4;
const F_POSE = 8;

/** Per-client npc_delta baseline: id → [x2, y2, dir, frame, pose] (half-pixel). */
export type NpcBase = Map<number, [number, number, number, number, number]>;

function asDataView(buf: ArrayBuffer | Uint8Array): DataView {
  if (buf instanceof Uint8Array) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return new DataView(buf);
}

/** First byte = message tag; lets the receiver dispatch a binary frame. */
export function frameTag(buf: ArrayBuffer | Uint8Array): number {
  return asDataView(buf).getUint8(0);
}

/** Encode an npc_update batch → ArrayBuffer (mirror of server encodeNpcUpdate).
 *  `ts` is the server send time (ms) appended as a trailing uint32. */
export function encodeNpcUpdate(npcs: NpcUpdate[], over = 0, ts = 0): ArrayBuffer {
  const n = npcs.length;
  const ab = new ArrayBuffer(NPC_HEADER_BYTES + n * NPC_ROW_BYTES + TS_BYTES);
  const dv = new DataView(ab);
  dv.setUint8(0, TAG.NPC_UPDATE);
  dv.setUint16(1, n, true);
  dv.setUint16(3, over & 0xffff, true);
  let o = NPC_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const r = npcs[i];
    dv.setUint32(o, r[0] >>> 0, true);
    dv.setUint16(o + 4, Math.round((r[1] as number) * 2) & 0xffff, true);
    dv.setUint16(o + 6, Math.round((r[2] as number) * 2) & 0xffff, true);
    dv.setUint8(o + 8, (r[3] as number) & 0xff);
    dv.setUint8(o + 9, (r[4] as number) & 0xff);
    dv.setUint8(o + 10, (r[5] as number) & 0xff);
    o += NPC_ROW_BYTES;
  }
  dv.setUint32(o, ts >>> 0, true);
  return ab;
}

/** Decode an npc_update binary frame → { npcs, over, ts }. Tag assumed at byte 0. */
export function decodeNpcUpdate(buf: ArrayBuffer | Uint8Array): {
  npcs: NpcUpdate[];
  over: number;
  ts: number;
} {
  const dv = asDataView(buf);
  const n = dv.getUint16(1, true);
  const over = dv.getUint16(3, true);
  const npcs: NpcUpdate[] = new Array(n);
  let o = NPC_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    npcs[i] = [
      dv.getUint32(o, true),
      dv.getUint16(o + 4, true) / 2,
      dv.getUint16(o + 6, true) / 2,
      dv.getUint8(o + 8),
      dv.getUint8(o + 9),
      dv.getUint8(o + 10),
    ] as unknown as NpcUpdate;
    o += NPC_ROW_BYTES;
  }
  return { npcs, over, ts: dv.getUint32(o, true) };
}

export interface PlayerMoveMsg {
  id: string;
  x: number;
  y: number;
  direction: Direction;
  frame: number;
  pose: Pose;
  /** Server send time (ms, server clock) decoded from the trailing timestamp. */
  ts?: number;
}

/** Encode one player_move → ArrayBuffer (mirror of server encodePlayerMove).
 *  `ts` is the server send time (ms) appended as a trailing uint32. */
export function encodePlayerMove(d: PlayerMoveMsg, ts = 0): ArrayBuffer {
  const ab = new ArrayBuffer(PLAYER_MOVE_BYTES + TS_BYTES);
  const dv = new DataView(ab);
  dv.setUint8(0, TAG.PLAYER_MOVE);
  dv.setUint32(1, parseInt(d.id, 10) >>> 0, true);
  dv.setUint16(5, Math.round(d.x * 2) & 0xffff, true);
  dv.setUint16(7, Math.round(d.y * 2) & 0xffff, true);
  dv.setUint8(9, d.direction & 0xff);
  dv.setUint8(10, d.frame & 0xff);
  dv.setUint8(11, Math.max(0, POSES.indexOf(d.pose)));
  dv.setUint32(PLAYER_MOVE_BYTES, ts >>> 0, true);
  return ab;
}

/**
 * Decode an npc_delta frame (TAG 0x03) against `base`, the EXACT mirror of the
 * server's encodeNpcDelta (server/wire.js). Mutates `base` per row, identically
 * to the server, so the two stay in sync on a reliable, ordered channel.
 */
export function decodeNpcDelta(
  buf: ArrayBuffer | Uint8Array,
  base: NpcBase
): { npcs: NpcUpdate[]; over: number; ts: number } {
  const dv = asDataView(buf);
  const n = dv.getUint16(1, true);
  const over = dv.getUint16(3, true);
  const npcs: NpcUpdate[] = new Array(n);
  let o = NPC_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const id = dv.getUint32(o, true);
    const flags = dv.getUint8(o + 4);
    o += 5;
    const prev = base.get(id) ?? [0, 0, 0, 0, 0];
    let x2: number;
    let y2: number;
    if (flags & F_KEY) {
      x2 = dv.getUint16(o, true);
      y2 = dv.getUint16(o + 2, true);
      o += 4;
    } else {
      x2 = prev[0] + dv.getInt8(o);
      y2 = prev[1] + dv.getInt8(o + 1);
      o += 2;
    }
    let dir = prev[2];
    let frame = prev[3];
    let pose = prev[4];
    if (flags & F_DIR) dir = dv.getUint8(o++);
    if (flags & F_FRAME) frame = dv.getUint8(o++);
    if (flags & F_POSE) pose = dv.getUint8(o++);
    base.set(id, [x2, y2, dir, frame, pose]);
    npcs[i] = [id, x2 / 2, y2 / 2, dir, frame, pose] as unknown as NpcUpdate;
  }
  return { npcs, over, ts: dv.getUint32(o, true) };
}

/**
 * Decode a player_delta frame (TAG 0x04) against `base` (per-player baseline) —
 * exact mirror of server encodePlayerDelta. Mutates `base` identically so the two
 * stay in sync on a reliable, ordered channel.
 */
export function decodePlayerDelta(buf: ArrayBuffer | Uint8Array, base: NpcBase): PlayerMoveMsg {
  const dv = asDataView(buf);
  const id = dv.getUint32(1, true);
  const flags = dv.getUint8(5);
  const prev = base.get(id) ?? [0, 0, 0, 0, 0];
  let o = 6;
  let x2: number;
  let y2: number;
  if (flags & F_KEY) {
    x2 = dv.getUint16(o, true);
    y2 = dv.getUint16(o + 2, true);
    o += 4;
  } else {
    x2 = prev[0] + dv.getInt8(o);
    y2 = prev[1] + dv.getInt8(o + 1);
    o += 2;
  }
  let dir = prev[2];
  let frame = prev[3];
  let pose = prev[4];
  if (flags & F_DIR) dir = dv.getUint8(o++);
  if (flags & F_FRAME) frame = dv.getUint8(o++);
  if (flags & F_POSE) pose = dv.getUint8(o++);
  const ts = dv.getUint32(o, true);
  base.set(id, [x2, y2, dir, frame, pose]);
  return {
    id: String(id),
    x: x2 / 2,
    y: y2 / 2,
    direction: dir as Direction,
    frame,
    pose: (POSES[pose] ?? 'walk') as Pose,
    ts,
  };
}

/** Decode a player_move binary frame → PlayerMoveMsg. Tag assumed at byte 0. */
export function decodePlayerMove(buf: ArrayBuffer | Uint8Array): PlayerMoveMsg {
  const dv = asDataView(buf);
  return {
    id: String(dv.getUint32(1, true)),
    x: dv.getUint16(5, true) / 2,
    y: dv.getUint16(7, true) / 2,
    direction: dv.getUint8(9) as Direction,
    frame: dv.getUint8(10),
    pose: (POSES[dv.getUint8(11)] ?? 'walk') as Pose,
    ts: dv.getUint32(PLAYER_MOVE_BYTES, true),
  };
}
