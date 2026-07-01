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
const { createNpcSim, resolveMelee } = require('./npcSim');

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

// Inject a deterministic RNG that never dodges and never crits (0.99 * 100 = 99,
// above every default chance), so the geometry/damage assertions below stay
// exact. resolveMelee's own dodge/crit branches are unit-tested separately.
const sim = createNpcSim(path.join(__dirname, '..', 'public', 'assets'), () => 0.99);
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

// --- Ranged-weapon projectiles (fire → fly → resolve over ticks) ---

check('a ranged shot flies forward, hits once for exactly `offense`, then is spent', () => {
  // A full-hp enemy with a clear line 40px to its west — well beyond the 14px
  // melee reach, so only a flying shot can connect.
  const e = live.find(
    (c) => hpOf(c.id).hp === c.maxHp && !sim.wallBetween(c.x - 40, c.y + 1, c.x, c.y)
  );
  if (!e) {
    console.log('  skip ranged shot — no fresh clear-line enemy left on this map');
    return;
  }
  const before = hpOf(e.id).hp;
  // handleAttack args after `range`: attackerLevel, projSpeed, pierce, projSprite.
  // range 120 reaches; projSpeed 8 px/tick. A melee swing from here would whiff.
  sim.handleAttack(
    e.x - 40,
    e.y + 1,
    3,
    'proj-atk',
    4,
    false,
    0,
    1,
    null,
    120,
    1,
    8,
    false,
    'bullet'
  );
  assert.strictEqual(
    hpOf(e.id).hp,
    before,
    'launch alone deals no damage — the shot must fly first'
  );
  // Fly it forward. It should connect within a handful of ticks (40/8 ≈ 5), then
  // be consumed; extra ticks must NOT keep damaging (no lingering/double-hit).
  for (let t = 0; t < 40; t++) sim.stepProjectiles(Date.now());
  assert.strictEqual(hpOf(e.id).hp, before - 4, 'the shot connected exactly once for its offense');
});

// --- Crit / dodge resolution (resolveMelee, pure + deterministic) ---

check('resolveMelee: a normal swing deals exactly base damage', () => {
  const r = resolveMelee(0, 0, 10, () => 0.5);
  assert.deepStrictEqual(r, { miss: false, crit: false, dmg: 10 });
});

check('resolveMelee: a dodge is a clean miss (0 damage)', () => {
  // dodge 100% → the first roll (any value) is under 100, so it misses.
  const r = resolveMelee(0, 100, 10, () => 0.0);
  assert.strictEqual(r.miss, true);
  assert.strictEqual(r.dmg, 0);
});

check('resolveMelee: a crit deals CRIT_MULT (2x) base damage', () => {
  // dodge 0 (never), crit 100% → rolls into the crit branch.
  const r = resolveMelee(100, 0, 10, () => 0.0);
  assert.strictEqual(r.crit, true);
  assert.strictEqual(r.dmg, 20);
});

check('resolveMelee: dodge is rolled BEFORE crit (a dodge wins)', () => {
  // Both at 100%: dodge resolves first, so the swing misses (no crit).
  const r = resolveMelee(100, 100, 10, () => 0.0);
  assert.strictEqual(r.miss, true);
  assert.strictEqual(r.crit, false);
});

check('handleAttack: a forced crit (crit=100) deals double damage', () => {
  // Re-read live enemies (earlier checks killed/dented some); find a fresh one.
  const e = sim
    .enemyState()
    .find(
      (n) => !n.dead && n.hp === n.maxHp && !sim.wallBetween(n.x - ATTACK_REACH, n.y + 1, n.x, n.y)
    );
  assert(e, 'need a full-HP clear-line enemy');
  const a = aimAt(e);
  // crit=100 with the sim's 0.99 rng: dodge(4%) whiffs, crit fires → 2x.
  sim.handleAttack(a.x, a.y, a.dir, 'atk-crit', 3, false, 100);
  assert.strictEqual(hpOf(e.id).hp, e.maxHp - 6, 'crit should deal 2x the 3 base');
});

