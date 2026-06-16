import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import {
  getTileAt,
  getSectorForTile,
  getOverworldHeightTiles,
  buildCustomRoomBand,
} from '../../engine/MapManager';
import { drawTile, drawMinitile, loadAtlas } from '../../engine/TilesetManager';
import { COMPOSITE_BASE, isComposite, packRef, unpackRef } from '../../engine/CompositeTiles';
import {
  customRef,
  customRefId,
  isCustomRef,
  mintCustomTile,
  customTilesDoc,
  drawCustomMinitile,
} from '../../engine/CustomTiles';
import { openTilePixelEditor } from '../TilePixelEditor';
import { primeJSONCache } from '../../engine/AssetLoader';
import { TILE_SIZE, MINITILE_SIZE, SECTOR_TILES_X, SECTOR_TILES_Y, SectorMeta } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';
import { loadWorldDoc, saveWorldDoc } from '../../engine/Auth';

// Room Builder — author CUSTOM rooms that don't exist in the ROM, stamped into an
// "interiors band" below the overworld (overrides/rooms.json; the ROM tiles.json
// is never touched). You build a room by PAINTING a brush into it. A brush is
// either a single arrangement picked from the Tiles palette, or a multi-cell
// STAMP sampled from anywhere in the world (overrides/stamps.json) — both store
// arrangement INDICES (our metadata, never ROM pixels). Collision + foreground
// ride along for free because both are keyed per arrangement. One tileset per
// room (an SNES per-sector reality): a blank room adopts the first brush's style.

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
  composites?: Record<string, number[]>; // composite cell id -> 16 packed minitile refs
  spawnDX: number;
  spawnDY: number;
  spawnDir: number;
}
interface CustomRoomsDoc {
  version: number;
  rooms: CustomRoom[];
}

interface Stamp {
  id: string;
  label: string;
  w: number; // bounding size in TILES (for layout/thumbnail)
  h: number;
  tilesetId: number;
  paletteId: number;
  tiles: number[]; // arrangement-grid stamp (w*h), empty for minitile stamps
  // Minitile stamp: a grid of 8x8 pieces (sub-tile). refs are packed minitile
  // refs (−1 = empty), mw*mh row-major.
  mini?: boolean;
  mw?: number;
  mh?: number;
  refs?: number[];
  folder?: string; // parent folder id; absent = Uncategorized
}
// A named parent folder stamps can be dragged into (organisation only).
interface StampFolder {
  id: string;
  name: string;
}
interface StampsDoc {
  version: number;
  stamps: Stamp[];
  folders?: StampFolder[];
}

// What you paint with: a single arrangement from the palette, or a sampled stamp.
type Brush =
  | { kind: 'tile'; tilesetId: number; paletteId: number; arr: number }
  | { kind: 'stamp'; stamp: Stamp };

interface Footprint {
  w: number;
  h: number;
  tilesetId: number;
  paletteId: number;
  tiles: number[];
}

const BAND_GAP_TILES = SECTOR_TILES_Y;
const PALETTE_COLS = 8; // atlas re-flowed to 8 columns of 32px tiles
const PALETTE_COUNT = 1024; // arrangements per atlas (32x32 grid)

interface TileRect {
  tx: number;
  ty: number;
  w: number;
  h: number;
}

class RoomBuilderTool implements EditorTool {
  id = 'room-builder';
  name = 'Room Builder';
  description = 'Paint tiles and stamps to build custom rooms.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private panel: HTMLDivElement | null = null;

  // rooms / data
  private rooms: CustomRoom[] = [];
  private stamps: Stamp[] = [];
  private folders: StampFolder[] = [];
  private collapsedFolders = new Set<string>(); // in-memory collapse state

  // brush + paint
  private brush: Brush | null = null;
  private erasing = false;
  private painting = false;
  private brushTab: 'tiles' | 'stamps' = 'stamps'; // open on Stamps so a saved stamp is visible
  private palTs = 0;
  private palPal = 0;

  // marquee (sample / copy / new-room sizing)
  private selecting = false;
  private pendingBlank = false;
  private dragStart: { tx: number; ty: number } | null = null;
  private sel: TileRect | null = null;
  private selUnit = TILE_SIZE; // 32 for tile sampling, 8 for minitile sampling
  private sampleMini = false; // the Sample button captures 8x8 minitiles

  // paint-stroke bookkeeping
  private hoverTile: { tx: number; ty: number } | null = null;
  private hoverMini: { mx: number; my: number } | null = null;
  private lastPaintedKey = '';
  private strokeDirty = false;
  private warnedStyle = false;
  private strokeBefore: CustomRoom[] | null = null;
  private roomsCollapsed = false;

  // selection + corner resize
  private selectedRoomId: string | null = null;
  private resizing: {
    id: string;
    corner: 'nw' | 'ne' | 'sw' | 'se';
    fx: number; // fixed (opposite) corner, in tiles
    fy: number;
    w: number; // live new size, in tiles (sector-aligned)
    h: number;
  } | null = null;

  // DOM refs
  private statusEl: HTMLDivElement | null = null;
  private tilesPane: HTMLDivElement | null = null;
  private stampsPane: HTMLDivElement | null = null;
  private tabTilesBtn: HTMLButtonElement | null = null;
  private tabStampsBtn: HTMLButtonElement | null = null;
  private paletteCanvas: HTMLCanvasElement | null = null;
  private paletteHi: HTMLDivElement | null = null;
  private palLabel: HTMLDivElement | null = null;
  private libraryEl: HTMLDivElement | null = null;
  private swatch: HTMLCanvasElement | null = null;
  private eraseBtn: HTMLButtonElement | null = null;
  private paintBtn: HTMLButtonElement | null = null;
  private listEl: HTMLDivElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    this.buildPanel();
    this.refreshList();
    this.refreshLibrary();
    void this.reloadData();
    this.updateStatus();
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  deactivate(): void {
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.panel?.remove();
    this.panel = null;
    this.selecting = false;
    this.painting = false;
    this.pendingBlank = false;
    this.dragStart = null;
    this.sel = null;
    this.hoverTile = null;
    this.resizing = null;
  }

  private onContextMenu = (e: MouseEvent): void => {
    if (!this.painting) return;
    e.preventDefault();
    this.setPainting(false);
    this.shell?.toast('Paint off');
  };

  onKey(key: string): boolean {
    if (key === 'escape' && this.painting) {
      this.setPainting(false);
      this.shell?.toast('Paint off');
      return true;
    }
    return false;
  }

  private async reloadData(): Promise<void> {
    try {
      // Only overwrite the in-memory lists when a load actually succeeds — a null
      // result (404 / a dev-server restart window) keeps what we already have so
      // the stamp library / room list never blanks out from under the user.
      // Stamps live in the DB now (world_docs / GET /api/world/stamps) so the
      // library follows you across sessions. One-time migrate from the legacy
      // overrides/stamps.json the first time the DB has nothing.
      let sdoc = await loadWorldDoc<StampsDoc>('stamps');
      if (!sdoc?.stamps?.length && !sdoc?.folders?.length) {
        const legacy = await loadOverride<StampsDoc>('stamps.json');
        if (legacy?.stamps?.length) {
          sdoc = legacy;
          this.stamps = legacy.stamps;
          this.folders = legacy.folders ?? [];
          await this.persistStamps(); // copy into the DB going forward
        }
      }
      if (sdoc?.stamps) this.stamps = sdoc.stamps;
      if (sdoc?.folders) this.folders = sdoc.folders;
      const rdoc = await loadOverride<CustomRoomsDoc>('rooms.json');
      if (rdoc?.rooms) this.rooms = rdoc.rooms;

      // Default the palette to the first room's style so it's relevant on open.
      if (this.rooms[0] && this.palTs === 0 && this.palPal === 0) {
        this.palTs = this.rooms[0].sector.tilesetId;
        this.palPal = this.rooms[0].sector.paletteId;
      }

      // One-time migration: older rooms weren't sector-aligned (orphan padding).
      const migrated = this.normalizeRooms();
      if (migrated) {
        await saveOverride('rooms.json', { version: 1, rooms: this.rooms });
        this.shell?.toast(`Aligned ${migrated} room(s) to the sector grid`);
      }
      await buildCustomRoomBand();
    } catch (e) {
      this.shell?.toast(`Room data load failed: ${e}`, true);
    }
    this.refreshLibrary();
    this.refreshList();
    void this.renderPalette();
  }

