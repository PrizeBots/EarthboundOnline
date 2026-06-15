/**
 * PlayerFlags — per-player progress state ("talked to Mom", "beat Frank").
 *
 * This is the runtime, mutable, PER-PLAYER counterpart to world_flags.json
 * (which is global, baked, open-world state shared by everybody). EarthBound's
 * single-player ROM keeps both in one global event-flag space; an MMO can't —
 * world state is shared, but quest progress is personal, so they split here.
 *
 * THE SEAM: today flags persist to localStorage (no DB/accounts exist yet — see
 * server/gameHost.js "No persistence yet"). For launch this MUST become
 * server-authoritative: the server validates the triggering event and owns the
 * write, or players fake progress by editing local storage. Everything that
 * *uses* flags goes through hasFlag/setFlag/clearFlag, so that migration is a
 * backend swap behind these functions — no caller changes.
 *
 * Player-flag ids are minted in a high range (>= 900000) to stay clear of the
 * ROM event-flag numbers world flags use — same convention as authored textIds.
 */

const STORAGE_KEY = 'eb_player_flags_v1';

let flags = new Set<number>();
let loaded = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const ids = JSON.parse(raw) as number[];
      if (Array.isArray(ids)) flags = new Set(ids.filter((n) => Number.isFinite(n)));
    }
  } catch (e) {
    console.warn('[PlayerFlags] load failed, starting empty', e);
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...flags]));
  } catch (e) {
    console.warn('[PlayerFlags] persist failed', e);
  }
}

function notify(): void {
  for (const l of [...listeners]) l();
}

/** Is this flag set for the current player? */
export function hasFlag(id: number): boolean {
  ensureLoaded();
  return flags.has(id);
}

/** Set a flag. Returns true if it changed (was previously clear). */
export function setFlag(id: number): boolean {
  ensureLoaded();
  if (flags.has(id)) return false;
  flags.add(id);
  persist();
  notify();
  return true;
}

/** Clear a flag. Returns true if it changed (was previously set). */
export function clearFlag(id: number): boolean {
  ensureLoaded();
  if (!flags.has(id)) return false;
  flags.delete(id);
  persist();
  notify();
  return true;
}

/** All set flag ids (a snapshot). */
export function allFlags(): number[] {
  ensureLoaded();
  return [...flags];
}

/**
 * Seed default-on flags for a NEW player: set any id in `defaults` that has
 * never been recorded. A flag the player has explicitly cleared stays cleared
 * (we can't distinguish "never seen" from "cleared" with a bare Set, so seeding
 * only runs while the store is empty — i.e. a fresh player). Good enough until
 * the server owns this; revisit when defaults must override per-player history.
 */
export function seedDefaults(defaults: number[]): void {
  ensureLoaded();
  if (flags.size > 0) return; // returning player — don't re-seed over their state
  let changed = false;
  for (const id of defaults)
    if (!flags.has(id)) {
      flags.add(id);
      changed = true;
    }
  if (changed) {
    persist();
    notify();
  }
}

/** Subscribe to flag changes (the Flag Editor's live-toggle redraws on this). */
export function onFlagsChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Dev: wipe all player flags (Flag Editor "reset progress"). */
export function resetFlags(): void {
  ensureLoaded();
  if (flags.size === 0) return;
  flags.clear();
  persist();
  notify();
}
