/**
 * Integration test for signed-in character persistence (GameHost + Store).
 * Drives the host with a fake socket and a real in-memory store: a created
 * character joins by session token, earns a level, disconnects (save-back), and
 * rejoins — proving its progress survives. Also covers the auth failure paths.
 *
 * Loads real public/assets but does NOT call host.start() (no sim tick); npcSim
 * installs file watchers on construction, so we process.exit() at the end.
 * Run with `npm test` (or `node server/persistence.test.js`).
 */
const assert = require('assert');
const path = require('path');
const { GameHost } = require('./gameHost');
const { createStore } = require('./store');
const { deriveCombatStats } = require('./charStats');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');

class FakeSocket {
  constructor() {
    this.sent = [];
    this.handlers = {};
    this.readyState = 1;
  }
  send(str) {
    this.sent.push(JSON.parse(str));
  }
  on(ev, cb) {
    this.handlers[ev] = cb;
  }
  recv(obj) {
    this.handlers.message(JSON.stringify(obj));
  }
  close() {
    if (this.handlers.close) this.handlers.close();
  }
  last(type) {
    return [...this.sent].reverse().find((m) => m.type === type);
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

const store = createStore({ filename: ':memory:' });
const host = new GameHost(ASSETS, store);

const T = 5_000_000;
const ALLOC = { muscle: 3, mental: 2, spirit: 3, speed: 3, knowledge: 4 };

// Sessions expire against the host's real Date.now(), so seed them with real
// time + a long TTL (account/character createdAt can stay on the fake clock).
const YEAR = 365 * 24 * 60 * 60 * 1000;
const NOW = Date.now();

// Seed an account + session + one character directly through the store.
const account = store.createAccount({ username: 'Hero', passwordHash: 'h', now: T });
store.createSession({ token: 'sess-ok', accountId: account.id, now: NOW, ttlMs: YEAR });
const character = store.createCharacter({
  accountId: account.id,
  name: 'Ness',
  spriteGroupId: 1,
  save: { alloc: ALLOC, level: 1, exp: 0 },
  now: T,
});

// A second account, to prove cross-account character access is refused.
const other = store.createAccount({ username: 'Rando', passwordHash: 'h', now: T });
store.createSession({ token: 'sess-other', accountId: other.id, now: NOW, ttlMs: YEAR });

// ---- join by token loads the derived build ----

const s1 = new FakeSocket();
host.handleConnection(s1);
s1.recv({ type: 'join', sessionToken: 'sess-ok', characterId: character.id });
const pid = s1.last('welcome').playerId;

check('join-by-token sends a welcome with self + stats', () => {
  const w = s1.last('welcome');
  assert(w.self && Number.isFinite(w.self.x), 'welcome.self spawn missing');
  assert(w.stats && w.stats.level === 1, 'welcome.stats missing');
});

check('combat stats are derived from the saved allocation', () => {
  const p = host.players.get(pid);
  const d = deriveCombatStats(ALLOC);
  assert.strictEqual(p.maxHp, d.maxHp, `maxHp ${p.maxHp} != derived ${d.maxHp}`);
  assert.strictEqual(p.offense, d.offense, 'offense should match the derived value');
});

// ---- earn a level, disconnect, and verify the save ----

check('earning EXP then disconnecting persists level + exp + banked points', () => {
  host.awardXp(pid, 1000); // well past level 2
  const player = host.players.get(pid);
  const leveled = player.level;
  assert(leveled >= 2, `expected a level-up, got ${leveled}`);
  // Server granted 1 skill point per level gained, pushed privately to the owner.
  const pu = s1.last('points_update');
  assert(
    pu && pu.points === leveled - 1,
    `expected ${leveled - 1} banked points, got ${pu && pu.points}`
  );
  s1.close(); // triggers save-back
  const saved = store.getCharacter(character.id).save;
  assert.strictEqual(saved.level, leveled, 'saved level should match');
  assert.strictEqual(saved.exp, 1000, 'saved exp should match');
  assert.strictEqual(saved.unspentPoints, leveled - 1, 'banked points persist');
  assert.deepStrictEqual(saved.alloc, ALLOC, 'alloc preserved across save');
});

// ---- spending points is SERVER-AUTHORITATIVE (no client-side cheating) ----

check('spend_points rejects cheats and applies a valid spend; persists', () => {
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', sessionToken: 'sess-ok', characterId: character.id });
  const id = s.last('welcome').playerId;
  const banked = s.last('points_update').points; // restored from the save
  assert(banked >= 1, `expected banked points on rejoin, got ${banked}`);
  const muscle0 = host.saves.get(id).alloc.muscle;
  const maxHp0 = host.players.get(id).maxHp;

  // CHEAT: spend more than banked -> rejected wholesale.
  s.recv({ type: 'spend_points', add: { muscle: banked + 5 } });
  assert.strictEqual(host.saves.get(id).unspentPoints, banked, 'over-spend must not debit');
  assert.strictEqual(host.saves.get(id).alloc.muscle, muscle0, 'over-spend must not change alloc');

  // CHEAT: unknown stat -> rejected.
  s.recv({ type: 'spend_points', add: { strength: 1 } });
  assert.strictEqual(host.saves.get(id).unspentPoints, banked, 'unknown stat must not debit');

  // CHEAT: fractional/negative -> rejected.
  s.recv({ type: 'spend_points', add: { muscle: -2 } });
  s.recv({ type: 'spend_points', add: { muscle: 1.5 } });
  assert.strictEqual(host.saves.get(id).unspentPoints, banked, 'bad amounts must not debit');

  // VALID: spend exactly 1 into Muscle.
  s.recv({ type: 'spend_points', add: { muscle: 1 } });
  assert.strictEqual(host.saves.get(id).alloc.muscle, muscle0 + 1, 'valid spend bumps the alloc');
  assert.strictEqual(
    host.saves.get(id).unspentPoints,
    banked - 1,
    'valid spend debits exactly one'
  );
  assert(host.players.get(id).maxHp > maxHp0, 'more Muscle -> re-derived more maxHp');

  s.close();
  const saved = store.getCharacter(character.id).save;
  assert.strictEqual(saved.unspentPoints, banked - 1, 'spent point persists');
  assert.strictEqual(saved.alloc.muscle, muscle0 + 1, 'bumped alloc persists');
});

// ---- player flags persist in the save and restore on rejoin ----

check('setting flags persists them; rejoin restores via welcome.flags', () => {
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', sessionToken: 'sess-ok', characterId: character.id });
  const id = s.last('welcome').playerId;

  s.recv({ type: 'set_flag', id: 900001 });
  s.recv({ type: 'set_flag', id: 900002 });
  s.recv({ type: 'set_flag', id: 900001 }); // duplicate — no-op
  s.recv({ type: 'clear_flag', id: 900002 }); // toggled back off
  assert.deepStrictEqual([...host.flags.get(id)], [900001], 'live set should hold only 900001');

  s.close(); // save-back
  const saved = store.getCharacter(character.id).save;
  assert.deepStrictEqual(saved.flags, [900001], 'flags persist to the save');

  const s2 = new FakeSocket();
  host.handleConnection(s2);
  s2.recv({ type: 'join', sessionToken: 'sess-ok', characterId: character.id });
  assert.deepStrictEqual(s2.last('welcome').flags, [900001], 'welcome restores saved flags');

  s2.recv({ type: 'clear_all_flags' });
  assert.strictEqual(host.flags.get(s2.last('welcome').playerId).size, 0, 'reset wipes flags');
  s2.close();
  assert.deepStrictEqual(store.getCharacter(character.id).save.flags, [], 'reset persists empty');
});

// ---- rejoin restores the saved progress ----

check('rejoining restores the saved level', () => {
  const s2 = new FakeSocket();
  host.handleConnection(s2);
  s2.recv({ type: 'join', sessionToken: 'sess-ok', characterId: character.id });
  const w = s2.last('welcome');
  assert(w.stats.level >= 2, `rejoined at level ${w.stats.level}, expected >= 2`);
  s2.close();
});

// ---- auth failure paths ----

check('a bad session token is rejected with join_error', () => {
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', sessionToken: 'nope', characterId: character.id });
  assert(s.last('join_error'), 'expected join_error');
  assert(!s.last('welcome'), 'must not welcome an invalid session');
});

check("another account can't load a character it doesn't own", () => {
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', sessionToken: 'sess-other', characterId: character.id });
  assert(s.last('join_error'), 'expected join_error for non-owned character');
});

check('anonymous join (no token) still works for the dev/char-select path', () => {
  const s = new FakeSocket();
  host.handleConnection(s);
  s.recv({ type: 'join', name: 'Guest', spriteGroupId: 2 });
  const w = s.last('welcome');
  assert(w && w.playerId, 'anonymous welcome missing');
  assert.strictEqual(host.players.get(w.playerId).name, 'Guest');
  assert.deepStrictEqual(w.flags, [], 'anonymous join starts with no flags');
  s.close();
});

store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
