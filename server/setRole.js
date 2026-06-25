/**
 * Admin CLI: set an account's role.
 *
 * Roles: 'player' (default) | 'dev' | 'admin'. The role is SERVER-VERIFIED
 * (loaded from the DB at join, never trusted from the client), so it can safely
 * gate dev/admin powers in PROD — notably the PSI/ability unlock bypass, which
 * lets dev accounts test every move regardless of stat investment.
 *
 * Usage (from the repo root):
 *   node server/setRole.js <username> <role>
 *
 * Examples:
 *   node server/setRole.js zz dev        # let "zz" test all PSI/abilities
 *   node server/setRole.js zz player     # back to a normal account
 *
 * Backend is auto-selected like the server (createStore): local data/eb.db by
 * default, or the Postgres URL in DATABASE_URL/SUPABASE_DB_URL.
 */
const { createStore } = require('./store');

const ROLES = ['player', 'dev', 'admin'];

async function main() {
  const [username, role] = process.argv.slice(2);
  if (!username || !ROLES.includes(role)) {
    console.error(`Usage: node server/setRole.js <username> <role>   (role: ${ROLES.join(' | ')})`);
    process.exit(1);
  }

  const store = createStore();
  const account = await store.getAccountByUsername(username);
  if (!account) {
    console.error(`No account named "${username}".`);
    process.exit(1);
  }

  const updated = await store.setRole(account.id, role);
  console.log(`"${updated.username}" role: ${updated.role}`);
  if (store.close) await store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
