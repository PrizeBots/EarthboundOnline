// FolderDesktop — a reusable file-explorer "desktop" for organizing icons into
// nested folders by drag & drop. Modeled on the Entity Manager's gallery
// (folders + marquee + breadcrumb + search), but generic over what an "item" is:
// the caller supplies how to draw a tile, label it, and read/mutate the folder
// store. The Item Manager uses it to sort items into categories (Food, Weapons…)
// that the Sprite Editor then reads back as its item tabs.

export interface FolderDesktopFolder {
  id: string;
  name: string;
  parent: string | null;
}

/** The folder model the desktop reads & mutates (e.g. ItemFolders.ts). */
export interface FolderDesktopStore {
  foldersWithParent(parent: string | null): FolderDesktopFolder[];
  folderOf(id: string): string | null;
  itemsInFolder(parent: string | null): string[];
  folderName(id: string): string;
  childCount(folderId: string): number;
  addFolder(name: string, parent: string | null): string;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
  assignTo(ids: Iterable<string>, folder: string | null): void;
  setParent(child: string, parent: string | null): boolean;
  autoOrganize(): void;
  allIds(): string[];
}

export interface FolderDesktopConfig {
  title: string;
  accent: string; // chrome / title color
  store: FolderDesktopStore;
  drawThumb: (canvas: HTMLCanvasElement, id: string) => void;
  labelFor: (id: string) => string;
  matches: (id: string, q: string) => boolean;
  onFocus: (id: string) => void; // single-tile click → right panel follows
  onSave: () => void; // persist after any mutation
  toast?: (msg: string, err?: boolean) => void;
}

type DragPayload = { type: 'items' } | { type: 'folder'; id: string };

export class FolderDesktop {
  private cfg: FolderDesktopConfig;
  private root: HTMLDivElement | null = null;
  private grid: HTMLDivElement | null = null;
  private toolbarEl: HTMLDivElement | null = null;
  private breadcrumbEl: HTMLDivElement | null = null;
  private countEl: HTMLDivElement | null = null;

  private cwd: string | null = null;
  private selection = new Set<string>();
  private selFolder: string | null = null;
  private search = '';
  private focused: string | null = null;

  private cells = new Map<string, HTMLDivElement>();
  private dragPayload: DragPayload | null = null;
  private renamingFolder: string | null = null; // folder id whose label is being edited in place

  private marquee: HTMLDivElement | null = null;
  private marqueeStart = { x: 0, y: 0 };
  private marqueeBase = new Set<string>();
  private onMoveBound = (e: MouseEvent) => this.onMarqueeMove(e);
  private onUpBound = () => this.onMarqueeUp();

  constructor(cfg: FolderDesktopConfig) {
    this.cfg = cfg;
  }

  get isOpen(): boolean {
    return !!this.root;
  }

  /** Mark which id is the "current" (selected) one — paints its tile distinctly. */
  setFocused(id: string | null): void {
    this.focused = id;
    if (id) {
      this.selection = new Set([id]);
      this.selFolder = null;
    }
    this.highlight();
  }

  open(): void {
    if (this.root) return;
    const el = document.createElement('div');
    // Sit in the editor center: clear top bar (~41px), left Places nav (258px)
    // and the right tool dock (266px) so nothing overlaps it.
    el.style.cssText =
      'position:fixed;top:41px;left:258px;right:266px;bottom:10px;z-index:88;display:flex;' +
      'flex-direction:column;background:#0d1014f5;color:#cde;font:12px monospace;border:1px solid ' +
      this.cfg.accent +
      ';border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,.6);overflow:hidden;';
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('keyup', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation());

    // Title bar: name + global search + close.
    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a2438;';
    const title = document.createElement('div');
    title.textContent = this.cfg.title;
    title.style.cssText = `color:${this.cfg.accent};font-weight:bold;letter-spacing:1px;`;
    head.appendChild(title);
    const search = document.createElement('input');
    search.placeholder = 'search all id or name…';
    search.style.cssText =
      'flex:1;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    search.oninput = () => {
      this.search = search.value.trim().toLowerCase();
      this.render();
    };
    head.appendChild(search);
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText =
      'font:12px monospace;padding:2px 9px;cursor:pointer;border-radius:3px;background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
    close.onclick = () => this.close();
    head.appendChild(close);
    el.appendChild(head);

