'use strict';
/**
 * Binary wire codec for the high-rate position firehose (NETWORK_REMODEL.md §5).
 *
 * Hand-packed, little-endian, FIXED layout — mirrored byte-for-byte in
 * `src/engine/wire.ts`. Pure (no I/O) so it round-trips in unit tests. Wired in
 * behind a `BINARY_WIRE` flag at the send/receive sites (separate step); this
 * module only defines the format + encode/decode.
 *
 * Coordinates ride as round(v*2) in a uint16 (half-pixel fixed point, matching
 * the sim's half-pixel rounding); decode divides by 2. The world is < ~10k px
 * per axis, so v*2 < 65535 — fits.
 *
 * npc_update layout (TAG 0x01):
 *   off size field
 *   0   1    tag = 0x01
 *   1   2    count  (uint16, number of rows)
 *   3   2    over   (uint16, crowd-cap overflow)
 *   5   ...  rows, each 11 bytes:
 *        4   id     (uint32)
 *        2   x*2    (uint16)
 *        2   y*2    (uint16)
 *        1   dir    (uint8)
 *        1   frame  (uint8)
 *        1   pose   (uint8, poseCode)
 *   end 4    ts     (uint32, server send time in ms — see below)
 *
 * TRAILING TIMESTAMP (clock-sync / jitter-immune interp): EVERY frame ends with a
 * uint32 server send time (a single server clock, ms). The client maps it to its
 * own clock (via the ping/pong offset) and buffers snapshots on the SERVER-time
 * axis, so arrival jitter no longer warps playback speed. It rides at the END (not
 * the header) because every decoder is COUNT-driven — it reads exactly `count`
 * rows then stops, leaving the cursor exactly on the ts — so appending it shifts
 * no existing offset and keeps the golden-vector prefix byte-identical.
 *
 * Golden vector (lockstep contract — the SAME bytes must decode in wire.ts):
 *   encodeNpcUpdate([[1000,100,200.5,3,2,1],[70000,50.5,60,7,0,0]], 5, 0x01020304) ===
 *   01 0200 0500  E8030000 C800 9101 03 02 01  70110100 6500 7800 07 00 00  04030201
 */

const TAG = { NPC_UPDATE: 0x01, PLAYER_MOVE: 0x02, NPC_DELTA: 0x03, PLAYER_DELTA: 0x04 };
const NPC_ROW_BYTES = 11;
const NPC_HEADER_BYTES = 5;
const TS_BYTES = 4; // trailing uint32 server-send timestamp on every frame
// npc_delta per-row flag bits.
const F_KEY = 1; // absolute x,y present (uint16); else dx,dy (int8) vs baseline
const F_DIR = 2; // dir byte present (changed)
const F_FRAME = 4; // frame byte present (changed)
const F_POSE = 8; // pose byte present (changed)
// Pose code table — MUST mirror POSES in src/types.ts (wire.ts imports it there).
const POSES = ['walk', 'climb', 'attack', 'hurt', 'peace', 'laying'];
const poseIdx = (p) => {
  const i = POSES.indexOf(p);
  return i < 0 ? 0 : i;
};

/** Encode an npc_update batch (rows = [[id,x,y,dir,frame,pose],...]) → Buffer.
 *  `ts` is the server send time (ms) appended as a trailing uint32. */
function encodeNpcUpdate(npcs, over = 0, ts = 0) {
  const n = npcs.length;
  const buf = Buffer.allocUnsafe(NPC_HEADER_BYTES + n * NPC_ROW_BYTES + TS_BYTES);
  buf.writeUInt8(TAG.NPC_UPDATE, 0);
  buf.writeUInt16LE(n, 1);
  buf.writeUInt16LE(over & 0xffff, 3);
  let o = NPC_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const r = npcs[i];
    buf.writeUInt32LE(r[0] >>> 0, o);
    buf.writeUInt16LE(Math.round(r[1] * 2) & 0xffff, o + 4);
    buf.writeUInt16LE(Math.round(r[2] * 2) & 0xffff, o + 6);
    buf.writeUInt8(r[3] & 0xff, o + 8);
    buf.writeUInt8(r[4] & 0xff, o + 9);
    buf.writeUInt8(r[5] & 0xff, o + 10);
    o += NPC_ROW_BYTES;
  }
  buf.writeUInt32LE(ts >>> 0, o);
  return buf;
}

