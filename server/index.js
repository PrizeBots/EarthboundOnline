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
