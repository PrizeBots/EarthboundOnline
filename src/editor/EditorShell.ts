import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  TILE_SIZE,
  MAP_WIDTH_TILES,
  MAP_HEIGHT_TILES,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
} from '../types';
import { RoomBounds } from '../engine/Camera';
import { getSectorForTile } from '../engine/MapManager';
import { getCollisionByteAt } from '../engine/Collision';
import { isMusicMuted, setMusicMuted } from '../engine/MusicManager';
import { setMuteButtonHidden } from '../engine/MuteButton';
import { isSpriteEditorOpen, closeSpriteEditor } from '../engine/spriteEditor';
import { getKeySet } from '../engine/Input';
import { CommandStack } from './CommandStack';
import { LocationNav, PlaceAnchor } from './LocationNav';
import { findEditorTool, getEditorTools, getSaveHandler } from './registry';
import { EditorContext, EditorShellApi, EditorTool, WorldPoint } from './types';

// Editor Shell (EDITOR_TOOLS.md §0): the dev-only mode every tool runs in.
// Suspends gameplay input/update (Game checks isActive()), frees the camera,
// draws grid overlays + a cursor readout, and hosts the shared selection,
// undo/redo, dirty-state, and toast plumbing. DOM chrome is deliberately
// styled UNLIKE the in-game EB windows so dev UI is never mistaken for game UI.

const MINITILE = 8;
const PAN_SPEED = 4;
const PAN_FAST = 12;
// Wheel zoom: out to 0.0625x (16x the world on screen — for surveying whole
// regions, e.g. all the music zones at once) and in to 2x for pixel-level
// placement nudging. Gameplay always runs at 1.
const ZOOM_MIN = 0.0625;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.25;

const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

type Rect = { x: number; y: number; w: number; h: number };

// Pointer travel (device px) under which a press+release counts as a click, not
// a pan — the threshold for click-to-teleport.
const CLICK_SLOP = 4;

export class EditorShell {
  private active = false;
  private readonly commands = new CommandStack();
  private readonly dirtyDomains = new Set<string>();
  private readonly heldKeys = new Set<string>();

  // Auto-save: every tool funnels edits through markDirty(domain), which
  // debounces a save via the domain's registered handler — no per-tool Save
  // buttons. `autoSaveTimers` holds the pending debounce per domain;
  // `savingDomains` guards against overlapping in-flight saves for one domain.
  private readonly autoSaveTimers = new Map<string, number>();
  private readonly savingDomains = new Set<string>();
  private readonly AUTOSAVE_MS = 600;

  private activeTool: EditorTool | null = null;
  private savedRoomBounds: RoomBounds | null = null;
  // Mute state to restore on exit — the editor force-mutes the game while active.
  private mutedBeforeEditor = false;
  private nav: LocationNav | null = null;

  // Draggable quick-link anchor published by the Places nav (a selected
  // building/room). Drawn on the map; drag it to move the link's coords.
  private placeAnchor: PlaceAnchor | null = null;
  private draggingAnchor = false;

  // One-shot marquee capture requested by the Places nav: drag a box on the map
  // to crop a building thumbnail or outline an area. Resolves the rect (or null).
  private marqueeCb: ((rect: Rect | null) => void) | null = null;
  private marqueeStart: WorldPoint | null = null;
  private marqueeRect: Rect | null = null;

  // Overlay toggles
  private showTileGrid = true;
  private showMiniGrid = false;
  private showSectorGrid = true;
  private applyRoomCrop = false;

  // Atlas streaming throttle: re-stream only when the view shifts a chunk or
  // the zoom changes, not every frame (the per-frame sector sweep is wasted work
  // while the camera sits still, and murders the framerate when zoomed way out).
  private lastStreamX = NaN;
  private lastStreamY = NaN;
  private lastStreamZoom = NaN;

  // Mouse state (world coords; hover survives while the mouse is off-canvas)
  private hover: WorldPoint = { x: 0, y: 0 };
  private panning = false;
  private toolDragging = false;
  private lastClientX = 0;
  private lastClientY = 0;
  // Click-to-teleport: with no tool active, a click (not a pan-drag) on the map
  // warps the player there so you can F2 back into the game in that spot. Track
  // the press position + whether the gesture is still a click candidate.
  private downClientX = 0;
  private downClientY = 0;
  private clickCandidate = false;

  // HUD
  private bar: HTMLDivElement | null = null;
  private readout: HTMLSpanElement | null = null;
  private dirtyDot: HTMLSpanElement | null = null;
  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;

  // Right-side tool dock (persistent tab menu + the active tool's panel host).
  // Replaces the old modal Admin Hub: tools live in a column you can flip
  // between without ever leaving the editor.
  private dock: HTMLDivElement | null = null;
  private panelHost: HTMLDivElement | null = null;
  private toolHint: HTMLDivElement | null = null;
  private readonly toolTabs = new Map<string, HTMLButtonElement>();
  private saveStatusBtn: HTMLButtonElement | null = null;
  private hotReloadBtn: HTMLButtonElement | null = null;
  private hotReloadOn = false;

