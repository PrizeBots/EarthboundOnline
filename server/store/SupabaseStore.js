/**
 * SupabaseStore — the launch/production persistence backend (Supabase Postgres).
 *
 * The Postgres half of the "SQLite now -> Supabase/Postgres at launch" plan
 * (START_SCREEN.md). It implements the SAME `Store` contract as SqliteStore
 * (documented in server/store/index.js), so everything above it (auth API,
 * character API, GameHost save read/write) is unchanged — `createStore()` picks
 * this backend whenever a Postgres connection string is present in the env.
 *
 * Differences from SqliteStore, all hidden behind the contract:
 *   - Every method is ASYNC (node-postgres is async). Callers `await` the store;
 *     `await` on SqliteStore's synchronous return is a harmless no-op, so the two
 *     backends are interchangeable.
 *   - `characters.save` / `world_docs.data` are real `jsonb` columns. We send
 *     `JSON.stringify(...)::jsonb` on write and the driver returns parsed objects
 *     on read — so, unlike SqliteStore, there is no manual JSON.parse/stringify
 *     at the boundary (the RETURN SHAPE stays identical: a parsed object).
 *   - `id` columns are `bigint`; node-postgres returns bigint as a STRING to avoid
 *     precision loss. We `Number(...)` ids/timestamps in the mappers so the shape
 *     matches SqliteStore exactly (numeric ids, < 2^53 for the lifetime of this).
 *
 * `pg` is required lazily inside the constructor so this module can be imported
 * (and `node --check`ed, and the SQLite-backed test suite run) WITHOUT the `pg`
 * package installed — it's only pulled in when a SupabaseStore is actually built.
 */
const { DuplicateUsernameError, SlotsFullError, MAX_CHARACTERS } = require('./errors');

