import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { createNpcSim } from './server/npcSim.js';

// --- Dev-only editor save channel (EDITOR_TOOLS.md "Save-Back Channel") ---
// Lives ONLY in the Vite dev server: not bundled, never on the deployed
// express/Render server, so editor writes cannot ship by construction.
// Writes go to public/overrides/ — OUR authored data layer applied on top of
// extraction — never to the generated asset files.
const OVERRIDES_DIR = path.resolve(__dirname, 'public', 'overrides');
const OVERRIDE_ALLOW = new Set([
  'npcs.json',
  'doors.json',
  'spawn.json',
  'collision.json',
  'dialogue.json',
  'sprites.json',
  'names.json',
]);
const SAVE_BODY_LIMIT = 8 * 1024 * 1024; // sprite overrides carry data URLs

// Verifier registry for editor "Verify" buttons (EDITOR_TOOLS.md: surface the
// canonical py checkers inside the tools). Fixed commands only — the client
// sends a NAME, never arguments. Python path per CLAUDE.md (the `python`
// alias may hang).
const PYTHON = 'C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe';
const VERIFIERS: Record<string, string[]> = {
  rooms: [PYTHON, 'tools/debug_room_crop_check.py'],
  anchors: [PYTHON, 'tools/debug_person_anchor_stats.py'],
};
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

function editorSavePlugin() {
  return {
    name: 'editor-save-channel',
    apply: 'serve' as const, // dev server only — excluded from `vite build`
    configureServer(server: any) {
      server.middlewares.use('/__editor/save', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        let size = 0;
        req.on('data', (chunk: any) => {
          size += chunk.length;
          if (size > SAVE_BODY_LIMIT) {
            res.statusCode = 413;
            res.end('override too large');
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('end', () => {
          try {
            const { name, data } = JSON.parse(body);
            // Allow-list (not just sanitization): only known override files.
            if (typeof name !== 'string' || !OVERRIDE_ALLOW.has(name)) {
              res.statusCode = 400;
              res.end(`unknown override file '${name}'`);
              return;
            }
            fs.mkdirSync(OVERRIDES_DIR, { recursive: true });
            const file = path.join(OVERRIDES_DIR, name);
            if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
            // Atomic-ish write: temp file then rename, pretty-printed for
            // clean git diffs (key order is the client's responsibility).
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
            fs.renameSync(tmp, file);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file: `public/overrides/${name}` }));
            console.log(`[editor] saved override ${name}`);
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });

      // Run a registered verifier script and return its output.
      server.middlewares.use('/__editor/verify', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
          let name = '';
          try {
            name = JSON.parse(body).name;
          } catch {
            /* fall through to allow-list rejection */
          }
          const cmd = VERIFIERS[name];
          if (!cmd) {
            res.statusCode = 400;
            res.end(`unknown verifier '${name}'`);
            return;
          }
          console.log(`[editor] running verifier '${name}'...`);
          const { execFile } = require('child_process');
          execFile(
            cmd[0],
            cmd.slice(1),
            { cwd: __dirname, timeout: VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
            (err: any, stdout: string, stderr: string) => {
              const output = `${stdout}\n${stderr}`.trim().slice(-8000);
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: !err, output }));
              console.log(`[editor] verifier '${name}' ${err ? 'FAILED' : 'done'}`);
            }
          );
        });
      });
    },
  };
}

function gameServerPlugin() {
  const players = new Map<string, any>();
  let nextId = 1;

  const POSES = ['walk', 'climb', 'attack', 'hurt'];

  // Spawn point: editor override wins over the src/spawn.json default.
  function readSpawn() {
    for (const rel of ['public/overrides/spawn.json', 'src/spawn.json']) {
      try {
        return JSON.parse(fs.readFileSync(path.resolve(__dirname, rel), 'utf8'));
      } catch {
        /* try next */
      }
    }
    return { x: 1296, y: 1168, dir: 0 };
  }
  const SPAWN = readSpawn();

  function broadcastAll(data: any) {
    const msg = JSON.stringify(data);
    for (const [, entry] of players) {
      if (entry._ws.readyState === 1) {
        entry._ws.send(msg);
      }
    }
  }

  // Server-authoritative NPC simulation: same world for every client.
  const npcSim = createNpcSim(path.resolve(__dirname, 'public', 'assets'));

  return {
    name: 'game-server',
    configureServer(server: any) {
      const wss = new WebSocketServer({ noServer: true });

      npcSim.start(
        () => [...players.values()].map((p: any) => ({ x: p.x, y: p.y })),
        (data: any) => broadcastAll(data)
      );

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
                // Pixel-edited sheet as a PNG data URL (~1-3KB); cap so a
                // hostile client can't make every join broadcast megabytes.
                appearance:
                  typeof msg.appearance === 'string' && msg.appearance.length <= 65536
                    ? msg.appearance
                    : null,
                x: SPAWN.x, y: SPAWN.y,
                direction: SPAWN.dir || 0, frame: 0,
                pose: 'walk',
                itemId: null, // held item, set by 'equip' messages
              };
              players.set(playerId, { ...playerData, _ws: ws });

              const otherPlayers: any[] = [];
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
              entry.pose = POSES.includes(msg.pose) ? msg.pose : 'walk';

              const moveMsg = JSON.stringify({
                type: 'player_move', id: playerId,
                x: msg.x, y: msg.y, direction: msg.direction, frame: msg.frame,
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
              // Server-authoritative: resolve from the tracked position so reach
              // can't be spoofed.
              npcSim.handleAttack(entry.x, entry.y, msg.dir | 0, playerId);
              break;
            }
            case 'equip': {
              const entry = players.get(playerId);
              if (!entry) break;
              // Item ids are short slugs; clients ignore unknown ids.
              entry.itemId =
                typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
              const equipMsg = JSON.stringify({
                type: 'equip', id: playerId, itemId: entry.itemId,
              });
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

      console.log('Game WebSocket server attached to Vite');
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [gameServerPlugin(), editorSavePlugin()],
  server: {
    port: 4444,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
