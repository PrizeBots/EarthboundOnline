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

wss.on('connection', (ws) => host.handleConnection(ws));

server.listen(PORT, () => {
  console.log(`EarthBound Online server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
