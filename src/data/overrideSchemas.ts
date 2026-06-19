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
    attackRange: z.number().optional(),
    // Crit/dodge as percent points (0..100); server rolls them /100.
    crit: z.number().min(0).max(100).optional(),
    dodge: z.number().min(0).max(100).optional(),
    col: EntityColSchema.optional(),
    combat: z.enum(['brave', 'skirmisher', 'coward', 'nervous']).optional(),
    // documentation extras kept on EarthBound enemies — not read by the runtime
    name: z.string().optional(),
    defense: z.number().optional(),
    money: z.number().optional(),
    // Loot: item dropped on death + roll chance (ROM "Item Rarity"). Sourced from
    // the enemy catalog (enemies.json); the server rolls `rate` on each kill.
    drop: z
      .object({
        item: z.number().int(),
        itemName: z.string().optional(),
        rate: z.number().min(0).max(1),
        raw: z.string().optional(),
      })
      .optional(),
    // Drop TABLE: authored list of independent rolls. Each entry rolls vs its own
    // `rate` on death, so an enemy can drop several distinct items. When present it
    // supersedes the single `drop` above (which stays as the catalog default).
    drops: z
      .array(
        z.object({
          item: z.number().int(),
          itemName: z.string().optional(),
          rate: z.number().min(0).max(1),
        })
      )
      .optional(),
  })
  .catchall(z.unknown());

export const SpawnerSchema = z
  .object({
    name: z.string(),
    sprite: z.number().int(),
    x: z.number(),
    y: z.number(),
    wanderRadius: z.number().nonnegative(),
    detectRange: z.number().positive().optional(), // px aggro radius (per-spawner)
    giveUpRange: z.number().positive().optional(), // px locked-on chase break-off
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
