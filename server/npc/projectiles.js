'use strict';
// Ranged-shot subsystem, extracted from npcSim.js (Phase 2 modularization).
// A ranged weapon (handleAttack with range > 0) — or a traveling PSI cone/bolt —
// launches a projectile that marches forward a few px each tick. It damages the
// first target its small hitbox overlaps — or EVERY new target, if it pierces —
// through the same resolveMelee / applyDamage path a melee swing uses, then is
// spent (or flies on, piercing) until it hits a wall or reaches its max range.
// Server-authoritative: clients only render the shot from the `projectile`
// broadcast and clear it on `proj_end`. See src/engine/Projectiles.ts.
//
// Owns ONLY the in-flight shot list; all world/actor state stays in npcSim and
// arrives through `deps`. The enemy/vehicle arrays are REASSIGNED on override
// reloads and the host callbacks are wired in start(), so those deps are
// ACCESSOR functions read late, per call — never captured once.
const { aabb, hyp, canHurt, resolveMelee } = require('./combatMath');

const PROJ_HALF = 5; // shot hitbox half-size (px)
const PROJ_DEFAULT_SPEED = 6; // px/tick when a weapon authors no projSpeed
const PROJ_KNOCK_BEHIND = 20; // knockback source sits this far behind the shot
const PROJ_MUZZLE_RISE = 10; // shot flies at chest height (feet - this); see the muzzle in handleAttack

