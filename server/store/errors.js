/**
 * Store error types + shared constants. Kept in their own module so both the
 * store impls and the (future) auth/character API can import them without a cycle.
 */

// Default max character saves ("games") per account. EarthBound-y choice of 3.
// This is only the DEFAULT for new accounts — the real cap is the per-account
// `max_characters` column (so an admin/tester can be bumped to e.g. 10). Stores
// seed the column with this value.
const MAX_CHARACTERS = 3;
const DEFAULT_MAX_CHARACTERS = MAX_CHARACTERS;

// Username already taken (case-insensitive). API maps this to HTTP 409.
class DuplicateUsernameError extends Error {
  constructor(username) {
    super(`username already taken: ${username}`);
    this.name = 'DuplicateUsernameError';
    this.code = 'DUPLICATE_USERNAME';
  }
}

// Account is at its per-account cap. API maps this to HTTP 409. `max` is the
// account's actual limit (its max_characters column), not the global default.
class SlotsFullError extends Error {
  constructor(accountId, max = MAX_CHARACTERS) {
    super(`account ${accountId} already has ${max} characters`);
    this.name = 'SlotsFullError';
    this.code = 'SLOTS_FULL';
    this.max = max;
  }
}

module.exports = {
  MAX_CHARACTERS,
  DEFAULT_MAX_CHARACTERS,
  DuplicateUsernameError,
  SlotsFullError,
};
