import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { GameHost } from './server/gameHost.js';
import { createStore } from './server/store/index.js';
import { createAuthApi } from './server/authApi.js';

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
  'song_names.json', // Sound Manager — admin song renames (parallel to names.json)
  'enemy_spawns.json', // Enemy Spawner tool — spawner instances + enemy classification
  'entities.json', // Entity Manager — the UNIVERSAL per-entity master table (all kinds)
  // NOTE: places.json is NO LONGER a file override — the Places outline now lives
  // in the DB (world_docs, via /api/world/places). Left out on purpose.
  'car_traffic.json',
  'music.json',
  'item_sprites.json',
  'custom_items.json',
  'custom_sprites.json', // Source Assets — standalone custom entity sprite groups (id/name/src refs, no pixels)
  'rooms.json',
  'map_tiles.json', // Room Builder — per-map-cell tile-arrangement override for editing ANY room (pure indices)
  'stamps.json', // Room Builder sampler — reusable tile-stamp library (pure arrangement indices)
  'custom_tiles.json', // Room Builder pixel editor — author-drawn 8x8 RGBA tiles for custom rooms
  'sprite_frames.json',
  'flags.json', // Flag Editor — flag catalog (id/name/scope/default)
  'triggers.json', // Flag Editor — event→flag rules
  'sfx_events.json', // Sound Manager SFX tab — event→sound map + per-event volumes
  'combat_juice.json', // Combat tool — floating damage/heal/crit number feel (numbers/colors only)
  'entity_folders.json', // Entity Desktop — folder layout + sprite→folder assignment
  'item_folders.json', // Item Desktop — folder layout + item→folder assignment
  'equip_stats.json', // Item Manager — per-item stat overrides (offense/defense/crit/dodge/attackSpeed/cost/heal/inflict)
  'gifts.json', // Gift Manager — authored present-box contents (edits[k]={item})
  'events.json', // Event Manager — authored event triggers/rooms (trigger circle, entrance/exit warps, end conditions)
  'psi.json', // PSI Manager — per-move tuning (pp/power/range/status), merged client + server
  'psi_folders.json', // PSI Manager — folder layout + move→folder assignment
  'source_folders.json', // Source Assets — authored category display-name overrides (id→name)
]);
const SAVE_BODY_LIMIT = 8 * 1024 * 1024; // sprite overrides carry data URLs

