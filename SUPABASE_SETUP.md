# Supabase Persistence Setup

Production accounts / sessions / character saves are stored in **Supabase
(Postgres)**. Local dev still uses SQLite (`data/eb.db`) automatically — Supabase
kicks in only when a Postgres connection string is present in the environment.

How the backend is chosen (`server/store/index.js` → `createStore`):

1. `opts.filename` given → **SQLite** (tests, explicit dev).
2. `DATABASE_URL` or `SUPABASE_DB_URL` set in the env → **Supabase/Postgres**.
3. otherwise → **SQLite** at `data/eb.db` (local dev default).

## One-time setup

### 1. Create the Supabase project

In the Supabase dashboard, create a project. Pick a region close to the game
server (e.g. the same region as the Render service).

### 2. Apply the schema

Two ways — either works:

- **Linked repo (recommended):** connect this GitHub repo to the Supabase
  project. Supabase applies `supabase/migrations/0001_init.sql` automatically.
- **Manual:** paste the contents of `supabase/migrations/0001_init.sql` into the
  Supabase **SQL Editor** and run it.

> The server ALSO self-heals the schema on boot (it runs the same
> `CREATE TABLE IF NOT EXISTS …`), so even a bare database works — but the
> migration file is the source of truth.

### 3. Get the connection string

Dashboard → **Project Settings → Database → Connection string → URI**.

Use the **Connection pooler** URI (Transaction/Session pooler, port `6543` or
`5432`) for a web service — it's built for many short-lived connections. It looks
like:

```
postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Replace `<PASSWORD>` with your database password.

### 4. Set the env var on the host

- **Render:** dashboard → the `earthbound-online` service → **Environment** →
  add `DATABASE_URL` = the URI above. (`render.yaml` declares it with
  `sync: false`, so it's set in the dashboard, never committed.)
- **Local test against Supabase (optional):** put it in `.env` (see
  `.env.example`) or export it before `npm start`.

That's it. Restart the server; on boot it logs `[store] using Supabase/Postgres
backend`.

## Verify the round-trip

Register → create a character → play (level up / equip / bank) → log out →
log back in → CONTINUE should restore everything. Saves are written on
level-up / equip / buy / bank / flag changes and on disconnect, and flushed on
server shutdown (SIGTERM) so a redeploy doesn't drop an in-flight save.

## Notes

- TLS: the server connects with TLS and relaxed cert verification (Supabase's
  pooler chain isn't in Node's default roots). The channel is still encrypted.
- Passwords are bcrypt-hashed (cost 10) and never leave the server. Session
  tokens are 32-byte random hex, valid 30 days.
- Timestamps in the schema are epoch-**milliseconds** (`bigint`), supplied by the
  app — not Postgres `timestamptz` — to match the store contract across SQLite
  and Postgres.
- Cutover at launch is fresh-start (the dev `data/eb.db` is throwaway). No row
  migration needed.
