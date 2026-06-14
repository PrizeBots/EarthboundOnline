import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import {
  getTileAt,
  getSectorForTile,
  getOverworldHeightTiles,
  buildCustomRoomBand,
} from '../../engine/MapManager';
import { listRooms } from '../../engine/Rooms';
import { MAP_WIDTH_TILES, TILE_SIZE, SECTOR_TILES_Y, SectorMeta } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';

// Room Builder — author CUSTOM rooms that don't exist in the ROM. Flow: click
// "New Room", drag a marquee over any area of the map, then "Copy" to clone that
// rectangle of tiles into a new standalone room in the interiors band
// (overrides/rooms.json). Wire a door to it (Door editor) and paint it (Tile
// Painter, planned). The ROM's tiles.json is never touched.

interface CustomRoom {
  id: string;
  label: string;
  town?: string | null;
  type?: string | null;
  bandX: number;
  bandY: number;
  w: number;
  h: number;
  sector: SectorMeta;
  tiles: number[];
  spawnDX: number;
  spawnDY: number;
  spawnDir: number;
}
interface CustomRoomsDoc { version: number; rooms: CustomRoom[]; }

const BAND_GAP_TILES = SECTOR_TILES_Y; // 1 sector gap isolates room crops

interface TileRect { tx: number; ty: number; w: number; h: number; }

class RoomBuilderTool implements EditorTool {
  id = 'room-builder';
  name = 'Room Builder';
  description = 'Drag a box over an area and copy it into a new custom room.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;

