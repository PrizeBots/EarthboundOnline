/**
 * Tests for the character creation stat model (server/charStats.js):
 * allocation validation and the 5-stat -> combat-stat mapping.
 * Dependency-free harness; run with `npm test` (or `node server/charStats.test.js`).
 */
const assert = require('assert');
const {
  STAT_KEYS,
  ALLOC_TOTAL,
  defaultAlloc,
  validateAlloc,
  sanitizeAlloc,
  deriveCombatStats,
} = require('./charStats');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    fail++;
  }
}

check('there are exactly 5 stats', () => {
  assert.strictEqual(STAT_KEYS.length, 5);
});

check('defaultAlloc is valid and sums to ALLOC_TOTAL', () => {
  assert(validateAlloc(defaultAlloc()));
  const sum = STAT_KEYS.reduce((s, k) => s + defaultAlloc()[k], 0);
  assert.strictEqual(sum, ALLOC_TOTAL);
});

check('validateAlloc rejects an under-spent allocation', () => {
  assert.strictEqual(
    validateAlloc({ muscle: 1, mental: 1, spirit: 1, speed: 1, knowledge: 1 }),
    false
  );
});

check('validateAlloc rejects an over-spent allocation', () => {
  assert.strictEqual(
    validateAlloc({ muscle: 10, mental: 10, spirit: 10, speed: 10, knowledge: 10 }),
    false
  );
});

check('validateAlloc rejects out-of-range and non-integer values', () => {
  assert.strictEqual(
    validateAlloc({ muscle: 0, mental: 4, spirit: 4, speed: 4, knowledge: 3 }),
    false
  );
  assert.strictEqual(
    validateAlloc({ muscle: 2.5, mental: 4, spirit: 4, speed: 2, knowledge: 2.5 }),
    false
  );
  assert.strictEqual(
    validateAlloc({ muscle: 11, mental: 1, spirit: 1, speed: 1, knowledge: 1 }),
    false
  );
});

check('validateAlloc accepts a valid spread', () => {
  assert(validateAlloc({ muscle: 5, mental: 1, spirit: 4, speed: 2, knowledge: 3 }));
});

check('sanitizeAlloc passes valid input through and falls back on junk', () => {
  const good = { muscle: 5, mental: 1, spirit: 4, speed: 2, knowledge: 3 };
  assert.deepStrictEqual(sanitizeAlloc(good), good);
  assert(validateAlloc(sanitizeAlloc(null)));
  assert(validateAlloc(sanitizeAlloc({ muscle: 99 })));
});

check('sanitizeBuild keeps a GROWN (leveled) alloc instead of resetting it', () => {
  const { sanitizeBuild } = require('./charStats');
  // A level-50 caster who poured points into Mental: sum far above the creation 15.
  const grown = { muscle: 1, mental: 50, spirit: 9, speed: 1, knowledge: 1 }; // spent 58
  assert.deepStrictEqual(sanitizeBuild(grown, 50), grown, 'grown alloc survives load');
  // The OLD creation-strict path would have wiped it back to the default spread.
  assert.notDeepStrictEqual(sanitizeAlloc(grown), grown);
});

check('sanitizeBuild rejects over-spent / corrupt allocs (anti-cheat floor)', () => {
  const { sanitizeBuild } = require('./charStats');
  const def = defaultAlloc();
  // Spent more than a level-2 character could have earned (11 base points only).
  assert.deepStrictEqual(
    sanitizeBuild({ muscle: 1, mental: 50, spirit: 1, speed: 1, knowledge: 1 }, 2),
    def
  );
  // Out-of-range / non-integer stats fall back too.
  assert.deepStrictEqual(
    sanitizeBuild({ muscle: 0, mental: 1, spirit: 1, speed: 1, knowledge: 1 }, 9),
    def
  );
  assert.deepStrictEqual(sanitizeBuild(null, 9), def);
});

check('deriveCombatStats produces integers and is monotonic in the right stat', () => {
  const lowMuscle = deriveCombatStats({ muscle: 1, mental: 3, spirit: 4, speed: 3, knowledge: 4 });
  const hiMuscle = deriveCombatStats({ muscle: 10, mental: 3, spirit: 4, speed: 3, knowledge: 1 });
  // Per-second REGEN RATES are floats by design (e.g. staminaRegen 1.5/Muscle,
  // ppRegen 0.05/Mental+Spirit); only the displayed combat stats must be integers.
  const RATE_FIELDS = new Set(['staminaRegen', 'ppRegen']);
  for (const [k, v] of Object.entries(hiMuscle)) {
    if (RATE_FIELDS.has(k)) continue;
    assert(Number.isInteger(v), `non-integer stat: ${v}`);
  }
  assert(hiMuscle.offense > lowMuscle.offense, 'more Muscle -> more offense');
  assert(hiMuscle.maxHp > lowMuscle.maxHp, 'more Muscle -> more HP');
});

check('Knowledge drives iq/luck, Mental drives pp', () => {
  const lo = deriveCombatStats({ muscle: 3, mental: 1, spirit: 3, speed: 4, knowledge: 1 });
  const hi = deriveCombatStats({ muscle: 3, mental: 10, spirit: 3, speed: 1, knowledge: 1 });
  assert(hi.ppMax > lo.ppMax, 'more Mental -> more PP');
  const hiK = deriveCombatStats({ muscle: 3, mental: 1, spirit: 3, speed: 1, knowledge: 7 });
  assert(hiK.iq > lo.iq && hiK.luck > lo.luck, 'more Knowledge -> more iq + luck');
});

check('PP regen scales with BOTH Mental and Spirit (ABILITIES.md §7)', () => {
  const base = deriveCombatStats({ muscle: 4, mental: 1, spirit: 1, speed: 5, knowledge: 4 });
  const hiMental = deriveCombatStats({ muscle: 4, mental: 6, spirit: 1, speed: 1, knowledge: 3 });
  const hiSpirit = deriveCombatStats({ muscle: 4, mental: 1, spirit: 6, speed: 1, knowledge: 3 });
  assert(hiMental.ppRegen > base.ppRegen, 'more Mental -> more PP regen');
  assert(hiSpirit.ppRegen > base.ppRegen, 'more Spirit -> more PP regen');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