  // FPS
  private frames = 0;
  private fpsStamp = 0;
  fps = 0;

  constructor(readonly context: EditorContext) {}

  // --- lifecycle -----------------------------------------------------------

  isActive(): boolean {
    return this.active;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;

    // Pull our avatar out of the server's world sim while editing: enemies stop
    // aggroing/colliding with the parked character, so nothing can kill it and
    // respawn-yank the free camera back across the map.
    this.context.setEditing(true);

    // Editor camera starts where the gameplay camera was; room crop is
    // released by default so packed interiors are visible while flying.
    this.savedRoomBounds = this.context.camera.roomBounds;
    if (!this.applyRoomCrop) this.context.camera.roomBounds = null;

    getKeySet().clear(); // a held walk key must not leak into gameplay state
    this.heldKeys.clear();

    // Silence the game while editing and hide the mute button (the editor owns
    // audio here). The player's own mute preference is restored on exit.
    this.mutedBeforeEditor = isMusicMuted();
    setMusicMuted(true);
    setMuteButtonHidden(true);

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.context.canvas.addEventListener('mousedown', this.onMouseDown);
    this.context.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('beforeunload', this.onBeforeUnload);

    this.buildHud();

    // Left-side location directory (town → building → room); click to jump.
    this.nav = new LocationNav(
      (x, y) => this.goTo(x, y),
      () => {
        const t = getSectorForTile(
          Math.floor(this.context.player.x / TILE_SIZE),
          Math.floor(this.context.player.y / TILE_SIZE)
        );
        return t?.town ?? 'other';
      },
      {
        viewCenter: () => {
          const cam = this.context.camera;
          return {
            x: Math.round(cam.x + cam.viewW / 2),
            y: Math.round(cam.y + cam.viewH / 2),
          };
        },
        select: (a) => {
          this.placeAnchor = a;
          this.draggingAnchor = false;
        },
        toast: (m, e) => this.toast(m, e),
        beginMarquee: (cb) => this.beginMarquee(cb),
        currentPos: () => ({
          x: Math.round(this.context.player.x),
          y: Math.round(this.context.player.y),
        }),
      }
    );
    void this.nav.mount();

    this.buildDock();

    this.toast(
      'Editor mode — pick a tool on the right · click empty map to teleport · F2 exits · wheel zooms'
    );
  }

  /**
   * Jump to a world point from the navigator: move the player there (so tools
   * act at the location) and center the free camera, but keep editor free-fly —
   * teleport applies a room crop, which we undo unless the Crop toggle is on.
   * savedRoomBounds tracks the landed room so the Crop toggle and exit restore
   * the right one.
   */
  private goTo(x: number, y: number): void {
    this.context.teleport(x, y);
    this.savedRoomBounds = this.context.camera.roomBounds;
    if (!this.applyRoomCrop) this.context.camera.roomBounds = null;
  }

  // --- marquee capture (for the Places nav) --------------------------------

  /** Arm a one-shot map marquee; `cb` fires with the world-px rect (or null if
   *  cancelled/too small). Replaces any in-flight request. */
  private beginMarquee(cb: (rect: Rect | null) => void): void {
    this.finishMarquee(false); // resolve a prior request as cancelled
    this.marqueeCb = cb;
    this.marqueeStart = null;
    this.marqueeRect = null;
    this.toast('Drag a box on the map to set it · Esc cancels');
  }

