/**
 * SqliteStore — the local/dev persistence backend for accounts, sessions, and
 * character saves. Implements the `Store` contract documented in
 * server/store/index.js.
 *
 * This is the SQLite-now half of the "SQLite now -> Supabase/Postgres at launch"
 * plan (see START_SCREEN.md). Everything here is deliberately portable:
 *   - standard SQL (no SQLite-only syntax in the schema except AUTOINCREMENT)
 *   - the volatile gameplay state lives in ONE `save` JSON column, which maps to
 *     a Postgres `jsonb` column 1:1 when SupabaseStore is written.
 * Keep new methods on the `Store` contract, not as SqliteStore specials, so the
 * Supabase swap stays a drop-in.
 *
 * better-sqlite3 is synchronous (no async/await). That's fine: these are tiny,
 * indexed, single-row operations and the game server is single-threaded anyway.
 * The `Store` contract is still written to allow an async impl later, but callers
 * here can treat results as immediate.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DuplicateUsernameError, SlotsFullError, MAX_CHARACTERS } = require('./errors');

// Bump when MIGRATIONS grows. PRAGMA user_version tracks what's applied so an
// existing eb.db upgrades in place on boot.
const MIGRATIONS = [
  // v1 — initial schema.
  (db) => {
    db.exec(`
      CREATE TABLE accounts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL,
        username_lower TEXT   NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token      TEXT    PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_account ON sessions(account_id);

      CREATE TABLE characters (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        slot            INTEGER NOT NULL,
        name            TEXT    NOT NULL,
        sprite_group_id INTEGER NOT NULL,
        appearance      TEXT,
        save            TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE(account_id, slot)
      );
      CREATE INDEX idx_characters_account ON characters(account_id);
    `);
  },

  // v2 — a generic key->JSON document store for authored world content (the
  // Places outline is the first; other editor overrides can follow). Written
  // ONLY by the localhost dev editor. `data` maps 1:1 to a Postgres `jsonb`
  // column for the Supabase swap.
  (db) => {
    db.exec(`
      CREATE TABLE world_docs (
        name       TEXT    PRIMARY KEY,
        data       TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
];

class SqliteStore {
  /**
   * @param {string} filename path to the db file, or ':memory:' for tests.
   *   Defaults to <repo>/data/eb.db. Parent dir is created if missing.
   */
  constructor(filename) {
    const file = filename || path.join(__dirname, '..', '..', 'data', 'eb.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL'); // concurrent reads while a write is open
    this.db.pragma('foreign_keys = ON'); // ON DELETE CASCADE actually fires
    this._migrate();
    this._prepare();
  }

  _migrate() {
    const applied = this.db.pragma('user_version', { simple: true });
    for (let v = applied; v < MIGRATIONS.length; v++) {
      const run = this.db.transaction(() => {
        MIGRATIONS[v](this.db);
        this.db.pragma(`user_version = ${v + 1}`);
      });
      run();
    }
  }

  _prepare() {
    const db = this.db;
    this._stmt = {
      insertAccount: db.prepare(
        `INSERT INTO accounts (username, username_lower, password_hash, created_at)
         VALUES (@username, @usernameLower, @passwordHash, @createdAt)`
      ),
      accountByLower: db.prepare(`SELECT * FROM accounts WHERE username_lower = ?`),
      accountById: db.prepare(`SELECT * FROM accounts WHERE id = ?`),

      insertSession: db.prepare(
        `INSERT INTO sessions (token, account_id, created_at, expires_at)
         VALUES (@token, @accountId, @createdAt, @expiresAt)`
      ),
      sessionByToken: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
      deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
      deleteExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),

      charsByAccount: db.prepare(`SELECT * FROM characters WHERE account_id = ? ORDER BY slot ASC`),
      charById: db.prepare(`SELECT * FROM characters WHERE id = ?`),
      insertChar: db.prepare(
        `INSERT INTO characters
           (account_id, slot, name, sprite_group_id, appearance, save, created_at, updated_at)
         VALUES (@accountId, @slot, @name, @spriteGroupId, @appearance, @save, @createdAt, @updatedAt)`
      ),
      updateCharSave: db.prepare(
        `UPDATE characters SET save = @save, updated_at = @updatedAt WHERE id = @id`
      ),
      deleteChar: db.prepare(`DELETE FROM characters WHERE id = ?`),

      worldDocByName: db.prepare(`SELECT * FROM world_docs WHERE name = ?`),
      upsertWorldDoc: db.prepare(
        `INSERT INTO world_docs (name, data, updated_at) VALUES (@name, @data, @updatedAt)
         ON CONFLICT(name) DO UPDATE SET data = @data, updated_at = @updatedAt`
      ),
    };
  }

  // --- mapping helpers (row <-> plain object, camelCase + parsed JSON) ---

  _account(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  _character(row) {
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      slot: row.slot,
      name: row.name,
      spriteGroupId: row.sprite_group_id,
      appearance: row.appearance,
      save: JSON.parse(row.save),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ============================ Accounts ============================

  /** @returns {object} the created account (without passwordHash echoed back) */
  createAccount({ username, passwordHash, now }) {
    const usernameLower = username.toLowerCase();
    if (this._stmt.accountByLower.get(usernameLower)) {
      throw new DuplicateUsernameError(username);
    }
    try {
      const info = this._stmt.insertAccount.run({
        username,
        usernameLower,
        passwordHash,
        createdAt: now,
      });
      return this._account(this._stmt.accountById.get(info.lastInsertRowid));
    } catch (e) {
      // Guard the race where two registrations slip past the pre-check.
      if (String(e.message).includes('UNIQUE')) throw new DuplicateUsernameError(username);
      throw e;
    }
  }

  getAccountByUsername(username) {
    return this._account(this._stmt.accountByLower.get(username.toLowerCase()));
  }

  getAccountById(id) {
    return this._account(this._stmt.accountById.get(id));
  }

  // ========================== World documents ==========================
  // A key->JSON store for authored world content (the Places outline; more
  // editor overrides can follow). Written only by the localhost dev editor.

  /** @returns the parsed JSON document for `name`, or null if none. */
  getWorldDoc(name) {
    const row = this._stmt.worldDocByName.get(name);
    return row ? JSON.parse(row.data) : null;
  }

  /** Upsert a world document. @returns { name, updatedAt }. */
  putWorldDoc(name, data, now) {
    this._stmt.upsertWorldDoc.run({ name, data: JSON.stringify(data), updatedAt: now });
    return { name, updatedAt: now };
  }

  // ============================ Sessions ============================

  createSession({ token, accountId, now, ttlMs }) {
    this._stmt.insertSession.run({
      token,
      accountId,
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    return { token, accountId, createdAt: now, expiresAt: now + ttlMs };
  }

  /** @returns the session if it exists AND hasn't expired, else null. */
  getSession(token, now) {
    const row = this._stmt.sessionByToken.get(token);
    if (!row) return null;
    if (row.expires_at <= now) {
      this._stmt.deleteSession.run(token); // lazy GC of the one we just hit
      return null;
    }
    return { token: row.token, accountId: row.account_id, expiresAt: row.expires_at };
  }

  deleteSession(token) {
    this._stmt.deleteSession.run(token);
  }

  deleteExpiredSessions(now) {
    return this._stmt.deleteExpiredSessions.run(now).changes;
  }

  // =========================== Characters ===========================

  listCharacters(accountId) {
    return this._stmt.charsByAccount.all(accountId).map((r) => this._character(r));
  }

  getCharacter(id) {
    return this._character(this._stmt.charById.get(id));
  }

  /**
   * Create a character in the lowest free slot (0..MAX_CHARACTERS-1).
   * Throws SlotsFullError if the account already has MAX_CHARACTERS.
   */
  createCharacter({ accountId, name, spriteGroupId, appearance, save, now }) {
    const create = this.db.transaction(() => {
      const used = new Set(this._stmt.charsByAccount.all(accountId).map((r) => r.slot));
      let slot = -1;
      for (let s = 0; s < MAX_CHARACTERS; s++) {
        if (!used.has(s)) {
          slot = s;
          break;
        }
      }
      if (slot === -1) throw new SlotsFullError(accountId);
      const info = this._stmt.insertChar.run({
        accountId,
        slot,
        name,
        spriteGroupId,
        appearance: appearance || null,
        save: JSON.stringify(save || {}),
        createdAt: now,
        updatedAt: now,
      });
      return info.lastInsertRowid;
    });
    return this._character(this._stmt.charById.get(create()));
  }

  /** Persist the volatile gameplay state (level/inventory/money/equipment/pos/flags). */
  updateCharacterSave(id, save, now) {
    this._stmt.updateCharSave.run({ id, save: JSON.stringify(save), updatedAt: now });
    return this._character(this._stmt.charById.get(id));
  }

  deleteCharacter(id) {
    this._stmt.deleteChar.run(id);
  }

  close() {
    this.db.close();
  }
}

module.exports = { SqliteStore };
