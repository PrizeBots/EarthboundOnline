-- Human-readable date columns for the Supabase table view. The app stores all
-- timestamps as epoch-MILLISECONDS (bigint) for backend parity (SQLite has no
-- date type) and integer comparison math. These GENERATED columns derive a
-- readable timestamptz from the bigint source so "when did this player register"
-- is legible in the dashboard. The app never writes them — they track the source.
-- Idempotent (ADD COLUMN IF NOT EXISTS); mirrors SCHEMA_SQL in SupabaseStore.js.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS created_at_ts timestamptz
  GENERATED ALWAYS AS (to_timestamp(created_at / 1000.0)) STORED;

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS created_at_ts timestamptz
  GENERATED ALWAYS AS (to_timestamp(created_at / 1000.0)) STORED;

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS updated_at_ts timestamptz
  GENERATED ALWAYS AS (to_timestamp(updated_at / 1000.0)) STORED;