/** Decode an npc_update Buffer → { type, npcs, over, ts }. Tag is assumed at byte 0. */
function decodeNpcUpdate(buf) {
  const n = buf.readUInt16LE(1);
  const over = buf.readUInt16LE(3);
  const npcs = new Array(n);
  let o = NPC_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    npcs[i] = [
      buf.readUInt32LE(o),
      buf.readUInt16LE(o + 4) / 2,
      buf.readUInt16LE(o + 6) / 2,
      buf.readUInt8(o + 8),
      buf.readUInt8(o + 9),
      buf.readUInt8(o + 10),
    ];
    o += NPC_ROW_BYTES;
  }
  return { type: 'npc_update', npcs, over, ts: buf.readUInt32LE(o) };
}

/**
 * player_move layout (TAG 0x02), 12 bytes — a single moving player:
 *   0  1  tag = 0x02
 *   1  4  id      (uint32; player ids are numeric strings → parsed)
 *   5  2  x*2     (uint16)
 *   7  2  y*2     (uint16)
 *   9  1  dir     (uint8)
 *   10 1  frame   (uint8)
 *   11 1  pose    (uint8, POSES index)
 */
const PLAYER_MOVE_BYTES = 12;

/** Encode one player_move {id,x,y,direction,frame,pose} → Buffer.
 *  `ts` is the server send time (ms) appended as a trailing uint32. */
function encodePlayerMove(d, ts = 0) {
  const buf = Buffer.allocUnsafe(PLAYER_MOVE_BYTES + TS_BYTES);
  buf.writeUInt8(TAG.PLAYER_MOVE, 0);
  buf.writeUInt32LE(parseInt(d.id, 10) >>> 0, 1);
  buf.writeUInt16LE(Math.round(d.x * 2) & 0xffff, 5);
  buf.writeUInt16LE(Math.round(d.y * 2) & 0xffff, 7);
  buf.writeUInt8(d.direction & 0xff, 9);
  buf.writeUInt8(d.frame & 0xff, 10);
  buf.writeUInt8(poseIdx(d.pose), 11);
  buf.writeUInt32LE(ts >>> 0, PLAYER_MOVE_BYTES);
  return buf;
}

/** Decode a player_move Buffer → {type,id,x,y,direction,frame,pose,ts}. */
function decodePlayerMove(buf) {
  return {
    type: 'player_move',
    id: String(buf.readUInt32LE(1)),
    x: buf.readUInt16LE(5) / 2,
    y: buf.readUInt16LE(7) / 2,
    direction: buf.readUInt8(9),
    frame: buf.readUInt8(10),
    pose: POSES[buf.readUInt8(11)] || 'walk',
    ts: buf.readUInt32LE(PLAYER_MOVE_BYTES),
  };
}

/**
 * npc_delta (TAG 0x03) — delta-coded npc_update against a per-client baseline
 * (NETWORK_REMODEL.md §5). encode + decode are EXACT INVERSES over a shared
 * `base` Map<id,[x2,y2,dir,frame,pose]> (half-pixel coords): the server keeps one
 * base per client, the client keeps its own, and every row updates both maps
 * identically — so on a reliable, ordered channel they never desync.
 *
 *   header: tag(1) count(2) over(2)
 *   row:    id(4) flags(1)
 *           pos:  KEY → x2(u16) y2(u16);  else dx(i8) dy(i8)
 *           dir(u8) / frame(u8) / pose(u8) — only if that flag bit is set
 *
 * A field is sent only when it changed (or on first sight / a >127 half-pixel
 * jump, which forces a KEY). Typical moving NPC: id+flags+dx+dy+frame = 8 bytes.
 */
