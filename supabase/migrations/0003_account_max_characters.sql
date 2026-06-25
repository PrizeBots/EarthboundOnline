-- Per-account character cap. The number of character saves an account may hold
-- used to be a hard-coded constant (3); it is now a column so an admin/tester
-- can be bumped (e.g. to 10) without touching every other account. Defaults to
-- 3 so existing accounts are unchanged. Idempotent; mirrors SCHEMA_SQL in
-- SupabaseStore.js.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS max_characters integer NOT NULL DEFAULT 3;
