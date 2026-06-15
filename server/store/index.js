/**
 * Store — the persistence seam for accounts, sessions, and character saves.
 *
 * This is the swap point in the "SQLite now -> Supabase/Postgres at launch" plan
 * (START_SCREEN.md). Everything above the store (auth API, character API, the
 * game server's save read/write) depends ONLY on the contract below, never on
 * better-sqlite3. To move to Supabase at launch: write a SupabaseStore with the
 * same methods and change the one line in `createStore`. Nothing else changes.
 *
 * ── Store contract ───────────────────────────────────────────────────────────
 * All `now` args are epoch-ms timestamps supplied by the caller (so the store
 * stays deterministic/testable). Methods are synchronous in SqliteStore; the
 * contract permits a future async impl, so callers should `await` if they want
 * to stay backend-agnostic — `await` on a non-promise is a harmless no-op.
 *
 * Accounts
 *   createAccount({ username, passwordHash, now }) -> account
 *       throws DuplicateUsernameError if the (case-insensitive) name is taken
 *   getAccountByUsername(username) -> account | null   (includes passwordHash)
 *   getAccountById(id) -> account | null               (includes passwordHash)
 *
 * Sessions
 *   createSession({ token, accountId, now, ttlMs }) -> session
 *   getSession(token, now) -> { token, accountId, expiresAt } | null
 *       returns null (and GCs the row) if expired
 *   deleteSession(token) -> void                        (logout)
 *   deleteExpiredSessions(now) -> number                (count removed)
 *
 * Characters  (max MAX_CHARACTERS per account; `save` is opaque JSON state:
 *              progression/inventory/money/equipment/position/flags)
 *   listCharacters(accountId) -> character[]            (slot order)
 *   getCharacter(id) -> character | null
 *   createCharacter({ accountId, name, spriteGroupId, appearance, save, now })
 *       -> character   (auto-assigns lowest free slot; throws SlotsFullError)
 *   updateCharacterSave(id, save, now) -> character     (persist gameplay state)
 *   deleteCharacter(id) -> void
 *
 *   account   = { id, username, passwordHash, createdAt }
 *   character = { id, accountId, slot, name, spriteGroupId, appearance,
 *                 save, createdAt, updatedAt }
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { SqliteStore } = require('./SqliteStore');
const { MAX_CHARACTERS, DuplicateUsernameError, SlotsFullError } = require('./errors');

/**
 * Build the persistence store. The ONE place that picks a backend.
 * @param {object} [opts]
 * @param {string} [opts.filename] sqlite path, or ':memory:'. Defaults to data/eb.db.
 */
function createStore(opts = {}) {
  // At launch, swap this line for `new SupabaseStore(...)`.
  return new SqliteStore(opts.filename);
}

module.exports = {
  createStore,
  SqliteStore,
  MAX_CHARACTERS,
  DuplicateUsernameError,
  SlotsFullError,
};
