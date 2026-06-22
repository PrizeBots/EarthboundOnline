import {
  CollisionOverrides,
  computeRoomBounds,
  getCellCollisionAt,
  getEffectiveRowAt,
  getArrangementByteAt,
  setCellCollisionLive,
  clearCellCollisionLive,
  FG_PROMOTE_BIT,
} from '../../engine/Collision';
import { Camera } from '../../engine/Camera';
import { MAP_WIDTH_TILES, TILE_SIZE } from '../../types';
import { saveOverride } from '../saveOverride';
import { registerSaveHandler } from '../EditorHub';
import { EditorShellApi, WorldPoint } from '../types';

// Collision/layer paint CORE — UI-less, embedded by the Room Builder so the map,
// its walkability, and its FG layer are all authored in one tool. (Was the
// standalone Collision & Priority Painter; the logic is unchanged, only lifted
// out of its own EditorTool shell.)
//
// MODEL: edits are PER-MAP-TILE — a paint affects ONLY the clicked cell, even
// when other map tiles reuse the same tile graphic. Collision.ts applies these
// per-cell overrides on top of the shared arrangement bytes. Edits apply LIVE
// and save as diffs to overrides/collision.json `cells` (legacy per-arrangement
// `edits` are preserved). npcSim and debug_room_crop_check.py re-apply them.

const DOMAIN = 'collision';
const MINITILE = 8;

// The paint operations the Room Builder modes map onto:
//   solid → 0x80 wall   walk → clear walls/priority (keep FG)
//   fg    → toggle 0x40 "draw this tile in FRONT so you hide behind it"
//   prilo/prihi → native 0x01/0x02 (advanced; only bite where the ROM already
//                 has foreground art)   clear → wipe the cell to 0
export type CollisionOp = 'solid' | 'walk' | 'fg' | 'prilo' | 'prihi' | 'clear';

const BIT: Record<string, number> = { solid: 0x80, prilo: 0x01, prihi: 0x02 };
const HIDE_BIT = FG_PROMOTE_BIT; // 0x40 — orthogonal modifier
// solid / pri-lo / pri-hi are mutually exclusive — painting one clears the
// other two (a paint OVERWRITES the cell's type instead of stacking bits).
const TYPE_MASK = BIT.solid | BIT.prilo | BIT.prihi;

interface CellRef {
  tileX: number;
  tileY: number;
  idx: number;
}
const cellKey = (c: CellRef) => `${c.tileX},${c.tileY},${c.idx}`;

export class CollisionPaint {
  private shell: EditorShellApi | null = null;
  brush = 1; // brush size in minitiles (1/2/4)
  // Front tool sub-mode: false = Place (set 0x40), true = Erase (clear 0x40).
  // Mirrors the Walls tool's Block/Clear so erasing a front tile is explicit
  // instead of the old "re-paint to toggle off" gesture.
  fgErase = false;

  // Authored per-map-cell bytes: key -> byte (only where it differs from the
  // tile's arrangement default). Saved as the override file's `cells` section.
  private authored = new Map<string, { cell: CellRef; byte: number }>();
  private legacyEdits: NonNullable<CollisionOverrides['edits']> = {};

  // Stroke state
  private painting = false;
  private op: CollisionOp = 'solid';
  private lastPaintPoint: WorldPoint | null = null;
  private fgSetting = true; // first cell of an FG stroke decides set vs clear
  private strokeChanges = new Map<string, { cell: CellRef; before: number; after: number }>();

  // Room-crop preview
  private roomCells: ReadonlySet<number> | null = null;
  private roomPoint: WorldPoint | null = null;

  setShell(shell: EditorShellApi): void {
    this.shell = shell;
  }

  authoredCount(): number {
    return this.authored.size;
  }

  /** Seed the authored map from the override file's `cells` (and remember the
   *  legacy per-arrangement `edits` so saving preserves them). */
  async load(): Promise<void> {
    this.authored.clear();
    this.legacyEdits = {};
    try {
      const res = await fetch('/overrides/collision.json', { cache: 'no-store' });
      if (!res.ok) return;
      const ov = (await res.json()) as CollisionOverrides;
      this.legacyEdits = ov.edits ?? {};
      for (const [tk, cells] of Object.entries(ov.cells ?? {})) {
        const [tileX, tileY] = tk.split(',').map(Number);
        for (const [idx, byte] of Object.entries(cells)) {
          const cell = { tileX, tileY, idx: Number(idx) };
          this.authored.set(cellKey(cell), { cell, byte });
        }
      }
    } catch {
      /* nothing authored yet */
    }
  }

