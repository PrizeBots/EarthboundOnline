import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';

function gameServerPlugin() {
  const players = new Map<string, any>();
  let nextId = 1;

  function broadcastAll(data: any) {
    const msg = JSON.stringify(data);
    for (const [, entry] of players) {
      if (entry._ws.readyState === 1) {
        entry._ws.send(msg);
      }
    }
  }

  return {
    name: 'game-server',
    configureServer(server: any) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
        // Only handle /ws path, let Vite handle its own HMR websocket
        if (req.url === '/ws') {
          wss.handleUpgrade(req, socket, head, (ws: any) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      wss.on('connection', (ws: any) => {
        const playerId = String(nextId++);
        console.log(`Player ${playerId} connected`);

        ws.on('message', (raw: any) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }

          switch (msg.type) {
            case 'join': {
              const playerData = {
                id: playerId,
                name: msg.name || `Player${playerId}`,
                spriteGroupId: msg.spriteGroupId || 1,
                appearance: msg.appearance || null,
                x: 1296, y: 1168,
                direction: 0, frame: 0,
              };
              players.set(playerId, { ...playerData, _ws: ws });

              const otherPlayers: any[] = [];
              for (const [id, p] of players) {
                if (id !== playerId) {
                  const { _ws, ...data } = p;
                  otherPlayers.push(data);
                }
              }
              ws.send(JSON.stringify({ type: 'welcome', playerId, players: otherPlayers }));

              const { _ws, ...publicData } = players.get(playerId);
              for (const [id, p] of players) {
                if (id !== playerId && p._ws.readyState === 1) {
                  p._ws.send(JSON.stringify({ type: 'player_join', player: publicData }));
                }
              }
              break;
            }
            case 'move': {
              const entry = players.get(playerId);
              if (!entry) break;
              entry.x = msg.x;
              entry.y = msg.y;
              entry.direction = msg.direction;
              entry.frame = msg.frame;

              const moveMsg = JSON.stringify({
                type: 'player_move', id: playerId,
                x: msg.x, y: msg.y, direction: msg.direction, frame: msg.frame,
              });
              for (const [id, p] of players) {
                if (id !== playerId && p._ws.readyState === 1) {
                  p._ws.send(moveMsg);
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

      console.log('Game WebSocket server attached to Vite');
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [gameServerPlugin()],
  server: {
    port: 4444,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
