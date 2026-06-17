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
import { saveOverride, loadOverride } from '../saveOverride';

// Status ids selectable in the inflict editor — KEEP IN SYNC with server/status.js
// STATUS (the wire-stable strings the inflict model + status engine use).
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'paralysis', label: 'Paralysis (numb)' },
  { value: 'diamond', label: 'Diamondized' },
  { value: 'sleep', label: 'Asleep' },
  { value: 'strange', label: 'Feeling strange' },
  { value: 'possessed', label: 'Possessed' },
  { value: 'noPsi', label: "Can't concentrate" },
  { value: 'crying', label: 'Crying' },
  { value: 'poison', label: 'Poisoned' },
  { value: 'nauseous', label: 'Nauseous' },
  { value: 'sunstroke', label: 'Sunstroke' },
  { value: 'cold', label: 'Cold' },
  { value: 'homesick', label: 'Homesick' },
];

/** One status proc a weapon carries. */
interface InflictEntry {
  type: string;
  chance: number;
}
/** Per-item authoring overrides (overrides/equip_stats.json). Every field is
 *  optional and layers over the ROM item table server-side (see shops.js). */
interface ItemOverride {
  offense?: number;
  defense?: number;
  crit?: number;
  dodge?: number;
  attackSpeed?: number;
  cost?: number;
  heal?: number;
  inflict?: InflictEntry[];
}

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
  private statsEl: HTMLDivElement | null = null;
  private desktop: FolderDesktop | null = null;
  // Per-item stat overrides (overrides/equip_stats.json), keyed by item id.
  private overrides: Record<string, ItemOverride> = {};

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('item-folders', () => saveItemFolders());
    registerSaveHandler('item-stats', () => this.saveStats());
    void this.loadAndBuild();
  }

  deactivate(): void {
    this.desktop?.close();
    this.desktop = null;
    this.panel?.remove();
    this.panel = null;
    this.detailsEl = null;
    this.statsEl = null;
  }

  // --- per-item stat overrides (equip_stats.json) -------------------------------------

  /** Save the override map (only non-empty entries) to equip_stats.json. */
  private async saveStats(): Promise<void> {
    // Drop any entries that ended up empty so the file stays clean.
    const out: Record<string, ItemOverride> = {};
    for (const [id, ov] of Object.entries(this.overrides)) {
      if (ov && Object.keys(ov).length) out[id] = ov;
    }
    this.overrides = out;
    await saveOverride('equip_stats.json', out);
    this.shell?.clearDirty('item-stats');
    this.shell?.toast(
      'Saved item stats → equip_stats.json (combat values apply on server restart)'
    );
  }

  /** The override record for an item (creating an empty one on demand). */
  private ovOf(id: string): ItemOverride {
    if (!this.overrides[id]) this.overrides[id] = {};
    return this.overrides[id];
  }

  /** Set (number) or clear (undefined/'') one scalar override field. Clearing it
   *  reverts the item to its ROM/base value; an emptied record is pruned on save. */
  private setOv(id: string, key: keyof ItemOverride, val: number | undefined): void {
    const ov = this.ovOf(id);
    if (val === undefined || Number.isNaN(val)) delete ov[key];
    else (ov[key] as number) = val;
    if (!Object.keys(ov).length) delete this.overrides[id];
    this.shell?.markDirty('item-stats');
  }

  private setInflict(id: string, list: InflictEntry[]): void {
    const ov = this.ovOf(id);
    if (list.length) ov.inflict = list;
    else delete ov.inflict; // no rows → weapon falls back to baseline paralysis
    if (!Object.keys(ov).length) delete this.overrides[id];
    this.shell?.markDirty('item-stats');
  }

  private async loadAndBuild(): Promise<void> {
    await loadShops(); // catalog (names/costs/types)
    await loadItemSprites(); // authored held art (for previews)
    await loadCustomItems(); // admin-minted items
    await loadItemFolders(); // the category desktop layout (seeds on first run)
    this.overrides = (await loadOverride<Record<string, ItemOverride>>('equip_stats.json')) ?? {};
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

    // Editable stat overrides (equip_stats.json), rebuilt per selected item.
    this.statsEl = document.createElement('div');
    this.statsEl.style.cssText =
      'display:flex;flex-direction:column;gap:5px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.statsEl);

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
    // Read-only structural meta (name/id/category/type/slot/users/sprite). The
    // editable numbers live in the stats section below; show them there.
    this.detailsEl.innerHTML = '';
    const rows: [string, string][] = [
      ['name', getItemName(id) ?? '(unnamed)'],
      ['id', id || '—'],
      ['category', cat ? folderName(cat) : 'Desktop (unsorted)'],
      ['type', `${type}${gear ? ' (equippable gear)' : ' (consumable / key)'}`],
    ];
    if (eq) rows.push(['equip slot', eq.slot]);
    rows.push(['can equip/use', users.length ? users.join(', ') : 'anyone']);
    rows.push(['held sprite', sprite ? 'set ✓' : gear ? 'NEEDS ART' : 'none']);
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.textContent = `${k}: ${v}`;
      if (k === 'held sprite' && v === 'NEEDS ART') r.style.color = '#e07820';
      this.detailsEl.appendChild(r);
    }
    this.refreshStats();
  }

  /** Build the editable stat-override form for the selected item. Inputs show the
   *  current override value, or are empty with the ROM/base value as placeholder;
   *  clearing an input reverts to base. All writes go to equip_stats.json. */
  private refreshStats(): void {
    if (!this.statsEl) return;
    const id = this.itemId;
    this.statsEl.innerHTML = '';
    if (!id) return;
    const eq = itemEquip(id);
    const ov = this.overrides[id] ?? {};

    const title = document.createElement('div');
    title.textContent = 'STAT OVERRIDES';
    title.style.cssText = 'color:#d8a23a;font-size:11px;letter-spacing:0.5px;';
    this.statsEl.appendChild(title);

    // Cost (every item) + sell readout (half of effective cost).
    this.mkNumRow('buy $', ov.cost, itemCost(id), 0, undefined, false, (v) =>
      this.setOv(id, 'cost', v)
    );
    const sell = document.createElement('div');
    sell.textContent = `sell: $${sellPrice(id)}  (half of buy)`;
    sell.style.cssText = 'color:#667;font-size:10px;margin-left:62px;';
    this.statsEl.appendChild(sell);

    if (eq) {
      if (eq.slot === 'weapon') {
        this.mkNumRow('offense', ov.offense, eq.offense ?? 0, 0, undefined, false, (v) =>
          this.setOv(id, 'offense', v)
        );
        this.mkNumRow('atk speed', ov.attackSpeed, 1, 0.1, undefined, true, (v) =>
          this.setOv(id, 'attackSpeed', v)
        );
      } else {
        this.mkNumRow('defense', ov.defense, eq.defense ?? 0, 0, undefined, false, (v) =>
          this.setOv(id, 'defense', v)
        );
      }
      // crit/dodge apply to any gear (percent points, 0..100).
      this.mkNumRow('crit %', ov.crit, 0, 0, 100, false, (v) => this.setOv(id, 'crit', v));
      this.mkNumRow('dodge %', ov.dodge, 0, 0, 100, false, (v) => this.setOv(id, 'dodge', v));
      if (eq.slot === 'weapon') this.buildInflictEditor(id, ov);
    } else {
      // Consumables: heal amount (HP restored on use). Base heal is server-side
      // (a few known items), so the placeholder can't show it — leave blank.
      this.mkNumRow('heal HP', ov.heal, 0, 0, undefined, false, (v) => this.setOv(id, 'heal', v));
      const note = document.createElement('div');
      note.textContent = 'Combat stats (offense/crit/inflict…) apply to equippable gear only.';
      note.style.cssText = 'color:#667;font-size:10px;line-height:1.4;';
      this.statsEl.appendChild(note);
    }
  }

  /** A labelled number input. `cur` = current override (undefined = none), shown
   *  as the value; `base` is the placeholder (the ROM/effective default). Empty
   *  input clears the override (revert to base). `float` keeps fractional values. */
  private mkNumRow(
    label: string,
    cur: number | undefined,
    base: number,
    min: number,
    max: number | undefined,
    float: boolean,
    onSet: (v: number | undefined) => void
  ): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'width:56px;color:#9fb8cc;';
    row.appendChild(l);
    const i = document.createElement('input');
    i.type = 'number';
    i.value = cur === undefined ? '' : String(cur);
    i.placeholder = `${base}`;
    i.style.cssText =
      'width:72px;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    i.onchange = () => {
      const raw = i.value.trim();
      if (raw === '') {
        onSet(undefined);
        return;
      }
      let n = float ? parseFloat(raw) : parseInt(raw, 10);
      if (Number.isNaN(n)) {
        onSet(undefined);
        i.value = '';
        return;
      }
      n = Math.max(min, n);
      if (max != null) n = Math.min(max, n);
      i.value = String(n);
      onSet(n);
    };
    row.appendChild(i);
    const rev = document.createElement('span');
    rev.textContent = cur === undefined ? '(base)' : '•';
    rev.style.cssText = `color:${cur === undefined ? '#667' : '#d8a23a'};font-size:10px;`;
    row.appendChild(rev);
    this.statsEl!.appendChild(row);
  }

  /** The status-inflict list editor for a weapon: rows of {status, chance%} plus
   *  add/remove. No rows → the weapon uses the baseline paralysis proc. */
  private buildInflictEditor(id: string, ov: ItemOverride): void {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;flex-direction:column;gap:4px;border-top:1px solid #2a3540;padding-top:6px;';
    const head = document.createElement('div');
    head.textContent = 'STATUS INFLICTS (on hit)';
    head.style.cssText = 'color:#9fb8cc;font-size:11px;';
    wrap.appendChild(head);

    const list = (ov.inflict ?? []).map((e) => ({ ...e }));
    const rowsEl = document.createElement('div');
    rowsEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    wrap.appendChild(rowsEl);

    const commit = () => this.setInflict(id, list);

    const renderRows = () => {
      rowsEl.innerHTML = '';
      list.forEach((entry, idx) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const sel = document.createElement('select');
        sel.style.cssText =
          'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 4px;';
        for (const o of STATUS_OPTIONS) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === entry.type) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.onchange = () => {
          entry.type = sel.value;
          commit();
        };
        r.appendChild(sel);
        const pct = document.createElement('input');
        pct.type = 'number';
        pct.value = String(entry.chance);
        pct.title = 'proc chance %';
        pct.style.cssText =
          'width:48px;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 4px;';
        pct.onchange = () => {
          let n = parseInt(pct.value, 10);
          if (Number.isNaN(n)) n = 0;
          n = Math.max(1, Math.min(100, n));
          entry.chance = n;
          pct.value = String(n);
          commit();
        };
        r.appendChild(pct);
        const pctLbl = document.createElement('span');
        pctLbl.textContent = '%';
        pctLbl.style.cssText = 'color:#9fb8cc;';
        r.appendChild(pctLbl);
        const del = document.createElement('button');
        del.textContent = '🗑';
        del.style.cssText =
          'font:11px monospace;padding:1px 6px;cursor:pointer;border-radius:3px;background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
        del.onclick = () => {
          list.splice(idx, 1);
          commit();
          renderRows();
        };
        r.appendChild(del);
        rowsEl.appendChild(r);
      });
      if (!list.length) {
        const none = document.createElement('div');
        none.textContent = 'none → baseline paralysis (12%)';
        none.style.cssText = 'color:#667;font-size:10px;';
        rowsEl.appendChild(none);
      }
    };
    renderRows();

    this.mkBtn(
      '+ Add status',
      () => {
        list.push({ type: 'paralysis', chance: 10 });
        commit();
        renderRows();
      },
      wrap
    );
    const hint = document.createElement('div');
    hint.textContent = 'Chance is scaled by the target’s resistance to that status.';
    hint.style.cssText = 'color:#667;font-size:10px;line-height:1.4;';
    wrap.appendChild(hint);
    this.statsEl!.appendChild(wrap);
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
