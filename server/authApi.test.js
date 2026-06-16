/**
 * Tests for the auth/character HTTP API (server/authApi.js). Spins the Express
 * app on an ephemeral port against an in-memory store and drives it with fetch
 * — a real end-to-end pass over routing, validation, hashing, and sessions.
 * Dependency-free harness, same style as store.test.js.
 * Run with `npm test` (or `node server/authApi.test.js`).
 */
/* global fetch */
const assert = require('assert');
const http = require('http');
const { createStore } = require('./store');
const { createAuthApi } = require('./authApi');

async function main() {
  const store = createStore({ filename: ':memory:' });
  const api = createAuthApi(store);
  const server = http.createServer(api);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let pass = 0;
  let fail = 0;
  async function check(name, fn) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
      pass++;
    } catch (e) {
      console.error(`  FAIL ${name}\n       ${e.message}`);
      fail++;
    }
  }

  const req = (method, path, { body, token } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const post = (path, body, token) => req('POST', path, { body, token });
  const get = (path, token) => req('GET', path, { token });
  const del = (path, token) => req('DELETE', path, { token });

  // ----------------------------- register ------------------------------

  let token;
  await check('register creates an account + returns a session token', async () => {
    const r = await post('/api/register', { username: 'Alice', password: 'hunter2' });
    assert.strictEqual(r.status, 201);
    const j = await r.json();
    assert.match(j.token, /^[0-9a-f]{64}$/);
    assert.strictEqual(j.account.username, 'Alice');
    assert.strictEqual(j.account.passwordHash, undefined, 'hash must never be returned');
    token = j.token;
  });

  await check('register rejects a short password (400)', async () => {
    const r = await post('/api/register', { username: 'Bobby', password: '123' });
    assert.strictEqual(r.status, 400);
  });

  await check('register rejects a bad username (400)', async () => {
    const r = await post('/api/register', { username: 'a b!', password: 'hunter2' });
    assert.strictEqual(r.status, 400);
  });

  await check('duplicate username (any case) is 409', async () => {
    const r = await post('/api/register', { username: 'alice', password: 'hunter2' });
    assert.strictEqual(r.status, 409);
  });

  // ------------------------------- login -------------------------------

  await check('login with the right password returns a fresh token', async () => {
    const r = await post('/api/login', { username: 'alice', password: 'hunter2' });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.match(j.token, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(j.token, token, 'login mints a new session');
  });

  await check('login with a wrong password is 401', async () => {
    const r = await post('/api/login', { username: 'alice', password: 'nope' });
    assert.strictEqual(r.status, 401);
  });

  await check('login for an unknown user is 401 (not 404)', async () => {
    const r = await post('/api/login', { username: 'ghost', password: 'whatever' });
    assert.strictEqual(r.status, 401);
  });

  // ------------------------------- /api/me ------------------------------

  await check('/api/me with no token is 401', async () => {
    const r = await get('/api/me');
    assert.strictEqual(r.status, 401);
  });

  await check('/api/me with a valid token returns the account', async () => {
    const r = await get('/api/me', token);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).account.username, 'Alice');
  });

  // ----------------------------- characters -----------------------------

  let charId;
  await check('create a character (201) in slot 0', async () => {
    const r = await post('/api/characters', { name: 'Ness', spriteGroupId: 1 }, token);
    assert.strictEqual(r.status, 201);
    const j = await r.json();
    assert.strictEqual(j.character.slot, 0);
    charId = j.character.id;
  });

  await check('creating without a token is 401', async () => {
    const r = await post('/api/characters', { name: 'X', spriteGroupId: 1 });
    assert.strictEqual(r.status, 401);
  });

  await check('list returns the roster + max', async () => {
    const r = await get('/api/characters', token);
    const j = await r.json();
    assert.strictEqual(j.characters.length, 1);
    assert.strictEqual(j.max, 3);
  });

  await check('a 4th character is 409 (slots full)', async () => {
    await post('/api/characters', { name: 'Paula', spriteGroupId: 2 }, token);
    await post('/api/characters', { name: 'Jeff', spriteGroupId: 3 }, token);
    const r = await post('/api/characters', { name: 'Poo', spriteGroupId: 4 }, token);
    assert.strictEqual(r.status, 409);
  });

  await check("deleting someone else's (or unknown) character is 404", async () => {
    const r = await del('/api/characters/99999', token);
    assert.strictEqual(r.status, 404);
  });

  await check('delete my character frees the slot', async () => {
    const r = await del(`/api/characters/${charId}`, token);
    assert.strictEqual(r.status, 200);
    const list = await (await get('/api/characters', token)).json();
    assert.strictEqual(list.characters.length, 2);
  });

  // ------------------------------- logout -------------------------------

  await check('logout invalidates the token', async () => {
    await post('/api/logout', {}, token);
    const r = await get('/api/me', token);
    assert.strictEqual(r.status, 401);
  });

  server.close();
  store.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
