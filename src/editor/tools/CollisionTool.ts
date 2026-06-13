import {
  CollisionOverrides,
  computeRoomBounds,
  getCollisionCellAt,
  getCollisionRow,
  getPristineCollisionByte,
  setCollisionByteLive,
} from '../../engine/Collision';
import { getSectorForTile, getTileAt, getDrawTilesetId } from '../../engine/MapManager';
import { Camera } from '../../engine/Camera';
import { MAP_WIDTH_TILES, MAP_HEIGHT_TILES, TILE_SIZE } from '../../types';
import { saveOverride } from '../saveOverride';
import { registerSaveHandler } from '../EditorHub';
import { EditorShellApi, EditorTool, WorldPoint } from '../types';

// Collision & Priority Painter (EDITOR_TOOLS.md §3). Paints the minitile
// collision bytes: solid 0x80, sprite-priority 0x01 (lower half behind FG)
// and 0x02 (upper half behind FG).
//
// IMPORTANT MODEL: collision is PER-ARRANGEMENT (an attribute of the tile
// graphic — BG tile attributes on real SNES), NOT per map cell. Painting one
// cell edits that arrangement everywhere it appears on the map; the panel
// shows the use count and 'U' highlights every visible instance before you
// commit. Edits apply LIVE to the loaded collision (room-crop preview runs
// against painted state) and save as diffs to overrides/collision.json,
// which Collision.ts, npcSim, and debug_room_crop_check.py all re-apply.

const DOMAIN = 'collision';
const MINITILE = 8;

type PaintTool = 'solid' | 'prilo' | 'prihi' | 'clear' | 'stamp' | 'eyedrop' | 'rect';
const TOOL_DEFS: { id: PaintTool; label: string; key: string }[] = [
  { id: 'solid', label: 'S Solid', key: 's' },
  { id: 'prilo', label: 'L Pri-lo', key: 'l' },
  { id: 'prihi', label: 'H Pri-hi', key: 'h' },
  { id: 'clear', label: 'C Clear', key: 'c' },
  { id: 'eyedrop', label: 'E Eyedrop', key: 'e' },
  { id: 'stamp', label: 'X Stamp', key: 'x' },
  { id: 'rect', label: 'T Rect', key: 't' },
];
const BIT: Record<string, number> = { solid: 0x80, prilo: 0x01, prihi: 0x02 };

/** One paintable data cell (per-arrangement, so shared by map instances). */
interface CellRef {
  drawTs: number;
  arr: number;
  idx: number;
}

