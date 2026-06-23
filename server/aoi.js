'use strict';
/**
 * Area-of-Interest spatial index (NETWORK_REMODEL.md §4, Pillar 1).
 *
 * A uniform spatial hash over world-pixel coordinates. It indexes the entities
 * that RECEIVE positional messages (players) by the grid cell they occupy, so a
 * positional broadcast can fan out to only the players near a point instead of
 * to every connected client. This is the O(N²) → O(N·k) lever — the single
 * biggest scaling win, and it lives entirely inside the current process.
 *
 * Subscription model is symmetric: every player implicitly subscribes to its own
 * anchor cell plus a 1-cell margin ring (3×3 block). So "the players who can see
 * point (x,y)" are exactly the players whose anchor sits in the 3×3 block of
 * cells around (x,y) — what `around()` yields. Since visibility is "anchors
 * within 1 cell of each other", it's mutual: A sees B ⟺ B sees A.
 *
 * HYSTERESIS (§4.2): a player does NOT re-anchor the instant it crosses a cell
 * boundary — it keeps its anchor cell until it moves `hysteresis` px PAST that
 * cell's edge. This gives a 2·H deadband around every boundary, so a player
 * walking the line doesn't oscillate cells and trigger a spawn/despawn storm
 * (each re-anchor reconciles a whole ring of peers). Recipient indexing AND the
 * subscription center both key off the same anchor, so they never disagree.
 *
 * Cell size 256px ≈ 2 screens, matching the client's existing NPC render-bucket
 * grid so the coordinate math is shared.
 */

const CELL_SIZE = 256; // px per cell — keep in sync with the client render grid

// Pack a signed cell coord pair into one number key. Offset keeps negatives
// (map edges / future areas left of origin) collision-free. ±32768 cells ×
// 256px ≈ ±8.3M px per axis — far beyond the EB world's extent.
const OFFSET = 32768;
function cellKey(cx, cy) {
  return (cx + OFFSET) * 65536 + (cy + OFFSET);
}

class SpatialGrid {
  constructor(cellSize = CELL_SIZE, hysteresis = Math.round(cellSize / 4)) {
    this.cellSize = cellSize;
    this.h = hysteresis; // px past a cell edge before re-anchoring (§4.2)
    this.cells = new Map(); // cellKey -> Set<id>
    this.at = new Map(); // id -> cellKey it is currently indexed under
    this.anchor = new Map(); // id -> [cx, cy] hysteretic anchor cell
  }

  /** Insert or move `id`. Re-anchors only when (x,y) leaves the current anchor
   *  cell's bounds expanded by the hysteresis band, so boundary-walking is a
   *  cheap no-op instead of a cell-flip storm. Returns true when the anchor cell
   *  actually changed (incl. first insert) — the caller's cue to reconcile AOI
   *  subscriptions; false otherwise. */
  update(id, x, y) {
    const W = this.cellSize;
    const H = this.h;
    const prev = this.anchor.get(id);
    let cx, cy;
    if (!prev) {
      cx = Math.floor(x / W);
      cy = Math.floor(y / W);
    } else {
      cx = prev[0];
      cy = prev[1];
      // Stay put unless we've moved H past one of this cell's edges.
      if (x < cx * W - H || x >= (cx + 1) * W + H) cx = Math.floor(x / W);
      if (y < cy * W - H || y >= (cy + 1) * W + H) cy = Math.floor(y / W);
    }
    const key = cellKey(cx, cy);
    const prevKey = this.at.get(id);
    if (prevKey === key) return false;
    if (prevKey !== undefined) {
      const s = this.cells.get(prevKey);
      if (s) {
        s.delete(id);
        if (s.size === 0) this.cells.delete(prevKey);
      }
    }
    let s = this.cells.get(key);
    if (!s) {
      s = new Set();
      this.cells.set(key, s);
    }
    s.add(id);
    this.at.set(id, key);
    this.anchor.set(id, [cx, cy]);
    return true;
  }

  /** Drop `id` from the index entirely (disconnect). */
  remove(id) {
    const prev = this.at.get(id);
    if (prev === undefined) return;
    const s = this.cells.get(prev);
    if (s) {
      s.delete(id);
      if (s.size === 0) this.cells.delete(prev);
    }
    this.at.delete(id);
    this.anchor.delete(id);
  }

  /** Anchor cell [cx,cy] of an indexed id, or null. Lets callers compute a
   *  player's block from the SAME hysteretic cell the index uses. */
  anchorOf(id) {
    return this.anchor.get(id) || null;
  }

  /** Yield ids in the (2*ring+1)² block of cells around the integer cell
   *  (cx,cy). Each id appears once (one entity → one cell). */
  *aroundCell(cx, cy, ring = 1) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const s = this.cells.get(cellKey(cx + dx, cy + dy));
        if (s) for (const id of s) yield id;
      }
    }
  }

  /** Block around world point (x,y) — for fan-out keyed off a source position
   *  (e.g. a moving player's exact spot). The 1-cell margin absorbs the
   *  hysteresis band, so recipients near a boundary are never missed. */
  *around(x, y, ring = 1) {
    yield* this.aroundCell(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize), ring);
  }

  /** Block around an indexed id's own ANCHOR cell — the consistent choice for
   *  that player's subscription (spawn/despawn) and its inbound NPC filtering. */
  *aroundId(id, ring = 1) {
    const a = this.anchor.get(id);
    if (a) yield* this.aroundCell(a[0], a[1], ring);
  }

  /** Diagnostics for Phase-0 measurement: occupancy distribution. */
  stats() {
    let max = 0;
    let occupied = 0;
    for (const s of this.cells.values()) {
      occupied++;
      if (s.size > max) max = s.size;
    }
    return { indexed: this.at.size, occupiedCells: occupied, maxPerCell: max };
  }
}

module.exports = { SpatialGrid, CELL_SIZE };
