import { EditorTool, EditorShellApi } from '../types';
import { FolderDesktop, FolderDesktopStore, FolderDesktopFolder } from '../FolderDesktop';
import { loadJSON, loadImage } from '../../engine/AssetLoader';
import { addCustomSprite, customSpritesDoc } from '../../engine/CustomSprites';
import { getNameOverrides, getSpriteName } from '../../engine/SpriteNames';
import {
  addCustomItem,
  customItemsDoc,
  itemSpritesDoc,
  itemPixelsFromImage,
  setItemSpriteData,
} from '../../engine/Items';
import { saveOverride, loadOverride } from '../saveOverride';
import { entityManagerTool } from './EntityManagerTool';
import { itemManagerTool } from './ItemManagerTool';

// Source Assets — a VIEW-ONLY browser of every graphic CoilSnake decompiled from
// the ROM, including art we never imported into the game (battle sprites, battle
// backgrounds, swirls, title/logos, town maps, cutscene anims). A discovery aid:
// scan the full ROM for anything worth turning into an entity/object later, then
// we build the cut/import tooling. Reuses FolderDesktop (categories = folders),
// fed by public/assets/rom_sources/ (staged by tools/copy_rom_sources.py).

interface RomAsset {
  id: string; // path sans ".png", e.g. "BattleSprites/000"
  folder: string; // category, e.g. "BattleSprites"
  file: string; // served path under /assets/rom_sources/, e.g. "BattleSprites/000.png"
  w: number;
  h: number;
}
interface RomIndex {
  categories: { id: string; name: string; count: number }[];
  assets: RomAsset[];
}

const BASE = '/assets/rom_sources/';

