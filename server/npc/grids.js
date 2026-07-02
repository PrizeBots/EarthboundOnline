'use strict';
// Broad-phase spatial grids, extracted from npcSim.js (Phase 2 modularization).
// These kill the O(N²) per-tick scans: several hot functions (unstack,
// separation, enemy targeting, vehicle shove, drop pickup) used to scan ALL
// ~1364 actors / the whole player roster for EACH near actor EVERY tick —
// millions of iterations/sec → 150-230ms event-loop stalls. Instead the live
// actors/players are bucketed into coarse grids ONCE per tick (the rebuild*
// fns, called at tick start) and queried locally (nearActors/nearPlayers). The
// grids are over-inclusive at cell granularity, so callers keep their exact
// box/distance test — same results, a fraction of the work. Built from
// tick-start positions (actors move ≤ a few px/tick, well under the cell
// margin), so broad-phase never misses a real neighbour.
function createGrids(deps) {
  const {
    actors, // () => live actor array (reassigned on placement reloads)
    enemies, // () => live enemy array (foe-cell source)
    ACTIVE_RADIUS, // px "any player near?" AI wake radius (npcSim tuning)
  } = deps;

  const GRID_CELL = 64;
  const actorGrid = new Map(); // "cx,cy" -> actor[]
  function rebuildActorGrid() {
    actorGrid.clear();
    for (const o of actors()) {
      if (o.dead || o.kind === 'deleted') continue;
      const key = Math.floor(o.x / GRID_CELL) + ',' + Math.floor(o.y / GRID_CELL);
      let arr = actorGrid.get(key);
      if (!arr) actorGrid.set(key, (arr = []));
      arr.push(o);
    }
  }
  function* nearActors(x, y, radius) {
    const r = Math.max(1, Math.ceil(radius / GRID_CELL));
    const cx = Math.floor(x / GRID_CELL);
    const cy = Math.floor(y / GRID_CELL);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const arr = actorGrid.get(cx + dx + ',' + (cy + dy));
        if (arr) for (const o of arr) yield o;
      }
    }
  }

  // Player broad-phase grid — same scheme as actorGrid, rebuilt once per tick from
  // the live players list (rebuildPlayerGrid, called right after rebuildActorGrid).
  // Lets NPC-vs-player collision (hitsPlayer) and player targeting (nearestFoeTo)
  // query only LOCAL players instead of scanning the whole roster every tick — the
  // O(movers × allPlayers) scan that stalled the sim once a bot fleet pushed the
  // player count into the hundreds/thousands. Editors are excluded at build time
  // (non-solid avatars), so the per-query editor check is no longer needed.
  const playerGrid = new Map(); // "cx,cy" -> player[]
  function rebuildPlayerGrid(players) {
    playerGrid.clear();
    for (const p of players) {
      if (p.editor) continue; // editor avatar is non-solid — actors walk through it
      const key = Math.floor(p.x / GRID_CELL) + ',' + Math.floor(p.y / GRID_CELL);
      let arr = playerGrid.get(key);
      if (!arr) playerGrid.set(key, (arr = []));
      arr.push(p);
    }
  }
  function* nearPlayers(x, y, radius) {
    const r = Math.max(1, Math.ceil(radius / GRID_CELL));
    const cx = Math.floor(x / GRID_CELL);
    const cy = Math.floor(y / GRID_CELL);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const arr = playerGrid.get(cx + dx + ',' + (cy + dy));
        if (arr) for (const p of arr) yield p;
      }
    }
  }

  // Coarse player-occupancy grid for the ACTIVE_RADIUS "is any player near this
  // actor?" test (gates per-actor AI + the resync re-flag). The old test scanned
  // ALL players per actor — O(actors × players), which at 1000 players is ~1.4M
  // checks/tick and dominates the `ai` phase. A fine 64px grid would instead scan
  // ~289 cells/actor at radius 512 (string-key Map lookups, also too many). This
  // grid uses ACTIVE_RADIUS-sized cells: an actor is "near" if its own cell or any
  // of the 8 neighbours holds a player — O(1) per actor (9 lookups), O(players) to
  // build. Over-inclusive by up to ~one cell (an actor up to ~2×ACTIVE_RADIUS out
  // may wake early), which only adds a little cheap wander AI and never false
  // combat (foe ranges are « ACTIVE_RADIUS). When players blanket the map (the
  // heavy case) the awake set is identical to the old exact test — just O(1) to find.
  const ACTIVE_CELL = ACTIVE_RADIUS;
  const activeCells = new Set();
  function rebuildActiveCells(players) {
    activeCells.clear();
    for (const p of players) {
      if (p.editor) continue;
      activeCells.add(Math.floor(p.x / ACTIVE_CELL) + ',' + Math.floor(p.y / ACTIVE_CELL));
    }
  }
  function anyPlayerNear(x, y) {
    const cx = Math.floor(x / ACTIVE_CELL);
    const cy = Math.floor(y / ACTIVE_CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (activeCells.has(cx + dx + ',' + (cy + dy))) return true;
      }
    }
    return false;
  }

  // Coarse FOE-occupancy grid: which ACTIVE_CELL cells hold a living enemy or a PK
  // player. Townsfolk defend on sight via nearestFoeTo (a grid scan + line-of-sight
  // raycasts) EVERY turn — but enemies are few and clustered, so the vast majority
  // of the ~1376 actors have no foe within range and that whole scan is wasted. This
  // gates it: an actor only runs nearestFoeTo if a foe is in its 3×3 coarse
  // neighbourhood (a superset of detectRange, so a real foe is never missed). At
  // 1000 dispersed players this is the single biggest `ai` cut.
  const foeCells = new Set();
  function rebuildFoeCells(players) {
    foeCells.clear();
    for (const e of enemies()) {
      if (e.dead || e.hp <= 0) continue;
      foeCells.add(Math.floor(e.x / ACTIVE_CELL) + ',' + Math.floor(e.y / ACTIVE_CELL));
    }
    for (const p of players) {
      if (p.editor || p.pk !== true) continue;
      if (p.hp !== undefined && p.hp <= 0) continue;
      foeCells.add(Math.floor(p.x / ACTIVE_CELL) + ',' + Math.floor(p.y / ACTIVE_CELL));
    }
  }
  function anyFoeNear(x, y) {
    if (foeCells.size === 0) return false;
    const cx = Math.floor(x / ACTIVE_CELL);
    const cy = Math.floor(y / ACTIVE_CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (foeCells.has(cx + dx + ',' + (cy + dy))) return true;
      }
    }
    return false;
  }

  return {
    rebuildActorGrid,
    nearActors,
    rebuildPlayerGrid,
    nearPlayers,
    rebuildActiveCells,
    anyPlayerNear,
    rebuildFoeCells,
    anyFoeNear,
  };
}

module.exports = { createGrids };