function encodeNpcDelta(rows, base, over = 0, ts = 0) {
  const descs = [];
  let size = NPC_HEADER_BYTES;
  for (const r of rows) {
    const id = r[0];
    const x2 = Math.round(r[1] * 2);
    const y2 = Math.round(r[2] * 2);
    const dir = r[3] & 0xff;
    const frame = r[4] & 0xff;
    const pose = r[5] & 0xff;
    const prev = base.get(id);
    let flags = 0;
    let p0;
    let p1;
    if (!prev || Math.abs(x2 - prev[0]) > 127 || Math.abs(y2 - prev[1]) > 127) {
      flags |= F_KEY;
      p0 = x2;
      p1 = y2;
      size += 4;
    } else {
      p0 = x2 - prev[0];
      p1 = y2 - prev[1];
      size += 2;
    }
    if (!prev || dir !== prev[2]) {
      flags |= F_DIR;
      size += 1;
    }
    if (!prev || frame !== prev[3]) {
      flags |= F_FRAME;
      size += 1;
    }
    if (!prev || pose !== prev[4]) {
      flags |= F_POSE;
      size += 1;
    }
    size += 5; // id + flags
    descs.push([id, flags, p0, p1, dir, frame, pose]);
    base.set(id, [x2, y2, dir, frame, pose]);
  }
  const buf = Buffer.allocUnsafe(size + TS_BYTES);
  buf.writeUInt8(TAG.NPC_DELTA, 0);
  buf.writeUInt16LE(descs.length, 1);
  buf.writeUInt16LE(over & 0xffff, 3);
  let o = NPC_HEADER_BYTES;
  for (const [id, flags, p0, p1, dir, frame, pose] of descs) {
    buf.writeUInt32LE(id >>> 0, o);
    buf.writeUInt8(flags, o + 4);
    o += 5;
    if (flags & F_KEY) {
      buf.writeUInt16LE(p0 & 0xffff, o);
      buf.writeUInt16LE(p1 & 0xffff, o + 2);
      o += 4;
    } else {
      buf.writeInt8(p0, o);
      buf.writeInt8(p1, o + 1);
      o += 2;
    }
    if (flags & F_DIR) buf.writeUInt8(dir, o++);
    if (flags & F_FRAME) buf.writeUInt8(frame, o++);
    if (flags & F_POSE) buf.writeUInt8(pose, o++);
  }
  buf.writeUInt32LE(ts >>> 0, o);
  return buf;
}

function decodeNpcDelta(buf, base) {
  const n = buf.readUInt16LE(1);
  const over = buf.readUInt16LE(3);
  const npcs = new Array(n);
  let o = NPC_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const id = buf.readUInt32LE(o);
    const flags = buf.readUInt8(o + 4);
    o += 5;
    const prev = base.get(id) || [0, 0, 0, 0, 0];
    let x2;
    let y2;
    if (flags & F_KEY) {
      x2 = buf.readUInt16LE(o);
      y2 = buf.readUInt16LE(o + 2);
      o += 4;
    } else {
      x2 = prev[0] + buf.readInt8(o);
      y2 = prev[1] + buf.readInt8(o + 1);
      o += 2;
    }
    let dir = prev[2];
    let frame = prev[3];
    let pose = prev[4];
    if (flags & F_DIR) dir = buf.readUInt8(o++);
    if (flags & F_FRAME) frame = buf.readUInt8(o++);
    if (flags & F_POSE) pose = buf.readUInt8(o++);
    base.set(id, [x2, y2, dir, frame, pose]);
    npcs[i] = [id, x2 / 2, y2 / 2, dir, frame, pose];
  }
  return { type: 'npc_update', npcs, over, ts: buf.readUInt32LE(o) };
}

