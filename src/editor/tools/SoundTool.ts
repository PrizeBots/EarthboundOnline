import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { SECTOR_TILES_X, SECTOR_TILES_Y, TILE_SIZE } from '../../types';
import {
  MusicArea,
  setMusicAreas,
  setMusicAuthoring,
  previewSong,
  stopMusic,
  stopAllSounds,
  playSfx,
  setMusicMuted,
  setSfxMuted,
} from '../../engine/MusicManager';
import {
  SFX_EVENTS,
  listSfx,
  sfxLabel,
  getSfxEventMap,
  setSfxEventMap,
  getSfxVolumeMap,
  setSfxVolumeMap,
} from '../../engine/SfxEvents';
import {
  getSongName,
  songLabel,
  setSongNameOverride,
  getSongNameOverrides,
  listSongs,
} from '../../engine/SongNames';
import { createSpritePicker, SpritePicker } from '../../engine/SpritePicker';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';

// Sound Manager (EDITOR_TOOLS.md). EarthBound assigns music PER SECTOR, but the
// door-stitched open world leaves many sectors carrying the wrong (intro-state
// or neighbouring) musicId, so the wrong song plays in a lot of spots. This tool
// lets an admin draw rectangular trigger areas on the map and assign the song
// that should play inside each. Areas live in overrides/music.json (OUR data,
// shippable) and win over the ROM's per-sector lookup in MusicManager. They snap
// to the sector grid by default so they bake cleanly back to per-sector musicId
// on SNES.

// EB sectors are 8x4 tiles → 64x32 px. Snapping areas to this grid keeps them
// aligned to the native music unit.
const SECTOR_W = SECTOR_TILES_X * TILE_SIZE; // 256 (8 tiles * 32px)
const SECTOR_H = SECTOR_TILES_Y * TILE_SIZE; // 128 (4 tiles * 32px)
// Only reject accidental click/micro-drags. A real drag is snapped up to at
// least one sector (snapArea), so a small gap walled in by other areas can
// still be filled — no need to drag a box bigger than the space allows.
const MIN_DRAG = TILE_SIZE;

interface MusicFile {
  version?: number;
  areas?: MusicArea[];
}

function snapTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

class SoundTool implements EditorTool {
  id = 'sound';
  name = 'Sound Manager';
  description = 'Draw music trigger areas on the map and assign the song that plays inside.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private areas: MusicArea[] = [];
  private sel: MusicArea | null = null;
  private snap = true;

  // Drawing a new rect (after "New area"): anchor + current corner in world px.
  private placing = false;
  private drawing = false;
  private ax = 0;
  private ay = 0;
  private hover: WorldPoint = { x: 0, y: 0 };

  // Moving an existing area: pointer + area origin at drag start.
  private moving = false;
  private mx = 0;
  private my = 0;
  private ox = 0;
  private oy = 0;

  // Resizing an area by a corner handle: the OPPOSITE corner is the fixed
  // anchor, so the rect is just normRect(anchor, pointer) as the mouse moves.
  private resizing = false;
  private anchorX = 0;
  private anchorY = 0;

  private tick = 0; // advances per draw to scroll the marching-ants marquee

  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;

