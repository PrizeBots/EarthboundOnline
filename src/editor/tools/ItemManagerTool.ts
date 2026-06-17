import { EditorTool, EditorShellApi } from '../types';
import {
  loadShops,
  allItems,
  itemType,
  itemCost,
  sellPrice,
  itemEquip,
  itemUsers,
} from '../../engine/Shop';
import {
  drawItemThumb,
  getItemName,
  hasItemSprite,
  isEquippable,
  loadItemSprites,
  loadCustomItems,
} from '../../engine/Items';
import {
  loadItemFolders,
  itemFoldersWithParent,
  folderOfItem,
  itemsInFolder,
  folderName,
  childItemCount,
  addItemFolder,
  renameItemFolder,
  deleteItemFolder,
  assignItemsTo,
  setItemFolderParent,
  autoOrganizeItems,
  allItemIds,
  saveItemFolders,
} from '../../engine/ItemFolders';
import { FolderDesktop, FolderDesktopStore } from '../FolderDesktop';
import { openSpriteEditor } from '../../engine/spriteEditor';
import { registerSaveHandler } from '../registry';

// Item Manager — the master catalog of every game item/weapon (shops.json),
// organized like the Entity Manager: a file-explorer "desktop" where items live
// in category folders (Food, Weapons, Drinks…) you sort by drag & drop. Those
// same folders feed the Sprite Editor's item-mode category tabs, so both tools
// agree on the taxonomy. The right panel shows the focused item's catalog meta
// and hands off to the Sprite Editor to draw its held art
// (overrides/item_sprites.json); the folder layout saves to item_folders.json.
class ItemManagerTool implements EditorTool {
  id = 'item-manager';
  name = 'Item Manager';
  description =
    'Every item/weapon, sorted into category folders. Edits hand off to the Sprite Editor.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private itemId = '';
  private panel: HTMLDivElement | null = null;
  private detailsEl: HTMLDivElement | null = null;
  private desktop: FolderDesktop | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('item-folders', () => saveItemFolders());
    void this.loadAndBuild();
  }

  deactivate(): void {
    this.desktop?.close();
    this.desktop = null;
    this.panel?.remove();
    this.panel = null;
    this.detailsEl = null;
  }

  private async loadAndBuild(): Promise<void> {
    await loadShops(); // catalog (names/costs/types)
    await loadItemSprites(); // authored held art (for previews)
    await loadCustomItems(); // admin-minted items
    await loadItemFolders(); // the category desktop layout (seeds on first run)
    if (!this.itemId) this.itemId = allItemIds()[0] ?? allItems()[0]?.id ?? '';
    this.buildPanel();
    this.buildDesktop();
    this.desktop?.open(); // big center gallery, open by default (like Entity Manager)
    this.refreshDetails();
  }

  /** Adapter: expose ItemFolders as the generic desktop's store. */
  private store(): FolderDesktopStore {
    return {
      foldersWithParent: (p) => itemFoldersWithParent(p),
      folderOf: (id) => folderOfItem(id),
      itemsInFolder: (p) => itemsInFolder(p),
      folderName: (id) => folderName(id),
      childCount: (id) => childItemCount(id),
      addFolder: (name, parent) => addItemFolder(name, parent),
      renameFolder: (id, name) => renameItemFolder(id, name),
      deleteFolder: (id) => deleteItemFolder(id),
      assignTo: (ids, folder) => assignItemsTo(ids, folder),
      setParent: (child, parent) => setItemFolderParent(child, parent),
      autoOrganize: () => autoOrganizeItems(),
      allIds: () => allItemIds(),
    };
  }

  private buildDesktop(): void {
    this.desktop = new FolderDesktop({
      title: 'ITEM DESKTOP',
      accent: '#d8a23a',
      store: this.store(),
      drawThumb: (c, id) => drawItemThumb(c, id),
      labelFor: (id) => `${id} ${getItemName(id) ?? ''}`.trim(),
      matches: (id, q) => `${id} ${(getItemName(id) ?? '').toLowerCase()}`.includes(q),
      onFocus: (id) => {
        this.itemId = id;
        this.refreshDetails();
      },
      onSave: () => this.shell?.markDirty('item-folders'),
      toast: (m, err) => this.shell?.toast(m, err),
    });
    this.desktop.setFocused(this.itemId);
  }

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #d8a23a;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'ITEM MANAGER';
    title.style.cssText = 'color:#d8a23a;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    const hint = document.createElement('div');
    hint.textContent =
      'Drag items between category folders in the desktop. Categories also drive the Sprite Editor.';
    hint.style.cssText = 'color:#8a93a8;font-size:10px;line-height:1.4;';
    this.panel.appendChild(hint);

    this.mkBtn('🖥 Open item desktop (center)', () => this.desktop?.toggle(), this.panel, true);

    this.detailsEl = document.createElement('div');
    this.detailsEl.style.cssText =
      'display:flex;flex-direction:column;gap:4px;color:#9fb8cc;font-size:11px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.detailsEl);

    const edit = document.createElement('button');
    edit.textContent = '✎ Edit sprite in Sprite Editor →';
    edit.style.cssText =
      'font:11px monospace;padding:3px 8px;cursor:pointer;border-radius:3px;' +
      'background:#3a2e10;color:#d8a23a;border:1px solid #d8a23a;';
    edit.onclick = () => {
      if (this.itemId) void openSpriteEditor({ focusItem: this.itemId });
    };
    this.panel.appendChild(edit);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refreshDetails(): void {
    if (!this.detailsEl) return;
    const id = this.itemId;
    const type = itemType(id);
    const gear = isEquippable(type);
    const eq = itemEquip(id);
    const users = itemUsers(id);
    const sprite = hasItemSprite(id);
    const cat = folderOfItem(id);
    this.detailsEl.innerHTML = '';
    const rows: [string, string][] = [
      ['name', getItemName(id) ?? '(unnamed)'],
      ['id', id || '—'],
      ['category', cat ? folderName(cat) : 'Desktop (unsorted)'],
      ['buy / sell', `$${itemCost(id)} / $${sellPrice(id)}`],
      ['type', `${type}${gear ? ' (equippable gear)' : ' (consumable / key)'}`],
    ];
    if (eq) {
      rows.push(['equip slot', eq.slot]);
      if (eq.slot === 'weapon') rows.push(['offense', `+${eq.offense ?? 0}`]);
      else rows.push(['defense', `+${eq.defense ?? 0}`]);
    }
    rows.push(['can equip/use', users.length ? users.join(', ') : 'anyone']);
    rows.push(['held sprite', sprite ? 'set ✓' : gear ? 'NEEDS ART' : 'none']);
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.textContent = `${k}: ${v}`;
      if (k === 'held sprite' && v === 'NEEDS ART') r.style.color = '#e07820';
      this.detailsEl.appendChild(r);
    }
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
      'font:11px monospace;padding:4px 8px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#3a2e10;color:#d8a23a;border:1px solid #d8a23a;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }
}

export const itemManagerTool = new ItemManagerTool();