class SourceAssetsTool implements EditorTool {
  id = 'source-assets';
  name = 'Source Assets';
  description = 'Browse every ROM graphic (incl. un-imported battle/UI/cutscene art).';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private index: RomIndex = { categories: [], assets: [] };
  private byId = new Map<string, RomAsset>();
  private byFolder = new Map<string, RomAsset[]>();
  private desktop: FolderDesktop | null = null;
  private images = new Map<string, HTMLImageElement>(); // file -> loaded (thumb cache)
  // Authored category display-name overrides (id -> custom name) — pure metadata,
  // persisted to overrides/source_folders.json. Lets the admin rename the ROM
  // source categories without touching the staged ROM tree.
  private folderNameOv = new Map<string, string>();
  private panel: HTMLDivElement | null = null;
  private detailEl: HTMLDivElement | null = null;
  private selected: string | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadAndBuild();
  }

  deactivate(): void {
    this.desktop?.close();
    this.desktop = null;
    this.panel?.remove();
    this.panel = null;
    this.detailEl = null;
    this.images.clear();
  }

  private async loadAndBuild(): Promise<void> {
    this.index = await loadJSON<RomIndex>(`${BASE}index.json`).catch(() => null as never);
    if (!this.index) {
      this.index = { categories: [], assets: [] };
      this.shell?.toast('No ROM sources staged — run tools/copy_rom_sources.py', true);
    }
    // Authored category renames (id -> name). 404 / absent → no renames.
    const ov = await loadOverride<{ names?: Record<string, string> }>('source_folders.json').catch(
      () => null
    );
    this.folderNameOv = new Map(Object.entries(ov?.names ?? {}));
    this.byId.clear();
    this.byFolder.clear();
    for (const a of this.index.assets) {
      this.byId.set(a.id, a);
      const list = this.byFolder.get(a.folder) ?? [];
      list.push(a);
      this.byFolder.set(a.folder, list);
    }
    this.buildPanel();
    this.buildDesktop();
    this.desktop?.open();
  }

  /** Category display name: authored override (id -> name) over the ROM base. */
  private categoryName(id: string): string {
    return this.folderNameOv.get(id) ?? this.index.categories.find((c) => c.id === id)?.name ?? id;
  }

  /**
   * Store over the ROM source tree. The TREE itself is read-only (you can't add/
   * move/delete ROM categories), but category DISPLAY NAMES are editable and
   * persist to overrides/source_folders.json.
   */
  private store(): FolderDesktopStore {
    const folders = (): FolderDesktopFolder[] =>
      this.index.categories.map((c) => ({ id: c.id, name: this.categoryName(c.id), parent: null }));
    return {
      foldersWithParent: (parent) => (parent === null ? folders() : []),
      folderOf: (id) => this.byId.get(id)?.folder ?? null,
      itemsInFolder: (parent) =>
        parent === null ? [] : (this.byFolder.get(parent) ?? []).map((a) => a.id),
      folderName: (id) => this.categoryName(id),
      childCount: (folderId) => this.byFolder.get(folderId)?.length ?? 0,
      // The ROM source tree's STRUCTURE isn't editable — only category names are.
      addFolder: () => '',
      renameFolder: (id, name) => {
        const base = this.index.categories.find((c) => c.id === id)?.name ?? id;
        const next = name.trim();
        if (next && next !== base) this.folderNameOv.set(id, next);
        else this.folderNameOv.delete(id); // back to the ROM default — drop the override
      },
      deleteFolder: () => {},
      assignTo: () => {},
      setParent: () => false,
      autoOrganize: () => {},
      allIds: () => this.index.assets.map((a) => a.id),
    };
  }

  private buildDesktop(): void {
    this.desktop = new FolderDesktop({
      title: 'ROM SOURCE ASSETS',
      accent: '#4ec9b0',
      store: this.store(),
      drawThumb: (c, id) => this.drawThumb(c, id),
      labelFor: (id) => {
        const a = this.byId.get(id);
        if (!a) return id;
        const base = a.file.split('/').pop() ?? a.file;
        // Sprite groups are stored by NUMBER (SpriteGroups/074.png) — show their
        // human name (spriteNames.json / admin renames) so they're findable.
        const nm = this.spriteGroupName(a);
        return nm ? `${nm}  ·  #${this.spriteGroupId(a)} ${a.w}×${a.h}` : `${base}  ${a.w}×${a.h}`;
      },
      // Search matches the path AND, for sprite groups, the human name — so
      // "police", "cop", "car" find SpriteGroups/074, /075, /255, etc.
      matches: (id, q) => {
        const a = this.byId.get(id);
        const nm = a ? this.spriteGroupName(a) : null;
        return `${id} ${nm ?? ''}`.toLowerCase().includes(q);
      },
      onFocus: (id) => {
        this.selected = id;
        this.refreshDetail();
      },
      onSave: () => {
        // Persist the category-name overrides (id -> name); pure metadata.
        void saveOverride('source_folders.json', {
          version: 1,
          names: Object.fromEntries(this.folderNameOv),
        });
      },
      toast: (m, err) => this.shell?.toast(m, err),
    });
  }

  /** Draw a ROM image fit into the thumb canvas (async load, pixelated). */
  /** The numeric sprite-group id for a `SpriteGroups/NNN.png` asset, else null. */
  private spriteGroupId(a: RomAsset): number | null {
    if (a.folder !== 'SpriteGroups') return null;
    const base = (a.file.split('/').pop() ?? '').replace(/\.png$/i, '');
    const gid = parseInt(base, 10);
    return Number.isFinite(gid) ? gid : null;
  }

  /** Human name for a sprite-group asset (spriteNames.json + admin renames), or
   *  null for non-sprite-group assets / unnamed groups. */
  private spriteGroupName(a: RomAsset): string | null {
    const gid = this.spriteGroupId(a);
    return gid == null ? null : getSpriteName(gid);
  }

  private drawThumb(canvas: HTMLCanvasElement, id: string): void {
    const a = this.byId.get(id);
    if (!a) return;
    const paint = (img: HTMLImageElement) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 4);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    };
    const cached = this.images.get(a.file);
    if (cached?.complete && cached.naturalWidth) {
      paint(cached);
      return;
    }
    const img = cached ?? new Image();
    if (!cached) {
      img.src = `${BASE}${a.file}`;
      this.images.set(a.file, img);
    }
    img.onload = () => paint(img);
  }

  // --- right-dock panel (selected asset detail) ----------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #4ec9b0;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'SOURCE ASSETS';
    title.style.cssText = 'color:#4ec9b0;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#9fb8cc;font-size:11px;line-height:1.5;';
    hint.textContent =
      `${this.index.assets.length} ROM graphics in ${this.index.categories.length} categories. ` +
      'Pick one, then create a new entity or item from it below.';
    this.panel.appendChild(hint);

    this.detailEl = document.createElement('div');
    this.detailEl.style.cssText =
      'display:flex;flex-direction:column;gap:6px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.detailEl);

    this.shell!.panelHost.appendChild(this.panel);
    this.refreshDetail();
  }

  private refreshDetail(): void {
    if (!this.detailEl) return;
    this.detailEl.innerHTML = '';
    const a = this.selected ? this.byId.get(this.selected) : null;
    if (!a) {
      this.detailEl.textContent = 'Click an asset to preview it.';
      return;
    }
    // Large pixelated preview (native <img>, capped width).
    const img = document.createElement('img');
    img.src = `${BASE}${a.file}`;
    img.style.cssText =
      'max-width:100%;align-self:center;image-rendering:pixelated;background:#0c1014;border:1px solid #243;border-radius:4px;';
    this.detailEl.appendChild(img);

    const info = document.createElement('div');
    info.style.cssText = 'color:#9fb8cc;font-size:11px;line-height:1.5;word-break:break-all;';
    info.innerHTML =
      `<b style="color:#cde">${a.folder}</b><br>` +
      `${a.file.split('/').pop()}  ·  ${a.w}×${a.h}px<br>` +
      `<span style="color:#667">${BASE}${a.file}</span>`;
    this.detailEl.appendChild(info);

    // Open the raw image in a new tab (full-res inspection).
    const open = document.createElement('button');
    open.textContent = '↗ Open full image';
    open.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;background:#1d2530;color:#cde;border:1px solid #3a4a5a;align-self:flex-start;';
    open.title = 'Open the raw ROM graphic in a new tab at full resolution.';
    open.onclick = () => window.open(`${BASE}${a.file}`, '_blank');
    this.detailEl.appendChild(open);

    // Create-from-asset actions. Each opens a small inline name form; OK mints
    // the item/entity using this sprite and hands off to its manager tool.
    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;flex-direction:column;gap:6px;border-top:1px solid #2a3540;padding-top:8px;margin-top:2px;';
    const head = document.createElement('div');
    head.textContent = 'CREATE FROM THIS ASSET';
    head.style.cssText = 'color:#4ec9b0;font-size:11px;letter-spacing:0.5px;';
    actions.appendChild(head);
    this.mkBtn(
      '➕ New Entity from this',
      () => this.openCreateForm(a, 'entity', actions),
      actions,
      'Mint a standalone custom entity sprite group from this graphic and open it in the Entity Manager.'
    );
    this.mkBtn(
      '➕ New Item from this',
      () => this.openCreateForm(a, 'item', actions),
      actions,
      'Mint a custom item using this graphic as its 16x16 held art and open it in the Item Manager.'
    );
    this.detailEl.appendChild(actions);
  }

  /** A small accent button (matches the panel chrome). */
  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    tip?: string
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    if (tip) b.title = tip;
    b.style.cssText =
      'font:11px monospace;padding:4px 8px;cursor:pointer;border-radius:3px;text-align:left;' +
      'background:#11302b;color:#4ec9b0;border:1px solid #2f6f63;';
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  /** Inline name form (replaces the action buttons until OK/Cancel). For items
   *  the kind defaults to a consumable — set the slot/stats later in the Item
   *  Manager, exactly like any other item. */
  private openCreateForm(a: RomAsset, kind: 'entity' | 'item', host: HTMLDivElement): void {
    host.innerHTML = '';
    const head = document.createElement('div');
    head.textContent = kind === 'entity' ? 'NEW ENTITY' : 'NEW ITEM';
    head.style.cssText = 'color:#4ec9b0;font-size:11px;letter-spacing:0.5px;';
    host.appendChild(head);

    const input = document.createElement('input');
    // Seed the name from the asset filename (sans extension), title-ish.
    const base = (a.file.split('/').pop() ?? a.id).replace(/\.png$/i, '');
    input.value = base;
    input.placeholder = 'name';
    input.title =
      kind === 'entity' ? 'Display name for the new entity.' : 'Display name for the new item.';
    input.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    host.appendChild(input);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;';
    const ok = this.mkBtn(
      'OK',
      () => {
        const name = input.value.trim() || base;
        ok.disabled = true;
        ok.textContent = 'Creating…';
        void (kind === 'entity' ? this.createEntity(a, name) : this.createItem(a, name)).catch(
          (e) => {
            this.shell?.toast(`Create failed: ${e}`, true);
            this.refreshDetail();
          }
        );
      },
      row,
      kind === 'entity' ? 'Create the entity with this name.' : 'Create the item with this name.'
    );
    this.mkBtn(
      'Cancel',
      () => this.refreshDetail(),
      row,
      'Discard and go back to the asset detail.'
    );
    host.appendChild(row);
    input.focus();
    input.select();
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ok.click();
      else if (e.key === 'Escape') this.refreshDetail();
    };
  }

  /** Mint a standalone custom entity sprite group from this asset, persist it,
   *  and open the Entity Manager focused on it (editable like any other). */
  private async createEntity(a: RomAsset, name: string): Promise<void> {
    const id = await addCustomSprite(name, a.file);
    await saveOverride('custom_sprites.json', customSpritesDoc());
    await saveOverride('names.json', getNameOverrides()); // persist the display name
    this.shell?.toast(`Created entity "${name}" → sprite #${id}`);
    entityManagerTool.requestEntity(id);
    this.shell?.openTool('entity-manager');
  }

  /** Mint a custom item, quantize this asset into its 16×16 held art, persist
   *  both files, and open the Item Manager focused on it. */
  private async createItem(a: RomAsset, name: string): Promise<void> {
    const id = addCustomItem(name);
    const img = await loadImage(`${BASE}${a.file}`);
    const pixels = itemPixelsFromImage(img, a.w, a.h);
    setItemSpriteData(id, { pixels, frames: [pixels], grip: { x: 8, y: 14 } });
    await saveOverride('custom_items.json', customItemsDoc());
    await saveOverride('item_sprites.json', itemSpritesDoc());
    this.shell?.toast(`Created item "${name}" (${id})`);
    itemManagerTool.requestItem(id);
    this.shell?.openTool('item-manager');
  }
}

export const sourceAssetsTool = new SourceAssetsTool();
