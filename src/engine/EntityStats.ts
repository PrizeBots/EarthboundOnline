// Per-entity stats, keyed by sprite group id. Authored in the Entity Manager
// (editor) and stored in enemy_spawns.json under `entities`. Enemy spawners no
// longer carry these — they reference a sprite and inherit its entity stats, so
// every shark (etc.) shares one definition. The server (npcSim) applies them to
// spawned enemies; the client only needs `hp` for the health bar.
//
// KEEP DEFAULTS IN SYNC with server/npcSim.js (DEFAULT_ENEMY_* / ENEMY_*).

export interface EntityStats {
  hp: number;
  xp: number; // EXP a kill grants the player
  level: number; // drives the aggro/flee rules
  damage: number; // HP each landed hit takes off the player
  attackCooldownMs: number; // min time between this entity's swings
  speed: number; // wander move speed px/tick (chase scales from it)
}

/** sprite group id (as a string key) -> its stats. */
export type EntityDefs = Record<string, EntityStats>;

export const DEFAULT_ENTITY_STATS: EntityStats = {
  hp: 24,
  xp: 5,
  level: 4,
  damage: 7,
  attackCooldownMs: 700,
  speed: 0.7,
};

/** Stats for a sprite group: its authored entry, or the defaults. */
export function entityStatsFor(defs: EntityDefs | undefined | null, sprite: number): EntityStats {
  return { ...DEFAULT_ENTITY_STATS, ...(defs?.[String(sprite)] ?? {}) };
}
