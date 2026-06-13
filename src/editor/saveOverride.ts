// Client half of the dev-only save-back channel (EDITOR_TOOLS.md). The write
// endpoint is Vite dev-server middleware — it does not exist in production
// builds or on the deployed express server, so editor saves cannot ship by
// construction. Writes land in public/overrides/<name>: OUR authored data
// (never ROM-derived), applied on top of fresh extraction so re-running the
// pipeline never clobbers authoring.

import { primeJSONCache } from '../engine/AssetLoader';

export async function saveOverride(name: string, data: unknown): Promise<void> {
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