function createProjectiles(deps) {
  const {
    rng, // injectable RNG (tests pass a fixed fn for deterministic crit/dodge)
    consts: { COL_H, HURT_W, HURT_H, HURT_OY },
    blocked, // world collision: solid-tile test (npc/world.js)
    actorBox, // vehicle hurtbox (per-entity col override aware)
    massOf, // npcSim's re-export (combatMath) — passed so mass rules stay single-sourced
    applyDamage, // full damage pipeline (knockback/status/XP/loot) — stays in npcSim
    knockbackPlayerSpot,
    emitCombat, // shared hit/miss/crit combat-event broadcast
    broadcast, // (msg) => void; drops the message before start() wires the socket fan-out
    enemies, // () => live enemy array
    vehicles, // () => live vehicle array
    players, // () => player snapshots ([] before start())
    onPlayerHit, // (targetPlayerId, dmg, byPlayerId, knockSpot, inflict) → GameHost.damagePlayer
    pvpReady, // () => true once the host PvP callbacks are wired (start())
  } = deps;

  let projectiles = [];
  let projSeq = 0;

  function spawnProjectile(o) {
    const len = hyp(o.vx, o.vy) || 1;
    const p = {
      id: ++projSeq,
      x: o.x,
      y: o.y,
      vx: o.vx / len, // unit direction
      vy: o.vy / len,
      speed: o.speed > 0 ? o.speed : PROJ_DEFAULT_SPEED,
      traveled: 0,
      maxDist: o.maxDist,
      base: o.base,
      critChance: o.critChance,
      attacker: o.attacker,
      attackerId: o.attackerId,
      attackerMass: o.attackerMass,
      inflict: o.inflict,
      pierce: !!o.pierce,
      // Flat damage (no dodge/crit roll), e.g. a PSI cone — matches the old instant
      // psiStrikeLine which applied `dmg` directly.
      flat: !!o.flat,
      // Hit-tracking sets. A fan of pellets (a PSI cone) shares ONE set so the whole
      // cast damages each target once, no matter how many pellets overlap it.
      hit: o.sharedHit || new Set(), // actors already damaged (piercing never double-hits)
      hitPlayers: o.sharedHitPlayers || new Set(),
    };
    projectiles.push(p);
    broadcast({
      type: 'projectile',
      id: p.id,
      byPlayer: p.attackerId,
      x: Math.round(p.x),
      y: Math.round(p.y),
      vx: p.vx,
      vy: p.vy,
      speed: p.speed,
      dist: p.maxDist,
      sprite: o.sprite || null,
      pierce: p.pierce,
    });
    return p;
  }

  function endProjectile(p, hit) {
    broadcast({
      type: 'proj_end',
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      hit: !!hit,
    });
  }

  // Resolve overlaps at the shot's current position. Damages each NEW target
  // (tracked per-shot, so a piercing shot never hits the same body twice) using
  // the swing resolution. Returns true if a NON-piercing shot connected and
  // should now be consumed.
  function projectileHits(p, playerList, now) {
    const bx = p.x - PROJ_HALF;
    const by = p.y - PROJ_HALF;
    const bw = PROJ_HALF * 2;
    const bh = PROJ_HALF * 2;
    // Knock targets along the shot's travel direction: place the knockback source
    // just BEHIND the projectile (pushActor / knockbackPlayerSpot shove away from it).
    const kx = p.x - p.vx * PROJ_KNOCK_BEHIND;
    const ky = p.y - p.vy * PROJ_KNOCK_BEHIND;
    for (const n of enemies()) {
      if (n.dead || p.hit.has(n)) continue;
      if (!canHurt(p.attacker, n)) continue;
      if (!aabb(bx, by, bw, bh, n.x - HURT_W / 2, n.y + HURT_OY, HURT_W, HURT_H)) continue;
      p.hit.add(n);
      const res = resolveMelee(p.critChance, p.flat ? 0 : n.dodge || 0, p.base, rng);
      if (res.miss) {
        emitCombat('miss', n.x, n.y, p.attackerId, null);
        if (!p.pierce) return true;
        continue;
      }
      applyDamage(n, res.dmg, now, p.attackerId, {
        x: kx,
        y: ky,
        amass: p.attackerMass,
        inflict: p.inflict,
      });
      emitCombat('hit', p.x, p.y, p.attackerId, null, res.dmg);
      if (res.crit) emitCombat('crit', n.x, n.y, p.attackerId, null);
      if (!p.pierce) return true;
    }
    // Vehicles (traffic cars + Entity Manager vehicles): no dodge, no status proc.
    for (const n of vehicles()) {
      if (n.dead || n.hp <= 0 || p.hit.has(n)) continue;
      if (!canHurt(p.attacker, n)) continue;
      const [vbx, vby, vbw, vbh] = actorBox(n, n.x, n.y);
      if (!aabb(bx, by, bw, bh, vbx, vby, vbw, vbh)) continue;
      p.hit.add(n);
      const res = resolveMelee(p.critChance, 0, p.base, rng);
      if (res.miss) {
        emitCombat('miss', n.x, n.y, p.attackerId, null);
        if (!p.pierce) return true;
        continue;
      }
      applyDamage(n, res.dmg, now, p.attackerId, { x: kx, y: ky, inflict: [] });
      emitCombat('hit', p.x, p.y, p.attackerId, null, res.dmg);
      if (res.crit) emitCombat('crit', n.x, n.y, p.attackerId, null);
      if (!p.pierce) return true;
    }
    // PvP: a shot lands on other players the PK rules allow (host owns their HP).
    if (pvpReady()) {
      for (const t of playerList) {
        if (t.id === p.attackerId || t.editor) continue;
        if (t.hp !== undefined && t.hp <= 0) continue;
        if (p.hitPlayers.has(t.id)) continue;
        if (!canHurt(p.attacker, { isEnemy: false, pk: t.pk })) continue;
        if (!aabb(bx, by, bw, bh, t.x - HURT_W / 2, t.y + HURT_OY, HURT_W, HURT_H)) continue;
        p.hitPlayers.add(t.id);
        const res = resolveMelee(p.critChance, p.flat ? 0 : t.dodge || 0, p.base, rng);
        if (res.miss) {
          emitCombat('miss', t.x, t.y, p.attackerId, t.id);
          if (!p.pierce) return true;
          continue;
        }
        onPlayerHit(
          t.id,
          res.dmg,
          p.attackerId,
          knockbackPlayerSpot(t.x, t.y, kx, ky, res.dmg, {
            amass: p.attackerMass,
            vmass: massOf(t),
          }),
          p.inflict
        );
        emitCombat('hit', p.x, p.y, p.attackerId, t.id, res.dmg);
        if (res.crit) emitCombat('crit', t.x, t.y, p.attackerId, t.id);
        if (!p.pierce) return true;
      }
    }
    return false;
  }

  // True if the shot at (x,y) is inside a solid collision tile. The shot flies at
  // chest height, but WALLS are solid on the ground plane — so we test the SAME
  // foot-line band a walking body collides against (blocked / COL_*), shifting the
  // sample down by the muzzle rise. A small box (PROJ_HALF wide, COL_H tall) means
  // even a one-minitile-thick wall stops the bullet. This is why a shot collides
  // with exactly the walls a player can't walk through. (wallBetween samples at
  // foot height too, but offset for actor-to-actor LoS — wrong for a chest-high shot.)
  function projBlocked(x, y) {
    const footY = y + PROJ_MUZZLE_RISE;
    return blocked(x - PROJ_HALF, footY - COL_H, PROJ_HALF * 2, COL_H);
  }

  // Advance every projectile one tick. Each marches forward in sub-steps no larger
  // than its hitbox, so a fast shot can't tunnel past a thin target or wall between
  // ticks; it ends on a wall, on its first hit (unless piercing), or at max range.
  function stepProjectiles(now) {
    if (!projectiles.length) return;
    const playerList = players();
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const steps = Math.max(1, Math.ceil(p.speed / PROJ_HALF));
      const sx = (p.vx * p.speed) / steps;
      const sy = (p.vy * p.speed) / steps;
      const stepLen = hyp(sx, sy);
      let done = false;
      let connected = false;
      for (let s = 0; s < steps; s++) {
        const px0 = p.x;
        const py0 = p.y;
        p.x += sx;
        p.y += sy;
        p.traveled += stepLen;
        if (projBlocked(p.x, p.y)) {
          // Stop at the first solid collision tile; back out to the last clear spot
          // so the impact spark lands on the wall face, not buried inside it.
          p.x = px0;
          p.y = py0;
          done = true;
          break;
        }
        if (projectileHits(p, playerList, now)) {
          connected = true;
          done = true; // non-piercing shot spent on its first target
          break;
        }
        if (p.traveled >= p.maxDist) {
          done = true; // flew its full range without connecting
          break;
        }
      }
      if (done) {
        endProjectile(p, connected);
        projectiles.splice(i, 1);
      }
    }
  }

  return { spawnProjectile, stepProjectiles };
}

module.exports = { createProjectiles, PROJ_MUZZLE_RISE };