  private selecting = false;          // armed for a marquee drag
  private dragStart: { tx: number; ty: number } | null = null;
  private sel: TileRect | null = null; // committed selection (tiles)

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    this.buildPanel();
    this.refreshList();
    this.updateStatus();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.selecting = false;
    this.dragStart = null;
    this.sel = null;
  }

  // --- marquee selection (mouse) ---------------------------------------------

  onMouseDown(p: WorldPoint): boolean {
    if (!this.selecting) return false; // let the shell pan when not armed
    this.dragStart = { tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) };
    this.sel = { tx: this.dragStart.tx, ty: this.dragStart.ty, w: 1, h: 1 };
    return true;
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    if (!this.selecting || !this.dragStart || !dragging) return;
    const tx = Math.floor(p.x / TILE_SIZE);
    const ty = Math.floor(p.y / TILE_SIZE);
    this.sel = {
      tx: Math.min(this.dragStart.tx, tx),
      ty: Math.min(this.dragStart.ty, ty),
      w: Math.abs(tx - this.dragStart.tx) + 1,
      h: Math.abs(ty - this.dragStart.ty) + 1,
    };
    this.updateStatus();
  }

  onMouseUp(): void {
    if (!this.selecting) return;
    this.dragStart = null; // selection committed; stays drawn until Copy/Cancel
    this.updateStatus();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.sel) return;
    const x = this.sel.tx * TILE_SIZE - Math.round(camera.x);
    const y = this.sel.ty * TILE_SIZE - Math.round(camera.y);
    const w = this.sel.w * TILE_SIZE;
    const h = this.sel.h * TILE_SIZE;
    ctx.fillStyle = 'rgba(77,182,232,0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#4db6e8';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#bfe3ff';
    ctx.font = '11px monospace';
    ctx.fillText(`${this.sel.w}x${this.sel.h} tiles`, x + 3, y - 4);
  }

  // --- copy the selected rectangle into a new custom room --------------------

  private async copySelection(): Promise<void> {
    if (!this.sel || this.sel.w < 1 || this.sel.h < 1) {
      this.shell!.toast('Drag a box over an area first', true);
      return;
    }
    const { tx, ty, w, h } = this.sel;
    const grid: number[] = new Array(w * h);
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) grid[ly * w + lx] = getTileAt(tx + lx, ty + ly);
    }
    // Sector style from the selection's center tile (drives render + collision).
    const srcSec = getSectorForTile(tx + (w >> 1), ty + (h >> 1));
    const sector: SectorMeta = {
      tilesetId: srcSec?.tilesetId ?? 0,
      paletteId: srcSec?.paletteId ?? 0,
      musicId: srcSec?.musicId ?? 0,
      indoor: true,
      dungeon: false,
    } as SectorMeta;

    const doc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    const bandX = 0;
    const bandY = this.nextBandY(doc.rooms);
    const room: CustomRoom = {
      id: `custom_${Date.now().toString(36)}`,
      label: `New Room ${doc.rooms.length + 1}`,
      town: 'custom', type: 'custom',
      bandX, bandY, w, h, sector, tiles: grid,
      spawnDX: (w >> 1) * 32 + 16, spawnDY: (h >> 1) * 32 + 16, spawnDir: 0,
    };
    doc.rooms.push(room);

    try {
      await saveOverride('rooms.json', doc);
      await buildCustomRoomBand();
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
      return;
    }
    this.selecting = false;
    this.sel = null;
    this.refreshList();
    this.updateStatus();
    // Editor navigation (goTo), NOT gameplay teleport — teleport would set the
    // gameplay room-crop to the band room while the free-fly camera stays over
    // the overworld, clipping the whole view to off-screen tiles (black screen).
    this.shell!.goTo(bandX * 32 + room.spawnDX, bandY * 32 + room.spawnDY);
    this.shell!.toast(`Copied ${w}x${h} tiles → "${room.label}" (rename/link in Places)`);
  }

  /** Stack new rooms below the lowest existing one, sector-aligned, with a gap. */
  private nextBandY(rooms: CustomRoom[]): number {
    let bottom = getOverworldHeightTiles();
    for (const r of rooms) {
      bottom = Math.max(bottom, r.bandY + Math.ceil(r.h / SECTOR_TILES_Y) * SECTOR_TILES_Y);
    }
    return bottom + BAND_GAP_TILES;
  }

  private async deleteRoom(id: string): Promise<void> {
    const doc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    doc.rooms = doc.rooms.filter((r) => r.id !== id);
    await saveOverride('rooms.json', doc);
    await buildCustomRoomBand();
    this.refreshList();
    this.shell!.toast(`Deleted room ${id}`);
  }

  // --- panel -----------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #4db6e8;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:8px;user-select:none;';

    const title = document.createElement('div');
    title.textContent = 'ROOM BUILDER';
    title.style.cssText = 'color:#4db6e8;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'color:#9fb8cc;font-size:11px;line-height:1.4;min-height:28px;';
    this.panel.appendChild(this.statusEl);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('New Room', () => this.startSelecting(), row, true);
    this.copyBtn = this.mkBtn('Copy', () => void this.copySelection(), row);
    this.mkBtn('Cancel', () => this.cancel(), row);
    this.panel.appendChild(row);

    const listTitle = document.createElement('div');
    listTitle.textContent = 'Custom rooms';
    listTitle.style.cssText = 'color:#9fb8cc;font-size:11px;margin-top:4px;';
    this.panel.appendChild(listTitle);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText = 'display:flex;flex-direction:column;gap:3px;max-height:200px;overflow:auto;';
    this.panel.appendChild(this.listEl);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private startSelecting(): void {
    this.selecting = true;
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
    this.shell!.toast('Drag a box over the area to copy, then click Copy');
  }

  private cancel(): void {
    this.selecting = false;
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    if (!this.selecting) {
      this.statusEl.textContent = 'Navigate to a room, then click New Room and drag a box over it.';
    } else if (!this.sel) {
      this.statusEl.textContent = '▸ Drag a box over the area you want to copy…';
    } else {
      this.statusEl.textContent = `▸ Selected ${this.sel.w}x${this.sel.h} tiles. Click Copy to make it a room.`;
    }
    if (this.copyBtn) this.copyBtn.disabled = !this.sel;
    if (this.copyBtn) this.copyBtn.style.opacity = this.sel ? '1' : '0.45';
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    const rooms = listRooms();
    if (rooms.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(none yet)';
      empty.style.cssText = 'color:#678;font-size:11px;';
      this.listEl.appendChild(empty);
      return;
    }
    for (const r of rooms) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const name = document.createElement('span');
      name.textContent = r.label;
      name.title = `${r.id} · ${r.rect.w / 32}x${r.rect.h / 32}t`;
      name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:#bfe3ff;';
      name.onclick = () => this.shell!.goTo(r.spawn?.x ?? r.rect.x, r.spawn?.y ?? r.rect.y);
      row.appendChild(name);
      const del = document.createElement('span');
      del.textContent = '✕';
      del.title = 'Delete this custom room';
      del.style.cssText = 'cursor:pointer;color:#ff8a7a;width:16px;text-align:center;';
      del.onclick = () => void this.deleteRoom(r.id);
      row.appendChild(del);
      this.listEl.appendChild(row);
    }
  }

  private mkBtn(label: string, fn: () => void, parent: HTMLElement, accent = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:4px 9px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#10303d;color:#4db6e8;border:1px solid #4db6e8;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }
}

export const roomBuilderTool = new RoomBuilderTool();
