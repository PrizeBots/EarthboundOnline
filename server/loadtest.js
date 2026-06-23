/**
 * Multiplayer stress + AOI-measurement harness — N headless WebSocket clients
 * against a running game server (dev server on :4444, or any host you pass).
 * Each bot joins anonymously and walks via the SERVER-AUTHORITATIVE input path
 * (type:'input' with seq/dx/dy → _simPlayers), exactly like a real browser — NOT
 * the legacy editor-only 'move' path (which the server rejects for players, so
 * old runs of this harness never actually moved anyone). It then reports connect
 * health, throughput, the PER-CLIENT downlink distribution, and the spatial
 * spread of bots — the numbers that prove the AOI win.
 *
 *   node server/loadtest.js [clients=12] [seconds=15] [host=localhost:4444] [flags]
 *
 * Flags:
 *   --hotspot        all bots pile into one spot (worst-case crowd; tests §4.6 cap)
 *   --ramp=<ms>      stagger connects by this many ms each (default auto: ~10s total)
 *   --spread=<px>    dispersal radius target for fan-out mode (default 2000)
 *   --quiet          suppress per-client error lines
 *
 * AOI measurement recipe (compare two runs):
 *   1) Server WITHOUT AOI:  node server/loadtest.js 500 20
 *   2) Server WITH AOI:     AOI_ENABLED=1 (on the server)  →  same command
 *   Watch "downlink/client" — off scales with N, on flattens to local density.
 *   Run the server with NET_DEBUG=1 to see egress + AOI occupancy server-side.
 *
 * Requires the server already running (CLAUDE.md: dev server lives on :4444).
 */
const WebSocket = require('ws');

const N = Number(process.argv[2]) || 12;
const SECONDS = Number(process.argv[3]) || 15;
const HOST =
  (process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null) ||
  'localhost:4444';
const URL = `ws://${HOST}/ws`;
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--'));
const flag = (name) => FLAGS.find((f) => f === `--${name}` || f.startsWith(`--${name}=`));
const flagVal = (name, def) => {
  const f = flag(name);
  if (!f) return def;
  const eq = f.indexOf('=');
  return eq === -1 ? true : Number(f.slice(eq + 1));
};

const HOTSPOT = !!flag('hotspot');
const QUIET = !!flag('quiet');
const SPREAD = flagVal('spread', 2000); // dispersal radius target (px)
// Stagger connects so thousands of sockets don't thundering-herd the accept
// queue. Default: spread all connects across ~10s (capped at 50ms each).
const RAMP_MS = flagVal('ramp', Math.min(50, Math.ceil(10000 / Math.max(1, N))));

const SPAWN = { x: 1296, y: 1168 };
const MOVE_MS = 50; // ~ the real client's every-3-frames input cadence

const stats = { opened: 0, welcomed: 0, closed: 0, errors: 0, joinErrors: 0, rx: 0, tx: 0 };
const clients = [];

// 8-direction unit vector for a heading angle (server input dx/dy ∈ {-1,0,1}).
function headingToStep(theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dx = Math.abs(c) < 0.38 ? 0 : Math.sign(c);
  const dy = Math.abs(s) < 0.38 ? 0 : Math.sign(s);
  return dx === 0 && dy === 0 ? [Math.sign(c) || 1, 0] : [dx, dy];
}

