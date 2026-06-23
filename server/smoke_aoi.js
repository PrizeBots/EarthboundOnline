/**
 * Flag-ON integration smoke (NETWORK_REMODEL.md) — the prod gate.
 *
 * Stands up a REAL GameHost with AOI_ENABLED + BINARY_WIRE on, behind a real `ws`
 * server, and drives real `ws` clients through join → server-authoritative
 * movement (the input path). Unlike the unit tests (mocked host / fake sockets),
 * this exercises the genuine over-the-wire binary frame transmission + the live
 * AOI spawn/despawn + delta decode through the actual constructor and sim loop.
 *
 *   AOI_ENABLED=1 BINARY_WIRE=1 node server/smoke_aoi.js     (flags forced below)
 *
 * Asserts: (1) nearby players spawn to each other; (2) a binary player_delta
 * (tag 0x04) decodes to the mover's advancing position over a real socket;
 * (3) walking far triggers despawn (player_leave). Exits non-zero on any failure.
 */
process.env.AOI_ENABLED = '1';
process.env.BINARY_WIRE = '1';

const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const wire = require('./wire');
const { GameHost } = require('./gameHost');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const STEP_MS = 50;
const RUN_MS = 2500; // B walks east long enough to decode several delta frames

function decodeFrame(data, base) {
  // Binary frame (Buffer) → decode via the server codec; JSON stays a string.
  if (typeof data === 'string') return JSON.parse(data);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const tag = buf.readUInt8(0);
  if (tag === wire.TAG.NPC_DELTA)
    return { type: 'npc_update', ...wire.decodeNpcDelta(buf, base.npc) };
  if (tag === wire.TAG.NPC_UPDATE) return wire.decodeNpcUpdate(buf);
  if (tag === wire.TAG.PLAYER_DELTA) return wire.decodePlayerDelta(buf, base.player);
  if (tag === wire.TAG.PLAYER_MOVE) return wire.decodePlayerMove(buf);
  return { type: 'unknown', tag };
}

function mkClient(url, name, spriteGroupId) {
  const c = {
    name,
    ws: new WebSocket(url),
    id: null,
    base: { npc: new Map(), player: new Map() },
    joined: [], // ids spawned to me (player_join)
    left: [], // ids despawned from me (player_leave)
    moves: {}, // id -> last decoded {x,y}
    binaryMoves: 0, // count of binary player_delta frames decoded
    npcBinaryFrames: 0, // count of binary npc_delta frames decoded
    npcRows: 0, // count of valid decoded NPC rows
  };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ type: 'join', name, spriteGroupId })));
  // Node `ws` delivers BOTH text and binary frames as Buffer; `isBinary` tells
  // which (mirrors the browser, where text → string, binary → ArrayBuffer).
  c.ws.on('message', (data, isBinary) => {
    const m = decodeFrame(isBinary ? data : data.toString(), c.base);
    if (m.type === 'welcome') c.id = m.playerId;
    else if (m.type === 'player_join') c.joined.push(m.player.id);
    else if (m.type === 'player_leave') c.left.push(m.id);
    else if (m.type === 'player_move') {
      c.moves[m.id] = { x: m.x, y: m.y };
      if (isBinary) c.binaryMoves++;
    } else if (m.type === 'npc_update') {
      // The NPC firehose (binary npc_delta tag 0x03). Count frames + rows and
      // sanity-check decoded coords so a malformed frame would throw/blow up here.
      if (isBinary) c.npcBinaryFrames++;
      for (const r of m.npcs) {
        if (Number.isFinite(r[1]) && Number.isFinite(r[2]) && r[1] >= 0 && r[2] >= 0) c.npcRows++;
      }
    }
  });
  return c;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  — ' + (detail || '')}`);
}

async function main() {
  const host = new GameHost(ASSETS);
  host.start(); // start the sim + AOI relevance timers (index.js does this; tests drive manually)
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => host.handleConnection(ws));
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://localhost:${wss.address().port}/ws`;

  // Three players. They spawn at the same point → all in one AOI cell at first.
  const a = mkClient(url, 'A', 1);
  const b = mkClient(url, 'B', 2);
  const cFar = mkClient(url, 'C', 3);
  await new Promise((r) => setTimeout(r, 600)); // let joins settle

  check(
    'all three joined (got welcome ids)',
    a.id && b.id && cFar.id,
    `${a.id},${b.id},${cFar.id}`
  );
  check(
    'A sees B + C spawned (same cell)',
    a.joined.includes(b.id) && a.joined.includes(cFar.id),
    a.joined.join(',')
  );

  // Phase 1 — B walks east via the input path; A & C idle. Validates the live
  // server-auth movement + the BINARY player_delta firehose over a real socket.
  let seq = 1;
  const drive = setInterval(() => {
    if (b.ws.readyState === 1)
      b.ws.send(JSON.stringify({ type: 'input', seq: seq++, dx: 1, dy: 0 }));
  }, STEP_MS);
  await new Promise((r) => setTimeout(r, RUN_MS));
  clearInterval(drive);

  for (const c of [a, b, cFar]) {
    const p = host.players.get(c.id);
    console.log(
      `  [diag] ${c.name} server(${p && Math.round(p.x)},${p && Math.round(p.y)}) binMovesByA=${a.binaryMoves}`
    );
  }

  const bServer = host.players.get(b.id);
  check(
    'B actually moved east (input path drives sim)',
    bServer.x > 1144 + 20,
    `B.x=${Math.round(bServer.x)}`
  );
  check(
    'A decoded B position via BINARY frames',
    a.binaryMoves > 0 && !!a.moves[b.id],
    `binMoves=${a.binaryMoves}`
  );
  // The decoded position tracks the server within a few 30Hz ticks of lag (the
  // client is always slightly behind the authoritative latest — that's expected;
  // exact-to-the-half-pixel correctness is already proven by the cross-runtime tests).
  const bSeen = a.moves[b.id];
  check(
    'A decoded B position tracks server (within tick lag)',
    bSeen && Math.abs(bSeen.x - bServer.x) <= 16 && Math.abs(bSeen.y - bServer.y) <= 16,
    bSeen ? `client(${bSeen.x},${bSeen.y}) server(${bServer.x},${bServer.y})` : 'no B move decoded'
  );

  // NPC firehose: nearby townsfolk/enemies wander (sim culls to ACTIVE_RADIUS),
  // so A should have decoded binary npc_delta frames with sane coords over the wire.
  console.log(`  [diag] A npcBinaryFrames=${a.npcBinaryFrames} npcRows=${a.npcRows}`);
  check(
    'A decoded NPC firehose via BINARY frames (npc_delta)',
    a.npcBinaryFrames > 0 && a.npcRows > 0,
    `frames=${a.npcBinaryFrames} rows=${a.npcRows}`
  );

  // Phase 2 — C jumps far east (level-1 walk is too slow to clear AOI in-test);
  // the live relevance pass should despawn it from A (player_leave over the wire).
  const cp = host.players.get(cFar.id);
  cp.x += 3000;
  host.aoi.update(cFar.id, cp.x, cp.y);
  await new Promise((r) => setTimeout(r, 700)); // ≥ one 250ms relevance tick
  check(
    "C left A's AOI → A got player_leave (despawn)",
    a.left.includes(cFar.id),
    `A.left=[${a.left}]`
  );

  // Teardown.
  for (const c of [a, b, cFar])
    try {
      c.ws.close();
    } catch {}
  wss.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n  ${failed ? 'SMOKE FAILED' : 'SMOKE PASS'} — ${results.length - failed}/${results.length} checks`
  );
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(2);
});
