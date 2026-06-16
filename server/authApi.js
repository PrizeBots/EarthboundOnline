/**
 * Auth + character HTTP API (START_SCREEN.md, Phase 2).
 *
 * An Express *app* (not a bare Router) exposing the account/session/character
 * endpoints the TITLE/AUTH overlay calls. We return a full app on purpose: an
 * Express app augments req/res with `res.json`, `req.body`, etc. via its own
 * `expressInit` middleware on every request, so the same factory mounts cleanly
 * in BOTH transports —
 *   - server/index.js (deploy):  app.use(createAuthApi(store))
 *   - vite.config.ts (dev):      server.middlewares.use(createAuthApi(store))
 * Vite's middleware stack is plain connect, which lacks res.json on its own; a
 * bare Router would throw there. The app also calls next() on any unmatched
 * path, so it layers under Vite/static without swallowing other requests.
 *
 * Persistence goes through the Store contract only (server/store/) — never
 * better-sqlite3 directly — so the Supabase swap at launch stays a one-liner.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { DuplicateUsernameError, SlotsFullError, MAX_CHARACTERS } = require('./store/errors');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days; refreshed on each login
const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/; // letters/digits/underscore, 3–16
const PASSWORD_MIN = 6;
const NAME_MAX = 24; // character display name cap

const newToken = () => crypto.randomBytes(32).toString('hex');

// Views that strip server-only fields before they hit the wire. Passwords/hashes
// must NEVER leave the process; account_id is implied by the session.
const publicAccount = (a) => ({ id: a.id, username: a.username, createdAt: a.createdAt });
const publicCharacter = (c) => ({
  id: c.id,
  slot: c.slot,
  name: c.name,
  spriteGroupId: c.spriteGroupId,
  appearance: c.appearance,
  save: c.save,
  updatedAt: c.updatedAt,
});

/**
 * Build the auth/character API.
 * @param {object} store  a Store impl (createStore()).
 * @param {object} [opts]
 * @param {() => number} [opts.now]  epoch-ms clock; injectable for tests.
 * @returns {import('express').Express} an Express app usable as middleware.
 */
function createAuthApi(store, { now = () => Date.now() } = {}) {
  const api = express();
  api.use(express.json({ limit: '256kb' }));

  const bearer = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    return m ? m[1] : null;
  };

  // Gate: resolve the bearer token to a live session, else 401.
  const requireAuth = (req, res, next) => {
    const token = bearer(req);
    const session = token ? store.getSession(token, now()) : null;
    if (!session) return res.status(401).json({ error: 'not signed in' });
    req.accountId = session.accountId;
    req.token = token;
    next();
  };

  // ------------------------------- accounts -------------------------------

  api.post('/api/register', async (req, res) => {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(username || '')) {
      return res
        .status(400)
        .json({ error: 'username must be 3–16 letters, digits, or underscores' });
    }
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
      return res
        .status(400)
        .json({ error: `password must be at least ${PASSWORD_MIN} characters` });
    }
    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const t = now();
      const account = store.createAccount({ username, passwordHash, now: t });
      const token = newToken();
      store.createSession({ token, accountId: account.id, now: t, ttlMs: SESSION_TTL_MS });
      res.status(201).json({ token, account: publicAccount(account) });
    } catch (e) {
      if (e instanceof DuplicateUsernameError) {
        return res.status(409).json({ error: 'that username is taken' });
      }
      throw e; // → error handler (500)
    }
  });

  api.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    const account = typeof username === 'string' ? store.getAccountByUsername(username) : null;
    // Always run a compare so a missing account and a wrong password take a
    // similar amount of time (don't leak which usernames exist via timing).
    const decoy = '$2a$10$0000000000000000000000000000000000000000000000000000a';
    const ok =
      typeof password === 'string' &&
      (await bcrypt.compare(password, account ? account.passwordHash : decoy)) &&
      !!account;
    if (!ok) return res.status(401).json({ error: 'wrong username or password' });
    const t = now();
    const token = newToken();
    store.createSession({ token, accountId: account.id, now: t, ttlMs: SESSION_TTL_MS });
    res.json({ token, account: publicAccount(account) });
  });

  api.post('/api/logout', (req, res) => {
    const token = bearer(req);
    if (token) store.deleteSession(token);
    res.json({ ok: true });
  });

  // Who am I? Lets the client validate a stored token on boot (TITLE screen).
  api.get('/api/me', requireAuth, (req, res) => {
    const account = store.getAccountById(req.accountId);
    if (!account) return res.status(401).json({ error: 'not signed in' });
    res.json({ account: publicAccount(account) });
  });

  // ------------------------------ characters ------------------------------

  api.get('/api/characters', requireAuth, (req, res) => {
    res.json({
      characters: store.listCharacters(req.accountId).map(publicCharacter),
      max: MAX_CHARACTERS,
    });
  });

  api.post('/api/characters', requireAuth, (req, res) => {
    const { name, spriteGroupId, appearance, save } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (!Number.isInteger(spriteGroupId)) {
      return res.status(400).json({ error: 'spriteGroupId must be an integer' });
    }
    try {
      const character = store.createCharacter({
        accountId: req.accountId,
        name: name.trim().slice(0, NAME_MAX),
        spriteGroupId,
        appearance: appearance ?? null,
        save: save && typeof save === 'object' ? save : {},
        now: now(),
      });
      res.status(201).json({ character: publicCharacter(character) });
    } catch (e) {
      if (e instanceof SlotsFullError) {
        return res.status(409).json({ error: `all ${MAX_CHARACTERS} save slots are full` });
      }
      throw e;
    }
  });

  api.delete('/api/characters/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const character = Number.isInteger(id) ? store.getCharacter(id) : null;
    // 404 (not 403) when it isn't yours — don't reveal that another account's id exists.
    if (!character || character.accountId !== req.accountId) {
      return res.status(404).json({ error: 'character not found' });
    }
    store.deleteCharacter(id);
    res.json({ ok: true });
  });

  // Final error handler: any thrown/rejected handler lands here as JSON 500
  // instead of Express's default HTML page (the client only parses JSON).
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    console.error('[authApi]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return api;
}

module.exports = { createAuthApi, SESSION_TTL_MS };
