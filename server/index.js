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

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve the built client. (Assets stay out of the deploy per the ROM policy —
// see CLAUDE.md; this only ships code.)
app.use(express.static(path.join(__dirname, '..', 'dist')));

const host = new GameHost(path.join(__dirname, '..', 'public', 'assets'));
host.start();

wss.on('connection', (ws) => host.handleConnection(ws));

server.listen(PORT, () => {
  console.log(`EarthBound Online server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
