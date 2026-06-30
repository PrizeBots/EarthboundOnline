'use strict';
// Pure combat math, extracted from npcSim.js (Phase 2 modularization). Stateless
// helpers + the tuning constants they own — no engine/world/closure state, so
// they're trivially unit-testable and safe to share. npcSim.js requires these
// back, which keeps a SINGLE source of truth for the constants the tick code also
// reads (e.g. KB_MAX, used in the knockback slide).

const CRIT_MULT = 2; // a crit (SMAAAASH!) deals double damage

// Knockback distance from raw damage: KB_PER_DMG px per point, clamped to
// [KB_MIN, KB_MAX]. e.g. 1→2px, 7→14px, capped at 44 so a big/crit hit can't
// fling a victim across the room. No flat floor (KB_MIN 0): a 0-damage (fully
// blocked) hit doesn't shove at all.
const KB_MIN = 0; // px — no minimum
const KB_MAX = 44; // px — cap so a big/crit hit can't fling across the room
const KB_PER_DMG = 2; // px of knockback per point of damage dealt
function knockDist(dmg) {
  return Math.max(KB_MIN, Math.min(KB_MAX, dmg * KB_PER_DMG));
}

// --- Mass / weight class (level-driven push + knockback resistance) ---
// Every actor AND player carries a `mass` derived from its level: heavier things
// shove lighter ones aside on contact (walk-push) and resist being knocked back.
// EQUAL mass reproduces the old behavior exactly (full knockback), so a fair
// same-level fight is unchanged — only a level GAP creates asymmetry. A per-entity
// `mass` override wins over the curve.
const MASS_PER_LEVEL = 1; // mass = 1 + level*this; level 2 → 3, level 12 → 13
function massOf(a) {
  if (a && typeof a.mass === 'number' && a.mass > 0) return a.mass;
  const lvl = a && typeof a.level === 'number' ? a.level : 1;
  return 1 + Math.max(0, lvl) * MASS_PER_LEVEL;
}
// Knockback scale from the attacker/victim mass ratio. Equal mass → 1 (UNCHANGED).
// Returns 1 when either mass is missing (vehicle / legacy / test callers) so their
// tuned knockback is untouched.
const KB_MASS_FLOOR = 0.15; // a featherweight attacker still nudges a heavy victim a little
const KB_MASS_CEIL = 2.0; // cap the bonus a heavyweight gets vs a gnat (final dist still ≤ KB_MAX)
function massKnockScale(attMass, vicMass) {
  if (!(attMass > 0) || !(vicMass > 0)) return 1;
  return Math.max(KB_MASS_FLOOR, Math.min(KB_MASS_CEIL, (2 * attMass) / (attMass + vicMass)));
}

// --- Level-gap flee gate (EarthBound's "weak enemies flee you") ---
// An enemy whose level a nearby player at least DOUBLES will not chase/attack —
// it flees, and a touch from that player is an instant win.
const FLEE_LEVEL_RATIO = 2; // player.level >= ratio * enemy.level → enemy flees
function outLevels(player, n) {
  return player && player.level != null && player.level >= FLEE_LEVEL_RATIO * (n.level || 1);
}

// --- Pose -> wire code, indexing POSES in src/types.ts: walk,climb,attack,hurt.
// Broadcast in npc_update rows so every client sees the same animation pose.
const POSE_CODE = { walk: 0, climb: 1, attack: 2, hurt: 3 };
function poseCode(n) {
  return POSE_CODE[n.pose] || 0;
}

// --- Geometry ---
function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// 2D distance. Replaces Math.hypot at every call site: hypot is variadic and
// does overflow-safe scaling, which makes it ~2-20x slower than a plain sqrt for
// the same result. Our coords are bounded (0..~10k px) so dx*dx+dy*dy never
// approaches Float64 overflow — the safety hypot pays for buys us nothing here.
// V8 inlines this. Result is identical to within a ULP.
function hyp(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

// --- PK (player-kill) damage model — the single source of truth for "can A
// hurt B". Every combatant carries a `pk` flag: enemies are always pk:true,
// townsfolk NPCs pk:false, players pk:false for now (a per-player toggle is
// backlogged; see TODO). `isEnemy` distinguishes the AI mobs from people.
//
// Rules (attacker -> who it can damage):
//   - Enemies hurt every non-enemy (NPCs, players, PK players) but NEVER each
//     other.
//   - PK players hurt EVERYTHING, including other PKers and enemies.
//   - Non-PK players and NPCs hurt only PKers (PK players + enemies), so two
//     non-PKers can't friendly-fire each other.
// Pass plain {isEnemy, pk} shapes — players live on the host, not in npcSim, so
// the host builds an attacker shape from its own player record.
function canHurt(attacker, target) {
  if (!attacker || !target || attacker === target) return false;
  if (attacker.isEnemy) return !target.isEnemy; // enemies hurt all non-enemies
  if (attacker.pk) return true; // PK players hurt everything
  return !!target.pk; // others hurt only PKers
}

/**
 * Resolve one landed melee swing's outcome, independent of geometry (the caller
 * already confirmed the hitbox connects). Order matters: DODGE is rolled FIRST
 * (a dodge beats a would-be crit), then CRIT. `critChance`/`dodgeChance` are
 * percentages (0..100); `rng()` returns [0, 1). Pure + injectable-rng so combat
 * is deterministically testable (see combat.test.js).
 */
function resolveMelee(critChance, dodgeChance, base, rng) {
  if (rng() * 100 < dodgeChance) return { miss: true, crit: false, dmg: 0 };
  if (rng() * 100 < critChance) return { miss: false, crit: true, dmg: base * CRIT_MULT };
  return { miss: false, crit: false, dmg: base };
}

module.exports = {
  CRIT_MULT,
  KB_MIN,
  KB_MAX,
  KB_PER_DMG,
  MASS_PER_LEVEL,
  KB_MASS_FLOOR,
  KB_MASS_CEIL,
  FLEE_LEVEL_RATIO,
  POSE_CODE,
  knockDist,
  massOf,
  massKnockScale,
  outLevels,
  poseCode,
  rand,
  aabb,
  hyp,
  canHurt,
  resolveMelee,
};
