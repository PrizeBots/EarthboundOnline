-- Zexonyte Online — initial persistence schema (accounts / sessions /
-- characters / world_docs). Postgres counterpart of the SQLite schema in
-- server/store/SqliteStore.js. Kept in sync with SCHEMA_SQL in
-- server/store/SupabaseStore.js (the server self-heals from that too).
--
-- Linking this repo to a Supabase project applies this migration automatically.
-- All timestamps are epoch-MILLISECONDS (bigint), supplied by the app — NOT
-- Postgres timestamps — to match the Store contract across both backends.

CREATE TABLE IF NOT EXISTS accounts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       text   NOT NULL,
  username_lower text   NOT NULL UNIQUE,   -- case-insensitive uniqueness
  password_hash  text   NOT NULL,          -- bcrypt; never leaves the server
  created_at     bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text   PRIMARY KEY,           -- 32-byte crypto.randomBytes hex
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS characters (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      bigint  NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot            integer NOT NULL,        -- 0..MAX_CHARACTERS-1
  name            text    NOT NULL,
  sprite_group_id integer NOT NULL,
  appearance      text,                    -- recolored sprite sheet (data URL)
  save            jsonb   NOT NULL,        -- progression/inventory/money/pos/flags
  created_at      bigint  NOT NULL,
  updated_at      bigint  NOT NULL,
  UNIQUE(account_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);

-- Authored world content written by the localhost dev editor (the Places
-- outline, etc.). Not player data.
CREATE TABLE IF NOT EXISTS world_docs (
  name       text   PRIMARY KEY,
  data       jsonb  NOT NULL,
  updated_at bigint NOT NULL
);
