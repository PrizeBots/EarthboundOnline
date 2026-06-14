// Zod schemas for the hand-edited override files in public/overrides/.
// These files are authored by hand and by the in-editor save channel, so a typo
// or a dropped field can silently break a load at runtime. Validating against
// these schemas turns "mystery crash" into a precise, located error.
//
// Keep EntityStatsSchema in sync with EntityStats (src/engine/EntityStats.ts).
// It is intentionally LOOSE: most fields are optional because file entries are
// partial (the runtime fills the rest from DEFAULT_ENTITY_STATS), and unknown
// keys are allowed so documentation extras (name/defense/money on enemies) and
// future fields don't fail validation.
import { z } from 'zod';

const EntityColSchema = z.object({
  w: z.number(),
  h: z.number(),
  offX: z.number(),
  offY: z.number(),
});

export const EntityStatsSchema = z
  .object({
    hp: z.number().nonnegative(),
    xp: z.number().nonnegative().optional(),
    level: z.number().optional(),
    damage: z.number().nonnegative().optional(),
    attackCooldownMs: z.number().positive().optional(),
    speed: z.number().optional(),
    detectRange: z.number().optional(),
    attackRange: z.number().optional(),
    col: EntityColSchema.optional(),
    combat: z.enum(['brave', 'skirmisher', 'coward', 'nervous']).optional(),
    // documentation extras kept on EarthBound enemies — not read by the runtime
    name: z.string().optional(),
    defense: z.number().optional(),
    money: z.number().optional(),
  })
  .catchall(z.unknown());

export const SpawnerSchema = z
  .object({
    name: z.string(),
    sprite: z.number().int(),
    x: z.number(),
    y: z.number(),
    wanderRadius: z.number().nonnegative(),
    poolSize: z.number().int().positive(),
    maxActive: z.number().int().nonnegative(),
    spawnIntervalMs: z.number().positive(),
    respawnDelayMs: z.number().nonnegative(),
    enabled: z.boolean(),
  })
  .catchall(z.unknown());

export const EnemySpawnsSchema = z.object({
  version: z.number(),
  enemySpriteGroups: z.array(z.number().int()),
  entities: z.record(z.string(), EntityStatsSchema),
  spawners: z.array(SpawnerSchema),
});

export type EnemySpawns = z.infer<typeof EnemySpawnsSchema>;