// Editor override hot-reload state. Shared between the watch `ignored`
// predicate (in server.watch below) and the /__editor/hotreload toggle.
// Default OFF so editor saves don't trigger Vite's full-page reload (which
// kicks you out of the editor). Primeable with EB_RELOAD_OVERRIDES=1.
let overrideHotReload = process.env.EB_RELOAD_OVERRIDES === '1';

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
    // The Reload toggle governs ALL hot reloading so you can keep working in the
    // editor while files change under you — your own override saves AND source
    // (.ts/.js) edits (e.g. an agent updating code). OFF (default): suppress every
    // HMR update + full-reload so the running page stays put and you don't get
    // kicked out of the editor. Vite still INVALIDATES the changed modules in its
    // graph (handleHotUpdate only governs HMR propagation, not the file-watch
    // invalidation), so a MANUAL refresh serves the fresh code. ON: normal HMR /
    // full-reload as usual. Flipped live via /__editor/hotreload (no restart).
    handleHotUpdate(ctx: any) {
      if (!overrideHotReload) return []; // toggle OFF → no auto-reload of any kind
      return ctx.modules;
    },
    configureServer(server: any) {
      // Hot-reload of override files is gated by the `ignored` predicate in
      // server.watch (below), which chokidar re-evaluates per file event — so
      // flipping `overrideHotReload` here takes effect live with no restart.
      // (We used to add/unwatch OVERRIDES_DIR on the live watcher, but unwatch
      // was unreliable for sub-paths of the recursively-watched root, and the
      // Windows backslash path never matched — so saves kept reloading even
      // with the toggle OFF.)
      server.middlewares.use('/__editor/hotreload', (req: any, res: any) => {
        const reply = () => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ on: overrideHotReload }));
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
            overrideHotReload = !!JSON.parse(body).on;
          } catch {
            /* keep current state on a bad body */
          }
          console.log(`[editor] override hot-reload ${overrideHotReload ? 'ON' : 'OFF'}`);
          reply();
        });
      });

      // Serve authored override files straight from disk so a BRAND-NEW override
      // domain loads without a dev-server restart. Vite's publicDir (sirv) caches
      // its file list at boot, so the first-ever events.json (created after boot)
      // would otherwise 404 to the SPA fallback and the editor would load empty.
      // Runs before sirv; only allow-listed names, so no path traversal.
      server.middlewares.use('/overrides', (req: any, res: any, next: any) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/+/, ''));
        if (!OVERRIDE_ALLOW.has(name)) return next(); // not ours — let sirv/SPA handle
        const file = path.join(OVERRIDES_DIR, name);
        if (!fs.existsSync(file)) {
          res.statusCode = 404; // loadOverride treats 404 as "nothing authored yet"
          res.end('not found');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-cache');
        res.end(fs.readFileSync(file));
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
      // Auth + character API, same factory the deploy server mounts. Vite's
      // middleware stack is plain connect; the Express app self-augments
      // req/res, so res.json() works here too. Registered first so /api/* is
      // handled before Vite's SPA/static fallthrough.
      const store = createStore();

      // One-time import of the legacy file-based Places outline into the DB (the
      // DB is now the source of truth). Only runs if the DB has no places doc yet
      // — after that, edits go straight to world_docs and the file is dormant.
      try {
        if (!store.getWorldDoc('places')) {
          const f = path.join(OVERRIDES_DIR, 'places.json');
          if (fs.existsSync(f)) {
            store.putWorldDoc('places', JSON.parse(fs.readFileSync(f, 'utf8')), Date.now());
            console.log('[editor] imported public/overrides/places.json into DB (world_docs)');
          }
        }
      } catch (e) {
        console.warn('[editor] places import skipped:', e);
      }

      // One-time seed of region rooms from the authored music areas (the proven
      // rectangle→song model). Each MusicArea {name,x,y,w,h,song} becomes a
      // bgm-only overworld Room {regions:[rect], bgm:song}, carrying its name as
      // the label so nothing is lost. Only runs if the DB has no rooms doc yet;
      // after that the Room Manager owns it. Parity: #rooms == #music areas.
      try {
        if (!store.getWorldDoc('rooms')) {
          const f = path.join(OVERRIDES_DIR, 'music.json');
          if (fs.existsSync(f)) {
            const areas = JSON.parse(fs.readFileSync(f, 'utf8'))?.areas ?? [];
            const rooms = areas.map((a: any, i: number) => ({
              id: `bgm_${i}`,
              label: a.name ?? `BGM ${i}`,
              type: 'overworld',
              regions: [{ x: a.x, y: a.y, w: a.w, h: a.h }],
              bgm: a.song,
            }));
            store.putWorldDoc('rooms', { version: 1, rooms }, Date.now());
            console.log(`[editor] seeded ${rooms.length} region rooms from music.json (world_docs)`);
          }
        }
      } catch (e) {
        console.warn('[editor] rooms seed skipped:', e);
      }

      // editorApi: mount the dev editor's /api/world/* persistence routes. ONLY
      // the dev server passes this — the deploy server (server/index.js) does not,
      // so the editor and its persistence simply don't exist in production. The
      // routes are loopback-gated too, so a LAN-exposed dev server stays local.
      server.middlewares.use(createAuthApi(store, { editorApi: true }));

      // Same store as the API → the game host loads/saves the same characters.
      const host = new GameHost(path.resolve(__dirname, 'public', 'assets'), store);
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

      // Tear down on dev-server restart/shutdown. Vite restarts the server
      // IN-PROCESS on config/dep changes, re-running configureServer — without
      // this, each reload leaks the old GameHost (its sim's 60Hz tick + watchers
      // keep the event loop alive forever), stacking loops until the server
      // crawls (2Hz, multi-second RTT). httpServer 'close' fires on every restart.
      server.httpServer.on('close', () => {
        try {
          host.stop();
          wss.close();
        } catch (e) {
          console.warn('[game-server] teardown error:', e);
        }
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
    watch: {
      // Never reload on the save channel's scratch files.
      // The override .json files in public/overrides/ are ignored while
      // hot-reload is OFF (the default), so editor saves don't trigger Vite's
      // full-page reload and kick you out of the editor. The header "Hot-reload"
      // toggle flips `overrideHotReload` live via /__editor/hotreload; chokidar
      // re-runs this predicate per file event, so the toggle applies without a
      // restart. Default can be primed with EB_RELOAD_OVERRIDES=1.
      ignored: [
        '**/*.bak',
        '**/*.tmp',
        (file: string) =>
          !overrideHotReload && file.replace(/\\/g, '/').includes('/public/overrides/'),
      ],
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Multi-page build. index.html is the PUBLIC landing page; play.html is the
      // game (the old index.html, moved). The stub pages share the site chrome.
      // Every .html that should ship to dist/ must be listed here — Vite only
      // crawls index.html by default.
      input: {
        index: path.resolve(__dirname, 'index.html'),
        play: path.resolve(__dirname, 'play.html'),
        shop: path.resolve(__dirname, 'shop.html'),
      },
    },
  },
});