    // Toolbar: folder actions + breadcrumb + selection count.
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #2a2438;flex-wrap:wrap;';
    this.mkBtn('+ New Folder', () => this.newFolder());
    this.mkBtn('✎ Rename', () => this.renameFolder());
    this.mkBtn('🗑 Delete', () => this.deleteFolder());
    this.mkBtn('⚙ Auto-organize', () => {
      this.cfg.store.autoOrganize();
      this.cfg.onSave();
      this.render();
      this.cfg.toast?.('Filed all unsorted items into the base categories');
    });
    this.breadcrumbEl = document.createElement('div');
    this.breadcrumbEl.style.cssText =
      'display:flex;align-items:center;gap:3px;flex:1;flex-wrap:wrap;color:#9fb8cc;';
    this.toolbarEl.appendChild(this.breadcrumbEl);
    this.countEl = document.createElement('div');
    this.countEl.style.cssText = 'color:#4ea3ff;white-space:nowrap;';
    this.toolbarEl.appendChild(this.countEl);
    el.appendChild(this.toolbarEl);

    // Icon grid.
    this.grid = document.createElement('div');
    this.grid.style.cssText =
      'flex:1 1 auto;min-height:0;height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;' +
      'padding:10px;display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start;';
    this.grid.addEventListener(
      'wheel',
      (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.grid!.scrollTop += e.deltaY;
      },
      { passive: false }
    );
    this.grid.addEventListener('mousedown', (e) => this.onGridMouseDown(e));
    this.grid.addEventListener('dragover', (e) => e.preventDefault());
    this.grid.addEventListener('drop', (e) => {
      e.preventDefault();
      this.handleDropOn(this.cwd);
    });
    el.appendChild(this.grid);

