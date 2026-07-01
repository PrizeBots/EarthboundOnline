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
  send(str) {
    // BINARY_WIRE (on by default) ships position frames as binary Buffers; these
    // tests assert on the JSON control messages only (the wire codec has its own
    // round-trip + smoke tests), so skip anything that isn't a JSON string.
    if (typeof str !== 'string') return;
    this.sent.push(JSON.parse(str));
  }
  on(ev, cb) {
    this.handlers[ev] = cb;
  }
  recv(obj) {
    this.handlers.message(JSON.stringify(obj));
  } // simulate a client msg
  close() {
    if (this.handlers.close) this.handlers.close();
  }
  ofType(t) {
    return this.sent.filter((m) => m.type === t);
  }
  last(t) {
    const a = this.ofType(t);
    return a[a.length - 1];
  }
  clear() {
    this.sent.length = 0;
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
const bobId = bob.last('welcome').playerId;

// AOI model: the welcome roster is always empty; peers arrive as targeted
// player_join messages, sent reciprocally on join (both ways, same tick) so
// nobody is invisible until the next relevance pass. (Alice and Bob spawn in the
// same cell here, so each is in the other's AOI block.)
check('second join → first player gets a player_join for the newcomer', () => {
  const pj = alice.last('player_join');
  assert(pj, 'Alice got no player_join');
  assert.strictEqual(pj.player.name, 'Bob');
});

check('joining player is spawned in-range peers, but never itself', () => {
  const joins = bob.ofType('player_join');
  assert(
    joins.some((m) => m.player.name === 'Alice'),
    'Bob should get a player_join for the in-range Alice'
  );
  assert(
    joins.every((m) => m.player.id !== bobId),
    'a player must never get a player_join for itself'
  );
});

check('welcome roster is empty under AOI (peers arrive via player_join)', () => {
  const w = bob.last('welcome');
  assert.strictEqual(w.players.length, 0, 'AOI welcome roster should be empty');
  assert(
    bob.ofType('player_join').some((m) => m.player.name === 'Alice'),
    'Alice should reach Bob as a targeted player_join, not in the roster'
  );
});

alice.clear();
bob.clear();
const aSpawn = host.players.get(aliceId);
const origX = aSpawn.x;
const origY = aSpawn.y;
const moveX = Math.round(aSpawn.x + 10);
const moveY = Math.round(aSpawn.y + 10);

// 'move' is an EDITOR-ONLY channel now (the dev free-camera anchor). Normal play
// is server-authoritative via 'input' (_simPlayers) + server-resolved door warps,
// so a gameplay client that volunteers a position is rejected — no client teleport
// or speedhack via 'move'.
check('move from a normal (non-editor) player is rejected — no trusted position', () => {
  const p = host.players.get(aliceId);
  p.editor = false;
  alice.clear();
  bob.clear();
  alice.recv({ type: 'move', x: moveX, y: moveY, direction: 2, frame: 1, pose: 'walk' });
  assert.strictEqual(p.x, origX, 'server position unchanged');
  assert.strictEqual(p.y, origY, 'server position unchanged');
  assert.strictEqual(bob.ofType('player_move').length, 0, 'no broadcast for a rejected move');
});

check('move from an EDITOR player anchors the sim + broadcasts (sender does not echo)', () => {
  const p = host.players.get(aliceId);
  p.editor = true;
  alice.clear();
  bob.clear();
  alice.recv({ type: 'move', x: moveX, y: moveY, direction: 2, frame: 1, pose: 'walk' });
  assert.strictEqual(p.x, moveX, 'editor anchor sets the server position');
  assert.strictEqual(p.y, moveY);
  const m = bob.last('player_move');
  assert(m && m.x === moveX && m.y === moveY, 'others get the editor anchor');
  assert.strictEqual(alice.ofType('player_move').length, 0, 'sender does not echo to itself');
  p.editor = false;
});

check('move validation: garbage coords are dropped (editor channel)', () => {
  const p = host.players.get(aliceId);
  p.editor = true;
  const x0 = p.x;
  const y0 = p.y;
  alice.recv({ type: 'move', x: 'NaN', y: null, direction: 0, frame: 0, pose: 'walk' });
  assert.strictEqual(p.x, x0, 'x unchanged');
  assert.strictEqual(p.y, y0, 'y unchanged');
  p.editor = false;
  p.x = origX; // restore Alice to spawn so later tests start from a known spot
  p.y = origY;
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

const BAT = '17'; // a weapon (equip.slot === 'weapon') in the real catalog
const COOKIE = '88'; // a heal consumable (heal > 0, no equip) in the real catalog

// Players now START EMPTY (shops.js: startingInventory = [], STARTING_MONEY = 0 —
// the old dev grant of a bat/bracelet/cookie was removed). These tests exercise
// the equip/use/buy/sell LOGIC, so grant what they need directly on the
// authoritative record (the same record the tests poke below). Guard the ids in
// case the catalog ever drops them.
(() => {
  const p = host.players.get(aliceId);
  assert(host.GOODS[BAT] && host.GOODS[BAT].equip && host.GOODS[BAT].equip.slot === 'weapon');
  assert(host.GOODS[COOKIE] && !host.GOODS[COOKIE].equip && host.GOODS[COOKIE].heal > 0);
  if (!p.inventory.includes(BAT)) p.inventory.push(BAT);
  if (!p.inventory.includes(COOKIE)) p.inventory.push(COOKIE);
  p.money = 100000; // ample on-hand cash for the buy/sell tests
})();

check('equip owned weapon → equipped set + weapon LEAVES Goods', () => {
  alice.clear();
  bob.clear();
  const p = host.players.get(aliceId);
  assert(p.inventory.includes(BAT), 'precondition: owns bat (in Goods)');
  alice.recv({ type: 'equip', slot: 'weapon', itemId: BAT });
  const eq = alice.last('equipped');
  assert(eq && eq.slots.weapon === BAT, 'equipped weapon should be the bat');
  assert(!p.inventory.includes(BAT), 'worn gear should leave Goods');
  const inv = alice.last('inventory');
  assert(inv && !inv.items.some((i) => i.id === BAT), 'Goods delta should omit the worn bat');
});

check('equip → other players get the held-item broadcast', () => {
  const e = bob.last('equip');
  assert(e, 'Bob got no equip broadcast');
  assert.strictEqual(e.itemId, BAT);
});

check('unequip → worn piece returns to Goods', () => {
  const p = host.players.get(aliceId);
  assert.strictEqual(p.equipped.weapon, BAT, 'precondition: bat is worn');
  alice.clear();
  alice.recv({ type: 'equip', slot: 'weapon', itemId: null });
  assert.strictEqual(p.equipped.weapon, null, 'slot should be empty after unequip');
  assert(p.inventory.includes(BAT), 'bat should be back in Goods');
  const inv = alice.last('inventory');
  assert(inv && inv.items.some((i) => i.id === BAT), 'Goods delta should include the bat');
});

check('unequip refused when Goods is full → notice, stays equipped', () => {
  const p = host.players.get(aliceId);
  const savedInv = [...p.inventory];
  const savedEq = { ...p.equipped };
  // Wear the bat, then stuff Goods to MAX_SLOTS (14) so it has nowhere to land.
  p.inventory = p.inventory.filter((id) => id !== BAT);
  p.equipped.weapon = BAT;
  while (p.inventory.length < 14) p.inventory.push(COOKIE);
  alice.clear();
  alice.recv({ type: 'equip', slot: 'weapon', itemId: null });
  assert.strictEqual(p.equipped.weapon, BAT, 'bat must stay equipped when the bag is full');
  const n = alice.last('notice');
  assert(n && /full/i.test(n.text), 'expected a bag-full notice');
  p.inventory = savedInv; // restore for the downstream consumable tests
  p.equipped = savedEq;
});

check('use_item consumable → slot consumed (inventory no longer has it)', () => {
  const p = host.players.get(aliceId);
  assert(p.inventory.includes(COOKIE), 'precondition: owns cookie');
  p.hp = p.maxHp - 5; // hurt, so the heal item isn't refused as "HP already full"
  alice.clear();
  alice.recv({ type: 'use_item', itemId: COOKIE });
  const inv = alice.last('inventory');
  assert(inv, 'no inventory delta after use');
  assert(!inv.items.some((i) => i.id === COOKIE), 'cookie was not consumed');
});

check('use_item heal at FULL HP → refused (not wasted), player notified', () => {
  const p = host.players.get(aliceId);
  if (!p.inventory.includes(COOKIE)) p.inventory.push(COOKIE); // re-grant (prior test ate it)
  p.hp = p.maxHp; // full HP — a pure-heal item would heal 0
  alice.clear();
  alice.recv({ type: 'use_item', itemId: COOKIE });
  assert.strictEqual(alice.ofType('inventory').length, 0, 'cookie must NOT be consumed at full HP');
  assert(p.inventory.includes(COOKIE), 'cookie should still be owned');
  const n = alice.last('notice');
  assert(n && /full/i.test(n.text), 'expected an "HP is full" notice');
});

check('use_item on equippable gear is refused (never consumed)', () => {
  alice.clear();
  alice.recv({ type: 'use_item', itemId: BAT });
  assert.strictEqual(alice.ofType('inventory').length, 0, 'gear should not produce a delta');
  assert(host.players.get(aliceId).inventory.includes(BAT), 'gear must still be owned');
});

// Find an affordable, stocked item from a store that has a PLACED clerk (buy/sell
// are now proximity-gated, so we need a clerk anchor to stand at). Pin the player
// to that clerk before each economy test so the transaction is in range.
const clerkAnchorFor = (store) => {
  for (const a of host.npcSim.interactableAnchors()) {
    const m = host.npcShops[String(a.npcId)];
    if (m && m.store === store) return a;
  }
  return null;
};
let buyStore = null;
let buyItem = null;
let buyAnchor = null;
for (const [sid, list] of Object.entries(shop.stores)) {
  if (!Array.isArray(list)) continue;
  const anchor = clerkAnchorFor(Number(sid));
  if (!anchor) continue; // can't test a store with no reachable clerk
  for (const it of list) {
    const g = shop.goods[String(it)];
    if (g && g.cost > 0 && g.cost <= 1000) {
      buyStore = Number(sid);
      buyItem = String(it);
      buyAnchor = anchor;
      break;
    }
  }
  if (buyItem) break;
}
// Stand the player at the clerk so the proximity gate passes (their tracked
// position is what the server checks).
const standAtClerk = () => {
  const p = host.players.get(aliceId);
  if (buyAnchor) {
    p.x = buyAnchor.x;
    p.y = buyAnchor.y;
  }
};

check('buy stocked affordable item → money debited by catalog cost, item added', () => {
  assert(buyItem, 'no affordable stocked item found in catalog');
  const cost = shop.goods[buyItem].cost;
  const before = host.players.get(aliceId).money;
  standAtClerk();
  alice.clear();
  alice.recv({ type: 'buy', store: buyStore, item: buyItem });
  assert.strictEqual(host.players.get(aliceId).money, before - cost, 'wrong money after buy');
  assert(
    alice.last('inventory').items.some((i) => i.id === buyItem),
    'bought item missing'
  );
});

check('sell owned item → money credited half the catalog cost', () => {
  const cost = shop.goods[buyItem].cost;
  const before = host.players.get(aliceId).money;
  standAtClerk();
  alice.clear();
  alice.recv({ type: 'sell', item: buyItem });
  assert.strictEqual(
    host.players.get(aliceId).money,
    before + Math.floor(cost / 2),
    'wrong money after sell'
  );
});

check('buy is rejected when unaffordable (no money/inventory change)', () => {
  const p = host.players.get(aliceId);
  p.money = 0; // force broke
  const invLen = p.inventory.length;
  standAtClerk();
  alice.clear();
  alice.recv({ type: 'buy', store: buyStore, item: buyItem });
  assert.strictEqual(p.money, 0, 'money should be untouched');
  assert.strictEqual(p.inventory.length, invLen, 'inventory should be untouched');
});

// ===================== 2a2. Drop item to the ground =====================

check('drop_item removes ONE from the bag and spawns a ground drop', () => {
  const p = host.players.get(aliceId);
  p.hp = p.hp > 0 ? p.hp : 10; // ensure alive
  p.downed = false;
  p.dying = false;
  p.inventory.push(COOKIE);
  const invLen = p.inventory.length;
  const dropsBefore = host.npcSim.dropsSnapshot().length;
  alice.clear();
  alice.recv({ type: 'drop_item', itemId: COOKIE });
  assert.strictEqual(p.inventory.length, invLen - 1, 'exactly one item should leave the bag');
  const drops = host.npcSim.dropsSnapshot();
  assert.strictEqual(drops.length, dropsBefore + 1, 'a ground drop should appear');
  assert(
    drops.some((d) => d.kind === 'item' && String(d.item) === COOKIE),
    'the dropped cookie should be on the ground'
  );
  assert(alice.last('inventory'), 'client should get a fresh inventory');
});

check('drop_item for an unowned item is ignored (no phantom drop)', () => {
  const p = host.players.get(aliceId);
  // Strip every cookie so the player owns none.
  p.inventory = p.inventory.filter((id) => id !== COOKIE);
  const invLen = p.inventory.length;
  const dropsBefore = host.npcSim.dropsSnapshot().length;
  alice.recv({ type: 'drop_item', itemId: COOKIE });
  assert.strictEqual(p.inventory.length, invLen, 'inventory must be untouched');
  assert.strictEqual(
    host.npcSim.dropsSnapshot().length,
    dropsBefore,
    'no drop should spawn for an item you do not own'
  );
});

check('drop_item clamps a forged far-away target to throw range (no map-wide fling)', () => {
  const p = host.players.get(aliceId);
  p.hp = p.hp > 0 ? p.hp : 10;
  p.downed = false;
  p.dying = false;
  p.inventory.push(COOKIE);
  const dropsBefore = host.npcSim.dropsSnapshot().length;
  alice.recv({ type: 'drop_item', itemId: COOKIE, x: p.x + 99999, y: p.y + 99999 });
  const drops = host.npcSim.dropsSnapshot();
  assert.strictEqual(drops.length, dropsBefore + 1, 'a drop should still spawn');
  const d = drops[drops.length - 1];
  // Aim is clamped to throw range (no map-wide horizontal fling). If the clamped
  // spot is solid, the item may slide straight DOWN to a reachable tile, so allow
  // a bounded vertical settle on top of the clamp — but x stays clamped and the
  // total never approaches the forged 99999px.
  assert(
    Math.abs(d.x - p.x) <= 160,
    `x should be clamped near the player, got ${Math.round(d.x - p.x)}px`
  );
  assert(
    d.y - p.y <= 160 + 256,
    `y stays within throw clamp + settle slide, got ${Math.round(d.y - p.y)}px`
  );
});

check('drop_item is refused while downed (no inventory fiddling when KO)', () => {
  const p = host.players.get(aliceId);
  p.inventory.push(COOKIE);
  p.downed = true;
  const invLen = p.inventory.length;
  const dropsBefore = host.npcSim.dropsSnapshot().length;
  alice.recv({ type: 'drop_item', itemId: COOKIE });
  assert.strictEqual(p.inventory.length, invLen, 'inventory must be untouched while downed');
  assert.strictEqual(host.npcSim.dropsSnapshot().length, dropsBefore, 'no drop while downed');
  p.downed = false; // restore for later tests
});

// ===================== 2b. Proximity gating (anti-cheat) =====================
// Buy/sell/ATM are only honored when the player is actually AT the shop/ATM, so a
// forged message from across the map can't transact.

check('buy is rejected when NOT at the shop', () => {
  const p = host.players.get(aliceId);
  p.money = 100000;
  p.x = -99999; // nowhere near any clerk
  p.y = -99999;
  const invLen = p.inventory.length;
  alice.recv({ type: 'buy', store: buyStore, item: buyItem });
  assert.strictEqual(p.money, 100000, 'money must not change away from the shop');
  assert.strictEqual(p.inventory.length, invLen, 'no item granted away from the shop');
});

check('ATM withdraw is rejected when NOT at an ATM', () => {
  const p = host.players.get(aliceId);
  p.bank = 500;
  p.money = 0;
  p.x = -99999;
  p.y = -99999;
  alice.recv({ type: 'atm_withdraw', amount: 100 });
  assert.strictEqual(p.bank, 500, 'bank must not change away from an ATM');
  assert.strictEqual(p.money, 0, 'cash must not change away from an ATM');
});

// Positive ATM path — only if the map actually has an ATM placement to stand at.
const atmAnchor = host.npcSim
  .interactableAnchors()
  .find((a) => a.sprite === 259 || a.sprite === 447);
if (atmAnchor) {
  check('ATM withdraw works when standing at an ATM', () => {
    const p = host.players.get(aliceId);
    p.bank = 500;
    p.money = 0;
    p.x = atmAnchor.x;
    p.y = atmAnchor.y;
    alice.recv({ type: 'atm_withdraw', amount: 100 });
    assert.strictEqual(p.bank, 400, 'bank should drop by the withdrawn amount at an ATM');
    assert.strictEqual(p.money, 100, 'cash should rise by the withdrawn amount at an ATM');
  });
}

// ============== 2c. Server-authoritative movement (input sim) ==============
// The client sends inputs (seq + held dir); the server simulates the position.

check('input sim moves the player on a clear step, acks the seq, drains the queue', () => {
  const p = host.players.get(aliceId);
  // 1296,1168 = spawn street (open/walkable — see combat.test).
  p._inputs = null;
  p._lastSeqIn = null;
  p._ackSeq = 0;
  let moved = false;
  let seq = 1;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    p.x = 1296;
    p.y = 1168;
    alice.clear();
    alice.recv({ type: 'input', seq, dx, dy });
    host._simPlayers();
    if (p.x !== 1296 || p.y !== 1168) moved = true;
    assert.strictEqual(p._ackSeq, seq, 'server should ack the processed input seq');
    assert(!p._inputs || p._inputs.length === 0, 'input queue should drain each tick');
    const pos = alice.last('pos');
    assert(pos && pos.seq === seq, 'owner should get a pos ack carrying the seq');
    seq++;
  }
  assert(moved, 'at least one direction must be walkable from spawn');
});

check('input sim ignores a stale / replayed seq (no double-processing)', () => {
  const p = host.players.get(aliceId);
  p.x = 1296;
  p.y = 1168;
  p._inputs = null;
  p._lastSeqIn = null;
  p._ackSeq = 0;
  alice.recv({ type: 'input', seq: 5, dx: 0, dy: 0 });
  host._simPlayers();
  assert.strictEqual(p._ackSeq, 5, 'fresh seq processed');
  alice.recv({ type: 'input', seq: 3, dx: 1, dy: 0 }); // stale — must be dropped at intake
  host._simPlayers();
  assert.strictEqual(p._ackSeq, 5, 'a stale seq must never be processed');
});

check('input sim throttles a flood to the per-tick step cap (anti-speedhack)', () => {
  const p = host.players.get(aliceId);
  p.x = 1296;
  p.y = 1168;
  p._inputs = null;
  p._lastSeqIn = null;
  p._ackSeq = 0;
  const x0 = p.x;
  const y0 = p.y;
  // Far more inputs than the per-tick cap, all in a single tick (a 120Hz client
  // or an input flooder). The server must NOT apply them all at once.
  for (let s = 1; s <= 50; s++) alice.recv({ type: 'input', seq: s, dx: 1, dy: 0 });
  host._simPlayers();
  // Only a couple of steps applied; the rest stay queued to drain at the honest
  // rate on later ticks — a client can't out-run real time.
  assert(
    p._inputs && p._inputs.length >= 40,
    `most flooded inputs must remain queued (had ${p._inputs ? p._inputs.length : 0})`
  );
  assert(
    Math.hypot(p.x - x0, p.y - y0) < 6,
    'one tick must not move further than the per-tick step cap'
  );
});

// Server-authoritative doors: a use_door is only honored if the player is actually
// on a door trigger, and warps to the door's OWN dest (never a client-chosen spot).
{
  // Find a real door trigger from the loaded map (if any).
  const sim = host.npcSim;
  let doorPos = null;
  // Probe a grid for a trigger via the exposed doorAt (cheap; map has ~1000).
  // We don't know coords, so scan candidate triggers through resolveDoor by
  // asking doorAt at each trigger — but we can't enumerate; instead place the
  // player at known door positions is impossible without the list. Use a coarse
  // scan over the world in big steps until doorAt returns one.
  outer: for (let y = 0; y < host.WORLD.h; y += 16) {
    for (let x = 0; x < host.WORLD.w; x += 16) {
      const d = sim.doorAt(x, y);
      if (d) {
        doorPos = { x, y, d };
        break outer;
      }
    }
  }
  if (doorPos) {
    check('use_door warps to the door dest when standing on a door', () => {
      const p = host.players.get(aliceId);
      p.editor = false;
      p.x = doorPos.x;
      p.y = doorPos.y;
      alice.clear();
      alice.recv({ type: 'use_door' });
      assert.strictEqual(p.x, Math.round(doorPos.d.destX), 'warped to door destX');
      assert.strictEqual(p.y, Math.round(doorPos.d.destY), 'warped to door destY');
      const w = alice.last('warp');
      assert(w && w.x === p.x && w.y === p.y, 'owner told the authoritative warp dest');
    });
  }

  check('door landing avoids stacking on an entity already on the exit', () => {
    // Spawn street (1296,1168) is open/walkable (see input-sim tests). Park Bob on
    // the exact exit tile; the server's landing resolver must hand the warping
    // player a DIFFERENT, clear spot so the two don't stack and wedge.
    const other = host.players.get(bobId);
    other.editor = false;
    other.x = 1296;
    other.y = 1168;
    const spot = host.npcSim.findPlayerLanding(
      1296,
      1168,
      Array.from(host.players.values()),
      aliceId
    );
    assert(
      !(spot.x === other.x && spot.y === other.y),
      'resolver must not return the occupied tile'
    );
    const COL_W = 14;
    const COL_H = 8;
    const COL_OY = -8;
    const ax = spot.x - COL_W / 2;
    const ay = spot.y + COL_OY;
    const bx = other.x - COL_W / 2;
    const by = other.y + COL_OY;
    const overlap = ax < bx + COL_W && ax + COL_W > bx && ay < by + COL_H && ay + COL_H > by;
    assert(!overlap, 'resolved landing must not overlap the occupant');
  });

  check('use_door is rejected when NOT on a door (snapped back)', () => {
    const p = host.players.get(aliceId);
    p.editor = false;
    p.x = -99999; // nowhere near any door
    p.y = -99999;
    alice.clear();
    alice.recv({ type: 'use_door' });
    assert.strictEqual(p.x, -99999, 'no warp away from a door');
    const pos = alice.last('pos');
    assert(pos && pos.x === -99999, 'server re-asserted the authoritative position');
  });
}

// Server-authoritative escalator ride: the diagonal glide across the solid steps
// is client-driven, so the server trusts the client's landing — but ONLY when the
// player's authoritative position is actually on a stair trigger (anti-cheat).
{
  const sim = host.npcSim;
  let stairPos = null;
  outer: for (let y = 0; y < host.WORLD.h; y += 8) {
    for (let x = 0; x < host.WORLD.w; x += 8) {
      if (sim.stairAt(x, y)) {
        stairPos = { x, y };
        break outer;
      }
    }
  }
  if (stairPos) {
    check('ride_warp honors the client landing when ON a stair (no movement freeze)', () => {
      const p = host.players.get(aliceId);
      p.editor = false;
      p.warping = false;
      p.x = stairPos.x;
      p.y = stairPos.y;
      alice.clear();
      alice.recv({ type: 'ride_warp', x: 4321, y: 8765 });
      assert.strictEqual(p.x, 4321, 'moved to the client landing X');
      assert.strictEqual(p.y, 8765, 'moved to the client landing Y');
      // Must NOT raise the warp shield: an open ride has no fade to clear it, and a
      // raised shield freezes server-side movement (the "stuck at top" bug).
      assert(!p.warping, 'open ride must not freeze the player with a warp shield');
    });
  }

  check('ride_warp is rejected when NOT on a stair (snapped back)', () => {
    const p = host.players.get(aliceId);
    p.editor = false;
    p.x = -88888; // nowhere near any stair
    p.y = -88888;
    alice.clear();
    alice.recv({ type: 'ride_warp', x: 4321, y: 8765 });
    assert.strictEqual(p.x, -88888, 'no warp without a stair under us');
    const pos = alice.last('pos');
    assert(pos && pos.x === -88888, 'server re-asserted the authoritative position');
  });
}

// ===================== 3. Door-transition shield =====================
// While a player is mid door-fade its client freezes (no moves), so the server
// must ignore enemy hits on the motionless ghost until the fade ends.

check('warp:true shields the player from enemy damage', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  alice.recv({ type: 'warp', warping: true });
  host.damagePlayer(aliceId, 20);
  assert.strictEqual(
    host.players.get(aliceId).hp,
    p.maxHp,
    'hit should have whiffed while warping'
  );
});

check('warp:false lifts the shield (damage lands again)', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  alice.recv({ type: 'warp', warping: false });
  host.damagePlayer(aliceId, 20);
  assert(host.players.get(aliceId).hp < p.maxHp, 'hit should land once the fade is over');
});

