/**
 * Standalone deploy server. Serves the built client (dist/) over Express and
 * runs the multiplayer host over a plain WebSocket server.
 *
 * All host logic lives in GameHost (server/gameHost.js) — the SAME class the
 * Vite dev server uses (vite.config.ts). This file is just the transport: HTTP
 * static serving + socket plumbing. Keep behaviour changes in GameHost so both
 * servers stay identical by construction.
 */
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

// PROD: neuter fs.watchFile BEFORE the sim modules load. The codebase registers
// ~15 dev-only hot-reload watchers (collision/doors/npcs/rooms/enemies/traffic/
// gifts/shops/spawn) that poll files and, on a (possibly phantom) change, re-parse
// the ENTIRE map + 1364-actor NPC set synchronously — stalling the event loop.
// Nobody edits override files on a deployed server, so they're pure overhead +
// a latency hazard in prod. Dev (NODE_ENV unset) keeps live hot-reload.
if (process.env.NODE_ENV === 'production') {
  require('fs').watchFile = () => {};
}

const { GameHost } = require('./gameHost');
const { createStore } = require('./store');
const { createAuthApi } = require('./authApi');

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Disable Nagle's algorithm on every TCP connection (incl. WebSocket upgrades).
// Without this, Node buffers small outgoing packets — every position update and
// ping — waiting to coalesce them or for a TCP ACK. Combined with the receiver's
// delayed-ACK, that's the classic Nagle stall that silently adds ~40-200ms to a
// real-time game's tiny, frequent packets (turning a ~70ms link into a felt
// ~200ms). setNoDelay flushes each packet immediately. Non-negotiable for an
// action game; the single biggest latency win for this codebase.
server.on('connection', (socket) => socket.setNoDelay(true));

// Auth + character API (accounts/sessions/saves). Mounted before static so the
// /api/* routes win; the app calls next() on anything it doesn't match.
const store = createStore();
app.use(createAuthApi(store));

// --- Event-loop lag probe (diagnostic) ------------------------------------
// A 50ms timer measures how late it actually fires; the overshoot is how long
// the loop was BLOCKED by synchronous work (a sim tick) — time during which no
// socket can be read/written. A real-time server must keep this near 0. If the
// in-game RTT is high but the network is fast, this number is the smoking gun.
// Read it from anywhere: GET /_perf.
const { performance } = require('perf_hooks');
let _loopLagMs = 0;
let _loopLagMax = 0;
let _lagPrev = performance.now();
const _lagTimer = setInterval(() => {
  const now = performance.now();
  _loopLagMs = Math.max(0, now - _lagPrev - 50);
  if (_loopLagMs > _loopLagMax) _loopLagMax = _loopLagMs;
  _lagPrev = now;
}, 50);
if (_lagTimer.unref) _lagTimer.unref();
app.get('/_perf', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    loopLagMs: Math.round(_loopLagMs),
    loopLagMaxMs: Math.round(_loopLagMax),
    uptimeS: Math.round(process.uptime()),
    rssMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
  });
  _loopLagMax = 0; // reset the peak each read
});

// Serve the built client (code only; the bundle never carries ROM data).
app.use(express.static(path.join(__dirname, '..', 'dist')));

// ROM-derived game data (sprites/atlases/map/…). It is NEVER committed (ROM
// policy, CLAUDE.md); in production it lives on a mounted disk at this same
// in-repo path (see render.yaml + ARCHITECTURE.md "Production data"). Keeping the
// path at <root>/public/assets preserves the server's overrides resolution
// (assetsDir/../overrides → the committed public/overrides). Serve it to the
// client at /assets; if the disk isn't attached yet the dir is just empty (the
// server already degrades to relay-only — see npcSim).
const assetsDir = path.join(__dirname, '..', 'public', 'assets');
app.use('/assets', express.static(assetsDir));

// Same store the API uses, so the game host loads/saves the same character rows.
const host = new GameHost(assetsDir, store);
host.start();

// WebSocket keepalive (protocol-level ping/pong). The browser can't send ping
// frames itself, so the SERVER drives them: this detects half-open TCP (a client
// whose network vanished without a close frame) and keeps NATs/proxies/load
// balancers from idle-dropping an otherwise-quiet connection — both of which
// otherwise surface as the other player freezing then teleporting. A socket that
// misses a pong between sweeps is terminated, firing GameHost's close handler
// (save-back + player_leave). Complements the app-level ping in Network.ts.
function heartbeat() {
  this.isAlive = true;
}
const WS_PING_MS = 15000;
const pingSweep = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket already closing */
    }
  }
}, WS_PING_MS);
wss.on('close', () => clearInterval(pingSweep));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  host.handleConnection(ws);
});

server.listen(PORT, () => {
  console.log(`Zexonyte Online server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});

// Graceful shutdown: flush any in-flight character saves before exiting so a
// disconnect/level-up write isn't dropped when the platform redeploys (SIGTERM).
let shuttingDown = false;
const shutdown = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${sig} — flushing saves`);
  try {
    await host.flushSaves();
    if (store.close) await store.close();
  } catch (e) {
    console.error('[shutdown] flush failed', e);
  }
  server.close(() => process.exit(0));
  // Don't hang forever on lingering sockets.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
