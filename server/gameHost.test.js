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
// Move relative to Alice's actual spawn: a small step the validation accepts (a
// huge teleport from spawn would be clamped as a speed hack — covered below).
const aSpawn = host.players.get(aliceId);
const moveX = Math.round(aSpawn.x + 10);
const moveY = Math.round(aSpawn.y + 10);
alice.recv({ type: 'move', x: moveX, y: moveY, direction: 2, frame: 1, pose: 'walk' });

check('move → others get player_move with the coords', () => {
  const m = bob.last('player_move');
  assert(m, 'Bob got no player_move');
  assert.strictEqual(m.x, moveX);
  assert.strictEqual(m.y, moveY);
});

// --- Server-side move validation (anti-cheat) ---
check('move validation: a teleport (huge non-warp jump) is clamped, not trusted', () => {
  alice.clear();
  const before = host.players.get(aliceId);
  const fromX = before.x;
  const fromY = before.y;
  alice.recv({ type: 'move', x: fromX + 5000, y: fromY, direction: 3, frame: 0, pose: 'walk' });
  const m = bob.last('player_move'); // bob is still in range; reuse him
  const moved = Math.hypot(m.x - fromX, m.y - fromY);
  assert(moved <= 96 + 0.5, `clamped step should be <= 96px, was ${moved}`);
  assert.strictEqual(host.players.get(aliceId).x, m.x, 'server position matches the clamp');
});

check('move validation: garbage coords are dropped', () => {
  const before = { ...host.players.get(aliceId) };
  alice.recv({ type: 'move', x: 'NaN', y: null, direction: 0, frame: 0, pose: 'walk' });
  assert.strictEqual(host.players.get(aliceId).x, before.x, 'x unchanged');
  assert.strictEqual(host.players.get(aliceId).y, before.y, 'y unchanged');
});

check('move validation: a door warp is exempt from the speed cap', () => {
  const p = host.players.get(aliceId);
  const fromX = p.x;
  alice.recv({ type: 'warp', warping: true });
  alice.recv({ type: 'move', x: fromX + 5000, y: p.y, direction: 3, frame: 0, pose: 'walk' });
  // Warp shield lets the big jump through (clamped only to the map bounds).
  assert(host.players.get(aliceId).x > fromX + 96, 'warp jump should not be speed-clamped');
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

const BAT = '17'; // weapon, dev-granted on join
const COOKIE = '88'; // consumable, dev-granted on join

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
    if (g && g.cost > 0 && g.cost <= 1000) {
      buyStore = Number(sid);
      buyItem = String(it);
      break;
    }
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
  assert(
    alice.last('inventory').items.some((i) => i.id === buyItem),
    'bought item missing'
  );
});

check('sell owned item → money credited half the catalog cost', () => {
  const cost = shop.goods[buyItem].cost;
  const before = host.players.get(aliceId).money;
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
  alice.clear();
  alice.recv({ type: 'buy', store: buyStore, item: buyItem });
  assert.strictEqual(p.money, 0, 'money should be untouched');
  assert.strictEqual(p.inventory.length, invLen, 'inventory should be untouched');
});

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

check('a move clears the shield even without a warp:false', () => {
  const p = host.players.get(aliceId);
  p.hp = p.maxHp;
  alice.recv({ type: 'warp', warping: true });
  alice.recv({ type: 'move', x: 50, y: 60, direction: 0, frame: 0, pose: 'walk' });
  host.damagePlayer(aliceId, 20);
  assert(host.players.get(aliceId).hp < p.maxHp, 'move should have dropped the shield');
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
// (geometric curve), grow stats, heal on level-up, and push a player_stats
// payload. Driven directly — no enemy kill needed.

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

check('crossing the EXP threshold levels up, grows stats, and full-heals', () => {
  const p = host.players.get(aliceId);
  const offBefore = p.offense,
    maxHpBefore = p.maxHp;
  p.hp = 1; // hurt, so the level-up heal is observable
  alice.clear();
  host.awardXp(aliceId, 100); // well past the level-2 threshold (30)
  const after = host.players.get(aliceId);
  assert(after.level >= 2, `should have leveled up, got level ${after.level}`);
  assert(after.offense > offBefore, 'offense should grow on level-up');
  assert(after.maxHp > maxHpBefore, 'maxHp should grow on level-up');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