  /** Resolve the pending marquee. Commits the rect only if it's big enough. */
  private finishMarquee(commit: boolean): void {
    const cb = this.marqueeCb;
    const r = this.marqueeRect;
    this.marqueeCb = null;
    this.marqueeStart = null;
    this.marqueeRect = null;
    if (!cb) return;
    if (commit && r && r.w >= 8 && r.h >= 8) {
      cb({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    } else {
      cb(null);
    }
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;

    this.finishMarquee(false); // resolve any dangling marquee request
    this.flushPending(); // persist any debounced edits before tearing down

    // Rejoin the world sim — the avatar is a live, damageable target again.
    this.context.setEditing(false);

    // Restore the player's pre-editor mute preference and bring the button back.
    setMusicMuted(this.mutedBeforeEditor);
    setMuteButtonHidden(false);

    this.setTool(null);
    this.context.camera.zoom = 1; // gameplay always renders at native scale
    this.context.camera.roomBounds = this.savedRoomBounds;
    this.context.camera.follow(this.context.player.x, this.context.player.y);
    getKeySet().clear();
    this.heldKeys.clear();

    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.context.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.context.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('beforeunload', this.onBeforeUnload);

    this.nav?.destroy();
    this.nav = null;
    this.dock?.remove();
    this.dock = null;
    this.panelHost = null;
    this.toolHint = null;
    this.saveStatusBtn = null;
    this.toolTabs.clear();
    this.bar?.remove();
    this.bar = null;
    this.toastEl?.remove();
    this.toastEl = null;
  }

  // --- tool management -----------------------------------------------------

  setTool(tool: EditorTool | null): void {
    if (this.activeTool === tool) return;
    this.flushPending(); // persist the outgoing tool's edits before swapping panels
    this.activeTool?.deactivate?.();
    this.activeTool = tool;
    tool?.activate?.(this.api()); // tools mount their panel into the dock's panelHost
    if (this.toolHint) this.toolHint.style.display = tool ? 'none' : '';
    this.syncToolTabs();
    if (tool) this.toast(`Tool: ${tool.name}`);
  }

  /** Tab/launch click in the dock: WIP tools warn, self-contained tools launch,
   *  shell tools toggle active (click the active tab again to deselect). */
  private selectTool(tool: EditorTool): void {
    if (tool.status !== 'ready') {
      this.toast(`${tool.name} is not built yet (see EDITOR_TOOLS.md)`, true);
      return;
    }
    if (tool.launch) {
      // Self-contained overlay (e.g. Sprite Editor). Clicking its tab while it's
      // already open toggles it closed; otherwise launch it.
      if (isSpriteEditorOpen()) closeSpriteEditor();
      else tool.launch();
      return;
    }
    // Switching to a normal shell tool closes the Sprite Editor first.
    if (isSpriteEditorOpen()) closeSpriteEditor();
    this.setTool(this.activeTool === tool ? null : tool);
  }

  getTool(): EditorTool | null {
    return this.activeTool;
  }

  api(): EditorShellApi {
    return {
      context: this.context,
      panelHost: this.panelHost!, // the dock body — tools append their panel here
      run: (cmd) => this.commands.run(cmd),
      toast: (msg, isError) => this.toast(msg, isError),
      markDirty: (d) => this.markDirty(d),
      clearDirty: (d) => this.clearDirty(d),
      goTo: (x, y) => this.goTo(x, y),
      openTool: (toolId) => {
        const tool = findEditorTool(toolId);
        if (tool && tool.status === 'ready') this.setTool(tool);
        else this.toast(`Tool '${toolId}' is not available`, true);
      },
    };
  }

  // --- dirty state ---------------------------------------------------------

  markDirty(domain: string): void {
    this.dirtyDomains.add(domain);
    this.updateSaveStatus();
    this.scheduleAutoSave(domain); // persist shortly after edits settle
  }

  clearDirty(domain: string): void {
    this.dirtyDomains.delete(domain);
    this.updateSaveStatus();
  }

  get dirty(): ReadonlySet<string> {
    return this.dirtyDomains;
  }

  // --- auto-save -----------------------------------------------------------

  /** (Re)start the debounce for a domain; the timer fires one save once edits pause. */
  private scheduleAutoSave(domain: string): void {
    const prev = this.autoSaveTimers.get(domain);
    if (prev) clearTimeout(prev);
    this.autoSaveTimers.set(
      domain,
      window.setTimeout(() => {
        this.autoSaveTimers.delete(domain);
        void this.autoSaveDomain(domain);
      }, this.AUTOSAVE_MS)
    );
  }

  /** Run a domain's registered save handler, guarding overlapping saves. The
   *  handler clears its own dirty flag and toasts (that's the save notification);
   *  on failure we keep the domain dirty and retry after the next change. */
  private async autoSaveDomain(domain: string): Promise<void> {
    if (!this.dirtyDomains.has(domain)) return; // nothing pending
    if (this.savingDomains.has(domain)) {
      this.scheduleAutoSave(domain); // a save is in flight — retry after it settles
      return;
    }
    const save = getSaveHandler(domain);
    if (!save) return; // no handler registered (shouldn't happen)
    this.savingDomains.add(domain);
    this.updateSaveStatus();
    try {
      await save();
      this.dirtyDomains.delete(domain);
    } catch (err) {
      this.toast(`Auto-save failed (${domain}) — will retry: ${err}`, true);
      this.scheduleAutoSave(domain);
    } finally {
      this.savingDomains.delete(domain);
      this.updateSaveStatus();
    }
  }

  /** Force every dirty domain to save NOW (skip the debounce) — used on tool
   *  switch, on exit, and when the status button is clicked. */
  private flushPending(): void {
    for (const domain of [...this.dirtyDomains]) {
      const prev = this.autoSaveTimers.get(domain);
      if (prev) {
        clearTimeout(prev);
        this.autoSaveTimers.delete(domain);
      }
      void this.autoSaveDomain(domain);
    }
  }

  private updateSaveStatus(): void {
    const dirty = this.dirtyDomains.size;
    const saving = this.savingDomains.size;
    if (this.dirtyDot) {
      this.dirtyDot.textContent = dirty ? `● unsaved: ${[...this.dirtyDomains].join(', ')}` : '';
    }
    if (this.saveStatusBtn) {
      this.saveStatusBtn.textContent = saving
        ? '💾 Saving…'
        : dirty
          ? `● Save now (${dirty})`
          : '✓ Saved';
    }
  }

  // --- right tool dock -------------------------------------------------------

  private buildDock(): void {
    this.dock = document.createElement('div');
    this.dock.style.cssText =
      'position:fixed;top:31px;right:0;bottom:0;width:256px;z-index:90;display:flex;' +
      'flex-direction:column;background:#101418f2;color:#cde;font:12px monospace;' +
      'border-left:2px solid #e8a33d;user-select:none;';
    // Typing into a tool field must not pan the camera / fire tool hotkeys.
    this.dock.addEventListener('keydown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.textContent = '⚒ TOOLS';
    head.title = 'dev only — never ships';
    head.style.cssText = 'color:#e8a33d;font-weight:bold;letter-spacing:1px;padding:6px 8px 4px;';
    this.dock.appendChild(head);

    // One tab per registered tool.
    const tabs = document.createElement('div');
    tabs.style.cssText =
      'display:flex;flex-direction:column;gap:3px;padding:0 6px 6px;border-bottom:1px solid #243;';
    for (const tool of getEditorTools()) {
      const b = document.createElement('button');
      b.textContent = tool.name + (tool.status === 'ready' ? '' : '  (WIP)');
      b.title = tool.description;
      b.style.cssText = this.tabStyle(false, tool.status === 'ready');
      b.onclick = () => this.selectTool(tool);
      this.toolTabs.set(tool.id, b);
      tabs.appendChild(b);
    }
    this.dock.appendChild(tabs);

    // The active tool mounts its panel here; scrolls if it's tall.
    this.panelHost = document.createElement('div');
    this.panelHost.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:8px 6px;';
    this.toolHint = document.createElement('div');
    this.toolHint.textContent = 'Pick a tool above to start editing.';
    this.toolHint.style.cssText = 'color:#667;font-size:11px;';
    this.panelHost.appendChild(this.toolHint);
    this.dock.appendChild(this.panelHost);

    this.dock.appendChild(this.buildDockFooter());
    document.body.appendChild(this.dock);
    this.syncToolTabs();
    this.updateSaveStatus();
  }

  private tabStyle(active: boolean, ready: boolean): string {
    const base =
      'font:11px monospace;padding:4px 8px;text-align:left;border-radius:3px;cursor:pointer;';
    if (!ready)
      return base + 'background:#11161c;color:#8899aa;border:1px solid #2a3340;opacity:.7;';
    return active
      ? base + 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
      : base + 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
  }

  private syncToolTabs(): void {
    for (const tool of getEditorTools()) {
      const b = this.toolTabs.get(tool.id);
      if (b) b.style.cssText = this.tabStyle(this.activeTool === tool, tool.status === 'ready');
    }
  }

  /** Footer: jump-to-px + Save all + Back to game. */
  private buildDockFooter(): HTMLDivElement {
    const footer = document.createElement('div');
    footer.style.cssText =
      'display:flex;flex-direction:column;gap:6px;padding:6px;border-top:1px solid #243;';

    const jump = document.createElement('div');
    jump.style.cssText = 'display:flex;gap:4px;align-items:center;';
    const mkIn = (ph: string) => {
      const i = document.createElement('input');
      i.placeholder = ph;
      i.style.cssText =
        'width:50px;font:11px monospace;background:#0c1014;color:#cde;' +
        'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
      return i;
    };
    const xIn = mkIn('x');
    const yIn = mkIn('y');
    const go = this.mkDockBtn('Go', () => {
      const x = parseInt(xIn.value, 10);
      const y = parseInt(yIn.value, 10);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        this.toast('Enter numeric x and y', true);
        return;
      }
      this.goTo(x, y);
    });
    const jLabel = document.createElement('span');
    jLabel.textContent = 'jump px';
    jLabel.style.cssText = 'color:#9fb8cc;font-size:10px;';
    jump.append(jLabel, xIn, yIn, go);
    footer.appendChild(jump);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;';
    // Auto-save status — edits persist automatically; click to force a save now.
    this.saveStatusBtn = this.mkDockBtn('✓ Saved', () => this.flushPending(), true);
    this.saveStatusBtn.style.flex = '1';
    this.saveStatusBtn.title = 'Changes auto-save. Click to save immediately.';
    btnRow.appendChild(this.saveStatusBtn);
    const back = this.mkDockBtn('Back to game', () => this.exit());
    btnRow.appendChild(back);
    footer.appendChild(btnRow);
    this.updateSaveStatus();
    return footer;
  }

  private mkDockBtn(label: string, onClick: () => void, accent = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:4px 8px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#1f3a26;color:#9f9;border:1px solid #4a6;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = onClick;
    return b;
  }

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.dirtyDomains.size > 0) e.preventDefault();
  };

