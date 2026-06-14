// Validates the hand-edited override files against their Zod schemas. This is
// the canary for a typo in public/overrides/*.json — a bad enemy stat, a missing
// spawner field, a malformed structure — caught here instead of at runtime in
// the browser. Add a schema + a case here whenever a new override file is hand-
// or editor-authored.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EnemySpawnsSchema } from '../src/data/overrideSchemas';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string) => JSON.parse(readFileSync(resolve(root, rel), 'utf8'));

describe('public/overrides/enemy_spawns.json', () => {
  const data = readJson('public/overrides/enemy_spawns.json');

  it('matches the EnemySpawns schema', () => {
    const result = EnemySpawnsSchema.safeParse(data);
    // Surface the precise path on failure instead of a bare boolean.
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
    expect(result.success).toBe(true);
  });

  // Sprite groups intentionally left without entity stats: dev placeholders with
  // no real EarthBound enemy mapped to that overworld sprite (they fall back to
  // DEFAULT_ENTITY_STATS). Mapping one to a real enemy = remove it from here.
  const KNOWN_UNMAPPED = new Set([107]);

  it('no spawner references an UNEXPECTED sprite that lacks entity stats', () => {
    const parsed = EnemySpawnsSchema.parse(data);
    const defined = new Set(Object.keys(parsed.entities).map(Number));
    const missing = [
      ...new Set(parsed.spawners.map((s) => s.sprite).filter((spr) => !defined.has(spr))),
    ].filter((spr) => !KNOWN_UNMAPPED.has(spr));
    // Fallback to defaults is legal, but an *unexpected* missing sprite usually
    // means the stats were forgotten — that's the regression this guards.
    expect(
      missing,
      `spawner sprites with no entity stats (not whitelisted): ${missing}`
    ).toHaveLength(0);
  });
});
