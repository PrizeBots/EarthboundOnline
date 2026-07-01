import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { TILE_SIZE, MINITILE_SIZE, SECTOR_TILES_X, SECTOR_TILES_Y } from '../../types';
import { getTileAt, getSectorForTile } from '../../engine/MapManager';
import { getCollisionByteAt } from '../../engine/Collision';
import { roomAt } from '../../engine/Rooms';
import { isComposite } from '../../engine/CompositeTiles';

// Select Tile — a read-only inspector. Click a tile to select it, or drag a box to
// select many, then Copy to put a full JSON report of the tile(s) on the clipboard
// (paste it into chat to talk about them). Nothing here mutates the world; it just
// reads what the engine already knows about each cell: its arrangement id, sector
// tileset/palette/music/flags, the room it's in, and the 4×4 minitile collision
// bytes. It's a tool (not a header gesture) so plain map click/drag stays pan+move.

interface TileRect {
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
}

const MAX_COPY_TILES = 1024; // guard against copying a giant selection

const flagsOf = (byte: number | null): string => {
  if (byte === null) return '--';
  return (
    [
      byte & 0x80 ? 'SOLID' : null,
      byte & 0x40 ? 'FRONT' : null,
      byte & 0x20 ? 'BACK' : null,
      byte & 0x01 ? 'PRI-LO' : null,
      byte & 0x02 ? 'PRI-HI' : null,
    ]
      .filter(Boolean)
      .join('+') || 'walk'
  );
};

const hex = (b: number | null): string =>
  b === null ? '--' : '0x' + b.toString(16).padStart(2, '0');

class TileInspectorTool implements EditorTool {
  id = 'tile-inspect';
  name = 'Select Tile';
  description = 'Click/drag to select tile(s); copy full per-tile info as JSON.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private sel: TileRect | null = null;
  private hover: WorldPoint = { x: 0, y: 0 };
  private dragging = false;
  private anchor: { tx: number; ty: number } | null = null;