  // --- per-frame (called from Game.update while active) ---------------------

  update(): void {
    const cam = this.context.camera;
    // Keep the broad map visible while the Crop toggle is off. teleport/goTo run
    // an ASYNC sector load and only then set the gameplay room crop, so nulling
    // it once in goTo() loses a race; re-assert it every frame instead. (Crop ON
    // keeps the landed room's bounds.)
    if (!this.applyRoomCrop && cam.roomBounds) cam.roomBounds = null;
    const fast = this.heldKeys.has('shift');
    // Pan in SCREEN-speed terms: zoomed out covers more world per frame.
    const speed = (fast ? PAN_FAST : PAN_SPEED) / cam.zoom;
    let dx = 0;
    let dy = 0;
    if (this.heldKeys.has('a') || this.heldKeys.has('arrowleft')) dx -= speed;
    if (this.heldKeys.has('d') || this.heldKeys.has('arrowright')) dx += speed;
    if (this.heldKeys.has('w') || this.heldKeys.has('arrowup')) dy -= speed;
    if (this.heldKeys.has('s') || this.heldKeys.has('arrowdown')) dy += speed;
    this.clampCamera(cam.x + dx, cam.y + dy);

    // Stream atlases for whatever the free camera now shows — gameplay only
    // loads around the (frozen) player, so panned/zoomed-out areas would
    // otherwise render black with doors/NPCs floating on them. Throttled: only
    // re-sweep when the view has shifted ~a third of a screen or the zoom
    // changed (the sweep itself is cheap per sector, but at 16x out it touches
    // hundreds of them, so doing it every frame is what stutters the pan).
    const stepX = cam.viewW / 3;
    const stepY = cam.viewH / 3;
    if (
      cam.zoom !== this.lastStreamZoom ||
      !(Math.abs(cam.x - this.lastStreamX) < stepX && Math.abs(cam.y - this.lastStreamY) < stepY)
    ) {
      this.lastStreamX = cam.x;
      this.lastStreamY = cam.y;
      this.lastStreamZoom = cam.zoom;
      this.context.streamView();
    }

    const now = performance.now();
    this.frames++;
    if (now - this.fpsStamp >= 1000) {
      this.fps = this.frames;
      this.frames = 0;
      this.fpsStamp = now;
    }

    if (this.toastTimer > 0 && --this.toastTimer === 0 && this.toastEl) {
      this.toastEl.style.opacity = '0';
    }
    this.updateReadout();
  }

