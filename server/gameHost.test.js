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
const bobId = bob.last('welcome').playerId;

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

check('a lethal hit DOWNS the player (KO), clearing statuses + broadcasting downed', () => {
  const p = host.players.get(aliceId);
  p.hp = 5;
  p.statuses = {};
  statusMod.applyStatus(p, statusMod.STATUS.PARALYSIS, Date.now());
  alice.clear();
  host.damagePlayer(aliceId, 9999); // lethal → downed (not instant respawn)
  const after = host.players.get(aliceId);
  assert.strictEqual(after.downed, true, 'lethal hit enters the downed/KO state');
  assert.strictEqual(Object.keys(after.statuses).length, 0, 'KO wipes statuses');
  const ps = alice.last('player_status');
  assert(ps && ps.statuses.length === 0, 'empty status set broadcast on KO');
  assert(alice.last('player_downed'), 'broadcasts player_downed');
  // Restore Alice to a clean ALIVE state for the PSI tests below.
  after.downed = false;
  after.downedUntil = 0;
  after.hp = after.maxHp;
});

// ===================== 4d. PSI casting =====================
// use_psi is server-authoritative: it checks PP, applies the effect (heal the
// caster / strike the nearest enemy), and broadcasts psi_cast (the animation) to
// EVERYONE incl. the caster, with the PsiAnim id + caster/target positions.

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

check('use_psi (offense) spends PP and broadcasts a projectile psi_cast', () => {
  const p = host.players.get(aliceId);
  p.pp = 9;
  alice.clear();
  alice.recv({ type: 'use_psi', psiId: 'psi_fire_alpha' });
  assert.strictEqual(host.players.get(aliceId).pp, 9 - 6, 'PSI Fire α costs 6 PP (canon)');
  const cast = alice.last('psi_cast');
  assert(cast && cast.id === 'psi_fire_alpha', 'fire broadcasts its anim id');
  assert(typeof cast.tx === 'number' && typeof cast.ty === 'number', 'carries a projectile target');
});

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
  host.damagePlayer(bobId, 9999); // Bob → downed
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
  b.hp = b.maxHp; // nobody downed
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