  // ── brush ──────────────────────────────────────────────────────────────────

  private brushFoot(): Footprint | null {
    const b = this.brush;
    if (!b) return null;
    if (b.kind === 'tile') {
      return { w: 1, h: 1, tilesetId: b.tilesetId, paletteId: b.paletteId, tiles: [b.arr] };
    }
    return {
      w: b.stamp.w,
      h: b.stamp.h,
      tilesetId: b.stamp.tilesetId,
      paletteId: b.stamp.paletteId,
      tiles: b.stamp.tiles,
    };
  }

  private setBrushTile(arr: number): void {
    this.brush = { kind: 'tile', tilesetId: this.palTs, paletteId: this.palPal, arr };
    this.erasing = false;
    void loadAtlas(this.palTs, this.palPal);
    this.updatePaletteHi();
    this.updateBrushUi();
    this.setPainting(true);
  }

  private setBrushStamp(s: Stamp): void {
    this.brush = { kind: 'stamp', stamp: s };
    this.erasing = false;
    if (s.mini) {
      for (const n of s.refs ?? []) {
        if (n >= 0) {
          const r = unpackRef(n);
          void loadAtlas(r.ts, r.pal);
        }
      }
    } else {
      void loadAtlas(s.tilesetId, s.paletteId);
    }
    this.refreshLibrary();
    this.updateBrushUi();
    this.setPainting(true);
  }

  private toggleErase(): void {
    this.erasing = !this.erasing;
    this.updateBrushUi();
    if (this.erasing) this.setPainting(true);
    else this.updateStatus();
  }

  // ── mouse ────────────────────────────────────────────────────────────────

