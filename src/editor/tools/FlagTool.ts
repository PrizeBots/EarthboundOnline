import { EditorTool, EditorShellApi } from '../types';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import { flagDefs, setFlagRegistry, FlagDef } from '../../engine/FlagRegistry';
import { getTriggers, setTriggers, Trigger } from '../../engine/FlagTriggers';
import { hasFlag, setFlag, clearFlag, resetFlags, onFlagsChanged } from '../../engine/PlayerFlags';
import { GameEventType } from '../../engine/EventBus';
import { createSpritePicker, drawSpriteGroupThumb } from '../../engine/SpritePicker';
import { listSpriteGroupIds } from '../../engine/SpriteManager';
import { getSpriteName } from '../../engine/SpriteNames';
import { itemSpriteIds, getItemName, drawItemThumb } from '../../engine/Items';
import worldFlags from '../../world_flags.json';

// Flag Editor (EDITOR_TOOLS.md §9) — the admin surface for the event-flag /
// quest system. Two tabs:
//   FLAGS    — the catalog (overrides/flags.json): create/rename/scope/default/
//              delete, plus a LIVE toggle of your own player flags so you can
//              watch conditional dialogue change in the real world.
//   TRIGGERS — the rules (overrides/triggers.json): "when <event> [on <target>],
//              if <require> flags hold, set/clear <flags>." This is what makes a
//              flag flip during play (talk to NPC, get item, defeat enemy…).
//
// Player-flag ids mint >= 900000 (clear of ROM numbers). Triggers set PLAYER
// flags only. Saves merge live (setFlagRegistry / setTriggers) so edits apply
// without a reload; world flags are surfaced read-mostly from world_flags.json.

const PLAYER_FLAG_BASE = 900000;

const EVENTS: {
  value: GameEventType;
  label: string;
  target: 'text' | 'item' | 'enemy' | 'sector';
}[] = [
  { value: 'dialogue:done', label: 'Talk to NPC (dialogue done)', target: 'text' },
  { value: 'item:acquired', label: 'Acquire item', target: 'item' },
  { value: 'enemy:defeated', label: 'Defeat enemy', target: 'enemy' },
  { value: 'area:entered', label: 'Enter sector', target: 'sector' },
];

type Mode = 'flags' | 'triggers';

