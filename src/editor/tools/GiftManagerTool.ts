import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { mkButton } from '../ui';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import {
  loadGifts,
  allGifts,
  giftFlagId,
  freeGiftSlot,
  containerTypeName,
  GIFT_SPRITE_CLOSED,
  GiftDef,
  GiftAddition,
  GiftOverrides,
} from '../../engine/Gifts';
import { reloadNpcsLive } from '../../engine/NPCManager';
import { loadShops, allItems } from '../../engine/Shop';
import { getItemName, drawItemThumb, loadItemSprites, loadCustomItems } from '../../engine/Items';
import { getSpriteName } from '../../engine/SpriteNames';
import { createSpritePicker, SpritePicker } from '../../engine/SpritePicker';

// Gift Manager — every EarthBound present box (sprite 195) and its contents +
// per-player one-time flag. Two layers: ROM gifts (assets/map/gifts.json, via
// tools/extract_gifts.py) whose CONTENTS you can re-author, and brand-NEW gift
// boxes you place in the world here. Both persist to overrides/gifts.json
// ({edits:{k:{item}}, additions:[{k,x,y,romFlag,item}]}); the engine spawns a
// prop for each addition and the server hot-reloads them for the one-time grant.
class GiftManagerTool implements EditorTool {
  id = 'gift-manager';
  name = 'Gift Manager';
  description = 'Present boxes — author ROM contents or place new gift boxes.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private gifts: GiftDef[] = [];
  private edits: Record<string, { item?: number | null }> = {};
  private additions: GiftAddition[] = [];
  private selected: string | null = null;
  private placing = false;
  private activeSprite: number | null = null; // active type tab (null = All)
  private panel: HTMLDivElement | null = null;
  private tabsEl: HTMLDivElement | null = null;
  private placeBtn: HTMLButtonElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private detailEl: HTMLDivElement | null = null;
  private summaryEl: HTMLDivElement | null = null;
  private rows = new Map<string, HTMLDivElement>();
  private picker: SpritePicker | null = null;
  private search = '';

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('gifts', () => this.save());
    void this.loadAndBuild();
  }

  deactivate(): void {
    this.placing = false;
    this.panel?.remove();
    this.panel = null;
    this.placeBtn = null;
    this.listEl = null;
    this.detailEl = null;
    this.picker = null;
    this.rows.clear();
  }

  /** Click-to-place: while armed, the next world click drops a new gift box. */
  onMouseDown(p: WorldPoint): boolean {
    if (!this.placing) return false;
    this.placing = false;
    this.updatePlaceBtn();
    void this.placeGiftAt(p);
    return true;
  }

  private async loadAndBuild(): Promise<void> {
    await Promise.all([loadShops(), loadItemSprites(), loadCustomItems()]);
    await loadGifts();
    const ov = await loadOverride<GiftOverrides>('gifts.json').catch(() => null);
    this.edits = ov?.edits ?? {};
    this.additions = ov?.additions ?? [];
    this.gifts = allGifts();
    if (!this.selected && this.gifts.length) this.selected = this.gifts[0].k;
    this.buildPanel();
    this.renderList();
    this.renderDetail();
  }

  /** Effective contents: an authored edit wins for ROM gifts; added gifts carry
   *  their item directly. */
  private itemOf(g: GiftDef): number | null {
    if (g.added) return g.item;
    const e = this.edits[g.k];
    return e && e.item !== undefined ? e.item : g.item;
  }

  private contentsLabel(g: GiftDef): string {
    const item = this.itemOf(g);
    if (item == null) return '⚠ (unset)';
    return getItemName(String(item)) ?? `item ${item}`;
  }

  // --- contents editing ----------------------------------------------------------------

  private setContents(k: string, item: number | null): void {
    const g = this.gifts.find((x) => x.k === k);
    if (g?.added) {
      const a = this.additions.find((x) => x.k === k);
      if (a) a.item = item;
      g.item = item; // keep the in-memory list in sync for instant relabel
    } else {
      this.edits[k] = { item };
    }
    this.shell?.markDirty('gifts');
    this.refreshRow(k);
    if (k === this.selected) this.renderDetail();
  }

  private resetContents(k: string): void {
    delete this.edits[k];
    this.shell?.markDirty('gifts');
    this.refreshRow(k);
    if (k === this.selected) this.renderDetail();
  }

  private async save(): Promise<void> {
    await saveOverride('gifts.json', {
      version: 1,
      edits: this.edits,
      additions: this.additions,
    });
    await loadGifts(); // refresh the live catalog (new contents tag on next area load)
    this.shell?.clearDirty('gifts');
    this.shell?.toast('Saved gifts — server hot-reloads boxes/contents');
  }

  // --- placement / deletion ------------------------------------------------------------

  private async placeGiftAt(p: WorldPoint): Promise<void> {
    const sprite = this.activeSprite ?? GIFT_SPRITE_CLOSED; // active tab's type (All → present)
    const { k, romFlag } = freeGiftSlot();
    this.additions.push({ k, x: Math.round(p.x), y: Math.round(p.y), sprite, romFlag, item: null });
    await this.save();
    await reloadNpcsLive(); // spawn the container prop so it shows + opens
    this.gifts = allGifts();
    this.selected = k;
    this.renderList();
    this.renderDetail();
    this.shell?.toast(`Placed a ${this.tabLabel(sprite)} container — now pick what is inside it`);
  }

  private async deleteGift(k: string): Promise<void> {
    this.additions = this.additions.filter((a) => a.k !== k);
    delete this.edits[k];
    await this.save();
    await reloadNpcsLive();
    this.gifts = allGifts();
    if (this.selected === k) this.selected = this.gifts[0]?.k ?? null;
    this.renderList();
    this.renderDetail();
    this.shell?.toast('Deleted gift box');
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #6ad08a;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'GIFT MANAGER';
    title.style.cssText = 'color:#6ad08a;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    this.summaryEl = document.createElement('div');
    this.summaryEl.style.cssText = 'color:#9fb8cc;font-size:11px;';
    this.panel.appendChild(this.summaryEl);

    // Type tabs: All + one per container sprite (presents, trash cans, jars…).
    this.tabsEl = document.createElement('div');
    this.tabsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;';
    this.panel.appendChild(this.tabsEl);

    // Place a brand-new container (of the active tab's type) by clicking the map.
    this.placeBtn = this.mkBtn(
      '📍 Place new',
      () => this.togglePlacing(),
      this.panel,
      'Arm placement, then click the map to drop a new container of the active tab type.'
    );

    const search = document.createElement('input');
    search.placeholder = 'search item / key…';
    search.title = 'Filter the list by contents item name or gift key.';
    search.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    search.oninput = () => {
      this.search = search.value.trim().toLowerCase();
      this.renderList();
    };
    this.panel.appendChild(search);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;' +
      'border:1px solid #243;border-radius:4px;padding:4px;background:#0c1014;';
    this.listEl.addEventListener('wheel', (e) => e.stopPropagation());
    this.panel.appendChild(this.listEl);

    this.detailEl = document.createElement('div');
    this.detailEl.style.cssText =
      'display:flex;flex-direction:column;gap:6px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.detailEl);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private togglePlacing(): void {
    this.placing = !this.placing;
    this.updatePlaceBtn();
    if (this.placing) this.shell?.toast('Click the map where the gift box should go');
  }

  private updatePlaceBtn(): void {
    if (!this.placeBtn) return;
    const type = this.tabLabel(this.activeSprite ?? GIFT_SPRITE_CLOSED);
    this.placeBtn.textContent = this.placing ? '📍 Click map… (cancel)' : `📍 Place new: ${type}`;
    this.placeBtn.style.borderColor = this.placing ? '#6ad08a' : '#3a4a5a';
  }

  // --- type tabs -----------------------------------------------------------------------

  /** Distinct container sprite types present in the catalog, ascending. */
  private containerSprites(): number[] {
    return [...new Set(this.gifts.map((g) => g.sprite))].sort((a, b) => a - b);
  }

  /** Tab/type label: an admin sprite rename wins over the built-in default. */
  private tabLabel(sprite: number): string {
    return getSpriteName(sprite) ?? containerTypeName(sprite);
  }

  private renderTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = '';
    const mk = (label: string, sprite: number | null) => {
      const on = this.activeSprite === sprite;
      const count =
        sprite === null ? this.gifts.length : this.gifts.filter((g) => g.sprite === sprite).length;
      const b = document.createElement('button');
      b.textContent = `${label} (${count})`;
      b.title =
        sprite === null
          ? 'Show all container types.'
          : `Show only "${label}" containers (also the type used by Place new).`;
      b.style.cssText =
        'font:10px monospace;padding:2px 6px;cursor:pointer;border-radius:3px;' +
        (on
          ? 'background:#16321f;color:#cde;border:1px solid #6ad08a;'
          : 'background:#1d2530;color:#9fb8cc;border:1px solid #3a4a5a;');
      b.onclick = () => {
        this.activeSprite = sprite;
        this.renderList();
        this.updatePlaceBtn();
      };
      this.tabsEl!.appendChild(b);
    };
    mk('All', null);
    for (const s of this.containerSprites()) mk(this.tabLabel(s), s);
  }

  private renderList(): void {
    if (!this.listEl || !this.summaryEl) return;
    this.renderTabs();
    this.listEl.innerHTML = '';
    this.rows.clear();
    const shown = this.gifts.filter(
      (g) => this.activeSprite === null || g.sprite === this.activeSprite
    );
    const resolved = shown.filter((g) => this.itemOf(g) != null).length;
    const added = shown.filter((g) => g.added).length;
    this.summaryEl.textContent =
      `${shown.length} shown · ${resolved} with contents` +
      (added ? ` · ${added} placed by you` : '');

    for (const g of shown) {
      const label = this.contentsLabel(g).toLowerCase();
      if (this.search && !label.includes(this.search) && !g.k.includes(this.search)) continue;
      this.listEl.appendChild(this.makeRow(g));
    }
  }

  private makeRow(g: GiftDef): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:3px;cursor:pointer;font-size:11px;';
    row.onclick = () => {
      this.selected = g.k;
      this.renderDetail();
      this.highlight();
    };
    const c = document.createElement('canvas');
    c.width = 18;
    c.height = 18;
    c.style.cssText = 'width:18px;height:18px;image-rendering:pixelated;flex:none;';
    const item = this.itemOf(g);
    if (item != null) drawItemThumb(c, String(item));
    const lbl = document.createElement('span');
    lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    lbl.textContent = `${g.added ? '＋ ' : ''}${this.contentsLabel(g)}`;
    row.append(c, lbl);
    this.rows.set(g.k, row);
    return row;
  }

  private refreshRow(k: string): void {
    const row = this.rows.get(k);
    const g = this.gifts.find((x) => x.k === k);
    if (!row || !g) return;
    const c = row.firstElementChild as HTMLCanvasElement;
    const item = this.itemOf(g);
    const ctx = c.getContext('2d');
    ctx?.clearRect(0, 0, c.width, c.height);
    if (item != null) drawItemThumb(c, String(item));
    const lbl = row.lastElementChild as HTMLElement;
    lbl.textContent = `${g.added ? '＋ ' : ''}${this.contentsLabel(g)}`;
  }

  private highlight(): void {
    for (const [k, row] of this.rows) {
      const on = k === this.selected;
      row.style.background = on ? '#16321f' : 'transparent';
      row.style.outline = on ? '1px solid #6ad08a' : 'none';
    }
  }

  private renderDetail(): void {
    if (!this.detailEl) return;
    this.detailEl.innerHTML = '';
    this.picker = null;
    const g = this.gifts.find((x) => x.k === this.selected);
    if (!g) {
      this.detailEl.textContent = 'No gift selected.';
      return;
    }
    this.highlight();

    const head = document.createElement('div');
    head.style.cssText = 'color:#9fb8cc;font-size:11px;line-height:1.5;';
    head.innerHTML =
      `<b style="color:#cde">type:</b> ${this.tabLabel(g.sprite)} (sprite ${g.sprite})<br>` +
      `<b style="color:#cde">contents:</b> ${this.contentsLabel(g)}` +
      `${g.special && !g.added ? '  <span style="color:#e8a33d">(special — author it)</span>' : ''}` +
      `${g.added ? '  <span style="color:#6ad08a">(placed by you)</span>' : ''}<br>` +
      `<b style="color:#cde">location:</b> (${g.x}, ${g.y})  ·  ` +
      `<b style="color:#cde">flag:</b> ${giftFlagId(g.romFlag)} (rom ${g.romFlag})`;
    this.detailEl.appendChild(head);

    const goRow = document.createElement('div');
    goRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn(
      '📍 Go to box',
      () => this.shell?.goTo(g.x, g.y),
      goRow,
      'Jump the camera to this container in the world.'
    );
    if (g.added) {
      this.mkBtn(
        '🗑 Delete box',
        () => void this.deleteGift(g.k),
        goRow,
        'Remove this player-placed container.'
      );
    } else if (this.edits[g.k]?.item !== undefined) {
      this.mkBtn(
        '↺ Reset to ROM',
        () => this.resetContents(g.k),
        goRow,
        'Discard your contents edit and restore the original ROM item.'
      );
    }
    this.detailEl.appendChild(goRow);

    // Contents picker — every catalog item (searchable), drawing its real art.
    const ids = allItems().map((i) => i.id);
    const cur = this.itemOf(g);
    this.picker = createSpritePicker({
      sections: [{ values: ids }],
      initial: cur != null ? String(cur) : (ids[0] ?? '0'),
      labelFor: (v) => `${v} ${getItemName(v) ?? ''}`.trim(),
      drawThumb: (canvas, v) => drawItemThumb(canvas, v),
      onSelect: (v) => this.setContents(g.k, Number(v) | 0),
    });
    this.picker.el.title = 'Pick the item this container gives when opened.';
    this.detailEl.appendChild(this.picker.el);
  }

  // Thin wrapper over the shared editor UI kit (src/editor/ui.ts).
  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    tip?: string
  ): HTMLButtonElement {
    return mkButton(label, fn, { parent, tip });
  }
}

export const giftManagerTool = new GiftManagerTool();
