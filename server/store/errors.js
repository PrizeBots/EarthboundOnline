/**
 * Store error types + shared constants. Kept in their own module so both the
 * store impls and the (future) auth/character API can import them without a cycle.
 */

// Max character saves ("games") per account. EarthBound-y choice of 3.
const MAX_CHARACTERS = 3;

// Username already taken (case-insensitive). API maps this to HTTP 409.
class DuplicateUsernameError extends Error {
  constructor(username) {
    super(`username already taken: ${username}`);
    this.name = 'DuplicateUsernameError';
    this.code = 'DUPLICATE_USERNAME';
  }
}

// Account already has MAX_CHARACTERS saves. API maps this to HTTP 409.
class SlotsFullError extends Error {
  constructor(accountId) {
    super(`account ${accountId} already has ${MAX_CHARACTERS} characters`);
    this.name = 'SlotsFullError';
    this.code = 'SLOTS_FULL';
  }
}

module.exports = { MAX_CHARACTERS, DuplicateUsernameError, SlotsFullError };
