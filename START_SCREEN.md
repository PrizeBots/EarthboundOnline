# Main Start Screen — Design

Status: **PLANNED** (approved 2026-06-15, not yet built). Plan-only; review before
implementing.

## Goal

A true title screen with two buttons — **START** and **CONTINUE** — backed by real
accounts. Players register with a username + password; each account holds up to **3
character saves** ("games"). START creates a new character; CONTINUE resumes one.

## Decisions

- **Auth:** our own **username + password** (hashed with `bcryptjs`, never plaintext).
  Overrides the earlier "avoid passwords / OAuth-only" stance. Accounts are designed so
  an OAuth/magic-link credential can be **linked/claimed** later.
- **Storage:** **SQLite in the standalone Node server now**, behind a swappable `Store`
  interface. **Migrate to Supabase/Postgres at MVP launch** (and test then). No paid
  infra until launch.
- **ROM step:** **skipped for now.** Keep loading assets over HTTP in dev. The ROM-intake
  gate slots in later, right after AUTH (see Pre-Launch in TODO.md).

## Screen flow

```
TITLE ──START──▶ [valid session?]──no──▶ AUTH ──▶ NEW CHARACTER (name → pick) ──▶ PLAY
  │                  │yes                            (blocked if 3/3 slots full)
  │                  └────────────────────────────▶ NEW CHARACTER ─────────────▶ PLAY
  │
  └──CONTINUE─▶ [valid session?]──no──▶ AUTH ──▶ CHARACTER SLOTS (pick 1 of ≤3) ─▶ PLAY
                     │yes                          (greyed out if 0 characters)
                     └──────────────────────────▶ CHARACTER SLOTS ──────────────▶ PLAY
```

- TITLE shows START + CONTINUE plus "Signed in as X / Log out".
- Either button with no valid session → AUTH first, then proceeds to the intended action.
- CONTINUE is disabled when the account has 0 characters.
- **Account = container; the 3 "games" are save slots (0–2).** START fills a free slot;
  CONTINUE loads a used one.
- (Future) ROM-intake gate inserts between AUTH and NEW CHARACTER.

## UI tech

TITLE / AUTH / SLOTS are a **DOM overlay** over the canvas, styled EB-ish — password
fields on a pixel canvas are painful (masking, paste, mobile keyboards). The "pick
character" step reuses the existing canvas `CharacterSelect` roster. The game itself stays
canvas. (Revisit if we want fully in-canvas EB-styled menus.)

## Data model (SQLite now → Postgres later; JSON cols → `jsonb`)

- `accounts`: id, username (unique, case-insensitive), password_hash, created_at
- `sessions`: token, account_id, created_at, expires_at
- `characters`: id, account_id, slot (0–2), name, sprite_group_id, appearance,
  progression(JSON: level/exp/all 7 stats), hp, max_hp, inventory(JSON), money,
  equipment(JSON: 4 slots + hotbar), pos_x, pos_y, zone, player_flags(JSON), updated_at

Keep SQL standard so the Supabase swap is mechanical.

## Backend

- `Store` **interface** + `SqliteStore` impl (`better-sqlite3`, synchronous, no native
  build pain on Windows). Supabase becomes a second impl later — that's the migration seam.
- Passwords: `bcryptjs` (pure JS).
- Sessions: opaque random token (`crypto.randomBytes`), stored server-side, kept
  client-side in `localStorage` as `eb_session`.
- **HTTP JSON API** on the standalone Node server:
  `POST /api/register`, `/api/login`, `/api/logout`,
  `GET /api/characters`, `POST /api/characters` (enforces ≤3), `DELETE /api/characters/:id`.

## Network join change

Today: join sends `{spriteGroupId, name, appearance}` ad hoc.
New: join sends `{ type:'join', sessionToken, characterId }`. Server validates the token →
loads that character's save → spawns with persisted level/inventory/equipment/position.
Name/sprite/appearance come **from the save**, not the wire.

## Save system (the dependency)

**CONTINUE is only meaningful once we persist progress**, so this feature absorbs the
Phase 4 "Save system" item. The server is already authoritative for stats/inventory/
equipment, so we wire writes:

- Persist on level-up, inventory/equip/money change, and on disconnect; plus periodic
  autosave.
- Move `PlayerFlags` off `localStorage` into the save (the "THE SEAM" comment in
  `PlayerFlags.ts`).

## Build phases (after approval)

1. ✅ `Store` interface + `SqliteStore` + schema/migrations. (`server/store/`)
2. ✅ Auth API + sessions. (`server/authApi.js` — Express app mounted in BOTH
   `server/index.js` and `vite.config.ts`; `server/authApi.test.js`, 16 tests.
   Routes: `POST /api/register|login|logout`, `GET /api/me`,
   `GET|POST /api/characters`, `DELETE /api/characters/:id`. bcryptjs hashing,
   32-byte hex session tokens, 30-day TTL, Bearer-token auth.)
3. ✅ Client TITLE + AUTH overlay. (`src/engine/auth/authClient.ts` API client +
   token in `localStorage['eb_session']`; `src/engine/auth/TitleScreen.ts` DOM
   overlay — TITLE w/ START+CONTINUE, register/login tabs, signed-in/log-out
   footer, CONTINUE disabled at 0 saves. Gated in `main.ts` before the game boots;
   resolves `{account, action}`. Boot validates stored token via `/api/me`.)
