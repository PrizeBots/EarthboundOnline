'use strict';
/**
 * Socket-free sim micro-benchmark. Drives npcSim DIRECTLY with N synthetic players
 * scattered across the whole map (so every actor is "near" someone — the worst case
 * for the per-actor proximity scans), jittering them each frame to keep movement/
 * collision/broadcast hot. No WebSockets, no Vite, no client AI — so the PROFILE_SIM
 * dump is the PURE server sim cost, and N scales to thousands trivially (a real 1000
 * -socket test is gated by localhost connection limits; this isn't).
 *
 *   PROFILE_SIM=1 node server/sim_microbench.js [N=1000] [seconds=8] [mode=spread]
 *
 * mode: spread (blanket the map — stresses ai/resync) | crowd (one blob — stresses
 *       the broadcast/dirty scan, like an io-game pile-up).
 *
 * Compares directly against the in-game simProfile output (same phase names).
 */
process.env.PROFILE_SIM = process.env.PROFILE_SIM || '1';

const path = require('path');
const { createNpcSim } = require('./npcSim');

const N = Number(process.argv[2]) || 1000;
const RUN_MS = (Number(process.argv[3]) || 8) * 1000;
const MODE = process.argv[4] || 'spread';
const ASSETS = path.join(__dirname, '..', 'public', 'assets');

const sim = createNpcSim(ASSETS);
const { w: W, h: H } = sim.bounds();

// Scatter N players. spread = uniform over the whole walkable map (worst case for
// the proximity scans); crowd = a tight blob (worst case for the per-mover publish).
const players = [];
for (let i = 0; i < N; i++) {
  const x = MODE === 'crowd' ? W / 2 + (Math.random() * 256 - 128) : Math.random() * W;
  const y = MODE === 'crowd' ? H / 2 + (Math.random() * 256 - 128) : Math.random() * H;
  players.push({ id: 'p' + i, x, y, hp: 100, maxHp: 100, direction: 0, level: 1, editor: false });
}

const noop = () => {};
// start(getPlayers, broadcast, onEnemyHit, onEnemyKill, onPlayerHit, onPickup, onPlayerShove)
sim.start(() => players, noop, noop, noop, noop, noop, noop);

// Jitter every player each ~33ms so movement/AOI/collision stay live (a static world
// would let the dirty-scan go quiet and understate the broadcast cost).
const drive = setInterval(() => {
  for (const p of players) {
    p.x = Math.max(0, Math.min(W - 1, p.x + (Math.random() * 4 - 2)));
    p.y = Math.max(0, Math.min(H - 1, p.y + (Math.random() * 4 - 2)));
  }
}, 33);

console.log(
  `sim_microbench: N=${N} mode=${MODE} map=${Math.round(W)}x${Math.round(H)} for ${RUN_MS}ms`
);
setTimeout(() => {
  clearInterval(drive);
  process.exit(0);
}, RUN_MS);
