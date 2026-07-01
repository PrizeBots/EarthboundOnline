// FloatingPanel — a draggable, resizable window for a tool's panel so it can sit
// wherever the work is instead of the fixed dock. Drag the header to move, drag the
// bottom-right corner to resize, click ⏷/⏵ (or double-click the header) to collapse.
// Position/size/collapsed state persist per `id` in localStorage, so it reopens
// where you left it. Purely presentational: the tool builds its DOM as before and
// mounts it into `.body`; this only wraps it in a movable frame.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingPanelOpts {
  id: string; // localStorage key suffix — unique per tool
  title: string;
  initial: Rect; // used the first time (no saved state yet)
  minW?: number;
  minH?: number;
}

const KEY = (id: string): string => `eb.floatpanel.${id}`;

export class FloatingPanel {
  readonly el: HTMLDivElement; // outer window
  readonly body: HTMLDivElement; // content mount point (tools append here)
  private header: HTMLDivElement;
  private collapseBtn: HTMLButtonElement;
  private grip: HTMLDivElement;
  private collapsed = false;
  private rect: Rect;
  private minW: number;
  private minH: number;
  private storeKey: string;
  private cleanup: (() => void)[] = [];

  constructor(opts: FloatingPanelOpts) {
    this.storeKey = KEY(opts.id);
    this.minW = opts.minW ?? 220;
    this.minH = opts.minH ?? 120;
    const saved = this.load();
    this.rect = saved?.rect ?? { ...opts.initial };
    this.collapsed = saved?.collapsed ?? false;

    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;z-index:120;display:flex;flex-direction:column;box-sizing:border-box;' +
      'background:#101418f5;border:1px solid #4db6e8;border-radius:6px;overflow:hidden;' +
      'box-shadow:0 6px 22px #000a;';

    // Header (drag handle).
    this.header = document.createElement('div');
    this.header.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:move;flex:none;' +
      'background:#16202a;border-bottom:1px solid #26424f;color:#5ad0e8;' +
      'font:bold 11px monospace;letter-spacing:1px;user-select:none;';
    const grip = document.createElement('span');
    grip.textContent = '⠿';
    grip.style.cssText = 'color:#4a6272;';
    this.header.appendChild(grip);
    const title = document.createElement('span');
    title.textContent = opts.title;
    title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    this.header.appendChild(title);
    this.collapseBtn = document.createElement('button');
    this.collapseBtn.style.cssText =
      'font:11px monospace;cursor:pointer;background:#1d2530;color:#cde;' +
      'border:1px solid #3a4a5a;border-radius:3px;padding:0 6px;';
    this.collapseBtn.onclick = (e) => {
      e.stopPropagation();
      this.setCollapsed(!this.collapsed);
    };
    this.header.appendChild(this.collapseBtn);
    this.el.appendChild(this.header);

    // Body (tool content).
    this.body = document.createElement('div');
    this.body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:8px;';
    this.el.appendChild(this.body);

    // Resize grip (bottom-right).
    this.grip = document.createElement('div');
    this.grip.style.cssText =
      'position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;' +
      'background:linear-gradient(135deg,transparent 50%,#4db6e8 50%,#4db6e8 60%,transparent 60%,transparent 72%,#4db6e8 72%,#4db6e8 82%,transparent 82%);';
    this.el.appendChild(this.grip);

    this.wireDrag();
    this.wireResize();
    this.header.ondblclick = () => this.setCollapsed(!this.collapsed);

    document.body.appendChild(this.el);
    this.apply();
    this.syncCollapse();
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.el.remove();
  }

  // --- geometry --------------------------------------------------------------

  private apply(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Clamp so the window (or at least its header) stays reachable on screen.
    this.rect.w = Math.max(this.minW, Math.min(this.rect.w, vw));
    this.rect.h = Math.max(this.minH, this.rect.h);
    this.rect.x = Math.max(8 - this.rect.w + 40, Math.min(this.rect.x, vw - 40));
    this.rect.y = Math.max(0, Math.min(this.rect.y, vh - 28));
    this.el.style.left = `${Math.round(this.rect.x)}px`;
    this.el.style.top = `${Math.round(this.rect.y)}px`;
    this.el.style.width = `${Math.round(this.rect.w)}px`;
    if (!this.collapsed) this.el.style.height = `${Math.round(this.rect.h)}px`;
  }

  private setCollapsed(v: boolean): void {
    this.collapsed = v;
    this.syncCollapse();
    this.save();
  }

  private syncCollapse(): void {
    this.body.style.display = this.collapsed ? 'none' : 'block';
    this.grip.style.display = this.collapsed ? 'none' : 'block';
    this.el.style.height = this.collapsed ? 'auto' : `${Math.round(this.rect.h)}px`;
    this.collapseBtn.textContent = this.collapsed ? '⏵' : '⏷';
    this.collapseBtn.title = this.collapsed ? 'Expand' : 'Collapse';
  }

  private wireDrag(): void {
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    const move = (e: MouseEvent) => {
      this.rect.x = ox + (e.clientX - sx);
      this.rect.y = oy + (e.clientY - sy);
      this.apply();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.save();
    };
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      sx = e.clientX;
      sy = e.clientY;
      ox = this.rect.x;
      oy = this.rect.y;
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    };
    this.header.addEventListener('mousedown', down);
    this.cleanup.push(() => this.header.removeEventListener('mousedown', down));
  }

  private wireResize(): void {
    let sx = 0;
    let sy = 0;
    let ow = 0;
    let oh = 0;
    const move = (e: MouseEvent) => {
      this.rect.w = ow + (e.clientX - sx);
      this.rect.h = oh + (e.clientY - sy);
      this.apply();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.save();
    };
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      sx = e.clientX;
      sy = e.clientY;
      ow = this.rect.w;
      oh = this.rect.h;
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
      e.stopPropagation();
    };
    this.grip.addEventListener('mousedown', down);
    this.cleanup.push(() => this.grip.removeEventListener('mousedown', down));
  }

  // --- persistence -----------------------------------------------------------

  private load(): { rect: Rect; collapsed: boolean } | null {
    try {
      const raw = localStorage.getItem(this.storeKey);
      return raw ? (JSON.parse(raw) as { rect: Rect; collapsed: boolean }) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(
        this.storeKey,
        JSON.stringify({ rect: this.rect, collapsed: this.collapsed })
      );
    } catch {
      /* storage full / disabled — position just won't persist */
    }
  }
}
