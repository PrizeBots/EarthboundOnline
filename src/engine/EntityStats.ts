// Per-entity stats, keyed by sprite group id. Authored in the Entity Manager
// (editor) and stored in enemy_spawns.json under `entities`. Enemy spawners no
// longer carry these — they reference a sprite and inherit its entity stats, so
// every shark (etc.) shares one definition. The server (npcSim) applies them to
// spawned enemies; the client only needs `hp` for the health bar.
//
// KEEP DEFAULTS IN SYNC with server/npcSim.js (DEFAULT_ENEMY_* / ENEMY_*).

// Collision box for a sprite group, authored in the Entity Manager. The box is
// anchored on the entity's position (center-x / feet-y): it's `w` wide centered
// on x (shifted by offX), `h` tall with its BOTTOM at y+offY (so offY 0 = box
// sits on the feet, like the foot box). When a sprite group has no `col`, the
// runtime falls back to its kind default — the full sprite rect for cars, the
// 14x8 foot box for people/enemies — so unconfigured entities are unchanged.
export interface EntityCol {
  w: number;
  h: number;
  offX: number;
  offY: number;
}

// How a townsperson (sprite group) maneuvers when an enemy threatens it. Server
// only (npcSim drives the behavior); assigned per entity in the Entity Manager.
// KEEP IN SYNC with server/npcSim.js COMBAT_PERSONALITIES.
export type CombatPersonality = 'brave' | 'skirmisher' | 'coward' | 'nervous';

// Editor-facing labels + blurbs for the personality dropdown (order = dropdown
// order). 'default' means "leave unassigned" — npcSim then seeds a pick by id.
export const COMBAT_PERSONALITY_OPTIONS: { value: CombatPersonality | ''; label: string }[] = [
  { value: '', label: 'default (seeded mix)' },
  { value: 'brave', label: 'brave — close in & press' },
  { value: 'skirmisher', label: 'skirmisher — hit & run' },
  { value: 'coward', label: 'coward — flee, swing if cornered' },
  { value: 'nervous', label: 'nervous — swing & shuffle' },
];

export interface EntityStats {
  hp: number;
  xp: number; // EXP a kill grants the player
  level: number; // drives the aggro/flee rules
  damage: number; // HP each landed hit takes off the player
  attackCooldownMs: number; // min time between this entity's swings
  speed: number; // wander move speed px/tick (chase scales from it)
  // Aggro radius (detectRange) and chase give-up distance (giveUpRange) are NOT
  // here: they're PER-SPAWNER (Enemy Spawner tool), so two spawners of the same
  // sprite can have different alertness/pursuit. See EnemySpawnerTool.
  attackRange: number; // px — enemy must be this close to land a hit
  // Crit/dodge are PERCENT integers (0..100): crit = chance this entity's swing
  // does CRIT_MULT damage (SMAAAASH); dodge = chance it evades an incoming hit
  // (the attacker "just misses"). Equipped gear adds to a player's values; here
  // they're the entity's BASE. Resolved server-side in npcSim (rolls /100).
  crit: number;
  dodge: number;
  col?: EntityCol; // authored collision box; absent = kind default (see EntityCol)
  combat?: CombatPersonality; // townsfolk threat behavior; absent = seeded default (npcSim)
}

/** sprite group id (as a string key) -> its stats. */
export type EntityDefs = Record<string, EntityStats>;

/** Authored collision box for a sprite group, or null to use the kind default. */
export function entityColFor(
  defs: EntityDefs | undefined | null,
  sprite: number
): EntityCol | null {
  return defs?.[String(sprite)]?.col ?? null;
}

export const DEFAULT_ENTITY_STATS: EntityStats = {
  hp: 24,
  xp: 5,
  level: 4,
  damage: 7,
  attackCooldownMs: 700,
  speed: 0.7,
  attackRange: 24,
  crit: 4, // % — KEEP IN SYNC with npcSim DEFAULT_ENEMY_CRIT
  dodge: 4, // % — KEEP IN SYNC with npcSim DEFAULT_ENEMY_DODGE
};

/** Stats for a sprite group: its authored entry, or the defaults. */
export function entityStatsFor(defs: EntityDefs | undefined | null, sprite: number): EntityStats {
  return { ...DEFAULT_ENTITY_STATS, ...(defs?.[String(sprite)] ?? {}) };
}