  private buildOverrides(): CollisionOverrides {
    const cells: NonNullable<CollisionOverrides['cells']> = {};
    for (const { cell, byte } of this.authored.values()) {
      const key = `${cell.tileX},${cell.tileY}`;
      (cells[key] ??= {})[String(cell.idx)] = byte;
    }
    const out: CollisionOverrides = { version: 1, cells };
    if (Object.keys(this.legacyEdits).length > 0) out.edits = this.legacyEdits;
    return out;
  }

  async save(): Promise<void> {
    await saveOverride('collision.json', this.buildOverrides());
  }

  // --- painting -------------------------------------------------------------

  private cellsUnderBrush(p: WorldPoint): CellRef[] {
    const out: CellRef[] = [];
    const seen = new Set<string>();
    const base = this.brush * MINITILE;
    const x0 = Math.floor(p.x / MINITILE) * MINITILE - Math.floor((this.brush - 1) / 2) * MINITILE;
    const y0 = Math.floor(p.y / MINITILE) * MINITILE - Math.floor((this.brush - 1) / 2) * MINITILE;
    for (let dy = 0; dy < base; dy += MINITILE) {
      for (let dx = 0; dx < base; dx += MINITILE) {
        const hit = getCellCollisionAt(x0 + dx + 1, y0 + dy + 1);
        if (!hit) continue;
        const cell: CellRef = { tileX: hit.tileX, tileY: hit.tileY, idx: hit.idx };
        const key = cellKey(cell);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cell);
      }
    }
    return out;
  }

  private currentByte(cell: CellRef): number {
    return getEffectiveRowAt(cell.tileX, cell.tileY)?.[cell.idx] ?? 0;
  }
  private baseByte(cell: CellRef): number {
    return getArrangementByteAt(cell.tileX, cell.tileY, cell.idx) ?? 0;
  }

  /** Apply a target byte to one cell's per-tile override (clearing it when the
   *  target equals the arrangement base, so no redundant override is stored). */
  private applyCell(cell: CellRef, byte: number): void {
    if (byte === this.baseByte(cell)) clearCellCollisionLive(cell.tileX, cell.tileY, cell.idx);
    else setCellCollisionLive(cell.tileX, cell.tileY, cell.idx, byte);
  }

  private targetByte(before: number): number {
    switch (this.op) {
      case 'clear':
        return 0;
      case 'walk':
        return before & ~TYPE_MASK; // drop wall/priority, keep FG-promote
      case 'fg':
        return this.fgSetting ? before | HIDE_BIT : before & ~HIDE_BIT;
      case 'solid':
        return (before & ~TYPE_MASK) | BIT.solid;
      case 'prilo':
        return (before & ~TYPE_MASK) | BIT.prilo;
      case 'prihi':
        return (before & ~TYPE_MASK) | BIT.prihi;
    }
  }

  private paintCells(cells: CellRef[]): void {
    for (const cell of cells) {
      const before = this.currentByte(cell);
      const after = this.targetByte(before);
      if (after === before) continue;
      const key = cellKey(cell);
      const prev = this.strokeChanges.get(key);
      this.strokeChanges.set(key, { cell, before: prev?.before ?? before, after });
      this.applyCell(cell, after);
    }
  }

  private syncAuthored(cell: CellRef): void {
    const key = cellKey(cell);
    const now = this.currentByte(cell);
    if (now === this.baseByte(cell)) this.authored.delete(key);
    else this.authored.set(key, { cell, byte: now });
  }

  // --- public stroke API (driven by the Room Builder mouse handlers) --------

  /** Begin a paint stroke at p with the given op. Returns true if a cell was hit
   *  (so the host can claim the gesture). */
  beginStroke(p: WorldPoint, op: CollisionOp): boolean {
    const hit = getCellCollisionAt(p.x, p.y);
    if (!hit) return false;
    this.op = op;
    // Front: Place sets 0x40, Erase clears it (explicit, like Walls Block/Clear).
    if (op === 'fg') this.fgSetting = !this.fgErase;
    this.painting = true;
    this.strokeChanges = new Map();
    this.lastPaintPoint = { ...p };
    this.paintCells(this.cellsUnderBrush(p));
    return true;
  }

  dragStroke(p: WorldPoint): void {
    if (!this.painting) return;
    // Paint every step since the last sample so a fast drag leaves no gaps.
    const from = this.lastPaintPoint ?? p;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / MINITILE));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      this.paintCells(this.cellsUnderBrush({ x: from.x + dx * t, y: from.y + dy * t }));
    }
    this.lastPaintPoint = { ...p };
  }

  /** End the stroke and register it as one undoable command. */
  endStroke(): void {
    if (!this.painting) return;
    this.painting = false;
    this.lastPaintPoint = null;
    if (this.strokeChanges.size === 0) return;
    const changes = [...this.strokeChanges.values()];
    this.strokeChanges = new Map();
    const apply = (dir: 'after' | 'before') => {
      for (const c of changes) {
        this.applyCell(c.cell, c[dir]);
        this.syncAuthored(c.cell);
      }
      this.shell?.markDirty(DOMAIN);
      this.refreshRoomPreview();
    };
    this.shell?.run({
      label: `paint ${this.op} (${changes.length} cells)`,
      do: () => apply('after'),
      undo: () => apply('before'),
    });
  }

  // --- room-crop preview + verifier -----------------------------------------

  refreshRoomPreview(at?: WorldPoint): void {
    if (at) this.roomPoint = { ...at };
    if (!this.roomPoint) return;
    const bounds = computeRoomBounds(this.roomPoint.x, this.roomPoint.y);
    this.roomCells = bounds?.cells ?? null;
    if (at) {
      this.shell?.toast(
        bounds ? `Room: ${bounds.cells.size} walkable minitiles` : 'No croppable room here'
      );
    }
  }

  async runVerifier(): Promise<string> {
    try {
      const res = await fetch('/__editor/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rooms' }),
      });
      const json = await res.json();
      this.shell?.toast(json.ok ? 'Verifier passed' : 'Verifier reported problems', !json.ok);
      return `${json.ok ? '✔' : '✘'} rooms\n${json.output}`;
    } catch (err) {
      this.shell?.toast(String(err), true);
      return String(err);
    }
  }

  // --- overlay --------------------------------------------------------------

  /** Tint the collision/priority bits over the world: solid = red, pri-lo =
   *  blue, pri-hi = purple, FG-promote = yellow. `hover` draws the brush box.
   *  `show` filters which layers tint, so each paint mode shows only its own. */
  drawOverlay(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    hover: WorldPoint,
    show: { solid: boolean; pri: boolean; fg: boolean }
  ): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    const vw = camera.viewW;
    const vh = camera.viewH;

    const t0x = Math.floor(camX / TILE_SIZE);
    const t0y = Math.floor(camY / TILE_SIZE);
    const t1x = Math.ceil((camX + vw) / TILE_SIZE);
    const t1y = Math.ceil((camY + vh) / TILE_SIZE);
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const row = getEffectiveRowAt(tx, ty);
        if (!row) continue;
        const baseX = tx * TILE_SIZE - camX;
        const baseY = ty * TILE_SIZE - camY;
        for (let i = 0; i < 16; i++) {
          const b = row[i];
          if (b === 0) continue;
          const cx = baseX + (i % 4) * MINITILE;
          const cy = baseY + (i >> 2) * MINITILE;
          if (show.solid && b & 0x80) {
            ctx.fillStyle = 'rgba(255,60,60,0.5)';
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
            ctx.strokeStyle = 'rgba(20,0,0,0.9)';
            ctx.lineWidth = 1 / camera.zoom;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + MINITILE, cy + MINITILE);
            ctx.moveTo(cx + MINITILE, cy);
            ctx.lineTo(cx, cy + MINITILE);
            ctx.stroke();
          }
          if (show.pri && b & 0x01) {
            ctx.fillStyle = 'rgba(70,130,255,0.55)';
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
          if (show.pri && b & 0x02) {
            ctx.fillStyle = 'rgba(175,80,255,0.6)';
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
          if (show.fg && b & HIDE_BIT) {
            ctx.fillStyle = 'rgba(245,215,40,0.55)';
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
        }
      }
    }

    if (this.roomCells) {
      ctx.fillStyle = 'rgba(80,220,255,0.28)';
      const MAP_W_MT = MAP_WIDTH_TILES * 4;
      for (const key of this.roomCells) {
        const mx = (key % MAP_W_MT) * MINITILE - camX;
        const my = Math.floor(key / MAP_W_MT) * MINITILE - camY;
        if (mx < -8 || mx > vw || my < -8 || my > vh) continue;
        ctx.fillRect(mx, my, MINITILE, MINITILE);
      }
    }

    // Brush cursor (minitile-granular).
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / camera.zoom;
    const off = Math.floor((this.brush - 1) / 2) * MINITILE;
    const bx = Math.floor(hover.x / MINITILE) * MINITILE - off - camX;
    const by = Math.floor(hover.y / MINITILE) * MINITILE - off - camY;
    ctx.strokeRect(bx + 0.5, by + 0.5, this.brush * MINITILE - 1, this.brush * MINITILE - 1);
  }
}

// Singleton shared by the Room Builder. The save handler lives here so collision
// edits still persist now that the standalone Collision tool is retired.
export const collisionPaint = new CollisionPaint();
registerSaveHandler(DOMAIN, () => collisionPaint.save());