// --- Enemy ability (PSI) spec sanitizer ---
check('parseAbilities keeps + clamps authored enemy casts, drops empties', () => {
  const out = sim._test.parseAbilities([
    {
      anim: 'psi_fire_alpha',
      range: 240,
      cooldownMs: 2600,
      damage: 20,
      inflict: [{ type: 'burn', chance: 35, dotDmg: 3, dotMs: 900 }],
    },
    {
      anim: 'hypnosis_alpha',
      range: 99999,
      cooldownMs: 10,
      damage: 0,
      inflict: [{ type: 'sleep', chance: 70 }],
    }, // range clamps, cd floors, 0-dmg OK (has inflict)
    { damage: 0, inflict: [] }, // dropped: does nothing
    { range: 100 }, // dropped: no damage, no inflict
  ]);
  assert.strictEqual(out.length, 2, 'two real abilities survive');
  assert.strictEqual(out[0].damage, 20);
  assert.strictEqual(out[0].inflict[0].type, 'burn');
  assert.strictEqual(out[1].range, 600, 'range clamps to the cap');
  assert.strictEqual(out[1].cooldownMs, 300, 'cooldown floors to the min');
  assert.strictEqual(out[1].damage, 0, 'a pure-status cast (0 dmg) is allowed');
});

check('parseAbilities accepts all PSI modes (heal/shield/buff/debuff/magnet)', () => {
  const out = sim._test.parseAbilities([
    { anim: 'lifeup_alpha', mode: 'heal', heal: 80 },
    { anim: 'shield_alpha', mode: 'shield', shieldKind: 'physical', shieldHits: 6 },
    { anim: 'offense_up_alpha', mode: 'buff', buffStat: 'offense', buffAmt: 20 },
    { anim: 'defense_down_alpha', mode: 'debuff', debuffStat: 'defense', debuffAmt: 15 },
    { anim: 'psi_magnet_alpha', mode: 'magnet', drainPp: 10 },
    { anim: 'x', mode: 'heal', heal: 0 }, // dropped: heal does nothing
  ]);
  assert.strictEqual(out.length, 5, 'the five real casts survive; empty heal dropped');
  assert.strictEqual(out[0].mode, 'heal');
  assert.strictEqual(out[0].heal, 80);
  assert.strictEqual(out[1].shieldKind, 'physical');
  assert.strictEqual(out[1].shieldHits, 6);
  assert.strictEqual(out[2].buffAmt, 20);
  assert.strictEqual(out[3].debuffAmt, 15);
  assert.strictEqual(out[4].drainPp, 10);
});

// --- PvP melee (player-vs-player, PK-gated) ---
// Drive handleAttack against a synthetic player roster supplied through start()'s
// getPlayers. start() arms the tick timer, but its setInterval callback can't
// interleave our synchronous checks, so this stays deterministic; process.exit()
// at the end clears it.
let pvpRoster = [];
const pvpHits = []; // {targetId, dmg, byId} captured from onPlayerHit
sim.start(
  () => pvpRoster,
  () => {}, // broadcast (combat crit/miss events) — ignored here
  () => {}, // onEnemyHit
  () => {}, // onEnemyKill
  (targetId, dmg, byId, knock, inflict) => pvpHits.push({ targetId, dmg, byId, knock, inflict })
);

// Attacker A swings EAST from 14px west of B (spawn street: walkable, open), so
// the hitbox centre lands on B's hurtbox.
const BX = 1296;
const BY = 1168;
const AX = BX - ATTACK_REACH;
const AY = BY;
const roster = (aPk, bPk) => [
  { id: 'A', x: AX, y: AY, hp: 60, pk: aPk, dodge: 0, editor: false },
  { id: 'B', x: BX, y: BY, hp: 60, pk: bPk, dodge: 0, editor: false },
];

check('PvP: a PK attacker hits a non-PK target', () => {
  pvpHits.length = 0;
  pvpRoster = roster(true, false);
  sim.handleAttack(AX, AY, 3, 'A', 5, true, 0);
  const h = pvpHits.find((x) => x.targetId === 'B');
  assert(h && h.dmg === 5, `expected B hit for 5, got ${JSON.stringify(pvpHits)}`);
});

check('PvP: a non-PK attacker CANNOT hit a non-PK target', () => {
  pvpHits.length = 0;
  pvpRoster = roster(false, false);
  sim.handleAttack(AX, AY, 3, 'A2', 5, false, 0);
  assert(!pvpHits.some((x) => x.targetId === 'B'), 'non-PK must not hit a non-PK player');
});

check('PvP: anyone hurts a PKer (non-PK attacker vs PK target)', () => {
  pvpHits.length = 0;
  pvpRoster = roster(false, true);
  sim.handleAttack(AX, AY, 3, 'A3', 5, false, 0);
  assert(
    pvpHits.some((x) => x.targetId === 'B' && x.dmg === 5),
    'should hit the PKer'
  );
});

