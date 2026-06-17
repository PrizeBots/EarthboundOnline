/**
 * Client-side mirror of the server's stat derivation (server/charStats.js
 * `deriveCombatStats`). The server stays authoritative — this is ONLY for live
 * UI previews (the level-up spend pentagon shows what your build becomes before
 * you confirm). KEEP THE FORMULAS IN SYNC WITH server/charStats.js.
 *
 * Maps the 5 creation stats {muscle,mental,spirit,speed,knowledge} -> the
 * level-1 EarthBound combat baseline. Per-level growth is added on top by the
 * server; previews cancel that term by working from the current displayed value
 * plus the derivation DELTA, so the level multiplier never needs to be known.
 */

export interface DerivedStats {
  maxHp: number;
  ppMax: number;
  offense: number;
  defense: number;
  speed: number;
  guts: number;
  vitality: number;
  iq: number;
  luck: number;
}

export function deriveCombatStats(alloc: Record<string, number>): DerivedStats {
  const muscle = alloc.muscle ?? 0;
  const mental = alloc.mental ?? 0;
  const spirit = alloc.spirit ?? 0;
  const speed = alloc.speed ?? 0;
  const knowledge = alloc.knowledge ?? 0;
  return {
    maxHp: 30 + muscle + spirit * 5, // Spirit primary; Muscle only a little
    ppMax: 2 + mental * 2,
    offense: (3 + muscle * 1.5) | 0,
    defense: (1 + spirit * 1.2) | 0,
    speed: (3 + speed * 1.2) | 0,
    guts: (2 + muscle + spirit * 0.5) | 0, // Muscle primary, Spirit half-weight
    vitality: 2 + spirit,
    iq: (3 + knowledge * 1.2) | 0,
    luck: 3 + knowledge,
  };
}