class FlagTool implements EditorTool {
  id = 'flags';
  name = 'Flag Editor';
  description = 'Author event flags, triggers, and flag-conditional dialogue.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private mode: Mode = 'flags';
  private flags: FlagDef[] = [];
  private triggers: Trigger[] = [];
  private selFlag: number | null = null;
  private selTrig: string | null = null;
  private filter = '';

  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private unsubFlags: (() => void) | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('flags', () => this.saveFlags());
    registerSaveHandler('triggers', () => this.saveTriggers());
    // Keep the live-toggle checkboxes in sync if a flag changes from elsewhere
    // (e.g. a trigger fires while the panel is open).
    this.unsubFlags = onFlagsChanged(() => this.refreshList());
    this.buildPanel();
    void this.load();
  }

  deactivate(): void {
    this.unsubFlags?.();
    this.unsubFlags = null;
    this.panel?.remove();
    this.panel = null;
  }

  // --- load / save ---------------------------------------------------------------------

  private async load(): Promise<void> {
    const ov = await loadOverride<{ version: number; flags?: FlagDef[] }>('flags.json').catch(
      () => null
    );
    const triggers = await loadOverride<{ version: number; triggers?: Trigger[] }>(
      'triggers.json'
    ).catch(() => null);

    // Start from the authored catalog (or the in-memory registry already loaded
    // at boot), then fold in any world flags from world_flags.json that aren't
    // catalogued yet, so existing open-world flags are visible/editable.
    const byId = new Map<number, FlagDef>();
    for (const f of ov?.flags ?? flagDefs()) byId.set(f.id, f);
    for (const hex of worldFlags.setFlags as string[]) {
      const id = parseInt(hex, 16);
      if (!byId.has(id)) {
        byId.set(id, { id, name: `world_${hex}`, scope: 'world', default: true });
      }
    }
    this.flags = [...byId.values()].sort((a, b) => a.id - b.id);
    this.triggers = (triggers?.triggers ?? getTriggers()).map((t) => ({ ...t }));

    // Push the merged catalog live so the rest of the engine sees world flags too.
    setFlagRegistry(this.flags);
    this.refreshList();
    this.rebuildForm();
  }

  private async saveFlags(): Promise<void> {
    // Persist authored flags only; world_flags.json stays the source for baked
    // world state, so don't re-write those entries we surfaced for visibility.
    const authored = this.flags.filter((f) => f.scope === 'player');
    setFlagRegistry(this.flags); // keep the live catalog (incl. world) in sync
    await saveOverride('flags.json', { version: 1, flags: authored });
    this.shell?.clearDirty('flags');
    this.shell?.toast(`Saved ${authored.length} flag(s)`);
  }

  private async saveTriggers(): Promise<void> {
    setTriggers(this.triggers);
    await saveOverride('triggers.json', { version: 1, triggers: this.triggers });
    this.shell?.clearDirty('triggers');
    this.shell?.toast(`Saved ${this.triggers.length} trigger(s)`);
  }

  private dirtyFlags(): void {
    setFlagRegistry(this.flags);
    this.shell?.markDirty('flags');
  }
  private dirtyTriggers(): void {
    setTriggers(this.triggers);
    this.shell?.markDirty('triggers');
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #c678dd;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'FLAG EDITOR';
    title.style.cssText = 'color:#c678dd;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px;';
    for (const m of ['flags', 'triggers'] as Mode[]) {
      const b = document.createElement('button');
      b.textContent = m.toUpperCase();
      b.dataset.tab = m;
      b.style.cssText =
        'flex:1;font:11px monospace;padding:3px 0;cursor:pointer;border-radius:3px;' +
        'background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
      b.onclick = () => {
        this.mode = m;
        this.filter = '';
        this.refreshList();
        this.rebuildForm();
        this.highlightTabs();
      };
      tabs.appendChild(b);
    }
    this.panel.appendChild(tabs);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:1px;max-height:170px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.panel.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    this.panel.appendChild(this.formEl);

    this.shell!.panelHost.appendChild(this.panel);
    this.highlightTabs();
  }

  private highlightTabs(): void {
    for (const b of this.panel?.querySelectorAll<HTMLButtonElement>('button[data-tab]') ?? []) {
      const on = b.dataset.tab === this.mode;
      b.style.background = on ? '#2a1f33' : '#1d2530';
      b.style.borderColor = on ? '#c678dd' : '#3a4a5a';
      b.style.color = on ? '#e2b6f5' : '#cde';
    }
  }

  // --- list ----------------------------------------------------------------------------

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (this.mode === 'flags') this.renderFlagList();
    else this.renderTriggerList();
  }

  private renderFlagList(): void {
    const list = this.listEl!;
    const f = this.filter.toLowerCase();
    const shown = this.flags.filter(
      (fl) => !f || fl.name.toLowerCase().includes(f) || String(fl.id).includes(f)
    );
    for (const fl of shown) {
      const row = document.createElement('div');
      const on = fl.id === this.selFlag;
      row.style.cssText =
        'display:flex;gap:6px;align-items:center;padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (on ? 'background:#221a2a;' : '');

      // Live toggle (player flags only — world flags are baked global state).
      if (fl.scope === 'player') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = hasFlag(fl.id);
        cb.title = 'live: set/clear this flag for YOUR character';
        cb.style.cssText = 'cursor:pointer;accent-color:#c678dd;';
        cb.onclick = (e) => {
          e.stopPropagation();
          if (cb.checked) setFlag(fl.id);
          else clearFlag(fl.id);
          this.shell?.toast(`${fl.name} ${cb.checked ? 'SET' : 'cleared'} (live)`);
        };
        row.appendChild(cb);
      } else {
        const dot = document.createElement('span');
        dot.textContent = '◧';
        dot.title = 'world flag (baked, global)';
        dot.style.cssText = 'color:#5a6;width:14px;text-align:center;';
        row.appendChild(dot);
      }

      const name = document.createElement('span');
      name.textContent = fl.name;
      name.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${
        fl.scope === 'player' ? '#cde' : '#8aa'
      };`;
      const meta = document.createElement('span');
      const used = this.triggerUseCount(fl.id);
      meta.textContent = `#${fl.id}${used ? ` ·${used}▸` : ''}`;
      meta.style.cssText = 'color:#667;font-size:10px;';
      row.append(name, meta);
      row.onclick = () => {
        this.selFlag = fl.id;
        this.refreshList();
        this.rebuildForm();
      };
      list.appendChild(row);
    }
    if (shown.length === 0) list.appendChild(this.emptyRow('No flags. “+ New flag” to start.'));
  }

  private renderTriggerList(): void {
    const list = this.listEl!;
    for (const t of this.triggers) {
      const row = document.createElement('div');
      const on = t.id === this.selTrig;
      row.style.cssText =
        'display:flex;flex-direction:column;padding:3px 4px;cursor:pointer;border-radius:3px;' +
        (on ? 'background:#221a2a;' : '');
      const head = document.createElement('div');
      head.textContent = this.triggerSummary(t);
      head.style.cssText = 'color:#cde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const sub = document.createElement('div');
      sub.textContent = `→ set ${(t.set ?? []).map((id) => this.flagName(id)).join(', ') || '—'}`;
      sub.style.cssText = 'color:#8a7;font-size:10px;';
      row.append(head, sub);
      row.onclick = () => {
        this.selTrig = t.id;
        this.refreshList();
        this.rebuildForm();
      };
      list.appendChild(row);
    }
    if (this.triggers.length === 0)
      list.appendChild(this.emptyRow('No triggers. “+ New trigger” to start.'));
  }

  private emptyRow(text: string): HTMLDivElement {
    const e = document.createElement('div');
    e.textContent = text;
    e.style.cssText = 'color:#667;padding:4px;';
    return e;
  }

  // --- form ----------------------------------------------------------------------------

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    if (this.mode === 'flags') this.renderFlagForm();
    else this.renderTriggerForm();
  }

  private renderFlagForm(): void {
    const form = this.formEl!;
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('+ New flag', () => this.newFlag(), top, true);
    this.mkSearch(top);
    form.appendChild(top);

    const fl = this.flags.find((f) => f.id === this.selFlag);
    if (!fl) {
      form.appendChild(this.hint('Select a flag to edit it, or toggle one live above.'));
      this.mkBtn(
        'Reset MY progress (clear all player flags)',
        () => {
          resetFlags();
          this.refreshList();
          this.shell?.toast('Player flags cleared');
        },
        form
      );
      return;
    }

    form.appendChild(this.fieldLabel(`#${fl.id} · ${fl.scope}`));

    if (fl.scope === 'world') {
      form.appendChild(
        this.hint('World flag (baked global state from world_flags.json) — name/desc only.')
      );
    }

    this.mkTextField(
      'name',
      fl.name,
      (v) => {
        fl.name = v.trim().replace(/\s+/g, '_') || fl.name;
        this.dirtyFlags();
        this.refreshList();
      },
      form
    );

    // Scope + default (player flags only).
    if (fl.scope === 'player') {
      const def = document.createElement('label');
      def.style.cssText = 'display:flex;gap:6px;align-items:center;color:#9fb8cc;font-size:11px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!fl.default;
      cb.style.accentColor = '#c678dd';
      cb.onchange = () => {
        fl.default = cb.checked;
        this.dirtyFlags();
      };
      def.append(cb, document.createTextNode('on by default for new players'));
      form.appendChild(def);
    }

    this.mkTextField(
      'description',
      fl.desc ?? '',
      (v) => {
        fl.desc = v;
        this.dirtyFlags();
      },
      form,
      true
    );

    const usedBy = this.triggers.filter((t) => this.trigRefsFlag(t, fl.id));
    if (usedBy.length) {
      const u = document.createElement('div');
      u.textContent = `Used by ${usedBy.length} trigger(s): ${usedBy.map((t) => t.id).join(', ')}`;
      u.style.cssText = 'color:#8a7;font-size:10px;';
      form.appendChild(u);
    }

    if (fl.scope === 'player') {
      this.mkBtn('Delete flag', () => this.deleteFlag(fl.id), form);
    }
  }

  private renderTriggerForm(): void {
    const form = this.formEl!;
    this.mkBtn('+ New trigger', () => this.newTrigger(), form, true);

    const t = this.triggers.find((x) => x.id === this.selTrig);
    if (!t) {
      form.appendChild(this.hint('Select a trigger to edit, or make a new one.'));
      return;
    }

    form.appendChild(this.fieldLabel(`id ${t.id}`));

    // Event type.
    const evSel = document.createElement('select');
    evSel.style.cssText = this.inputCss();
    for (const e of EVENTS) {
      const o = document.createElement('option');
      o.value = e.value;
      o.textContent = e.label;
      if (e.value === t.on.event) o.selected = true;
      evSel.appendChild(o);
    }
    evSel.onchange = () => {
      t.on = { event: evSel.value as GameEventType };
      this.dirtyTriggers();
      this.rebuildForm();
      this.refreshList();
    };
    form.appendChild(this.labeled('WHEN', evSel));

    // Target (depends on event).
    form.appendChild(this.targetControl(t));

    // Flag lists.
    form.appendChild(
      this.flagListField('REQUIRE (all set)', t.require ?? [], (ids) => {
        t.require = ids.length ? ids : undefined;
        this.dirtyTriggers();
      })
    );
    form.appendChild(
      this.flagListField('REQUIRE CLEAR (all unset)', t.requireClear ?? [], (ids) => {
        t.requireClear = ids.length ? ids : undefined;
        this.dirtyTriggers();
      })
    );
    form.appendChild(
      this.flagListField('SET', t.set ?? [], (ids) => {
        t.set = ids.length ? ids : undefined;
        this.dirtyTriggers();
        this.refreshList();
      })
    );
    form.appendChild(
      this.flagListField('CLEAR', t.clear ?? [], (ids) => {
        t.clear = ids.length ? ids : undefined;
        this.dirtyTriggers();
      })
    );

    this.mkBtn('Delete trigger', () => this.deleteTrigger(t.id), form);
  }

  /** The target picker/input for a trigger's event type. */
  private targetControl(t: Trigger): HTMLElement {
    const ev = EVENTS.find((e) => e.value === t.on.event)!;
    if (ev.target === 'text') {
      const wrap = this.labeled(
        'NPC textId',
        this.numInput(t.on.text, (n) => {
          t.on.text = n;
          this.dirtyTriggers();
          this.refreshList();
        })
      );
      wrap.appendChild(this.hint('Tip: talk to the NPC in-world; the console logs textId=NNN.'));
      return wrap;
    }
    if (ev.target === 'sector') {
      return this.labeled(
        'sector id',
        this.numInput(t.on.sector, (n) => {
          t.on.sector = n;
          this.dirtyTriggers();
          this.refreshList();
        })
      );
    }
    if (ev.target === 'item') {
      const ids = itemSpriteIds();
      const picker = createSpritePicker({
        sections: [{ values: ids }],
        initial: t.on.item != null ? String(t.on.item) : (ids[0] ?? ''),
        labelFor: (v) => `${v} ${getItemName(v) ?? ''}`.trim(),
        drawThumb: drawItemThumb,
        onSelect: (v) => {
          t.on.item = Number(v);
          this.dirtyTriggers();
          this.refreshList();
        },
        searchPlaceholder: 'search item…',
      });
      if (t.on.item == null && ids[0]) t.on.item = Number(ids[0]);
      return this.labeled('item', picker.el);
    }
    // enemy (sprite group)
    const groups = listSpriteGroupIds().map(String);
    const picker = createSpritePicker({
      sections: [{ values: groups }],
      initial: t.on.enemy != null ? String(t.on.enemy) : (groups[0] ?? ''),
      labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? ''}`.trim(),
      drawThumb: drawSpriteGroupThumb,
      onSelect: (v) => {
        t.on.enemy = Number(v);
        this.dirtyTriggers();
        this.refreshList();
      },
      searchPlaceholder: 'search enemy sprite…',
    });
    if (t.on.enemy == null && groups[0]) t.on.enemy = Number(groups[0]);
    return this.labeled('enemy sprite', picker.el);
  }

  /** Chip list + "add" dropdown for a set of player-flag ids. */
  private flagListField(
    label: string,
    ids: number[],
    onChange: (ids: number[]) => void
  ): HTMLElement {
    const current = [...ids];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = 'color:#778;font-size:10px;letter-spacing:1px;';
    wrap.appendChild(lbl);

    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
    const renderChips = () => {
      chips.innerHTML = '';
      for (const id of current) {
        const chip = document.createElement('span');
        chip.style.cssText =
          'display:inline-flex;gap:4px;align-items:center;background:#2a1f33;color:#e2b6f5;' +
          'border:1px solid #6a4a7a;border-radius:10px;padding:1px 7px;font-size:10px;';
        chip.append(document.createTextNode(this.flagName(id)));
        const x = document.createElement('span');
        x.textContent = '✕';
        x.style.cssText = 'cursor:pointer;color:#c88;';
        x.onclick = () => {
          const i = current.indexOf(id);
          if (i >= 0) current.splice(i, 1);
          renderChips();
          onChange(current);
        };
        chip.appendChild(x);
        chips.appendChild(chip);
      }
    };
    renderChips();
    wrap.appendChild(chips);

    const add = document.createElement('select');
    add.style.cssText = this.inputCss();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '+ add flag…';
    add.appendChild(ph);
    for (const fl of this.flags.filter((f) => f.scope === 'player' && !current.includes(f.id))) {
      const o = document.createElement('option');
      o.value = String(fl.id);
      o.textContent = fl.name;
      add.appendChild(o);
    }
    add.onchange = () => {
      const id = Number(add.value);
      if (id) {
        current.push(id);
        renderChips();
        onChange(current);
      }
      add.value = '';
    };
    wrap.appendChild(add);
    return wrap;
  }

  // --- mutations -----------------------------------------------------------------------

  private newFlag(): void {
    const id = this.mintFlagId();
    const fl: FlagDef = { id, name: `flag_${id}`, scope: 'player', default: false };
    this.flags.push(fl);
    this.flags.sort((a, b) => a.id - b.id);
    this.selFlag = id;
    this.dirtyFlags();
    this.refreshList();
    this.rebuildForm();
  }

  private deleteFlag(id: number): void {
    this.flags = this.flags.filter((f) => f.id !== id);
    if (this.selFlag === id) this.selFlag = null;
    this.dirtyFlags();
    this.refreshList();
    this.rebuildForm();
  }

  private newTrigger(): void {
    const id = this.mintTrigId();
    const t: Trigger = { id, on: { event: 'dialogue:done' }, set: [] };
    this.triggers.push(t);
    this.selTrig = id;
    this.dirtyTriggers();
    this.refreshList();
    this.rebuildForm();
  }

  private deleteTrigger(id: string): void {
    this.triggers = this.triggers.filter((t) => t.id !== id);
    if (this.selTrig === id) this.selTrig = null;
    this.dirtyTriggers();
    this.refreshList();
    this.rebuildForm();
  }

  private mintFlagId(): number {
    let max = PLAYER_FLAG_BASE - 1;
    for (const f of this.flags) if (f.scope === 'player' && f.id > max) max = f.id;
    return max + 1;
  }

  private mintTrigId(): string {
    let n = 1;
    const ids = new Set(this.triggers.map((t) => t.id));
    while (ids.has(`trig_${n}`)) n++;
    return `trig_${n}`;
  }

  // --- helpers -------------------------------------------------------------------------

  private flagName(id: number): string {
    return this.flags.find((f) => f.id === id)?.name ?? `#${id}`;
  }

  private triggerUseCount(id: number): number {
    return this.triggers.filter((t) => this.trigRefsFlag(t, id)).length;
  }

  private trigRefsFlag(t: Trigger, id: number): boolean {
    return [t.require, t.requireClear, t.set, t.clear].some((a) => a?.includes(id));
  }

  private triggerSummary(t: Trigger): string {
    const ev = EVENTS.find((e) => e.value === t.on.event);
    const tgt =
      t.on.text != null
        ? ` text ${t.on.text}`
        : t.on.item != null
          ? ` item ${t.on.item}`
          : t.on.enemy != null
            ? ` sprite ${t.on.enemy}`
            : t.on.sector != null
              ? ` sector ${t.on.sector}`
              : '';
    return `${ev?.label ?? t.on.event}${tgt}`;
  }

  // small DOM builders -----------------------------------------------------------------

  private inputCss(): string {
    return (
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;' +
      'border-radius:3px;padding:3px 6px;width:100%;box-sizing:border-box;'
    );
  }

  private labeled(label: string, control: HTMLElement): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const l = document.createElement('div');
    l.textContent = label;
    l.style.cssText = 'color:#778;font-size:10px;letter-spacing:1px;';
    wrap.append(l, control);
    return wrap;
  }

  private fieldLabel(text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'color:#9fb8cc;font-size:11px;';
    return d;
  }

  private hint(text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'color:#667;font-size:10px;';
    return d;
  }

  private numInput(value: number | undefined, onChange: (n: number) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'number';
    i.value = value != null ? String(value) : '';
    i.style.cssText = this.inputCss();
    i.oninput = () => {
      const n = Number(i.value);
      if (Number.isFinite(n)) onChange(n);
    };
    return i;
  }

  private mkTextField(
    label: string,
    value: string,
    onChange: (v: string) => void,
    parent: HTMLElement,
    multiline = false
  ): void {
    const ctl = multiline ? document.createElement('textarea') : document.createElement('input');
    ctl.value = value;
    ctl.style.cssText = this.inputCss() + (multiline ? 'resize:vertical;' : '');
    if (multiline) (ctl as HTMLTextAreaElement).rows = 2;
    ctl.oninput = () => onChange(ctl.value);
    parent.appendChild(this.labeled(label, ctl));
  }

  private mkSearch(parent: HTMLElement): void {
    const i = document.createElement('input');
    i.placeholder = 'search…';
    i.style.cssText = this.inputCss() + 'flex:1;';
    i.oninput = () => {
      this.filter = i.value;
      this.refreshList();
    };
    parent.appendChild(i);
  }

  private mkBtn(label: string, fn: () => void, parent: HTMLElement, accent = false): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:3px 9px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#2a1f33;color:#e2b6f5;border:1px solid #c678dd;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
  }
}

export const flagTool = new FlagTool();
