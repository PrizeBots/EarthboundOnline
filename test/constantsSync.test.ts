// Drift guard for the client↔server mirrored movement/stamina constants.
// The client copy is src/engine/moveConstants.ts; the server copy is the
// MIRRORED_CONSTANTS export in server/gameHost.js. The old "KEEP IN SYNC"
// comments were the only guard — this makes a one-sided edit a CI failure.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as client from '../src/engine/moveConstants';

const require = createRequire(import.meta.url);
const { MIRRORED_CONSTANTS: server } = require('../server/gameHost.js');

describe('client/server mirrored constants', () => {
  it('walk-speed formula inputs match', () => {
    expect(server.SPEED_BASE).toBe(client.SPEED_BASE);
    expect(server.SPEED_PER_STAT).toBe(client.SPEED_PER_STAT);
    expect(server.SPEED_MIN).toBe(client.SPEED_MIN);
    expect(server.SPEED_MAX).toBe(client.SPEED_MAX);
  });

  it('run + stamina economy matches', () => {
    expect(server.RUN_MULT).toBe(client.RUN_MULT);
    // Server drains per 60Hz movement step; client predicts per second.
    expect(server.RUN_DRAIN_PER_STEP).toBeCloseTo(client.RUN_DRAIN_PER_SEC / 60, 10);
    expect(server.STAMINA_ATTACK_COST).toBe(client.STAMINA_ATTACK_COST);
    expect(server.RUN_RECOVER_FRAC).toBe(client.RUN_RECOVER_FRAC);
  });

  it('player collision box matches', () => {
    expect(server.PLAYER_COL_W).toBe(client.PLAYER_COL_W);
    expect(server.PLAYER_COL_H).toBe(client.PLAYER_COL_H);
    expect(server.PLAYER_COL_OY).toBe(client.PLAYER_COL_OY);
  });
});
