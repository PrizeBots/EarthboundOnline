/**
 * simProfile — lightweight per-phase tick profiler for the server sim loops.
 *
 * Gated by the PROFILE_SIM=1 env var: when off, every call is a cheap no-op so
 * it's safe to leave wired into the hot loops permanently. When on, it sums
 * wall-time per named phase and every DUMP_MS prints an averaged ms/sec
 * breakdown plus the live actor/player counts — so a bot ramp (1 → 25 → 50 →
 * 100) shows which phase's cost grows with N (linear = per-entity work;
 * super-linear = an O(N^2) hotspot).
 *
 *   PROFILE_SIM=1 npm run dev      # or set it before booting the standalone server
 *
 * Usage (lap style — no closures, so loop `continue`/`break` are unaffected):
 *   prof.begin();                  // mark the start of a tick
 *   ...work...;  prof.lap('grids');
 *   ...work...;  prof.lap('ai');
 *   prof.setContext(players, actors, hz);
 *   prof.frame();                  // call once per driving tick; dumps every 2s
 *
 * Output (every 2s):
 *   [simProfile] 96 players, 1364 actors | npcTick 41.2Hz
 *     ai          312.4 ms/s  (52%)   <- biggest = the bottleneck
 *     npcBroadcast 118.7 ms/s (20%)
 *     ...
 *     TOTAL       601.0 ms/s  of 1000  (60% of one core)
 */

const { performance } = require('perf_hooks');

const ON = process.env.PROFILE_SIM === '1';

// phase name -> accumulated ms since the last dump
const acc = new Map();
let lastDumpAt = 0;
const DUMP_MS = 2000;

// Lap cursor. The sim callbacks are synchronous and never interleave (one event
// loop, no await), so a single shared cursor is safe across both loops.
let cursor = 0;

// Live context the dump prints alongside the phase costs.
let ctx = { players: 0, actors: 0, npcHz: 0 };

/** Whether profiling is active (lets callers skip building debug context). */
function enabled() {
  return ON;
}

/** Mark the start of a phase sequence within one tick. */
function begin() {
  if (!ON) return;
  cursor = performance.now();
}

/** Attribute the time since the previous begin()/lap() to `phase`. */
function lap(phase) {
  if (!ON) return;
  const now = performance.now();
  acc.set(phase, (acc.get(phase) || 0) + (now - cursor));
  cursor = now;
}

/** High-res clock for ad-hoc sub-phase timing (paired with add()). */
function now() {
  return ON ? performance.now() : 0;
}

/** Add a pre-measured ms span to `phase` (for sub-phase timing inside a loop,
 *  where the single lap() cursor can't be used). No-op when disabled. */
function add(phase, ms) {
  if (!ON) return;
  acc.set(phase, (acc.get(phase) || 0) + ms);
}

/** Record live counts for the next dump (cheap setter, safe to call each tick). */
function setContext(players, actors, npcHz) {
  if (!ON) return;
  ctx = { players, actors, npcHz };
}

/** Call once per driving tick; emits a breakdown every DUMP_MS. */
function frame() {
  if (!ON) return;
  const now = performance.now();
  if (!lastDumpAt) {
    lastDumpAt = now;
    return;
  }
  const elapsed = now - lastDumpAt;
  if (elapsed < DUMP_MS) return;
  lastDumpAt = now;

  const rows = [];
  let total = 0;
  for (const [phase, ms] of acc) {
    const msPerSec = (ms / elapsed) * 1000;
    total += msPerSec;
    rows.push({ phase, msPerSec });
  }
  acc.clear();
  rows.sort((a, b) => b.msPerSec - a.msPerSec);

  const pad = (s, n) => String(s).padEnd(n);
  const lines = rows.map((r) => {
    const pct = total > 0 ? Math.round((r.msPerSec / total) * 100) : 0;
    return `    ${pad(r.phase, 13)}${r.msPerSec.toFixed(1).padStart(7)} ms/s  (${String(pct).padStart(2)}%)`;
  });
  const head =
    `[simProfile] ${ctx.players} players, ${ctx.actors} actors | ` +
    `npcTick ${ctx.npcHz.toFixed(1)}Hz`;
  const tail =
    `    ${pad('TOTAL', 13)}${total.toFixed(1).padStart(7)} ms/s  of 1000  ` +
    `(${Math.round((total / 1000) * 100)}% of one core)`;

  console.log([head, ...lines, tail].join('\n'));
}

module.exports = { enabled, begin, lap, now, add, setContext, frame };