  onMouseDown(p: WorldPoint): boolean {
    if (this.painting) {
      this.lastPaintedKey = '';
      this.strokeDirty = false;
      this.warnedStyle = false;
      this.strokeBefore = this.cloneRooms();
      this.paintHere(p);
      return true;
    }
    if (this.selecting) {
      const u = this.selUnit;
      this.dragStart = { tx: Math.floor(p.x / u), ty: Math.floor(p.y / u) };
      this.sel = { tx: this.dragStart.tx, ty: this.dragStart.ty, w: 1, h: 1 };
      return true;
    }
    // Idle: grab a corner handle of the selected room to resize, else select the
    // room under the cursor (return false so a plain drag still pans the camera).
    if (this.selectedRoomId) {
      const corner = this.handleHit(p);
      if (corner) {
        this.startResize(corner, p);
        return true;
      }
    }
    const r = this.roomAt(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE));
    if (r) this.selectRoom(r.id);
    return false;
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hoverTile = { tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) };
    this.hoverMini = { mx: Math.floor(p.x / MINITILE_SIZE), my: Math.floor(p.y / MINITILE_SIZE) };
    if (this.resizing) {
      if (dragging) this.updateResize(p);
      return;
    }
    if (this.painting) {
      if (dragging) this.paintHere(p);
      return;
    }
    if (!this.selecting || !this.dragStart || !dragging) return;
    const u = this.selUnit;
    const tx = Math.floor(p.x / u);
    const ty = Math.floor(p.y / u);
    this.sel = {
      tx: Math.min(this.dragStart.tx, tx),
      ty: Math.min(this.dragStart.ty, ty),
      w: Math.abs(tx - this.dragStart.tx) + 1,
      h: Math.abs(ty - this.dragStart.ty) + 1,
    };
    if (this.pendingBlank) {
      const x0 = Math.floor(this.sel.tx / SECTOR_TILES_X) * SECTOR_TILES_X;
      const y0 = Math.floor(this.sel.ty / SECTOR_TILES_Y) * SECTOR_TILES_Y;
      const x1 = Math.ceil((this.sel.tx + this.sel.w) / SECTOR_TILES_X) * SECTOR_TILES_X;
      const y1 = Math.ceil((this.sel.ty + this.sel.h) / SECTOR_TILES_Y) * SECTOR_TILES_Y;
      this.sel = { tx: x0, ty: y0, w: x1 - x0, h: y1 - y0 };
    }
    this.updateStatus();
  }

  onMouseUp(): void {
    if (this.resizing) {
      this.commitResize();
      return;
    }
    if (this.painting) {
      if (this.strokeDirty && this.strokeBefore) {
        const before = this.strokeBefore;
        const after = this.cloneRooms();
        this.shell!.run({
          label: this.erasing ? 'Erase tiles' : 'Paint tiles',
          do: () => this.applyRoomsState(after),
          undo: () => this.applyRoomsState(before),
        });
      }
      this.strokeBefore = null;
      this.strokeDirty = false;
      return;
    }
    if (!this.selecting) return;
    this.dragStart = null;
    if (this.pendingBlank && this.sel && this.sel.w >= 1 && this.sel.h >= 1) {
      const { w, h } = this.sel;
      this.pendingBlank = false;
      this.selecting = false;
      this.sel = null;
      void this.createBlankRoom(w, h);
      return;
    }
    this.updateStatus();
  }

  // ── paint ──────────────────────────────────────────────────────────────────

  private roomAt(tx: number, ty: number): CustomRoom | null {
    for (const r of this.rooms) {
      if (tx >= r.bandX && tx < r.bandX + r.w && ty >= r.bandY && ty < r.bandY + r.h) return r;
    }
    return null;
  }

  // ── selection + corner resize ──────────────────────────────────────────────

  private selectedRoom(): CustomRoom | null {
    return this.rooms.find((r) => r.id === this.selectedRoomId) ?? null;
  }

  private selectRoom(id: string): void {
    this.selectedRoomId = id;
    this.refreshList();
    this.updateStatus();
  }

  /** Which corner handle of the selected room (if any) is under the pointer. */
  private handleHit(p: WorldPoint): 'nw' | 'ne' | 'sw' | 'se' | null {
    const r = this.selectedRoom();
    if (!r || this.painting) return null;
    const zoom = this.shell?.context.camera.zoom ?? 1;
    const t = 9 / zoom; // ~9 device px grab radius
    const corners: ['nw' | 'ne' | 'sw' | 'se', number, number][] = [
      ['nw', r.bandX, r.bandY],
      ['ne', r.bandX + r.w, r.bandY],
      ['sw', r.bandX, r.bandY + r.h],
      ['se', r.bandX + r.w, r.bandY + r.h],
    ];
    for (const [c, tx, ty] of corners) {
      if (Math.abs(p.x - tx * TILE_SIZE) <= t && Math.abs(p.y - ty * TILE_SIZE) <= t) return c;
    }
    return null;
  }

  private startResize(corner: 'nw' | 'ne' | 'sw' | 'se', p: WorldPoint): void {
    const r = this.selectedRoom();
    if (!r) return;
    // The opposite corner stays fixed (in tiles).
    const fx = corner === 'nw' || corner === 'sw' ? r.bandX + r.w : r.bandX;
    const fy = corner === 'nw' || corner === 'ne' ? r.bandY + r.h : r.bandY;
    this.strokeBefore = this.cloneRooms(); // undo snapshot
    this.resizing = { id: r.id, corner, fx, fy, w: r.w, h: r.h };
    this.updateResize(p);
  }

  private updateResize(p: WorldPoint): void {
    const rz = this.resizing;
    if (!rz) return;
    // New size = distance from the fixed corner to the cursor, snapped to whole
    // sectors, clamped to a one-sector minimum.
    rz.w = Math.max(
      SECTOR_TILES_X,
      Math.round(Math.abs(p.x / TILE_SIZE - rz.fx) / SECTOR_TILES_X) * SECTOR_TILES_X
    );
    rz.h = Math.max(
      SECTOR_TILES_Y,
      Math.round(Math.abs(p.y / TILE_SIZE - rz.fy) / SECTOR_TILES_Y) * SECTOR_TILES_Y
    );
  }

  /** World-tile rect the resize preview occupies, derived from the fixed corner. */
  private resizeRect(rz: NonNullable<RoomBuilderTool['resizing']>): TileRect {
    const anchorRight = rz.corner === 'sw' || rz.corner === 'nw';
    const anchorBottom = rz.corner === 'nw' || rz.corner === 'ne';
    return {
      tx: anchorRight ? rz.fx - rz.w : rz.fx,
      ty: anchorBottom ? rz.fy - rz.h : rz.fy,
      w: rz.w,
      h: rz.h,
    };
  }

  private commitResize(): void {
    const rz = this.resizing;
    this.resizing = null;
    if (!rz) return;
    const room = this.rooms.find((r) => r.id === rz.id);
    if (!room) {
      this.strokeBefore = null;
      return;
    }
    const w0 = room.w;
    const h0 = room.h;
    const anchorRight = rz.corner === 'sw' || rz.corner === 'nw';
    const anchorBottom = rz.corner === 'nw' || rz.corner === 'ne';
    const dx = anchorRight ? rz.w - w0 : 0; // shift content to keep the fixed edge
    const dy = anchorBottom ? rz.h - h0 : 0;
    const tiles = new Array(rz.w * rz.h).fill(0);
    for (let ny = 0; ny < rz.h; ny++) {
      for (let nx = 0; nx < rz.w; nx++) {
        const ox = nx - dx;
        const oy = ny - dy;
        if (ox >= 0 && ox < w0 && oy >= 0 && oy < h0)
          tiles[ny * rz.w + nx] = room.tiles[oy * w0 + ox] ?? 0;
      }
    }
    room.w = rz.w;
    room.h = rz.h;
    room.tiles = tiles;
    room.spawnDX = Math.min(room.spawnDX, rz.w * 32 - 16);
    room.spawnDY = Math.min(room.spawnDY, rz.h * 32 - 16);
    this.restackBand(); // keep the band non-overlapping after a size change

    if (this.strokeBefore) {
      const before = this.strokeBefore;
      const after = this.cloneRooms();
      this.shell!.run({
        label: 'Resize room',
        do: () => this.applyRoomsState(after),
        undo: () => this.applyRoomsState(before),
      });
    }
    this.strokeBefore = null;
    this.refreshList();
  }

  /** Re-stack all rooms in a single left-aligned column (no overlaps). */
  private restackBand(): void {
    let bottom = getOverworldHeightTiles();
    for (const r of [...this.rooms].sort((a, b) => a.bandY - b.bandY)) {
      r.bandX = 0;
      r.bandY = bottom + BAND_GAP_TILES;
      bottom = r.bandY + Math.ceil(r.h / SECTOR_TILES_Y) * SECTOR_TILES_Y;
    }
  }

  /** Paint the brush (or erase) with its top-left at tile (tx,ty), clipped to the room. */
  private stampAt(tx: number, ty: number): void {
    const foot = this.erasing ? null : this.brushFoot();
    if (!this.erasing && !foot) return;
    const key = `${tx},${ty}`;
    if (key === this.lastPaintedKey) return;
    this.lastPaintedKey = key;

    const room = this.roomAt(tx, ty);
    if (!room) {
      if (!this.warnedStyle) {
        this.shell!.toast(
          'Aim inside the room outline (amber box) — the outer blue is padding',
          true
        );
        this.warnedStyle = true;
      }
      return;
    }

    if (
      foot &&
      (room.sector.tilesetId !== foot.tilesetId || room.sector.paletteId !== foot.paletteId)
    ) {
      // A still-blank room has no style to protect yet, so it ADOPTS the brush's
      // tileset/palette. Once it holds content, a mismatched brush is rejected
      // (one tileset's arrangements render as garbage under another's atlas).
      const roomEmpty = room.tiles.every((t) => (t ?? 0) === 0);
      if (roomEmpty) {
        room.sector = { ...room.sector, tilesetId: foot.tilesetId, paletteId: foot.paletteId };
      } else {
        if (!this.warnedStyle) {
          this.shell!.toast(
            `Room is ts${room.sector.tilesetId}/pal${room.sector.paletteId}; brush is ts${foot.tilesetId}/pal${foot.paletteId}. Match it or use a blank room.`,
            true
          );
          this.warnedStyle = true;
        }
        return;
      }
    }

    const w = this.erasing ? 1 : foot!.w;
    const h = this.erasing ? 1 : foot!.h;
    let changed = false;
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        const rx = tx + lx - room.bandX;
        const ry = ty + ly - room.bandY;
        if (rx < 0 || rx >= room.w || ry < 0 || ry >= room.h) continue;
        room.tiles[ry * room.w + rx] = this.erasing ? 0 : (foot!.tiles[ly * w + lx] ?? 0);
        changed = true;
      }
    }
    if (!changed) return;
    this.strokeDirty = true;
    primeJSONCache('/overrides/rooms.json', { version: 1, rooms: this.rooms });
    void buildCustomRoomBand();
  }

  // ── minitile (sub-tile) painting ───────────────────────────────────────────

  private paintHere(p: WorldPoint): void {
    if (this.isMiniBrush()) {
      this.paintMinis(Math.floor(p.x / MINITILE_SIZE), Math.floor(p.y / MINITILE_SIZE));
    } else {
      this.stampAt(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE));
    }
  }

  private isMiniBrush(): boolean {
    return !this.erasing && this.brush?.kind === 'stamp' && !!this.brush.stamp.mini;
  }

  /** Paint a minitile stamp with its top-left at minitile (mx,my). Each painted
   *  8x8 minitile turns its containing room cell into a COMPOSITE. */
  private paintMinis(mx: number, my: number): void {
    if (this.brush?.kind !== 'stamp' || !this.brush.stamp.mini) return;
    const s = this.brush.stamp;
    const mw = s.mw ?? 1;
    const mh = s.mh ?? 1;
    const refs = s.refs ?? [];
    const key = `m${mx},${my}`;
    if (key === this.lastPaintedKey) return;
    this.lastPaintedKey = key;
    let changed = false;
    for (let ly = 0; ly < mh; ly++) {
      for (let lx = 0; lx < mw; lx++) {
        const n = refs[ly * mw + lx] ?? -1;
        if (n < 0) continue; // transparent part of the stamp — don't erase
        const wmx = mx + lx;
        const wmy = my + ly;
        const room = this.roomAt(wmx >> 2, wmy >> 2);
        if (!room) {
          if (!this.warnedStyle) {
            this.shell!.toast('Aim inside the room outline (amber box)', true);
            this.warnedStyle = true;
          }
          continue;
        }
        const cellIdx = ((wmy >> 2) - room.bandY) * room.w + ((wmx >> 2) - room.bandX);
        const comp = this.ensureCompositeCell(room, cellIdx);
        comp[(wmy & 3) * 4 + (wmx & 3)] = n;
        changed = true;
      }
    }
    if (!changed) return;
    this.strokeDirty = true;
    primeJSONCache('/overrides/rooms.json', { version: 1, rooms: this.rooms });
    void buildCustomRoomBand();
  }

  /** Get the 16-ref composite for a cell, converting a plain arrangement to one. */
  private ensureCompositeCell(room: CustomRoom, cellIdx: number): number[] {
    const cur = room.tiles[cellIdx] ?? 0;
    room.composites = room.composites ?? {};
    if (isComposite(cur)) {
      let comp = room.composites[String(cur)];
      if (!comp) {
        comp = new Array(16).fill(-1);
        room.composites[String(cur)] = comp;
      }
      return comp;
    }
    const comp: number[] = new Array(16).fill(-1);
    if (cur > 0 && cur < COMPOSITE_BASE) {
      // Explode the existing ROM arrangement into its 16 source minitiles.
      for (let mi = 0; mi < 16; mi++) {
        comp[mi] = packRef(room.sector.tilesetId, room.sector.paletteId, cur, mi);
      }
    }
    const id = this.nextCompositeId();
    room.composites[String(id)] = comp;
    room.tiles[cellIdx] = id;
    return comp;
  }

  private nextCompositeId(): number {
    let max = COMPOSITE_BASE - 1;
    for (const r of this.rooms) {
      for (const k of Object.keys(r.composites ?? {})) max = Math.max(max, Number(k));
    }
    return max + 1;
  }

  /** Source minitile ref at world-minitile (mx,my) — for sampling. */
  private srcMinitileRef(mx: number, my: number): number {
    const tileX = mx >> 2;
    const tileY = my >> 2;
    const arr = getTileAt(tileX, tileY);
    const mi = (my & 3) * 4 + (mx & 3);
    if (isComposite(arr)) {
      for (const r of this.rooms) {
        const c = r.composites?.[String(arr)];
        if (c) return c[mi] ?? -1;
      }
      return -1;
    }
    const sec = getSectorForTile(tileX, tileY);
    if (!sec) return -1;
    return packRef(sec.tilesetId, sec.paletteId, arr, mi);
  }

  private cloneComposites(c: Record<string, number[]>): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const k of Object.keys(c)) out[k] = c[k].slice();
    return out;
  }

  private cloneRooms(): CustomRoom[] {
    return this.rooms.map((r) => ({
      ...r,
      sector: { ...r.sector },
      tiles: r.tiles.slice(),
      composites: r.composites ? this.cloneComposites(r.composites) : undefined,
    }));
  }

  private applyRoomsState(snapshot: CustomRoom[]): void {
    this.rooms = snapshot.map((r) => ({
      ...r,
      sector: { ...r.sector },
      tiles: r.tiles.slice(),
      composites: r.composites ? this.cloneComposites(r.composites) : undefined,
    }));
    primeJSONCache('/overrides/rooms.json', { version: 1, rooms: this.rooms });
    void buildCustomRoomBand();
    void this.commitRooms();
  }

  private async commitRooms(): Promise<void> {
    try {
      await saveOverride('rooms.json', { version: 1, rooms: this.rooms });
      await buildCustomRoomBand();
      this.refreshList();
    } catch (e) {
      this.shell?.toast(`Save failed: ${e}`, true);
    }
  }

  // ── overlay ──────────────────────────────────────────────────────────────

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    // Room footprints: blue tint on empty cells (recedes as you paint) + a bright
    // dashed amber boundary (the TRUE editable extent — stamps only stick inside).
    for (const r of this.rooms) {
      const rx = r.bandX * TILE_SIZE - Math.round(camera.x);
      const ry = r.bandY * TILE_SIZE - Math.round(camera.y);
      ctx.fillStyle = 'rgba(77,182,232,0.22)';
      for (let ly = 0; ly < r.h; ly++) {
        for (let lx = 0; lx < r.w; lx++) {
          if ((r.tiles[ly * r.w + lx] ?? 0) !== 0) continue;
          ctx.fillRect(rx + lx * TILE_SIZE, ry + ly * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }
      const rw = r.w * TILE_SIZE;
      const rh = r.h * TILE_SIZE;
      ctx.strokeStyle = '#ffd23e';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffe98a';
      ctx.font = '11px monospace';
      ctx.fillText(`${r.label} · ${r.w}x${r.h}`, rx + 3, ry - 4);

      // Selected room: solid highlight + draggable corner handles.
      if (r.id === this.selectedRoomId && !this.painting && !this.resizing) {
        ctx.strokeStyle = '#ffd23e';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        const hs = 4;
        ctx.fillStyle = '#ffd23e';
        const corners: [number, number][] = [
          [rx, ry],
          [rx + rw, ry],
          [rx, ry + rh],
          [rx + rw, ry + rh],
        ];
        for (const [hx, hy] of corners) ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
      }
    }

    // Live resize preview (the dragged corner follows the cursor, sector-snapped).
    if (this.resizing) {
      const rect = this.resizeRect(this.resizing);
      const x = rect.tx * TILE_SIZE - Math.round(camera.x);
      const y = rect.ty * TILE_SIZE - Math.round(camera.y);
      ctx.fillStyle = 'rgba(255,210,62,0.14)';
      ctx.fillRect(x, y, rect.w * TILE_SIZE, rect.h * TILE_SIZE);
      ctx.strokeStyle = '#ffd23e';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, rect.w * TILE_SIZE - 1, rect.h * TILE_SIZE - 1);
      ctx.fillStyle = '#ffe98a';
      ctx.font = '11px monospace';
      ctx.fillText(`${rect.w}x${rect.h}`, x + 3, y - 4);
    }

    // Marquee box — green to size a new room, blue to sample/copy. Drawn in the
    // selection's unit (32px tiles, or 8px minitiles when sampling minis).
    if (this.sel) {
      const u = this.selUnit;
      const x = this.sel.tx * u - Math.round(camera.x);
      const y = this.sel.ty * u - Math.round(camera.y);
      const w = this.sel.w * u;
      const h = this.sel.h * u;
      ctx.fillStyle = this.pendingBlank ? 'rgba(124,252,106,0.16)' : 'rgba(77,182,232,0.18)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = this.pendingBlank ? '#7CFC6A' : '#4db6e8';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = this.pendingBlank ? '#d4ffcb' : '#bfe3ff';
      ctx.font = '11px monospace';
      const unitLabel = u === MINITILE_SIZE ? ' minis' : '';
      ctx.fillText(
        `${this.pendingBlank ? 'new room ' : ''}${this.sel.w}x${this.sel.h}${unitLabel}`,
        x + 3,
        y - 4
      );
    }

    // Minitile paint ghost (8px granularity).
    if (this.painting && this.isMiniBrush() && this.hoverMini && this.brush?.kind === 'stamp') {
      const s = this.brush.stamp;
      const mw = s.mw ?? 1;
      const mh = s.mh ?? 1;
      const refs = s.refs ?? [];
      ctx.save();
      ctx.globalAlpha = 0.6;
      for (let ly = 0; ly < mh; ly++) {
        for (let lx = 0; lx < mw; lx++) {
          const n = refs[ly * mw + lx] ?? -1;
          if (n < 0) continue;
          const r = unpackRef(n);
          const sx = (this.hoverMini.mx + lx) * MINITILE_SIZE - Math.round(camera.x);
          const sy = (this.hoverMini.my + ly) * MINITILE_SIZE - Math.round(camera.y);
          drawMinitile(ctx, r.ts, r.pal, r.arr, r.mi, sx, sy);
        }
      }
      ctx.restore();
      const gx = this.hoverMini.mx * MINITILE_SIZE - Math.round(camera.x);
      const gy = this.hoverMini.my * MINITILE_SIZE - Math.round(camera.y);
      ctx.strokeStyle = '#7CFC6A';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx + 0.5, gy + 0.5, mw * MINITILE_SIZE - 1, mh * MINITILE_SIZE - 1);
      return;
    }

    // Paint ghost under the cursor (arrangement / erase).
    if (this.painting && this.hoverTile) {
      const ox = this.hoverTile.tx;
      const oy = this.hoverTile.ty;
      const foot = this.erasing ? null : this.brushFoot();
      const room = this.roomAt(ox, oy);
      const w = this.erasing ? 1 : (foot?.w ?? 1);
      const h = this.erasing ? 1 : (foot?.h ?? 1);
      const ok =
        !!room &&
        (this.erasing ||
          (!!foot &&
            (room.tiles.every((t) => !t) ||
              (room.sector.tilesetId === foot.tilesetId &&
                room.sector.paletteId === foot.paletteId))));
      if (foot) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        for (let ly = 0; ly < h; ly++) {
          for (let lx = 0; lx < w; lx++) {
            const sx = (ox + lx) * TILE_SIZE - Math.round(camera.x);
            const sy = (oy + ly) * TILE_SIZE - Math.round(camera.y);
            drawTile(ctx, foot.tilesetId, foot.paletteId, foot.tiles[ly * w + lx] ?? 0, sx, sy);
          }
        }
        ctx.restore();
      }
      const gx = ox * TILE_SIZE - Math.round(camera.x);
      const gy = oy * TILE_SIZE - Math.round(camera.y);
      ctx.strokeStyle = this.erasing ? '#ff6a6a' : ok ? '#7CFC6A' : '#ff6a6a';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx + 0.5, gy + 0.5, w * TILE_SIZE - 1, h * TILE_SIZE - 1);
    }
  }

  // ── capture: sample → stamp / copy → room ────────────────────────────────

  private async saveStamp(): Promise<void> {
    if (!this.sel || this.sel.w < 1 || this.sel.h < 1) {
      this.shell!.toast('Drag a box on the map first', true);
      return;
    }
    const { tx, ty, w, h } = this.sel;
    let stamp: Stamp;
    if (this.selUnit === MINITILE_SIZE) {
      // Minitile sample: capture each 8x8 piece under the box as a packed ref.
      const refs: number[] = new Array(w * h);
      for (let ly = 0; ly < h; ly++) {
        for (let lx = 0; lx < w; lx++) refs[ly * w + lx] = this.srcMinitileRef(tx + lx, ty + ly);
      }
      stamp = {
        id: `stamp_${Date.now().toString(36)}`,
        label: `Mini ${this.stamps.length + 1}`,
        w: Math.ceil(w / 4),
        h: Math.ceil(h / 4),
        tilesetId: 0,
        paletteId: 0,
        tiles: [],
        mini: true,
        mw: w,
        mh: h,
        refs,
      };
    } else {
      const style = this.sampleStyle(tx, ty, w, h, false);
      stamp = {
        id: `stamp_${Date.now().toString(36)}`,
        label: `Stamp ${this.stamps.length + 1}`,
        w,
        h,
        tilesetId: style.tilesetId,
        paletteId: style.paletteId,
        tiles: this.readRegion(tx, ty, w, h),
      };
    }
    this.stamps.push(stamp);
    try {
      await this.persistStamps();
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
      this.stamps.pop();
      return;
    }
    this.selecting = false;
    this.sel = null;
    this.brushTab = 'stamps';
    this.syncTabs();
    this.refreshLibrary();
    this.setBrushStamp(stamp);
    this.shell!.toast(`Saved ${w}x${h} stamp — pick a room and paint`);
  }

  private async copySelection(): Promise<void> {
    if (!this.sel || this.sel.w < 1 || this.sel.h < 1) {
      this.shell!.toast('Drag a box on the map first', true);
      return;
    }
    if (this.selUnit !== TILE_SIZE) {
      this.shell!.toast('Copy→Room needs a tile selection — use "Sample area"', true);
      return;
    }
    const tx = Math.floor(this.sel.tx / SECTOR_TILES_X) * SECTOR_TILES_X;
    const ty = Math.floor(this.sel.ty / SECTOR_TILES_Y) * SECTOR_TILES_Y;
    const w = Math.ceil((this.sel.tx + this.sel.w) / SECTOR_TILES_X) * SECTOR_TILES_X - tx;
    const h = Math.ceil((this.sel.ty + this.sel.h) / SECTOR_TILES_Y) * SECTOR_TILES_Y - ty;
    const grid = this.readRegion(tx, ty, w, h);
    const sector = this.sampleStyle(tx, ty, w, h, true);

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
    this.shell!.toast(`Copied ${w}x${h} → "${room.label}"`);
  }

  private async deleteStamp(id: string): Promise<void> {
    this.stamps = this.stamps.filter((s) => s.id !== id);
    if (this.brush?.kind === 'stamp' && this.brush.stamp.id === id) this.brush = null;
    try {
      await this.persistStamps();
    } catch (e) {
      this.shell?.toast(`Save failed: ${e}`, true);
    }
    this.refreshLibrary();
    this.updateBrushUi();
  }

  /** Persist the stamp library (stamps + folders) to the DB. */
  private async persistStamps(): Promise<void> {
    await saveWorldDoc('stamps', { version: 2, stamps: this.stamps, folders: this.folders });
  }

  // ── pixel editing (Path B) ───────────────────────────────────────────────
  /** Copy a stamp into the pixel editor; saving mints custom tiles + a new stamp. */
  private async editStampPixels(s: Stamp): Promise<void> {
    const pxW = s.mini ? (s.mw ?? 1) * MINITILE_SIZE : s.w * TILE_SIZE;
    const pxH = s.mini ? (s.mh ?? 1) * MINITILE_SIZE : s.h * TILE_SIZE;

    // Make sure every source atlas is loaded before we read pixels.
    if (s.mini) {
      const combos = new Set(
        (s.refs ?? [])
          .filter((n) => n >= 0 && !isCustomRef(n))
          .map((n) => {
            const r = unpackRef(n);
            return `${r.ts},${r.pal}`;
          })
      );
      await Promise.all(
        [...combos].map((k) => {
          const [ts, pal] = k.split(',').map(Number);
          return loadAtlas(ts, pal);
        })
      );
    } else {
      await loadAtlas(s.tilesetId, s.paletteId);
    }

    const cv = document.createElement('canvas');
    cv.width = pxW;
    cv.height = pxH;
    const c = cv.getContext('2d');
    if (!c) return;
    if (s.mini) {
      const mw = s.mw ?? 1;
      const mh = s.mh ?? 1;
      const refs = s.refs ?? [];
      for (let ly = 0; ly < mh; ly++) {
        for (let lx = 0; lx < mw; lx++) {
          const n = refs[ly * mw + lx] ?? -1;
          if (n < 0) continue;
          if (isCustomRef(n))
            drawCustomMinitile(c, customRefId(n), lx * MINITILE_SIZE, ly * MINITILE_SIZE);
          else {
            const r = unpackRef(n);
            drawMinitile(c, r.ts, r.pal, r.arr, r.mi, lx * MINITILE_SIZE, ly * MINITILE_SIZE);
          }
        }
      }
    } else {
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
    }

    const img = c.getImageData(0, 0, pxW, pxH);
    openTilePixelEditor({
      width: pxW,
      height: pxH,
      initial: img.data,
      title: `Edit "${s.label}" → new stamp`,
      onSave: (rgba) => void this.saveEditedStamp(s, pxW, pxH, rgba),
    });
  }

  /** Slice an edited bitmap into 8x8 custom tiles and add a new stamp using them. */
  private async saveEditedStamp(
    src: Stamp,
    W: number,
    H: number,
    rgba: Uint8ClampedArray
  ): Promise<void> {
    const mw = W / 8;
    const mh = H / 8;
    const refs: number[] = new Array(mw * mh);
    for (let ty = 0; ty < mh; ty++) {
      for (let tx = 0; tx < mw; tx++) {
        const px = new Array<number>(256);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const si = ((ty * 8 + y) * W + (tx * 8 + x)) * 4;
            const di = (y * 8 + x) * 4;
            px[di] = rgba[si];
            px[di + 1] = rgba[si + 1];
            px[di + 2] = rgba[si + 2];
            px[di + 3] = rgba[si + 3];
          }
        }
        refs[ty * mw + tx] = customRef(mintCustomTile(px));
      }
    }

    const stamp: Stamp = {
      id: `stamp_${Date.now().toString(36)}`,
      label: `${src.label} (edit)`,
      w: Math.ceil(mw / 4),
      h: Math.ceil(mh / 4),
      tilesetId: 0,
      paletteId: 0,
      tiles: [],
      mini: true,
      mw,
      mh,
      refs,
      folder: src.folder,
    };
    this.stamps.push(stamp);
    try {
      await saveOverride('custom_tiles.json', customTilesDoc()); // shipped → renders in-game
      await this.persistStamps();
    } catch (e) {
      this.shell?.toast(`Save failed: ${e}`, true);
      this.stamps.pop();
      return;
    }
    this.refreshLibrary();
    this.setBrushStamp(stamp);
    this.shell?.toast(`Saved edited stamp (${mw}x${mh} tiles) — paint it into a room`);
  }

  // ── folders ─────────────────────────────────────────────────────────────
  private async createFolder(): Promise<void> {
    const name = window.prompt('New folder name:')?.trim();
    if (!name) return;
    this.folders.push({ id: `fold_${Date.now().toString(36)}`, name });
    await this.persistStampsSafe();
    this.refreshLibrary();
  }

  private async renameFolder(f: StampFolder): Promise<void> {
    const name = window.prompt('Rename folder:', f.name)?.trim();
    if (!name) return;
    f.name = name;
    await this.persistStampsSafe();
    this.refreshLibrary();
  }

  /** Delete a folder; its stamps fall back to Uncategorized. */
  private async deleteFolder(f: StampFolder): Promise<void> {
    if (!window.confirm(`Delete folder "${f.name}"? Its stamps move to Uncategorized.`)) return;
    this.folders = this.folders.filter((x) => x.id !== f.id);
    for (const s of this.stamps) if (s.folder === f.id) delete s.folder;
    await this.persistStampsSafe();
    this.refreshLibrary();
  }

  /** Drag-and-drop a stamp into a folder (null = Uncategorized). */
  private async moveStampToFolder(stampId: string, folderId: string | null): Promise<void> {
    const s = this.stamps.find((x) => x.id === stampId);
    if (!s) return;
    if ((s.folder ?? null) === folderId) return; // no-op
    if (folderId) s.folder = folderId;
    else delete s.folder;
    await this.persistStampsSafe();
    this.refreshLibrary();
  }

  private async persistStampsSafe(): Promise<void> {
    try {
      await this.persistStamps();
    } catch (e) {
      this.shell?.toast(`Save failed: ${e}`, true);
    }
  }

  // ── rooms ────────────────────────────────────────────────────────────────

  private startBlankRoom(): void {
    this.setPainting(false);
    this.selecting = true;
    this.pendingBlank = true;
    this.sampleMini = false;
    this.selUnit = TILE_SIZE;
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
    this.shell!.toast('Drag a box on the map to size the new room');
  }

  private startSample(mini: boolean): void {
    this.setPainting(false);
    this.selecting = true;
    this.pendingBlank = false;
    this.sampleMini = mini;
    this.selUnit = mini ? MINITILE_SIZE : TILE_SIZE;
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
    this.shell!.toast(
      mini
        ? 'Drag a box on the 8px grid to sample minitiles, then Sample→Stamp'
        : 'Drag a box on the map, then Sample→Stamp or Copy→Room'
    );
  }

  private async createBlankRoom(wTiles: number, hTiles: number): Promise<void> {
    const a = this.sectorAlign(Math.min(64, wTiles), Math.min(64, hTiles));
    const foot = this.brushFoot();
    const sector: SectorMeta = {
      tilesetId: foot?.tilesetId ?? this.palTs,
      paletteId: foot?.paletteId ?? this.palPal,
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
      w: a.w,
      h: a.h,
      sector,
      tiles: new Array(a.w * a.h).fill(0),
      spawnDX: (a.w >> 1) * 32 + 16,
      spawnDY: (a.h >> 1) * 32 + 16,
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
    this.shell!.toast(
      `Blank ${a.w}x${a.h} room — pick a brush and paint (double-click its name to rename)`
    );
    if (this.brush) this.setPainting(true);
  }

  private async deleteRoom(id: string): Promise<void> {
    const doc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    doc.rooms = doc.rooms.filter((r) => r.id !== id);
    await saveOverride('rooms.json', doc);
    await buildCustomRoomBand();
    this.rooms = doc.rooms;
    if (this.selectedRoomId === id) this.selectedRoomId = null;
    this.refreshList();
  }

  private startInlineRename(id: string, current: string, labelEl: HTMLSpanElement): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.style.cssText =
      'flex:1;min-width:0;font:12px monospace;background:#0c1016;color:#fff;' +
      'border:1px solid #ffd23e;border-radius:2px;padding:0 2px;';
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.replaceWith(labelEl);
      if (save && name && name !== current) void this.applyRename(id, name);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
    labelEl.replaceWith(input);
    input.focus();
    input.select();
  }

  private async applyRename(id: string, name: string): Promise<void> {
    const room = this.rooms.find((r) => r.id === id);
    if (!room) return;
    room.label = name;
    this.refreshList();
    try {
      await saveOverride('rooms.json', { version: 1, rooms: this.rooms });
      await buildCustomRoomBand();
      this.refreshList();
      this.shell!.toast(`Renamed → "${name}"`);
    } catch (e) {
      this.shell!.toast(`Rename save failed: ${e}`, true);
    }
  }

  // ── geometry helpers ─────────────────────────────────────────────────────

  private sectorAlign(w: number, h: number): { w: number; h: number } {
    return {
      w: Math.max(SECTOR_TILES_X, Math.ceil(w / SECTOR_TILES_X) * SECTOR_TILES_X),
      h: Math.max(SECTOR_TILES_Y, Math.ceil(h / SECTOR_TILES_Y) * SECTOR_TILES_Y),
    };
  }

  private normalizeRooms(): number {
    let changed = 0;
    for (const r of this.rooms) {
      const a = this.sectorAlign(r.w, r.h);
      if (a.w === r.w && a.h === r.h) continue;
      const tiles = new Array(a.w * a.h).fill(0);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) tiles[y * a.w + x] = r.tiles[y * r.w + x] ?? 0;
      }
      r.w = a.w;
      r.h = a.h;
      r.tiles = tiles;
      changed++;
    }
    return changed;
  }

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

  private nextBandY(rooms: CustomRoom[]): number {
    let bottom = getOverworldHeightTiles();
    for (const r of rooms) {
      bottom = Math.max(bottom, r.bandY + Math.ceil(r.h / SECTOR_TILES_Y) * SECTOR_TILES_Y);
    }
    return bottom + BAND_GAP_TILES;
  }

  // ── panel ────────────────────────────────────────────────────────────────

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #4db6e8;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:8px;user-select:none;';

    this.panel.appendChild(this.mkTitle('ROOM BUILDER'));

    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'color:#9fb8cc;font-size:11px;line-height:1.4;min-height:16px;';
    this.panel.appendChild(this.statusEl);

    // ── BRUSH section ──
    this.panel.appendChild(this.mkSection('BRUSH'));

    // tab row + brush swatch + erase
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:6px;';
    this.tabTilesBtn = this.mkBtn('Tiles', () => this.setTab('tiles'), top);
    this.tabStampsBtn = this.mkBtn('Stamps', () => this.setTab('stamps'), top);
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1;';
    top.appendChild(spacer);
    this.swatch = document.createElement('canvas');
    this.swatch.width = 32;
    this.swatch.height = 32;
    this.swatch.style.cssText =
      'width:34px;height:34px;image-rendering:pixelated;background:#000;border:1px solid #2a3340;border-radius:3px;';
    top.appendChild(this.swatch);
    this.eraseBtn = this.mkBtn('⌫', () => this.toggleErase(), top);
    this.eraseBtn.title = 'Eraser (paint empty)';
    this.panel.appendChild(top);

    // Tiles pane: palette steppers + atlas grid
    this.tilesPane = document.createElement('div');
    this.tilesPane.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const palBar = document.createElement('div');
    palBar.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;';
    this.mkMini('ts−', () => this.stepPalette('ts', -1), palBar);
    this.mkMini('ts+', () => this.stepPalette('ts', 1), palBar);
    this.mkMini('pal−', () => this.stepPalette('pal', -1), palBar);
    this.mkMini('pal+', () => this.stepPalette('pal', 1), palBar);
    this.palLabel = document.createElement('div');
    this.palLabel.style.cssText = 'color:#9fb8cc;margin-left:4px;';
    palBar.appendChild(this.palLabel);
    this.tilesPane.appendChild(palBar);

    const palScroll = document.createElement('div');
    palScroll.style.cssText =
      'max-height:200px;overflow:auto;border:1px solid #2a3340;border-radius:3px;background:#000;';
    const palWrap = document.createElement('div');
    palWrap.style.cssText = `position:relative;width:${PALETTE_COLS * TILE_SIZE}px;`;
    this.paletteCanvas = document.createElement('canvas');
    this.paletteCanvas.style.cssText = 'display:block;image-rendering:pixelated;cursor:crosshair;';
    this.paletteCanvas.onclick = (e) => this.onPaletteClick(e);
    palWrap.appendChild(this.paletteCanvas);
    this.paletteHi = document.createElement('div');
    this.paletteHi.style.cssText =
      'position:absolute;width:32px;height:32px;border:2px solid #ffd23e;box-sizing:border-box;pointer-events:none;display:none;';
    palWrap.appendChild(this.paletteHi);
    palScroll.appendChild(palWrap);
    this.tilesPane.appendChild(palScroll);
    this.panel.appendChild(this.tilesPane);

    // Stamps pane: capture buttons + library
    this.stampsPane = document.createElement('div');
    this.stampsPane.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const sampRow = document.createElement('div');
    sampRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn('Sample 32', () => this.startSample(false), sampRow, true).title =
      'Sample whole tiles (32px)';
    this.mkBtn('Sample 8', () => this.startSample(true), sampRow, true).title =
      'Sample minitiles (8px — quarter-tile and finer)';
    this.mkBtn('→ Stamp', () => void this.saveStamp(), sampRow);
    this.mkBtn('+ Folder', () => void this.createFolder(), sampRow).title =
      'Create a folder, then drag stamps into it';
    this.mkBtn('↻', () => void this.reloadData(), sampRow).title = 'Reload stamps from the DB';
    this.stampsPane.appendChild(sampRow);
    this.libraryEl = document.createElement('div');
    this.libraryEl.style.cssText =
      'display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;padding:2px;';
    this.stampsPane.appendChild(this.libraryEl);
    this.panel.appendChild(this.stampsPane);

    this.paintBtn = this.mkBtn('Paint: off', () => this.setPainting(!this.painting), this.panel);
    this.paintBtn.style.width = '100%';

    // ── ROOMS section ──
    this.panel.appendChild(this.mkSection('ROOMS'));
    const roomRow = document.createElement('div');
    roomRow.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('+ New Room', () => this.startBlankRoom(), roomRow, true);
    this.mkBtn('Copy area', () => void this.copySelection(), roomRow);
    this.panel.appendChild(roomRow);

    const listTitle = document.createElement('div');
    listTitle.style.cssText = 'color:#9fb8cc;font-size:11px;cursor:pointer;user-select:none;';
    this.panel.appendChild(listTitle);
    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;';
    this.panel.appendChild(this.listEl);
    const syncCollapse = () => {
      listTitle.textContent = `${this.roomsCollapsed ? '▸' : '▾'} Custom rooms`;
      this.listEl!.style.display = this.roomsCollapsed ? 'none' : 'flex';
    };
    listTitle.onclick = () => {
      this.roomsCollapsed = !this.roomsCollapsed;
      syncCollapse();
    };
    syncCollapse();

    this.shell!.panelHost.appendChild(this.panel);
    this.syncTabs();
    this.updateBrushUi();
    void this.renderPalette();
  }

  private setTab(tab: 'tiles' | 'stamps'): void {
    this.brushTab = tab;
    this.syncTabs();
    if (tab === 'tiles') void this.renderPalette();
  }

  private syncTabs(): void {
    if (this.tilesPane) this.tilesPane.style.display = this.brushTab === 'tiles' ? 'flex' : 'none';
    if (this.stampsPane)
      this.stampsPane.style.display = this.brushTab === 'stamps' ? 'flex' : 'none';
    const on = (b: HTMLButtonElement | null, active: boolean) => {
      if (!b) return;
      b.style.background = active ? '#10303d' : '#1d2530';
      b.style.borderColor = active ? '#4db6e8' : '#3a4a5a';
      b.style.color = active ? '#4db6e8' : '#cde';
    };
    on(this.tabTilesBtn, this.brushTab === 'tiles');
    on(this.tabStampsBtn, this.brushTab === 'stamps');
  }

  private stepPalette(which: 'ts' | 'pal', dir: number): void {
    if (which === 'ts') this.palTs = Math.max(0, this.palTs + dir);
    else this.palPal = Math.max(0, this.palPal + dir);
    void this.renderPalette();
  }

  private async renderPalette(): Promise<void> {
    const cv = this.paletteCanvas;
    if (!cv) return;
    if (this.palLabel) this.palLabel.textContent = `tileset ${this.palTs} · pal ${this.palPal}`;
    await loadAtlas(this.palTs, this.palPal);
    const rows = Math.ceil(PALETTE_COUNT / PALETTE_COLS);
    cv.width = PALETTE_COLS * TILE_SIZE;
    cv.height = rows * TILE_SIZE;
    const c = cv.getContext('2d');
    if (!c) return;
    c.fillStyle = '#000';
    c.fillRect(0, 0, cv.width, cv.height);
    for (let arr = 0; arr < PALETTE_COUNT; arr++) {
      const dx = (arr % PALETTE_COLS) * TILE_SIZE;
      const dy = Math.floor(arr / PALETTE_COLS) * TILE_SIZE;
      drawTile(c, this.palTs, this.palPal, arr, dx, dy);
    }
    this.updatePaletteHi();
  }

  private onPaletteClick(e: MouseEvent): void {
    const cv = this.paletteCanvas;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * PALETTE_COLS);
    const row = Math.floor((e.clientY - r.top) / TILE_SIZE);
    const arr = row * PALETTE_COLS + col;
    if (arr < 0 || arr >= PALETTE_COUNT) return;
    this.setBrushTile(arr);
  }

  private updatePaletteHi(): void {
    if (!this.paletteHi) return;
    const b = this.brush;
    const show =
      b?.kind === 'tile' &&
      b.tilesetId === this.palTs &&
      b.paletteId === this.palPal &&
      !this.erasing;
    if (!show || b?.kind !== 'tile') {
      this.paletteHi.style.display = 'none';
      return;
    }
    this.paletteHi.style.display = 'block';
    this.paletteHi.style.left = `${(b.arr % PALETTE_COLS) * TILE_SIZE}px`;
    this.paletteHi.style.top = `${Math.floor(b.arr / PALETTE_COLS) * TILE_SIZE}px`;
  }

  private setPainting(on: boolean): void {
    if (on && !this.brush && !this.erasing) {
      this.shell!.toast('Pick a tile or stamp first', true);
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
  }

  private syncPaintBtn(): void {
    if (!this.paintBtn) return;
    this.paintBtn.textContent = this.painting
      ? this.erasing
        ? 'Erasing — click rooms (right-click/Esc to stop)'
        : 'Painting — click rooms (right-click/Esc to stop)'
      : 'Paint: off';
    this.paintBtn.style.background = this.painting ? '#10303d' : '#1d2530';
    this.paintBtn.style.borderColor = this.painting ? '#4db6e8' : '#3a4a5a';
    this.paintBtn.style.color = this.painting ? '#4db6e8' : '#cde';
  }

  private updateBrushUi(): void {
    // swatch
    const cv = this.swatch;
    if (cv) {
      const c = cv.getContext('2d');
      if (c) {
        c.clearRect(0, 0, 32, 32);
        const miniStamp =
          !this.erasing && this.brush?.kind === 'stamp' && this.brush.stamp.mini
            ? this.brush.stamp
            : null;
        const foot = this.erasing || miniStamp ? null : this.brushFoot();
        if (this.erasing) {
          c.fillStyle = '#ff6a6a';
          c.font = 'bold 20px monospace';
          c.fillText('⌫', 6, 24);
        } else if (miniStamp) {
          const mw = miniStamp.mw ?? 1;
          const mh = miniStamp.mh ?? 1;
          const refs = miniStamp.refs ?? [];
          const draw = () => {
            c.clearRect(0, 0, 32, 32);
            for (let ly = 0; ly < mh && ly < 4; ly++) {
              for (let lx = 0; lx < mw && lx < 4; lx++) {
                const n = refs[ly * mw + lx] ?? -1;
                if (n < 0) continue;
                const r = unpackRef(n);
                drawMinitile(c, r.ts, r.pal, r.arr, r.mi, lx * MINITILE_SIZE, ly * MINITILE_SIZE);
              }
            }
          };
          draw();
          for (const n of refs) {
            if (n >= 0) {
              const r = unpackRef(n);
              void loadAtlas(r.ts, r.pal).then(draw);
            }
          }
        } else if (foot) {
          const draw = () => drawTile(c, foot.tilesetId, foot.paletteId, foot.tiles[0] ?? 0, 0, 0);
          draw();
          void loadAtlas(foot.tilesetId, foot.paletteId).then(draw);
        }
      }
    }
    if (this.eraseBtn) {
      this.eraseBtn.style.background = this.erasing ? '#3d1010' : '#1d2530';
      this.eraseBtn.style.borderColor = this.erasing ? '#ff6a6a' : '#3a4a5a';
      this.eraseBtn.style.color = this.erasing ? '#ff8a7a' : '#cde';
    }
    this.updatePaletteHi();
    this.syncPaintBtn();
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    if (this.pendingBlank) {
      this.statusEl.textContent = this.sel
        ? `New room ${this.sel.w}x${this.sel.h} — release to create`
        : 'Drag a box to size the new room…';
    } else if (this.selecting) {
      this.statusEl.textContent = this.sel
        ? `Selected ${this.sel.w}x${this.sel.h} — Sample→Stamp or Copy→Room`
        : 'Drag a box on the map…';
    } else if (this.painting) {
      this.statusEl.textContent = this.erasing
        ? 'Erasing — click/drag inside a room'
        : 'Painting — click/drag inside a room';
    } else if (this.resizing) {
      this.statusEl.textContent = `Resizing → ${this.resizing.w}x${this.resizing.h}`;
    } else if (this.selectedRoom()) {
      this.statusEl.textContent = `Selected "${this.selectedRoom()!.label}" — drag a corner handle to resize`;
    } else if (this.rooms.length === 0) {
      this.statusEl.textContent = 'Start with + New Room (or Copy area), then paint a brush in.';
    } else {
      this.statusEl.textContent = 'Click a room to select it, or pick a brush and paint.';
    }
  }

  private refreshLibrary(): void {
    if (!this.libraryEl) return;
    this.libraryEl.innerHTML = '';
    if (this.stamps.length === 0 && this.folders.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(no stamps — Sample area, then Sample→Stamp)';
      empty.style.cssText = 'color:#678;font-size:11px;';
      this.libraryEl.appendChild(empty);
      return;
    }

    // Group stamps by folder (unknown/absent folder id → Uncategorized).
    const valid = new Set(this.folders.map((f) => f.id));
    const grouped = new Map<string, Stamp[]>();
    for (const s of this.stamps) {
      const key = s.folder && valid.has(s.folder) ? s.folder : '';
      const arr = grouped.get(key) ?? grouped.set(key, []).get(key)!;
      arr.push(s);
    }

    for (const f of this.folders) {
      this.libraryEl.appendChild(this.folderSection(f, grouped.get(f.id) ?? []));
    }
    // Uncategorized last (only show the header if there are loose stamps).
    const loose = grouped.get('') ?? [];
    if (loose.length || this.folders.length === 0) {
      this.libraryEl.appendChild(this.folderSection(null, loose));
    }
  }

  /** A folder (or the Uncategorized bucket) — a drop target with its stamp grid. */
  private folderSection(folder: StampFolder | null, stamps: Stamp[]): HTMLDivElement {
    const fid = folder?.id ?? null;
    const section = document.createElement('div');
    section.style.cssText = 'border-radius:4px;border:1px solid #222b35;';
    const collapsed = folder ? this.collapsedFolders.has(folder.id) : false;

    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:4px;padding:3px 5px;font-size:11px;color:#9fd2ef;' +
      'background:#10161e;border-radius:4px;cursor:pointer;user-select:none;';
    const caret = folder ? (collapsed ? '▸' : '▾') : '•';
    const title = document.createElement('span');
    title.textContent = `${caret} ${folder ? folder.name : 'Uncategorized'} (${stamps.length})`;
    title.style.flex = '1';
    if (folder) {
      title.onclick = () => {
        if (this.collapsedFolders.has(folder.id)) this.collapsedFolders.delete(folder.id);
        else this.collapsedFolders.add(folder.id);
        this.refreshLibrary();
      };
    }
    header.appendChild(title);
    if (folder) {
      const ren = document.createElement('span');
      ren.textContent = '✎';
      ren.title = 'Rename folder';
      ren.style.cssText = 'color:#88a;cursor:pointer;';
      ren.onclick = (e) => {
        e.stopPropagation();
        void this.renameFolder(folder);
      };
      const del = document.createElement('span');
      del.textContent = '🗑';
      del.title = 'Delete folder';
      del.style.cssText = 'cursor:pointer;';
      del.onclick = (e) => {
        e.stopPropagation();
        void this.deleteFolder(folder);
      };
      header.append(ren, del);
    }
    section.appendChild(header);

    // The whole section is a drop target: dropping a stamp re-files it here.
    const highlight = (on: boolean) => {
      section.style.background = on ? '#10303d' : '';
    };
    section.ondragover = (e) => {
      e.preventDefault();
      highlight(true);
    };
    section.ondragleave = () => highlight(false);
    section.ondrop = (e) => {
      e.preventDefault();
      highlight(false);
      const id = e.dataTransfer?.getData('text/plain');
      if (id) void this.moveStampToFolder(id, fid);
    };

    if (!collapsed) {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px;min-height:20px;';
      if (stamps.length === 0) {
        const hint = document.createElement('div');
        hint.textContent = 'drag stamps here';
        hint.style.cssText = 'color:#4a5563;font-size:10px;font-style:italic;padding:2px;';
        grid.appendChild(hint);
      }
      for (const s of stamps) grid.appendChild(this.stampCell(s));
      section.appendChild(grid);
    }
    return section;
  }

  /** A single draggable stamp tile (click = pick brush, ✕ = delete, drag = re-file). */
  private stampCell(s: Stamp): HTMLDivElement {
    const active = this.brush?.kind === 'stamp' && this.brush.stamp.id === s.id;
    const cell = document.createElement('div');
    cell.draggable = true;
    cell.style.cssText =
      'position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;' +
      'padding:3px;border-radius:4px;cursor:grab;width:72px;' +
      (active
        ? 'background:#10303d;border:1px solid #4db6e8;'
        : 'background:#161c24;border:1px solid #2a3340;');
    cell.title = `${s.label} · ${s.w}x${s.h} · ts${s.tilesetId}/pal${s.paletteId}`;
    cell.onclick = () => this.setBrushStamp(s);
    cell.ondragstart = (e) => {
      e.dataTransfer?.setData('text/plain', s.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    try {
      cell.appendChild(this.makeThumb(s, 64));
    } catch {
      /* a bad thumbnail must not blank the whole library */
    }
    const name = document.createElement('div');
    name.textContent = s.label;
    name.style.cssText =
      'font-size:10px;color:#bfe3ff;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    cell.appendChild(name);
    const del = document.createElement('div');
    del.textContent = '✕';
    del.title = 'Delete stamp';
    del.style.cssText =
      'position:absolute;top:1px;right:3px;color:#ff8a7a;font-size:11px;cursor:pointer;';
    del.onclick = (e) => {
      e.stopPropagation();
      void this.deleteStamp(s.id);
    };
    cell.appendChild(del);
    const edit = document.createElement('div');
    edit.textContent = '✎';
    edit.title = 'Copy & edit pixels → new stamp';
    edit.style.cssText =
      'position:absolute;top:1px;left:3px;color:#9fe3a0;font-size:11px;cursor:pointer;';
    edit.onclick = (e) => {
      e.stopPropagation();
      void this.editStampPixels(s);
    };
    cell.appendChild(edit);
    return cell;
  }

  private makeThumb(s: Stamp, maxPx: number): HTMLCanvasElement {
    const pxW = s.mini ? (s.mw ?? 1) * MINITILE_SIZE : s.w * TILE_SIZE;
    const pxH = s.mini ? (s.mh ?? 1) * MINITILE_SIZE : s.h * TILE_SIZE;
    const scale = Math.max(0.0625, Math.min(2, maxPx / Math.max(pxW, pxH)));
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    canvas.style.cssText = `width:${Math.max(1, Math.round(pxW * scale))}px;height:${Math.max(1, Math.round(pxH * scale))}px;image-rendering:pixelated;background:#000;border-radius:2px;`;
    const c = canvas.getContext('2d');
    if (!c) return canvas;
    if (s.mini) {
      const mw = s.mw ?? 1;
      const mh = s.mh ?? 1;
      const refs = s.refs ?? [];
      const draw = () => {
        for (let ly = 0; ly < mh; ly++) {
          for (let lx = 0; lx < mw; lx++) {
            const n = refs[ly * mw + lx] ?? -1;
            if (n < 0) continue;
            if (isCustomRef(n)) {
              drawCustomMinitile(c, customRefId(n), lx * MINITILE_SIZE, ly * MINITILE_SIZE);
              continue;
            }
            const r = unpackRef(n);
            drawMinitile(c, r.ts, r.pal, r.arr, r.mi, lx * MINITILE_SIZE, ly * MINITILE_SIZE);
          }
        }
      };
      draw();
      // Prime each distinct source atlas, then redraw once they're in.
      const keys = new Set(refs.filter((n) => n >= 0).map((n) => unpackRef(n)));
      for (const r of keys) void loadAtlas(r.ts, r.pal).then(draw);
    } else {
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
    if (this.rooms.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(none yet)';
      empty.style.cssText = 'color:#678;font-size:11px;';
      this.listEl.appendChild(empty);
      return;
    }
    for (const r of this.rooms) {
      const gx = r.bandX * 32 + r.spawnDX;
      const gy = r.bandY * 32 + r.spawnDY;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const selected = r.id === this.selectedRoomId;
      const name = document.createElement('span');
      name.textContent = selected ? `▸ ${r.label}` : r.label;
      name.title = `${r.id} · ${r.w}x${r.h}t · click=select+go, double-click=rename`;
      name.style.cssText =
        'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;' +
        (selected ? 'color:#ffd23e;font-weight:bold;' : 'color:#bfe3ff;');
      let clickTimer: number | null = null;
      name.onclick = () => {
        if (clickTimer !== null) return;
        clickTimer = window.setTimeout(() => {
          clickTimer = null;
          this.selectRoom(r.id); // select → shows resize handles on the map
          this.shell!.goTo(gx, gy);
        }, 220);
      };
      name.ondblclick = () => {
        if (clickTimer !== null) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        this.startInlineRename(r.id, r.label, name);
      };
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

  // ── small DOM builders ─────────────────────────────────────────────────────

  private mkTitle(text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'color:#4db6e8;font-weight:bold;letter-spacing:1px;';
    return d;
  }

  private mkSection(text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText =
      'color:#5a7a90;font-size:10px;letter-spacing:1px;border-top:1px solid #233040;padding-top:6px;margin-top:2px;';
    return d;
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

  private mkMini(label: string, fn: () => void, parent: HTMLElement): HTMLButtonElement {
    const b = this.mkBtn(label, fn, parent);
    b.style.padding = '2px 5px';
    return b;
  }
}

export const roomBuilderTool = new RoomBuilderTool();
