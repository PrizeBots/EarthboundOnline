// Validates the hand-edited override files against their Zod schemas. This is
// the canary for a typo in public/overrides/*.json — a bad enemy stat, a missing
// spawner field, a malformed structure — caught here instead of at runtime in
// the browser. Add a schema + a case here whenever a new override file is hand-
// or editor-authored.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EnemySpawnsSchema } from '../src/data/overrideSchemas';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string) => JSON.parse(readFileSync(resolve(root, rel), 'utf8'));

/** Recursively list every .ts file under `dir` (skips node_modules). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...tsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Every override file an editor tool writes MUST be on vite.config.ts's
// OVERRIDE_ALLOW list, or the dev-server save channel 400s ("unknown override
// file") and edits silently fail to persist. This drift is easy to introduce
// (add a saveOverride call, forget the allowlist) and invisible until you try to
// save — so assert the two stay in lockstep at test time.
describe('editor save channel allowlist', () => {
  it('every saveOverride() filename is on vite.config OVERRIDE_ALLOW', () => {
    // Extract the allowlisted filenames from the OVERRIDE_ALLOW Set literal.
    const cfg = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    const block = cfg.match(/OVERRIDE_ALLOW\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    if (!block) throw new Error('Could not find OVERRIDE_ALLOW in vite.config.ts');
    const allow = new Set([...block[1].matchAll(/['"]([^'"]+\.json)['"]/g)].map((m) => m[1]));

    // Collect every literal saveOverride('x.json', …) call site under src/.
    const saved = new Set<string>();
    for (const file of tsFiles(resolve(root, 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/saveOverride\(\s*['"]([^'"]+\.json)['"]/g)) saved.add(m[1]);
    }

    const missing = [...saved].filter((f) => !allow.has(f)).sort();
    expect(missing, `saveOverride targets missing from OVERRIDE_ALLOW: ${missing}`).toHaveLength(0);
  });
});

describe('public/overrides/enemy_spawns.json', () => {
  const data = readJson('public/overrides/enemy_spawns.json');

  it('matches the EnemySpawns schema', () => {
    const result = EnemySpawnsSchema.safeParse(data);
    // Surface the precise path on failure instead of a bare boolean.
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
    expect(result.success).toBe(true);
  });

  // Sprite groups with a spawner but no authored entity stats yet — they run on
  // DEFAULT_ENTITY_STATS until someone gives them real HP/level/etc. in the Entity
  // Manager (which writes enemy_spawns.json `entities`). Authoring stats for one =
  // remove it from here. The bulk below are editor-placed spawners pending stats.
  const KNOWN_UNMAPPED = new Set([
    101, 107, 195, 274, 276, 277, 278, 279, 280, 285, 286, 287, 288, 289, 290, 292, 294, 296, 297,
    298, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 311, 312, 313, 314, 315, 316, 318, 319,
    320, 322, 323, 324, 325, 326, 327, 328, 329, 331, 332, 364, 386, 387, 388, 389, 390, 391, 392,
    413, 415, 416, 417, 444, 461,
  ]);

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
