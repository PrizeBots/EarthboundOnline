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

check('deriveCombatStats produces integers and is monotonic in the right stat', () => {
  const lowMuscle = deriveCombatStats({ muscle: 1, mental: 3, spirit: 4, speed: 3, knowledge: 4 });
  const hiMuscle = deriveCombatStats({ muscle: 10, mental: 3, spirit: 4, speed: 3, knowledge: 1 });
  for (const v of Object.values(hiMuscle)) assert(Number.isInteger(v), `non-integer stat: ${v}`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
