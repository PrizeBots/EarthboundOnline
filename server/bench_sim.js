'use strict';
/**
 * Sim load profile harness (not a test). Boots a REAL GameHost with the full NPC
 * world, joins several moving players to keep the AI/collision/broadcast hot, runs
 * for a few seconds, then exits. Run under the V8 profiler to find where the tick
 * actually spends CPU — the data that decides what to optimize:
 *
 *   node --prof server/bench_sim.js
 *   node --prof-process isolate-*.log > prof.txt   # human-readable hot-function list
 *
 * Absolute times are meaningless on a fast dev CPU; the RELATIVE distribution (which
 * functions dominate) is CPU-independent and is exactly what we need.
 */
process.env.AOI_ENABLED = '1';
process.env.BINARY_WIRE = '1';

const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { GameHost } = require('./gameHost');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const CLIENTS = 4;
const RUN_MS = 12000;
const STEP_MS = 33; // ~30Hz input, like a real client

function mkClient(url, name, sprite) {
  const c = { name, ws: new WebSocket(url), id: null, frames: 0 };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ type: 'join', name, spriteGroupId: sprite })));
  c.ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'welcome') c.id = m.playerId;
      } catch {
        /* ignore */
      }
    } else {
      c.frames++;
    }
  });
  c.ws.on('error', () => {});
  return c;
}

async function main() {
  const host = new GameHost(ASSETS);
  host.start();
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => host.handleConnection(ws));
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://localhost:${wss.address().port}/ws`;

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) clients.push(mkClient(url, 'P' + i, (i % 4) + 1));
  await new Promise((r) => setTimeout(r, 800)); // let joins settle

  // Scatter the players so each lights up its own ACTIVE_RADIUS bubble of NPC AI,
  // then keep them walking (random-ish per client) so movement/collision stay hot.
  for (let i = 0; i < clients.length; i++) {
    const p = host.players.get(clients[i].id);
    if (p) {
      p.x += (i - 1.5) * 360; // spread along x within the spawn town
      host.aoi.update(clients[i].id, p.x, p.y);
    }
  }

  let seq = 1;
  let t = 0;
  const drive = setInterval(() => {
    t += STEP_MS;
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i];
      if (c.ws.readyState !== 1) continue;
      // A slowly rotating heading per client → covers cells, hugs walls, re-targets.
      const ang = (t / 700) * (i % 2 ? 1 : -1) + i;
      const dx = Math.cos(ang) > 0 ? 1 : -1;
      const dy = Math.sin(ang) > 0 ? 1 : -1;
      c.ws.send(JSON.stringify({ type: 'input', seq: seq++, dx, dy }));
    }
  }, STEP_MS);

  await new Promise((r) => setTimeout(r, RUN_MS));
  clearInterval(drive);
  const total = clients.reduce((n, c) => n + c.frames, 0);
  console.log(`bench done — ${CLIENTS} clients, ${RUN_MS}ms, ${total} binary frames received`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
