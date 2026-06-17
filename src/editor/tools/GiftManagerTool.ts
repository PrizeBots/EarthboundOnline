import { EditorTool, EditorShellApi } from '../types';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import { loadGifts, allGifts, giftFlagId, GiftDef, GiftOverrides } from '../../engine/Gifts';
import { loadShops, allItems } from '../../engine/Shop';
import { getItemName, drawItemThumb, loadItemSprites, loadCustomItems } from '../../engine/Items';
import { createSpritePicker, SpritePicker } from '../../engine/SpritePicker';

// Gift Manager — every EarthBound present box (sprite 195) placed in the world,
// with its CONTENTS and per-player one-time flag. The list is ROM-derived
// (assets/map/gifts.json via tools/extract_gifts.py); editing an item writes the
// authored layer (overrides/gifts.json edits, keyed by placement key) that both
// the engine (Gifts.loadGifts) and the server (gameHost) merge on top. Most
// contents auto-resolve from the ROM; a few "special" presents come in unset for
// you to fill here. Per-player one-time open is server-authoritative — this tool
// only authors what's inside each box.
class GiftManagerTool implements EditorTool {
  id = 'gift-manager';
  name = 'Gift Manager';
  description = 'Every present box + its contents and one-time-open flag.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private gifts: GiftDef[] = [];
  private edits: Record<string, { item?: number | null }> = {};
  private selected: string | null = null;
  private panel: HTMLDivElement | null = null;
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
    this.panel?.remove();
    this.panel = null;
    this.listEl = null;
    this.detailEl = null;
    this.picker = null;
    this.rows.clear();
  }

  private async loadAndBuild(): Promise<void> {
    await Promise.all([loadShops(), loadItemSprites(), loadCustomItems()]);
    await loadGifts();
    const ov = await loadOverride<GiftOverrides>('gifts.json').catch(() => null);
    this.edits = ov?.edits ?? {};
    this.gifts = allGifts();
    if (!this.selected && this.gifts.length) this.selected = this.gifts[0].k;
    this.buildPanel();
    this.renderList();
    this.renderDetail();
  }

  /** Effective contents of a gift: an authored edit wins over the ROM value. */
  private itemOf(g: GiftDef): number | null {
    const e = this.edits[g.k];
    return e && e.item !== undefined ? e.item : g.item;
  }

  private isEdited(g: GiftDef): boolean {
    return this.edits[g.k]?.item !== undefined;
  }

  private contentsLabel(g: GiftDef): string {
    const item = this.itemOf(g);
    if (item == null) return '⚠ (unset)';
    return getItemName(String(item)) ?? `item ${item}`;
  }

  // --- contents editing ----------------------------------------------------------------

  private setContents(k: string, item: number | null): void {
    this.edits[k] = { item };
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
    await saveOverride('gifts.json', { version: 1, edits: this.edits });
    await loadGifts(); // refresh the live catalog so newly-loaded areas tag the new contents
    this.shell?.clearDirty('gifts');
    this.shell?.toast('Saved gift contents — restart the server to grant the new items');
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

    const search = document.createElement('input');
    search.placeholder = 'search item / key…';
    search.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    search.oninput = () => {
      this.search = search.value.trim().toLowerCase();
      this.renderList();
    };
    this.panel.appendChild(search);

    // Scrollable list of every gift.
    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;' +
      'border:1px solid #243;border-radius:4px;padding:4px;background:#0c1014;';
    this.listEl.addEventListener('wheel', (e) => e.stopPropagation());
    this.panel.appendChild(this.listEl);

    // Detail for the selected gift (location, flag, contents picker).
    this.detailEl = document.createElement('div');
    this.detailEl.style.cssText =
      'display:flex;flex-direction:column;gap:6px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.detailEl);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private renderList(): void {
    if (!this.listEl || !this.summaryEl) return;
    this.listEl.innerHTML = '';
    this.rows.clear();
    const resolved = this.gifts.filter((g) => this.itemOf(g) != null).length;
    const special = this.gifts.length - resolved;
    this.summaryEl.textContent = `${this.gifts.length} gifts · ${resolved} with contents · ${special} unset`;

    for (const g of this.gifts) {
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
    lbl.textContent = `${this.contentsLabel(g)}${this.isEdited(g) ? ' •' : ''}`;
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
    lbl.textContent = `${this.contentsLabel(g)}${this.isEdited(g) ? ' •' : ''}`;
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
      `<b style="color:#cde">contents:</b> ${this.contentsLabel(g)}` +
      `${g.special && !this.isEdited(g) ? '  <span style="color:#e8a33d">(special — author it)</span>' : ''}<br>` +
      `<b style="color:#cde">location:</b> (${g.x}, ${g.y})  ·  ` +
      `<b style="color:#cde">flag:</b> ${giftFlagId(g.romFlag)} (rom ${g.romFlag})`;
    this.detailEl.appendChild(head);

    // Go to the box in the world (editor free-fly camera).
    const goRow = document.createElement('div');
    goRow.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('📍 Go to box', () => this.shell?.goTo(g.x, g.y), goRow);
    if (this.isEdited(g)) this.mkBtn('↺ Reset to ROM', () => this.resetContents(g.k), goRow);
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
    this.detailEl.appendChild(this.picker.el);
  }

  private mkBtn(label: string, fn: () => void, parent: HTMLElement): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }
}

export const giftManagerTool = new GiftManagerTool();
