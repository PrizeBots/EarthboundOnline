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
import { EditorShellApi, EditorTool, WorldPoint } from '../types';

// Collision & Priority Painter (EDITOR_TOOLS.md §3). Paints the minitile
// collision bytes: solid 0x80; sprite-priority 0x01 (lower half behind FG) and
// 0x02 (whole body behind FG); and "Behind"/Hide 0x40 (redraw this minitile's
// art in FRONT of you — hide behind BG buildings the ROM never made foreground).
//
// MODEL: edits are PER-MAP-TILE — a paint affects ONLY the cell you click, even
// when other map tiles reuse the same tile graphic. (Collision.ts applies these
// per-cell overrides on top of the shared arrangement bytes; legacy
// per-arrangement edits in overrides/collision.json still apply underneath.)
// Edits apply LIVE (room-crop preview runs against painted state) and save as
// diffs to overrides/collision.json `cells`, which Collision.ts, npcSim, and
// debug_room_crop_check.py all re-apply.

const DOMAIN = 'collision';
const MINITILE = 8;

type PaintTool = 'solid' | 'prilo' | 'prihi' | 'clear' | 'stamp' | 'eyedrop' | 'rect' | 'hide';
// Hotkeys avoid WASD/arrows (camera pan) and 1-4 (grid toggles) — the active
// tool consumes the key before the shell pans, so a movement key would be stolen.
const TOOL_DEFS: { id: PaintTool; label: string; key: string; tip: string }[] = [
  // NOT 's' — that pans the camera down
  {
    id: 'solid',
    label: 'F Solid',
    key: 'f',
    tip: 'F: paint the solid-wall bit 0x80 — blocks movement (hold + drag to paint).',
  },
  {
    id: 'prilo',
    label: 'L Pri-lo',
    key: 'l',
    tip: 'L: paint priority-low 0x01 — your lower half draws behind this tile’s foreground art.',
  },
  {
    id: 'prihi',
    label: 'H Pri-hi',
    key: 'h',
    tip: 'H: paint priority-high 0x02 — your whole body draws behind this tile’s foreground art.',
  },
  {
    id: 'clear',
    label: 'C Clear',
    key: 'c',
    tip: 'C: clear the cell — wipes all collision/priority bits back to 0.',
  },
  {
    id: 'eyedrop',
    label: 'E Eyedrop',
    key: 'e',
    tip: 'E: eyedropper — pick the clicked cell’s byte into the stamp, then switch to Stamp.',
  },
  {
    id: 'stamp',
    label: 'X Stamp',
    key: 'x',
    tip: 'X: stamp — paint the exact byte picked with the eyedropper onto cells.',
  },
  {
    id: 'rect',
    label: 'T Rect',
    key: 't',
    tip: 'T: rectangle — drag to fill/clear a box of cells with the solid bit.',
  },
  // 0x40: minitile redraws in FRONT of you + hides you behind it (for BG buildings)
  {
    id: 'hide',
    label: 'G Behind',
    key: 'g',
    tip: 'G: toggle Behind 0x40 — redraws this tile in front of you so you hide behind BG buildings (leaves solid/priority bits intact).',
  },
];
const BIT: Record<string, number> = { solid: 0x80, prilo: 0x01, prihi: 0x02 };
// "Behind"/Hide is a MODIFIER bit, orthogonal to the mutually-exclusive type
// bits above — painting it leaves solid/pri untouched (and vice-versa).
const HIDE_BIT = FG_PROMOTE_BIT;
// The three paintable "types" are mutually exclusive — painting one clears the
// other two (so a paint OVERWRITES the cell's type instead of stacking bits).
const TYPE_MASK = BIT.solid | BIT.prilo | BIT.prihi;

/** One paintable MAP CELL: a minitile of a specific map tile. */
interface CellRef {
  tileX: number;
  tileY: number;
  idx: number;
}

