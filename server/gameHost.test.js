/**
 * Smoke test for GameHost (server/gameHost.js) — the first automated test of the
 * multiplayer host. Dependency-free: drives the host with fake sockets and
 * asserts the behaviour of the message switch. Run with `npm test`.
 *
 * Two sections:
 *  1. Transport/routing — join/move/chat/leave broadcast contract (catalog-free).
 *  2. Economy — equip/use_item/buy/sell, picking valid item ids from the real
 *     catalog (via loadShops) so the test isn't brittle to specific numbers, and
 *     asserting money/inventory via the authoritative player record.
 *
 * Loads the real public/assets but does NOT call host.start() — there's no sim
 * tick, we invoke the socket handlers directly. npcSim installs a file watcher on
 * construction, so we process.exit() at the end.
 */
const assert = require('assert');
const path = require('path');
const { GameHost } = require('./gameHost');
const { loadShops } = require('./shops');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');

// A stand-in for a `ws` socket: records what the server sent it, and lets the
// test push client->server messages and a close into the registered handlers.
class FakeSocket {
  constructor() {
    this.sent = [];
    this.handlers = {};
    this.readyState = 1; // OPEN — GameHost only broadcasts to readyState === 1
  }
  send(str) { this.sent.push(JSON.parse(str)); }
  on(ev, cb) { this.handlers[ev] = cb; }
  recv(obj) { this.handlers.message(JSON.stringify(obj)); } // simulate a client msg
  close() { if (this.handlers.close) this.handlers.close(); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
  last(t) { const a = this.ofType(t); return a[a.length - 1]; }
  clear() { this.sent.length = 0; }
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
const shop = loadShops(ASSETS); // same data the host loaded — used to pick valid ids

// ============================ 1. Transport ============================

const alice = new FakeSocket();
host.handleConnection(alice);
alice.recv({ type: 'join', name: 'Alice', spriteGroupId: 1 });
const aliceId = alice.last('welcome').playerId;

check('join → welcome to self (id, roster, inventory, money)', () => {
  const w = alice.last('welcome');
  assert(w, 'no welcome sent');
  assert.strictEqual(typeof w.playerId, 'string');
  assert(Array.isArray(w.players), 'players not an array');
  assert.strictEqual(w.players.length, 0, 'first player should see empty roster');
  assert(Array.isArray(w.inventory), 'inventory not an array');
  assert.strictEqual(typeof w.money, 'number');
});

const bob = new FakeSocket();
host.handleConnection(bob);
bob.recv({ type: 'join', name: 'Bob', spriteGroupId: 2 });

check('second join → first player gets player_join', () => {
  const pj = alice.last('player_join');
  assert(pj, 'Alice got no player_join');
  assert.strictEqual(pj.player.name, 'Bob');
});

check('joining player does NOT get its own player_join', () => {
  assert.strictEqual(bob.ofType('player_join').length, 0);
});

check("Bob's welcome roster includes Alice", () => {
  const w = bob.last('welcome');
  assert.strictEqual(w.players.length, 1);
  assert.strictEqual(w.players[0].name, 'Alice');
});

alice.clear();
bob.clear();
alice.recv({ type: 'move', x: 100, y: 200, direction: 2, frame: 1, pose: 'walk' });

check('move → others get player_move with the coords', () => {
  const m = bob.last('player_move');
  assert(m, 'Bob got no player_move');
  assert.strictEqual(m.x, 100);
  assert.strictEqual(m.y, 200);
});

check('move → sender does NOT echo to itself', () => {
  assert.strictEqual(alice.ofType('player_move').length, 0);
});

alice.clear();
bob.clear();
alice.recv({ type: 'chat', text: 'hello world' });

check('chat → others get it, sender does not', () => {
  assert.strictEqual(bob.last('chat').text, 'hello world');
  assert.strictEqual(alice.ofType('chat').length, 0);
});

bob.clear();
bob.recv({ type: 'equip', slot: 'bogus', itemId: null });

check('invalid equip slot is ignored', () => {
  assert.strictEqual(bob.ofType('equipped').length, 0);
});

check('unknown message type does not throw', () => {
  bob.recv({ type: 'nonsense_message' });
});

// ============================ 2. Economy ============================
// Starter gear (DEV grants): Cracked bat (weapon), Cheap bracelet (arms), Cookie.

const BAT = '17';      // weapon, dev-granted on join
const COOKIE = '88';   // consumable, dev-granted on join

check('equip owned weapon → owner gets authoritative equipped set', () => {
  alice.clear();
  bob.clear();
  assert(host.players.get(aliceId).inventory.includes(BAT), 'precondition: owns bat');
  alice.recv({ type: 'equip', slot: 'weapon', itemId: BAT });
  const eq = alice.last('equipped');
  assert(eq, 'no equipped msg to owner');
  assert.strictEqual(eq.slots.weapon, BAT);
});

check('equip → other players get the held-item broadcast', () => {
  const e = bob.last('equip');
  assert(e, 'Bob got no equip broadcast');
  assert.strictEqual(e.itemId, BAT);
});

check('use_item consumable → slot consumed (inventory no longer has it)', () => {
  assert(host.players.get(aliceId).inventory.includes(COOKIE), 'precondition: owns cookie');
  alice.clear();
  alice.recv({ type: 'use_item', itemId: COOKIE });
  const inv = alice.last('inventory');
  assert(inv, 'no inventory delta after use');
  assert(!inv.items.some((i) => i.id === COOKIE), 'cookie was not consumed');
});

check('use_item on equippable gear is refused (never consumed)', () => {
  alice.clear();
  alice.recv({ type: 'use_item', itemId: BAT });
  assert.strictEqual(alice.ofType('inventory').length, 0, 'gear should not produce a delta');
  assert(host.players.get(aliceId).inventory.includes(BAT), 'gear must still be owned');
});

// Find an affordable, stocked item from the real catalog.
let buyStore = null;
let buyItem = null;
for (const [sid, list] of Object.entries(shop.stores)) {
  if (!Array.isArray(list)) continue;
  for (const it of list) {
    const g = shop.goods[String(it)];
    if (g && g.cost > 0 && g.cost <= 1000) { buyStore = Number(sid); buyItem = String(it); break; }
  }
  if (buyItem) break;
}

check('buy stocked affordable item → money debited by catalog cost, item added', () => {
  assert(buyItem, 'no affordable stocked item found in catalog');
  const cost = shop.goods[buyItem].cost;
  const before = host.players.get(aliceId).money;
  alice.clear();
  alice.recv({ type: 'buy', store: buyStore, item: buyItem });
  assert.strictEqual(host.players.get(aliceId).money, before - cost, 'wrong money after buy');
  assert(alice.last('inventory').items.some((i) => i.id === buyItem), 'bought item missing');
});

check('sell owned item → money credited half the catalog cost', () => {
  const cost = shop.goods[buyItem].cost;
  const before = host.players.get(aliceId).money;
  alice.clear();
  alice.recv({ type: 'sell', item: buyItem });
  assert.strictEqual(host.players.get(aliceId).money, before + Math.floor(cost / 2), 'wrong money after sell');
});

check('buy is rejected when unaffordable (no money/inventory change)', () => {
  const p = host.players.get(aliceId);
  p.money = 0; // force broke
  const invLen = p.inventory.length;
  alice.clear();
  alice.recv({ type: 'buy', store: buyStore, item: buyItem });
  assert.strictEqual(p.money, 0, 'money should be untouched');
  assert.strictEqual(p.inventory.length, invLen, 'inventory should be untouched');
});

// ============================ 3. Leave ============================

alice.clear();
bob.close();

check('close → remaining players get player_leave', () => {
  const pl = alice.last('player_leave');
  assert(pl, 'Alice got no player_leave');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
