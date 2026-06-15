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

1. `Store` interface + `SqliteStore` + schema/migrations.
2. Auth API + sessions.
3. Client TITLE + AUTH overlay.
4. Character slots: create (START) + list/select (CONTINUE).
5. Wire save read on join / write on change+disconnect; move flags into the save.
6. Document the Supabase migration seam.

## Migration to Supabase (at MVP launch)

- Add a `SupabaseStore` implementing the same `Store` interface; swap the impl, keep the
  game server for the real-time sim (Supabase can't run the authoritative loop).
- SQLite tables map 1:1 to Postgres; JSON cols → `jsonb`.
- Migrate existing rows or have users re-register (decide at launch). Test the full flow
  before going live.

## Deferred (noted, not built)

- ROM-intake gate + real client-side ROM extraction (Pre-Launch section in TODO.md).
- OAuth/magic-link credential linking ("claim your account").
