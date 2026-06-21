import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { TILE_SIZE } from '../../types';
import { RoomDef, RoomRect, RoomType, setRegionRooms, listRegionRooms } from '../../engine/Rooms';
import { previewSong, stopMusic, setMusicMuted, setSfxMuted } from '../../engine/MusicManager';
import { getSongName, songLabel, listSongs } from '../../engine/SongNames';
import { createSpritePicker, SpritePicker } from '../../engine/SpritePicker';
import { loadWorldDoc, saveWorldDoc } from '../../engine/Auth';
import { registerSaveHandler } from '../registry';

// Room Manager (ROOM_SYSTEM.md, Phase 2). The parity-with-Sound-Manager tool: it
// edits REGION ROOMS — identity + typed props painted over the existing map (the
// 505 bgm zones seeded from the music areas, plus authored ROM interiors/shops).
// A room owns a stable id, one or more region rects, a name, a type, a per-room
// `bgm`, and type-specific props (shop storeId, hotel cost, …). Rooms live in the
// DB 'rooms' world doc; edits live-push via setRegionRooms (no reboot) and the
// running game's music/crop/behaviors consume them immediately.
//
// Scope: this edits REGION rooms. Custom rooms (RoomBuilder's interiors band) keep
// their geometry there and are not shown here yet — re-typing them via this
// overlay is a deferred follow-up (see ROOM_SYSTEM.md → Reconciliation).

const ROOM_TYPES: RoomType[] = [
  'overworld',
  'shop',
  'hospital',
  'hotel',
  'house',
  'bedroom',
  'dungeon',
  'other',
];

const MIN_DRAG = TILE_SIZE; // reject accidental click/micro-drags
const BGM_NONE = '-1'; // sentinel in the song picker = inherit sector musicId

interface RoomsDoc {
  version?: number;
  rooms?: RoomDef[];
}

function snapTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

class RoomManagerTool implements EditorTool {
  id = 'rooms';
  name = 'Room Manager';
  description = 'Author rooms: regions, name, type, per-room music, and type-specific props.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private rooms: RoomDef[] = [];
  private sel: RoomDef | null = null;
  private selRegion = 0; // index into sel.regions of the rect being edited
  private snap = true;

  // Drawing a new rect (after "New room" / "New region"): anchor + corner in px.
  private placing = false;
  private placingMode: 'room' | 'region' = 'room';
  private drawing = false;
  private ax = 0;
  private ay = 0;
  private hover: WorldPoint = { x: 0, y: 0 };

  // Moving the active region: pointer + region origin at drag start.
  private moving = false;
  private mx = 0;
  private my = 0;
  private ox = 0;
  private oy = 0;

  // Resizing the active region by a corner handle (opposite corner = anchor).
  private resizing = false;
  private anchorX = 0;
  private anchorY = 0;

