import manifest from '../data/sfxManifest.json';

// Door sound effects — the prepopulated set an admin assigns per door in the
// Placement Editor's Doors tab. Each plays once when the player uses the door
// (Game.startTransition -> playSfx).
//
// The catalogue is the real EarthBound SFX rip, imported by tools/import_sfx.py:
// audio -> public/assets/sfx/<id>.wav (ROM-derived, git-ignored, dev-only),
// metadata -> src/data/sfxManifest.json (OUR index, committed). We surface the
// door/movement sounds first, then the whole library (any SFX is selectable).
// On SNES these map to the sound engine's SFX IDs fired with the door animation.

export interface DoorSfxDef {
  id: string;
  label: string;
}

interface SfxEntry {
  id: string;
  num: number | null;
  label: string;
  file: string;
}

const SFX: SfxEntry[] = manifest as SfxEntry[];

// EarthBound has no distinct rope/ladder sound — those transitions are silent or
// reuse Stairs, so there's intentionally no 'rope' entry. The door/movement
// sounds we float to the top of the picker:
const PRIORITY = [
  'door-open',
  'door-close',
  'locked-door',
  'pyramid-door-opens',
  'stairs',
  'quick-stairs-cutscene',
  'falling',
  'pressure-plate',
  'eden-warp',
  'teleportation',
  'teleportation-end',
];

/** Default SFX for a door with no authored override — the common door open. */
export const DEFAULT_DOOR_SFX = 'door-open';

// 'none' first, then the prioritized door/movement sounds, then everything else.
export const DOOR_SFX: DoorSfxDef[] = (() => {
  const byId = new Map(SFX.map((s) => [s.id, s]));
  const out: DoorSfxDef[] = [{ id: 'none', label: 'None (silent)' }];
  const used = new Set<string>(['none']);
  for (const id of PRIORITY) {
    const s = byId.get(id);
    if (s && !used.has(id)) {
      out.push({ id: s.id, label: s.label });
      used.add(id);
    }
  }
  for (const s of SFX) {
    if (!used.has(s.id)) {
      out.push({ id: s.id, label: s.label });
      used.add(s.id);
    }
  }
  return out;
})();

const SFX_IDS = new Set(DOOR_SFX.map((s) => s.id));

/** Normalize a stored value to a known SFX id (legacy/blank/unknown -> default). */
export function normalizeDoorSfx(v: string | undefined | null): string {
  return v && SFX_IDS.has(v) ? v : DEFAULT_DOOR_SFX;
}

/** Human label for an SFX id (falls back to the raw id). */
export function doorSfxLabel(id: string): string {
  return DOOR_SFX.find((s) => s.id === id)?.label ?? id;
}
