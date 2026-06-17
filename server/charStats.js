/**
 * Character creation stats — the 5 allocatable stats and how they map onto the
 * server-authoritative EarthBound combat stats.
 *
 * The player allocates ALLOC_POINTS across 5 stats (each starts at STAT_MIN,
 * caps at STAT_MAX). This is the ONE place that build translates into mechanics:
 * `deriveCombatStats` turns {muscle,mental,spirit,speed,knowledge} into the
 * level-1 baseline for offense/defense/hp/pp/etc. Tune the formulas here.
 *
 * The save stores the raw `alloc` (the source of truth) + level/exp; combat
 * stats are RE-DERIVED on load (alloc + level), never trusted from the client.
 */

const STAT_KEYS = ['muscle', 'mental', 'spirit', 'speed', 'knowledge'];
const STAT_MIN = 1;
const STAT_MAX = 10;
const ALLOC_POINTS = 10; // points distributed BEYOND the 1-per-stat base
// Each stat starts at STAT_MIN, so a valid allocation sums to base + points.
const ALLOC_TOTAL = STAT_KEYS.length * STAT_MIN + ALLOC_POINTS; // 5 + 10 = 15

/** A balanced default (2 spare points on Muscle/Spirit) used as a fallback. */
function defaultAlloc() {
  return { muscle: 3, mental: 2, spirit: 3, speed: 3, knowledge: 4 };
}

/** True if `alloc` has all 5 keys, each in [MIN,MAX], summing to ALLOC_TOTAL. */
function validateAlloc(alloc) {
  if (!alloc || typeof alloc !== 'object') return false;
  let sum = 0;
  for (const k of STAT_KEYS) {
    const v = alloc[k];
    if (!Number.isInteger(v) || v < STAT_MIN || v > STAT_MAX) return false;
    sum += v;
  }
  return sum === ALLOC_TOTAL;
}

/** Coerce any value to a valid alloc (clamp + fall back to default if broken). */
function sanitizeAlloc(alloc) {
  if (validateAlloc(alloc)) {
    // Already valid — copy only the known keys.
    const out = {};
    for (const k of STAT_KEYS) out[k] = alloc[k];
    return out;
  }
  return defaultAlloc();
}

/**
 * Map the 5 creation stats -> level-1 EarthBound combat stats. Muscle = damage
 * + guts, Spirit = HP + armor + stamina + some guts, Speed = dodge, Mental = PSI
 * fuel, Knowledge = IQ + luck/crit. Numbers are deliberately gentle; they're the
 * level-1 baseline that the per-level GROWTH curve builds on.
 */
function deriveCombatStats(alloc) {
  const { muscle, mental, spirit, speed, knowledge } = alloc;
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

module.exports = {
  STAT_KEYS,
  STAT_MIN,
  STAT_MAX,
  ALLOC_POINTS,
  ALLOC_TOTAL,
  defaultAlloc,
  validateAlloc,
  sanitizeAlloc,
  deriveCombatStats,
};