// Idempotent schema. Mirrors supabase/migrations/0001_init.sql so the store
// self-heals even when pointed at a bare database (e.g. a connection string used
// outside the Supabase migration pipeline). Safe to run on every boot.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS accounts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username       text   NOT NULL,
    username_lower text   NOT NULL UNIQUE,
    password_hash  text   NOT NULL,
    created_at     bigint NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      text   PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

  CREATE TABLE IF NOT EXISTS characters (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id      bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    slot            integer NOT NULL,
    name            text    NOT NULL,
    sprite_group_id integer NOT NULL,
    appearance      text,
    save            jsonb   NOT NULL,
    created_at      bigint  NOT NULL,
    updated_at      bigint  NOT NULL,
    UNIQUE(account_id, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);

  CREATE TABLE IF NOT EXISTS world_docs (
    name       text   PRIMARY KEY,
    data       jsonb  NOT NULL,
    updated_at bigint NOT NULL
  );
`;

class SupabaseStore {
  /**
   * @param {object} opts
   * @param {string} opts.connectionString  Postgres/Supabase connection string
   *   (the Supabase "Connection pooler" URI is recommended for a web service).
   */
  constructor({ connectionString } = {}) {
    if (!connectionString) throw new Error('SupabaseStore requires a connectionString');
    // Lazy require: keeps `pg` out of the dependency path for the SQLite tests.
    const { Pool } = require('pg');
    // Supabase requires TLS. Its pooler presents a cert chain Node doesn't have a
    // root for by default, so disable strict verification (the channel is still
    // encrypted) unless we're clearly talking to a local Postgres.
    const local = /(@|\/\/)(localhost|127\.0\.0\.1)\b/.test(connectionString);
    this.pool = new Pool({
      connectionString,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 10,
    });
    // Ensure the schema exists before the first real query. Every method awaits
    // this, so concurrent boot-time queries queue behind the one-time init.
    this._ready = this.pool.query(SCHEMA_SQL);
    // Attach a logging handler so an unreachable DB at boot surfaces as a logged
    // error rather than an unhandled rejection that crashes the process. Requests
    // still re-await `_ready` and get a clean failure until the DB recovers.
    this._ready.catch((e) => console.error('[store] schema init failed:', e.message));
    // The pool emits 'error' for idle-client failures (e.g. Supabase recycling a
    // connection); swallow+log so one dropped socket can't take the server down.
    this.pool.on('error', (e) => console.error('[store] idle client error:', e.message));
  }

  async _q(text, params) {
    await this._ready;
    return this.pool.query(text, params);
  }

  // --- mapping helpers (row -> plain object, camelCase + numeric ids) ---

  _account(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: Number(row.created_at),
    };
  }

  _character(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      accountId: Number(row.account_id),
      slot: row.slot,
      name: row.name,
      spriteGroupId: row.sprite_group_id,
      appearance: row.appearance,
      save: row.save, // jsonb -> already parsed by the driver
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // ============================ Accounts ============================

  async createAccount({ username, passwordHash, now }) {
    try {
      const r = await this._q(
        `INSERT INTO accounts (username, username_lower, password_hash, created_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [username, username.toLowerCase(), passwordHash, now]
      );
      return this._account(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw new DuplicateUsernameError(username); // unique_violation
      throw e;
    }
  }

  async getAccountByUsername(username) {
    const r = await this._q(`SELECT * FROM accounts WHERE username_lower = $1`, [
      username.toLowerCase(),
    ]);
    return this._account(r.rows[0]);
  }

  async getAccountById(id) {
    const r = await this._q(`SELECT * FROM accounts WHERE id = $1`, [id]);
    return this._account(r.rows[0]);
  }

  // ============================ Sessions ============================

  async createSession({ token, accountId, now, ttlMs }) {
    const expiresAt = now + ttlMs;
    await this._q(
      `INSERT INTO sessions (token, account_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [token, accountId, now, expiresAt]
    );
    return { token, accountId, createdAt: now, expiresAt };
  }

  /** @returns the session if it exists AND hasn't expired, else null (GCs expired). */
  async getSession(token, now) {
    const r = await this._q(`SELECT * FROM sessions WHERE token = $1`, [token]);
    const row = r.rows[0];
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= now) {
      await this._q(`DELETE FROM sessions WHERE token = $1`, [token]); // lazy GC
      return null;
    }
    return { token: row.token, accountId: Number(row.account_id), expiresAt };
  }

  async deleteSession(token) {
    await this._q(`DELETE FROM sessions WHERE token = $1`, [token]);
  }

  async deleteExpiredSessions(now) {
    const r = await this._q(`DELETE FROM sessions WHERE expires_at <= $1`, [now]);
    return r.rowCount;
  }

  // ========================== World documents ==========================

  async getWorldDoc(name) {
    const r = await this._q(`SELECT data FROM world_docs WHERE name = $1`, [name]);
    return r.rows[0] ? r.rows[0].data : null;
  }

  async putWorldDoc(name, data, now) {
    await this._q(
      `INSERT INTO world_docs (name, data, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (name) DO UPDATE SET data = $2::jsonb, updated_at = $3`,
      [name, JSON.stringify(data), now]
    );
    return { name, updatedAt: now };
  }

  // =========================== Characters ===========================

  async listCharacters(accountId) {
    const r = await this._q(`SELECT * FROM characters WHERE account_id = $1 ORDER BY slot ASC`, [
      accountId,
    ]);
    return r.rows.map((row) => this._character(row));
  }

  async getCharacter(id) {
    const r = await this._q(`SELECT * FROM characters WHERE id = $1`, [id]);
    return this._character(r.rows[0]);
  }

  /**
   * Create a character in the lowest free slot (0..MAX_CHARACTERS-1) inside a
   * transaction so two concurrent creates can't claim the same slot. Throws
   * SlotsFullError when the account is full.
   */
  async createCharacter({ accountId, name, spriteGroupId, appearance, save, now }) {
    await this._ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock this account's rows so a concurrent create serializes behind us.
      const used = await client.query(
        `SELECT slot FROM characters WHERE account_id = $1 FOR UPDATE`,
        [accountId]
      );
      const taken = new Set(used.rows.map((r) => r.slot));
      let slot = -1;
      for (let s = 0; s < MAX_CHARACTERS; s++) {
        if (!taken.has(s)) {
          slot = s;
          break;
        }
      }
      if (slot === -1) throw new SlotsFullError(accountId);
      const ins = await client.query(
        `INSERT INTO characters
           (account_id, slot, name, sprite_group_id, appearance, save, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7) RETURNING *`,
        [accountId, slot, name, spriteGroupId, appearance || null, JSON.stringify(save || {}), now]
      );
      await client.query('COMMIT');
      return this._character(ins.rows[0]);
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback error */
      }
      if (e instanceof SlotsFullError) throw e;
      if (e.code === '23505') throw new SlotsFullError(accountId); // slot UNIQUE race
      throw e;
    } finally {
      client.release();
    }
  }

  async updateCharacterSave(id, save, now) {
    const r = await this._q(
      `UPDATE characters SET save = $2::jsonb, updated_at = $3 WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(save), now]
    );
    return this._character(r.rows[0]);
  }

  async deleteCharacter(id) {
    await this._q(`DELETE FROM characters WHERE id = $1`, [id]);
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { SupabaseStore };
