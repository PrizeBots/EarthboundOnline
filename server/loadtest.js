/**
 * Multiplayer stress harness — N headless WebSocket clients against a running
 * game server (the dev server on :4444, or any host you pass). Each client joins
 * anonymously, then wanders with small validation-legal steps (and the odd swing
 * + chat) for a fixed duration, exactly like a real browser client. Reports
 * connect success, message throughput, and any errors/disconnects.
 *
 * This is the "stress test with 10+ simultaneous clients" Phase-2 check — it
 * exercises the broadcast fan-out, move validation, PvP/NPC sim, and the
 * idle/heartbeat path under concurrent load without needing 10 browsers.
 *
 *   node server/loadtest.js [clients=12] [seconds=15] [host=localhost:4444]
 *
 * Requires the server already running (CLAUDE.md: dev server lives on :4444).
 */
const WebSocket = require('ws');

const N = Number(process.argv[2]) || 12;
const SECONDS = Number(process.argv[3]) || 15;
const HOST = process.argv[4] || 'localhost:4444';
const URL = `ws://${HOST}/ws`;

// Spawn-ish area + a small per-tick step that stays under the server's move cap
// (MAX_MOVE_STEP = 96) so honest movement is never throttled.
const SPAWN = { x: 1296, y: 1168 };
const STEP = 8; // px per move (well under the 96px cap)
const MOVE_MS = 50; // ~ the real client's every-3-frames cadence

const stats = {
  opened: 0,
  welcomed: 0,
  closed: 0,
  errors: 0,
  joinErrors: 0,
  rx: 0, // total messages received across all clients
  tx: 0, // total messages sent across all clients
};

const clients = [];

function spawnClient(i) {
  const ws = new WebSocket(URL);
  const c = { ws, x: SPAWN.x + ((i * 7) % 40), y: SPAWN.y + ((i * 5) % 40), dir: 0, timer: null };
  clients.push(c);

  ws.on('open', () => {
    stats.opened++;
    ws.send(JSON.stringify({ type: 'join', name: `Load${i}`, spriteGroupId: 1 + (i % 8) }));
    stats.tx++;
    // Drive movement + the occasional swing/chat/PK toggle.
    let n = 0;
    c.timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      n++;
      c.x += (Math.random() * 2 - 1) * STEP;
      c.y += (Math.random() * 2 - 1) * STEP;
      ws.send(
        JSON.stringify({
          type: 'move',
          x: Math.round(c.x),
          y: Math.round(c.y),
          direction: c.dir,
          frame: n % 4,
          pose: 'walk',
        })
      );
      stats.tx++;
      if (n % 20 === 0) {
        ws.send(JSON.stringify({ type: 'attack', dir: c.dir }));
        stats.tx++;
      }
      if (n % 60 === 0) {
        ws.send(JSON.stringify({ type: 'chat', text: `hi from ${i}` }));
        stats.tx++;
      }
      c.dir = (c.dir + 1) % 8;
    }, MOVE_MS);
  });

  ws.on('message', (raw) => {
    stats.rx++;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'welcome') stats.welcomed++;
    if (msg.type === 'join_error') stats.joinErrors++;
  });

  ws.on('error', (e) => {
    stats.errors++;
    if (stats.errors <= 3) console.error(`  client ${i} error:`, e.message);
  });
  ws.on('close', () => {
    stats.closed++;
    if (c.timer) clearInterval(c.timer);
  });
}

console.log(`Load test: ${N} clients → ${URL} for ${SECONDS}s`);
const t0 = Date.now();
for (let i = 0; i < N; i++) spawnClient(i);

setTimeout(() => {
  for (const c of clients) {
    if (c.timer) clearInterval(c.timer);
    try {
      c.ws.close();
    } catch {
      /* already closed */
    }
  }
  const secs = (Date.now() - t0) / 1000;
  setTimeout(() => {
    console.log('\n=== Load test report ===');
    console.log(`  clients launched : ${N}`);
    console.log(`  sockets opened   : ${stats.opened}`);
    console.log(`  welcomes         : ${stats.welcomed}`);
    console.log(`  join errors      : ${stats.joinErrors}`);
    console.log(`  socket errors    : ${stats.errors}`);
    console.log(`  msgs sent        : ${stats.tx}`);
    console.log(`  msgs received    : ${stats.rx}  (~${Math.round(stats.rx / secs)}/s)`);
    console.log(`  closes           : ${stats.closed}`);
    const ok = stats.opened === N && stats.welcomed === N && stats.errors === 0;
    console.log(
      `\n  ${ok ? 'PASS' : 'CHECK'}: ${ok ? 'all clients joined cleanly' : 'see counts above'}`
    );
    process.exit(ok ? 0 : 1);
  }, 500);
}, SECONDS * 1000);