  // Music | SFX tab. The Music tab is the map-area editor (below); the SFX tab
  // is the event→sound assignment list (test + reassign + stop-all).
  private mode: 'music' | 'sfx' = 'music';
  private musicBody: HTMLDivElement | null = null;
  private sfxBody: HTMLDivElement | null = null;
  private tabBtns: Record<'music' | 'sfx', HTMLButtonElement | null> = { music: null, sfx: null };
  // Working copy of the event→sfx map (merged defaults+overrides). Edits mutate
  // this and persist to overrides/sfx_events.json via the 'sfx_events' handler.
  private sfxMap: Record<string, string> = {};
  // Working copy of the per-event playback volume (0..1, default 1). Saved in the
  // same overrides/sfx_events.json under `volumes`.
  private sfxVolumes: Record<string, number> = {};

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    // The editor mutes music AND sfx on entry (so other tools edit in silence);
    // the Sound Manager is the exception — unmute both so Test/auditioning is
    // audible. deactivate() restores the editor's edit-in-silence state.
    setMusicMuted(false);
    setSfxMuted(false);
    setMusicAuthoring(true); // music areas drive preview while this tool is open
    registerSaveHandler('music', () => this.save());
    registerSaveHandler('sfx_events', () => this.saveSfx());
    this.sfxMap = getSfxEventMap(); // defaults + any loaded overrides
    this.sfxVolumes = getSfxVolumeMap(); // per-event volume (defaults to full)
    this.buildPanel();
    this.refreshList();
    this.rebuildForm();
    this.refreshSfxList();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    stopAllSounds(); // drop any music/sfx preview before leaving the tool
    setMusicAuthoring(false); // hand bgm resolution back to rooms
    setMusicMuted(true); // restore the editor's edit-in-silence state
    setSfxMuted(true);
    this.panel?.remove();
    this.panel = null;
    this.placing = this.drawing = this.moving = this.resizing = false;
    this.sel = null;
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      const cfg = await loadOverride<MusicFile>('music.json');
      this.areas = (cfg?.areas ?? []).map((a) => ({
        name: a.name ?? 'area',
        x: a.x ?? 0,
        y: a.y ?? 0,
        w: a.w ?? SECTOR_W,
        h: a.h ?? SECTOR_H,
        song: a.song ?? 0,
      }));
    } catch (e) {
      this.shell?.toast(`Couldn't load music areas: ${e}`, true);
      return;
    }
    setMusicAreas(this.areas); // push working set so the authoring preview resolves
    this.refreshList();
    this.rebuildForm();
  }

  // --- save ------------------------------------------------------------------

  private async save(): Promise<void> {
    const file: MusicFile = {
      version: 1,
      areas: this.areas.map((a) => ({
        name: a.name,
        x: Math.round(a.x),
        y: Math.round(a.y),
        w: Math.round(a.w),
        h: Math.round(a.h),
        song: a.song,
      })),
    };
    await saveOverride('music.json', file);
    setMusicAreas(file.areas!); // live in this client immediately
    this.shell?.clearDirty('music');
    this.shell?.toast('Saved music areas — live here; other clients refresh to resync');
  }

  // --- input -----------------------------------------------------------------

  onKey(key: string): boolean {
    if (key === 'n') {
      this.startPlacing();
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

    // Grab a corner handle to resize. The selected area wins (its handles sit on
    // top), then any area's corner, so you can size a zone without selecting it first.
    const grab = this.handleRadius();
    let corner = this.sel ? this.cornerOf(this.sel, p, grab) : -1;
    let target: MusicArea | null = this.sel;
    if (corner < 0) {
      const found = this.cornerAtAny(p, grab);
      if (found) {
        target = found.area;
        corner = found.corner;
      }
    }
    if (corner >= 0 && target) {
      this.sel = target;
      this.resizing = true;
      const [ax, ay] = this.oppositeCorner(target, corner);
      this.anchorX = ax;
      this.anchorY = ay;
      this.refreshList();
      this.rebuildForm();
      return true;
    }

    // Otherwise grab the body to move (drag by the center).
    const hit = this.pickAt(p);
    if (hit) {
      this.sel = hit;
      this.moving = true;
      this.mx = p.x;
      this.my = p.y;
      this.ox = hit.x;
      this.oy = hit.y;
      this.refreshList();
      this.rebuildForm();
      return true;
    }
    return false; // let the shell pan
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (this.drawing) return; // rect tracked from anchor → hover in the overlay
    // Move/resize follow the cursor FREELY while dragging — snapping live would
    // round sub-sector drags back to the start, so the box looked frozen. We snap
    // to the sector grid once, on mouse-up (onMouseUp → snapArea).
    if (this.resizing && dragging && this.sel) {
      const r = this.normRect(this.anchorX, this.anchorY, p.x, p.y, false);
      this.sel.x = r.x;
      this.sel.y = r.y;
      this.sel.w = r.w;
      this.sel.h = r.h;
      this.shell?.markDirty('music');
      this.syncForm();
      return;
    }
    if (this.moving && dragging && this.sel) {
      this.sel.x = this.ox + (p.x - this.mx);
      this.sel.y = this.oy + (p.y - this.my);
      this.shell?.markDirty('music');
      this.syncForm();
    }
  }

  onMouseUp(p: WorldPoint): void {
    if (this.drawing) {
      this.drawing = false;
      this.placing = false;
      const rect = this.normRect(this.ax, this.ay, p.x, p.y);
      if (rect.w >= MIN_DRAG && rect.h >= MIN_DRAG) {
        const defSong = this.sel?.song ?? listSongs()[0]?.song ?? 0;
        const a: MusicArea = { name: this.nextName(), song: defSong, ...rect };
        this.snapArea(a); // align + clamp to the sector grid (≥ 1 sector when snap is on)
        this.areas.push(a);
        this.sel = a;
        this.shell?.markDirty('music');
        this.refreshList();
        this.rebuildForm();
      } else {
        this.shell?.toast('Area too small — drag a box', true);
      }
      return;
    }
    if ((this.moving || this.resizing) && this.sel) {
      this.snapArea(this.sel); // align to the sector grid now the drag is done
      this.shell?.markDirty('music');
      this.rebuildForm();
    }
    this.moving = false;
    this.resizing = false;
  }

  /** Snap an area's origin and size to the sector grid (no-op if snap is off). */
  private snapArea(a: MusicArea): void {
    if (!this.snap) return;
    const x2 = snapTo(a.x + a.w, SECTOR_W);
    const y2 = snapTo(a.y + a.h, SECTOR_H);
    a.x = snapTo(a.x, SECTOR_W);
    a.y = snapTo(a.y, SECTOR_H);
    a.w = Math.max(SECTOR_W, x2 - a.x);
    a.h = Math.max(SECTOR_H, y2 - a.y);
  }

  // --- corner-handle hit testing --------------------------------------------

  /** Handle grab radius in WORLD px — a constant ~8 device px at any zoom. */
  private handleRadius(): number {
    const zoom = this.shell?.context.camera.zoom ?? 1;
    return 8 / zoom;
  }

  /** The four corners of an area as [x,y], ordered TL, TR, BL, BR. */
  private corners(a: MusicArea): [number, number][] {
    return [
      [a.x, a.y],
      [a.x + a.w, a.y],
      [a.x, a.y + a.h],
      [a.x + a.w, a.y + a.h],
    ];
  }

  /** Corner of `a` within `r` of point `p`, or -1. */
  private cornerOf(a: MusicArea, p: WorldPoint, r: number): number {
    const cs = this.corners(a);
    for (let c = 0; c < 4; c++) {
      if (Math.abs(p.x - cs[c][0]) <= r && Math.abs(p.y - cs[c][1]) <= r) return c;
    }
    return -1;
  }

  /** Topmost area with a corner near `p` (last drawn wins). */
  private cornerAtAny(p: WorldPoint, r: number): { area: MusicArea; corner: number } | null {
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const c = this.cornerOf(this.areas[i], p, r);
      if (c >= 0) return { area: this.areas[i], corner: c };
    }
    return null;
  }

  /** The corner diagonally opposite `corner` — the fixed anchor while resizing. */
  private oppositeCorner(a: MusicArea, corner: number): [number, number] {
    return this.corners(a)[3 - corner];
  }

  private normRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    snap = this.snap
  ): { x: number; y: number; w: number; h: number } {
    let x = Math.min(x0, x1),
      y = Math.min(y0, y1);
    let w = Math.abs(x1 - x0),
      h = Math.abs(y1 - y0);
    if (snap) {
      const x2 = snapTo(x + w, SECTOR_W),
        y2 = snapTo(y + h, SECTOR_H);
      x = snapTo(x, SECTOR_W);
      y = snapTo(y, SECTOR_H);
      w = Math.max(SECTOR_W, x2 - x);
      h = Math.max(SECTOR_H, y2 - y);
    }
    return { x, y, w, h };
  }

  private pickAt(p: WorldPoint): MusicArea | null {
    // Topmost (last) match wins, matching MusicManager's resolution order.
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const a = this.areas[i];
      if (p.x >= a.x && p.x < a.x + a.w && p.y >= a.y && p.y < a.y + a.h) return a;
    }
    return null;
  }

  private nextName(): string {
    let n = this.areas.length + 1;
    const taken = new Set(this.areas.map((a) => a.name));
    while (taken.has(`area-${n}`)) n++;
    return `area-${n}`;
  }

  private startPlacing(): void {
    this.placing = true;
    this.shell?.toast('Drag a box on the map to set the music area');
  }

  private deleteSelected(): void {
    if (!this.sel) return;
    const i = this.areas.indexOf(this.sel);
    if (i >= 0) this.areas.splice(i, 1);
    this.sel = null;
    this.shell?.markDirty('music');
    this.refreshList();
    this.rebuildForm();
  }

  // --- overlay ---------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    const zoom = camera.zoom || 1;
    const lw = 1 / zoom; // keep borders ~1 device px at any zoom
    const fontPx = Math.max(7, Math.round(9 / zoom));
    const vw = camera.viewW,
      vh = camera.viewH;

    // Animated "marching ants": a dashed border whose dash offset scrolls every
    // frame, so each zone reads as a live selection marquee (like Placement's
    // boxes, but moving). A dark underlay keeps the light dashes legible on any
    // tile. `tick` advances per draw — no Date.now needed.
    this.tick++;
    const dash = 5 * lw;
    const off = (this.tick * 0.4 * lw) % (dash * 2);
    // Level-of-detail: when zoomed out, hundreds of zones are on screen at once.
    // Animated dashes + a dark underlay + a big label per zone get expensive, and
    // none of it is legible at that scale — so below these zooms draw a plain
    // solid border and drop labels. Keeps far-out panning smooth.
    const fancyBorders = zoom >= 0.3; // animated marching-ants vs. plain stroke
    const showLabels = zoom >= 0.5; // text is unreadable smaller than this
    if (showLabels) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textAlign = 'left';
    }

    for (let i = 0; i < this.areas.length; i++) {
      const a = this.areas[i];
      const sx = a.x - camX,
        sy = a.y - camY;
      // Cull zones outside the (zoomed) view — there are hundreds.
      if (sx + a.w < 0 || sx > vw || sy + a.h < 0 || sy > vh) continue;
      const on = a === this.sel;
      const hue = (i * 47) % 360;

      // Subtle fill so the zone's footprint reads at a glance.
      ctx.fillStyle = `hsla(${hue},70%,55%,${on ? 0.26 : 0.12})`;
      ctx.fillRect(sx, sy, a.w, a.h);

      if (fancyBorders || on) {
        // Dark solid underlay, then the scrolling light dashes on top.
        ctx.setLineDash([]);
        ctx.lineWidth = lw * (on ? 3 : 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeRect(sx, sy, a.w, a.h);
        ctx.setLineDash([dash, dash]);
        ctx.lineDashOffset = -off;
        ctx.lineWidth = lw * (on ? 2 : 1);
        ctx.strokeStyle = on ? '#ffffff' : `hsla(${hue},90%,72%,1)`;
        ctx.strokeRect(sx, sy, a.w, a.h);
        ctx.setLineDash([]);
      } else {
        // Cheap plain border for the zoomed-out survey view.
        ctx.lineWidth = lw;
        ctx.strokeStyle = `hsla(${hue},90%,72%,1)`;
        ctx.strokeRect(sx, sy, a.w, a.h);
      }

      if (showLabels) {
        ctx.fillStyle = on ? '#fff' : `hsla(${hue},85%,82%,1)`;
        ctx.fillText(`♪ ${getSongName(a.song) ?? a.song}`, sx + 3 * lw, sy + fontPx + lw);
      }
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Corner handles on the SELECTED zone — grab to resize.
    if (this.sel) {
      const h = this.handleRadius(); // world-px half-size (~8 device px)
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#101418';
      ctx.lineWidth = lw;
      for (const [cx, cy] of this.corners(this.sel)) {
        const hx = cx - camX - h,
          hy = cy - camY - h;
        ctx.fillRect(hx, hy, h * 2, h * 2);
        ctx.strokeRect(hx, hy, h * 2, h * 2);
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

    // Header: title + a Stop-all button that kills any music/sfx preview from
    // either tab (the tool is the only place editor music is audible).
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.textContent = 'SOUND MANAGER';
    title.style.cssText = 'color:#5ad0e8;font-weight:bold;letter-spacing:1px;flex:1;';
    header.appendChild(title);
    this.mkBtn('■ Stop all', () => stopAllSounds(), header, true);
    this.panel.appendChild(header);

    // Music | SFX tab switch.
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px;';
    this.tabBtns.music = this.mkBtn('Music', () => this.switchMode('music'), tabs);
    this.tabBtns.sfx = this.mkBtn('SFX', () => this.switchMode('sfx'), tabs);
    this.panel.appendChild(tabs);

    // --- Music tab body ---
    this.musicBody = document.createElement('div');
    this.musicBody.style.cssText = 'display:flex;flex-direction:column;gap:7px;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn('+ New area (N)', () => this.startPlacing(), actions);
    // No Save button — edits auto-save via the shell (registered handler).
    this.musicBody.appendChild(actions);

    const snapRow = document.createElement('label');
    snapRow.style.cssText = 'display:flex;align-items:center;gap:6px;color:#9fb8cc;font-size:11px;';
    const snapCb = document.createElement('input');
    snapCb.type = 'checkbox';
    snapCb.checked = this.snap;
    snapCb.onchange = () => (this.snap = snapCb.checked);
    snapRow.append(snapCb, document.createTextNode('snap to sector grid (64×32)'));
    this.musicBody.appendChild(snapRow);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.musicBody.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.musicBody.appendChild(this.formEl);

    const hint = document.createElement('div');
    hint.textContent =
      'drag center to move · drag a corner to resize · Del to remove · wheel zooms out to see all';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.musicBody.appendChild(hint);
    this.panel.appendChild(this.musicBody);

    // --- SFX tab body ---
    this.sfxBody = document.createElement('div');
    this.sfxBody.style.cssText = 'display:flex;flex-direction:column;gap:7px;';
    this.buildSfxBody(this.sfxBody);
    this.panel.appendChild(this.sfxBody);

    this.shell!.panelHost.appendChild(this.panel);
    this.switchMode(this.mode); // apply initial tab visibility + button styles
  }

  /** Show the chosen tab's body, hide the other, and restyle the tab buttons. */
  private switchMode(mode: 'music' | 'sfx'): void {
    this.mode = mode;
    if (this.musicBody) this.musicBody.style.display = mode === 'music' ? 'flex' : 'none';
    if (this.sfxBody) this.sfxBody.style.display = mode === 'sfx' ? 'flex' : 'none';
    for (const k of ['music', 'sfx'] as const) {
      const b = this.tabBtns[k];
      if (!b) continue;
      const on = k === mode;
      b.style.cssText =
        'font:11px monospace;padding:3px 12px;cursor:pointer;border-radius:3px;' +
        (on
          ? 'background:#123338;color:#5ad0e8;border:1px solid #5ad0e8;'
          : 'background:#1d2530;color:#7a8a9a;border:1px solid #3a4a5a;');
    }
    // The Music tab owns the map overlay/selection; mute its handles on the SFX tab.
    if (mode === 'sfx') this.sel = null;
  }

  // --- SFX tab ---------------------------------------------------------------

  /** Build the static SFX-tab chrome (library tester + stop-all + event list). */
  private buildSfxBody(host: HTMLDivElement): void {
    // Sound library: a searchable dropdown of ALL sfx so you can audition any of
    // them directly, independent of which game event they're bound to.
    const libRow = this.mkRow(host, 'library');
    let libSel = listSfx()[0]?.id ?? 'none';
    const libPicker = createSpritePicker({
      sections: [{ values: listSfx().map((s) => s.id) }],
      initial: libSel,
      labelFor: (v) => sfxLabel(v),
      searchPlaceholder: 'search all sounds…',
      onSelect: (v) => {
        libSel = v;
        playSfx(v); // audition on pick
      },
    });
    libPicker.el.style.flex = '1';
    libPicker.el.style.minWidth = '0';
    libRow.appendChild(libPicker.el);
    this.mkBtn('▶', () => playSfx(libSel), libRow);

    const sub = document.createElement('div');
    sub.textContent =
      'Game event → sound. ▶ tests · pick to reassign · drag vol to set loudness (auto-saves).';
    sub.style.cssText =
      'color:#9fb8cc;font-size:10px;border-top:1px solid #2a3540;padding-top:6px;';
    host.appendChild(sub);

    const list = document.createElement('div');
    list.style.cssText =
      'display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;' +
      'border-top:1px solid #2a3540;padding:6px 0;';
    host.appendChild(list);
    this.sfxListEl = list;
  }

  private sfxListEl: HTMLDivElement | null = null;

  /** Render one card per game event: label · sound picker · ▶ test, plus a
   *  volume slider on a second line that scales that event's playback gain. */
  private refreshSfxList(): void {
    const list = this.sfxListEl;
    if (!list) return;
    list.innerHTML = '';
    const sounds = listSfx();
    for (const evt of SFX_EVENTS) {
      const audition = () =>
        playSfx(this.sfxMap[evt.id] ?? evt.defaultSfx, this.sfxVolumes[evt.id] ?? 1);

      const card = document.createElement('div');
      card.style.cssText =
        'display:flex;flex-direction:column;gap:3px;padding:5px 2px;border-bottom:1px solid #1c2730;';

      // Line 1: event label · current sound picker · ▶ test.
      const top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const label = document.createElement('span');
      label.textContent = evt.label;
      label.title = `event id: ${evt.id}`;
      label.style.cssText =
        'width:120px;flex:none;color:#cde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      top.appendChild(label);

      const cur = this.sfxMap[evt.id] ?? evt.defaultSfx;
      const picker = createSpritePicker({
        sections: [{ values: sounds.map((s) => s.id) }],
        initial: cur,
        labelFor: (v) => sfxLabel(v),
        searchPlaceholder: 'search sound…',
        onSelect: (v) => {
          this.sfxMap[evt.id] = v;
          setSfxEventMap(this.sfxMap); // live in this client immediately
          this.shell?.markDirty('sfx_events');
          audition(); // hear the newly-picked sound at its current volume
        },
      });
      picker.el.style.flex = '1';
      picker.el.style.minWidth = '0';
      top.appendChild(picker.el);
      this.mkBtn('▶', audition, top);
      card.appendChild(top);

      // Line 2: volume slider (0–100%) + live readout.
      const volRow = document.createElement('div');
      volRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const volLbl = document.createElement('span');
      volLbl.textContent = 'vol';
      volLbl.style.cssText = 'width:120px;flex:none;color:#9fb8cc;font-size:11px;';
      volRow.appendChild(volLbl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '5';
      slider.value = String(Math.round((this.sfxVolumes[evt.id] ?? 1) * 100));
      slider.style.cssText = 'flex:1;min-width:0;accent-color:#5ad0e8;cursor:pointer;';
      const readout = document.createElement('span');
      readout.textContent = `${slider.value}%`;
      readout.style.cssText =
        'width:34px;flex:none;text-align:right;color:#cde;font-size:11px;font-variant-numeric:tabular-nums;';
      slider.oninput = () => {
        const pct = parseInt(slider.value, 10) || 0;
        this.sfxVolumes[evt.id] = pct / 100;
        readout.textContent = `${pct}%`;
        setSfxVolumeMap(this.sfxVolumes); // live in this client immediately
        this.shell?.markDirty('sfx_events');
      };
      slider.onchange = () => audition(); // audition once on release, not per tick
      volRow.append(slider, readout);
      card.appendChild(volRow);

      list.appendChild(card);
    }
  }

  /** Persist the event→sfx map + per-event volumes to overrides/sfx_events.json. */
  private async saveSfx(): Promise<void> {
    await saveOverride('sfx_events.json', {
      version: 1,
      events: this.sfxMap,
      volumes: this.sfxVolumes,
    });
    setSfxEventMap(this.sfxMap);
    setSfxVolumeMap(this.sfxVolumes);
    this.shell?.clearDirty('sfx_events');
    this.shell?.toast(
      'Saved SFX assignments + volumes — live here; other clients refresh to resync'
    );
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (this.areas.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No areas yet.';
      e.style.cssText = 'color:#667;';
      this.listEl.appendChild(e);
      return;
    }
    for (const a of this.areas) {
      const row = document.createElement('div');
      const on = a === this.sel;
      row.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (on ? 'background:#15282c;' : '');
      const label = document.createElement('span');
      label.textContent = `♪ ${getSongName(a.song) ?? a.song}`;
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.appendChild(label);
      row.onclick = () => {
        this.sel = a;
        // Free-fly to the zone (goTo undoes the room crop); context.teleport
        // would crop to the landed room and black out the rest of the map.
        this.shell?.goTo(a.x + a.w / 2, a.y + a.h / 2);
        this.refreshList();
        this.rebuildForm();
      };
      this.listEl.appendChild(row);
    }
  }

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    if (!this.sel) {
      const e = document.createElement('div');
      e.textContent = 'Select or draw an area.';
      e.style.cssText = 'color:#667;';
      this.formEl.appendChild(e);
      return;
    }
    const a = this.sel;
    const form = this.formEl;

    const nameIn = this.mkInput(
      form,
      'name',
      (v) => {
        a.name = v || 'area';
        this.shell?.markDirty('music');
        this.refreshList();
      },
      120
    );
    nameIn.value = a.name;

    const numField = (label: string, get: () => number, set: (n: number) => void) => {
      const i = this.mkInput(
        form,
        label,
        (v) => {
          const n = parseFloat(v);
          if (Number.isNaN(n)) return;
          set(n);
          this.shell?.markDirty('music');
        },
        64
      );
      i.value = String(get());
      return i;
    };
    numField(
      'x',
      () => a.x,
      (n) => (a.x = Math.round(n))
    );
    numField(
      'y',
      () => a.y,
      (n) => (a.y = Math.round(n))
    );
    numField(
      'w',
      () => a.w,
      (n) => (a.w = Math.max(SECTOR_W, Math.round(n)))
    );
    numField(
      'h',
      () => a.h,
      (n) => (a.h = Math.max(SECTOR_H, Math.round(n)))
    );

    // Song picker — a searchable dropdown of real track titles (same component
    // as the other editor pickers, minus the sprite thumbnail). Type to filter
    // by song number or name; picking auditions the track.
    const songRow = this.mkRow(form, 'song');
    const picker = createSpritePicker({
      sections: [{ values: listSongs().map((s) => String(s.song)) }],
      initial: String(a.song),
      labelFor: (v) => songLabel(Number(v)),
      searchPlaceholder: 'search song # or name…',
      onSelect: (v) => {
        a.song = parseInt(v, 10) || 0;
        this.shell?.markDirty('music');
        this.refreshList();
        this.syncSongName();
        previewSong(a.song); // audition the picked track
      },
    });
    picker.el.style.flex = '1';
    picker.el.style.minWidth = '0';
    songRow.appendChild(picker.el);
    this.songPicker = picker;

    const audRow = this.mkRow(form, '');
    this.mkBtn('▶ Test', () => previewSong(a.song), audRow);
    this.mkBtn('■ Stop', () => stopMusic(), audRow);

    // Rename the SONG itself (global — like renaming an entity). Writes the
    // song-name override, which the dropdown/overlay/list all read back.
    const renameRow = this.mkRow(form, 'rename');
    const renameIn = this.mkBareInput(
      renameRow,
      (v) => {
        const name = v.trim();
        setSongNameOverride(a.song, name || null);
        this.shell?.markDirty('song_names');
        this.songPicker?.refresh(); // relabel the picker with the new name
        this.refreshList();
        this.shell?.toast(
          `Renamed song ${a.song} to "${name || '(default)'}" — auto-saving song_names.json`
        );
      },
      150
    );
    this.songNameInput = renameIn;
    this.syncSongName();

    this.mkBtn('Delete area', () => this.deleteSelected(), form);
  }

  private songPicker: SpritePicker | null = null;
  private songNameInput: HTMLInputElement | null = null;

  /** Mirror the selected area's current song title into the rename field. */
  private syncSongName(): void {
    if (this.songNameInput && this.sel) {
      this.songNameInput.value = getSongName(this.sel.song) ?? '';
    }
  }

  private syncForm(): void {
    // Keep the numeric fields in step while dragging/resizing the area.
    const inputs = this.formEl?.querySelectorAll('input') ?? [];
    // Fields render in order: name, x, y, w, h, (song dropdown), rename —
    // the <input>s are name(0), x(1), y(2), w(3), h(4), rename(5).
    if (!this.sel) return;
    if (inputs[1]) (inputs[1] as HTMLInputElement).value = String(Math.round(this.sel.x));
    if (inputs[2]) (inputs[2] as HTMLInputElement).value = String(Math.round(this.sel.y));
    if (inputs[3]) (inputs[3] as HTMLInputElement).value = String(Math.round(this.sel.w));
    if (inputs[4]) (inputs[4] as HTMLInputElement).value = String(Math.round(this.sel.h));
  }

  // --- small DOM helpers -----------------------------------------------------

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#123338;color:#5ad0e8;border:1px solid #5ad0e8;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  private mkRow(parent: HTMLElement, label: string): HTMLDivElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'width:46px;color:#9fb8cc;';
    r.appendChild(l);
    parent.appendChild(r);
    return r;
  }

  private mkInput(
    parent: HTMLElement,
    label: string,
    onChange: (v: string) => void,
    width = 64
  ): HTMLInputElement {
    const r = this.mkRow(parent, label);
    return this.mkBareInput(r, onChange, width);
  }

  private mkBareInput(
    parent: HTMLElement,
    onChange: (v: string) => void,
    width = 64
  ): HTMLInputElement {
    const i = document.createElement('input');
    i.style.cssText =
      `width:${width}px;font:11px monospace;background:#0c1014;color:#cde;` +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    i.onchange = () => onChange(i.value);
    parent.appendChild(i);
    return i;
  }
}

export const soundTool = new SoundTool();
