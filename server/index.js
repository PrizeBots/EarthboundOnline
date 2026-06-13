const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { createNpcSim } = require('./npcSim');

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from Vite's build output (or let Vite proxy handle it in dev)
app.use(express.static(path.join(__dirname, '..', 'dist')));

// --- Game State ---
const players = new Map(); // id -> { id, name, spriteGroupId, x, y, direction, frame, pose, itemId }
let nextId = 1;

const POSES = ['walk', 'climb', 'attack', 'hurt'];

// Spawn point: editor override (public/overrides/spawn.json) wins over the
// src/spawn.json default the client also uses. Read once at startup (nodemon
// restarts on server-code changes; a moved spawn only matters for new joins).
function readSpawn() {
  const fs = require('fs');
  for (const rel of ['../public/overrides/spawn.json', '../src/spawn.json']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
    } catch {
      /* try next */
    }
  }
  return { x: 1296, y: 1168, dir: 0 };
}
const SPAWN = readSpawn();

// Server-authoritative NPC simulation: same world for every client.
const npcSim = createNpcSim(path.join(__dirname, '..', 'public', 'assets'));
npcSim.start(
  () => [...players.values()].map((p) => ({ x: p.x, y: p.y })),
  (data) => broadcastAll(data)
);

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  for (const [id, ws] of players) {
    if (id !== excludeId && ws._socket && ws._socket.writable) {
      ws._ws.send(msg);
    }
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [, entry] of players) {
    if (entry._ws.readyState === 1) {
      entry._ws.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  const playerId = String(nextId++);
  console.log(`Player ${playerId} connected`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const playerData = {
          id: playerId,
          name: msg.name || `Player${playerId}`,
          spriteGroupId: msg.spriteGroupId || 1,
          // Pixel-edited sheet as a PNG data URL (~1-3KB); cap so a hostile
          // client can't make every join broadcast megabytes.
          appearance:
            typeof msg.appearance === 'string' && msg.appearance.length <= 65536
              ? msg.appearance
              : null,
          x: SPAWN.x,
          y: SPAWN.y,
          direction: SPAWN.dir || 0,
          frame: 0,
          pose: 'walk',
          itemId: null, // held item, set by 'equip' messages
        };
        players.set(playerId, { ...playerData, _ws: ws });

        // Send the new player their ID and current players list
        const otherPlayers = [];
        for (const [id, p] of players) {
          if (id !== playerId) {
            const { _ws, ...data } = p;
            otherPlayers.push(data);
          }
        }
        ws.send(JSON.stringify({
          type: 'welcome',
          playerId,
          players: otherPlayers,
          npcs: npcSim.snapshot(),
          npcHps: npcSim.hpSnapshot(),
        }));

        // Tell everyone else about the new player
        const { _ws, ...publicData } = players.get(playerId);
        broadcastAll({
          type: 'player_join',
          player: publicData,
        });
        break;
      }

      case 'move': {
        const entry = players.get(playerId);
        if (!entry) break;
        entry.x = msg.x;
        entry.y = msg.y;
        entry.direction = msg.direction;
        entry.frame = msg.frame;
        entry.pose = POSES.includes(msg.pose) ? msg.pose : 'walk';

        // Broadcast to all OTHER players
        const moveMsg = JSON.stringify({
          type: 'player_move',
          id: playerId,
          x: msg.x,
          y: msg.y,
          direction: msg.direction,
          frame: msg.frame,
          pose: entry.pose,
        });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) {
            p._ws.send(moveMsg);
          }
        }
        break;
      }

      case 'attack': {
        const entry = players.get(playerId);
        if (!entry) break;
        // Server-authoritative: resolve the swing from the player's tracked
        // position (not client-sent coords) so reach can't be spoofed.
        npcSim.handleAttack(entry.x, entry.y, msg.dir | 0, playerId);
        break;
      }

      case 'equip': {
        const entry = players.get(playerId);
        if (!entry) break;
        // Item ids are short slugs; clients ignore ids they don't recognize.
        entry.itemId =
          typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
        const equipMsg = JSON.stringify({ type: 'equip', id: playerId, itemId: entry.itemId });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) {
            p._ws.send(equipMsg);
          }
        }
        break;
      }

      case 'chat': {
        if (!players.has(playerId)) break;
        const text = String(msg.text || '').slice(0, 100).trim();
        if (!text) break;

        // Broadcast to everyone else; the sender shows its own bubble locally.
        const chatMsg = JSON.stringify({ type: 'chat', id: playerId, text });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) {
            p._ws.send(chatMsg);
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    players.delete(playerId);
    broadcastAll({ type: 'player_leave', id: playerId });
  });
});

server.listen(PORT, () => {
  console.log(`EarthBound Online server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
