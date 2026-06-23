/**
 * Bandwidth measurement (NETWORK_REMODEL.md §11 Phase 0) — quantifies the AOI +
 * binary win WITHOUT touching the live server. Stands up an in-process GameHost
 * (flags read from env at require time, so run once per config), connects N real
 * `ws` bots that join + wander near spawn, and reports the SERVER egress over a
 * steady-state window via host.netStats().
 *
 *   node server/measure_net.js [N=20] [secs=5]
 *
 * Compare two runs (the difference is the whole point):
 *   node server/measure_net.js 20 5                          # baseline (JSON, no AOI)
 *   AOI_ENABLED=1 BINARY_WIRE=1 node server/measure_net.js 20 5   # optimized
 *
 * Even with bots clustered at spawn (so player_move sees little AOI gain), the NPC
 * firehose shows the cull: baseline ships EVERY moving world NPC to EVERY client;
 * AOI ships only the local ones. Binary then shrinks every row on top.
 */
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { GameHost } = require('./gameHost');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const N = Number(process.argv[2]) || 20;
const SECS = Number(process.argv[3]) || 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const host = new GameHost(ASSETS);
  host.start();
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => host.handleConnection(ws));
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://localhost:${wss.address().port}/ws`;

  const bots = [];
  for (let i = 0; i < N; i++) {
    const ws = new WebSocket(url);
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', name: `M${i}`, spriteGroupId: 1 + (i % 8) }))
    );
    ws.on('message', () => {}); // drain frames (we only care about server-side egress)
    ws.on('error', () => {});
    bots.push(ws);
  }
  await sleep(1500); // let joins settle

  let seq = 1;
  const drive = setInterval(() => {
    for (const ws of bots) {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'input', seq, dx: Math.random() < 0.5 ? 1 : -1, dy: 0 }));
    }
    seq++;
  }, 50);

  host.netStats(); // reset → measure only the steady-state window
  await sleep(SECS * 1000);
  const s = host.netStats();
  clearInterval(drive);

  const aoi = process.env.AOI_ENABLED === '1';
  const bin = process.env.BINARY_WIRE === '1';
  console.log(
    `\n=== AOI=${aoi ? 'ON' : 'off'} BINARY=${bin ? 'ON' : 'off'} | ${s.players} players, ${SECS}s ===`
  );
  console.log(`  total egress : ${s.mbPerSec} MB/s   (${s.sendsPerSec} sends/s)`);
  console.log(`  per-client   : ${((s.mbPerSec * 1024) / Math.max(1, s.players)).toFixed(1)} KB/s`);
  const byType = Object.entries(s.byType).sort((a, b) => b[1].kbPerSec - a[1].kbPerSec);
  for (const [t, v] of byType)
    console.log(
      `    ${t.padEnd(14)} ${String(v.kbPerSec).padStart(8)} kB/s   ${v.sendsPerSec} sends/s`
    );

  for (const ws of bots)
    try {
      ws.close();
    } catch {}
  wss.close();
  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => {
  console.error('measure crashed:', e);
  process.exit(2);
});
