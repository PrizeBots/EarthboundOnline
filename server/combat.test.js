/**
 * Combat resolution test for npcSim (server/npcSim.js) — covers the core game
 * loop's authoritative melee: hitbox overlap, exact damage, miss, death, and the
 * per-player cooldown. Dependency-free; run via `npm test`.
 *
 * Deterministic by construction: it reads a live enemy's real position through
 * npcSim.enemyState() and aims the swing using the documented hitbox geometry
 * (see npcSim.js: ATTACK_REACH/HALF, HURT_*). applyDamage only flips dirty flags
 * (the tick loop broadcasts), so handleAttack works WITHOUT start() — no timers,
 * no flakiness. npcSim installs a file watcher on construction, so we
 * process.exit() at the end.
 *
 * If the hitbox constants in npcSim.js change, update REACH/aim here to match —
 * a failure of "aimed attack deals exactly N damage" is the signal.
 */
const assert = require('assert');
const path = require('path');
const { createNpcSim } = require('./npcSim');

const ATTACK_REACH = 14; // px the hitbox sits in front of the attacker (npcSim.js)

// Place the attacker so its hitbox centre lands on the enemy's hurtbox. dir 3 is
// east [1,0] (DIR_VEC), so x = enemy.x - REACH puts the hitbox centre at enemy.x;
// y + 1 lines the 16px box up with the feet-anchored 14x18 hurtbox.
function aimAt(e) {
  return { x: e.x - ATTACK_REACH, y: e.y + 1, dir: 3 };
}

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

const sim = createNpcSim(path.join(__dirname, '..', 'public', 'assets'));
// Only fight enemies with a CLEAR line to the swing spot (no wall on the east
// side) — melee now respects walls, so an enemy standing flush against one would
// make a correctly-aimed swing miss. Filtering here keeps the damage tests about
// hitbox geometry, not map layout; the wall block has its own test below.
const allLive = sim.enemyState().filter((e) => !e.dead && e.hp > 0);
const live = allLive.filter((e) => !sim.wallBetween(e.x - ATTACK_REACH, e.y + 1, e.x, e.y));
const hpOf = (id) => sim.enemyState().find((e) => e.id === id);

check('enemyState() exposes live enemies to fight', () => {
  assert(live.length >= 4, `need >=4 clear-line live enemies, got ${live.length}`);
});

check('a correctly-aimed swing deals exactly `offense` damage', () => {
  const e = live[0];
  const a = aimAt(e);
  sim.handleAttack(a.x, a.y, a.dir, 'atk-dmg', 5, false);
  assert.strictEqual(hpOf(e.id).hp, e.maxHp - 5);
});

check('a swing aimed away misses (no damage)', () => {
  const e = live[1];
  sim.handleAttack(e.x + 500, e.y, 3, 'atk-miss', 5, false); // hitbox 500px away
  assert.strictEqual(hpOf(e.id).hp, e.maxHp);
});

check('a lethal swing kills the enemy (dead, hp 0)', () => {
  const e = live[2];
  const a = aimAt(e);
  sim.handleAttack(a.x, a.y, a.dir, 'atk-kill', e.maxHp + 10, false);
  const after = hpOf(e.id);
  assert.strictEqual(after.hp, 0);
  assert.strictEqual(after.dead, true);
});

check("a player's immediate second swing is gated by cooldown", () => {
  const e = live[3];
  const a = aimAt(e);
  sim.handleAttack(a.x, a.y, a.dir, 'atk-cd', 1, false); // lands: -1
  sim.handleAttack(a.x, a.y, a.dir, 'atk-cd', 1, false); // same player, within cooldown: ignored
  assert.strictEqual(hpOf(e.id).hp, e.maxHp - 1);
});

check('a swing through a wall deals no damage (no melee through walls)', () => {
  // Find a live enemy standing with a wall just to its east, then swing at it
  // from the far (open) side of that wall. The hitbox overlaps the enemy, but the
  // wall on the line must block the hit. Aim west (dir 2) from e.x + REACH.
  const blocked = allLive.find((e) => sim.wallBetween(e.x + ATTACK_REACH, e.y + 1, e.x, e.y));
  if (!blocked) {
    console.log('  skip a swing through a wall — no wall-adjacent enemy on this map');
    return;
  }
  const before = hpOf(blocked.id).hp;
  sim.handleAttack(blocked.x + ATTACK_REACH, blocked.y + 1, 2, 'atk-wall', 5, false);
  assert.strictEqual(hpOf(blocked.id).hp, before, 'wall should have blocked the swing');
});

check('wallBetween: adjacent actors are never wall-separated', () => {
  // Bodies within one minitile can never have a wall between them.
  assert.strictEqual(sim.wallBetween(100, 100, 104, 100), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