// ===================== 3b. Dev editor mode =====================
// While a client is in the editor its avatar is pulled from the world sim, so it
// must take no damage (a death would respawn-yank the admin's free camera).

check('editor:true makes the player untargetable (no damage)', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  alice.recv({ type: 'editor', on: true });
  host.damagePlayer(aliceId, 20);
  assert.strictEqual(host.players.get(aliceId).hp, p.maxHp, 'hit should whiff while in the editor');
});

check('editor:false rejoins the world (damage lands again)', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  alice.recv({ type: 'editor', on: false });
  host.damagePlayer(aliceId, 20);
  assert(host.players.get(aliceId).hp < p.maxHp, 'hit should land once the editor closes');
});

// ===================== 4. Progression / leveling =====================
// awardXp is the server-authoritative leveling path: accrue EXP, apply level-ups
// (geometric curve), drip maxHp + bank a skill point, heal on level-up, and push
// a player_stats payload. Combat stats grow by SPENDING points, not on level-up.
// Driven directly — no enemy kill needed.

check('XP below the threshold accrues without leveling', () => {
  const p = host.players.get(aliceId);
  p.level = 1;
  p.exp = 0;
  p.expToNext = 30; // known baseline (level-2 costs 30)
  alice.clear();
  host.awardXp(aliceId, 10);
  const ps = alice.last('player_stats');
  assert(ps, 'no player_stats broadcast');
  assert.strictEqual(ps.leveled, false);
  assert.strictEqual(ps.gained, 10);
  assert.strictEqual(host.players.get(aliceId).exp, 10);
  assert.strictEqual(host.players.get(aliceId).level, 1);
});