  // --- overlay drawing (called from Game.render after the world) ------------

  drawOverlay(): void {
    const ctx = this.context.ctx;
    const cam = this.context.camera;
    const camX = Math.round(cam.x);
    const camY = Math.round(cam.y);

    // Overlays draw in world-screen coordinates under the same zoom
    // transform as the world render, so markers stay glued to the map.
    ctx.save();
    ctx.scale(cam.zoom, cam.zoom);
    const lw = 1 / cam.zoom; // keep lines ~1 device pixel at any zoom

    if (this.showMiniGrid && cam.zoom >= 0.5) {
      this.drawGrid(ctx, camX, camY, MINITILE, 'rgba(255,255,255,0.08)', lw);
    }
    if (this.showTileGrid) {
      this.drawGrid(ctx, camX, camY, TILE_SIZE, 'rgba(255,255,255,0.18)', lw);
    }
    if (this.showSectorGrid) {
      this.drawGrid(
        ctx,
        camX,
        camY,
        SECTOR_TILES_X * TILE_SIZE,
        'rgba(255,190,40,0.55)',
        lw,
        SECTOR_TILES_Y * TILE_SIZE
      );
    }

    // Hovered minitile
    const mx = Math.floor(this.hover.x / MINITILE) * MINITILE - camX;
    const my = Math.floor(this.hover.y / MINITILE) * MINITILE - camY;
    ctx.strokeStyle = 'rgba(80,220,255,0.9)';
    ctx.lineWidth = lw;
    ctx.strokeRect(mx + 0.5, my + 0.5, MINITILE - 1, MINITILE - 1);

    // Player marker (you, frozen while editing)
    const px = Math.round(this.context.player.x) - camX;
    const py = Math.round(this.context.player.y) - camY;
    ctx.strokeStyle = 'rgba(120,255,120,0.9)';
    ctx.beginPath();
    ctx.moveTo(px - 4, py);
    ctx.lineTo(px + 4, py);
    ctx.moveTo(px, py - 4);
    ctx.lineTo(px, py + 4);
    ctx.stroke();

    this.activeTool?.drawOverlay?.(ctx, cam);

    // Pending marquee (Places nav thumbnail / area outline): a green capture box.
    if (this.marqueeRect) {
      const r = this.marqueeRect;
      ctx.fillStyle = 'rgba(124,252,106,0.16)';
      ctx.fillRect(r.x - camX, r.y - camY, r.w, r.h);
      ctx.strokeStyle = '#7CFC6A';
      ctx.lineWidth = lw * 2;
      ctx.strokeRect(r.x - camX + 0.5, r.y - camY + 0.5, r.w, r.h);
    }

    // Selected quick-link anchor (from the Places nav): a pink pin you can drag.
    if (this.placeAnchor) {
      const ax = Math.round(this.placeAnchor.x) - camX;
      const ay = Math.round(this.placeAnchor.y) - camY;
      ctx.strokeStyle = this.draggingAnchor ? '#ffd23e' : '#ff3ea5';
      ctx.fillStyle = this.draggingAnchor ? 'rgba(255,210,62,0.9)' : 'rgba(255,62,165,0.85)';
      ctx.lineWidth = lw * 2;
      ctx.beginPath();
      ctx.arc(ax, ay, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath(); // center diamond
      ctx.moveTo(ax, ay - 4);
      ctx.lineTo(ax + 4, ay);
      ctx.lineTo(ax, ay + 4);
      ctx.lineTo(ax - 4, ay);
      ctx.closePath();
      ctx.fill();
      ctx.font = `${Math.round(11 / cam.zoom)}px monospace`;
      ctx.fillStyle = '#fff';
      ctx.fillText(this.placeAnchor.label, ax + 9, ay - 5);
    }

    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    stepX: number,
    color: string,
    lw: number,
    stepY = stepX
  ): void {
    const cam = this.context.camera;
    ctx.fillStyle = color;
    for (let x = stepX - (camX % stepX); x < cam.viewW; x += stepX) {
      ctx.fillRect(x, 0, lw, cam.viewH);
    }
    for (let y = stepY - (camY % stepY); y < cam.viewH; y += stepY) {
      ctx.fillRect(0, y, cam.viewW, lw);
    }
  }

  // --- input ----------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    // Typing into a panel input must not pan the camera / trigger tools (or exit).
    const focused = document.activeElement?.tagName;
    const typing = focused === 'INPUT' || focused === 'SELECT' || focused === 'TEXTAREA';

    // F2 exits editor mode back to the game from ANYWHERE — including the Sprite
    // Editor overlay, which otherwise owns the keyboard (its own listener never
    // gets a chance to exit). Handle it BEFORE the sprite-editor bail below;
    // close that overlay first, then exit the shell.
    if (e.key === 'F2' && !typing) {
      e.preventDefault();
      if (isSpriteEditorOpen()) closeSpriteEditor();
      this.exit();
      return;
    }

    // The Sprite Editor (docked left) owns the rest of the keyboard while open —
    // bail BEFORE stopPropagation so its own listeners still receive the event.
    if (isSpriteEditorOpen()) return;
    if (typing) return;
    e.stopPropagation();
    const k = e.key.toLowerCase();
    // The active tool gets Escape first (e.g. closing its own overlay); otherwise
    // Esc deselects the current tool (the dock stays — no modal to close).
    if (k === 'escape') {
      if (this.marqueeCb) {
        this.finishMarquee(false);
        this.toast('Marquee cancelled');
        return;
      }
      if (this.activeTool?.onKey?.('escape')) return;
      this.setTool(null);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      const cmd = e.shiftKey ? this.commands.redo() : this.commands.undo();
      this.toast(cmd ? `${e.shiftKey ? 'Redo' : 'Undo'}: ${cmd.label}` : 'Nothing to undo');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      const cmd = this.commands.redo();
      this.toast(cmd ? `Redo: ${cmd.label}` : 'Nothing to redo');
      return;
    }
    if (this.activeTool?.onKey?.(k)) return;
    if (k === '1') this.toggle('tile');
    else if (k === '2') this.toggle('mini');
    else if (k === '3') this.toggle('sector');
    else if (k === '4') this.toggle('crop');
    else if (k === 'shift' || PAN_KEYS.has(k)) {
      e.preventDefault();
      this.heldKeys.add(k);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    e.stopPropagation();
    this.heldKeys.delete(e.key.toLowerCase());
  };

  private toggle(which: 'tile' | 'mini' | 'sector' | 'crop'): void {
    if (which === 'tile') this.showTileGrid = !this.showTileGrid;
    else if (which === 'mini') this.showMiniGrid = !this.showMiniGrid;
    else if (which === 'sector') this.showSectorGrid = !this.showSectorGrid;
    else {
      this.applyRoomCrop = !this.applyRoomCrop;
      this.context.camera.roomBounds = this.applyRoomCrop ? this.savedRoomBounds : null;
    }
    this.syncToggleButtons();
  }

  private clampCamera(x: number, y: number): void {
    const cam = this.context.camera;
    cam.x = Math.max(0, Math.min(x, MAP_WIDTH_TILES * TILE_SIZE - cam.viewW));
    cam.y = Math.max(0, Math.min(y, MAP_HEIGHT_TILES * TILE_SIZE - cam.viewH));
  }

  private toWorld(clientX: number, clientY: number): WorldPoint {
    const rect = this.context.canvas.getBoundingClientRect();
    const cam = this.context.camera;
    const scaleX = (rect.width / SCREEN_WIDTH) * cam.zoom;
    const scaleY = (rect.height / SCREEN_HEIGHT) * cam.zoom;
    return {
      x: cam.x + (clientX - rect.left) / scaleX,
      y: cam.y + (clientY - rect.top) / scaleY,
    };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const cam = this.context.camera;
    const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    const next = Math.max(ZOOM_MIN, Math.min(cam.zoom * factor, ZOOM_MAX));
    if (next === cam.zoom) return;
    // Anchor the zoom at the cursor: the world point under it stays put.
    const before = this.toWorld(e.clientX, e.clientY);
    cam.zoom = next;
    const after = this.toWorld(e.clientX, e.clientY);
    this.clampCamera(cam.x + before.x - after.x, cam.y + before.y - after.y);
    this.hover = this.toWorld(e.clientX, e.clientY);
    this.updateReadout();
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = this.toWorld(e.clientX, e.clientY);
    // A pending marquee owns the next drag entirely.
    if (this.marqueeCb) {
      this.marqueeStart = p;
      this.marqueeRect = { x: p.x, y: p.y, w: 0, h: 0 };
      return;
    }
    // Grabbing the selected place anchor wins over panning / the active tool.
    if (this.placeAnchor) {
      const grab = 10 / this.context.camera.zoom; // ~10 device px
      if (Math.hypot(p.x - this.placeAnchor.x, p.y - this.placeAnchor.y) <= grab) {
        this.draggingAnchor = true;
        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;
        return;
      }
    }
    this.clickCandidate = false;
    if (this.activeTool?.onMouseDown?.(p)) {
      this.toolDragging = true;
    } else {
      this.panning = true;
      // No tool selected → this may be a click-to-teleport (resolved on mouseup
      // if the pointer barely moved). Dragging still pans.
      this.clickCandidate = !this.activeTool;
      this.downClientX = e.clientX;
      this.downClientY = e.clientY;
    }
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
  };

  private onMouseMove = (e: MouseEvent) => {
    this.hover = this.toWorld(e.clientX, e.clientY);
    if (this.marqueeCb && this.marqueeStart) {
      const s = this.marqueeStart;
      this.marqueeRect = {
        x: Math.min(s.x, this.hover.x),
        y: Math.min(s.y, this.hover.y),
        w: Math.abs(this.hover.x - s.x),
        h: Math.abs(this.hover.y - s.y),
      };
      this.updateReadout();
      return;
    }
    if (this.draggingAnchor && this.placeAnchor) {
      this.placeAnchor.x = Math.round(this.hover.x);
      this.placeAnchor.y = Math.round(this.hover.y);
      this.placeAnchor.onMove(this.placeAnchor.x, this.placeAnchor.y);
      this.updateReadout();
      return;
    }
    if (this.panning) {
      const rect = this.context.canvas.getBoundingClientRect();
      const cam = this.context.camera;
      const scale = (rect.width / SCREEN_WIDTH) * cam.zoom;
      this.clampCamera(
        cam.x - (e.clientX - this.lastClientX) / scale,
        cam.y - (e.clientY - this.lastClientY) / scale
      );
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
    }
    this.activeTool?.onMouseMove?.(this.hover, this.toolDragging);
    this.updateReadout();
  };

  private onMouseUp = (e: MouseEvent) => {
    if (this.marqueeCb) {
      this.finishMarquee(true);
      return;
    }
    if (this.draggingAnchor) {
      this.draggingAnchor = false;
      this.placeAnchor?.onCommit();
      return;
    }
    if (this.toolDragging) {
      this.activeTool?.onMouseUp?.(this.toWorld(e.clientX, e.clientY));
    } else if (this.clickCandidate) {
      // A click (not a drag) with no tool active: teleport the player here so F2
      // drops back into the game at this spot.
      const moved = Math.hypot(e.clientX - this.downClientX, e.clientY - this.downClientY);
      if (moved < CLICK_SLOP) {
        const p = this.toWorld(e.clientX, e.clientY);
        const tx = Math.round(p.x);
        const ty = Math.round(p.y);
        this.goTo(tx, ty);
        this.toast(`Teleported to (${tx}, ${ty}) — press F2 to play here`);
      }
    }
    this.clickCandidate = false;
    this.panning = false;
    this.toolDragging = false;
  };

  // --- HUD -------------------------------------------------------------------

  private buildHud(): void {
    this.bar = document.createElement('div');
    this.bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:90;display:flex;gap:10px;' +
      'align-items:center;padding:5px 10px;background:#101418f2;color:#cde;' +
      'font:12px monospace;border-bottom:2px solid #e8a33d;user-select:none;';

    const title = document.createElement('span');
    title.textContent = '⚒ EDITOR';
    title.style.cssText = 'color:#e8a33d;font-weight:bold;letter-spacing:1px;';
    this.bar.appendChild(title);

    const mkBtn = (label: string, onClick: () => void, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:11px monospace;padding:2px 8px;cursor:pointer;border-radius:3px;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = onClick;
      this.bar!.appendChild(b);
      return b;
    };

    for (const [label, which] of [
      ['1 Tile', 'tile'],
      ['2 Mini', 'mini'],
      ['3 Sector', 'sector'],
      ['4 Crop', 'crop'],
    ] as const) {
      const b = mkBtn(label, () => this.toggle(which));
      b.dataset.toggle = which;
    }

    mkBtn('Places', () => this.nav?.toggle());

    // Reload toggle: when OFF (default) NOTHING refreshes the page — neither
    // editor override saves nor source (.ts) edits via Vite HMR — so you stay in
    // the editor. When ON, both reload as usual. Talks to the dev server's
    // /__editor/hotreload endpoint.
    this.hotReloadBtn = mkBtn('🔄 Reload: …', () => void this.toggleHotReload());
    this.hotReloadBtn.title =
      'Auto-refresh the page on override saves AND source edits (off = stay in the editor)';
    void this.refreshHotReload();

    this.readout = document.createElement('span');
    this.readout.style.cssText = 'margin-left:auto;color:#9fb8cc;white-space:pre;';
    this.bar.appendChild(this.readout);

    this.dirtyDot = document.createElement('span');
    this.dirtyDot.style.cssText = 'color:#ff7a6a;';
    this.bar.appendChild(this.dirtyDot);

    mkBtn('Exit (F2)', () => this.exit());

    document.body.appendChild(this.bar);
    this.syncToggleButtons();
    this.updateSaveStatus();

    this.toastEl = document.createElement('div');
    this.toastEl.style.cssText =
      'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:95;' +
      'padding:6px 14px;border-radius:4px;background:#101418f2;color:#cde;' +
      'font:12px monospace;border:1px solid #e8a33d;opacity:0;transition:opacity .3s;';
    document.body.appendChild(this.toastEl);
  }

  // --- override hot-reload toggle (dev server) -------------------------------

  /** Read the current hot-reload state from the dev server and sync the button. */
  private async refreshHotReload(): Promise<void> {
    try {
      const r = await fetch('/__editor/hotreload');
      if (r.ok) this.hotReloadOn = !!(await r.json()).on;
    } catch {
      /* not on the Vite dev server (e.g. preview build) — leave it off */
    }
    this.syncHotReloadBtn();
  }

  /** Flip hot-reload on the dev server, then reflect the confirmed state. */
  private async toggleHotReload(): Promise<void> {
    const next = !this.hotReloadOn;
    try {
      const r = await fetch('/__editor/hotreload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: next }),
      });
      if (r.ok) this.hotReloadOn = !!(await r.json()).on;
    } catch {
      this.toast('Hot-reload toggle failed (dev server only)', true);
      return;
    }
    this.syncHotReloadBtn();
    this.toast(
      this.hotReloadOn
        ? 'Reload ON — the page refreshes on override saves and source edits'
        : 'Reload OFF — saves and source edits keep you in the editor'
    );
  }