function spawnClient(i) {
  const ws = new WebSocket(URL);
  // Each bot fans out along its own heading so the population spreads across many
  // AOI cells (unless --hotspot keeps everyone piled at spawn). Known position is
  // tracked from server 'pos' acks — used only for the spatial-spread report.
  const heading = (i / Math.max(1, N)) * Math.PI * 2;
  const c = { ws, i, x: SPAWN.x, y: SPAWN.y, dir: 0, seq: 1, rx: 0, heading, timer: null };
  clients.push(c);

  ws.on('open', () => {
    stats.opened++;
    ws.send(JSON.stringify({ type: 'join', name: `Load${i}`, spriteGroupId: 1 + (i % 8) }));
    stats.tx++;
    let n = 0;
    c.timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      n++;
      let dx, dy;
      if (HOTSPOT) {
        // Random micro-wander with ~zero net drift: stay piled (crowd-cap test).
        dx = Math.round(Math.random() * 2 - 1);
        dy = Math.round(Math.random() * 2 - 1);
      } else {
        // Walk outward along the assigned heading until ~SPREAD from spawn, then
        // mill in place — fans the population across the cell grid.
        const r = Math.hypot(c.x - SPAWN.x, c.y - SPAWN.y);
        if (r < SPREAD) [dx, dy] = headingToStep(c.heading);
        else {
          dx = Math.round(Math.random() * 2 - 1);
          dy = Math.round(Math.random() * 2 - 1);
        }
      }
      c.dir = dx || dy ? ((Math.atan2(dy, dx) / (Math.PI / 4) + 8) | 0) % 8 : c.dir;
      ws.send(JSON.stringify({ type: 'input', seq: c.seq++, dx, dy }));
      stats.tx++;
      if (n % 40 === 0) {
        ws.send(JSON.stringify({ type: 'attack', dir: c.dir }));
        stats.tx++;
      }
      if (n % 120 === 0) {
        ws.send(JSON.stringify({ type: 'chat', text: `hi from ${i}` }));
        stats.tx++;
      }
    }, MOVE_MS);
  });

  ws.on('message', (raw) => {
    stats.rx++;
    c.rx++;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'welcome') stats.welcomed++;
    else if (msg.type === 'join_error') stats.joinErrors++;
    else if (msg.type === 'pos') {
      // Server-authoritative position ack — track where we actually are.
      if (Number.isFinite(msg.x)) c.x = msg.x;
      if (Number.isFinite(msg.y)) c.y = msg.y;
    }
  });

  ws.on('error', (e) => {
    stats.errors++;
    if (!QUIET && stats.errors <= 3) console.error(`  client ${i} error:`, e.message);
  });
  ws.on('close', () => {
    stats.closed++;
    if (c.timer) clearInterval(c.timer);
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

console.log(
  `Load test: ${N} clients → ${URL} for ${SECONDS}s ` +
    `(${HOTSPOT ? 'HOTSPOT pile-up' : `fan-out spread≈${SPREAD}px`}, ramp ${RAMP_MS}ms/client)`
);
const t0 = Date.now();
let launched = 0;
const rampTimer = setInterval(() => {
  if (launched >= N) {
    clearInterval(rampTimer);
    return;
  }
  spawnClient(launched++);
}, RAMP_MS);

setTimeout(() => {
  clearInterval(rampTimer);
  // Measure the steady-state downlink over the final window only (after ramp),
  // so connect bursts don't skew the per-client rate.
  const windowStart = Date.now();
  const baseRx = clients.map((c) => c.rx);
  setTimeout(() => {
    const measSecs = Math.max(0.001, (Date.now() - windowStart) / 1000);
    const perClient = clients.map((c, k) => (c.rx - baseRx[k]) / measSecs).sort((a, b) => a - b);
    // Spatial spread: bucket final positions into 256px AOI cells.
    const cells = new Map();
    for (const c of clients) {
      const key = Math.floor(c.x / 256) + ':' + Math.floor(c.y / 256);
      cells.set(key, (cells.get(key) || 0) + 1);
    }
    let maxPerCell = 0;
    for (const v of cells.values()) if (v > maxPerCell) maxPerCell = v;

    for (const c of clients) {
      if (c.timer) clearInterval(c.timer);
      try {
        c.ws.close();
      } catch {
        /* already closed */
      }
    }
    const secs = (Date.now() - t0) / 1000;
    const avg = perClient.reduce((s, v) => s + v, 0) / Math.max(1, perClient.length);
    setTimeout(() => {
      console.log('\n=== Load test report ===');
      console.log(`  clients launched : ${N}`);
      console.log(`  sockets opened   : ${stats.opened}`);
      console.log(`  welcomes         : ${stats.welcomed}`);
      console.log(`  join errors      : ${stats.joinErrors}`);
      console.log(`  socket errors    : ${stats.errors}`);
      console.log(`  msgs sent        : ${stats.tx}`);
      console.log(`  msgs received    : ${stats.rx}  (~${Math.round(stats.rx / secs)}/s total)`);
      console.log('  --- AOI metric: downlink msgs/s PER CLIENT (steady state) ---');
      console.log(
        `  avg ${avg.toFixed(1)} | p50 ${percentile(perClient, 50).toFixed(1)} | ` +
          `p95 ${percentile(perClient, 95).toFixed(1)} | max ${percentile(perClient, 100).toFixed(1)}`
      );
      console.log(`  spatial spread   : ${cells.size} cells occupied, max ${maxPerCell} bots/cell`);
      console.log(`  closes           : ${stats.closed}`);
      const ok = stats.opened === N && stats.joinErrors === 0 && stats.errors === 0;
      console.log(
        `\n  ${ok ? 'PASS' : 'CHECK'}: ${ok ? 'all clients joined cleanly' : 'see counts above'}`
      );
      process.exit(ok ? 0 : 1);
    }, 500);
  }, 2000); // 2s steady-state measurement window
}, SECONDS * 1000);