check('crossing the EXP threshold levels up, drips maxHp, and full-heals', () => {
  const p = host.players.get(aliceId);
  // Only maxHp auto-grows (GROWTH); offense/defense/speed/etc. grow ONLY by
  // spending banked skill points — so they must NOT move on a bare level-up.
  const offBefore = p.offense,
    maxHpBefore = p.maxHp;
  p.hp = 1; // hurt, so the level-up heal is observable
  alice.clear();
  host.awardXp(aliceId, 100); // well past the level-2 threshold (30)
  const after = host.players.get(aliceId);
  assert(after.level >= 2, `should have leveled up, got level ${after.level}`);
  assert(after.maxHp > maxHpBefore, 'maxHp should grow on level-up');
  assert.strictEqual(after.offense, offBefore, 'offense must NOT auto-grow (spend-only)');
  assert.strictEqual(after.hp, after.maxHp, 'a level-up fully heals');
  const ps = alice.last('player_stats');
  assert.strictEqual(ps.leveled, true);
  assert.strictEqual(ps.stats.level, after.level);
});

check('a level-up also broadcasts refreshed (full) HP', () => {
  const after = host.players.get(aliceId);
  const hpMsg = alice.last('player_hp'); // emitted by the prior level-up
  assert(hpMsg, 'no player_hp after level-up');
  assert.strictEqual(hpMsg.hp, after.maxHp);
});