  private tick = 0;

  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private bgmPicker: SpritePicker | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    // Rooms already drive runtime music, so we DON'T flip authoring mode — we just
    // unmute so bgm Test/preview is audible (other tools edit in silence).
    setMusicMuted(false);
    setSfxMuted(false);
    registerSaveHandler('rooms', () => this.save());
    this.buildPanel();
    this.refreshList();
    this.rebuildForm();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    stopMusic();
    setMusicMuted(true);
    setSfxMuted(true);
    this.panel?.remove();
    this.panel = null;
    this.placing = this.drawing = this.moving = this.resizing = false;
    this.sel = null;
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      const doc = await loadWorldDoc<RoomsDoc>('rooms');
      this.rooms = (doc?.rooms ?? []).map((r) => this.normalize(r));
    } catch (e) {
      // Fall back to whatever the engine already has registered.
      this.rooms = listRegionRooms().map((r) => this.normalize(r));
      this.shell?.toast(`Couldn't load rooms doc: ${e}`, true);
    }
    setRegionRooms(this.rooms); // engine consumes the working set live
    this.refreshList();
    this.rebuildForm();
  }

  /** Guarantee a regions[] exists (migrate a stray single rect into it). */
  private normalize(r: RoomDef): RoomDef {
    const regions = r.regions && r.regions.length ? r.regions : r.rect ? [r.rect] : [];
    return { ...r, regions };
  }

  // --- input -----------------------------------------------------------------

  onKey(key: string): boolean {
    if (key === 'n') {
      this.startPlacing('room');
      return true;
    }
    if ((key === 'delete' || key === 'backspace') && this.sel) {
      this.deleteSelected();
      return true;
    }
    return false;
  }

  onMouseDown(p: WorldPoint): boolean {
    if (this.placing) {
      this.ax = p.x;
      this.ay = p.y;
      this.drawing = true;
      return true;
    }

    const grab = this.handleRadius();
    // Grab a corner handle on the selected room's regions to resize.
    if (this.sel) {
      const ri = this.regionCornerOf(this.sel, p, grab);
      if (ri) {
        this.selRegion = ri.region;
        this.resizing = true;
        const [ax, ay] = this.oppositeCorner(this.sel.regions![ri.region], ri.corner);
        this.anchorX = ax;
        this.anchorY = ay;
        return true;
      }
    }

    // Otherwise pick a room body to select + move that region.
    const hit = this.pickAt(p);
    if (hit) {
      this.sel = hit.room;
      this.selRegion = hit.region;
      const rc = hit.room.regions![hit.region];
      this.moving = true;
      this.mx = p.x;
      this.my = p.y;
      this.ox = rc.x;
      this.oy = rc.y;
      this.refreshList();
      this.rebuildForm();
      return true;
    }
    return false; // let the shell pan
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (this.drawing) return;
    const rc = this.activeRegion();
    if (this.resizing && dragging && rc) {
      const r = this.normRect(this.anchorX, this.anchorY, p.x, p.y, false);
      rc.x = r.x;
      rc.y = r.y;
      rc.w = r.w;
      rc.h = r.h;
      this.pushLive();
      this.syncForm();
      return;
    }
    if (this.moving && dragging && rc) {
      rc.x = this.ox + (p.x - this.mx);
      rc.y = this.oy + (p.y - this.my);
      this.pushLive();
      this.syncForm();
    }
  }

  onMouseUp(p: WorldPoint): void {
    if (this.drawing) {
      this.drawing = false;
      this.placing = false;
      const rect = this.normRect(this.ax, this.ay, p.x, p.y);
      if (rect.w >= MIN_DRAG && rect.h >= MIN_DRAG) {
        if (this.placingMode === 'region' && this.sel) {
          this.sel.regions!.push(rect);
          this.selRegion = this.sel.regions!.length - 1;
        } else {
          const room: RoomDef = {
            id: this.nextId(),
            label: this.nextLabel(),
            type: 'other',
            bgm: null,
            regions: [rect],
          };
          this.rooms.push(room);
          this.sel = room;
          this.selRegion = 0;
        }
        this.pushLive();
        this.refreshList();
        this.rebuildForm();
      } else {
        this.shell?.toast('Too small — drag a box', true);
      }
      return;
    }
    if ((this.moving || this.resizing) && this.activeRegion()) {
      this.snapRegion(this.activeRegion()!);
      this.pushLive();
      this.rebuildForm();
    }
    this.moving = false;
    this.resizing = false;
  }

  private activeRegion(): RoomRect | null {
    return this.sel?.regions?.[this.selRegion] ?? null;
  }

  private snapRegion(rc: RoomRect): void {
    if (!this.snap) return;
    const x2 = snapTo(rc.x + rc.w, TILE_SIZE);
    const y2 = snapTo(rc.y + rc.h, TILE_SIZE);
    rc.x = snapTo(rc.x, TILE_SIZE);
    rc.y = snapTo(rc.y, TILE_SIZE);
    rc.w = Math.max(TILE_SIZE, x2 - rc.x);
    rc.h = Math.max(TILE_SIZE, y2 - rc.y);
  }

  /** Push the working set into the engine + mark dirty (auto-save on the shell). */
  private pushLive(): void {
    setRegionRooms(this.rooms);
    this.shell?.markDirty('rooms');
  }

  // --- corner-handle hit testing --------------------------------------------

  private handleRadius(): number {
    const zoom = this.shell?.context.camera.zoom ?? 1;
    return 8 / zoom;
  }

  private corners(rc: RoomRect): [number, number][] {
    return [
      [rc.x, rc.y],
      [rc.x + rc.w, rc.y],
      [rc.x, rc.y + rc.h],
      [rc.x + rc.w, rc.y + rc.h],
    ];
  }

  private cornerOf(rc: RoomRect, p: WorldPoint, r: number): number {
    const cs = this.corners(rc);
    for (let c = 0; c < 4; c++) {
      if (Math.abs(p.x - cs[c][0]) <= r && Math.abs(p.y - cs[c][1]) <= r) return c;
    }
    return -1;
  }

  /** A corner of any region of `room` near `p`. */
  private regionCornerOf(
    room: RoomDef,
    p: WorldPoint,
    r: number
  ): { region: number; corner: number } | null {
    const regions = room.regions ?? [];
    for (let i = regions.length - 1; i >= 0; i--) {
      const c = this.cornerOf(regions[i], p, r);
      if (c >= 0) return { region: i, corner: c };
    }
    return null;
  }

  private oppositeCorner(rc: RoomRect, corner: number): [number, number] {
    return this.corners(rc)[3 - corner];
  }

  private normRect(x0: number, y0: number, x1: number, y1: number, snap = this.snap): RoomRect {
    let x = Math.min(x0, x1),
      y = Math.min(y0, y1);
    let w = Math.abs(x1 - x0),
      h = Math.abs(y1 - y0);
    if (snap) {
      const x2 = snapTo(x + w, TILE_SIZE),
        y2 = snapTo(y + h, TILE_SIZE);
      x = snapTo(x, TILE_SIZE);
      y = snapTo(y, TILE_SIZE);
      w = Math.max(TILE_SIZE, x2 - x);
      h = Math.max(TILE_SIZE, y2 - y);
    }
    return { x, y, w, h };
  }

  /** Topmost room+region containing `p` (most-specific/smallest region wins). */
  private pickAt(p: WorldPoint): { room: RoomDef; region: number } | null {
    let best: { room: RoomDef; region: number } | null = null;
    let bestArea = Infinity;
    for (const room of this.rooms) {
      const regions = room.regions ?? [];
      for (let i = 0; i < regions.length; i++) {
        const rc = regions[i];
        if (p.x >= rc.x && p.x < rc.x + rc.w && p.y >= rc.y && p.y < rc.y + rc.h) {
          const a = rc.w * rc.h;
          if (a < bestArea) {
            bestArea = a;
            best = { room, region: i };
          }
        }
      }
    }
    return best;
  }

  private nextId(): string {
    let n = this.rooms.length + 1;
    const taken = new Set(this.rooms.map((r) => r.id));
    while (taken.has(`room_${n}`)) n++;
    return `room_${n}`;
  }

  private nextLabel(): string {
    return `Room ${this.rooms.length + 1}`;
  }

  private startPlacing(mode: 'room' | 'region'): void {
    if (mode === 'region' && !this.sel) {
      this.shell?.toast('Select a room first to add a region', true);
      return;
    }
    this.placing = true;
    this.placingMode = mode;
    this.shell?.toast(
      mode === 'region'
        ? 'Drag a box to add a region to this room'
        : 'Drag a box to make a new room'
    );
  }

  private deleteSelected(): void {
    if (!this.sel) return;
    const regions = this.sel.regions ?? [];
    // If the room has multiple regions, delete just the active one; otherwise the room.
    if (regions.length > 1) {
      regions.splice(this.selRegion, 1);
      this.selRegion = 0;
    } else {
      const i = this.rooms.indexOf(this.sel);
      if (i >= 0) this.rooms.splice(i, 1);
      this.sel = null;
    }
    this.pushLive();
    this.refreshList();
    this.rebuildForm();
  }

  // --- overlay ---------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    const zoom = camera.zoom || 1;
    const lw = 1 / zoom;
    const fontPx = Math.max(7, Math.round(9 / zoom));
    const vw = camera.viewW,
      vh = camera.viewH;

    this.tick++;
    const dash = 5 * lw;
    const off = (this.tick * 0.4 * lw) % (dash * 2);
    const fancyBorders = zoom >= 0.3;
    const showLabels = zoom >= 0.5;
    if (showLabels) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textAlign = 'left';
    }

    for (let i = 0; i < this.rooms.length; i++) {
      const room = this.rooms[i];
      const on = room === this.sel;
      const hue = (i * 47) % 360;
      const regions = room.regions ?? [];
      for (const rc of regions) {
        const sx = rc.x - camX,
          sy = rc.y - camY;
        if (sx + rc.w < 0 || sx > vw || sy + rc.h < 0 || sy > vh) continue;

        ctx.fillStyle = `hsla(${hue},70%,55%,${on ? 0.26 : 0.1})`;
        ctx.fillRect(sx, sy, rc.w, rc.h);

        if (fancyBorders || on) {
          ctx.setLineDash([]);
          ctx.lineWidth = lw * (on ? 3 : 2);
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.strokeRect(sx, sy, rc.w, rc.h);
          ctx.setLineDash([dash, dash]);
          ctx.lineDashOffset = -off;
          ctx.lineWidth = lw * (on ? 2 : 1);
          ctx.strokeStyle = on ? '#ffffff' : `hsla(${hue},90%,72%,1)`;
          ctx.strokeRect(sx, sy, rc.w, rc.h);
          ctx.setLineDash([]);
        } else {
          ctx.lineWidth = lw;
          ctx.strokeStyle = `hsla(${hue},90%,72%,1)`;
          ctx.strokeRect(sx, sy, rc.w, rc.h);
        }

        if (showLabels) {
          ctx.fillStyle = on ? '#fff' : `hsla(${hue},85%,82%,1)`;
          const tag = room.type && room.type !== 'other' ? `[${room.type}] ` : '';
          ctx.fillText(`${tag}${room.label}`, sx + 3 * lw, sy + fontPx + lw);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Corner handles on the active region of the selected room.
    const rc = this.activeRegion();
    if (rc) {
      const h = this.handleRadius();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#101418';
      ctx.lineWidth = lw;
      for (const [cx, cy] of this.corners(rc)) {
        ctx.fillRect(cx - camX - h, cy - camY - h, h * 2, h * 2);
        ctx.strokeRect(cx - camX - h, cy - camY - h, h * 2, h * 2);
      }
    }

    ctx.lineWidth = lw;
    if (this.drawing) {
      const r = this.normRect(this.ax, this.ay, this.hover.x, this.hover.y);
      ctx.strokeStyle = 'rgba(120,220,255,0.95)';
      ctx.setLineDash([5 * lw, 4 * lw]);
      ctx.strokeRect(r.x - camX, r.y - camY, r.w, r.h);
      ctx.setLineDash([]);
    }
  }

  // --- panel -----------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #5ad0e8;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.textContent = 'ROOM MANAGER';
    title.style.cssText = 'color:#5ad0e8;font-weight:bold;letter-spacing:1px;flex:1;';
    header.appendChild(title);
    this.mkBtn('■ Stop', () => stopMusic(), header, true, 'Stop the music preview.');
    this.panel.appendChild(header);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn(
      '+ New room (N)',
      () => this.startPlacing('room'),
      actions,
      false,
      'Draw a box to create a new room (shortcut: N).'
    );
    this.mkBtn(
      '+ Region',
      () => this.startPlacing('region'),
      actions,
      false,
      'Draw another rect to add to the selected room (a room can span several regions).'
    );
    this.panel.appendChild(actions);

    const snapRow = document.createElement('label');
    snapRow.style.cssText = 'display:flex;align-items:center;gap:6px;color:#9fb8cc;font-size:11px;';
    snapRow.title = 'On = snap new/edited region rects to the 32px tile grid.';
    const snapCb = document.createElement('input');
    snapCb.type = 'checkbox';
    snapCb.checked = this.snap;
    snapCb.title = 'On = snap new/edited region rects to the 32px tile grid.';
    snapCb.onchange = () => (this.snap = snapCb.checked);
    snapRow.append(snapCb, document.createTextNode('snap to tile grid (32px)'));
    this.panel.appendChild(snapRow);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.panel.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.panel.appendChild(this.formEl);

    const hint = document.createElement('div');
    hint.textContent =
      'drag center to move · corner to resize · Del removes region/room · edits auto-save';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.panel.appendChild(hint);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (this.rooms.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No rooms yet.';
      e.style.cssText = 'color:#667;';
      this.listEl.appendChild(e);
      return;
    }
    // Lightly group: typed rooms first, then the bgm-zone overworld rooms.
    const sorted = [...this.rooms].sort((a, b) => {
      const at = a.type === 'overworld' || !a.type ? 1 : 0;
      const bt = b.type === 'overworld' || !b.type ? 1 : 0;
      return at - bt;
    });
    for (const room of sorted) {
      const row = document.createElement('div');
      const on = room === this.sel;
      row.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (on ? 'background:#15282c;' : '');
      const tag = room.type && room.type !== 'other' ? `[${room.type}] ` : '';
      const label = document.createElement('span');
      label.textContent = `${tag}${room.label}`;
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.appendChild(label);
      row.onclick = () => {
        this.sel = room;
        this.selRegion = 0;
        const rc = room.regions?.[0];
        if (rc) this.shell?.goTo(rc.x + rc.w / 2, rc.y + rc.h / 2);
        this.refreshList();
        this.rebuildForm();
      };
      this.listEl.appendChild(row);
    }
  }

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    this.bgmPicker = null;
    if (!this.sel) {
      const e = document.createElement('div');
      e.textContent = 'Select or draw a room.';
      e.style.cssText = 'color:#667;';
      this.formEl.appendChild(e);
      return;
    }
    const room = this.sel;
    const form = this.formEl;

    const nameIn = this.mkInput(
      form,
      'name',
      (v) => {
        room.label = v || 'Room';
        this.pushLive();
        this.refreshList();
      },
      150,
      'Display name for this room (blank defaults to "Room").'
    );
    nameIn.value = room.label;

    const townIn = this.mkInput(
      form,
      'town',
      (v) => {
        room.town = v.trim() || undefined;
        this.pushLive();
      },
      120,
      'Optional town this room belongs to (blank = none).'
    );
    townIn.value = room.town ?? '';

    // Type dropdown — drives the conditional fields below.
    const typeRow = this.mkRow(
      form,
      'type',
      'Room kind; drives behavior and the type-specific fields shown below.'
    );
    const typeSel = document.createElement('select');
    typeSel.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;flex:1;';
    typeSel.title = 'Room kind; drives behavior and the type-specific fields shown below.';
    for (const t of ROOM_TYPES) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      if ((room.type ?? 'other') === t) o.selected = true;
      typeSel.appendChild(o);
    }
    typeSel.onchange = () => {
      room.type = typeSel.value as RoomType;
      this.pushLive();
      this.refreshList();
      this.rebuildForm(); // show/hide type-conditional fields
    };
    typeRow.appendChild(typeSel);

    // BGM picker (parity with the Sound Manager's song dropdown).
    const bgmRow = this.mkRow(
      form,
      'bgm',
      'Music for this room; "(inherit sector)" leaves the ROM sector musicId in charge.'
    );
    const picker = createSpritePicker({
      sections: [{ values: [BGM_NONE, ...listSongs().map((s) => String(s.song))] }],
      initial: room.bgm != null ? String(room.bgm) : BGM_NONE,
      labelFor: (v) => (v === BGM_NONE ? '(inherit sector)' : songLabel(Number(v))),
      searchPlaceholder: 'search song # or name…',
      onSelect: (v) => {
        room.bgm = v === BGM_NONE ? null : parseInt(v, 10) || 0;
        this.pushLive();
        if (room.bgm) previewSong(room.bgm);
      },
    });
    picker.el.style.flex = '1';
    picker.el.style.minWidth = '0';
    bgmRow.appendChild(picker.el);
    this.bgmPicker = picker;

    const audRow = this.mkRow(form, '');
    this.mkBtn(
      '▶ Test',
      () => room.bgm && previewSong(room.bgm),
      audRow,
      false,
      "Audition this room's bgm."
    );
    this.mkBtn('■ Stop', () => stopMusic(), audRow, false, 'Stop the music preview.');

    // Type-conditional props.
    this.buildTypeFields(form, room);

    // Active region geometry.
    const rc = this.activeRegion();
    if (rc) {
      const regCount = room.regions?.length ?? 1;
      const regLabel = this.mkRow(
        form,
        'region',
        "Which of this room's region rects is being edited (current / total)."
      );
      const span = document.createElement('span');
      span.textContent = `${this.selRegion + 1} / ${regCount}`;
      span.style.cssText = 'color:#9fb8cc;';
      regLabel.appendChild(span);
      this.numField(
        form,
        'x',
        () => rc.x,
        (n) => (rc.x = Math.round(n)),
        'Left edge of this region in world pixels.'
      );
      this.numField(
        form,
        'y',
        () => rc.y,
        (n) => (rc.y = Math.round(n)),
        'Top edge of this region in world pixels.'
      );
      this.numField(
        form,
        'w',
        () => rc.w,
        (n) => (rc.w = Math.max(TILE_SIZE, Math.round(n))),
        'Width in pixels (min one tile = 32px).'
      );
      this.numField(
        form,
        'h',
        () => rc.h,
        (n) => (rc.h = Math.max(TILE_SIZE, Math.round(n))),
        'Height in pixels (min one tile = 32px).'
      );
    }

    this.mkBtn(
      'Delete',
      () => this.deleteSelected(),
      form,
      false,
      'Delete the active region, or the whole room if it has only one region.'
    );
  }

  /** Render the fields that only matter for the room's current type. */
  private buildTypeFields(form: HTMLElement, room: RoomDef): void {
    switch (room.type) {
      case 'shop':
        this.numFieldOpt(
          form,
          'storeId',
          () => room.storeId,
          (n) => (room.storeId = n),
          'Shop catalog id this store sells from (blank = none).'
        );
        break;
      case 'hospital':
        this.numFieldOpt(
          form,
          'healCost',
          () => room.healCost,
          (n) => (room.healCost = n),
          'Money charged to fully heal here (blank = default).'
        );
        break;
      case 'hotel':
        this.numFieldOpt(
          form,
          'cost',
          () => room.cost,
          (n) => (room.cost = n),
          'Money charged for a stay (blank = default).'
        );
        this.numFieldOpt(
          form,
          'wakeBgm',
          () => room.wakeBgm,
          (n) => (room.wakeBgm = n),
          'Song id played on waking up (blank = none).'
        );
        this.numFieldOpt(
          form,
          'warp x',
          () => room.bedroomWarp?.x,
          (n) =>
            (room.bedroomWarp = { ...(room.bedroomWarp ?? { x: 0, y: 0, dir: 0 }), x: n ?? 0 }),
          'World-pixel X to warp the player to on check-in (blank = 0).'
        );
        this.numFieldOpt(
          form,
          'warp y',
          () => room.bedroomWarp?.y,
          (n) =>
            (room.bedroomWarp = { ...(room.bedroomWarp ?? { x: 0, y: 0, dir: 0 }), y: n ?? 0 }),
          'World-pixel Y to warp the player to on check-in (blank = 0).'
        );
        break;
      case 'bedroom': {
        const row = this.mkRow(
          form,
          'save pt',
          'On = sleeping here saves the game (a save point).'
        );
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!room.isSaveRoom;
        cb.title = 'On = sleeping here saves the game (a save point).';
        cb.onchange = () => {
          room.isSaveRoom = cb.checked;
          this.pushLive();
        };
        row.appendChild(cb);
        break;
      }
    }
  }

  // --- small DOM helpers -----------------------------------------------------

  private numField(
    form: HTMLElement,
    label: string,
    get: () => number,
    set: (n: number) => void,
    tip?: string
  ): void {
    const i = this.mkInput(
      form,
      label,
      (v) => {
        const n = parseFloat(v);
        if (Number.isNaN(n)) return;
        set(n);
        this.pushLive();
      },
      64,
      tip
    );
    i.value = String(get());
  }

  /** A numeric field whose value may be undefined (clears on blank). */
  private numFieldOpt(
    form: HTMLElement,
    label: string,
    get: () => number | undefined,
    set: (n: number | undefined) => void,
    tip?: string
  ): void {
    const i = this.mkInput(
      form,
      label,
      (v) => {
        const t = v.trim();
        if (t === '') {
          set(undefined);
        } else {
          const n = parseFloat(t);
          if (Number.isNaN(n)) return;
          set(n);
        }
        this.pushLive();
      },
      64,
      tip
    );
    const cur = get();
    i.value = cur == null ? '' : String(cur);
  }

  private syncForm(): void {
    // Keep the region x/y/w/h fields in step while dragging/resizing.
    const rc = this.activeRegion();
    if (!rc || !this.formEl) return;
    const inputs = this.formEl.querySelectorAll('input');
    // name(0), town(1), then type-conditional inputs are variable — so instead of
    // index math, refresh the whole form on drag end; live just rebuild lightly.
    // Cheap path: find the x/y/w/h inputs by their preceding label text.
    const rows = this.formEl.querySelectorAll('div');
    rows.forEach((row) => {
      const lbl = row.querySelector('span')?.textContent;
      const inp = row.querySelector('input') as HTMLInputElement | null;
      if (!inp) return;
      if (lbl === 'x') inp.value = String(Math.round(rc.x));
      else if (lbl === 'y') inp.value = String(Math.round(rc.y));
      else if (lbl === 'w') inp.value = String(Math.round(rc.w));
      else if (lbl === 'h') inp.value = String(Math.round(rc.h));
    });
    void inputs;
  }

  private async save(): Promise<void> {
    await saveWorldDoc('rooms', { version: 1, rooms: this.rooms });
    setRegionRooms(this.rooms);
    this.shell?.clearDirty('rooms');
    this.shell?.toast('Saved rooms — live here; other clients refresh to resync');
  }

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false,
    tip?: string
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#123338;color:#5ad0e8;border:1px solid #5ad0e8;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    if (tip) b.title = tip;
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  private mkRow(parent: HTMLElement, label: string, tip?: string): HTMLDivElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'width:52px;color:#9fb8cc;flex:none;' +
      (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    r.appendChild(l);
    parent.appendChild(r);
    return r;
  }

  private mkInput(
    parent: HTMLElement,
    label: string,
    onChange: (v: string) => void,
    width = 64,
    tip?: string
  ): HTMLInputElement {
    const r = this.mkRow(parent, label, tip);
    const i = document.createElement('input');
    i.style.cssText =
      `width:${width}px;font:11px monospace;background:#0c1014;color:#cde;` +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    if (tip) i.title = tip;
    i.onchange = () => onChange(i.value);
    r.appendChild(i);
    return i;
  }
}

export const roomManagerTool = new RoomManagerTool();
