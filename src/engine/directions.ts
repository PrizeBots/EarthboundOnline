// Canonical Direction → unit facing vector table, indexed by the src/types
// Direction enum order (S, N, W, E, NW, SW, SE, NE). Diagonals are normalized
// (±Math.SQRT1_2) so every facing moves/aims at the same magnitude.
//
// NOTE: the SERVER mirrors these values in server/npcSim.js (DIR_VEC) — keep
// the two in sync if they ever change.

const DIAG = Math.SQRT1_2;

export const DIR_VEC: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // S
  [0, -1], // N
  [-1, 0], // W
  [1, 0], // E
  [-DIAG, -DIAG], // NW
  [-DIAG, DIAG], // SW
  [DIAG, DIAG], // SE
  [DIAG, -DIAG], // NE
];
