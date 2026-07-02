// Client half of the dev-only save-back channel (EDITOR_TOOLS.md). The write
// endpoint is Vite dev-server middleware — it does not exist in production
// builds or on the deployed express server, so editor saves cannot ship by
// construction. Writes land in public/overrides/<name>: OUR authored data
// (never ROM-derived), applied on top of fresh extraction so re-running the
// pipeline never clobbers authoring.

import { primeJSONCache } from '../engine/AssetLoader';
import type { ZodType } from 'zod';
import { NpcOverridesSchema, EnemySpawnsSchema, EntitiesFileSchema } from '../data/overrideSchemas';

// Validate BEFORE writing: a tool bug must throw here (surfaced to the tool's
// save UI), not corrupt the authored file on disk. Files without a schema yet
// pass through — add entries as schemas land (TODO.md "Zod schemas for the
// other hand-edited overrides").
const OVERRIDE_SCHEMAS: Record<string, ZodType> = {
  'npcs.json': NpcOverridesSchema,
  'enemy_spawns.json': EnemySpawnsSchema,
  'entities.json': EntitiesFileSchema,
};

export async function saveOverride(name: string, data: unknown): Promise<void> {
  const schema = OVERRIDE_SCHEMAS[name];
  if (schema) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(
        `saveOverride(${name}): invalid data at ${first.path.join('.') || '(root)'} — ${first.message}`
      );
    }
  }
  const res = await fetch('/__editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`saveOverride(${name}): ${res.status} ${await res.text()}`);
  }
  // loadJSON caches override files by URL; refresh the entry so any live
  // re-apply (e.g. DoorManager.loadDoors) and the next editor open read the
  // data we just wrote instead of the stale game-start cache.
  primeJSONCache(`/overrides/${name}`, data);
}

/** Load an override file (404 -> null: nothing authored yet). */
export async function loadOverride<T>(name: string): Promise<T | null> {
  const res = await fetch(`/overrides/${name}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as T;
}
