import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { GameHost } from './server/gameHost.js';

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
  'enemy_spawns.json',
  'places.json',
  'car_traffic.json',
  'music.json',
  'item_sprites.json',
  'custom_items.json',
  'rooms.json',
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
      // Hot-reload of override files. OFF by default so editor saves don't
      // trigger Vite's full-page reload (which kicks you out of the editor); the
      // header toggle flips it live. We add/unwatch the overrides dir on the live
      // chokidar instance rather than via a static `ignored` so it can change at
      // runtime. Primeable with EB_RELOAD_OVERRIDES=1.
      let hotReload = process.env.EB_RELOAD_OVERRIDES === '1';
      const applyHotReload = () => {
        try {
          if (hotReload) server.watcher.add(OVERRIDES_DIR);
          else server.watcher.unwatch(OVERRIDES_DIR);
        } catch {
          /* watcher not ready yet — retried on the next toggle */
        }
      };
      applyHotReload();

      server.middlewares.use('/__editor/hotreload', (req: any, res: any) => {
        const reply = () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ on: hotReload }));
        };
        if (req.method === 'GET') return reply();
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('GET or POST only');
          return;
        }
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
          try {
            hotReload = !!JSON.parse(body).on;
          } catch {
            /* keep current state on a bad body */
          }
          applyHotReload();
          console.log(`[editor] override hot-reload ${hotReload ? 'ON' : 'OFF'}`);
          reply();
        });
      });

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

// The multiplayer host. All game logic lives in GameHost (server/gameHost.js),
// shared verbatim with the standalone deploy server (server/index.js) — this
// plugin is only the Vite transport glue (the /ws upgrade). Keep behaviour
// changes in GameHost so both servers stay identical by construction.
function gameServerPlugin() {
  return {
    name: 'game-server',
    // Dev server ONLY. Critical: GameHost is constructed inside configureServer,
    // NOT in this factory — its npcSim installs fs.watchFile watchers on
    // construction, which keep the Node event loop alive forever. If that ran
    // during `vite build` the build process would never exit and the deploy host
    // kills it (SIGTERM → "Exited with status 143"), even though the bundle built
    // fine. apply:'serve' + lazy construction keeps build a pure, exiting step.
    apply: 'serve' as const,
    configureServer(server: any) {
      const host = new GameHost(path.resolve(__dirname, 'public', 'assets'));
      const wss = new WebSocketServer({ noServer: true });
      host.start();

      server.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
        // Only handle /ws; let Vite keep its own HMR websocket.
        if (req.url === '/ws') {
          wss.handleUpgrade(req, socket, head, (ws: any) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      wss.on('connection', (ws: any) => host.handleConnection(ws));
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
    watch: {
      // Never reload on the save channel's scratch files. The override .json
      // files in public/overrides/ are watched/UNwatched at RUNTIME (default
      // off, so editor saves don't kick you out) — the editor's header
      // "Hot-reload" toggle flips it live via /__editor/hotreload. See
      // editorSavePlugin. Default can be primed with EB_RELOAD_OVERRIDES=1.
      ignored: ['**/*.bak', '**/*.tmp'],
    },
  },
  build: {
    outDir: 'dist',
  },
});
