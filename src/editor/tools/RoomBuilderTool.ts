import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { mkButton } from '../ui';
import {
  getTileAt,
  getSectorForTile,
  getOverworldHeightTiles,
  buildCustomRoomBand,
  MapTilesOverride,
} from '../../engine/MapManager';
import { drawTile, drawMinitile, loadAtlas } from '../../engine/TilesetManager';
import { COMPOSITE_BASE, isComposite, packRef, unpackRef } from '../../engine/CompositeTiles';
import { customRefId, isCustomRef, drawCustomMinitile } from '../../engine/CustomTiles';
import { primeJSONCache } from '../../engine/AssetLoader';
import { TILE_SIZE, MINITILE_SIZE, SECTOR_TILES_X, SECTOR_TILES_Y, SectorMeta } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';
import {
  Stamp,
  StampFolder,
  getStamps,
  getStampFolders,
  setStamps,
  setStampFolders,
  loadStamps,
  saveStamps,
} from '../../engine/Stamps';
import {
  addFurnitureSprite,
  customSpritesDoc,
  CustomSpriteTiles,
} from '../../engine/CustomSprites';
import { setEntityCol } from '../../engine/NPCManager';
import { EntityCol, EntityPropsOverride } from '../../engine/EntityStats';
import { openSpriteEditor } from '../../engine/spriteEditor';
import { placementTool } from './PlacementTool';
import { collisionPaint, CollisionOp } from './collisionPaint';
import { FloatingPanel } from '../FloatingPanel';

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

// Stamp / StampFolder now live in the shared engine/Stamps service (single source
// of truth, shared with the Sprite Editor's stamp-cleanup mode).

// What you paint with: a single arrangement from the palette, or a sampled stamp.
type Brush =
  | { kind: 'tile'; tilesetId: number; paletteId: number; arr: number }
  | { kind: 'stamp'; stamp: Stamp };

