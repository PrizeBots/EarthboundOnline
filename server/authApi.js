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
const { validateAlloc } = require('./charStats');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days; refreshed on each login
const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/; // letters/digits/underscore, 3–16
const PASSWORD_MIN = 6;
const NAME_MAX = 24; // character display name cap

const newToken = () => crypto.randomBytes(32).toString('hex');

// Views that strip server-only fields before they hit the wire. Passwords/hashes
// must NEVER leave the process; account_id is implied by the session.
const publicAccount = (a) => ({ id: a.id, username: a.username, createdAt: a.createdAt });

// World documents the local editor persists to the DB (the Places outline; more
// editor overrides can follow). Allow-list — only known doc names are valid.
const WORLD_DOC_ALLOW = new Set(['places', 'stamps', 'rooms']);

// Loopback check — the editor's world-doc routes are dev/localhost only, so even
// when mounted they refuse non-loopback callers.
const isLoopback = (req) => {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};
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
 * @param {boolean} [opts.editorApi]  mount the dev editor's world-document routes
 *   (`/api/world/:name`). The Vite dev server passes this; the deploy server does
 *   NOT — the editor and its persistence are localhost-dev only, never in prod.
 * @returns {import('express').Express} an Express app usable as middleware.
 */
function createAuthApi(store, { now = () => Date.now(), editorApi = false } = {}) {
  const api = express();
  // Scope the JSON body parser to OUR /api routes. Mounted globally on the Vite
  // dev server, an unscoped parser would drain the body of every request —
  // including the editor's raw-stream POSTs (/__editor/save, /__editor/hotreload),
  // whose handlers then hang waiting on a stream that's already consumed.
  api.use('/api', express.json({ limit: '256kb' }));

  const bearer = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    return m ? m[1] : null;
  };

  // Gate: resolve the bearer token to a live session, else 401. Async because the
  // store may be (Supabase). A rejection here is forwarded to the error handler.
  const requireAuth = async (req, res, next) => {
    try {
      const token = bearer(req);
      const session = token ? await store.getSession(token, now()) : null;
      if (!session) return res.status(401).json({ error: 'not signed in' });
      req.accountId = session.accountId;
      req.token = token;
      next();
    } catch (e) {
      next(e);
    }
  };

  // Gate: loopback only. The editor routes are dev-localhost; this refuses any
  // non-loopback caller even if the routes are somehow reachable.
  const requireLoopback = (req, res, next) => {
    if (isLoopback(req)) return next();
    res.status(403).json({ error: 'local editor only' });
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
      const account = await store.createAccount({ username, passwordHash, now: t });
      const token = newToken();
      await store.createSession({ token, accountId: account.id, now: t, ttlMs: SESSION_TTL_MS });
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
    const account =
      typeof username === 'string' ? await store.getAccountByUsername(username) : null;
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
    await store.createSession({ token, accountId: account.id, now: t, ttlMs: SESSION_TTL_MS });
    res.json({ token, account: publicAccount(account) });
  });

  api.post('/api/logout', async (req, res) => {
    const token = bearer(req);
    if (token) await store.deleteSession(token);
    res.json({ ok: true });
  });

  // Who am I? Lets the client validate a stored token on boot (TITLE screen).
  api.get('/api/me', requireAuth, async (req, res) => {
    const account = await store.getAccountById(req.accountId);
    if (!account) return res.status(401).json({ error: 'not signed in' });
    res.json({ account: publicAccount(account) });
  });

  // ------------------------------ characters ------------------------------

  api.get('/api/characters', requireAuth, async (req, res) => {
    const characters = await store.listCharacters(req.accountId);
    res.json({
      characters: characters.map(publicCharacter),
      max: MAX_CHARACTERS,
    });
  });

  api.post('/api/characters', requireAuth, async (req, res) => {
    const { name, spriteGroupId, appearance, alloc, favoriteThing, favoriteFood } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (!Number.isInteger(spriteGroupId)) {
      return res.status(400).json({ error: 'spriteGroupId must be an integer' });
    }
    // The 5-stat creation allocation is the build's source of truth. Validate it
    // here; combat stats are derived from it server-side on join (never trusted).
    if (!validateAlloc(alloc)) {
      return res.status(400).json({ error: 'invalid stat allocation' });
    }
    // The recolored sprite sheet (PNG data URL). Cap it so a row can't be huge.
    if (appearance != null && (typeof appearance !== 'string' || appearance.length > 65536)) {
      return res.status(400).json({ error: 'appearance too large' });
    }
    // EarthBound naming prompts — optional flavor stored in the save (trimmed +
    // capped; non-strings ignored). Not combat-relevant, so no strict validation.
    const fav = (v) => (typeof v === 'string' ? v.trim().slice(0, NAME_MAX) : '');
    try {
      // Canonical starting save: build + level/exp + the EB favorites. The game
      // host fills in starting inventory/money/spawn on first join (it owns that).
      const character = await store.createCharacter({
        accountId: req.accountId,
        name: name.trim().slice(0, NAME_MAX),
        spriteGroupId,
        appearance: appearance ?? null,
        save: {
          alloc,
          level: 1,
          exp: 0,
          favoriteThing: fav(favoriteThing),
          favoriteFood: fav(favoriteFood),
        },
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

  api.delete('/api/characters/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const character = Number.isInteger(id) ? await store.getCharacter(id) : null;
    // 404 (not 403) when it isn't yours — don't reveal that another account's id exists.
    if (!character || character.accountId !== req.accountId) {
      return res.status(404).json({ error: 'character not found' });
    }
    await store.deleteCharacter(id);
    res.json({ ok: true });
  });

  // ---------------------------- world documents ---------------------------
  // The local editor's authored content (the Places outline; more editor
  // overrides later). Mounted ONLY when editorApi is set — i.e. on the Vite dev
  // server, never on the deploy server. Loopback-gated as a second guard, so the
  // editing surface simply does not exist in production.
  if (editorApi) {
    api.get('/api/world/:name', requireLoopback, async (req, res) => {
      const name = req.params.name;
      if (!WORLD_DOC_ALLOW.has(name))
        return res.status(404).json({ error: `unknown world doc '${name}'` });
      res.json({ name, data: await store.getWorldDoc(name) });
    });

    api.put('/api/world/:name', requireLoopback, async (req, res) => {
      const name = req.params.name;
      if (!WORLD_DOC_ALLOW.has(name))
        return res.status(404).json({ error: `unknown world doc '${name}'` });
      const data = req.body && req.body.data;
      if (data === undefined) return res.status(400).json({ error: 'missing data' });
      const r = await store.putWorldDoc(name, data, now());
      res.json({ ok: true, updatedAt: r.updatedAt });
    });
  }

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
