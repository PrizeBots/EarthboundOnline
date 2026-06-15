import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import {
  getTileAt,
  getSectorForTile,
  getOverworldHeightTiles,
  buildCustomRoomBand,
} from '../../engine/MapManager';
import { listRooms } from '../../engine/Rooms';
import { drawTile, loadAtlas } from '../../engine/TilesetManager';
import { primeJSONCache } from '../../engine/AssetLoader';
import { MAP_WIDTH_TILES, TILE_SIZE, SECTOR_TILES_Y, SectorMeta } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';

// Room Builder + Stamp Sampler — author CUSTOM rooms that don't exist in the ROM.
//
// Two ways to build:
//   1. Copy → New Room: drag a marquee over any map area and clone that whole
//      rectangle into a new standalone room in the interiors band.
//   2. Sampler: drag a marquee → "Save Stamp" captures that rectangle as a
//      reusable STAMP (overrides/stamps.json). Make a blank room, pick a stamp,
//      and Paint it in (click or drag) to compose a room piece by piece.
//
// A stamp stores ARRANGEMENT INDICES (not pixels) + the source tileset/palette,
// so it's our authored metadata, never ROM-derived. Collision rides along for
// free — it's keyed per arrangement. Because arrangements are tileset-specific,
// a stamp only paints into a room of the SAME tileset/palette (blank rooms adopt
// the active stamp's style). The ROM's tiles.json is never touched.

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
interface CustomRoomsDoc {
  version: number;
  rooms: CustomRoom[];
}

// A reusable tile stamp sampled from anywhere in the world.
interface Stamp {
  id: string;
  label: string;
  w: number; // size in tiles
  h: number;
  tilesetId: number; // source map tileset (arrangements are tileset-specific)
  paletteId: number;
  tiles: number[]; // w*h arrangement ids, row-major
}
interface StampsDoc {
  version: number;
  stamps: Stamp[];
}

const BAND_GAP_TILES = SECTOR_TILES_Y; // 1 sector gap isolates room crops

interface TileRect {
  tx: number;
  ty: number;
  w: number;
  h: number;
}

class RoomBuilderTool implements EditorTool {
  id = 'room-builder';
  name = 'Room Builder';
  description = 'Sample tiles into stamps and paint them to build new rooms.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private libraryEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private stampBtn: HTMLButtonElement | null = null;
  private paintBtn: HTMLButtonElement | null = null;

  // marquee selection (for Copy / Save Stamp / sizing a blank room)
  private selecting = false;
  private pendingBlank = false; // the next marquee defines a blank room's size
  private dragStart: { tx: number; ty: number } | null = null;
  private sel: TileRect | null = null;

