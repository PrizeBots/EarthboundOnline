import names from '../data/spriteNames.json';
import { loadJSON } from './AssetLoader';

// Display names for ROM sprite groups (src/data/spriteNames.json — OUR
// authored metadata, shippable). The ROM stores no names; canonical cast
// names were anchored from each sprite's OWN placements (dialogue + location
// — see tools/debug_name_evidence.py); generic townsfolk/props carry
// descriptive names. Admin renames live in public/overrides/names.json
// (authored in the editor) and win over the baked table — both ship.

const TABLE = names as Record<string, string>;
let overrides: Record<string, string> = {};

export interface NameOverrides {
  version: number;
  names?: Record<string, string>;
}

/** Load admin renames; call once at startup (404 -> none). */
export async function loadNameOverrides(): Promise<void> {
  try {
    const ov = await loadJSON<NameOverrides>('/overrides/names.json');
    overrides = ov.names ?? {};
  } catch {
    overrides = {};
  }
}

export function getSpriteName(groupId: number): string | null {
  return overrides[String(groupId)] ?? TABLE[String(groupId)] ?? null;
}

/** Editor rename: empty/identical-to-base names clear the override. */
export function setSpriteNameOverride(groupId: number, name: string | null): void {
  const key = String(groupId);
  if (!name || name === TABLE[key]) delete overrides[key];
  else overrides[key] = name;
}

export function getNameOverrides(): NameOverrides {
  return { version: 1, names: overrides };
}
