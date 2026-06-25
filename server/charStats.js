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
// Progression rules (canonical home — gameHost imports these so the spend path and
// the load path agree). Each level banks POINTS_PER_LEVEL skill points; a single
// stat caps at STAT_SPEND_MAX when spending them.
const POINTS_PER_LEVEL = 1;
const STAT_SPEND_MAX = 99;

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

/** Coerce any value to a valid CREATION alloc (clamp + fall back to default if
 *  broken). Strict: sum must equal ALLOC_TOTAL (the 10-point creation spread). */
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
 * Sanitize a LOADED build allocation. Post-creation, stats GROW past the creation
 * spread as banked skill points are spent (spend_points), so a saved build's alloc
 * legitimately sums above ALLOC_TOTAL — `validateAlloc`/`sanitizeAlloc` (creation-
 * only) would wrongly reset it to default and silently wipe every spent point on
 * reload. This accepts a grown alloc as long as it's internally consistent for
 * `level`: every stat is an integer in [STAT_MIN, STAT_SPEND_MAX], and the points
 * spent beyond the 5-stat base don't exceed what a character of `level` could have
 * earned (ALLOC_POINTS at creation + POINTS_PER_LEVEL per level since). Anything
 * outside those bounds (corrupt / tampered / pre-feature) falls back to defaultAlloc
 * so a bad row can't grant impossible stats. createCharacter still uses the strict
 * `validateAlloc` for the creation spread; this is only the load path.
 */
function sanitizeBuild(alloc, level = 1) {
  if (!alloc || typeof alloc !== 'object') return defaultAlloc();
  const lvl = Number.isInteger(level) && level >= 1 ? level : 1;
  const earned = ALLOC_POINTS + (lvl - 1) * POINTS_PER_LEVEL; // spendable beyond base
  const out = {};
  let spent = 0;
  for (const k of STAT_KEYS) {
    const v = alloc[k];
    if (!Number.isInteger(v) || v < STAT_MIN || v > STAT_SPEND_MAX) return defaultAlloc();
    out[k] = v;
    spent += v - STAT_MIN; // points allocated above the base 1
  }
  if (spent > earned) return defaultAlloc(); // can't have spent more than earned
  return out;
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
    staminaMax: 40 + spirit * 5, // Spirit sets the pool size (run + attack fuel)
    staminaRegen: 6 + muscle * 1.5, // Muscle sets recharge rate (per second)
    // Passive PP regen (PP/sec). Mental + Spirit BOTH fuel it (ABILITIES.md §7): a
    // caster (Mental) recovers their own resource, and the recovery lane (Spirit)
    // adds sustain — so the Mental+Spirit battle-mage hybrid gets the best uptime
    // while a pure caster still runs dry mid-fight. Deliberately slow (small pools).
    ppRegen: 0.4 + mental * 0.05 + spirit * 0.05,
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
  POINTS_PER_LEVEL,
  STAT_SPEND_MAX,
  defaultAlloc,
  validateAlloc,
  sanitizeAlloc,
  sanitizeBuild,
  deriveCombatStats,
};