check('an ANONYMOUS player banks skill points on level-up (drives the level-up button)', () => {
  // alice is an anonymous join; the prior test leveled her up several times.
  const pts = alice.last('points_update');
  assert(pts, 'no points_update sent to anon player on level-up');
  assert(pts.points > 0, `anon should bank points on level-up, got ${pts.points}`);
  assert(pts.alloc && typeof pts.alloc === 'object', 'points_update carries the alloc');
  assert(host.points.get(aliceId).unspentPoints > 0, 'points banked on the per-player record');
});

check('an anonymous player can spend banked points (server-authoritative)', () => {
  const before = host.points.get(aliceId).unspentPoints;
  assert(before > 0, 'precondition: has points to spend');
  const offBefore = host.players.get(aliceId).offense;
  alice.clear();
  alice.recv({ type: 'spend_points', add: { muscle: 1 } });
  assert.strictEqual(host.points.get(aliceId).unspentPoints, before - 1, 'one point spent');
  assert.strictEqual(host.points.get(aliceId).alloc.muscle, 4, 'alloc muscle incremented (3→4)');
  assert(host.players.get(aliceId).offense > offBefore, 'spending muscle raised offense');
  assert.strictEqual(alice.last('points_update').points, before - 1, 'echoed remaining points');
});

// ---- Stat capsules + Rock candy: bank a free skill point (spent via the
// reused level-up button → pentagon), so all capsules behave like Rock candy. ----
const VITAL_CAP = '116'; // override layer: skillPoint 1 (a free pentagon point)
const ROCK_CANDY = '101'; // override layer: skillPoint 1 (a free pentagon point)