check('knockback: a landed hit shoves the victim away from the attacker', () => {
  // A is due WEST of B and swings east; B must be knocked further east (x up),
  // never past the cap, and clamped to a real (walkable) spot by the sim.
  pvpHits.length = 0;
  pvpRoster = roster(true, false);
  sim.handleAttack(AX, AY, 3, 'KB', 5, true, 0); // fresh id — 'A' is mid-cooldown
  const h = pvpHits.find((x) => x.targetId === 'B');
  assert(h && h.knock, `expected a knockback spot, got ${JSON.stringify(h)}`);
  assert(h.knock.x > BX, `victim should be pushed east (x ${h.knock.x} > ${BX})`);
  assert(Math.abs(h.knock.y - BY) <= 1, 'a due-west hit pushes straight east, not sideways');
  assert(h.knock.x - BX <= 44, 'knockback never exceeds the KB_MAX cap');
});

check('PvP: a swing never hits the attacker themselves', () => {
  pvpHits.length = 0;
  pvpRoster = [{ id: 'A4', x: BX, y: BY, hp: 60, pk: true, dodge: 0, editor: false }];
  sim.handleAttack(AX, AY, 3, 'A4', 5, true, 0);
  assert(!pvpHits.some((x) => x.targetId === 'A4'), 'must never self-hit');
});

// --- Status inflict model (data-sourced specs) ---
// The swing carries a status-inflict spec from its source (the equipped weapon,
// via gameHost). handleAttack forwards it to the victim path verbatim; omitting
// it falls back to the baseline paralysis proc. These check the SPEC threading
// (deterministic — no rng/vuln); the proc roll + immunity live in status.test.js.
const PLAYER_PARALYSIS_CHANCE = 12; // mirror npcSim.js; baseline when none authored

check('inflict model: a swing carries its weapon spec to the victim', () => {
  pvpHits.length = 0;
  pvpRoster = roster(true, false);
  const spec = [{ type: 'sleep', chance: 50 }];
  sim.handleAttack(AX, AY, 3, 'WI', 5, true, 0, 1, spec); // fresh id (cooldown)
  const h = pvpHits.find((x) => x.targetId === 'B');
  assert.deepStrictEqual(h && h.inflict, spec, 'victim should receive the authored spec');
});

check('inflict model: no spec falls back to baseline paralysis', () => {
  pvpHits.length = 0;
  pvpRoster = roster(true, false);
  sim.handleAttack(AX, AY, 3, 'WI2', 5, true, 0); // no inflict arg → default
  const h = pvpHits.find((x) => x.targetId === 'B');
  assert.deepStrictEqual(
    h && h.inflict,
    [{ type: 'paralysis', chance: PLAYER_PARALYSIS_CHANCE }],
    'an unauthored weapon keeps the baseline paralysis proc'
  );
});

check('inflict model: an empty spec carries NO status', () => {
  pvpHits.length = 0;
  pvpRoster = roster(true, false);
  sim.handleAttack(AX, AY, 3, 'WI3', 5, true, 0, 1, []); // weapon authored as no-proc
  const h = pvpHits.find((x) => x.targetId === 'B');
  assert.deepStrictEqual(h && h.inflict, [], 'an empty spec means no status proc');
});

check('inflict model: normalizeInflict sanitizes authored data', () => {
  const { normalizeInflict } = require('./status');
  assert.deepStrictEqual(
    normalizeInflict([
      { type: 'sleep', chance: 30 }, // kept
      { type: 'bogus', chance: 50 }, // unknown status → dropped
      { type: 'poison', chance: 0 }, // non-positive → dropped
      { type: 'paralysis', chance: 250 }, // clamped to 100
      'garbage', // non-object → dropped
    ]),
    [
      { type: 'sleep', chance: 30 },
      { type: 'paralysis', chance: 100 },
    ]
  );
  assert.deepStrictEqual(normalizeInflict(null), [], 'non-array → []');
});

// End-to-end proc: with an rng that always rolls 0, a carried status actually
// lands on an enemy (applyDamage → tryStatus → the actor's status set). A fresh
// sim so the always-proc rng doesn't taint the geometry sim above.
check('inflict model: a carried status lands on a struck enemy', () => {
  const simP = createNpcSim(path.join(__dirname, '..', 'public', 'assets'), () => 0);
  const targets = simP
    .enemyState()
    .filter((e) => !e.dead && e.hp > 0 && !simP.wallBetween(e.x - ATTACK_REACH, e.y + 1, e.x, e.y));
  let applied = false;
  for (const e of targets) {
    const a = aimAt(e);
    // offense 1 so the enemy SURVIVES (the inflict only rolls on a non-lethal
    // hit — a kill takes the death branch). chance 100 + rng 0 → procs on any
    // target not fully paralysis-immune.
    simP.handleAttack(a.x, a.y, a.dir, `IP-${e.id}`, 1, false, 0, 1, [
      { type: 'paralysis', chance: 100 },
    ]);
    const st = simP.enemyState().find((x) => x.id === e.id);
    if (st && st.statuses && st.statuses.paralysis) {
      applied = true;
      break;
    }
  }
  assert(applied, 'expected the carried paralysis to land on at least one enemy');
});

