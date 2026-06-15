/**
 * Tests for the persistence Store (server/store/) — accounts, sessions, and
 * character saves. Runs against an in-memory SQLite db so it leaves no files and
 * needs no cleanup. Dependency-free harness, same style as gameHost.test.js.
 * Run with `npm test` (or `node server/store.test.js`).
 */
const assert = require('assert');
const { createStore, DuplicateUsernameError, SlotsFullError, MAX_CHARACTERS } = require('./store');

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
const T = 1_000_000; // a fixed "now" baseline so tests are deterministic

// ============================ Accounts ============================

let alice;
check('createAccount returns the new account', () => {
  alice = store.createAccount({ username: 'Alice', passwordHash: 'hash-a', now: T });
  assert.strictEqual(alice.username, 'Alice');
  assert(alice.id > 0, 'should get a numeric id');
});

check('getAccountByUsername is case-insensitive and returns the hash', () => {
  const got = store.getAccountByUsername('ALICE');
  assert.strictEqual(got.id, alice.id);
  assert.strictEqual(got.passwordHash, 'hash-a');
});

check('duplicate username (different case) throws DuplicateUsernameError', () => {
  assert.throws(
    () => store.createAccount({ username: 'alice', passwordHash: 'x', now: T }),
    DuplicateUsernameError
  );
});

check('getAccountByUsername returns null for unknown name', () => {
  assert.strictEqual(store.getAccountByUsername('nobody'), null);
});

// ============================ Sessions ============================

check('createSession then getSession round-trips', () => {
  store.createSession({ token: 'tok1', accountId: alice.id, now: T, ttlMs: 1000 });
  const s = store.getSession('tok1', T + 500);
  assert(s, 'session should be live mid-ttl');
  assert.strictEqual(s.accountId, alice.id);
});

check('getSession returns null once expired (and GCs it)', () => {
  assert.strictEqual(store.getSession('tok1', T + 2000), null);
  // second hit confirms it was removed, not just filtered
  assert.strictEqual(store.getSession('tok1', T + 500), null);
});

check('deleteSession (logout) removes a live session', () => {
  store.createSession({ token: 'tok2', accountId: alice.id, now: T, ttlMs: 1000 });
  store.deleteSession('tok2');
  assert.strictEqual(store.getSession('tok2', T + 100), null);
});

check('deleteExpiredSessions sweeps only expired rows', () => {
  store.createSession({ token: 'live', accountId: alice.id, now: T, ttlMs: 10000 });
  store.createSession({ token: 'dead', accountId: alice.id, now: T, ttlMs: 100 });
  const removed = store.deleteExpiredSessions(T + 1000);
  assert.strictEqual(removed, 1, 'only the dead one');
  assert(store.getSession('live', T + 1000), 'live session survives');
});

// =========================== Characters ===========================

check('createCharacter auto-assigns slot 0, persists save JSON', () => {
  const c = store.createCharacter({
    accountId: alice.id,
    name: 'Ness',
    spriteGroupId: 1,
    save: { level: 1, money: 1000 },
    now: T,
  });
  assert.strictEqual(c.slot, 0);
  assert.strictEqual(c.save.money, 1000);
});

check('slots fill 0,1,2 in order', () => {
  const c1 = store.createCharacter({
    accountId: alice.id,
    name: 'Paula',
    spriteGroupId: 2,
    save: {},
    now: T,
  });
  const c2 = store.createCharacter({
    accountId: alice.id,
    name: 'Jeff',
    spriteGroupId: 3,
    save: {},
    now: T,
  });
  assert.strictEqual(c1.slot, 1);
  assert.strictEqual(c2.slot, 2);
});

check(`a 4th character throws SlotsFullError (cap ${MAX_CHARACTERS})`, () => {
  assert.throws(
    () =>
      store.createCharacter({
        accountId: alice.id,
        name: 'Poo',
        spriteGroupId: 4,
        save: {},
        now: T,
      }),
    SlotsFullError
  );
});

check('listCharacters returns all 3 in slot order', () => {
  const list = store.listCharacters(alice.id);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(
    list.map((c) => c.slot),
    [0, 1, 2]
  );
});

check('updateCharacterSave persists new state and bumps updated_at', () => {
  const list = store.listCharacters(alice.id);
  const updated = store.updateCharacterSave(list[0].id, { level: 5, money: 250 }, T + 100);
  assert.strictEqual(updated.save.level, 5);
  assert.strictEqual(updated.updatedAt, T + 100);
});

check('deleteCharacter frees its slot for reuse', () => {
  const list = store.listCharacters(alice.id);
  const slot1 = list.find((c) => c.slot === 1);
  store.deleteCharacter(slot1.id);
  assert.strictEqual(store.listCharacters(alice.id).length, 2);
  // creating again should backfill the freed slot 1, not jump to a new number
  const fresh = store.createCharacter({
    accountId: alice.id,
    name: 'Poo',
    spriteGroupId: 4,
    save: {},
    now: T,
  });
  assert.strictEqual(fresh.slot, 1);
});

check("one account's characters are isolated from another's", () => {
  const bob = store.createAccount({ username: 'Bob', passwordHash: 'hash-b', now: T });
  assert.strictEqual(store.listCharacters(bob.id).length, 0);
  store.createCharacter({ accountId: bob.id, name: 'BobChar', spriteGroupId: 9, save: {}, now: T });
  assert.strictEqual(store.listCharacters(bob.id).length, 1);
  assert.strictEqual(store.listCharacters(alice.id).length, 3, "Alice's roster unchanged");
});

store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