check('use_item stat capsule → banks a free skill point (lights the button), consumed', () => {
  const p = host.players.get(aliceId);
  const prog = host.points.get(aliceId);
  if (!p.inventory.includes(VITAL_CAP)) p.inventory.push(VITAL_CAP);
  const ptsBefore = prog.unspentPoints || 0;
  alice.clear();
  alice.recv({ type: 'use_item', itemId: VITAL_CAP });
  assert.strictEqual(prog.unspentPoints, ptsBefore + 1, 'capsule banked one free point');
  assert.strictEqual(
    alice.last('points_update').points,
    ptsBefore + 1,
    'echoed new total (button lights)'
  );
  const inv = alice.last('inventory');
  assert(inv && !inv.items.some((i) => i.id === VITAL_CAP), 'capsule was consumed');
});

check('use_item Rock candy → banks one free skill point, consumed', () => {
  const p = host.players.get(aliceId);
  const prog = host.points.get(aliceId);
  if (!p.inventory.includes(ROCK_CANDY)) p.inventory.push(ROCK_CANDY);
  const ptsBefore = prog.unspentPoints || 0;
  alice.clear();
  alice.recv({ type: 'use_item', itemId: ROCK_CANDY });
  assert.strictEqual(prog.unspentPoints, ptsBefore + 1, 'one free point banked');
  assert.strictEqual(alice.last('points_update').points, ptsBefore + 1, 'echoed new total');
  const inv = alice.last('inventory');
  assert(inv && !inv.items.some((i) => i.id === ROCK_CANDY), 'rock candy consumed');
});

// ---- Condiment seasoning (canon auto-apply, no-waste) ----
const HAMBURGER = '90'; // base heal 48; preferred condiment = Ketchup (+16)
const KETCHUP = '118';
const SUGAR = '119'; // a MISMATCH for hamburger (would only give +2)

check('use_item food + carried preferred condiment → big bonus, condiment consumed', () => {
  const p = host.players.get(aliceId);
  if (!p.inventory.includes(HAMBURGER)) p.inventory.push(HAMBURGER);
  if (!p.inventory.includes(KETCHUP)) p.inventory.push(KETCHUP);
  p.maxHp = 500; // lift the cap so the full base+seasoning heal is observable
  p.hp = 1;
  const before = p.hp;
  alice.clear();
  alice.recv({ type: 'use_item', itemId: HAMBURGER });
  assert.strictEqual(p.hp - before, 48 + 16, `expected base+seasoning heal, got ${p.hp - before}`);
  const inv = alice.last('inventory');
  assert(inv && !inv.items.some((i) => i.id === HAMBURGER), 'hamburger consumed');
  assert(!p.inventory.includes(KETCHUP), 'ketchup consumed as seasoning');
});

check('use_item food + only a MISMATCHED condiment → no seasoning, condiment kept', () => {
  const p = host.players.get(aliceId);
  if (!p.inventory.includes(HAMBURGER)) p.inventory.push(HAMBURGER);
  if (!p.inventory.includes(SUGAR)) p.inventory.push(SUGAR);
  p.maxHp = 500;
  p.hp = 1;
  const before = p.hp;
  alice.clear();
  alice.recv({ type: 'use_item', itemId: HAMBURGER });
  assert.strictEqual(p.hp - before, 48, 'only the base hamburger heal, no seasoning');
  assert(p.inventory.includes(SUGAR), 'mismatched sugar must NOT be auto-spent');
});

// ===================== 4b. PK toggle =====================

check('set_pk on → flag set, lock armed, broadcast to everyone', () => {
  alice.clear();
  bob.clear();
  alice.recv({ type: 'set_pk', on: true });
  const p = host.players.get(aliceId);
  assert.strictEqual(p.pk, true, 'server pk flag set');
  assert(p.pkLockMs > 0, 'enable arms the in-game lock');
  const self = alice.last('player_pk');
  const other = bob.last('player_pk');
  assert(self && self.id === aliceId && self.pk === true, 'sender sees own pk');
  assert(other && other.id === aliceId && other.pk === true, 'others see the pk');
});

check('set_pk off while locked is REFUSED (and re-asserts pk:true)', () => {
  alice.clear();
  alice.recv({ type: 'set_pk', on: false });
  assert.strictEqual(host.players.get(aliceId).pk, true, 'cannot disable while locked');
  const re = alice.last('player_pk');
  assert(re && re.pk === true, 'server re-asserts the locked-on state to the owner');
});

