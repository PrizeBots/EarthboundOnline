/**
 * PlayerFlags — per-player progress state ("talked to Mom", "beat Frank").
 *
 * This is the runtime, mutable, PER-PLAYER counterpart to world_flags.json
 * (which is global, baked, open-world state shared by everybody). EarthBound's
 * single-player ROM keeps both in one global event-flag space; an MMO can't —
 * world state is shared, but quest progress is personal, so they split here.
 *
 * STORAGE: flags now live in the character's server save (gameHost.js persists
 * them in the `save` JSON, same as level/inventory). This module keeps an
 * in-memory Set for fast SYNCHRONOUS reads (every caller goes through
 * hasFlag/setFlag/clearFlag unchanged), hydrated from the server's `welcome`
 * (hydrateFlags) and mirrored back on every change through a registered SINK
 * (setFlagSink → Network.sendFlag). Writes are optimistic: we update the local
 * Set immediately and tell the server, which owns the persisted copy.
 *
 * Anonymous (dev / char-select) players have no save row, so the server keeps
 * their flags only for the session — they reset on reload, by design (flags
 * belong to a character, not a browser).
 *
 * NOTE: the server currently TRUSTS set/clear requests (it just stores them).
 * Validating the triggering event server-side (so a client can't fake quest
 * progress) is a later anti-cheat step; everything routes through this seam, so
 * that stays a backend change with no caller churn.
 *
 * Player-flag ids are minted in a high range (>= 900000) to stay clear of the
 * ROM event-flag numbers world flags use — same convention as authored textIds.
 */

let flags = new Set<number>();

type Listener = () => void;
const listeners = new Set<Listener>();

/** Mirror a flag change to the server (set via setFlagSink). null until wired. */
type FlagSink = (action: 'set' | 'clear' | 'reset', id?: number) => void;
let sink: FlagSink | null = null;

/** Register the network sink that persists flag changes server-side. */
export function setFlagSink(fn: FlagSink | null): void {
  sink = fn;
}

function notify(): void {
  for (const l of [...listeners]) l();
}

/**
 * Replace the local flag set with the server's authoritative copy (from the
 * `welcome` message). Does NOT echo back through the sink — this IS the server's
 * state. Call default-seeding (seedDefaults) AFTER this so a fresh character
 * still gets its default-on flags.
 */
export function hydrateFlags(ids: number[]): void {
  flags = new Set(ids.filter((n) => Number.isFinite(n)));
  notify();
}

/** Is this flag set for the current player? */
export function hasFlag(id: number): boolean {
  return flags.has(id);
}

/** Set a flag. Returns true if it changed (was previously clear). */
export function setFlag(id: number): boolean {
  if (flags.has(id)) return false;
  flags.add(id);
  sink?.('set', id);
  notify();
  return true;
}

/** Clear a flag. Returns true if it changed (was previously set). */
export function clearFlag(id: number): boolean {
  if (!flags.has(id)) return false;
  flags.delete(id);
  sink?.('clear', id);
  notify();
  return true;
}

/** All set flag ids (a snapshot). */
export function allFlags(): number[] {
  return [...flags];
}

/**
 * Seed default-on flags for a NEW player: set any id in `defaults` not already
 * present. Each seeded flag is pushed to the server (through setFlag) so it
 * persists. Only runs while the store is empty — i.e. a fresh character — so a
 * returning player's saved state is never re-seeded over (we can't distinguish
 * "never seen" from "deliberately cleared" with a bare Set). Call AFTER
 * hydrateFlags so server state wins. Good enough until the server owns defaults.
 */
export function seedDefaults(defaults: number[]): void {
  if (flags.size > 0) return; // returning character — don't re-seed over their state
  for (const id of defaults) setFlag(id); // setFlag persists each through the sink
}

/** Subscribe to flag changes (the Flag Editor's live-toggle redraws on this). */
export function onFlagsChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Dev: wipe all player flags (Flag Editor "reset progress"). */
export function resetFlags(): void {
  if (flags.size === 0) return;
  flags.clear();
  sink?.('reset');
  notify();
}
