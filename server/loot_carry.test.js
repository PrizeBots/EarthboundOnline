/**
 * loot_carry.test.js — enemies/townsfolk pick up ground item drops (carry-capped)
 * and eject their whole haul when they die.
 *
 * Drives npcSim directly (no socket): spawnItemDrop drops loot on the world,
 * pickupByActors runs one pickup pass, enemyState() exposes each enemy's
 * `carried` list, and handleAttack lands a lethal swing to test the death eject.
 */
const path = require('path');
const assert = require('assert');
const { createNpcSim } = require('./npcSim');

const ATTACK_REACH = 14; // px the hitbox sits in front of the attacker (npcSim.js)
const ACTOR_CARRY_CAP = 2; // mirror of npcSim's cap (keep in sync)
const ITEM = 1; // any catalog item id — we only track the drop, not its stats
const aimAt = (e) => ({ x: e.x - ATTACK_REACH, y: e.y + 1, dir: 3 }); // dir 3 = east

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

// rng 0.99 → never dodge, never crit (matches combat.test.js), so a lethal swing
// lands cleanly and loot rolls are irrelevant to these carry assertions.
const sim = createNpcSim(path.join(__dirname, '..', 'public', 'assets'), () => 0.99);
const liveEnemies = () => sim.enemyState().filter((e) => !e.dead && e.hp > 0);
const totalCarried = () => sim.enemyState().reduce((sum, e) => sum + e.carried.length, 0);
const groundItems = () => sim.dropsSnapshot().filter((d) => d.kind === 'item').length;

check('an actor grabs a ground item it stands on', () => {
  const e = liveEnemies()[0];
  assert(e, 'need a live enemy');
  const carriedBefore = totalCarried();
  const itemsBefore = groundItems();
  sim.spawnItemDrop(e.x, e.y, ITEM, 'Test Item'); // lands on the enemy, immediately claimable
  assert.strictEqual(groundItems(), itemsBefore + 1, 'drop appeared on the ground');
  sim.pickupByActors(Date.now());
  assert.strictEqual(totalCarried(), carriedBefore + 1, 'an actor took it into its haul');
  assert.strictEqual(groundItems(), itemsBefore, 'the ground drop was claimed');
});

check('no actor carries more than the cap', () => {
  const e = liveEnemies()[0];
  // Pile far more than the cap on one spot, then run several pickup passes.
  for (let i = 0; i < ACTOR_CARRY_CAP + 3; i++) sim.spawnItemDrop(e.x, e.y, ITEM, 'Pile');
  for (let i = 0; i < 5; i++) sim.pickupByActors(Date.now());
  const over = sim.enemyState().find((a) => a.carried.length > ACTOR_CARRY_CAP);
  assert(!over, `an actor exceeded the cap (${over && over.carried.length})`);
});

check('a dying actor ejects its whole haul back onto the ground', () => {
  // Find a carrying enemy with a clear swing line (so the lethal blow lands).
  const carrier = sim
    .enemyState()
    .find(
      (e) =>
        !e.dead &&
        e.hp > 0 &&
        e.carried.length > 0 &&
        !sim.wallBetween(e.x - ATTACK_REACH, e.y + 1, e.x, e.y)
    );
  if (!carrier) {
    console.log('  skip eject test — no clear-line carrying enemy on this map');
    return;
  }
  const haul = carrier.carried.length;
  const itemsBefore = groundItems();
  const a = aimAt(carrier);
  sim.handleAttack(a.x, a.y, a.dir, 'kill-carrier', carrier.maxHp + 50, false);
  const after = sim.enemyState().find((e) => e.id === carrier.id);
  assert.strictEqual(after.dead, true, 'the carrier died');
  assert.strictEqual(after.carried.length, 0, 'its haul was emptied');
  assert.strictEqual(groundItems(), itemsBefore + haul, 'the haul dropped back to the ground');
});

// --- Townsfolk USE the loot they carry (enemies never do) ------------------

const COOKIE = 88; // GOODS heal item (6 HP); Cracked bat (weapon, +4 off) = 17
const WEAPON = 17;

check('a hurt townsperson uses a healing item', () => {
  const n = sim._test.townsfolk()[0];
  if (!n) {
    console.log('  skip heal test — no townsfolk on this map');
    return;
  }
  n.carried = [{ item: COOKIE, name: 'Cookie' }];
  n.hp = 1; // badly hurt
  sim._test.useCarried(n);
  assert(n.hp > 1, 'healing item restored HP');
  assert.strictEqual(n.carried.length, 0, 'the heal item was consumed');
});

check('a healthy townsperson does NOT waste a heal', () => {
  const n = sim._test.townsfolk()[0];
  if (!n) return;
  n.carried = [{ item: COOKIE, name: 'Cookie' }];
  n.hp = n.maxHp; // full HP
  sim._test.useCarried(n);
  assert.strictEqual(n.carried.length, 1, 'kept the heal item for when it is needed');
});

check('a townsperson equips a looted weapon (more swing damage)', () => {
  const n = sim._test.townsfolk()[0];
  if (!n) return;
  n.carried = [{ item: WEAPON, name: 'Cracked bat' }];
  n.equipped = [];
  n.weaponBonus = 0;
  n.hp = n.maxHp;
  sim._test.useCarried(n);
  assert(n.weaponBonus > 0, 'weapon offense raised the actor swing damage');
  assert.strictEqual(n.carried.length, 0, 'weapon moved out of the loose carry');
  assert.strictEqual(n.equipped.length, 1, 'weapon is now equipped (drops on death)');
  assert.strictEqual(String(n.itemId), String(WEAPON), 'held weapon sprite set');
});

check('a dying townsperson drops both carried AND equipped gear', () => {
  const n = sim._test.townsfolk().find((t) => !t.dead && t.hp > 0);
  if (!n) {
    console.log('  skip eject-equipped test — no live townsperson');
    return;
  }
  n.carried = [{ item: COOKIE, name: 'Cookie' }];
  n.equipped = [{ item: WEAPON, name: 'Cracked bat' }];
  n.weaponBonus = 4;
  n.itemId = String(WEAPON);
  const itemsBefore = groundItems();
  sim._test.damage(n, n.maxHp + 50); // lethal
  assert.strictEqual(n.dead, true, 'the townsperson died');
  assert.strictEqual(groundItems(), itemsBefore + 2, 'both items dropped to the ground');
  assert.strictEqual(n.carried.length + n.equipped.length, 0, 'haul + gear cleared');
  assert.strictEqual(n.weaponBonus, 0, 'weapon bonus reset for respawn');
  assert.strictEqual(n.itemId, null, 'held sprite cleared');
});

check('equipSnapshot exposes a townsperson held weapon to late joiners', () => {
  const n = sim._test.townsfolk().find((t) => !t.dead && t.hp > 0);
  if (!n) return;
  n.carried = [{ item: WEAPON, name: 'Cracked bat' }];
  n.equipped = [];
  n.weaponBonus = 0;
  n.itemId = null;
  n.hp = n.maxHp;
  sim._test.useCarried(n); // equips the weapon → sets itemId
  const row = sim.equipSnapshot().find((r) => r[0] === n.id);
  assert(row, 'snapshot includes the armed townsperson');
  assert.strictEqual(String(row[1]), String(WEAPON), 'snapshot carries the held weapon id');
  // Dead actors are not advertised as armed.
  sim._test.damage(n, n.maxHp + 50);
  assert(
    !sim.equipSnapshot().some((r) => r[0] === n.id),
    'a dead actor is dropped from the snapshot'
  );
});

console.log(`\nloot_carry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
