import { EditorTool, EditorShellApi } from '../types';
import { createSpritePicker, SpritePicker } from '../../engine/SpritePicker';
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
  customItemIds,
  HELD_ITEM_IDS,
} from '../../engine/Items';
import { openSpriteEditor } from '../../engine/SpriteEditor';

// The catalog is split into the same tabs as the Sprite Editor's item picker:
// Weapons/Items come from the shops catalog (a weapon is gear whose equip slot
// is 'weapon'); Custom holds the legacy seed items plus admin-minted ones.
type ItemTab = 'weapons' | 'items' | 'custom';
function idsForTab(tab: ItemTab): string[] {
  if (tab === 'custom') {
    const seen = new Set<string>();
    return [...HELD_ITEM_IDS, ...customItemIds()].filter((id) =>
      seen.has(id) ? false : seen.add(id)
    );
  }
  const isWeapon = (id: string) => itemEquip(id)?.slot === 'weapon';
  return allItems()
    .filter((i) => (tab === 'weapons' ? isWeapon(i.id) : !isWeapon(i.id)))
    .map((i) => i.id);
}
/** The tab a given item id belongs to (custom seeds + minted items win). */
function tabForItem(id: string): ItemTab {
  if (HELD_ITEM_IDS.includes(id) || customItemIds().includes(id)) return 'custom';
  return itemEquip(id)?.slot === 'weapon' ? 'weapons' : 'items';
}

// Item Manager — the master list of every game item/weapon (shops.json catalog).
// Each item carries a held sprite (so players see each other's gear); this tool
// browses them with the shared sprite-preview dropdown + quick search, shows the
// catalog metadata, and hands off to the Sprite Editor's item mode to draw/edit
// the held art (the same per-item art the game renders). The art itself is
// saved by the Sprite Editor to overrides/item_sprites.json.
class ItemManagerTool implements EditorTool {
  id = 'item-manager';
  name = 'Item Manager';
  description = 'Every item/weapon + its held sprite. Edits hand off to the Sprite Editor.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private itemId = '';
  private tab: ItemTab = 'weapons';
  private panel: HTMLDivElement | null = null;
  private picker: SpritePicker | null = null;
  private pickerHost: HTMLDivElement | null = null;
  private tabsEl: HTMLDivElement | null = null;
  private detailsEl: HTMLDivElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadAndBuild();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.picker = null;
    this.pickerHost = null;
    this.tabsEl = null;
  }

  private async loadAndBuild(): Promise<void> {
    await loadShops(); // catalog (names/costs/types)
    await loadItemSprites(); // authored held art (for previews)
    await loadCustomItems(); // admin-minted items (for the Custom tab)
    if (!this.itemId) this.itemId = idsForTab('weapons')[0] ?? allItems()[0]?.id ?? '';
    this.tab = this.itemId ? tabForItem(this.itemId) : 'weapons';
    this.buildPanel();
    this.refreshDetails();
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

    // Weapons / Items / Custom tabs — same split as the Sprite Editor's picker.
    this.tabsEl = document.createElement('div');
    this.tabsEl.style.cssText = 'display:flex;gap:4px;';
    for (const [t, label] of [
      ['weapons', 'Weapons'],
      ['items', 'Items'],
      ['custom', 'Custom'],
    ] as [ItemTab, string][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.itab = t;
      b.style.cssText =
        'flex:1;font:11px monospace;padding:4px 0;background:#2a2a3a;color:#ddd;' +
        'border:1px solid #444;border-radius:3px;cursor:pointer;';
      b.onclick = () => this.selectTab(t);
      this.tabsEl.appendChild(b);
    }
    this.panel.appendChild(this.tabsEl);

    // The catalog dropdown — sprite preview + quick search, rebuilt per tab.
    this.pickerHost = document.createElement('div');
    this.panel.appendChild(this.pickerHost);
    this.rebuildPicker();
    this.highlightTabs();

    this.detailsEl = document.createElement('div');
    this.detailsEl.style.cssText =
      'display:flex;flex-direction:column;gap:4px;color:#9fb8cc;font-size:11px;';
    this.panel.appendChild(this.detailsEl);

    const edit = document.createElement('button');
    edit.textContent = '✎ Edit sprite in Sprite Editor →';
    edit.style.cssText =
      'font:11px monospace;padding:3px 8px;cursor:pointer;border-radius:3px;' +
      'background:#3a2e10;color:#d8a23a;border:1px solid #d8a23a;';
    edit.onclick = () => {
      // Hand off to the Sprite Editor's item mode focused on this item.
      void openSpriteEditor({ focusItem: this.itemId });
    };
    this.panel.appendChild(edit);

    this.shell!.panelHost.appendChild(this.panel);
  }

  /** Switch tab, snap the selection to that tab's first item, and rebuild. */
  private selectTab(t: ItemTab): void {
    if (t === this.tab) return;
    this.tab = t;
    const ids = idsForTab(t);
    if (!ids.includes(this.itemId)) this.itemId = ids[0] ?? '';
    this.rebuildPicker();
    this.highlightTabs();
    this.refreshDetails();
  }

  /** (Re)build the dropdown for the current tab's item list. */
  private rebuildPicker(): void {
    if (!this.pickerHost) return;
    this.pickerHost.innerHTML = '';
    const ids = idsForTab(this.tab);
    this.picker = createSpritePicker({
      sections: [{ values: ids }],
      initial: this.itemId || ids[0] || '',
      labelFor: (v) => `${v} ${getItemName(v) ?? ''}`.trim(),
      drawThumb: drawItemThumb,
      onSelect: (v) => {
        this.itemId = v;
        this.refreshDetails();
      },
    });
    this.pickerHost.appendChild(this.picker.el);
  }

  private highlightTabs(): void {
    if (!this.tabsEl) return;
    for (const b of Array.from(this.tabsEl.children) as HTMLButtonElement[]) {
      const on = b.dataset.itab === this.tab;
      b.style.background = on ? '#3a4a6a' : '#2a2a3a';
      b.style.borderColor = on ? '#6af' : '#444';
    }
  }

  private refreshDetails(): void {
    if (!this.detailsEl) return;
    const id = this.itemId;
    const type = itemType(id);
    const gear = isEquippable(type);
    const eq = itemEquip(id);
    const users = itemUsers(id);
    const sprite = hasItemSprite(id);
    this.detailsEl.innerHTML = '';
    const rows: [string, string][] = [
      ['name', getItemName(id) ?? '(unnamed)'],
      ['id', id],
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
}

export const itemManagerTool = new ItemManagerTool();