// --- Directional PSI cone: traveling projectile fan (psiStrikeCone) -----------
check('psiStrikeCone: a traveling pellet deals its flat damage to an enemy in its path', () => {
  const e = sim
    .enemyState()
    .find((x) => !x.dead && x.hp >= 12 && !sim.wallBetween(x.x - 60, x.y, x.x, x.y));
  assert(e, 'need a clear-line live enemy for the cone');
  const before = e.hp;
  const DMG = 7;
  // Straight cone (spread 0 → ONE pellet) fired from 50px west, east at the enemy.
  // Flat damage (no dodge/crit), so it lands exactly DMG once the shot reaches it.
  sim.psiStrikeCone(
    e.x - 50,
    e.y,
    1,
    0,
    200,
    0,
    DMG,
    'cone',
    [],
    false,
    1,
    4,
    'psi:psi_fire_alpha'
  );
  const now = Date.now();
  for (let i = 0; i < 40; i++) sim.stepProjectiles(now); // fly the pellet through the enemy
  const after = sim.enemyState().find((x) => x.id === e.id).hp;
  assert.strictEqual(before - after, DMG, 'cone pellet deals exactly its flat damage, once');
});

// --- Lag compensation: rewind an enemy to what the attacker saw ---------------
// The hit TEST uses a rewound position so a fleeing target you aimed at still
// connects; damage/knockback still apply to the live enemy. These unit-test the
// rewind primitives (histPosAt/recordHist) directly — the pure novel logic.
const { recordHist, histPosAt } = sim._lagComp;

check('histPosAt: no history → live position', () => {
  const n = { x: 50, y: 60 };
  const p = histPosAt(n, 1000);
  assert.strictEqual(p.x, 50);
  assert.strictEqual(p.y, 60);
});

check('histPosAt: a timestamp newer than newest sample → live position', () => {
  const n = { x: 50, y: 60, _hist: [1000, 10, 10, 1100, 20, 20] };
  const p = histPosAt(n, 2000); // future → live
  assert.strictEqual(p.x, 50);
  assert.strictEqual(p.y, 60);
});

check('histPosAt: interpolates between two samples', () => {
  const n = { x: 999, y: 999, _hist: [1000, 0, 0, 1100, 100, 200] };
  const p = histPosAt(n, 1050); // halfway → (50, 100)
  assert.strictEqual(Math.round(p.x), 50);
  assert.strictEqual(Math.round(p.y), 100);
});

check('histPosAt: a timestamp older than oldest sample → clamps to oldest', () => {
  const n = { x: 999, y: 999, _hist: [1000, 7, 8, 1100, 100, 200] };
  const p = histPosAt(n, 500);
  assert.strictEqual(p.x, 7);
  assert.strictEqual(p.y, 8);
});

check('recordHist: appends samples and evicts beyond the 500ms window', () => {
  const n = { x: 5, y: 5 };
  recordHist(n, 1000); // x/y = 5,5
  n.x = 6;
  n.y = 6;
  recordHist(n, 1200);
  n.x = 7;
  n.y = 7;
  recordHist(n, 1600); // 1000 is now >500ms older than 1600 → evicted
  assert.strictEqual(n._hist.length, 6, 'expected 2 samples (6 numbers)');
  assert.strictEqual(n._hist[0], 1200, 'oldest sample should be 1200, not 1000');
});

check('lag-comp scenario: a fled enemy rewinds to where it was seen', () => {
  // Enemy was at (100,100) 100ms ago, now fled to (400,100). A swing aimed at
  // where the attacker SAW it must rewind to (100,100), not the live (400,100).
  const now = 100000;
  const n = { x: 400, y: 100, _hist: [now - 100, 100, 100, now, 400, 100] };
  const rewound = histPosAt(n, now - 100);
  assert.strictEqual(rewound.x, 100, 'rewound to where it was seen');
  assert.notStrictEqual(n.x, rewound.x, 'live position has moved on');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