/**
 * player_delta (TAG 0x04) — delta-coded single player_move against a PER-VIEWER
 * baseline (NETWORK_REMODEL.md §5). Same flag scheme as npc_delta, one entity:
 *   tag(1) id(4) flags(1) [KEY: x2,y2 | dx,dy(i8)] [dir/frame/pose if changed]
 * Each viewer keeps its own `base` (id→[x2,y2,dir,frame,pose]); the server keeps a
 * matching per-viewer base. First sight / >127 jump → KEY. End-to-end correct
 * across despawn/respawn (delta = end - baseline, regardless of path).
 */
function encodePlayerDelta(d, base, ts = 0) {
  const id = parseInt(d.id, 10) >>> 0;
  const x2 = Math.round(d.x * 2);
  const y2 = Math.round(d.y * 2);
  const dir = d.direction & 0xff;
  const frame = d.frame & 0xff;
  const pose = poseIdx(d.pose);
  const prev = base.get(id);
  let flags = 0;
  let size = 6; // tag + id + flags
  const key = !prev || Math.abs(x2 - prev[0]) > 127 || Math.abs(y2 - prev[1]) > 127;
  if (key) {
    flags |= F_KEY;
    size += 4;
  } else {
    size += 2;
  }
  if (!prev || dir !== prev[2]) {
    flags |= F_DIR;
    size += 1;
  }
  if (!prev || frame !== prev[3]) {
    flags |= F_FRAME;
    size += 1;
  }
  if (!prev || pose !== prev[4]) {
    flags |= F_POSE;
    size += 1;
  }
  const buf = Buffer.allocUnsafe(size + TS_BYTES);
  buf.writeUInt8(TAG.PLAYER_DELTA, 0);
  buf.writeUInt32LE(id, 1);
  buf.writeUInt8(flags, 5);
  let o = 6;
  if (key) {
    buf.writeUInt16LE(x2 & 0xffff, o);
    buf.writeUInt16LE(y2 & 0xffff, o + 2);
    o += 4;
  } else {
    buf.writeInt8(x2 - prev[0], o);
    buf.writeInt8(y2 - prev[1], o + 1);
    o += 2;
  }
  if (flags & F_DIR) buf.writeUInt8(dir, o++);
  if (flags & F_FRAME) buf.writeUInt8(frame, o++);
  if (flags & F_POSE) buf.writeUInt8(pose, o++);
  buf.writeUInt32LE(ts >>> 0, o);
  base.set(id, [x2, y2, dir, frame, pose]);
  return buf;
}

function decodePlayerDelta(buf, base) {
  const id = buf.readUInt32LE(1);
  const flags = buf.readUInt8(5);
  const prev = base.get(id) || [0, 0, 0, 0, 0];
  let o = 6;
  let x2;
  let y2;
  if (flags & F_KEY) {
    x2 = buf.readUInt16LE(o);
    y2 = buf.readUInt16LE(o + 2);
    o += 4;
  } else {
    x2 = prev[0] + buf.readInt8(o);
    y2 = prev[1] + buf.readInt8(o + 1);
    o += 2;
  }
  let dir = prev[2];
  let frame = prev[3];
  let pose = prev[4];
  if (flags & F_DIR) dir = buf.readUInt8(o++);
  if (flags & F_FRAME) frame = buf.readUInt8(o++);
  if (flags & F_POSE) pose = buf.readUInt8(o++);
  const ts = buf.readUInt32LE(o);
  base.set(id, [x2, y2, dir, frame, pose]);
  return {
    type: 'player_move',
    id: String(id),
    x: x2 / 2,
    y: y2 / 2,
    direction: dir,
    frame,
    pose: POSES[pose] || 'walk',
    ts,
  };
}

module.exports = {
  TAG,
  POSES,
  NPC_ROW_BYTES,
  NPC_HEADER_BYTES,
  PLAYER_MOVE_BYTES,
  encodeNpcUpdate,
  decodeNpcUpdate,
  encodePlayerMove,
  decodePlayerMove,
  encodeNpcDelta,
  decodeNpcDelta,
  encodePlayerDelta,
  decodePlayerDelta,
};