check('PK lock counts down by IN-GAME time only', () => {
  const p = host.players.get(aliceId);
  const before = p.pkLockMs;
  p.pkTickAt = Date.now() - 10000; // pretend 10s of in-game time elapsed
  host._tickPkLock(p);
  assert(p.pkLockMs <= before - 9000, `lock should drop ~10s (${before} -> ${p.pkLockMs})`);
  assert(p.pkLockMs > 0, 'still locked after 10s of a 5-min lock');
});

check('set_pk off after the lock runs out → cleared', () => {
  const p = host.players.get(aliceId);
  p.pkLockMs = 0; // pretend the full 5 in-game minutes were served
  p.pkTickAt = Date.now();
  alice.recv({ type: 'set_pk', on: false });
  assert.strictEqual(host.players.get(aliceId).pk, false, 'pk clears once the lock runs out');
  assert.strictEqual(host.players.get(aliceId).pkLockMs, 0, 'lock reset');
});

// ===================== 4c. Status conditions =====================
// A landed hit can carry status inflicts (e.g. paralysis); the host applies them
// via the status engine, broadcasts the set + a status_applied (floating text /
// input-lock), ticks DoT, and clears everything on death.
const statusMod = require('./status');

check('a hit carrying a paralysis inflict applies it + broadcasts', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  p.warping = false;
  p.editor = false;
  p.statuses = {};
  alice.clear();
  // chance 100 always procs (Math.random()*100 < 100), so this is deterministic.
  host.damagePlayer(aliceId, 5, null, [{ type: statusMod.STATUS.PARALYSIS, chance: 100 }]);
  assert(
    statusMod.hasStatus(p, statusMod.STATUS.PARALYSIS, Date.now()),
    'paralysis should be active'
  );
  const sa = alice.last('status_applied');
  assert(
    sa && sa.status === statusMod.STATUS.PARALYSIS && sa.blocks === true,
    'status_applied sent'
  );
  const ps = alice.last('player_status');
  assert(ps && ps.statuses.includes(statusMod.STATUS.PARALYSIS), 'player_status set broadcast');
});

check('poison ticks HP down over time (DoT)', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  p.statuses = {};
  statusMod.applyStatus(p, statusMod.STATUS.POISON, Date.now());
  p.statuses[statusMod.STATUS.POISON].nextDotAt = Date.now() - 1; // first tick due now
  const before = p.hp;
  alice.clear();
  host._tickPlayerStatuses();
  assert(host.players.get(aliceId).hp < before, 'poison should tick HP down');
  assert(alice.ofType('player_hp').length > 0, 'a DoT tick broadcasts player_hp');
});

const shieldsMod = require('./shields');

check('a Power Shield soaks a physical hit (no HP loss) then breaks', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  p.warping = false;
  p.editor = false;
  p.dying = false;
  p.statuses = {};
  shieldsMod.clearShields(p);
  shieldsMod.applyShield(p, 'physical', 'block', 1); // one charge
  alice.clear();
  const before = p.hp;
  host.damagePlayer(aliceId, 40, null, null, null, { kind: 'physical' });
  assert.strictEqual(p.hp, before, 'a blocked hit costs no HP');
  assert(alice.last('shield_block'), 'broadcasts a shield_block');
  assert.strictEqual(shieldsMod.activeShields(p).length, 0, 'the charge was spent');
  // Shield gone — the next physical hit lands normally.
  host.damagePlayer(aliceId, 40, null, null, null, { kind: 'physical' });
  assert(p.hp < before, 'once the shield breaks, damage lands again');
});

check('a reflect shield bounces damage back at the attacking enemy', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  p.dying = false;
  p.statuses = {};
  shieldsMod.clearShields(p);
  shieldsMod.applyShield(p, 'physical', 'reflect', 1);
  let reflected = null;
  const orig = host.npcSim.hurtEnemyById;
  host.npcSim.hurtEnemyById = (id, dmg) => {
    reflected = { id, dmg };
    return true;
  };
  const before = p.hp;
  host.damagePlayer(aliceId, 25, null, null, 77, { kind: 'physical', attacker: { npc: 77 } });
  host.npcSim.hurtEnemyById = orig;
  assert.strictEqual(p.hp, before, 'the reflected hit still costs the victim no HP');
  assert(
    reflected && reflected.id === 77 && reflected.dmg === 25,
    'damage bounced to the attacker'
  );
});

check('DoT bleeds THROUGH a shield (poison carries no kind)', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  p.dying = false;
  p.statuses = {};
  shieldsMod.clearShields(p);
  shieldsMod.applyShield(p, 'physical', 'block', 3);
  const before = p.hp;
  host.damagePlayer(aliceId, 10, null, null); // DoT-style call: no kind
  assert(p.hp < before, 'unkinded (DoT) damage is not shielded');
  assert.strictEqual(shieldsMod.activeShields(p).length, 1, 'shield charge NOT spent by DoT');
});

check('diamondize blocks healing until cured (persist-until-cure, no failsafe)', () => {
  const p = host.players.get(aliceId);
  p.hp = 10;
  p.dying = false;
  p.downed = false;
  p.statuses = {};
  statusMod.applyStatus(p, statusMod.STATUS.DIAMOND, Date.now());
  // Permanent: it never auto-expires, even far in the future.
  assert(statusMod.hasStatus(p, statusMod.STATUS.DIAMOND, Date.now() + 1e9), 'diamond persists');
  assert.strictEqual(host.healPlayer(p, 50), 0, 'a heal is refused while diamondized');
  assert.strictEqual(p.hp, 10, 'HP unchanged by the blocked heal');
  // The cure (Healing PSI clears all statuses) lets healing work again.
  statusMod.clearAll(p);
  assert(host.healPlayer(p, 50) > 0, 'after the cure, healing works');
});

check('a lethal hit starts the mortal roll; the roll-out DOWNS the player (KO)', () => {
  // A lethal blow no longer KOs instantly — it begins the EB rolling-HP "Mortal
  // Damage" window (player stays UP and can heal to survive). Only when the roll
  // runs out (_mortalExpired) are they laid out into the downed/KO state.
  const p = host.players.get(aliceId);
  p.hp = 5;
  p.statuses = {};
  statusMod.applyStatus(p, statusMod.STATUS.PARALYSIS, Date.now());
  alice.clear();
  host.damagePlayer(aliceId, 9999); // lethal → mortal roll (not instant KO)
  assert.strictEqual(p.dying, true, 'a lethal hit starts the rolling-HP mortal window');
  assert(alice.last('player_mortal'), 'broadcasts player_mortal (the roll)');
  host._mortalExpired(aliceId, p); // roll ran out with no heal → lay them out
  assert.strictEqual(p.downed, true, 'roll expiry enters the downed/KO state');
  assert.strictEqual(Object.keys(p.statuses).length, 0, 'KO wipes statuses');
  const ps = alice.last('player_status');
  assert(ps && ps.statuses.length === 0, 'empty status set broadcast on KO');
  assert(alice.last('player_downed'), 'broadcasts player_downed');
  // Restore Alice to a clean ALIVE state for the PSI tests below.
  p.downed = false;
  p.downedUntil = 0;
  p.dying = false;
  p.dyingUntil = 0;
  p.hp = p.maxHp;
});

