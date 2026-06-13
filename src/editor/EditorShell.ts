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
import { getKeySet } from '../engine/Input';
import { CommandStack } from './CommandStack';
import { LocationNav } from './LocationNav';
import { findEditorTool } from './registry';
import { EditorContext, EditorShellApi, EditorTool, WorldPoint } from './types';

// Editor Shell (EDITOR_TOOLS.md §0): the dev-only mode every tool runs in.
// Suspends gameplay input/update (Game checks isActive()), frees the camera,
// draws grid overlays + a cursor readout, and hosts the shared selection,
// undo/redo, dirty-state, and toast plumbing. DOM chrome is deliberately
// styled UNLIKE the in-game EB windows so dev UI is never mistaken for game UI.

const MINITILE = 8;
const PAN_SPEED = 4;
const PAN_FAST = 12;
// Wheel zoom: out to 0.25x (4x the world on screen) and in to 2x for
// pixel-level placement nudging. Gameplay always runs at 1.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.25;

const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

export class EditorShell {
  private active = false;
  private readonly commands = new CommandStack();
  private readonly dirtyDomains = new Set<string>();
  private readonly heldKeys = new Set<string>();

  private activeTool: EditorTool | null = null;
  private savedRoomBounds: RoomBounds | null = null;
  private nav: LocationNav | null = null;

  // Overlay toggles
  private showTileGrid = true;
  private showMiniGrid = false;
  private showSectorGrid = true;
  private applyRoomCrop = false;

  // Mouse state (world coords; hover survives while the mouse is off-canvas)
  private hover: WorldPoint = { x: 0, y: 0 };
  private panning = false;
  private toolDragging = false;
  private lastClientX = 0;
  private lastClientY = 0;

  // HUD
  private bar: HTMLDivElement | null = null;
  private readout: HTMLSpanElement | null = null;
  private dirtyDot: HTMLSpanElement | null = null;
  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;

  // FPS
  private frames = 0;
  private fpsStamp = 0;
  fps = 0;

  /** Set by index.ts — opens the Admin Hub overlay. */
  onHubRequest: () => void = () => {};
  /** Set by index.ts — true while the hub overlay is open (shell yields keys). */
  isHubOpen: () => boolean = () => false;

  constructor(readonly context: EditorContext) {}

  // --- lifecycle -----------------------------------------------------------

  isActive(): boolean {
    return this.active;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;

    // Editor camera starts where the gameplay camera was; room crop is
    // released by default so packed interiors are visible while flying.
    this.savedRoomBounds = this.context.camera.roomBounds;
    if (!this.applyRoomCrop) this.context.camera.roomBounds = null;

    getKeySet().clear(); // a held walk key must not leak into gameplay state
    this.heldKeys.clear();

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
      }
    );
    void this.nav.mount();

    this.toast('Editor mode — F2 exits, Esc opens the hub, wheel zooms');
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

  exit(): void {
    if (!this.active) return;
    this.active = false;

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
    this.bar?.remove();
    this.bar = null;
    this.toastEl?.remove();
    this.toastEl = null;
  }

  // --- tool management -----------------------------------------------------

  setTool(tool: EditorTool | null): void {
    if (this.activeTool === tool) return;
    this.activeTool?.deactivate?.();
    this.activeTool = tool;
    tool?.activate?.(this.api());
    if (tool) this.toast(`Tool: ${tool.name}`);
  }

  getTool(): EditorTool | null {
    return this.activeTool;
  }

  api(): EditorShellApi {
    return {
      context: this.context,
      run: (cmd) => this.commands.run(cmd),
      toast: (msg, isError) => this.toast(msg, isError),
      markDirty: (d) => this.markDirty(d),
      clearDirty: (d) => this.clearDirty(d),
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
    this.updateDirtyDot();
  }

  clearDirty(domain: string): void {
    this.dirtyDomains.delete(domain);
    this.updateDirtyDot();
  }

  get dirty(): ReadonlySet<string> {
    return this.dirtyDomains;
  }

  private updateDirtyDot(): void {
    if (!this.dirtyDot) return;
    const n = this.dirtyDomains.size;
    this.dirtyDot.textContent = n > 0 ? `● unsaved: ${[...this.dirtyDomains].join(', ')}` : '';
  }

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.dirtyDomains.size > 0) e.preventDefault();
  };

  // --- per-frame (called from Game.update while active) ---------------------

  update(): void {
    const cam = this.context.camera;
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
        ctx, camX, camY,
        SECTOR_TILES_X * TILE_SIZE, 'rgba(255,190,40,0.55)', lw,
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
    if (this.isHubOpen()) return; // hub overlay owns the keyboard
    // Typing into a panel input must not pan the camera / trigger tools.
    const focused = document.activeElement?.tagName;
    if (focused === 'INPUT' || focused === 'SELECT' || focused === 'TEXTAREA') return;
    e.stopPropagation();
    const k = e.key.toLowerCase();

    if (e.key === 'F2') {
      e.preventDefault();
      this.exit();
      return;
    }
    // The active tool gets Escape first (e.g. closing its own overlay).
    if (k === 'escape') {
      if (this.activeTool?.onKey?.('escape')) return;
      this.onHubRequest();
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
    if (this.activeTool?.onMouseDown?.(p)) {
      this.toolDragging = true;
    } else {
      this.panning = true;
    }
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
  };

  private onMouseMove = (e: MouseEvent) => {
    this.hover = this.toWorld(e.clientX, e.clientY);
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
    if (this.toolDragging) {
      this.activeTool?.onMouseUp?.(this.toWorld(e.clientX, e.clientY));
    }
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

    mkBtn('Hub (Esc)', () => this.onHubRequest(), true);

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

    this.readout = document.createElement('span');
    this.readout.style.cssText = 'margin-left:auto;color:#9fb8cc;white-space:pre;';
    this.bar.appendChild(this.readout);

    this.dirtyDot = document.createElement('span');
    this.dirtyDot.style.cssText = 'color:#ff7a6a;';
    this.bar.appendChild(this.dirtyDot);

    mkBtn('Exit (F2)', () => this.exit());

    document.body.appendChild(this.bar);
    this.syncToggleButtons();
    this.updateDirtyDot();

    this.toastEl = document.createElement('div');
    this.toastEl.style.cssText =
      'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:95;' +
      'padding:6px 14px;border-radius:4px;background:#101418f2;color:#cde;' +
      'font:12px monospace;border:1px solid #e8a33d;opacity:0;transition:opacity .3s;';
    document.body.appendChild(this.toastEl);
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
