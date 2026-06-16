/**
 * FlagRegistry — the authored catalog of every flag (public/overrides/flags.json).
 *
 * This is the data the Flag Editor tool manages: each flag's id, human name,
 * scope, default, and description. It is metadata only — the live per-player
 * state lives in PlayerFlags, and global open-world state in world_flags.json.
 * The registry exists so flags have names ("met_mom") instead of bare numbers,
 * so the tool can list/search them, and so new players get their defaults.
 *
 * The file is absent until the admin authors the first flag — load tolerates
 * that and leaves the catalog empty.
 */

export type FlagScope = 'player' | 'world';

export interface FlagDef {
  /** Player flags mint >= 900000 (clear of ROM numbers); world flags reuse
   *  the ROM event-flag numbers (stored as numbers here). */
  id: number;
  name: string;
  scope: FlagScope;
  /** New players start with this value (player scope); world default state. */
  default?: boolean;
  desc?: string;
}

interface FlagsFile {
  version: number;
  flags?: FlagDef[];
}

let registry: FlagDef[] = [];
const byId = new Map<number, FlagDef>();
const byName = new Map<string, FlagDef>();

function reindex(): void {
  byId.clear();
  byName.clear();
  for (const f of registry) {
    byId.set(f.id, f);
    byName.set(f.name, f);
  }
}

/**
 * Load the catalog. Call once at startup (Game.startGame). Default-on player
 * flags are NOT seeded here — that must happen AFTER the server's `welcome`
 * hydrates the saved flags (else a fresh seed would be overwritten). The game
 * seeds them in onFlags using getPlayerDefaultFlags(). World flags are never
 * seeded into PlayerFlags — they belong to the global world layer.
 */
export async function loadFlagRegistry(): Promise<void> {
  const file = await fetch('/overrides/flags.json')
    .then((r) => (r.ok ? (r.json() as Promise<FlagsFile>) : null))
    .catch(() => null);
  registry = file?.flags ?? [];
  reindex();
}

/** Ids of default-on PLAYER flags — seeded into a fresh character after hydrate. */
export function getPlayerDefaultFlags(): number[] {
  return registry.filter((f) => f.scope === 'player' && f.default).map((f) => f.id);
}

/** Replace the in-memory catalog (the Flag Editor calls this after an edit). */
export function setFlagRegistry(flags: FlagDef[]): void {
  registry = flags.slice();
  reindex();
}

export function flagDefs(): FlagDef[] {
  return registry;
}

export function flagById(id: number): FlagDef | undefined {
  return byId.get(id);
}

export function flagByName(name: string): FlagDef | undefined {
  return byName.get(name);
}

/** Display label for a flag id — its name, or the bare id if uncatalogued. */
export function flagLabel(id: number): string {
  return byId.get(id)?.name ?? `#${id}`;
}