// ===================== 4d. PSI casting =====================
// use_psi is server-authoritative: it checks PP, applies the effect (heal the
// caster / strike the nearest enemy), and broadcasts psi_cast (the animation) to
// EVERYONE incl. the caster, with the PsiAnim id + caster/target positions.

// Give Alice a caster's PP pool so the Mental unlock gate clears these moves —
// this block exercises PP/cast/effects, not the gate (see the gate test below).
// ppMax = 2 + 2*Mental, so 100 ≈ Mental 49 → everything but Rockin' Ω is learned.
host.players.get(aliceId).ppMax = 100;

check('use_psi (heal) spends PP and broadcasts psi_cast at the caster', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  p.pp = 7;
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'lifeup_alpha' });
  assert.strictEqual(host.players.get(aliceId).pp, 7 - 5, 'Lifeup α costs 5 PP (canon)');
  const cast = alice.last('psi_cast');
  assert(cast && cast.id === 'lifeup_alpha', 'broadcasts the PsiAnim id to the caster too');
  assert.strictEqual(cast.tx, cast.x, 'self/heal PSI targets the caster spot');
  assert.strictEqual(cast.ty, cast.y);
});

check(
  'use_psi (Fire cone) spends PP and does NOT broadcast a psi_cast (projectiles carry it)',
  () => {
    const p = host.players.get(aliceId);
    p.pp = 9;
    alice.clear();
    alice.recv({ type: 'use_psi', psiId: 'psi_fire_alpha' });
    assert.strictEqual(host.players.get(aliceId).pp, 9 - 6, 'PSI Fire α costs 6 PP (canon)');
    // The directional cone now travels as server projectiles (damage syncs to the
    // visual + each pellet dissolves at a wall), so it no longer broadcasts a psi_cast
    // flipbook fan — the projectiles ARE the visual. (Projectile spawn + damage is
    // covered in combat.test, where the sim's broadcast/roster are wired.)
    assert.strictEqual(
      alice.ofType('psi_cast').length,
      0,
      'no psi_cast — projectiles are the visual'
    );
  }
);

check('use_psi is refused without enough PP (no cast)', () => {
  const p = host.players.get(aliceId);
  p.pp = 1; // below Lifeup α (5) and PSI Fire α (6)
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'psi_fire_alpha' });
  assert.strictEqual(host.players.get(aliceId).pp, 1, 'PP untouched when too low');
  assert.strictEqual(alice.ofType('psi_cast').length, 0, 'no cast broadcast');
});

check('use_psi is blocked while "can\'t concentrate" (noPsi), even with PP', () => {
  const p = host.players.get(aliceId);
  p.pp = 9;
  p.statuses = {};
  statusMod.applyStatus(p, statusMod.STATUS.NO_PSI, Date.now());
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'lifeup_alpha' });
  assert.strictEqual(host.players.get(aliceId).pp, 9, 'PP untouched while noPsi');
  assert.strictEqual(alice.ofType('psi_cast').length, 0, 'no cast while noPsi');
  p.statuses = {};
});

check('use_psi enforces the Mental unlock gate; dev role bypasses it', () => {
  const p = host.players.get(aliceId);
  p.statuses = {};
  p.ppMax = 22; // Mental ~10 → Rockin' Ω (unlockMental 50) NOT learned
  p.pp = 99; // plenty of PP — so only the unlock gate can refuse
  p.role = 'player';
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'psi_omega' });
  assert.strictEqual(alice.ofType('psi_cast').length, 0, 'locked move is refused (no cast)');
  assert.strictEqual(host.players.get(aliceId).pp, 99, 'no PP spent on a locked move');
  // Dev/admin bypass the gate entirely — they can test every move.
  p.role = 'dev';
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'psi_omega' });
  assert(alice.last('psi_cast'), 'dev role casts the locked move (bypass)');
  // restore for later tests
  p.role = 'player';
  p.ppMax = 100;
  p.pp = 99;
});

check("Healing PSI clears the caster's status conditions", () => {
  const p = host.players.get(aliceId);
  p.pp = 9;
  p.statuses = {};
  statusMod.applyStatus(p, statusMod.STATUS.PARALYSIS, Date.now());
  statusMod.applyStatus(p, statusMod.STATUS.POISON, Date.now());
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'healing_alpha' });
  assert.strictEqual(
    Object.keys(host.players.get(aliceId).statuses).length,
    0,
    'healing wiped all statuses'
  );
  const ps = alice.last('player_status');
  assert(ps && ps.statuses.length === 0, 'broadcasts the cleared (empty) set');
});

// ===================== 4e. Downed / revive =====================

check('a revive ITEM stands a downed ally back up (in range) + is consumed', () => {
  const a = host.players.get(aliceId);
  const b = host.players.get(bobId);
  a.hp = a.maxHp;
  a.x = b.x = 100;
  a.y = b.y = 100; // co-located → within REVIVE_RANGE
  host.damagePlayer(bobId, 9999); // lethal → mortal roll
  host._mortalExpired(bobId, b); // roll out → downed (the revive target state)
  assert.strictEqual(b.downed, true, 'Bob is downed');
  // Find a revive item id from the catalog (Horn of life = 130) and give it to Alice.
  const reviveId = Object.keys(host.GOODS).find((id) => (host.GOODS[id].revive | 0) > 0);
  assert(reviveId, 'a revive item exists in the catalog');
  a.inventory.push(reviveId);
  alice.clear();
  alice.recv({ type: 'use_item', itemId: reviveId, targetId: bobId });
  assert.strictEqual(host.players.get(bobId).downed, false, 'Bob revived (no longer downed)');
  assert(host.players.get(bobId).hp > 0, 'Bob has HP after revive');
  assert(!a.inventory.includes(reviveId), 'the revive item was consumed');
});

check('a revive item is REFUSED (not consumed) when no downed ally is in range', () => {
  const a = host.players.get(aliceId);
  const b = host.players.get(bobId);
  a.hp = a.maxHp;
  b.downed = false;
  b.dying = false;
  b.dyingUntil = 0;
  b.hp = b.maxHp; // nobody downed (and not mid-roll)
  const reviveId = Object.keys(host.GOODS).find((id) => (host.GOODS[id].revive | 0) > 0);
  a.inventory.push(reviveId);
  alice.clear();
  alice.recv({ type: 'use_item', itemId: reviveId, targetId: bobId });
  assert(a.inventory.includes(reviveId), 'item NOT consumed when target invalid');
  assert(alice.last('notice'), 'player is told why');
});