const cellKey = (c: CellRef) => `${c.drawTs}:${c.arr}:${c.idx}`;

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

  // Authored cells: key -> byte (only where current differs from pristine).
  private authored = new Map<string, { cell: CellRef; byte: number }>();

  // Stroke state
  private painting = false;
  private strokeBit = 0; // bit being painted this stroke (bit tools)
  private strokeSetting = true; // first cell decides: set or clear
  private strokeChanges = new Map<string, { cell: CellRef; before: number; after: number }>();
  private rectStart: WorldPoint | null = null;

  // Inspector / blast radius
  private inspect: CellRef | null = null;
  private inspectUses = 0;
  private highlightUses = false;

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

  /** Seed the authored map from the override file already applied at load. */
  private async loadAuthored(): Promise<void> {
    this.authored.clear();
    try {
      const res = await fetch('/overrides/collision.json', { cache: 'no-store' });
      if (!res.ok) return;
      const ov = (await res.json()) as CollisionOverrides;
      for (const [key, cells] of Object.entries(ov.edits ?? {})) {
        const [drawTs, arr] = key.split(':').map(Number);
        for (const [idx, byte] of Object.entries(cells)) {
          const cell = { drawTs, arr, idx: Number(idx) };
          this.authored.set(cellKey(cell), { cell, byte });
        }
      }
    } catch {
      /* nothing authored yet */
    }
    this.refreshPanel();
  }

  private buildOverrides(): CollisionOverrides {
    const edits: NonNullable<CollisionOverrides['edits']> = {};
    for (const { cell, byte } of this.authored.values()) {
      const key = `${cell.drawTs}:${cell.arr}`;
      (edits[key] ??= {})[String(cell.idx)] = byte;
    }
    return { version: 1, edits };
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
        const cell = getCollisionCellAt(x0 + dx + 1, y0 + dy + 1);
        if (!cell) continue;
        const key = cellKey(cell);
        if (seen.has(key)) continue; // same arrangement cell via two map tiles
        seen.add(key);
        out.push(cell);
      }
    }
    return out;
  }

  private currentByte(cell: CellRef): number {
    return getCollisionRow(cell.drawTs, cell.arr)?.[cell.idx] ?? 0;
  }

  private paintCells(cells: CellRef[]): void {
    for (const cell of cells) {
      const before = this.currentByte(cell);
      let after = before;
      if (this.tool === 'clear') after = 0;
      else if (this.tool === 'stamp') after = this.stampByte;
      else after = this.strokeSetting ? before | this.strokeBit : before & ~this.strokeBit;
      if (after === before) continue;

      const key = cellKey(cell);
      const prev = this.strokeChanges.get(key);
      this.strokeChanges.set(key, { cell, before: prev?.before ?? before, after });
      setCollisionByteLive(cell.drawTs, cell.arr, cell.idx, after);
    }
  }

  /** Track authored state for a cell against its pristine byte. */
  private syncAuthored(cell: CellRef): void {
    const key = cellKey(cell);
    const now = this.currentByte(cell);
    const pristine = getPristineCollisionByte(cell.drawTs, cell.arr, cell.idx);
    if (pristine === null || now === pristine) this.authored.delete(key);
    else this.authored.set(key, { cell, byte: now });
  }

  private commitStroke(label: string): void {
    if (this.strokeChanges.size === 0) return;
    const changes = [...this.strokeChanges.values()];
    this.strokeChanges = new Map();
    const apply = (dir: 'after' | 'before') => {
      for (const c of changes) {
        setCollisionByteLive(c.cell.drawTs, c.cell.arr, c.cell.idx, c[dir]);
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
    const cell = getCollisionCellAt(p.x, p.y);
    if (!cell) return false;
    this.setInspect(cell);

    if (this.tool === 'eyedrop') {
      this.stampByte = this.currentByte(cell);
      this.setTool('stamp');
      this.shell?.toast(`Picked 0x${this.stampByte.toString(16).padStart(2, '0')} — stamp to paint`);
      return true;
    }
    if (this.tool === 'rect') {
      this.rectStart = { ...p };
      return true;
    }
    // Bit tools decide set-vs-clear from the first cell under the brush.
    if (this.tool in BIT) {
      this.strokeBit = BIT[this.tool];
      this.strokeSetting = (this.currentByte(cell) & this.strokeBit) === 0;
    }
    this.painting = true;
    this.strokeChanges = new Map();
    this.paintCells(this.cellsUnderBrush(p));
    return true;
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (dragging && this.painting) {
      this.paintCells(this.cellsUnderBrush(p));
    }
  }

  onMouseUp(p: WorldPoint): void {
    if (this.rectStart) {
      const a = this.rectStart;
      this.rectStart = null;
      const first = getCollisionCellAt(a.x, a.y);
      if (first) {
        // Rect uses the SOLID bit semantics of the first corner cell.
        this.strokeBit = BIT.solid;
        this.strokeSetting = (this.currentByte(first) & BIT.solid) === 0;
        this.strokeChanges = new Map();
        const cells: CellRef[] = [];
        const seen = new Set<string>();
        const x0 = Math.min(a.x, p.x);
        const x1 = Math.max(a.x, p.x);
        const y0 = Math.min(a.y, p.y);
        const y1 = Math.max(a.y, p.y);
        for (let y = Math.floor(y0 / MINITILE) * MINITILE; y <= y1; y += MINITILE) {
          for (let x = Math.floor(x0 / MINITILE) * MINITILE; x <= x1; x += MINITILE) {
            const c = getCollisionCellAt(x + 1, y + 1);
            if (!c || seen.has(cellKey(c))) continue;
            seen.add(cellKey(c));
            cells.push(c);
          }
        }
        // 'rect' falls through paintCells' bit branch using strokeBit/Setting.
        this.paintCells(cells);
        this.commitStroke(`rect ${this.strokeSetting ? 'solid' : 'clear-solid'} (${cells.length} cells)`);
      }
      return;
    }
    if (this.painting) {
      this.painting = false;
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
    if (key === 'u') {
      this.highlightUses = !this.highlightUses;
      this.refreshPanel();
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
    // Blast radius: how many map tiles use this arrangement.
    let uses = 0;
    for (let ty = 0; ty < MAP_HEIGHT_TILES; ty++) {
      for (let tx = 0; tx < MAP_WIDTH_TILES; tx++) {
        const sector = getSectorForTile(tx, ty);
        if (!sector) continue;
        if (getDrawTilesetId(sector.tilesetId) !== cell.drawTs) continue;
        if (getTileAt(tx, ty) === cell.arr) uses++;
      }
    }
    this.inspectUses = uses;
    this.refreshPanel();
  }

  private refreshRoomPreview(at?: WorldPoint): void {
    if (at) this.roomPoint = { ...at };
    if (!this.roomPoint) return;
    const bounds = computeRoomBounds(this.roomPoint.x, this.roomPoint.y);
    this.roomCells = bounds?.cells ?? null;
    if (at) {
      this.shell?.toast(
        bounds ? `Room recomputed: ${bounds.cells.size} walkable minitiles` : 'No croppable room here'
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

    // Per-tile pass: tint collision bits. Solid = red full cell; pri-lo =
    // blue LOWER half; pri-hi = green UPPER half (matching their meaning).
    const t0x = Math.floor(camX / TILE_SIZE);
    const t0y = Math.floor(camY / TILE_SIZE);
    const t1x = Math.ceil((camX + vw) / TILE_SIZE);
    const t1y = Math.ceil((camY + vh) / TILE_SIZE);
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const sector = getSectorForTile(tx, ty);
        if (!sector) continue;
        const drawTs = getDrawTilesetId(sector.tilesetId);
        const arr = getTileAt(tx, ty);
        const row = getCollisionRow(drawTs, arr);
        if (!row) continue;

        const baseX = tx * TILE_SIZE - camX;
        const baseY = ty * TILE_SIZE - camY;
        for (let i = 0; i < 16; i++) {
          const b = row[i];
          if (b === 0) continue;
          const cx = baseX + (i % 4) * MINITILE;
          const cy = baseY + (i >> 2) * MINITILE;
          if (b & 0x80) {
            ctx.fillStyle = 'rgba(255,64,64,0.42)';
            ctx.fillRect(cx, cy, MINITILE, MINITILE);
          }
          if (b & 0x01) {
            ctx.fillStyle = 'rgba(90,140,255,0.55)';
            ctx.fillRect(cx, cy + MINITILE / 2, MINITILE, MINITILE / 2);
          }
          if (b & 0x02) {
            ctx.fillStyle = 'rgba(90,255,140,0.5)';
            ctx.fillRect(cx, cy, MINITILE, MINITILE / 2);
          }
        }

        // Blast radius: outline every instance of the inspected arrangement.
        if (
          this.highlightUses &&
          this.inspect &&
          drawTs === this.inspect.drawTs &&
          arr === this.inspect.arr
        ) {
          ctx.strokeStyle = 'rgba(255,230,80,0.9)';
          ctx.strokeRect(baseX + 0.5, baseY + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
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
      'position:fixed;top:36px;right:8px;z-index:91;width:240px;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #e8a33d;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';

    const head = document.createElement('div');
    head.textContent = 'COLLISION PAINTER';
    head.style.cssText = 'color:#e8a33d;letter-spacing:1px;';
    this.panel.appendChild(head);

    const warn = document.createElement('div');
    warn.style.cssText = 'color:#ffb38a;font-size:10px;';
    warn.textContent =
      'Edits are PER-ARRANGEMENT: one paint changes every map tile using that graphic. Check uses (U) first.';
    this.panel.appendChild(warn);

    const tools = document.createElement('div');
    tools.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    this.panel.appendChild(tools);
    for (const def of TOOL_DEFS) {
      const b = document.createElement('button');
      b.textContent = def.label;
      b.dataset.tool = def.id;
      b.style.cssText =
        'font:10px monospace;padding:2px 6px;cursor:pointer;border-radius:3px;' +
        'background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
      b.onclick = () => this.setTool(def.id);
      tools.appendChild(b);
    }

    const opts = document.createElement('div');
    opts.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    this.panel.appendChild(opts);
    const mk = (label: string, fn: () => void, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:10px monospace;padding:2px 6px;cursor:pointer;border-radius:3px;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = fn;
      opts.appendChild(b);
      return b;
    };
    mk('Brush (B)', () => this.onKey('b'));
    mk('Art (M)', () => this.onKey('m'));
    mk('Room@cursor (R)', () => this.onKey('r'));
    mk('Uses (U)', () => this.onKey('u'));

    // Legend
    const legend = document.createElement('div');
    legend.style.cssText = 'font-size:10px;color:#9fb8cc;line-height:1.6;';
    legend.innerHTML =
      '<span style="background:rgba(255,64,64,.6);padding:0 6px;">&nbsp;</span> solid 0x80 &nbsp;' +
      '<span style="background:rgba(90,140,255,.7);padding:0 6px;">&nbsp;</span> pri-lo 0x01 &nbsp;' +
      '<span style="background:rgba(90,255,140,.6);padding:0 6px;">&nbsp;</span> pri-hi 0x02';
    this.panel.appendChild(legend);

    this.inspectorEl = document.createElement('div');
    this.inspectorEl.style.cssText =
      'font-size:11px;color:#9fb8cc;border-top:1px solid #243;padding-top:6px;min-height:28px;white-space:pre;';
    this.panel.appendChild(this.inspectorEl);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;';
    this.panel.appendChild(actions);
    const mkAction = (label: string, fn: () => void, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:11px monospace;padding:3px 8px;cursor:pointer;border-radius:3px;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = fn;
      actions.appendChild(b);
    };
    mkAction('Verify rooms', () => void this.runVerifier('rooms'));
    mkAction('Save', () => {
      void this.save()
        .then(() => {
          this.shell?.clearDirty(DOMAIN);
          this.shell?.toast('Saved overrides/collision.json (npcSim re-applies in ~2s)');
        })
        .catch((err) => this.shell?.toast(String(err), true));
    }, true);

    this.outputEl = document.createElement('pre');
    this.outputEl.style.cssText =
      'display:none;max-height:180px;overflow:auto;background:#0c1014;color:#9fb8cc;' +
      'font:10px monospace;padding:6px;border:1px solid #243;border-radius:3px;white-space:pre-wrap;';
    this.panel.appendChild(this.outputEl);

    document.body.appendChild(this.panel);
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
      const byte = c ? (getCollisionRow(c.drawTs, c.arr)?.[c.idx] ?? 0) : null;
      this.inspectorEl.textContent = c
        ? `arr ts${c.drawTs}:${c.arr} cell ${c.idx}  byte 0x${byte!.toString(16).padStart(2, '0')}\n` +
          `used by ${this.inspectUses} map tiles${this.highlightUses ? ' (highlighted)' : ''}\n` +
          `${this.authored.size} authored cells · brush ${this.brush}x · stamp 0x${this.stampByte
            .toString(16)
            .padStart(2, '0')}`
        : `click a cell to inspect\n${this.authored.size} authored cells · brush ${this.brush}x`;
    }
  }
}

export const collisionTool = new CollisionTool();
registerSaveHandler(DOMAIN, () => collisionTool.save());
