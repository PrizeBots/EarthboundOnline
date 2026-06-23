// Lockstep contract for the binary firehose codec: the server (server/wire.js,
// CommonJS) ENCODES and the client (src/engine/wire.ts) DECODES the very same
// bytes — and vice-versa. Guards the hand-packed byte layout from drifting
// between the two mirrors, and specifically that the trailing uint32 server-send
// timestamp (clock-sync / jitter-immune interp) round-trips on every frame type,
// including the variable-length delta frames where its placement is subtlest.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  decodeNpcUpdate,
  decodeNpcDelta,
  decodePlayerMove,
  decodePlayerDelta,
  encodeNpcUpdate,
  encodePlayerMove,
  type NpcBase,
  type PlayerMoveMsg,
} from '../src/engine/wire';

const require = createRequire(import.meta.url);
// Server-side codec (CommonJS). Pure (no I/O), so it loads fine under vitest.
const sw = require('../server/wire.js');

const TS = 0x01020304; // a recognisable non-trivial timestamp

describe('wire codec — server encode → client decode', () => {
  it('npc_update preserves rows, over, and the trailing ts', () => {
    const rows = [
      [1000, 100, 200.5, 3, 2, 1],
      [70000, 50.5, 60, 7, 0, 0],
    ];
    const got = decodeNpcUpdate(sw.encodeNpcUpdate(rows, 5, TS));
    expect(got.over).toBe(5);
    expect(got.ts).toBe(TS);
    expect(got.npcs).toEqual(rows);
  });

  it('player_move preserves fields + ts', () => {
    const got = decodePlayerMove(
      sw.encodePlayerMove({ id: '1234', x: 12.5, y: 34, direction: 2, frame: 5, pose: 'walk' }, TS)
    );
    expect(got).toMatchObject({ id: '1234', x: 12.5, y: 34, direction: 2, frame: 5, pose: 'walk' });
    expect(got.ts).toBe(TS);
  });

  it('npc_delta keyframe then delta both carry ts (variable length)', () => {
    const sBase = new Map();
    const cBase: NpcBase = new Map();
    const key = sw.encodeNpcDelta([[1, 100, 100, 0, 0, 0]], sBase, 0, TS);
    const k = decodeNpcDelta(key, cBase);
    expect(k.npcs[0]).toEqual([1, 100, 100, 0, 0, 0]);
    expect(k.ts).toBe(TS);

    // Second frame: small move → encoded as int8 dx/dy (the delta path), ts still
    // trailing after the variable-length body.
    const TS2 = 0x0a0b0c0d;
    const d = decodeNpcDelta(sw.encodeNpcDelta([[1, 103, 98, 0, 1, 0]], sBase, 0, TS2), cBase);
    expect(d.npcs[0]).toEqual([1, 103, 98, 0, 1, 0]);
    expect(d.ts).toBe(TS2);
  });

  it('player_delta keyframe + delta carry ts', () => {
    const sBase = new Map();
    const cBase: NpcBase = new Map();
    const k = decodePlayerDelta(
      sw.encodePlayerDelta(
        { id: '7', x: 200, y: 200, direction: 1, frame: 0, pose: 'walk' },
        sBase,
        TS
      ),
      cBase
    );
    expect(k).toMatchObject({ id: '7', x: 200, y: 200, direction: 1 });
    expect(k.ts).toBe(TS);

    const d = decodePlayerDelta(
      sw.encodePlayerDelta(
        { id: '7', x: 202, y: 199, direction: 1, frame: 1, pose: 'walk' },
        sBase,
        9
      ),
      cBase
    );
    expect(d).toMatchObject({ id: '7', x: 202, y: 199, frame: 1 });
    expect(d.ts).toBe(9);
  });
});

describe('wire codec — client encode → server decode (symmetry)', () => {
  it('npc_update round-trips back through the server decoder', () => {
    const rows = [[42, 10, 20, 1, 0, 2]] as unknown as Parameters<typeof encodeNpcUpdate>[0];
    const ab = encodeNpcUpdate(rows, 0, TS);
    const got = sw.decodeNpcUpdate(Buffer.from(ab));
    expect(got.ts).toBe(TS);
    expect(got.npcs).toEqual([[42, 10, 20, 1, 0, 2]]);
  });

  it('player_move round-trips back through the server decoder', () => {
    const msg: PlayerMoveMsg = { id: '9', x: 5, y: 6, direction: 0, frame: 3, pose: 'walk' };
    const got = sw.decodePlayerMove(Buffer.from(encodePlayerMove(msg, TS)));
    expect(got.ts).toBe(TS);
    expect(got).toMatchObject({ id: '9', x: 5, y: 6, frame: 3 });
  });
});