const cellKey = (c: CellRef) => `${c.tileX},${c.tileY},${c.idx}`;

class CollisionTool implements EditorTool {
  id = 'collision';
  name = 'Collision & Priority Painter';
  description =
    'Paint solid/priority minitile bits (per-arrangement!). Live room-crop preview; saves to overrides/collision.json.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private tool: PaintTool = 'solid';
  private brush = 1; // brush size in minitiles (1/2/4)
  private hideArt = false;
  private stampByte = 0x80;
  private hover: WorldPoint = { x: 0, y: 0 };
  private hideSetting = true; // first cell of a Behind stroke decides set vs clear

  // Authored per-map-cell bytes: key -> byte (only where it differs from the
  // tile's arrangement default). Saved as the override file's `cells` section.
  private authored = new Map<string, { cell: CellRef; byte: number }>();
  // Legacy per-arrangement edits already in the file — preserved on save.
  private legacyEdits: NonNullable<CollisionOverrides['edits']> = {};

  // Stroke state
  private painting = false;
  private lastPaintPoint: WorldPoint | null = null; // for gap-free drag interpolation
  private strokeBit = 0; // bit being painted this stroke (bit tools)
  private strokeSetting = true; // first cell decides: set or clear
  private strokeChanges = new Map<string, { cell: CellRef; before: number; after: number }>();
  private rectStart: WorldPoint | null = null;

  // Inspector (the cell last clicked).
  private inspect: CellRef | null = null;

  // Room-crop preview
  private roomCells: ReadonlySet<number> | null = null;
  private roomPoint: WorldPoint | null = null;

  private panel: HTMLDivElement | null = null;
  private inspectorEl: HTMLDivElement | null = null;
  private outputEl: HTMLPreElement | null = null;

