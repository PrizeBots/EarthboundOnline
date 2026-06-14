import { EditorTool, EditorShellApi } from '../types';
import { createSpritePicker, SpritePicker } from '../../engine/SpritePicker';
import { loadShops, allItems, itemType, itemCost, sellPrice, itemEquip, itemUsers } from '../../engine/Shop';
import { drawItemThumb, getItemName, hasItemSprite, isEquippable, loadItemSprites } from '../../engine/Items';
import { openSpriteEditor } from '../../engine/SpriteEditor';

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
  private panel: HTMLDivElement | null = null;
  private picker: SpritePicker | null = null;
  private detailsEl: HTMLDivElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadAndBuild();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.picker = null;
  }

  private async loadAndBuild(): Promise<void> {
    await loadShops();        // catalog (names/costs/types)
    await loadItemSprites();  // authored held art (for previews)
    const items = allItems();
    if (!this.itemId) this.itemId = items[0]?.id ?? '';
    this.buildPanel(items.map((i) => i.id));
    this.refreshDetails();
  }

  private buildPanel(ids: string[]): void {
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

    // The catalog dropdown — sprite preview + quick search, every game item.
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
    this.panel.appendChild(this.picker.el);

    this.detailsEl = document.createElement('div');
    this.detailsEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;color:#9fb8cc;font-size:11px;';
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
    rows.push(['held sprite', sprite ? 'set ✓' : (gear ? 'NEEDS ART' : 'none')]);
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.textContent = `${k}: ${v}`;
      if (k === 'held sprite' && v === 'NEEDS ART') r.style.color = '#e07820';
      this.detailsEl.appendChild(r);
    }
  }
}

export const itemManagerTool = new ItemManagerTool();
