const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from Vite's build output (or let Vite proxy handle it in dev)
app.use(express.static(path.join(__dirname, '..', 'dist')));

// --- Game State ---
const players = new Map(); // id -> { id, name, spriteGroupId, x, y, direction, frame }
let nextId = 1;

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
          x: 1296,
          y: 1168,
          direction: 0, // Direction.S
          frame: 0,
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

        // Broadcast to all OTHER players
        const moveMsg = JSON.stringify({
          type: 'player_move',
          id: playerId,
          x: msg.x,
          y: msg.y,
          direction: msg.direction,
          frame: msg.frame,
        });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) {
            p._ws.send(moveMsg);
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
