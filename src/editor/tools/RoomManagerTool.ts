import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { MAP_WIDTH_SECTORS, MAP_HEIGHT_SECTORS } from '../../types';
import {
  RoomDef,
  RoomType,
  SectorCoord,
  setRegionRooms,
  listRegionRooms,
  sectorOfPoint,
  sectorRect,
  SECTOR_W_PX,
  SECTOR_H_PX,
} from '../../engine/Rooms';
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

const BGM_NONE = '-1'; // sentinel in the song picker = inherit sector musicId

interface RoomsDoc {
  version?: number;
  rooms?: RoomDef[];
}

const secKey = (c: number, r: number): string => c + ',' + r;

class RoomManagerTool implements EditorTool {
  id = 'rooms';
  name = 'Room Manager';
  description = 'Author rooms: regions, name, type, per-room music, and type-specific props.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private rooms: RoomDef[] = [];
  private sel: RoomDef | null = null;
  private hover: WorldPoint = { x: 0, y: 0 };

  // Sector → owning room, rebuilt on every edit. Every sector belongs to exactly
  // one room (the partition invariant), so this is the authority for steal/erase.
  private owner = new Map<string, RoomDef>();

  // Paint gesture: a drag ADDS swept sectors to the active room; a plain click
  // TOGGLES the one sector. Sectors owned by another room are queued in `stolen`
  // and moved on a single confirm at the end of the gesture (steal-with-confirm).
  private painting = false;
  private dragMoved = false;
  private downSec: SectorCoord | null = null;
  private lastKey = '';
  private stolen = new Map<string, RoomDef>(); // sectorKey → previous owner (pending confirm)

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
    this.painting = false;
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
    this.pushLive(); // engine consumes the working set live + rebuild ownership
    this.refreshList();
    this.rebuildForm();
  }

  /** Guarantee a sectors[] exists. Legacy rect/region rooms are migrated to the
   *  sectors they cover, so the whole library becomes editable as the sector
   *  partition (regions[] is then re-derived from sectors by Rooms.ts). */
  private normalize(r: RoomDef): RoomDef {
    const sectors = r.sectors && r.sectors.length ? r.sectors : this.deriveSectors(r);
    return { ...r, sectors };
  }

  /** The set of whole sectors that an old rect-based room's geometry covers. */
  private deriveSectors(r: RoomDef): SectorCoord[] {
    const rects = r.regions && r.regions.length ? r.regions : r.rect ? [r.rect] : [];
    const out = new Map<string, SectorCoord>();
    for (const rc of rects) {
      const c0 = Math.floor(rc.x / SECTOR_W_PX);
      const c1 = Math.floor((rc.x + rc.w - 1) / SECTOR_W_PX);
      const r0 = Math.floor(rc.y / SECTOR_H_PX);
      const r1 = Math.floor((rc.y + rc.h - 1) / SECTOR_H_PX);
      for (let c = Math.max(0, c0); c <= c1; c++) {
        for (let row = Math.max(0, r0); row <= r1; row++) out.set(secKey(c, row), [c, row]);
      }
    }
    return [...out.values()];
  }

  // --- input -----------------------------------------------------------------

  onKey(key: string): boolean {
    if (key === 'n') {
      this.newRoom();
      return true;
    }
    if ((key === 'delete' || key === 'backspace') && this.sel) {
      this.deleteSelected();
      return true;
    }
    return false;
  }

  // A map gesture assigns sectors to the active room. We defer the actual edit to
  // mouse-up so a plain CLICK toggles one sector while a DRAG paints many.
  onMouseDown(p: WorldPoint): boolean {
    const sec = this.sectorAt(p);
    if (!sec) return false; // off-map → let the shell pan
    this.painting = true;
    this.dragMoved = false;
    this.downSec = sec;
    this.lastKey = secKey(sec[0], sec[1]);
    this.stolen = new Map();
    return true;
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (!this.painting || !dragging) return;
    const sec = this.sectorAt(p);
    if (!sec) return;
    if (!this.dragMoved) {
      this.dragMoved = true;
      if (this.downSec) this.paintAdd(this.downSec); // include the anchor sector
    }
    const k = secKey(sec[0], sec[1]);
    if (k === this.lastKey) return;
    this.lastKey = k;
    this.paintAdd(sec);
  }

  onMouseUp(): void {
    if (!this.painting) return;
    this.painting = false;
    if (!this.dragMoved && this.downSec) {
      this.clickSector(this.downSec); // plain click → toggle one sector
    } else {
      this.finalizeSteals(); // drag → commit live adds + confirm any steals once
    }
    this.downSec = null;
    this.lastKey = '';
  }

  /** The in-bounds sector (col,row) under a world point, or null off the map. */
  private sectorAt(p: WorldPoint): SectorCoord | null {
    const [c, r] = sectorOfPoint(p.x, p.y);
    if (c < 0 || r < 0 || c >= MAP_WIDTH_SECTORS || r >= MAP_HEIGHT_SECTORS) return null;
    return [c, r];
  }

  // --- sector membership (the one-sector-one-room partition) -----------------

  private addSector(room: RoomDef, [c, r]: SectorCoord): void {
    (room.sectors ??= []).push([c, r]);
    this.owner.set(secKey(c, r), room);
  }

  private removeSector(room: RoomDef, [c, r]: SectorCoord): void {
    const k = secKey(c, r);
    room.sectors = (room.sectors ?? []).filter(([a, b]) => a !== c || b !== r);
    if (this.owner.get(k) === room) this.owner.delete(k);
  }

  private stealSector(sec: SectorCoord, from: RoomDef): void {
    this.removeSector(from, sec);
    if (this.sel) this.addSector(this.sel, sec);
  }

  /** Drag paint: add-only. Unowned sectors land live; sectors owned by another
   *  room are queued in `stolen` for a single confirm at the end of the gesture. */
  private paintAdd(sec: SectorCoord): void {
    if (!this.sel) return;
    const k = secKey(sec[0], sec[1]);
    const own = this.owner.get(k);
    if (own === this.sel) return; // already mine
    if (own) {
      this.stolen.set(k, own);
      return;
    }
    this.addSector(this.sel, sec);
  }

  /** Plain click: toggle one sector against the active room (steal-with-confirm). */
  private clickSector(sec: SectorCoord): void {
    const k = secKey(sec[0], sec[1]);
    const own = this.owner.get(k) ?? null;
    if (!this.sel) {
      if (own) this.selectRoom(own);
      else this.shell?.toast('Pick or create a room first (N), then click sectors', true);
      return;
    }
    if (own === this.sel) {
      this.removeSector(this.sel, sec);
    } else if (own) {
      if (!confirm(`Move this sector from "${own.label}" into "${this.sel.label}"?`)) return;
      this.stealSector(sec, own);
    } else {
      this.addSector(this.sel, sec);
    }
    this.afterEdit();
  }

  /** End of a drag: confirm any queued steals once, then commit. */
  private finalizeSteals(): void {
    if (this.stolen.size && this.sel) {
      const names = [...new Set([...this.stolen.values()].map((r) => r.label))].join(', ');
      if (confirm(`Move ${this.stolen.size} sector(s) from ${names} into "${this.sel.label}"?`)) {
        for (const [k, own] of this.stolen) {
          const [c, r] = k.split(',').map(Number);
          this.stealSector([c, r], own);
        }
      }
    }
    this.stolen = new Map();
    this.afterEdit();
  }

  /** Commit an edit: rebuild ownership, live-push to the engine, refresh UI. */
  private afterEdit(): void {
    this.pushLive();
    this.refreshList();
    this.rebuildForm();
  }

  /** Push the working set into the engine + mark dirty (auto-save on the shell). */
  private pushLive(): void {
    setRegionRooms(this.rooms); // re-derives each room's regions[] from its sectors
    this.rebuildOwners();
    this.shell?.markDirty('rooms');
  }

  private rebuildOwners(): void {
    this.owner = new Map();
    for (const room of this.rooms) {
      for (const [c, r] of room.sectors ?? []) this.owner.set(secKey(c, r), room);
    }
  }

  private selectRoom(room: RoomDef): void {
    this.sel = room;
    this.refreshList();
    this.rebuildForm();
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

  private newRoom(): void {
    const room: RoomDef = {
      id: this.nextId(),
      label: this.nextLabel(),
      type: 'other',
      bgm: null,
      sectors: [],
    };
    this.rooms.push(room);
    this.selectRoom(room);
    this.shell?.toast('Click or drag sectors to assign them to this room');
  }

  private deleteSelected(): void {
    if (!this.sel) return;
    const i = this.rooms.indexOf(this.sel);
    if (i >= 0) this.rooms.splice(i, 1);
    this.sel = null;
    this.afterEdit();
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
    const showLabels = zoom >= 0.5;
    if (showLabels) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textAlign = 'left';
    }

    // Each room is its set of sectors — fill + outline every owned sector.
    for (let i = 0; i < this.rooms.length; i++) {
      const room = this.rooms[i];
      const on = room === this.sel;
      const hue = (i * 47) % 360;
      let labelDrawn = false;
      for (const [c, r] of room.sectors ?? []) {
        const rc = sectorRect(c, r);
        const sx = rc.x - camX,
          sy = rc.y - camY;
        if (sx + rc.w < 0 || sx > vw || sy + rc.h < 0 || sy > vh) continue;

        ctx.fillStyle = `hsla(${hue},70%,55%,${on ? 0.3 : 0.12})`;
        ctx.fillRect(sx, sy, rc.w, rc.h);

        ctx.lineWidth = lw * (on ? 2 : 1);
        if (on) {
          ctx.setLineDash([dash, dash]);
          ctx.lineDashOffset = -off;
          ctx.strokeStyle = '#ffffff';
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = `hsla(${hue},90%,72%,0.9)`;
        }
        ctx.strokeRect(sx, sy, rc.w, rc.h);
        ctx.setLineDash([]);

        if (showLabels && !labelDrawn) {
          labelDrawn = true;
          ctx.fillStyle = on ? '#fff' : `hsla(${hue},85%,82%,1)`;
          const tag = room.type && room.type !== 'other' ? `[${room.type}] ` : '';
          ctx.fillText(`${tag}${room.label}`, sx + 3 * lw, sy + fontPx + lw);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Hover: outline the sector under the cursor (where a click/drag would assign).
    const sec = this.sectorAt(this.hover);
    if (sec) {
      const rc = sectorRect(sec[0], sec[1]);
      ctx.lineWidth = lw * 1.5;
      ctx.strokeStyle = this.sel ? 'rgba(120,220,255,0.95)' : 'rgba(255,255,255,0.6)';
      ctx.strokeRect(rc.x - camX, rc.y - camY, rc.w, rc.h);
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
      () => this.newRoom(),
      actions,
      false,
      'Create an empty room, then click/drag sectors to assign them to it (shortcut: N).'
    );
    this.panel.appendChild(actions);

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
      'click/drag sectors to assign · click an owned sector to remove · Del deletes room · auto-saves';
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
        const s = room.sectors?.[0];
        if (s)
          this.shell?.goTo(
            s[0] * SECTOR_W_PX + SECTOR_W_PX / 2,
            s[1] * SECTOR_H_PX + SECTOR_H_PX / 2
          );
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
      e.textContent = 'Select a room, or press N to create one.';
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

    // Sector membership readout (geometry IS the selected sectors — paint on map).
    const secRow = this.mkRow(
      form,
      'sectors',
      'How many map sectors make up this room. Click/drag sectors on the map to add; click an owned sector to remove.'
    );
    const secSpan = document.createElement('span');
    secSpan.textContent = `${room.sectors?.length ?? 0} sector(s)`;
    secSpan.style.cssText = 'color:#9fb8cc;';
    secRow.appendChild(secSpan);

    this.mkBtn(
      'Delete room',
      () => this.deleteSelected(),
      form,
      false,
      'Delete this room (frees all its sectors).'
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
