/**
 * Admin CLI: set an account's per-account character cap (max_characters).
 *
 * The number of character saves an account may hold defaults to 3, but it lives
 * in a column so a tester/admin can be bumped without touching anyone else.
 *
 * Usage (from the repo root):
 *   node server/setMaxChars.js <username> <count>
 *
 * Examples:
 *   node server/setMaxChars.js admin 10      # let "admin" hold 10 characters
 *   node server/setMaxChars.js admin 3       # back to the default
 *
 * Backend is auto-selected the same way the server picks one (createStore):
 * local data/eb.db by default, or the Postgres URL in DATABASE_URL/SUPABASE_DB_URL.
 */
const { createStore } = require('./store');

async function main() {
  const [username, countArg] = process.argv.slice(2);
  const count = Number(countArg);
  if (!username || !Number.isInteger(count) || count < 1) {
    console.error('Usage: node server/setMaxChars.js <username> <count>   (count >= 1)');
    process.exit(1);
  }

  const store = createStore();
  const account = await store.getAccountByUsername(username);
  if (!account) {
    console.error(`No account named "${username}".`);
    process.exit(1);
  }

  const updated = await store.setMaxCharacters(account.id, count);
  console.log(`"${updated.username}" max characters: ${updated.maxCharacters}`);
  if (store.close) await store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