  // --- lifecycle -----------------------------------------------------------

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadAuthored();
    this.buildPanel();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.inspectorEl = null;
    this.outputEl = null;
    this.roomCells = null;
    this.painting = false;
    this.rectStart = null;
  }

  /** Seed the authored map from the override file's `cells` (and remember the
   *  legacy per-arrangement `edits` so saving preserves them). */
  private async loadAuthored(): Promise<void> {
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
    this.refreshPanel();
  }

  private buildOverrides(): CollisionOverrides {
    const cells: NonNullable<CollisionOverrides['cells']> = {};
    for (const { cell, byte } of this.authored.values()) {
      const key = `${cell.tileX},${cell.tileY}`;
      (cells[key] ??= {})[String(cell.idx)] = byte;
    }
    const out: CollisionOverrides = { version: 1, cells };
    // Keep any legacy per-arrangement edits that were already authored.
    if (Object.keys(this.legacyEdits).length > 0) out.edits = this.legacyEdits;
    return out;
  }

  async save(): Promise<void> {
    await saveOverride('collision.json', this.buildOverrides());
  }

  // --- painting ---------------------------------------------------------------

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

  /** The cell's current effective byte (arrangement + any per-cell override). */
  private currentByte(cell: CellRef): number {
    return getEffectiveRowAt(cell.tileX, cell.tileY)?.[cell.idx] ?? 0;
  }

  /** The byte the cell reverts to with no per-tile override (arrangement base). */
  private baseByte(cell: CellRef): number {
    return getArrangementByteAt(cell.tileX, cell.tileY, cell.idx) ?? 0;
  }

  /** Apply a target byte to one cell's per-tile override (clearing it when the
   *  target equals the arrangement base, so no redundant override is stored). */
  private applyCell(cell: CellRef, byte: number): void {
    if (byte === this.baseByte(cell)) clearCellCollisionLive(cell.tileX, cell.tileY, cell.idx);
    else setCellCollisionLive(cell.tileX, cell.tileY, cell.idx, byte);
  }

  private paintCells(cells: CellRef[]): void {
    for (const cell of cells) {
      const before = this.currentByte(cell);
      let after = before;
      if (this.tool === 'clear') after = 0;
      else if (this.tool === 'stamp') after = this.stampByte;
      // Behind/Hide toggles ONLY the 0x40 modifier (leaves solid/pri intact, so
      // you can hide behind a wall without making it walkable).
      else if (this.tool === 'hide')
        after = this.hideSetting ? before | HIDE_BIT : before & ~HIDE_BIT;
      // Bit tools OVERWRITE the cell's type: set this bit and clear the other
      // two (solid / pri-lo / pri-hi are mutually exclusive). Clear mode (a rect
      // that starts on an already-filled corner) just drops the bit.
      else
        after = this.strokeSetting
          ? (before & ~TYPE_MASK) | this.strokeBit
          : before & ~this.strokeBit;
      if (after === before) continue;

      const key = cellKey(cell);
      const prev = this.strokeChanges.get(key);
      this.strokeChanges.set(key, { cell, before: prev?.before ?? before, after });
      this.applyCell(cell, after);
    }
  }

  /** Track authored state for a cell against its arrangement base byte. */
  private syncAuthored(cell: CellRef): void {
    const key = cellKey(cell);
    const now = this.currentByte(cell);
    if (now === this.baseByte(cell)) this.authored.delete(key);
    else this.authored.set(key, { cell, byte: now });
  }

  private commitStroke(label: string): void {
    if (this.strokeChanges.size === 0) return;
    const changes = [...this.strokeChanges.values()];
    this.strokeChanges = new Map();
    const apply = (dir: 'after' | 'before') => {
      for (const c of changes) {
        this.applyCell(c.cell, c[dir]);
        this.syncAuthored(c.cell);
      }
      this.shell!.markDirty(DOMAIN);
      this.refreshRoomPreview();
      this.refreshPanel();
    };
    // The stroke already applied live; register it as an undoable command.
    this.shell!.run({
      label,
      do: () => apply('after'),
      undo: () => apply('before'),
    });
  }

  // --- shell events -------------------------------------------------------------

  onMouseDown(p: WorldPoint): boolean {
    const hit = getCellCollisionAt(p.x, p.y);
    if (!hit) return false;
    const cell: CellRef = { tileX: hit.tileX, tileY: hit.tileY, idx: hit.idx };
    this.setInspect(cell);

    if (this.tool === 'eyedrop') {
      this.stampByte = this.currentByte(cell);
      this.setTool('stamp');
      this.shell?.toast(
        `Picked 0x${this.stampByte.toString(16).padStart(2, '0')} — stamp to paint`
      );
      return true;
    }
    if (this.tool === 'rect') {
      this.rectStart = { ...p };
      return true;
    }
    // Bit tools always PAINT the bit ON (hold + drag to keep painting); use the
    // Clear tool to remove. (Toggling from the first cell made a stroke that
    // started on a filled cell silently erase instead of paint.)
    if (this.tool in BIT) {
      this.strokeBit = BIT[this.tool];
      this.strokeSetting = true;
    } else if (this.tool === 'hide') {
      // Behind/Hide TOGGLES off the first cell's state, so a second pass un-hides
      // without the Clear tool wiping the cell's solid/pri bits too.
      this.hideSetting = (this.currentByte(cell) & HIDE_BIT) === 0;
    }
    this.painting = true;
    this.strokeChanges = new Map();
    this.lastPaintPoint = { ...p };
    this.paintCells(this.cellsUnderBrush(p));
    return true;
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (!(dragging && this.painting)) return;
    // Paint every step along the path since the last sample so a fast drag
    // leaves no gaps (tiles for FG, minitile cells otherwise).
    const from = this.lastPaintPoint ?? p;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / MINITILE));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const q = { x: from.x + dx * t, y: from.y + dy * t };
      this.paintCells(this.cellsUnderBrush(q));
    }
    this.lastPaintPoint = { ...p };
  }

  onMouseUp(p: WorldPoint): void {
    if (this.rectStart) {
      const a = this.rectStart;
      this.rectStart = null;
      const first = getCellCollisionAt(a.x, a.y);
      if (first) {
        // Rect uses the SOLID bit semantics of the first corner cell.
        this.strokeBit = BIT.solid;
        this.strokeSetting = (first.byte & BIT.solid) === 0;
        this.strokeChanges = new Map();
        const cells: CellRef[] = [];
        const seen = new Set<string>();
        const x0 = Math.min(a.x, p.x);
        const x1 = Math.max(a.x, p.x);
        const y0 = Math.min(a.y, p.y);
        const y1 = Math.max(a.y, p.y);
        for (let y = Math.floor(y0 / MINITILE) * MINITILE; y <= y1; y += MINITILE) {
          for (let x = Math.floor(x0 / MINITILE) * MINITILE; x <= x1; x += MINITILE) {
            const hit = getCellCollisionAt(x + 1, y + 1);
            if (!hit) continue;
            const c: CellRef = { tileX: hit.tileX, tileY: hit.tileY, idx: hit.idx };
            if (seen.has(cellKey(c))) continue;
            seen.add(cellKey(c));
            cells.push(c);
          }
        }
        // 'rect' falls through paintCells' bit branch using strokeBit/Setting.
        this.paintCells(cells);
        this.commitStroke(
          `rect ${this.strokeSetting ? 'solid' : 'clear-solid'} (${cells.length} cells)`
        );
      }
      return;
    }
    if (this.painting) {
      this.painting = false;
      this.lastPaintPoint = null;
      this.commitStroke(`paint ${this.tool} (${this.strokeChanges.size} cells)`);
    }
  }

  onKey(key: string): boolean {
    const def = TOOL_DEFS.find((t) => t.key === key);
    if (def) {
      this.setTool(def.id);
      return true;
    }
    if (key === 'b') {
      this.brush = this.brush === 1 ? 2 : this.brush === 2 ? 4 : 1;
      this.shell?.toast(`Brush: ${this.brush}x${this.brush} minitiles`);
      this.refreshPanel();
      return true;
    }
    if (key === 'm') {
      this.hideArt = !this.hideArt;
      this.refreshPanel();
      return true;
    }
    if (key === 'r') {
      this.refreshRoomPreview(this.hover);
      return true;
    }
    return false;
  }

  private setTool(t: PaintTool): void {
    this.tool = t;
    this.refreshPanel();
  }

  private setInspect(cell: CellRef): void {
    if (this.inspect && cellKey(this.inspect) === cellKey(cell)) return;
    this.inspect = cell;
    this.refreshPanel();
  }

  private refreshRoomPreview(at?: WorldPoint): void {
    if (at) this.roomPoint = { ...at };
    if (!this.roomPoint) return;
    const bounds = computeRoomBounds(this.roomPoint.x, this.roomPoint.y);
    this.roomCells = bounds?.cells ?? null;
    if (at) {
      this.shell?.toast(
        bounds
          ? `Room recomputed: ${bounds.cells.size} walkable minitiles`
          : 'No croppable room here'
      );
    }
  }

  // --- overlay -------------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    const vw = camera.viewW;
    const vh = camera.viewH;

    if (this.hideArt) {
      ctx.fillStyle = 'rgba(12,14,18,0.93)';
      ctx.fillRect(0, 0, vw, vh);
    }

    // Per-tile pass: tint collision bits, each a FULL cell — solid = red,
    // pri-lo = blue, pri-hi = pink (a cell with multiple bits blends).
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
          if (b & 0x80) {
            ctx.fillStyle = 'rgba(255,60,60,0.5)'; // solid → red
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
            // Dark diagonal cross-hatch so solid reads clearly over busy tile art.
            ctx.strokeStyle = 'rgba(20,0,0,0.9)';
            ctx.lineWidth = 1 / camera.zoom;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + MINITILE, cy + MINITILE);
            ctx.moveTo(cx + MINITILE, cy);
            ctx.lineTo(cx, cy + MINITILE);
            ctx.stroke();
          }
          if (b & 0x01) {
            ctx.fillStyle = 'rgba(70,130,255,0.55)'; // pri-lo → blue (full cell)
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
          if (b & 0x02) {
            ctx.fillStyle = 'rgba(175,80,255,0.6)'; // pri-hi → purple (full cell)
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
          if (b & HIDE_BIT) {
            ctx.fillStyle = 'rgba(245,215,40,0.55)'; // behind/hide → yellow (full cell)
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
        }

        // Outline the cell last clicked (inspected).
        if (this.inspect && this.inspect.tileX === tx && this.inspect.tileY === ty) {
          const ix = (this.inspect.idx % 4) * MINITILE;
          const iy = (this.inspect.idx >> 2) * MINITILE;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.strokeRect(baseX + ix + 0.5, baseY + iy + 0.5, MINITILE - 1, MINITILE - 1);
        }
      }
    }

    // Room-crop preview cells
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

    // Brush / rect cursor
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / camera.zoom;
    if (this.rectStart) {
      const x0 = Math.min(this.rectStart.x, this.hover.x);
      const y0 = Math.min(this.rectStart.y, this.hover.y);
      const x1 = Math.max(this.rectStart.x, this.hover.x);
      const y1 = Math.max(this.rectStart.y, this.hover.y);
      ctx.strokeRect(x0 - camX + 0.5, y0 - camY + 0.5, x1 - x0, y1 - y0);
    } else {
      const off = Math.floor((this.brush - 1) / 2) * MINITILE;
      const bx = Math.floor(this.hover.x / MINITILE) * MINITILE - off - camX;
      const by = Math.floor(this.hover.y / MINITILE) * MINITILE - off - camY;
      ctx.strokeRect(bx + 0.5, by + 0.5, this.brush * MINITILE - 1, this.brush * MINITILE - 1);
    }
  }

  // --- panel ----------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #e8a33d;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';

    const head = document.createElement('div');
    head.textContent = 'COLLISION PAINTER';
    head.style.cssText = 'color:#e8a33d;letter-spacing:1px;';
    this.panel.appendChild(head);

    const warn = document.createElement('div');
    warn.style.cssText = 'color:#9fb8cc;font-size:10px;';
    warn.textContent =
      'Per-tile. F/L/H overwrite the cell type; G Behind toggles on top; C clears. Hold to paint.';
    this.panel.appendChild(warn);

    const tools = document.createElement('div');
    tools.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    this.panel.appendChild(tools);
    for (const def of TOOL_DEFS) {
      const b = document.createElement('button');
      b.textContent = def.label;
      b.dataset.tool = def.id;
      b.title = def.tip;
      b.style.cssText =
        'font:10px monospace;padding:2px 6px;cursor:pointer;border-radius:3px;' +
        'background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
      b.onclick = () => this.setTool(def.id);
      tools.appendChild(b);
    }

    const opts = document.createElement('div');
    opts.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    this.panel.appendChild(opts);
    const mk = (label: string, fn: () => void, tip?: string, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (tip) b.title = tip;
      b.style.cssText =
        'font:10px monospace;padding:2px 6px;cursor:pointer;border-radius:3px;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = fn;
      opts.appendChild(b);
      return b;
    };
    mk('Brush (B)', () => this.onKey('b'), 'Cycle brush size 1→2→4 minitiles (8px each).');
    mk(
      'Art (M)',
      () => this.onKey('m'),
      'Toggle a dark overlay that dims the map art so collision tints read clearly.'
    );
    mk(
      'Room@cursor (R)',
      () => this.onKey('r'),
      'Recompute the room-crop preview at the cursor (cyan = walkable minitiles).'
    );

    // Legend
    const legend = document.createElement('div');
    legend.style.cssText = 'font-size:10px;color:#9fb8cc;line-height:1.6;';
    legend.innerHTML =
      '<span style="background:repeating-linear-gradient(45deg,rgba(255,60,60,.85) 0 3px,rgba(20,0,0,.9) 3px 4px);padding:0 6px;">&nbsp;</span> solid 0x80 &nbsp;' +
      '<span style="background:rgba(70,130,255,.85);padding:0 6px;">&nbsp;</span> pri-lo 0x01 (lower half behind FG) &nbsp;' +
      '<span style="background:rgba(175,80,255,.9);padding:0 6px;">&nbsp;</span> pri-hi 0x02 (whole body behind FG)<br>' +
      '<span style="background:rgba(245,215,40,.9);padding:0 6px;">&nbsp;</span> <b>Behind (G)</b> 0x40 — minitile brush; redraws this tile-art in FRONT of you so you hide behind it. ' +
      'Use for BUILDINGS — pri-lo/hi only do something where the ROM already has foreground art.';
    this.panel.appendChild(legend);

    this.inspectorEl = document.createElement('div');
    this.inspectorEl.style.cssText =
      'font-size:11px;color:#9fb8cc;border-top:1px solid #243;padding-top:6px;min-height:28px;white-space:pre;';
    this.panel.appendChild(this.inspectorEl);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;';
    this.panel.appendChild(actions);
    const mkAction = (label: string, fn: () => void, tip?: string, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (tip) b.title = tip;
      b.style.cssText =
        'font:11px monospace;padding:3px 8px;cursor:pointer;border-radius:3px;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = fn;
      actions.appendChild(b);
    };
    mkAction(
      'Verify rooms',
      () => void this.runVerifier('rooms'),
      'Run the room-crop verifier against the painted collision (takes a minute).'
    );
    // No Save button — edits auto-save via the shell (registered 'collision'
    // handler); npcSim re-applies the override ~2s after the write.

    this.outputEl = document.createElement('pre');
    this.outputEl.style.cssText =
      'display:none;max-height:180px;overflow:auto;background:#0c1014;color:#9fb8cc;' +
      'font:10px monospace;padding:6px;border:1px solid #243;border-radius:3px;white-space:pre-wrap;';
    this.panel.appendChild(this.outputEl);

    this.shell!.panelHost.appendChild(this.panel);
    this.refreshPanel();
  }

  private async runVerifier(name: string): Promise<void> {
    if (!this.outputEl) return;
    this.outputEl.style.display = 'block';
    this.outputEl.textContent = `running ${name} verifier (takes a minute)...`;
    try {
      const res = await fetch('/__editor/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      this.outputEl.textContent = `${json.ok ? '✔' : '✘'} ${name}\n${json.output}`;
      this.shell?.toast(json.ok ? 'Verifier passed' : 'Verifier reported problems', !json.ok);
    } catch (err) {
      this.outputEl.textContent = String(err);
      this.shell?.toast(String(err), true);
    }
  }

  private refreshPanel(): void {
    if (!this.panel) return;
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
      const on = b.dataset.tool === this.tool;
      b.style.color = on ? '#e8a33d' : '#cde';
      b.style.borderColor = on ? '#e8a33d' : '#3a4a5a';
    }
    if (this.inspectorEl) {
      const c = this.inspect;
      const byte = c ? this.currentByte(c) : null;
      this.inspectorEl.textContent = c
        ? `tile (${c.tileX},${c.tileY}) cell ${c.idx}  byte 0x${byte!.toString(16).padStart(2, '0')}\n` +
          `${this.authored.size} authored cells · brush ${this.brush}x · stamp 0x${this.stampByte
            .toString(16)
            .padStart(2, '0')}`
        : `click a cell to inspect\n${this.authored.size} authored cells · brush ${this.brush}x`;
    }
  }
}

export const collisionTool = new CollisionTool();
registerSaveHandler(DOMAIN, () => collisionTool.save());