    document.body.appendChild(el);
    this.root = el;
    this.render();
  }

  close(): void {
    window.removeEventListener('mousemove', this.onMoveBound);
    window.removeEventListener('mouseup', this.onUpBound);
    this.marquee?.remove();
    this.marquee = null;
    this.root?.remove();
    this.root = null;
    this.grid = null;
    this.toolbarEl = null;
    this.breadcrumbEl = null;
    this.countEl = null;
    this.dragPayload = null;
    this.cells.clear();
  }

  toggle(): void {
    if (this.root) this.close();
    else this.open();
  }

  /** Open the folder holding `id` and scroll its tile into view. */
  reveal(id: string): void {
    if (!this.root) return;
    if (this.search) return;
    const folder = this.cfg.store.folderOf(id);
    if (this.cwd !== folder) {
      this.cwd = folder;
      this.render();
    }
    this.cells.get(id)?.scrollIntoView({ block: 'nearest' });
  }

  // --- grid ------------------------------------------------------------------

  render(): void {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    this.cells.clear();
    if (this.search) {
      for (const id of this.cfg.store.allIds())
        if (this.cfg.matches(id, this.search)) this.grid.appendChild(this.makeItemCell(id));
    } else {
      for (const f of this.cfg.store.foldersWithParent(this.cwd))
        this.grid.appendChild(this.makeFolderTile(f));
      for (const id of this.cfg.store.itemsInFolder(this.cwd))
        this.grid.appendChild(this.makeItemCell(id));
    }
    this.highlight();
    this.updateToolbar();
  }

  private makeItemCell(id: string): HTMLDivElement {
    const cell = document.createElement('div');
    cell.dataset.item = id;
    cell.draggable = true;
    cell.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px;box-sizing:border-box;' +
      'width:108px;flex:none;border:1px solid #2a2438;border-radius:5px;cursor:pointer;background:#12131c;';
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    c.style.cssText =
      'width:94px;height:94px;flex:none;image-rendering:pixelated;background:#0c1014;border-radius:4px;pointer-events:none;';
    this.cfg.drawThumb(c, id);
    const lbl = document.createElement('div');
    lbl.textContent = this.cfg.labelFor(id);
    lbl.style.cssText =
      'font-size:9px;color:#9fb8cc;text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;';
    cell.append(c, lbl);
    cell.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else {
        this.selection = new Set([id]);
      }
      this.selFolder = null;
      this.focused = id;
      this.cfg.onFocus(id);
      this.highlight();
      this.updateToolbar();
    };
    cell.ondragstart = (e) => {
      if (!this.selection.has(id)) {
        this.selection = new Set([id]);
        this.focused = id;
        this.cfg.onFocus(id);
      }
      this.dragPayload = { type: 'items' };
      e.dataTransfer?.setData('text/plain', 'items');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    this.cells.set(id, cell);
    return cell;
  }

  private makeFolderTile(f: FolderDesktopFolder): HTMLDivElement {
    const tile = document.createElement('div');
    tile.draggable = true;
    const baseBorder = () => (this.selFolder === f.id ? '#e8c14e' : '#3a3324');
    tile.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px;box-sizing:border-box;' +
      'width:108px;flex:none;border:1px solid ' +
      baseBorder() +
      ';border-radius:5px;cursor:pointer;background:' +
      (this.selFolder === f.id ? '#2a2410' : '#1a1710') +
      ';';
    const icon = document.createElement('div');
    icon.textContent = '📁';
    icon.style.cssText =
      'width:94px;height:94px;display:flex;align-items:center;justify-content:center;font-size:52px;' +
      'line-height:1;flex:none;background:#0c1014;border-radius:4px;pointer-events:none;';
    // Label — editable IN PLACE (no modal). Double-click the name, or hit the
    // toolbar Rename button, to turn it into an input right here in the tile.
    let labelEl: HTMLElement;
    if (this.renamingFolder === f.id) {
      const input = document.createElement('input');
      input.value = f.name;
      input.style.cssText =
        'font-size:9px;color:#e8c14e;background:#0c1014;border:1px solid #e8c14e;border-radius:3px;' +
        'text-align:center;width:100%;box-sizing:border-box;outline:none;';
      // Don't let clicks/keys bubble to the tile (select/open) or the editor shell.
      input.onclick = (e) => e.stopPropagation();
      input.ondblclick = (e) => e.stopPropagation();
      input.onkeyup = (e) => e.stopPropagation();
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitRename(f.id, input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.renamingFolder = null;
          this.render();
        }
      };
      input.onblur = () => {
        if (this.renamingFolder === f.id) this.commitRename(f.id, input.value);
      };
      // Focus + select after it mounts.
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      tile.draggable = false;
      labelEl = input;
    } else {
      const lbl = document.createElement('div');
      lbl.textContent = `${f.name} (${this.cfg.store.childCount(f.id)})`;
      lbl.style.cssText =
        'font-size:9px;color:#e8c14e;text-align:center;width:100%;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;';
      // Double-click the name to rename in place; single clicks still bubble to
      // the tile (select). stopPropagation keeps it from opening the folder.
      lbl.ondblclick = (e) => {
        e.stopPropagation();
        this.beginRename(f.id);
      };
      labelEl = lbl;
    }
    tile.append(icon, labelEl);
    tile.onclick = () => {
      this.selFolder = this.selFolder === f.id ? null : f.id;
      this.render();
    };
    tile.ondblclick = () => this.openFolder(f.id);
    tile.ondragstart = (e) => {
      this.dragPayload = { type: 'folder', id: f.id };
      e.dataTransfer?.setData('text/plain', 'folder');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    tile.ondragover = (e) => {
      e.preventDefault();
      tile.style.borderColor = '#6ad08a';
    };
    tile.ondragleave = () => {
      tile.style.borderColor = baseBorder();
    };
    tile.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleDropOn(f.id);
    };
    return tile;
  }

  private openFolder(fid: string | null): void {
    this.cwd = fid;
    this.selFolder = null;
    this.selection.clear();
    this.render();
  }

  private updateToolbar(): void {
    if (this.breadcrumbEl) {
      this.breadcrumbEl.innerHTML = '';
      const path: FolderDesktopFolder[] = [];
      const all = this.allFolders();
      let cur = this.cwd;
      while (cur) {
        const node = all.find((x) => x.id === cur);
        if (!node) break;
        path.unshift(node);
        cur = node.parent;
      }
      const crumb = (label: string, fid: string | null) => {
        const a = document.createElement('span');
        a.textContent = label;
        a.style.cssText =
          'cursor:pointer;padding:1px 5px;border-radius:3px;' +
          (fid === this.cwd ? 'color:#cde;background:#2a2438;' : 'color:#7a8aa0;');
        a.onclick = () => this.openFolder(fid);
        a.ondragover = (e) => {
          e.preventDefault();
          a.style.background = '#1d3a2a';
        };
        a.ondragleave = () => {
          a.style.background = fid === this.cwd ? '#2a2438' : 'transparent';
        };
        a.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.handleDropOn(fid);
        };
        this.breadcrumbEl!.appendChild(a);
      };
      crumb('🖥 Desktop', null);
      for (const f of path) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.color = '#445';
        this.breadcrumbEl.appendChild(sep);
        crumb(f.name, f.id);
      }
    }
    if (this.countEl)
      this.countEl.textContent = this.selection.size ? `${this.selection.size} selected` : '';
  }

  /** Every folder (for breadcrumb chain walking). */
  private allFolders(): FolderDesktopFolder[] {
    const out: FolderDesktopFolder[] = [];
    const walk = (parent: string | null) => {
      for (const f of this.cfg.store.foldersWithParent(parent)) {
        out.push(f);
        walk(f.id);
      }
    };
    walk(null);
    return out;
  }

  // --- folder mutations ------------------------------------------------------

  private newFolder(): void {
    const name = window.prompt('Folder name:', 'New Folder');
    if (name == null) return;
    this.cfg.store.addFolder(name, this.cwd);
    this.cfg.onSave();
    this.render();
  }

  // Toolbar Rename → start editing the selected folder's label in place.
  private renameFolder(): void {
    if (!this.selFolder) {
      this.cfg.toast?.('Click a folder to select it first', true);
      return;
    }
    this.beginRename(this.selFolder);
  }

  private beginRename(id: string): void {
    this.selFolder = id;
    this.renamingFolder = id;
    this.render(); // makeFolderTile now draws an input for this folder
  }

  private commitRename(id: string, value: string): void {
    this.renamingFolder = null;
    const f = this.allFolders().find((x) => x.id === id);
    const name = value.trim();
    if (f && name && name !== f.name) {
      this.cfg.store.renameFolder(id, name);
      this.cfg.onSave();
    }
    this.render();
  }

  private deleteFolder(): void {
    if (!this.selFolder) {
      this.cfg.toast?.('Click a folder to select it first', true);
      return;
    }
    const f = this.allFolders().find((x) => x.id === this.selFolder);
    if (!f) return;
    if (!window.confirm(`Delete "${f.name}"? Its contents move up to the parent.`)) return;
    this.cfg.store.deleteFolder(f.id);
    this.selFolder = null;
    this.cfg.onSave();
    this.render();
  }

  private handleDropOn(target: string | null): void {
    const p = this.dragPayload;
    this.dragPayload = null;
    if (!p) return;
    if (p.type === 'items') {
      if (!this.selection.size) return;
      const n = this.selection.size;
      this.cfg.store.assignTo(this.selection, target);
      this.cfg.onSave();
      this.render();
      this.cfg.toast?.(
        `Moved ${n} ${n === 1 ? 'item' : 'items'} → ${target ? this.cfg.store.folderName(target) : 'Desktop'}`
      );
    } else {
      if (!this.cfg.store.setParent(p.id, target)) {
        this.cfg.toast?.("Can't move a folder into its own subfolder", true);
        return;
      }
      this.cfg.onSave();
      this.render();
    }
  }

  // --- marquee selection -----------------------------------------------------

  private onGridMouseDown(e: MouseEvent): void {
    if (e.target !== this.grid || e.button !== 0) return;
    e.preventDefault();
    this.marqueeStart = { x: e.clientX, y: e.clientY };
    this.marqueeBase = e.ctrlKey || e.metaKey ? new Set(this.selection) : new Set();
    this.selection = new Set(this.marqueeBase);
    this.selFolder = null;
    this.marquee = document.createElement('div');
    this.marquee.style.cssText =
      'position:fixed;border:1px solid #4ea3ff;background:#4ea3ff22;z-index:90;pointer-events:none;';
    document.body.appendChild(this.marquee);
    window.addEventListener('mousemove', this.onMoveBound);
    window.addEventListener('mouseup', this.onUpBound);
    this.highlight();
    this.updateToolbar();
  }

  private onMarqueeMove(e: MouseEvent): void {
    if (!this.marquee) return;
    const x1 = Math.min(this.marqueeStart.x, e.clientX);
    const y1 = Math.min(this.marqueeStart.y, e.clientY);
    const x2 = Math.max(this.marqueeStart.x, e.clientX);
    const y2 = Math.max(this.marqueeStart.y, e.clientY);
    this.marquee.style.left = `${x1}px`;
    this.marquee.style.top = `${y1}px`;
    this.marquee.style.width = `${x2 - x1}px`;
    this.marquee.style.height = `${y2 - y1}px`;
    const next = new Set(this.marqueeBase);
    for (const [id, cell] of this.cells) {
      const r = cell.getBoundingClientRect();
      if (!(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2)) next.add(id);
    }
    this.selection = next;
    this.highlight();
    this.updateToolbar();
  }

  private onMarqueeUp(): void {
    window.removeEventListener('mousemove', this.onMoveBound);
    window.removeEventListener('mouseup', this.onUpBound);
    this.marquee?.remove();
    this.marquee = null;
    this.highlight();
    this.updateToolbar();
  }

  private highlight(): void {
    for (const [id, cell] of this.cells) {
      const cur = id === this.focused;
      const sel = this.selection.has(id);
      cell.style.borderColor = cur ? this.cfg.accent : sel ? '#4ea3ff' : '#2a2438';
      cell.style.background = cur ? '#241a33' : sel ? '#16263a' : '#12131c';
      cell.style.outline = sel && !cur ? '1px solid #4ea3ff' : 'none';
    }
  }

  private mkBtn(label: string, fn: () => void): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
    b.onclick = fn;
    this.toolbarEl!.appendChild(b);
  }
}
