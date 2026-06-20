// Validates the hand-edited override files against their Zod schemas. This is
// the canary for a typo in public/overrides/*.json — a bad enemy stat, a missing
// spawner field, a malformed structure — caught here instead of at runtime in
// the browser. Add a schema + a case here whenever a new override file is hand-
// or editor-authored.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EnemySpawnsSchema, NpcOverridesSchema } from '../src/data/overrideSchemas';

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

describe('public/overrides/npcs.json', () => {
  it('matches the NpcOverrides schema (incl. per-instance props)', () => {
    let data: unknown;
    try {
      data = readJson('public/overrides/npcs.json');
    } catch {
      return; // no authored placements yet — nothing to validate
    }
    const result = NpcOverridesSchema.safeParse(data);
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
    expect(result.success).toBe(true);
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

  // Sprite groups with a spawner but NO stats anywhere — no canon entry in the ROM
  // enemy catalog AND no authored override. They fall back to DEFAULT_ENTITY_STATS.
  // 107 is an overworld sprite with no EarthBound enemy mapped to it. Map one to a
  // real enemy (or author stats in the Entity Manager) = remove it from here.
  const KNOWN_UNMAPPED = new Set([107]);

  // Canon ROM stats live in the enemy catalog (enemies.json `bySprite`), keyed by
  // overworld sprite id. The runtime applies them UNDER any override
  // (DEFAULT < catalog < entities), so a catalog sprite is fully statted without an
  // `entities` entry. Read defensively — the asset file may be absent in a build
  // that doesn't commit public/assets.
  const catalogSprites = (() => {
    try {
      const cat = readJson('public/assets/map/enemies.json') as {
        bySprite?: Record<string, unknown>;
      };
      return new Set(Object.keys(cat.bySprite ?? {}).map(Number));
    } catch {
      return new Set<number>();
    }
  })();

  it('every spawner sprite has stats (catalog or authored), else is whitelisted', () => {
    const parsed = EnemySpawnsSchema.parse(data);
    const statted = new Set([...Object.keys(parsed.entities).map(Number), ...catalogSprites]);
    const missing = [...new Set(parsed.spawners.map((s) => s.sprite))].filter(
      (spr) => !statted.has(spr) && !KNOWN_UNMAPPED.has(spr)
    );
    expect(
      missing,
      `spawner sprites with no stats anywhere (catalog/entities/whitelist): ${missing}`
    ).toHaveLength(0);
  });
});
