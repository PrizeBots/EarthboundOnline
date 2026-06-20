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

// The SHARED entity-property shape (EntityProps, src/engine/EntityStats.ts) —
// every field optional so it serves BOTH the sprite-group `entities` table AND
// the sparse per-instance override (a placement's `props`). The resolver fills
// absent fields from the layer beneath. Keep this body in sync with EntityProps.
const entityPropsShape = {
  hp: z.number().nonnegative().optional(),
  xp: z.number().nonnegative().optional(),
  level: z.number().optional(),
  damage: z.number().nonnegative().optional(),
  attackCooldownMs: z.number().positive().optional(),
  speed: z.number().optional(),
  attackRange: z.number().optional(),
  // Behavior ranges (resolvable per-instance / per-spawner).
  detectRange: z.number().positive().optional(), // px aggro radius
  giveUpRange: z.number().positive().optional(), // px locked-on chase break-off
  wanderRadius: z.number().nonnegative().optional(), // px roam radius (0 = stationary)
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
};

/** Sparse shared-property override — used for per-instance `props` (npcs.json). */
export const EntityPropsSchema = z.object(entityPropsShape).catchall(z.unknown());

/** Sprite-group entity-table entry: same shape, but `hp` is required (the table
 *  is the stat baseline). KEEP IN SYNC with EntityStats (src/engine/EntityStats.ts). */
export const EntityStatsSchema = z
  .object({ ...entityPropsShape, hp: z.number().nonnegative() })
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
  entities: z.record(z.string(), EntityPropsSchema), // sparse authored deltas
  spawners: z.array(SpawnerSchema),
});

export type EnemySpawns = z.infer<typeof EnemySpawnsSchema>;

// One placement row in npcs.json (a base-entry edit or an addition). LOOSE: only
// the structural fields are checked; unknown keys pass (catchall). `props` is the
// sparse per-instance override. KEEP IN SYNC with RawNPC (src/engine/NPCManager.ts).
const RawNpcSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    sprite: z.number().int(),
    dir: z.number().int(),
    kind: z.string(),
    t: z.number().optional(),
    props: EntityPropsSchema.optional(),
  })
  .catchall(z.unknown());

// Editor-authored placement overrides (public/overrides/npcs.json). `edits` maps
// a base entry's key to a replacement row or null (delete); `additions` are
// net-new placements. All optional so a minimal/empty file validates.
export const NpcOverridesSchema = z.object({
  version: z.number().optional(),
  edits: z.record(z.string(), RawNpcSchema.nullable()).optional(),
  additions: z.array(RawNpcSchema).optional(),
});

export type NpcOverridesFile = z.infer<typeof NpcOverridesSchema>;