// The ONE "what does clicking do?" selector. Each tool reveals only its own
// controls: Select picks/resizes rooms; Paint draws tiles; Walls paints
// walkability; Front paints the foreground (hide-behind) layer; Back paints the
// always-on-top (entities draw over the tile) layer.
type RoomTool = 'select' | 'paint' | 'walls' | 'front' | 'back';

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
  private floatPanel: FloatingPanel | null = null;

  // rooms / data
  private rooms: CustomRoom[] = [];
  // Stamps/folders proxy the shared engine/Stamps service (one source of truth so
  // edits in the Sprite Editor's stamp mode reflect here, and vice versa).
  private get stamps(): Stamp[] {
    return getStamps();
  }
  private set stamps(v: Stamp[]) {
    setStamps(v);
  }
  private get folders(): StampFolder[] {
    return getStampFolders();
  }
  private set folders(v: StampFolder[]) {
    setStampFolders(v);
  }
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

  // Copy area → paste: drag-select sector(s) to capture as tileset-independent
  // minitile refs, then click a destination sector to stamp them into the map
  // override (works on ANY room — no stamp saved to the library).
  private copyPhase: 'off' | 'select' | 'paste' = 'off';
  private copyBuf: { mw: number; mh: number; refs: number[] } | null = null;

  // "Edit map" mode — paint/erase/stamp directly onto ANY room's tiles (not just
  // the custom band), persisted to overrides/map_tiles.json. Off by default so a
  // stray click can't repaint the world.
  private editMap = false;
  private mapTilesOv: MapTilesOverride = { version: 1, cells: {}, composites: {} };
  private mapOvBefore: MapTilesOverride | null = null; // undo snapshot for a stroke
  private editMapBtn: HTMLButtonElement | null = null;

  // paint-stroke bookkeeping
  private hoverTile: { tx: number; ty: number } | null = null;
  private hoverMini: { mx: number; my: number } | null = null;
  private lastPaintedKey = '';
  private strokeDirty = false;
  private warnedStyle = false;
  private strokeBefore: CustomRoom[] | null = null;
  private roomsCollapsed = false;

  // Collision / layer paint (embedded — replaces the old standalone tool).
  // 'tiles' = normal tile painting; any CollisionOp routes the mouse to the
  // shared collisionPaint core instead (Solid/Walk/FG + advanced pri/clear).
  private tool: RoomTool = 'select';
  private wallsErase = false;
  private fgSeg: HTMLDivElement | null = null;
  private bgSeg: HTMLDivElement | null = null;
  private paintMode: 'tiles' | CollisionOp = 'tiles';
  private colHover: WorldPoint = { x: 0, y: 0 };
  private advOpen = false;
  private toolHelp: HTMLDivElement | null = null;
  private brushHeader: HTMLDivElement | null = null;
  private brushTop: HTMLDivElement | null = null;
  private colControls: HTMLDivElement | null = null;
  private wallsSeg: HTMLDivElement | null = null;
  private advEl: HTMLDivElement | null = null;
  private advOut: HTMLPreElement | null = null;

  // Layer VISIBILITY toggles — independent of the active tool. When on, that
  // layer's overlay is drawn under EVERY tool, so you can paint tiles while
  // seeing the walls + front you've laid down. The active collision tool always
  // force-shows its own layer regardless of these toggles.
  private layerVis: { walls: boolean; front: boolean; back: boolean; pri: boolean } = {
    walls: false,
    front: false,
    back: false,
    pri: false,
  };
  private layerBtns: Partial<Record<'walls' | 'front' | 'back' | 'pri', HTMLButtonElement>> = {};

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
    collisionPaint.setShell(shell);
    void collisionPaint.load();
    this.buildPanel();
    this.refreshList();
    this.refreshLibrary();
    void this.reloadData();
    this.updateStatus();
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  deactivate(): void {
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.floatPanel?.destroy();
    this.floatPanel = null;
    this.panel?.remove();
    this.panel = null;
    this.selecting = false;
    this.painting = false;
    this.pendingBlank = false;
    this.dragStart = null;
    this.sel = null;
    this.hoverTile = null;
    this.resizing = null;
    this.mapOvBefore = null;
    this.copyPhase = 'off';
    this.copyBuf = null;
  }

  private onContextMenu = (e: MouseEvent): void => {
    if (this.copyPhase !== 'off') {
      e.preventDefault();
      this.cancelCopy();
      return;
    }
    if (!this.painting) return;
    e.preventDefault();
    this.setPainting(false);
    this.shell?.toast('Paint off');
  };

  onKey(key: string): boolean {
    if (key === 'escape' && this.copyPhase !== 'off') {
      this.cancelCopy();
      return true;
    }
    if (key === 'escape' && this.painting) {
      this.setPainting(false);
      this.shell?.toast('Paint off');
      return true;
    }
    if (key === 'escape' && this.selecting) {
      this.selecting = false;
      this.pendingBlank = false;
      this.sampleMini = false;
      this.sel = null;
      this.dragStart = null;
      this.updateStatus();
      this.shell?.toast('Cancelled');
      return true;
    }
    return false;
  }

  private async reloadData(): Promise<void> {
    try {
      // Stamps live in the shared engine/Stamps service (DB-backed, legacy
      // overrides/stamps.json fallback). loadStamps() refreshes the canonical
      // lists that this.stamps/this.folders proxy — shared with the Sprite Editor.
      await loadStamps();
      const rdoc = await loadOverride<CustomRoomsDoc>('rooms.json');
      if (rdoc?.rooms) this.rooms = rdoc.rooms;

      const mdoc = await loadOverride<MapTilesOverride>('map_tiles.json');
      if (mdoc?.cells)
        this.mapTilesOv = {
          version: 1,
          cells: { ...mdoc.cells },
          composites: { ...(mdoc.composites ?? {}) },
        };

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
    if (this.paintMode !== 'tiles') {
      // Collision/layer paint: a left-drag paints cells via the shared core.
      return collisionPaint.beginStroke(p, this.paintMode);
    }
    // Copy-area paste: a click drops the captured region at the clicked sector.
    if (this.copyPhase === 'paste' && this.copyBuf) {
      this.pasteCopyAt(p);
      return true;
    }
    if (this.painting) {
      this.lastPaintedKey = '';
      this.strokeDirty = false;
      this.warnedStyle = false;
      if (this.editMap) this.mapOvBefore = this.cloneMapOv();
      else this.strokeBefore = this.cloneRooms();
      this.paintHere(p);
      return true;
    }
    if (this.selecting) {
      const u = this.selUnit;
      this.dragStart = { tx: Math.floor(p.x / u), ty: Math.floor(p.y / u) };
      this.sel = { tx: this.dragStart.tx, ty: this.dragStart.ty, w: 1, h: 1 };
      // New-room mode selects whole sectors — snap from the first click so even a
      // plain click (no drag) reads as "1 sector", matching the Room Manager feel.
      if (this.pendingBlank) this.snapSelToSectors();
      this.updateStatus();
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
    if (this.paintMode !== 'tiles') {
      this.colHover = p;
      if (dragging) collisionPaint.dragStroke(p);
      return;
    }
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
    if (this.pendingBlank) this.snapSelToSectors();
    this.updateStatus();
  }

  /** Grow the current marquee out to whole sectors (new-room footprint = N sectors). */
  private snapSelToSectors(): void {
    if (!this.sel) return;
    const x0 = Math.floor(this.sel.tx / SECTOR_TILES_X) * SECTOR_TILES_X;
    const y0 = Math.floor(this.sel.ty / SECTOR_TILES_Y) * SECTOR_TILES_Y;
    const x1 = Math.ceil((this.sel.tx + this.sel.w) / SECTOR_TILES_X) * SECTOR_TILES_X;
    const y1 = Math.ceil((this.sel.ty + this.sel.h) / SECTOR_TILES_Y) * SECTOR_TILES_Y;
    this.sel = { tx: x0, ty: y0, w: x1 - x0, h: y1 - y0 };
  }

  onMouseUp(): void {
    if (this.paintMode !== 'tiles') {
      collisionPaint.endStroke();
      return;
    }
    if (this.resizing) {
      this.commitResize();
      return;
    }
    if (this.painting) {
      if (this.editMap) {
        if (this.strokeDirty && this.mapOvBefore) {
          const before = this.mapOvBefore;
          const after = this.cloneMapOv();
          this.shell!.run({
            label: this.erasing ? 'Erase map tiles' : 'Paint map tiles',
            do: () => void this.applyMapOvState(after),
            undo: () => void this.applyMapOvState(before),
          });
        }
        this.mapOvBefore = null;
        this.strokeDirty = false;
        return;
      }
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
      const { tx, ty, w, h } = this.sel;
      this.pendingBlank = false;
      this.selecting = false;
      this.sel = null;
      void this.createBlankRoom(tx, ty, w, h);
      return;
    }
    if (this.copyPhase === 'select' && this.sel && this.sel.w >= 1 && this.sel.h >= 1) {
      this.captureCopy();
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
    // Pin the fixed (opposite) corner so the room grows/shrinks where it sits —
    // free placement, no band re-stacking.
    room.bandX = Math.max(0, anchorRight ? rz.fx - rz.w : rz.fx);
    room.bandY = Math.max(0, anchorBottom ? rz.fy - rz.h : rz.fy);
    room.spawnDX = Math.min(room.spawnDX, rz.w * 32 - 16);
    room.spawnDY = Math.min(room.spawnDY, rz.h * 32 - 16);

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

    let mix = false;
    if (
      foot &&
      (room.sector.tilesetId !== foot.tilesetId || room.sector.paletteId !== foot.paletteId)
    ) {
      // A still-blank room ADOPTS the brush's tileset/palette (its cells stay
      // compact ROM-arrangement indices). A room that already holds a DIFFERENT
      // style paints the stamp as self-describing COMPOSITE cells instead — each
      // minitile carries its own tileset/palette, so tilesets mix freely (make
      // crazy new stuff), exactly like sub-tile (minitile) stamps already do.
      const roomEmpty = room.tiles.every((t) => (t ?? 0) === 0);
      if (roomEmpty) {
        room.sector = { ...room.sector, tilesetId: foot.tilesetId, paletteId: foot.paletteId };
      } else {
        mix = true;
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
        const cellIdx = ry * room.w + rx;
        if (this.erasing) {
          room.tiles[cellIdx] = 0;
        } else {
          const arr = foot!.tiles[ly * w + lx] ?? 0;
          room.tiles[cellIdx] = mix ? this.mixCell(room, foot!, arr) : arr;
        }
        changed = true;
      }
    }
    if (!changed) return;
    this.strokeDirty = true;
    primeJSONCache('/overrides/rooms.json', { version: 1, rooms: this.rooms });
    void buildCustomRoomBand();
  }

  /** Store a full-tile stamp cell as a self-describing COMPOSITE under the STAMP's
   *  own tileset/palette, so it renders + collides correctly inside a room of a
   *  different style (this is what lets a stamp mix tilesets). arr 0 stays empty;
   *  an already-composite arr keeps its refs. Returns the cell id for room.tiles. */
  private mixCell(room: CustomRoom, foot: Footprint, arr: number): number {
    if (arr === 0) return 0;
    room.composites = room.composites ?? {};
    const comp = new Array<number>(16);
    if (isComposite(arr)) {
      const src = this.lookupComposite(arr);
      for (let mi = 0; mi < 16; mi++) comp[mi] = src?.[mi] ?? -1;
    } else {
      for (let mi = 0; mi < 16; mi++) comp[mi] = packRef(foot.tilesetId, foot.paletteId, arr, mi);
    }
    const id = this.nextCompositeId();
    room.composites[String(id)] = comp;
    return id;
  }

  // ── minitile (sub-tile) painting ───────────────────────────────────────────

  private paintHere(p: WorldPoint): void {
    if (this.editMap) {
      if (this.isMiniBrush()) {
        this.paintMapMinis(Math.floor(p.x / MINITILE_SIZE), Math.floor(p.y / MINITILE_SIZE));
        return;
      }
      this.paintMapCell(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE));
      return;
    }
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
    // Map-edit composites share the same id space (both feed setComposites), so
    // account for them too or a new custom cell could reuse a map cell's id.
    for (const k of Object.keys(this.mapTilesOv.composites ?? {})) max = Math.max(max, Number(k));
    return max + 1;
  }

  /** Find a composite's 16 refs by id across both sources (custom rooms + the map
   *  override), so converting a cell that's already a composite keeps its pixels. */
  private lookupComposite(id: number): number[] | undefined {
    for (const r of this.rooms) {
      const c = r.composites?.[String(id)];
      if (c) return c;
    }
    return this.mapTilesOv.composites?.[String(id)];
  }

  /** Minitile painting onto ANY room (Edit-map mode): the composite goes into the
   *  map_tiles override's global composite map instead of a custom room's — same
   *  mechanism buildCustomRoomBand already consumes for non-band cells. */
  private paintMapMinis(mx: number, my: number): void {
    if (this.brush?.kind !== 'stamp' || !this.brush.stamp.mini) return;
    const s = this.brush.stamp;
    const mw = s.mw ?? 1;
    const mh = s.mh ?? 1;
    const refs = s.refs ?? [];
    const key = `mm${mx},${my}`;
    if (key === this.lastPaintedKey) return;
    this.lastPaintedKey = key;
    let changed = false;
    for (let ly = 0; ly < mh; ly++) {
      for (let lx = 0; lx < mw; lx++) {
        const n = refs[ly * mw + lx] ?? -1;
        if (n < 0) continue; // transparent part of the stamp — don't erase
        const comp = this.ensureMapCompositeCell((mx + lx) >> 2, (my + ly) >> 2);
        if (!comp) continue; // off-map
        comp[((my + ly) & 3) * 4 + ((mx + lx) & 3)] = n;
        changed = true;
      }
    }
    if (!changed) return;
    this.strokeDirty = true;
    primeJSONCache('/overrides/map_tiles.json', this.mapTilesOv);
    void buildCustomRoomBand();
  }

  /** Ensure the map cell at tile (tx,ty) is a composite in the map override,
   *  converting its current arrangement (ROM or existing composite) in place. */
  private ensureMapCompositeCell(tx: number, ty: number): number[] | null {
    const sec = getSectorForTile(tx, ty);
    if (!sec) return null; // off the map
    this.mapTilesOv.composites = this.mapTilesOv.composites ?? {};
    this.mapTilesOv.cells = this.mapTilesOv.cells ?? {};
    // Prefer this stroke's pending override for the cell (buildCustomRoomBand
    // hasn't re-run yet, so getTileAt still reports the pre-stroke arrangement) —
    // otherwise a second minitile in the same cell would orphan the first.
    const pending = this.mapTilesOv.cells[`${tx},${ty}`];
    const cur = pending !== undefined ? pending : getTileAt(tx, ty);
    if (isComposite(cur)) {
      let comp = this.mapTilesOv.composites[String(cur)];
      if (!comp) {
        comp = this.lookupComposite(cur)?.slice() ?? new Array(16).fill(-1);
        this.mapTilesOv.composites[String(cur)] = comp;
      }
      this.mapTilesOv.cells[`${tx},${ty}`] = cur;
      return comp;
    }
    const comp: number[] = new Array(16).fill(-1);
    if (cur > 0 && cur < COMPOSITE_BASE) {
      // Explode the existing ROM arrangement into its 16 source minitiles.
      for (let mi = 0; mi < 16; mi++) comp[mi] = packRef(sec.tilesetId, sec.paletteId, cur, mi);
    }
    const id = this.nextCompositeId();
    this.mapTilesOv.composites[String(id)] = comp;
    this.mapTilesOv.cells[`${tx},${ty}`] = id;
    return comp;
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

  // ── edit map (per-cell tile override on ANY room) ──────────────────────────

  private toggleEditMap(): void {
    this.editMap = !this.editMap;
    if (this.editMap) {
      // Default the brush palette to the sector under the cursor so painted tiles
      // match the room's style without garbling (mismatched tileset = garbage).
      const h = this.hoverTile;
      const sec = h ? getSectorForTile(h.tx, h.ty) : null;
      if (sec) {
        this.palTs = sec.tilesetId;
        this.palPal = sec.paletteId;
        void this.renderPalette();
      }
      this.setPainting(true);
      this.shell?.toast('Edit map ON — paint/erase tiles in ANY room (saved to map_tiles.json)');
    } else {
      this.setPainting(false);
      this.shell?.toast('Edit map OFF');
    }
    this.syncEditMapBtn();
  }

  private syncEditMapBtn(): void {
    const b = this.editMapBtn;
    if (!b) return;
    b.textContent = this.editMap ? 'Edit map: ON (any room)' : 'Edit map: off';
    b.style.background = this.editMap ? '#3d2a10' : '#1d2530';
    b.style.borderColor = this.editMap ? '#e8a33d' : '#3a4a5a';
    b.style.color = this.editMap ? '#ffd23e' : '#cde';
  }

  /** Paint/erase ONE map cell into the tile override (with the brush's top-left at
   *  tx,ty for a stamp). A painted arrangement is interpreted with the target
   *  cell's own sector tileset/palette, so the brush must match it. */
  private paintMapCell(tx: number, ty: number): void {
    const key = `${tx},${ty}`;
    if (key === this.lastPaintedKey) return;
    this.lastPaintedKey = key;
    const sec = getSectorForTile(tx, ty);
    if (!sec) return; // off the map

    this.mapTilesOv.cells = this.mapTilesOv.cells ?? {};
    if (this.erasing) {
      if (this.mapTilesOv.cells[key] !== undefined) {
        delete this.mapTilesOv.cells[key];
        this.strokeDirty = true;
      }
    } else {
      const foot = this.brushFoot();
      if (!foot) return;
      if (foot.tilesetId !== sec.tilesetId || foot.paletteId !== sec.paletteId) {
        if (!this.warnedStyle) {
          this.shell!.toast(
            `Cell is ts${sec.tilesetId}/pal${sec.paletteId}; brush is ts${foot.tilesetId}/pal${foot.paletteId}. Match the room's style (Tiles tab steppers / sample from this room).`,
            true
          );
          this.warnedStyle = true;
        }
        return;
      }
      for (let ly = 0; ly < foot.h; ly++) {
        for (let lx = 0; lx < foot.w; lx++) {
          const cx = tx + lx;
          const cy = ty + ly;
          const s = getSectorForTile(cx, cy);
          // Only paint cells whose sector matches the brush — a stamp straddling
          // two tilesets won't garble the neighbor.
          if (!s || s.tilesetId !== foot.tilesetId || s.paletteId !== foot.paletteId) continue;
          this.mapTilesOv.cells[`${cx},${cy}`] = foot.tiles[ly * foot.w + lx] ?? 0;
          this.strokeDirty = true;
        }
      }
    }
    if (!this.strokeDirty) return;
    primeJSONCache('/overrides/map_tiles.json', this.mapTilesOv);
    void buildCustomRoomBand();
  }

  private cloneMapOv(): MapTilesOverride {
    return {
      version: 1,
      cells: { ...(this.mapTilesOv.cells ?? {}) },
      composites: { ...(this.mapTilesOv.composites ?? {}) },
    };
  }

  private async applyMapOvState(snapshot: MapTilesOverride): Promise<void> {
    this.mapTilesOv = {
      version: 1,
      cells: { ...(snapshot.cells ?? {}) },
      composites: { ...(snapshot.composites ?? {}) },
    };
    primeJSONCache('/overrides/map_tiles.json', this.mapTilesOv);
    await buildCustomRoomBand();
    try {
      await saveOverride('map_tiles.json', this.mapTilesOv);
    } catch (e) {
      this.shell?.toast(`Save failed: ${e}`, true);
    }
  }

  // ── overlay ──────────────────────────────────────────────────────────────

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const inCol = this.paintMode !== 'tiles';
    // Layer overlays = the visibility toggles, OR'd with whatever the active
    // collision tool needs force-shown (so switching to Walls always shows walls
    // even if its toggle is off). Drawn under EVERY tool so a tile paint can see
    // the walls/front already laid down.
    const advanced = this.paintMode === 'prilo' || this.paintMode === 'prihi';
    const show = {
      solid:
        this.layerVis.walls || this.paintMode === 'solid' || this.paintMode === 'walk' || advanced,
      pri: this.layerVis.pri || advanced || this.paintMode === 'clear',
      fg: this.layerVis.front || this.paintMode === 'fg' || this.paintMode === 'clear',
      bg: this.layerVis.back || this.paintMode === 'bg' || this.paintMode === 'clear',
    };
    if (inCol || show.solid || show.pri || show.fg || show.bg) {
      collisionPaint.drawOverlay(ctx, camera, this.colHover, show, inCol);
    }
    // Collision tools draw only their layer overlay — no room boxes/ghost on top.
    if (inCol) return;
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
        const hr = 2.5; // handle radius
        ctx.fillStyle = '#ffd23e';
        const corners: [number, number][] = [
          [rx, ry],
          [rx + rw, ry],
          [rx, ry + rh],
          [rx + rw, ry + rh],
        ];
        for (const [hx, hy] of corners) {
          ctx.beginPath();
          ctx.arc(hx, hy, hr, 0, Math.PI * 2);
          ctx.fill();
        }
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
      let label: string;
      if (this.pendingBlank) {
        const secs = (this.sel.w / SECTOR_TILES_X) * (this.sel.h / SECTOR_TILES_Y);
        label = `new room — ${secs} sector${secs === 1 ? '' : 's'}`;
      } else {
        label = `${this.sel.w}x${this.sel.h}${u === MINITILE_SIZE ? ' minis' : ''}`;
      }
      ctx.fillText(label, x + 3, y - 4);
    }

    // Copy/paste ghost: outline where the captured region would land, snapped to
    // the sector under the cursor.
    if (this.copyPhase === 'paste' && this.copyBuf && this.hoverTile) {
      const secTX = SECTOR_TILES_X;
      const secTY = SECTOR_TILES_Y;
      const dtx = Math.floor(this.hoverTile.tx / secTX) * secTX;
      const dty = Math.floor(this.hoverTile.ty / secTY) * secTY;
      const x = dtx * TILE_SIZE - Math.round(camera.x);
      const y = dty * TILE_SIZE - Math.round(camera.y);
      const w = (this.copyBuf.mw / 4) * TILE_SIZE;
      const h = (this.copyBuf.mh / 4) * TILE_SIZE;
      ctx.fillStyle = 'rgba(124,252,106,0.14)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#7CFC6A';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = '#d4ffcb';
      ctx.font = '11px monospace';
      ctx.fillText('paste here', x + 3, y - 4);
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
      // Edit-map mode targets ANY cell; "ok" = the brush matches the cell's
      // sector tileset/palette. Otherwise the target must be a custom room.
      const editSec = this.editMap ? getSectorForTile(ox, oy) : null;
      const ok = this.editMap
        ? this.erasing
          ? !!editSec
          : !!foot &&
            !!editSec &&
            editSec.tilesetId === foot.tilesetId &&
            editSec.paletteId === foot.paletteId
        : // Any stamp now paints into any room (mismatched styles become
          // composite cells), so a room + a brush is always paintable.
          !!room && (this.erasing || !!foot);
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

  /** Turn the current tile selection into a movable FURNITURE prop: mint a
   *  tile-region custom sprite (by-reference, no pixels), give it a solid
   *  collision box (the full footprint), persist both the art metadata and the
   *  col, then hand off to the Placement editor ready to drop it. */
  private async saveFurniture(): Promise<void> {
    if (!this.sel || this.sel.w < 1 || this.sel.h < 1) {
      this.shell!.toast('Drag a box on the map first (Sample 32)', true);
      return;
    }
    if (this.selUnit !== TILE_SIZE) {
      this.shell!.toast('Furniture needs a tile selection — use "Sample 32"', true);
      return;
    }
    const { tx, ty, w, h } = this.sel;
    const name = window.prompt('Furniture name:', `Furniture ${this.stamps.length + 1}`)?.trim();
    if (!name) return;

    const style = this.sampleStyle(tx, ty, w, h, false);
    const tiles: CustomSpriteTiles = {
      tilesetId: style.tilesetId,
      paletteId: style.paletteId,
      w,
      h,
      bg: this.readRegion(tx, ty, w, h),
    };

    let id: number;
    try {
      id = await addFurnitureSprite(name, tiles);
    } catch (e) {
      this.shell!.toast(`Furniture create failed: ${e}`, true);
      return;
    }

    // Solid collision box = the full footprint (centered on x, feet at the bottom).
    // Tune it later per sprite in the Entity Manager.
    const col: EntityCol = { w: w * TILE_SIZE, h: h * TILE_SIZE, offX: 0, offY: 0 };
    setEntityCol(id, col); // live → solid + drawn in the overlay immediately

    try {
      await saveOverride('custom_sprites.json', customSpritesDoc());
      const entDoc = (await loadOverride<{
        version?: number;
        entities?: Record<string, EntityPropsOverride>;
      }>('entities.json')) ?? { version: 1, entities: {} };
      const entities: Record<string, EntityPropsOverride> = entDoc.entities ?? {};
      entities[String(id)] = { ...(entities[String(id)] ?? {}), col };
      await saveOverride('entities.json', { version: 1, entities });
    } catch (e) {
      this.shell!.toast(`Save failed: ${e}`, true);
      return;
    }

    this.selecting = false;
    this.sel = null;
    this.updateStatus();
    // Land in the Placement editor ready to drop it as a prop.
    placementTool.requestPlaceProp(id);
    this.shell!.openTool('placement');
    this.shell!.toast(`Saved furniture "${name}" — click the map to place it`);
  }

  // ── copy area → paste (on-map sector copy/paste; no library stamp) ──────────

  /** Arm the copy: drag-select the source sector(s), then click to paste. */
  private copyArea(): void {
    this.setTool('select'); // tiles-mode, non-painting context for the marquee
    this.selecting = true;
    this.pendingBlank = false;
    this.sampleMini = false;
    this.selUnit = TILE_SIZE;
    this.sel = null;
    this.dragStart = null;
    this.copyBuf = null;
    this.copyPhase = 'select';
    this.updateStatus();
    this.shell!.toast(
      'Drag to select sector(s) to copy — then click a sector to paste. Esc cancels.'
    );
  }

  /** End of the source drag: capture the sector-aligned region as minitile refs. */
  private captureCopy(): void {
    if (!this.sel) return;
    const tx = Math.floor(this.sel.tx / SECTOR_TILES_X) * SECTOR_TILES_X;
    const ty = Math.floor(this.sel.ty / SECTOR_TILES_Y) * SECTOR_TILES_Y;
    const w = Math.ceil((this.sel.tx + this.sel.w) / SECTOR_TILES_X) * SECTOR_TILES_X - tx;
    const h = Math.ceil((this.sel.ty + this.sel.h) / SECTOR_TILES_Y) * SECTOR_TILES_Y - ty;
    // Capture as packed minitile refs (each carries its own tileset/palette), so a
    // paste renders correctly regardless of the destination sector's style.
    const mw = w * 4;
    const mh = h * 4;
    const refs = new Array<number>(mw * mh);
    for (let ly = 0; ly < mh; ly++) {
      for (let lx = 0; lx < mw; lx++) {
        refs[ly * mw + lx] = this.srcMinitileRef(tx * 4 + lx, ty * 4 + ly);
      }
    }
    this.copyBuf = { mw, mh, refs };
    this.selecting = false;
    this.sel = null;
    this.dragStart = null;
    this.copyPhase = 'paste';
    this.updateStatus();
    const secs = (w / SECTOR_TILES_X) * (h / SECTOR_TILES_Y);
    this.shell!.toast(`Copied ${secs} sector(s) — click a sector to paste (Esc when done)`);
  }

  /** Stamp the captured region into the map override, sector-aligned to the click. */
  private pasteCopyAt(p: WorldPoint): void {
    if (!this.copyBuf) return;
    const secW = SECTOR_TILES_X * TILE_SIZE;
    const secH = SECTOR_TILES_Y * TILE_SIZE;
    const destTx0 = Math.floor(p.x / secW) * SECTOR_TILES_X;
    const destTy0 = Math.floor(p.y / secH) * SECTOR_TILES_Y;
    if (!getSectorForTile(destTx0, destTy0)) {
      this.shell!.toast('Off the map', true);
      return;
    }
    const before = this.cloneMapOv();
    const { mw, mh, refs } = this.copyBuf;
    for (let ly = 0; ly < mh; ly++) {
      for (let lx = 0; lx < mw; lx++) {
        const comp = this.ensureMapCompositeCell(destTx0 + (lx >> 2), destTy0 + (ly >> 2));
        if (!comp) continue; // off-map cell — skip
        comp[(ly & 3) * 4 + (lx & 3)] = refs[ly * mw + lx];
      }
    }
    primeJSONCache('/overrides/map_tiles.json', this.mapTilesOv);
    const after = this.cloneMapOv();
    this.shell!.run({
      label: 'Paste tiles',
      do: () => void this.applyMapOvState(after),
      undo: () => void this.applyMapOvState(before),
    });
    this.shell!.toast('Pasted — click another sector or Esc to finish');
  }

  /** Leave copy/paste mode (Esc / tool change / right-click). */
  private cancelCopy(): void {
    if (this.copyPhase === 'off') return;
    this.copyPhase = 'off';
    this.copyBuf = null;
    this.selecting = false;
    this.sel = null;
    this.dragStart = null;
    this.updateStatus();
    this.shell?.toast('Copy/paste off');
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

  /** Persist the stamp library (stamps + folders) to the DB via the shared service. */
  private async persistStamps(): Promise<void> {
    await saveStamps();
  }

  // ── pixel editing → Sprite Editor ────────────────────────────────────────
  /** Open a stamp in the full Sprite Editor (Stamp mode) to clean it up / erase
   *  its background. Saving there overwrites this same stamp in place; on return
   *  we reload so the library thumbnails reflect the edit. */
  private openStampInEditor(s: Stamp): void {
    void openSpriteEditor({
      focusStamp: s.id,
      // The editor edits the SAME stamp object (shared engine/Stamps array) in
      // place and persists in the background, so just re-render the thumbnails on
      // return — no racy DB reload needed.
      onCancel: () => this.refreshLibrary(),
    });
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
    this.shell!.toast('Click a sector to make the room — drag for more. Esc to cancel.');
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

  private async createBlankRoom(
    tx: number,
    ty: number,
    wTiles: number,
    hTiles: number
  ): Promise<void> {
    const a = this.sectorAlign(Math.min(64, wTiles), Math.min(64, hTiles));
    const foot = this.brushFoot();
    const sector: SectorMeta = {
      tilesetId: foot?.tilesetId ?? this.palTs,
      paletteId: foot?.paletteId ?? this.palPal,
      musicId: 0,
      indoor: true,
      dungeon: false,
    } as SectorMeta;

    // Place the room where the user picked (sector-aligned), NOT in the band.
    // buildCustomRoomBand stamps a room's tiles at any bandX/bandY, so a room can
    // sit on top of an overworld sector — the ROM file is never touched, only the
    // runtime map (same override mechanism as Edit-map / map_tiles.json).
    const bandX = Math.floor(tx / SECTOR_TILES_X) * SECTOR_TILES_X;
    const bandY = Math.floor(ty / SECTOR_TILES_Y) * SECTOR_TILES_Y;
    const doc = (await loadOverride<CustomRoomsDoc>('rooms.json')) ?? { version: 1, rooms: [] };
    const room: CustomRoom = {
      id: `custom_${Date.now().toString(36)}`,
      label: `Room ${doc.rooms.length + 1}`,
      town: 'custom',
      type: 'custom',
      bandX,
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
    this.shell!.goTo(bandX * 32 + room.spawnDX, bandY * 32 + room.spawnDY);
    const secs = (a.w / SECTOR_TILES_X) * (a.h / SECTOR_TILES_Y);
    this.shell!.toast(
      `New ${secs}-sector room placed here — pick a brush and paint (double-click its name to rename)`
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

    // ── LAYERS: persistent show/hide for each painted layer, independent of the
    // active tool — so you can see walls + front overlaid while painting tiles.
    // Sits above TOOL; all off by default so a fresh room reads clean. ──
    this.panel.appendChild(this.mkSection('LAYERS — show/hide overlays'));
    const layerRow = document.createElement('div');
    layerRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    const mkLayer = (label: string, key: 'walls' | 'front' | 'back' | 'pri', tip: string) => {
      const b = this.mkBtn(label, () => this.toggleLayer(key), layerRow);
      b.dataset.layer = key;
      b.title = tip;
      this.layerBtns[key] = b;
    };
    mkLayer('🧱 Walls', 'walls', 'Show/hide the wall (collision) overlay — red.');
    mkLayer('🌳 Front', 'front', 'Show/hide the front (hide-behind) overlay — light blue.');
    mkLayer('🔻 Back', 'back', 'Show/hide the background (always-on-top) overlay — red / orange.');
    mkLayer('▦ Priority', 'pri', 'Show/hide native ROM priority bits — blue / purple.');
    this.panel.appendChild(layerRow);

    // ── TOOL: the single "what does clicking do?" selector ──
    this.panel.appendChild(this.mkSection('TOOL — what clicking does'));
    const toolRow = document.createElement('div');
    toolRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    const mkTool = (label: string, tool: RoomTool, tip: string) => {
      const b = this.mkBtn(label, () => this.setTool(tool), toolRow);
      b.dataset.tool = tool;
      b.title = tip;
    };
    mkTool('▣ Select', 'select', 'Click a room to select it; drag its corner handles to resize.');
    mkTool('🖌 Paint', 'paint', 'Draw tiles into rooms or onto the map with the brush.');
    mkTool('🧱 Walls', 'walls', 'Paint where you can and cannot walk.');
    mkTool('🌳 Front', 'front', 'Paint tiles you hide BEHIND (trees, roofs, signs).');
    mkTool('🔻 Back', 'back', 'Paint tiles entities always draw ON TOP of (rugs, low decals).');
    this.panel.appendChild(toolRow);

    this.toolHelp = document.createElement('div');
    this.toolHelp.style.cssText = 'color:#7fa8c0;font-size:10px;line-height:1.4;min-height:26px;';
    this.panel.appendChild(this.toolHelp);

    // Collision controls (Walls/Front) — shown only in those tools.
    this.colControls = document.createElement('div');
    this.colControls.style.cssText = 'display:none;flex-direction:column;gap:6px;';
    // Block / Clear segment (Walls tool only).
    this.wallsSeg = document.createElement('div');
    this.wallsSeg.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;';
    const blk = this.mkBtn('Block', () => this.setWallsErase(false), this.wallsSeg);
    blk.dataset.wall = 'block';
    blk.title = 'Paint walls that block movement.';
    const clr = this.mkBtn('Clear', () => this.setWallsErase(true), this.wallsSeg);
    clr.dataset.wall = 'clear';
    clr.title = 'Remove walls so you can walk here.';
    this.colControls.appendChild(this.wallsSeg);

    // Place / Erase segment (Front tool only) — mirrors Walls Block/Clear so a
    // painted front tile can be erased instead of relying on a toggle gesture.
    this.fgSeg = document.createElement('div');
    this.fgSeg.style.cssText = 'display:none;gap:4px;align-items:center;flex-wrap:wrap;';
    const fgPlace = this.mkBtn('Place', () => this.setFrontErase(false), this.fgSeg);
    fgPlace.dataset.fg = 'place';
    fgPlace.title = 'Paint front tiles you hide behind.';
    const fgErase = this.mkBtn('Erase', () => this.setFrontErase(true), this.fgSeg);
    fgErase.dataset.fg = 'erase';
    fgErase.title = 'Remove front tiles so they no longer cover players.';
    this.colControls.appendChild(this.fgSeg);

    // Place / Erase segment (Back tool only) — mirrors Front so a painted
    // background (on-top) tile can be erased explicitly.
    this.bgSeg = document.createElement('div');
    this.bgSeg.style.cssText = 'display:none;gap:4px;align-items:center;flex-wrap:wrap;';
    const bgPlace = this.mkBtn('Place', () => this.setBackErase(false), this.bgSeg);
    bgPlace.dataset.bg = 'place';
    bgPlace.title = 'Paint tiles entities always draw on top of.';
    const bgErase = this.mkBtn('Erase', () => this.setBackErase(true), this.bgSeg);
    bgErase.dataset.bg = 'erase';
    bgErase.title = 'Remove background tiles so native priority applies again.';
    this.colControls.appendChild(this.bgSeg);

    const cRow = document.createElement('div');
    cRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
    this.mkBtn('Brush size', () => this.cycleColBrush(), cRow).title =
      'Cycle brush size 1→2→4 cells (8px each).';
    const advBtn = this.mkBtn(
      'Advanced ▸',
      () => {
        this.advOpen = !this.advOpen;
        this.syncTool();
      },
      cRow
    );
    advBtn.dataset.adv = '1';
    advBtn.title = 'Native ROM priority bits, walkable preview, and room verifier (rarely needed).';
    this.colControls.appendChild(cRow);

    this.advEl = document.createElement('div');
    this.advEl.style.cssText =
      'display:none;flex-direction:column;gap:4px;border-top:1px solid #243;padding-top:6px;';
    const advRow = document.createElement('div');
    advRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    const mkAdv = (label: string, mode: CollisionOp, tip: string) => {
      const b = this.mkBtn(label, () => this.setMode(mode), advRow);
      b.dataset.mode = mode;
      b.title = tip;
    };
    mkAdv(
      'Pri-lo',
      'prilo',
      'Native 0x01 — lower half behind FG (only bites where ROM has FG art).'
    );
    mkAdv(
      'Pri-hi',
      'prihi',
      'Native 0x02 — whole body behind FG (only bites where ROM has FG art).'
    );
    mkAdv('Wipe cell', 'clear', 'Wipe the cell back to 0 (all bits).');
    this.mkBtn(
      'Show walkable',
      () => collisionPaint.refreshRoomPreview(this.colHover),
      advRow
    ).title = 'Preview the room-crop (cyan = walkable cells) at the cursor.';
    this.mkBtn('Verify rooms', () => void this.runColVerify(), advRow).title =
      'Run the room-crop verifier against painted collision (takes a minute).';
    this.advEl.appendChild(advRow);
    this.advOut = document.createElement('pre');
    this.advOut.style.cssText =
      'display:none;max-height:160px;overflow:auto;background:#0c1014;color:#9fb8cc;' +
      'font:10px monospace;padding:6px;border:1px solid #243;border-radius:3px;white-space:pre-wrap;';
    this.advEl.appendChild(this.advOut);
    this.colControls.appendChild(this.advEl);
    this.panel.appendChild(this.colControls);

    // ── BRUSH section (Paint tool only) ── lives in its OWN floating window so the
    // palette can sit next to the room you're painting. brushBox is that window's
    // content; the docked panel keeps LAYERS / TOOL / ROOMS.
    this.brushHeader = this.mkSection('BRUSH'); // kept for syncTool; the float titles itself
    const brushBox = document.createElement('div');
    brushBox.style.cssText =
      'width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;';

    // tab row + brush swatch + erase
    const top = document.createElement('div');
    this.brushTop = top;
    top.style.cssText = 'display:flex;align-items:center;gap:6px;';
    this.tabTilesBtn = this.mkBtn('Tiles', () => this.setTab('tiles'), top);
    this.tabTilesBtn.title = 'Brush from a single tileset arrangement picked in the palette grid.';
    this.tabStampsBtn = this.mkBtn('Stamps', () => this.setTab('stamps'), top);
    this.tabStampsBtn.title = 'Brush from a saved multi-tile stamp sampled from the world.';
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
    brushBox.appendChild(top);

    // Tiles pane: palette steppers + atlas grid
    this.tilesPane = document.createElement('div');
    this.tilesPane.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const palBar = document.createElement('div');
    palBar.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;';
    this.mkMini('ts−', () => this.stepPalette('ts', -1), palBar).title =
      'Previous tileset for the palette grid.';
    this.mkMini('ts+', () => this.stepPalette('ts', 1), palBar).title =
      'Next tileset for the palette grid.';
    this.mkMini('pal−', () => this.stepPalette('pal', -1), palBar).title =
      'Previous palette for the current tileset.';
    this.mkMini('pal+', () => this.stepPalette('pal', 1), palBar).title =
      'Next palette for the current tileset.';
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
    brushBox.appendChild(this.tilesPane);

    // Stamps pane: capture buttons + library
    this.stampsPane = document.createElement('div');
    this.stampsPane.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const sampRow = document.createElement('div');
    sampRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn('Sample 32', () => this.startSample(false), sampRow, true).title =
      'Sample whole tiles (32px)';
    this.mkBtn('Sample 8', () => this.startSample(true), sampRow, true).title =
      'Sample minitiles (8px — quarter-tile and finer)';
    this.mkBtn('→ Stamp', () => void this.saveStamp(), sampRow).title =
      'Save the sampled box as a reusable stamp brush.';
    this.mkBtn('→ Furniture', () => void this.saveFurniture(), sampRow).title =
      'Turn the sampled tiles into a movable, solid prop you place in the Placement editor';
    this.mkBtn('+ Folder', () => void this.createFolder(), sampRow).title =
      'Create a folder, then drag stamps into it';
    this.mkBtn('↻', () => void this.reloadData(), sampRow).title = 'Reload stamps from the DB';
    this.stampsPane.appendChild(sampRow);
    this.libraryEl = document.createElement('div');
    this.libraryEl.style.cssText =
      'display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;padding:2px;';
    this.stampsPane.appendChild(this.libraryEl);
    brushBox.appendChild(this.stampsPane);

    this.paintBtn = this.mkBtn('Paint: off', () => this.setPainting(!this.painting), brushBox);
    this.paintBtn.style.width = '100%';
    this.paintBtn.title =
      'Toggle paint mode — click/drag in a room to lay down the current brush (right-click/Esc stops).';

    // Edit-map toggle: when ON, the brush/erase/stamp paints onto ANY room's
    // tiles (overrides/map_tiles.json) instead of a custom band room — for
    // rearranging baked furniture & redecorating existing rooms.
    this.editMapBtn = this.mkBtn('Edit map: off', () => this.toggleEditMap(), brushBox);
    this.editMapBtn.style.width = '100%';
    this.editMapBtn.title =
      'Paint/erase/stamp directly onto ANY room (saves to map_tiles.json). Match the room tileset.';
    this.syncEditMapBtn();

    // The brush section is its own draggable/resizable window (shown only for the
    // Paint tool — see syncTool). Everything else stays in the docked panel.
    this.floatPanel = new FloatingPanel({
      id: 'room-builder-brush',
      title: 'BRUSH',
      initial: {
        x: Math.max(20, window.innerWidth - 380),
        y: 90,
        w: 340,
        h: Math.min(560, Math.round(window.innerHeight * 0.7)),
      },
      minW: 260,
      minH: 160,
    });
    this.floatPanel.body.appendChild(brushBox);

    // ── ROOMS section ──
    this.panel.appendChild(this.mkSection('ROOMS'));
    const roomRow = document.createElement('div');
    roomRow.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('+ New Room', () => this.startBlankRoom(), roomRow, true).title =
      'Click a sector to create a new room (drag across sectors for a bigger one). ' +
      'The room is built in the interiors band below the map.';
    this.mkBtn('Copy area', () => this.copyArea(), roomRow).title =
      'Copy sector(s) and paste them elsewhere: click, drag-select the source sector(s), ' +
      'then click a destination sector to stamp them down (repeat; Esc when done).';
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
    this.syncLayerBtns();
    this.setTool('select');
    this.updateBrushUi();
    void this.renderPalette();
  }

  private setTab(tab: 'tiles' | 'stamps'): void {
    this.brushTab = tab;
    this.syncTabs();
    if (tab === 'tiles') void this.renderPalette();
  }

  // ── layer visibility (persistent overlays) ─────────────────────────────────

  private toggleLayer(key: 'walls' | 'front' | 'back' | 'pri'): void {
    this.layerVis[key] = !this.layerVis[key];
    this.syncLayerBtns();
    this.shell?.toast(`${key} overlay ${this.layerVis[key] ? 'on' : 'off'}`);
  }

  private syncLayerBtns(): void {
    for (const key of ['walls', 'front', 'back', 'pri'] as const) {
      const b = this.layerBtns[key];
      if (!b) continue;
      const on = this.layerVis[key];
      b.style.background = on ? '#10303d' : '#1d2530';
      b.style.color = on ? '#4db6e8' : '#7a8a98';
      b.style.borderColor = on ? '#4db6e8' : '#3a4a5a';
    }
  }

  // ── tool selector (what clicking does) ─────────────────────────────────────

  /** Switch the active tool, configuring the paint state it implies. */
  private setTool(tool: RoomTool): void {
    this.tool = tool;
    this.selecting = false;
    this.pendingBlank = false;
    this.sel = null;
    this.copyPhase = 'off'; // leaving/entering any tool cancels an in-flight copy
    this.copyBuf = null;
    if (tool !== 'walls' && tool !== 'front' && tool !== 'back') this.advOpen = false;
    if (tool === 'select') {
      this.paintMode = 'tiles';
      this.setPainting(false);
    } else if (tool === 'paint') {
      this.paintMode = 'tiles';
      this.setPainting(!!this.brush || this.erasing);
    } else if (tool === 'walls') {
      this.paintMode = this.wallsErase ? 'walk' : 'solid';
      this.setPainting(false);
    } else if (tool === 'front') {
      this.paintMode = 'fg';
      this.setPainting(false);
    } else {
      this.paintMode = 'bg';
      this.setPainting(false);
    }
    this.syncTool();
    this.updateStatus();
  }

  /** Walls sub-toggle: Block adds walls (solid), Clear removes them (walk). */
  private setWallsErase(erase: boolean): void {
    this.wallsErase = erase;
    if (this.tool === 'walls') this.paintMode = erase ? 'walk' : 'solid';
    this.syncTool();
    this.updateStatus();
  }

  /** Front sub-toggle: Place sets the 0x40 front bit, Erase clears it. */
  private setFrontErase(erase: boolean): void {
    collisionPaint.fgErase = erase;
    this.syncTool();
    this.updateStatus();
  }

  /** Back sub-toggle: Place sets the 0x20 always-on-top bit, Erase clears it. */
  private setBackErase(erase: boolean): void {
    collisionPaint.bgErase = erase;
    this.syncTool();
    this.updateStatus();
  }

  /** Advanced collision op (native priority / wipe). Keeps the current tool. */
  private setMode(mode: CollisionOp): void {
    this.paintMode = mode;
    this.setPainting(false);
    this.syncTool();
    this.updateStatus();
  }

  private cycleColBrush(): void {
    collisionPaint.brush = collisionPaint.brush === 1 ? 2 : collisionPaint.brush === 2 ? 4 : 1;
    this.shell?.toast(`Brush: ${collisionPaint.brush}x${collisionPaint.brush} cells`);
  }

  private async runColVerify(): Promise<void> {
    if (!this.advOut) return;
    this.advOut.style.display = 'block';
    this.advOut.textContent = 'running rooms verifier (takes a minute)...';
    this.advOut.textContent = await collisionPaint.runVerifier();
  }

  private toolHelpText(): string {
    switch (this.tool) {
      case 'select':
        return 'Click a room to select it, drag its corner handles to resize. Build rooms below.';
      case 'paint':
        return 'Click/drag to paint the brush. Choose Tiles or Stamps, and where it lands.';
      case 'walls':
        return 'Paint where you can walk — yellow = wall (green if it also has a front copy). Block adds walls, Clear removes them.';
      case 'front':
        return 'Paint front tiles that cover players (trees, roofs, signs). Light blue = front. Place adds, Erase removes.';
      case 'back':
        return 'Paint background tiles entities always draw ON TOP of (rugs, low decals). Red = background, orange if also a wall. Place adds, Erase removes.';
    }
  }

  /** Reflect the active tool: show only its controls + highlight buttons. */
  private syncTool(): void {
    const showBrush = this.tool === 'paint';
    const showCol = this.tool === 'walls' || this.tool === 'front' || this.tool === 'back';
    // The brush window only appears for the Paint tool.
    if (this.floatPanel) this.floatPanel.el.style.display = showBrush ? 'flex' : 'none';
    if (this.brushHeader) this.brushHeader.style.display = showBrush ? 'block' : 'none';
    if (this.brushTop) this.brushTop.style.display = showBrush ? 'flex' : 'none';
    if (this.paintBtn) this.paintBtn.style.display = showBrush ? 'block' : 'none';
    if (this.editMapBtn) this.editMapBtn.style.display = showBrush ? 'block' : 'none';
    if (showBrush) this.syncTabs();
    else {
      if (this.tilesPane) this.tilesPane.style.display = 'none';
      if (this.stampsPane) this.stampsPane.style.display = 'none';
    }
    if (this.colControls) this.colControls.style.display = showCol ? 'flex' : 'none';
    if (this.wallsSeg) this.wallsSeg.style.display = this.tool === 'walls' ? 'flex' : 'none';
    if (this.fgSeg) this.fgSeg.style.display = this.tool === 'front' ? 'flex' : 'none';
    if (this.bgSeg) this.bgSeg.style.display = this.tool === 'back' ? 'flex' : 'none';
    if (this.advEl) this.advEl.style.display = showCol && this.advOpen ? 'flex' : 'none';

    // Highlight the active tool.
    this.panel?.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
      const on = b.dataset.tool === this.tool;
      b.style.background = on ? '#10303d' : '#1d2530';
      b.style.color = on ? '#4db6e8' : '#cde';
      b.style.borderColor = on ? '#4db6e8' : '#3a4a5a';
    });
    // Highlight Block/Clear by current erase state.
    this.panel?.querySelectorAll<HTMLButtonElement>('button[data-wall]').forEach((b) => {
      const on = (b.dataset.wall === 'clear') === this.wallsErase;
      b.style.color = on ? '#7CFC6A' : '#cde';
      b.style.borderColor = on ? '#7CFC6A' : '#3a4a5a';
    });
    // Highlight Front Place/Erase by current erase state.
    this.panel?.querySelectorAll<HTMLButtonElement>('button[data-fg]').forEach((b) => {
      const on = (b.dataset.fg === 'erase') === collisionPaint.fgErase;
      b.style.color = on ? '#7CFC6A' : '#cde';
      b.style.borderColor = on ? '#7CFC6A' : '#3a4a5a';
    });
    // Highlight Back Place/Erase by current erase state.
    this.panel?.querySelectorAll<HTMLButtonElement>('button[data-bg]').forEach((b) => {
      const on = (b.dataset.bg === 'erase') === collisionPaint.bgErase;
      b.style.color = on ? '#7CFC6A' : '#cde';
      b.style.borderColor = on ? '#7CFC6A' : '#3a4a5a';
    });
    // Highlight the active advanced op (if any) by paint mode.
    this.panel?.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) => {
      const on = b.dataset.mode === this.paintMode;
      b.style.color = on ? '#7CFC6A' : '#cde';
      b.style.borderColor = on ? '#7CFC6A' : '#3a4a5a';
    });
    const adv = this.panel?.querySelector<HTMLButtonElement>('button[data-adv]');
    if (adv) adv.textContent = this.advOpen ? 'Advanced ▾' : 'Advanced ▸';
    if (this.toolHelp) this.toolHelp.textContent = this.toolHelpText();
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
    if (this.paintMode !== 'tiles') {
      const m = this.paintMode;
      this.statusEl.textContent =
        m === 'solid'
          ? 'Walls — click/drag to add walls (yellow, green if also front).'
          : m === 'walk'
            ? 'Walls — click/drag to remove walls.'
            : m === 'fg'
              ? 'Front — click/drag to mark tiles you hide behind (light blue).'
              : m === 'bg'
                ? 'Back — click/drag to mark tiles entities draw on top of (red, orange if also a wall).'
                : `Advanced (${m}) — click/drag to paint.`;
      return;
    }
    if (this.copyPhase === 'select') {
      this.statusEl.textContent = this.sel
        ? `Copy: ${this.sel.w}x${this.sel.h} tiles — release to capture (snaps to sectors)`
        : 'Copy: drag to select the sector(s) to copy';
    } else if (this.copyPhase === 'paste') {
      const secs = this.copyBuf ? (this.copyBuf.mw / 32) * (this.copyBuf.mh / 16) : 0;
      this.statusEl.textContent = `Copied ${secs} sector(s) — click a sector to paste (Esc when done)`;
    } else if (this.pendingBlank) {
      if (this.sel) {
        const secs = (this.sel.w / SECTOR_TILES_X) * (this.sel.h / SECTOR_TILES_Y);
        this.statusEl.textContent = `New room — ${secs} sector${secs === 1 ? '' : 's'}, release to create`;
      } else {
        this.statusEl.textContent =
          'Click a sector to create the room (drag for more) — Esc to cancel';
      }
    } else if (this.selecting) {
      this.statusEl.textContent = this.sel
        ? `Selected ${this.sel.w}x${this.sel.h} — Sample→Stamp`
        : 'Drag a box on the map…';
    } else if (this.painting) {
      const where = this.editMap ? 'ANY room (map edit)' : 'a custom room';
      this.statusEl.textContent = this.erasing
        ? `Erasing — click/drag in ${where}`
        : `Painting — click/drag in ${where}`;
    } else if (this.resizing) {
      this.statusEl.textContent = `Resizing → ${this.resizing.w}x${this.resizing.h}`;
    } else if (this.selectedRoom()) {
      this.statusEl.textContent = `Selected "${this.selectedRoom()!.label}" — drag a corner handle to resize`;
    } else if (this.rooms.length === 0) {
      this.statusEl.textContent = 'Start with + New Room, then paint a brush in.';
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
    edit.title = 'Edit pixels in the Sprite Editor (clean up / erase background)';
    edit.style.cssText =
      'position:absolute;top:1px;left:3px;color:#9fe3a0;font-size:11px;cursor:pointer;';
    edit.onclick = (e) => {
      e.stopPropagation();
      this.openStampInEditor(s);
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
    return mkButton(label, fn, { parent, variant: accent ? 'gold' : 'default', pad: '4px 9px' });
  }

  private mkMini(label: string, fn: () => void, parent: HTMLElement): HTMLButtonElement {
    const b = this.mkBtn(label, fn, parent);
    b.style.padding = '2px 5px';
    return b;
  }
}

export const roomBuilderTool = new RoomBuilderTool();