  private panel: HTMLDivElement | null = null;
  private infoEl: HTMLPreElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    this.buildPanel();
    this.refresh();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.sel = null;
    this.dragging = false;
    this.anchor = null;
  }

  // --- input -----------------------------------------------------------------

  onMouseDown(p: WorldPoint): boolean {
    const t = this.tileAt(p);
    if (!t) return false; // off-map → let the shell pan
    this.dragging = true;
    this.anchor = t;
    this.sel = { tx0: t.tx, ty0: t.ty, tx1: t.tx, ty1: t.ty };
    this.refresh();
    return true; // consume so the map doesn't pan/teleport
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (!this.dragging || !dragging || !this.anchor) return;
    const t = this.tileAt(p);
    if (!t) return;
    this.sel = {
      tx0: Math.min(this.anchor.tx, t.tx),
      ty0: Math.min(this.anchor.ty, t.ty),
      tx1: Math.max(this.anchor.tx, t.tx),
      ty1: Math.max(this.anchor.ty, t.ty),
    };
    this.refresh();
  }

  onMouseUp(): void {
    this.dragging = false;
    this.anchor = null;
    this.refresh();
  }

  /** The tile (col,row) under a world point, or null off the map. */
  private tileAt(p: WorldPoint): { tx: number; ty: number } | null {
    const tx = Math.floor(p.x / TILE_SIZE);
    const ty = Math.floor(p.y / TILE_SIZE);
    if (!getSectorForTile(tx, ty)) return null;
    return { tx, ty };
  }

  private selTiles(): { tx: number; ty: number }[] {
    if (!this.sel) return [];
    const out: { tx: number; ty: number }[] = [];
    for (let ty = this.sel.ty0; ty <= this.sel.ty1; ty++)
      for (let tx = this.sel.tx0; tx <= this.sel.tx1; tx++) out.push({ tx, ty });
    return out;
  }

  // --- the report ------------------------------------------------------------

  private tileReport(tx: number, ty: number): Record<string, unknown> {
    const arr = getTileAt(tx, ty);
    const sec = getSectorForTile(tx, ty);
    const cx = tx * TILE_SIZE + TILE_SIZE / 2;
    const cy = ty * TILE_SIZE + TILE_SIZE / 2;
    const room = roomAt(cx, cy);
    // 4×4 grid of minitile collision bytes (sampled at each minitile center).
    const bytes: (number | null)[] = [];
    for (let my = 0; my < 4; my++)
      for (let mx = 0; mx < 4; mx++)
        bytes.push(
          getCollisionByteAt(
            tx * TILE_SIZE + mx * MINITILE_SIZE + 4,
            ty * TILE_SIZE + my * MINITILE_SIZE + 4
          )
        );
    const union = bytes.reduce<number>((a, b) => a | (b ?? 0), 0);
    return {
      tile: { x: tx, y: ty },
      worldPx: { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE },
      sector: {
        x: Math.floor(tx / SECTOR_TILES_X),
        y: Math.floor(ty / SECTOR_TILES_Y),
        tilesetId: sec?.tilesetId ?? null,
        paletteId: sec?.paletteId ?? null,
        musicId: sec?.musicId ?? null,
        indoor: !!sec?.indoor,
        dungeon: !!sec?.dungeon,
        town: sec?.town ?? null,
      },
      room: room ? { id: room.id, label: room.label } : null,
      arrangement: arr,
      composite: isComposite(arr),
      collision: {
        flags: flagsOf(union),
        bytes: bytes.map(hex), // row-major 4×4 (minitiles)
      },
    };
  }

  /** The clipboard payload: one object for a single tile, else a wrapped array. */
  private buildReport(): unknown {
    const tiles = this.selTiles();
    if (tiles.length === 1) return this.tileReport(tiles[0].tx, tiles[0].ty);
    const capped = tiles.slice(0, MAX_COPY_TILES);
    return {
      selection: {
        x: this.sel!.tx0,
        y: this.sel!.ty0,
        w: this.sel!.tx1 - this.sel!.tx0 + 1,
        h: this.sel!.ty1 - this.sel!.ty0 + 1,
        count: tiles.length,
        ...(tiles.length > MAX_COPY_TILES ? { truncatedTo: MAX_COPY_TILES } : {}),
      },
      tiles: capped.map((t) => this.tileReport(t.tx, t.ty)),
    };
  }

  private async copy(): Promise<void> {
    if (!this.sel) {
      this.shell?.toast('Select a tile first (click the map)', true);
      return;
    }
    const text = JSON.stringify(this.buildReport(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for when the async clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const n = this.selTiles().length;
    this.shell?.toast(`Copied ${n} tile${n === 1 ? '' : 's'} to clipboard`);
  }

  // --- overlay ---------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    const zoom = camera.zoom || 1;
    const lw = 1 / zoom;

    // Hover tile outline.
    const ht = this.tileAt(this.hover);
    if (ht) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(120,220,255,0.55)';
      ctx.strokeRect(ht.tx * TILE_SIZE - camX, ht.ty * TILE_SIZE - camY, TILE_SIZE, TILE_SIZE);
    }

    // Selection box.
    if (this.sel) {
      const x = this.sel.tx0 * TILE_SIZE - camX;
      const y = this.sel.ty0 * TILE_SIZE - camY;
      const w = (this.sel.tx1 - this.sel.tx0 + 1) * TILE_SIZE;
      const h = (this.sel.ty1 - this.sel.ty0 + 1) * TILE_SIZE;
      ctx.fillStyle = 'rgba(90,208,232,0.12)';
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = lw * 2;
      ctx.strokeStyle = '#5ad0e8';
      ctx.strokeRect(x, y, w, h);
    }
  }

  // --- panel -----------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;' +
      'font:12px monospace;border:1px solid #5ad0e8;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.textContent = 'SELECT TILE';
    title.style.cssText = 'color:#5ad0e8;font-weight:bold;letter-spacing:1px;flex:1;';
    header.appendChild(title);
    this.mkBtn('⧉ Copy', () => void this.copy(), header, true);
    this.panel.appendChild(header);

    this.infoEl = document.createElement('pre');
    this.infoEl.style.cssText =
      'margin:0;white-space:pre-wrap;word-break:break-word;font:11px monospace;color:#bfe3ff;' +
      'max-height:320px;overflow:auto;background:#0c1016;border:1px solid #223;border-radius:3px;padding:6px;';
    this.panel.appendChild(this.infoEl);

    const hint = document.createElement('div');
    hint.textContent = 'click a tile · drag to select many · Copy → clipboard (JSON)';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.panel.appendChild(hint);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refresh(): void {
    if (!this.infoEl) return;
    if (!this.sel) {
      this.infoEl.textContent = 'No tile selected.\nClick the map to pick one.';
      return;
    }
    const tiles = this.selTiles();
    if (tiles.length === 1) {
      this.infoEl.textContent = JSON.stringify(this.tileReport(tiles[0].tx, tiles[0].ty), null, 2);
      return;
    }
    // Multi-tile: show the box summary + the first tile as a preview.
    const s = this.sel;
    const summary =
      `selection ${s.tx1 - s.tx0 + 1}×${s.ty1 - s.ty0 + 1} tiles ` +
      `(${tiles.length} total) at tile (${s.tx0},${s.ty0})\n` +
      `— Copy grabs the full array —\n\nfirst tile:\n`;
    this.infoEl.textContent = summary + JSON.stringify(this.tileReport(s.tx0, s.ty0), null, 2);
  }

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 8px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#123338;color:#5ad0e8;border:1px solid #5ad0e8;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }
}

export const tileInspectorTool = new TileInspectorTool();