check('revive PSI (Healing Ω) revives a downed ally to full HP', () => {
  const a = host.players.get(aliceId);
  const b = host.players.get(bobId);
  a.hp = a.maxHp;
  a.pp = 99;
  a.x = b.x = 100;
  a.y = b.y = 100;
  host.damagePlayer(bobId, 9999); // Bob → downed
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'healing_omega', targetId: bobId });
  const after = host.players.get(bobId);
  assert.strictEqual(after.downed, false, 'Bob revived by Healing Ω');
  assert.strictEqual(after.hp, after.maxHp, 'Ω revives to full HP');
});

// ============================ 5. Leave ============================

alice.clear();
bob.close();

check('close → remaining players get player_leave', () => {
  const pl = alice.last('player_leave');
  assert(pl, 'Alice got no player_leave');
});

// ===================== 6. Idle-disconnect sweep =====================
// _reapIdle closes connections that went silent (dead/zombie sockets); a live
// client (lastSeen fresh) is left alone. Closing runs the close handler, which
// removes the player from the roster.

check('_reapIdle reaps a silent connection but keeps a live one', () => {
  const zombie = new FakeSocket();
  host.handleConnection(zombie);
  zombie.recv({ type: 'join', name: 'Zombie', spriteGroupId: 1 });
  const zid = zombie.last('welcome').playerId;

  const live = new FakeSocket();
  host.handleConnection(live);
  live.recv({ type: 'join', name: 'Live', spriteGroupId: 1 });
  const lid = live.last('welcome').playerId;

  host.players.get(zid).lastSeen = Date.now() - 60000; // silent a minute ago
  host.players.get(lid).lastSeen = Date.now(); // active now
  host._reapIdle();

  assert(!host.players.has(zid), 'silent zombie should be reaped');
  assert(host.players.has(lid), 'live player must survive the sweep');
  live.close();
});

// ============================ 4. Gifts (present boxes) ============================

const GIFT_FLAG_BASE = 910000;

check('open_gift grants the item once, sets the flag, and acks gift_opened', () => {
  let found = null;
  for (const [k, g] of host.GIFTS) {
    if (g.item != null && host.GOODS[String(g.item)]) {
      found = [k, g];
      break;
    }
  }
  assert(found, 'no resolvable gift in the catalog');
  const [k, g] = found;
  const flagId = GIFT_FLAG_BASE + g.romFlag;

  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', name: 'Gifter', spriteGroupId: 1 });
  const id = s.last('welcome').playerId;
  const before = host.players.get(id).inventory.length;
  s.clear();

  s.recv({ type: 'open_gift', k });
  const inv = host.players.get(id).inventory;
  assert.strictEqual(inv.length, before + 1, 'item not granted');
  assert.strictEqual(inv[inv.length - 1], String(g.item), 'wrong item granted');
  assert(host.flags.get(id).has(flagId), 'one-time flag not set');
  assert.strictEqual(s.last('gift_opened') && s.last('gift_opened').k, k, 'no gift_opened ack');
  assert(s.last('loot'), 'no loot toast');
  s.close();
});

check('a second open of the same gift is refused (no item, no ack)', () => {
  let found = null;
  for (const [k, g] of host.GIFTS) {
    if (g.item != null && host.GOODS[String(g.item)]) {
      found = [k, g];
      break;
    }
  }
  const [k] = found;
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', name: 'Twice', spriteGroupId: 1 });
  const id = s.last('welcome').playerId;
  s.recv({ type: 'open_gift', k }); // first open
  const after = host.players.get(id).inventory.length;
  s.clear();
  s.recv({ type: 'open_gift', k }); // re-open
  assert.strictEqual(host.players.get(id).inventory.length, after, 're-open granted again');
  assert(!s.last('gift_opened'), 're-open should not ack');
  s.close();
});

check('open_gift on an unknown key is ignored', () => {
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', name: 'NoGift', spriteGroupId: 1 });
  s.clear();
  s.recv({ type: 'open_gift', k: 'definitely:not:a:gift' });
  assert(!s.last('gift_opened'), 'unknown gift should not ack');
  s.close();
});

check('an empty (unresolved) container shows flavor text, grants nothing, stays checkable', () => {
  let found = null;
  for (const [k, g] of host.GIFTS) {
    if (g.item == null) {
      found = [k, g];
      break;
    }
  }
  if (!found) return; // catalog has no specials — nothing to assert
  const [k, g] = found;
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', name: 'Special', spriteGroupId: 1 });
  const id = s.last('welcome').playerId;
  const before = host.players.get(id).inventory.length;
  s.clear();
  s.recv({ type: 'open_gift', k });
  // No grant, no permanent open: an empty container just reports its canon
  // flavor line and stays checkable (flag NOT consumed, no gift_opened ack).
  assert.strictEqual(host.players.get(id).inventory.length, before, 'empty granted an item');
  assert(!host.flags.get(id).has(GIFT_FLAG_BASE + g.romFlag), 'empty consumed the one-time flag');
  assert(!s.last('gift_opened'), 'empty container should not ack gift_opened');
  assert(s.last('notice') && s.last('notice').text, 'no flavor notice for empty container');
  s.close();
});

// ============== 6. Reconnect: same character evicts its prior session ==========
// A reconnecting client gets a fresh playerId, so without dedup the old session
// lingers up to IDLE_TIMEOUT_MS — a flaky/AFK tab that drops + rejoins piles up
// frozen zombie copies of the same character. Join must evict the prior session.
// The signed-in path is async (awaits the store), so run it via an async check.
async function asyncCheck(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    fail++;
  }
}

(async () => {
  await asyncCheck(
    'a same-character rejoin evicts the prior session (no zombie pile)',
    async () => {
      const h = new GameHost(ASSETS);
      // Minimal store stub so the signed-in join path resolves a fixed characterId.
      h.store = {
        getSession: async () => ({ accountId: 1 }),
        getCharacter: async (id) => ({ id: Number(id), accountId: 1, save: {} }),
        updateCharacterSave: async () => {},
      };
      const liveFor = (cid) => [...h.saves.values()].filter((s) => s.characterId === cid).length;
      const ids = [];
      for (let i = 0; i < 4; i++) {
        const s = new FakeSocket();
        h.handleConnection(s);
        // Drive the async join directly (the message handler returns the promise);
        // never cleanly close → simulate a flaky tab whose old socket lingers.
        await s.handlers.message(
          JSON.stringify({ type: 'join', sessionToken: 't', characterId: 7 })
        );
        ids.push(s.last('welcome').playerId);
      }
      assert.strictEqual(liveFor(7), 1, 'only the newest session of a character stays live');
      for (const old of ids.slice(0, -1)) {
        assert(!h.players.has(old), `superseded session ${old} should be evicted`);
      }
      assert(h.players.has(ids[ids.length - 1]), 'the latest session is the live one');
      h.stop();
    }
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
