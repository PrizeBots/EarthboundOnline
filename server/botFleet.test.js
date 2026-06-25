/**
 * Smoke test for the in-process bot fleet (server/botManager.js) + its dev-gated
 * `bot` control message (gameHost `case 'bot'`). Dependency-free: drives the host
 * with fake sockets, no host.start() (we don't need the sim tick). npcSim installs
 * a file watcher on construction, so we process.exit() at the end. Run with
 * `node server/botFleet.test.js`.
 */
const assert = require('assert');
const path = require('path');
const { GameHost } = require('./gameHost');
const { BotFleet } = require('./botManager');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');

class FakeSocket {
  constructor() {
    this.sent = [];
    this.handlers = {};
    this.readyState = 1;
  }
  send(str) {
    if (typeof str === 'string') this.sent.push(JSON.parse(str));
  }
  on(ev, cb) {
    this.handlers[ev] = cb;
  }
  recv(obj) {
    this.handlers.message(JSON.stringify(obj));
  }
  last(t) {
    const a = this.sent.filter((m) => m.type === t);
    return a[a.length - 1];
  }
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    fail++;
  }
}

const host = new GameHost(ASSETS);

// ============== 1. BotFleet directly: spawn / despawn / stop =================
const fleet = new BotFleet(host);
const base = host.players.size;

check('spawn(25) adds 25 anonymous players synchronously', () => {
  const n = fleet.spawn(25, { behavior: 'wander' });
  assert.strictEqual(n, 25, `fleet.count = ${n}`);
  assert.strictEqual(host.players.size, base + 25, `players = ${host.players.size}`);
});

check('spawned bots joined (have an authoritative entry with a position)', () => {
  const b = fleet.bots[0];
  const entry = host.players.get(b.playerId);
  assert(entry, 'bot has no player entry');
  assert(Number.isFinite(entry.x) && Number.isFinite(entry.y), 'bot has no position');
});

check('despawn(10) removes exactly 10', () => {
  const n = fleet.despawn(10);
  assert.strictEqual(n, 15, `fleet.count = ${n}`);
  assert.strictEqual(host.players.size, base + 15, `players = ${host.players.size}`);
});

check('stop() removes all bots and clears timers', () => {
  fleet.stop();
  assert.strictEqual(fleet.count, 0, `fleet.count = ${fleet.count}`);
  assert.strictEqual(host.players.size, base, `players = ${host.players.size}`);
  assert.strictEqual(fleet._driveTimer, null, 'drive timer not cleared');
  assert.strictEqual(fleet._sampleTimer, null, 'sample timer not cleared');
});

check('stats() reports a clean snapshot with no side effects', () => {
  const s = fleet.stats();
  assert.strictEqual(s.count, 0);
  assert.strictEqual(typeof s.players, 'number');
  assert.strictEqual(typeof s.maxBots, 'number');
});

// ===================== 2. Gate: the `bot` control message ====================
// BOTS_ENABLED is unset in the test env, so an anonymous player must be refused
// and a dev/admin player allowed.
const anon = new FakeSocket();
host.handleConnection(anon);
anon.recv({ type: 'join', name: 'Anon', spriteGroupId: 1 });

check('anonymous (role player) is refused with a forbidden notice', () => {
  anon.recv({ type: 'bot', op: 'spawn', count: 5 });
  const notice = anon.last('notice');
  assert(notice && notice.code === 'forbidden', 'expected a forbidden notice');
  assert.strictEqual(anon.last('bot_stats'), undefined, 'must not reply with bot_stats');
});

const adminSock = new FakeSocket();
host.handleConnection(adminSock);
adminSock.recv({ type: 'join', name: 'Admin', spriteGroupId: 1 });
// Role is server-authoritative; set it directly on the live entry to simulate a
// signed-in dev/admin (the path _loadCharacterInit would take in prod).
host.players.get(adminSock.last('welcome').playerId).role = 'admin';

check('dev/admin spawns bots and gets a bot_stats reply', () => {
  const before = host.players.size;
  adminSock.recv({ type: 'bot', op: 'spawn', count: 3, behavior: 'wander' });
  const s = adminSock.last('bot_stats');
  assert(s, 'no bot_stats reply');
  assert.strictEqual(s.count, 3, `count = ${s.count}`);
  assert.strictEqual(host.players.size, before + 3, `players = ${host.players.size}`);
});

check('dev/admin stop clears the fleet', () => {
  adminSock.recv({ type: 'bot', op: 'stop' });
  const s = adminSock.last('bot_stats');
  assert.strictEqual(s.count, 0, `count = ${s.count}`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