4. ⬜ Character slots: create (START) + list/select (CONTINUE). ← NEXT
   `action` is plumbed through `main.ts` but both paths still fall through to the
   existing canvas character-select; Phase 4 branches on it.
5. ✅ Wire save read on join / write on change+disconnect; move flags into the save.
   (`GameHost._loadCharacterInit`/`_saveCharacter`; flags now in the save —
   `this.flags` map ↔ `save.flags`, mirrored from the client `PlayerFlags` sink.)
6. ✅ Document the Supabase migration seam. (See "Migration to Supabase" below.)

## Migration to Supabase — ✅ BUILT (2026-06-17)

`SupabaseStore` (`server/store/SupabaseStore.js`) is implemented and wired.
`createStore` now auto-selects the backend by env: a Postgres URL
(`DATABASE_URL` / `SUPABASE_DB_URL`) → Supabase, else SQLite. The store contract
went async-for-real: `authApi.js` handlers, `GameHost._loadCharacterInit` (join),
and `GameHost._saveCharacter` (now a per-character serialized write queue, flushed
on `SIGTERM`) all `await` the store. Schema lives in `supabase/migrations/`.
**Operator steps to go live: `SUPABASE_SETUP.md`.** The section below is the
original design notes, kept for reference.

## Migration to Supabase (at MVP launch) — the seam, documented

Everything above the persistence layer (auth API, character API, `GameHost`'s
save read/write) depends ONLY on the `Store` contract, never on `better-sqlite3`.
So the whole migration is: write one new class and change one line.

**The swap point** is `createStore()` in `server/store/index.js`:

```js
// SQLite now ↓ — at launch, swap this single line:
return new SqliteStore(opts.filename);
// return new SupabaseStore(opts);
```

Nothing else imports `SqliteStore` directly — grep to confirm before/after.

**The contract `SupabaseStore` must implement** (full signatures in the
`server/store/index.js` header comment). Every method below already has SQLite
parity + tests (`store.test.js`), so they double as the acceptance spec:

- Accounts: `createAccount({username,passwordHash,now})` (throws
  `DuplicateUsernameError` on case-insensitive dup), `getAccountByUsername`,
  `getAccountById` — both return the row INCLUDING `passwordHash`.
- Sessions: `createSession({token,accountId,now,ttlMs})`, `getSession(token,now)`
  (returns null AND GCs the row when expired), `deleteSession`,
  `deleteExpiredSessions(now)`.
- Characters (≤ `MAX_CHARACTERS` per account; `save` is opaque JSON —
  progression/inventory/money/equipment/position/**flags**): `listCharacters`,
  `getCharacter`, `createCharacter` (auto-assigns lowest free slot; throws
  `SlotsFullError`), `updateCharacterSave(id,save,now)`, `deleteCharacter`.
- World docs: `getWorldDoc(name)`, `putWorldDoc(name,data,now)`.

**Schema mapping** (tables in `SqliteStore.js`):

- `accounts`, `sessions`, `characters`, `world_docs` map 1:1 to Postgres tables.
- JSON `TEXT` columns (`characters.save`, `world_docs.data`) → `jsonb`. SqliteStore
  `JSON.parse`/`JSON.stringify`es at the boundary; with `jsonb` the driver returns
  objects directly — so `SupabaseStore` SKIPS those parse/stringify steps. Keep the
  return SHAPE identical (parsed object, not a string).
- Username uniqueness is **case-insensitive** in SQLite (see the `LOWER()` index/
  lookup). Reproduce with a `citext` column or a unique index on `lower(username)`.

**The one real gotcha — sync vs async.** `SqliteStore` methods are SYNCHRONOUS;
the contract permits async, and callers already `await` (a no-op on a non-promise),
so a Promise-returning `SupabaseStore` works WITHOUT caller changes. Verify the
two hot paths still behave:

- `GameHost._loadCharacterInit` (join) — already inside an async message handler.
- `GameHost._saveCharacter` (level-up/equip/buy/disconnect) — fire-and-forget is
  fine, but make sure the **disconnect** save isn't dropped when the process is
  shutting down (await it, or flush on `SIGTERM`).
- `authApi.js` route handlers — already async; just `await` the store calls.

**Security parity to preserve:** login stays timing-safe against username
enumeration (compare a dummy hash when the user is missing — see `authApi.js`);
session tokens stay 32-byte `crypto.randomBytes` hex; bcrypt cost 10.

**Cutover:** decide migrate-rows vs. fresh-start at launch (likely fresh-start —
the dev `data/eb.db` is throwaway). Run the FULL flow against `SupabaseStore`
before going live: register → login → create char → play → level/equip → logout →
login → CONTINUE restores everything. The existing `store.test.js` /
`authApi.test.js` / `persistence.test.js` should pass against the new store with
only the `createStore` swap.

## Deferred (noted, not built)

- ROM-intake gate + real client-side ROM extraction (Pre-Launch section in TODO.md).
- OAuth/magic-link credential linking ("claim your account").