  private syncHotReloadBtn(): void {
    const b = this.hotReloadBtn;
    if (!b) return;
    b.textContent = `🔄 Reload: ${this.hotReloadOn ? 'on' : 'off'}`;
    b.style.background = this.hotReloadOn ? '#143d22' : '#1d2530';
    b.style.color = this.hotReloadOn ? '#6ad08a' : '#cde';
    b.style.borderColor = this.hotReloadOn ? '#6ad08a' : '#3a4a5a';
  }

  private syncToggleButtons(): void {
    if (!this.bar) return;
    const states: Record<string, boolean> = {
      tile: this.showTileGrid,
      mini: this.showMiniGrid,
      sector: this.showSectorGrid,
      crop: this.applyRoomCrop,
    };
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('button[data-toggle]')) {
      const on = states[b.dataset.toggle!];
      b.style.color = on ? '#7fe07f' : '#778899';
      b.style.borderColor = on ? '#7fe07f' : '#3a4a5a';
    }
  }

  toast(message: string, isError = false): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = message;
    this.toastEl.style.borderColor = isError ? '#ff7a6a' : '#e8a33d';
    this.toastEl.style.opacity = '1';
    this.toastTimer = 150; // ~2.5s at 60fps
  }

  private updateReadout(): void {
    if (!this.readout) return;
    const { x, y } = this.hover;
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    const mtx = Math.floor(x / MINITILE);
    const mty = Math.floor(y / MINITILE);
    const sec = getSectorForTile(tx, ty);
    const secX = Math.floor(tx / SECTOR_TILES_X);
    const secY = Math.floor(ty / SECTOR_TILES_Y);
    const byte = getCollisionByteAt(x, y);

    const flags =
      byte === null
        ? '--'
        : [
            byte & 0x80 ? 'SOLID' : null,
            byte & 0x01 ? 'PRI-LO' : null,
            byte & 0x02 ? 'PRI-HI' : null,
          ]
            .filter(Boolean)
            .join('+') || 'walk';
    const secInfo = sec
      ? `ts${sec.tilesetId}/p${sec.paletteId}/m${sec.musicId}${sec.indoor ? '/in' : ''}${sec.dungeon ? '/dg' : ''}`
      : 'void';

    const zoom = Math.round(this.context.camera.zoom * 100);
    this.readout.textContent =
      `px(${Math.floor(x)},${Math.floor(y)}) t(${tx},${ty}) mt(${mtx},${mty}) ` +
      `sec(${secX},${secY}) ${secInfo} col=${byte === null ? '--' : '0x' + byte.toString(16).padStart(2, '0')} ${flags} ` +
      `${zoom}% ${this.fps}fps`;
  }
}