  // stamp library + paint
  private stamps: Stamp[] = [];
  private activeStampId: string | null = null;
  private painting = false;
  private hoverTile: { tx: number; ty: number } | null = null;
  private rooms: CustomRoom[] = []; // in-memory mirror of overrides/rooms.json
  private lastPaintedKey = ''; // dedup within a drag stroke
  private strokeDirty = false; // a stroke touched tiles → persist on up
  private warnedStyle = false; // throttle the style-mismatch toast per stroke

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    this.buildPanel();
    void this.reloadData();
    this.updateStatus();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.selecting = false;
    this.painting = false;
    this.dragStart = null;
    this.sel = null;
    this.hoverTile = null;
  }

  private async reloadData(): Promise<void> {
    const sdoc = (await loadOverride<StampsDoc>('stamps.json')) ?? { version: 1, stamps: [] };
    this.stamps = sdoc.stamps;
    const rdoc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    this.rooms = rdoc.rooms;
    if (this.activeStampId && !this.stamps.some((s) => s.id === this.activeStampId)) {
      this.activeStampId = null;
    }
    await this.primeActiveAtlas();
    this.refreshLibrary();
    this.refreshList();
  }

  private activeStamp(): Stamp | null {
    return this.stamps.find((s) => s.id === this.activeStampId) ?? null;
  }

  private async primeActiveAtlas(): Promise<void> {
    const s = this.activeStamp();
    if (s) await loadAtlas(s.tilesetId, s.paletteId);
  }

  // --- mouse: marquee select OR paint ---------------------------------------

  onMouseDown(p: WorldPoint): boolean {
    if (this.painting) {
      this.lastPaintedKey = '';
      this.strokeDirty = false;
      this.warnedStyle = false;
      this.stampAt(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE));
      return true; // claim the drag so the shell doesn't pan
    }
    if (!this.selecting) return false; // let the shell pan when idle
    this.dragStart = { tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) };
    this.sel = { tx: this.dragStart.tx, ty: this.dragStart.ty, w: 1, h: 1 };
    return true;
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hoverTile = { tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) };
    if (this.painting) {
      if (dragging) this.stampAt(this.hoverTile.tx, this.hoverTile.ty);
      return;
    }
    if (!this.selecting || !this.dragStart || !dragging) return;
    const tx = this.hoverTile.tx;
    const ty = this.hoverTile.ty;
    this.sel = {
      tx: Math.min(this.dragStart.tx, tx),
      ty: Math.min(this.dragStart.ty, ty),
      w: Math.abs(tx - this.dragStart.tx) + 1,
      h: Math.abs(ty - this.dragStart.ty) + 1,
    };
    this.updateStatus();
  }

  onMouseUp(): void {
    if (this.painting) {
      if (this.strokeDirty) void this.persistRooms();
      this.strokeDirty = false;
      return;
    }
    if (!this.selecting) return;
    this.dragStart = null;
    // A blank-room marquee commits immediately: the box size IS the room size.
    if (this.pendingBlank && this.sel && this.sel.w >= 1 && this.sel.h >= 1) {
      const { w, h } = this.sel;
      this.pendingBlank = false;
      this.selecting = false;
      this.sel = null;
      void this.createBlankRoom(w, h);
      return;
    }
    // Otherwise the selection stays drawn until Copy / Save Stamp / Cancel.
    this.updateStatus();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    // Marquee selection box — green while sizing a new blank room, blue to sample.
    if (this.sel) {
      const x = this.sel.tx * TILE_SIZE - Math.round(camera.x);
      const y = this.sel.ty * TILE_SIZE - Math.round(camera.y);
      const w = this.sel.w * TILE_SIZE;
      const h = this.sel.h * TILE_SIZE;
      const fill = this.pendingBlank ? 'rgba(124,252,106,0.16)' : 'rgba(77,182,232,0.18)';
      const line = this.pendingBlank ? '#7CFC6A' : '#4db6e8';
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = this.pendingBlank ? '#d4ffcb' : '#bfe3ff';
      ctx.font = '11px monospace';
      ctx.fillText(
        `${this.pendingBlank ? 'new room ' : ''}${this.sel.w}x${this.sel.h} tiles`,
        x + 3,
        y - 4
      );
    }

    // Paint ghost: the active stamp previewed under the cursor.
    const stamp = this.activeStamp();
    if (this.painting && stamp && this.hoverTile) {
      const ox = this.hoverTile.tx;
      const oy = this.hoverTile.ty;
      const room = this.roomAt(ox, oy);
      const valid =
        !!room &&
        room.sector.tilesetId === stamp.tilesetId &&
        room.sector.paletteId === stamp.paletteId;
      ctx.save();
      ctx.globalAlpha = 0.6;
      for (let ly = 0; ly < stamp.h; ly++) {
        for (let lx = 0; lx < stamp.w; lx++) {
          const sx = (ox + lx) * TILE_SIZE - Math.round(camera.x);
          const sy = (oy + ly) * TILE_SIZE - Math.round(camera.y);
          drawTile(
            ctx,
            stamp.tilesetId,
            stamp.paletteId,
            stamp.tiles[ly * stamp.w + lx] ?? 0,
            sx,
            sy
          );
        }
      }
      ctx.restore();
      const gx = ox * TILE_SIZE - Math.round(camera.x);
      const gy = oy * TILE_SIZE - Math.round(camera.y);
      ctx.strokeStyle = valid ? '#7CFC6A' : '#ff6a6a';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx + 0.5, gy + 0.5, stamp.w * TILE_SIZE - 1, stamp.h * TILE_SIZE - 1);
    }
  }

  // --- Copy the selected rectangle into a new standalone room ----------------

  private async copySelection(): Promise<void> {
    if (!this.sel || this.sel.w < 1 || this.sel.h < 1) {
      this.shell!.toast('Select an area first', true);
      return;
    }
    const { tx, ty, w, h } = this.sel;
    const grid = this.readRegion(tx, ty, w, h);
    const sector = this.sampleStyle(tx, ty, w, h, true);

    const doc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    const bandY = this.nextBandY(doc.rooms);
    const room: CustomRoom = {
      id: `custom_${Date.now().toString(36)}`,
      label: `New Room ${doc.rooms.length + 1}`,
      town: 'custom',
      type: 'custom',
      bandX: 0,
      bandY,
      w,
      h,
      sector,
      tiles: grid,
      spawnDX: (w >> 1) * 32 + 16,
      spawnDY: (h >> 1) * 32 + 16,
      spawnDir: 0,
    };
    doc.rooms.push(room);
    try {
      await saveOverride('rooms.json', doc);
      await buildCustomRoomBand();
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
      return;
    }
    this.rooms = doc.rooms;
    this.selecting = false;
    this.sel = null;
    this.refreshList();
    this.updateStatus();
    this.shell!.goTo(room.bandX * 32 + room.spawnDX, bandY * 32 + room.spawnDY);
    this.shell!.toast(`Copied ${w}x${h} tiles → "${room.label}"`);
  }

  // --- Sampler: save the selection as a reusable stamp -----------------------

  private async saveStamp(): Promise<void> {
    if (!this.sel || this.sel.w < 1 || this.sel.h < 1) {
      this.shell!.toast('Select an area first', true);
      return;
    }
    const { tx, ty, w, h } = this.sel;
    const style = this.sampleStyle(tx, ty, w, h, false);
    const stamp: Stamp = {
      id: `stamp_${Date.now().toString(36)}`,
      label: `Stamp ${this.stamps.length + 1}`,
      w,
      h,
      tilesetId: style.tilesetId,
      paletteId: style.paletteId,
      tiles: this.readRegion(tx, ty, w, h),
    };
    this.stamps.push(stamp);
    try {
      await saveOverride('stamps.json', { version: 1, stamps: this.stamps });
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
      this.stamps.pop();
      return;
    }
    this.activeStampId = stamp.id;
    this.selecting = false;
    this.sel = null;
    await this.primeActiveAtlas();
    this.refreshLibrary();
    this.updateStatus();
    this.shell!.toast(`Saved ${w}x${h} stamp "${stamp.label}" — make a room and Paint it`);
  }

  private async deleteStamp(id: string): Promise<void> {
    this.stamps = this.stamps.filter((s) => s.id !== id);
    if (this.activeStampId === id) this.activeStampId = null;
    await saveOverride('stamps.json', { version: 1, stamps: this.stamps });
    this.refreshLibrary();
    this.updateStatus();
  }

  // --- Build a blank room to paint into --------------------------------------

  /** Arm a marquee whose dragged box defines the new blank room's size. */
  private startBlankRoom(): void {
    this.painting = false;
    this.syncPaintBtn();
    this.selecting = true;
    this.pendingBlank = true;
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
    this.shell!.toast('Drag a box on the map to set the new room size');
  }

  private async createBlankRoom(wTiles: number, hTiles: number): Promise<void> {
    const w = Math.max(1, Math.min(64, wTiles));
    const h = Math.max(1, Math.min(64, hTiles));

    // Adopt the active stamp's style so its tiles paint correctly; else default.
    const s = this.activeStamp();
    const sector: SectorMeta = {
      tilesetId: s?.tilesetId ?? 0,
      paletteId: s?.paletteId ?? 0,
      musicId: 0,
      indoor: true,
      dungeon: false,
    } as SectorMeta;

    const doc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    const bandY = this.nextBandY(doc.rooms);
    const room: CustomRoom = {
      id: `custom_${Date.now().toString(36)}`,
      label: `Room ${doc.rooms.length + 1}`,
      town: 'custom',
      type: 'custom',
      bandX: 0,
      bandY,
      w,
      h,
      sector,
      tiles: new Array(w * h).fill(0),
      spawnDX: (w >> 1) * 32 + 16,
      spawnDY: (h >> 1) * 32 + 16,
      spawnDir: 0,
    };
    doc.rooms.push(room);
    try {
      await saveOverride('rooms.json', doc);
      await buildCustomRoomBand();
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
      return;
    }
    this.rooms = doc.rooms;
    this.refreshList();
    this.updateStatus();
    this.shell!.goTo(room.bandX * 32 + room.spawnDX, bandY * 32 + room.spawnDY);
    this.shell!.toast(`Blank ${w}x${h} room — pick a stamp and Paint`);
    if (s) this.setPainting(true); // a stamp is ready → jump straight into painting
  }

  // --- Painting a stamp into the custom room under the cursor ----------------

  private roomAt(tx: number, ty: number): CustomRoom | null {
    for (const r of this.rooms) {
      if (tx >= r.bandX && tx < r.bandX + r.w && ty >= r.bandY && ty < r.bandY + r.h) return r;
    }
    return null;
  }

  /** Stamp the active stamp with its top-left at tile (tx,ty), clipped to room. */
  private stampAt(tx: number, ty: number): void {
    const stamp = this.activeStamp();
    if (!stamp) return;
    const key = `${tx},${ty}`;
    if (key === this.lastPaintedKey) return; // same tile within a drag
    this.lastPaintedKey = key;

    const room = this.roomAt(tx, ty);
    if (!room) {
      if (!this.warnedStyle) {
        this.shell!.toast('Paint inside a custom room', true);
        this.warnedStyle = true;
      }
      return;
    }
    if (room.sector.tilesetId !== stamp.tilesetId || room.sector.paletteId !== stamp.paletteId) {
      if (!this.warnedStyle) {
        this.shell!.toast(
          `Stamp style ts${stamp.tilesetId}/pal${stamp.paletteId} ≠ room ts${room.sector.tilesetId}/pal${room.sector.paletteId}`,
          true
        );
        this.warnedStyle = true;
      }
      return;
    }

    let changed = false;
    for (let ly = 0; ly < stamp.h; ly++) {
      for (let lx = 0; lx < stamp.w; lx++) {
        const rx = tx + lx - room.bandX;
        const ry = ty + ly - room.bandY;
        if (rx < 0 || rx >= room.w || ry < 0 || ry >= room.h) continue; // clip
        room.tiles[ry * room.w + rx] = stamp.tiles[ly * stamp.w + lx] ?? 0;
        changed = true;
      }
    }
    if (!changed) return;
    this.strokeDirty = true;
    // Live preview without a server round-trip: prime the cache + rebuild band.
    primeJSONCache('/overrides/rooms.json', { version: 1, rooms: this.rooms });
    void buildCustomRoomBand();
  }

  /** Write the in-memory rooms to disk (once per paint stroke). */
  private async persistRooms(): Promise<void> {
    try {
      await saveOverride('rooms.json', { version: 1, rooms: this.rooms });
      await buildCustomRoomBand();
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
    }
  }

  // --- shared helpers --------------------------------------------------------

  private readRegion(tx: number, ty: number, w: number, h: number): number[] {
    const grid: number[] = new Array(w * h);
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) grid[ly * w + lx] = getTileAt(tx + lx, ty + ly);
    }
    return grid;
  }

  private sampleStyle(tx: number, ty: number, w: number, h: number, asRoom: boolean): SectorMeta {
    const src = getSectorForTile(tx + (w >> 1), ty + (h >> 1));
    return {
      tilesetId: src?.tilesetId ?? 0,
      paletteId: src?.paletteId ?? 0,
      musicId: src?.musicId ?? 0,
      indoor: asRoom ? true : src?.indoor,
      dungeon: asRoom ? false : src?.dungeon,
    } as SectorMeta;
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
    this.rooms = doc.rooms;
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

    // Select + commit row.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn('Select Area', () => this.startSelecting(), row, true);
    this.copyBtn = this.mkBtn('Copy → Room', () => void this.copySelection(), row);
    this.stampBtn = this.mkBtn('Save Stamp', () => void this.saveStamp(), row);
    this.mkBtn('Cancel', () => this.cancel(), row);
    this.panel.appendChild(row);

    // Stamp library.
    const libTitle = document.createElement('div');
    libTitle.textContent = 'Stamps';
    libTitle.style.cssText = 'color:#9fb8cc;font-size:11px;margin-top:4px;';
    this.panel.appendChild(libTitle);

    this.libraryEl = document.createElement('div');
    this.libraryEl.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;max-height:170px;overflow:auto;padding:2px;';
    this.panel.appendChild(this.libraryEl);

    // Build row.
    const build = document.createElement('div');
    build.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    this.mkBtn('New Blank Room', () => this.startBlankRoom(), build);
    this.paintBtn = this.mkBtn('Paint: off', () => this.setPainting(!this.painting), build);
    this.panel.appendChild(build);

    // Custom-room list.
    const listTitle = document.createElement('div');
    listTitle.textContent = 'Custom rooms';
    listTitle.style.cssText = 'color:#9fb8cc;font-size:11px;margin-top:4px;';
    this.panel.appendChild(listTitle);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:3px;max-height:160px;overflow:auto;';
    this.panel.appendChild(this.listEl);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private startSelecting(): void {
    this.selecting = true;
    this.pendingBlank = false;
    this.painting = false;
    this.syncPaintBtn();
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
    this.shell!.toast('Drag a box over an area, then Copy → Room or Save Stamp');
  }

  private setPainting(on: boolean): void {
    if (on && !this.activeStamp()) {
      this.shell!.toast('Select a stamp first', true);
      return;
    }
    this.painting = on;
    if (on) {
      this.selecting = false;
      this.pendingBlank = false;
      this.sel = null;
    }
    this.syncPaintBtn();
    this.updateStatus();
    if (on) this.shell!.toast('Click/drag inside a custom room to paint the stamp');
  }

  private syncPaintBtn(): void {
    if (!this.paintBtn) return;
    this.paintBtn.textContent = `Paint: ${this.painting ? 'on' : 'off'}`;
    this.paintBtn.style.background = this.painting ? '#10303d' : '#1d2530';
    this.paintBtn.style.borderColor = this.painting ? '#4db6e8' : '#3a4a5a';
    this.paintBtn.style.color = this.painting ? '#4db6e8' : '#cde';
  }

  private cancel(): void {
    this.selecting = false;
    this.pendingBlank = false;
    this.painting = false;
    this.sel = null;
    this.dragStart = null;
    this.syncPaintBtn();
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const stamp = this.activeStamp();
    if (this.painting) {
      this.statusEl.textContent = stamp
        ? `▸ Painting "${stamp.label}" (${stamp.w}x${stamp.h}). Click/drag in a custom room.`
        : '▸ Pick a stamp to paint.';
    } else if (this.pendingBlank) {
      this.statusEl.textContent = this.sel
        ? `▸ New room ${this.sel.w}x${this.sel.h}. Release to create.`
        : '▸ Drag a box to set the new room size…';
    } else if (this.selecting) {
      this.statusEl.textContent = this.sel
        ? `▸ Selected ${this.sel.w}x${this.sel.h}. Copy → Room, or Save Stamp.`
        : '▸ Drag a box over the area to sample…';
    } else {
      this.statusEl.textContent = 'Select Area to sample, or pick a stamp and Paint into a room.';
    }
    const hasSel = !!this.sel;
    for (const b of [this.copyBtn, this.stampBtn]) {
      if (b) {
        b.disabled = !hasSel;
        b.style.opacity = hasSel ? '1' : '0.45';
      }
    }
  }

  private refreshLibrary(): void {
    if (!this.libraryEl) return;
    this.libraryEl.innerHTML = '';
    if (this.stamps.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(no stamps — Select Area then Save Stamp)';
      empty.style.cssText = 'color:#678;font-size:11px;';
      this.libraryEl.appendChild(empty);
      return;
    }
    for (const s of this.stamps) {
      const active = s.id === this.activeStampId;
      const cell = document.createElement('div');
      cell.style.cssText =
        'position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;' +
        'padding:3px;border-radius:4px;cursor:pointer;width:72px;' +
        (active
          ? 'background:#10303d;border:1px solid #4db6e8;'
          : 'background:#161c24;border:1px solid #2a3340;');
      cell.title = `${s.label} · ${s.w}x${s.h} · ts${s.tilesetId}/pal${s.paletteId}`;
      cell.onclick = () => void this.selectStamp(s.id);

      const thumb = this.makeThumb(s, 64);
      cell.appendChild(thumb);

      const name = document.createElement('div');
      name.textContent = s.label;
      name.style.cssText =
        'font-size:10px;color:#bfe3ff;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      cell.appendChild(name);

      const del = document.createElement('div');
      del.textContent = '✕';
      del.title = 'Delete stamp';
      del.style.cssText = 'position:absolute;top:1px;right:3px;color:#ff8a7a;font-size:11px;';
      del.onclick = (e) => {
        e.stopPropagation();
        void this.deleteStamp(s.id);
      };
      cell.appendChild(del);

      this.libraryEl.appendChild(cell);
    }
  }

  private async selectStamp(id: string): Promise<void> {
    this.activeStampId = id;
    await this.primeActiveAtlas();
    this.refreshLibrary();
    this.updateStatus();
  }

  /** Render a stamp to a small canvas thumbnail (atlas already primed at save). */
  private makeThumb(s: Stamp, maxPx: number): HTMLCanvasElement {
    const scale = Math.max(0.0625, Math.min(1, maxPx / (Math.max(s.w, s.h) * TILE_SIZE)));
    const cw = Math.max(1, Math.round(s.w * TILE_SIZE * scale));
    const ch = Math.max(1, Math.round(s.h * TILE_SIZE * scale));
    const canvas = document.createElement('canvas');
    canvas.width = s.w * TILE_SIZE;
    canvas.height = s.h * TILE_SIZE;
    canvas.style.cssText = `width:${cw}px;height:${ch}px;image-rendering:pixelated;background:#000;border-radius:2px;`;
    const c = canvas.getContext('2d');
    if (c) {
      // Atlas may still be loading the very first time; redraw shortly after.
      const draw = () => {
        for (let ly = 0; ly < s.h; ly++) {
          for (let lx = 0; lx < s.w; lx++) {
            drawTile(
              c,
              s.tilesetId,
              s.paletteId,
              s.tiles[ly * s.w + lx] ?? 0,
              lx * TILE_SIZE,
              ly * TILE_SIZE
            );
          }
        }
      };
      draw();
      void loadAtlas(s.tilesetId, s.paletteId).then(draw);
    }
    return canvas;
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
      name.style.cssText =
        'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:#bfe3ff;';
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

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false
  ): HTMLButtonElement {
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
