import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { drawWindow } from '../../engine/WindowRenderer';
import { drawText } from '../../engine/TextRenderer';
import { wrapText } from '../../engine/ChatManager';
import { getSpriteGroupMeta } from '../../engine/SpriteManager';
import {
  mergeNpcOverrides, reloadNpcText, reloadNpcsLive,
  RawNPC, NpcOverrides, DialogueOverrides,
} from '../../engine/NPCManager';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';

// Dialogue Editor (EDITOR_TOOLS.md §4) — author the decoded NPC text. Each
// entry is keyed by a textId (the NPC config id; an NPC links to it via its `t`
// field) and holds an ordered list of pages, the same shape npc_text.json and
// DialogueManager use. Edits save to the overrides layer
// (public/overrides/dialogue.json) and merge over the decoded text in
// NPCManager — the generated npc_text.json is never touched, so re-running
// eb_dialogue.py never clobbers authoring.
//
// v1 scope: edit existing entries' pages + a faithful EB-window live preview.
// Deferred (separate passes): ccscript flag-conditionals/branches, assigning a
// textId to an NPC (that edits the NPC's `t` — Placement Editor's domain), and
// net-new textIds for brand-new NPCs.

const FONT = 0; // EB dialogue font (loaded at boot)
const BOX_W = 240;
const LINE_H = 16;
const INSET = 6;
const INNER_W = BOX_W - INSET * 2;
const LINES_PER_BOX = 3;
const BOX_H = LINES_PER_BOX * LINE_H + INSET * 2;

interface Ref {
  x: number;
  y: number;
}

interface Entry {
  textId: string;
  pages: string[]; // working copy (edited in place)
  base: string[] | null; // decoded npc_text base, for diffing on save
  refs: Ref[]; // NPC placements that speak this textId
}

class DialogueTool implements EditorTool {
  id = 'dialogue';
  name = 'Dialogue Editor';
  description = 'Author NPC text through the real EB text window.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private entries = new Map<string, Entry>();
  private order: string[] = []; // textIds, numeric-sorted
  private filter = '';
  private selId: string | null = null;
  private pageIdx = 0;
  // NPC placements grouped by the textId they speak (rebuilt on load).
  private refsById = new Map<string, Ref[]>();
  // All NPC placements (base + overrides), kept for click-to-target hit-testing.
  private npcs: RawNPC[] = [];
  // NPCs given a fresh textId this session (by clicking) — their `t` link is
  // written to npcs.json on Save so the dialogue round-trips on reload.
  private linkedNpcs = new Set<RawNPC>();
  // Cross-tool handoff: a textId to focus/create once loaded (set before the
  // tool activates, e.g. Placement Editor's "Author dialogue").
  private pendingFocus: string | null = null;

  private panel: HTMLDivElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private preview: HTMLCanvasElement | null = null;
  private pageLabel: HTMLSpanElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('dialogue', () => this.save());
    this.buildPanel();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.selId = null;
  }

  // --- world interaction: click an NPC to target its dialogue --------------------------

  /** Front-most NPC placement whose sprite box contains the world point. */
  private npcAt(p: WorldPoint): RawNPC | null {
    let best: RawNPC | null = null;
    for (const n of this.npcs) {
      const meta = getSpriteGroupMeta(n.sprite);
      const w = meta?.width ?? 16;
      const h = meta?.height ?? 16;
      // Anchor is center-x / feet-y (same as the renderer + Placement Editor).
      if (p.x < n.x - w / 2 || p.x > n.x + w / 2 || p.y < n.y - h || p.y > n.y) continue;
      if (!best || n.y > best.y) best = n; // front-most (largest y) wins
    }
    return best;
  }

  onMouseDown(p: WorldPoint): boolean {
    const npc = this.npcAt(p);
    if (!npc) return false; // empty space — let the shell pan
    this.targetNpc(npc);
    return true;
  }

  /**
   * Click-to-target: ALWAYS select an editable dialogue entry for this NPC —
   * its existing one, or a fresh empty one if it has none. A newly-minted link
   * is remembered and written to npcs.json on Save (works for base AND added
   * NPCs), so the dialogue round-trips on reload.
   */
  private targetNpc(npc: RawNPC): void {
    const ref: Ref = { x: npc.x, y: npc.y };
    if (npc.t != null) {
      this.focusEntry(String(npc.t), ref);
      this.shell?.toast(`Dialogue ${npc.t}`);
      return;
    }
    // No dialogue yet — mint an id, link it locally, open it for editing, and
    // queue the link for Save.
    const id = this.mintTextId();
    npc.t = Number(id);
    this.refsById.set(id, [ref]);
    this.linkedNpcs.add(npc);
    this.focusEntry(id, ref);
    this.shell?.toast(`New dialogue ${id} — type its text, then Save`);
  }

  /**
   * Write this session's NPC→textId links into overrides/npcs.json (read-merge-
   * write so other placement edits survive) and apply them live. Base NPCs key
   * by their stable `k`; added NPCs are matched/added in the `additions` array.
   */
  private async persistLinks(): Promise<void> {
    if (this.linkedNpcs.size === 0) return;
    const ov = (await loadOverride<NpcOverrides>('npcs.json').catch(() => null)) ?? { version: 1 };
    ov.edits ??= {};
    ov.additions ??= [];
    for (const npc of this.linkedNpcs) {
      if (npc.t == null) continue;
      if (npc.k != null) {
        // Override edits replace the whole base entry — merge onto any existing
        // edit (keep a prior move); a null edit means deleted, so skip it.
        const cur = ov.edits[npc.k];
        if (cur === null) continue;
        const fields = cur ?? { x: npc.x, y: npc.y, sprite: npc.sprite, dir: npc.dir, kind: npc.kind };
        ov.edits[npc.k] = { ...fields, t: npc.t };
      } else {
        // Added NPC: find its entry in the additions array by identity, or add it.
        const a = ov.additions.find(
          (x) => x.x === npc.x && x.y === npc.y && x.sprite === npc.sprite &&
                 x.dir === npc.dir && x.kind === npc.kind,
        );
        if (a) a.t = npc.t;
        else ov.additions.push({
          x: npc.x, y: npc.y, sprite: npc.sprite, dir: npc.dir, kind: npc.kind, t: npc.t,
        });
      }
    }
    await saveOverride('npcs.json', ov);
    await reloadNpcsLive(); // links go live on the NPCs immediately
    this.linkedNpcs.clear();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    const vw = camera.viewW;
    const vh = camera.viewH;
    ctx.lineWidth = 1;
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    for (const n of this.npcs) {
      const sx = n.x - camX;
      const sy = n.y - camY;
      if (sx < -16 || sx > vw + 16 || sy < -32 || sy > vh + 16) continue;
      const has = n.t != null;
      const sel = has && String(n.t) === this.selId;
      ctx.strokeStyle = sel ? '#ffd23e' : has ? 'rgba(109,179,232,0.85)' : 'rgba(150,150,150,0.5)';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(sx - 7.5, sy - 11.5, 15, 13);
      if (sel) {
        ctx.fillStyle = '#ffd23e';
        ctx.fillText(String(n.t), sx, sy - 14);
      }
    }
    ctx.textAlign = 'left';
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      await this.load();
    } catch (e) {
      console.error('[Dialogue] load failed', e);
      this.shell?.toast(`Couldn't load dialogue: ${e}`, true);
      return;
    }
    this.refreshList();
    this.rebuildForm();
    this.applyPendingFocus();
  }

  /**
   * Cross-tool handoff: focus the entry for `textId`, creating an empty one if
   * it doesn't exist yet (a brand-new NPC's line). Called by the Placement
   * Editor's "Author dialogue" before it opens this tool; applied after load.
   */
  requestEntry(textId: string): void {
    if (this.panel) this.focusEntry(textId);
    else this.pendingFocus = textId; // applied after load()
  }

  private applyPendingFocus(): void {
    const id = this.pendingFocus;
    if (id == null) return;
    this.pendingFocus = null;
    this.focusEntry(id);
  }

  /**
   * Select the entry for `textId`, creating an empty one if it doesn't exist
   * yet, and rebuild the form so it's immediately editable. `ref` (a clicked
   * NPC's position) is recorded so the entry shows its speaker. Synchronous —
   * never blocked by persistence.
   */
  private focusEntry(id: string, ref?: Ref): void {
    let e = this.entries.get(id);
    if (!e) {
      e = { textId: id, pages: [''], base: null, refs: ref ? [ref] : (this.refsById.get(id) ?? []) };
      this.entries.set(id, e);
      this.order = [...this.entries.keys()].sort((a, b) => Number(a) - Number(b));
      this.shell?.markDirty('dialogue');
    } else if (ref && !e.refs.some((r) => r.x === ref.x && r.y === ref.y)) {
      e.refs.push(ref);
    }
    this.selId = id;
    this.pageIdx = 0;
    this.filter = '';
    if (this.searchEl) this.searchEl.value = '';
    this.refreshList();
    this.rebuildForm();
  }

  /** Lowest unused textId in the authored range (kept clear of ROM config ids). */
  private mintTextId(): string {
    let max = 899999;
    for (const id of this.entries.keys()) {
      const n = Number(id);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  private async load(): Promise<void> {
    const fetchJSON = <T>(url: string): Promise<T | null> =>
      fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

    const [base, ov, npcsBase, npcsOv] = await Promise.all([
      fetchJSON<Record<string, string[]>>('/assets/map/npc_text.json'),
      loadOverride<DialogueOverrides>('dialogue.json').catch(() => null),
      fetchJSON<RawNPC[]>('/assets/map/npcs.json'),
      loadOverride<NpcOverrides>('npcs.json').catch(() => null),
    ]);

    // Merged NPC placements (base + overrides). Kept whole for click-to-target,
    // and grouped by the textId they speak for the reference counts/markers.
    this.npcs = mergeNpcOverrides(npcsBase ?? [], npcsOv ?? null).filter(
      (n): n is RawNPC => !!n,
    );
    this.refsById.clear();
    for (const n of this.npcs) {
      if (n.t == null) continue;
      const k = String(n.t);
      (this.refsById.get(k) ?? this.refsById.set(k, []).get(k)!).push({ x: n.x, y: n.y });
    }

    const baseText = base ?? {};
    const edits = ov?.edits ?? {};
    const ids = new Set([...Object.keys(baseText), ...Object.keys(edits)]);
    this.entries.clear();
    for (const id of ids) {
      const override = edits[id];
      if (override === null) continue; // reverted to base-with-no-entry: skip
      const basePages = baseText[id] ?? null;
      const pages = override ?? basePages ?? [''];
      this.entries.set(id, {
        textId: id,
        pages: pages.slice(),
        base: basePages ? basePages.slice() : null,
        refs: this.refsById.get(id) ?? [],
      });
    }
    this.order = [...this.entries.keys()].sort((a, b) => Number(a) - Number(b));
  }

  // --- save ----------------------------------------------------------------------------

  private async save(): Promise<void> {
    // Persist any NPC→textId links made by clicking, so the dialogue reattaches
    // to its NPC on reload (this is what makes click-to-author round-trip).
    await this.persistLinks();

    // Drop orphaned authored entries: ones WE created (no decoded base) that no
    // NPC references. Decoded ROM entries are always kept (they may fire from
    // events, not placements), and the entry you're currently editing is kept
    // so Save never deletes active work.
    let dropped = 0;
    for (const e of [...this.entries.values()]) {
      if (e.base === null && e.refs.length === 0 && e.textId !== this.selId) {
        this.entries.delete(e.textId);
        dropped++;
      }
    }
    if (dropped) this.order = [...this.entries.keys()].sort((a, b) => Number(a) - Number(b));

    const edits: Record<string, string[]> = {};
    for (const e of this.entries.values()) {
      // Only persist entries that diverge from the decoded base.
      if (JSON.stringify(e.pages) !== JSON.stringify(e.base)) edits[e.textId] = e.pages;
    }
    await saveOverride('dialogue.json', { version: 1, edits });
    await reloadNpcText(); // authored text goes live for NPCs in this client
    this.shell?.clearDirty('dialogue');
    if (dropped) this.refreshList();
    this.shell?.toast(
      `Saved dialogue (${Object.keys(edits).length} authored${dropped ? `, ${dropped} orphan(s) removed` : ''})`,
    );
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;' +
      'background:#101418f2;color:#cde;font:12px monospace;border:1px solid #6db3e8;' +
      'border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'DIALOGUE EDITOR';
    title.style.cssText = 'color:#6db3e8;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    const hint = document.createElement('div');
    hint.textContent = 'Click an NPC in the world to edit its dialogue (or give it some).';
    hint.style.cssText = 'color:#778;font-size:10px;';
    this.panel.appendChild(hint);

    this.mkBtn('+ New dialogue', () => this.requestEntry(this.mintTextId()), this.panel, true);

    this.searchEl = document.createElement('input');
    this.searchEl.placeholder = 'search id or text…';
    this.searchEl.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;' +
      'border-radius:3px;padding:3px 6px;';
    this.searchEl.oninput = () => {
      this.filter = this.searchEl!.value.toLowerCase();
      this.refreshList();
    };
    this.panel.appendChild(this.searchEl);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:1px;max-height:150px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.panel.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    this.panel.appendChild(this.formEl);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    const f = this.filter;
    const shown = this.order.filter((id) => {
      if (!f) return true;
      if (id.includes(f)) return true;
      return (this.entries.get(id)?.pages.join(' ').toLowerCase().includes(f)) ?? false;
    });
    if (shown.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No matching entries.';
      e.style.cssText = 'color:#667;';
      this.listEl.appendChild(e);
      return;
    }
    for (const id of shown.slice(0, 400)) {
      const e = this.entries.get(id)!;
      const row = document.createElement('div');
      const on = id === this.selId;
      const authored = JSON.stringify(e.pages) !== JSON.stringify(e.base);
      row.style.cssText =
        'display:flex;gap:6px;align-items:baseline;padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (on ? 'background:#16242e;' : '');
      const idEl = document.createElement('span');
      idEl.textContent = (authored ? '*' : '') + id;
      idEl.style.cssText = `color:${authored ? '#e8a33d' : '#6db3e8'};min-width:46px;`;
      const snip = document.createElement('span');
      snip.textContent = (e.pages[0] ?? '').replace(/\n/g, ' ').slice(0, 28);
      snip.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9fb8cc;';
      const refs = document.createElement('span');
      refs.textContent = e.refs.length ? `👤${e.refs.length}` : '';
      refs.style.cssText = 'color:#667;font-size:10px;';
      row.append(idEl, snip, refs);
      row.onclick = () => {
        this.selId = id;
        this.pageIdx = 0;
        this.refreshList();
        this.rebuildForm();
      };
      this.listEl.appendChild(row);
    }
  }

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    this.preview = null;
    this.pageLabel = null;
    const e = this.selId ? this.entries.get(this.selId) : null;
    if (!e) {
      const hint = document.createElement('div');
      hint.textContent = 'Select an entry to edit its pages.';
      hint.style.cssText = 'color:#667;';
      this.formEl.appendChild(hint);
      return;
    }

    const header = document.createElement('div');
    header.textContent = `textId ${e.textId}` + (e.refs.length ? `  ·  spoken by ${e.refs.length} NPC(s)` : '  ·  no NPC references');
    header.style.cssText = 'color:#9fb8cc;font-size:11px;';
    this.formEl.appendChild(header);

    if (e.refs.length) {
      this.mkBtn('Go to speaker', () => {
        const r = e.refs[0];
        this.shell?.context.teleport(r.x, r.y);
      }, this.formEl);
    }

    // One textarea per page.
    e.pages.forEach((page, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'display:flex;justify-content:space-between;color:#778;font-size:10px;';
      const name = document.createElement('span');
      name.textContent = `page ${i + 1}`;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'remove page';
      del.style.cssText = 'background:none;border:none;color:#c66;cursor:pointer;font:10px monospace;';
      del.onclick = () => {
        e.pages.splice(i, 1);
        if (e.pages.length === 0) e.pages.push('');
        this.pageIdx = Math.min(this.pageIdx, e.pages.length - 1);
        this.shell?.markDirty('dialogue');
        this.refreshList();
        this.rebuildForm();
      };
      lbl.append(name, del);
      row.appendChild(lbl);

      const ta = document.createElement('textarea');
      ta.value = page;
      ta.rows = Math.min(4, Math.max(2, page.split('\n').length));
      ta.style.cssText =
        'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;' +
        'border-radius:3px;padding:3px 5px;resize:vertical;white-space:pre;';
      ta.oninput = () => {
        e.pages[i] = ta.value;
        this.shell?.markDirty('dialogue');
        if (i === this.pageIdx) this.drawPreview();
      };
      ta.onfocus = () => {
        this.pageIdx = i;
        this.drawPreview();
        this.updatePageLabel();
      };
      row.appendChild(ta);
      this.formEl!.appendChild(row);
    });

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('+ page', () => {
      e.pages.push('');
      this.pageIdx = e.pages.length - 1;
      this.shell?.markDirty('dialogue');
      this.rebuildForm();
    }, addRow);
    this.mkBtn('Revert to base', () => {
      if (!e.base) { this.shell?.toast('No decoded base for this entry', true); return; }
      e.pages = e.base.slice();
      this.shell?.markDirty('dialogue');
      this.refreshList();
      this.rebuildForm();
    }, addRow);
    this.formEl.appendChild(addRow);

    // Live preview in the real EB text window.
    const pvLabel = document.createElement('div');
    pvLabel.style.cssText = 'display:flex;align-items:center;gap:8px;color:#778;font-size:10px;margin-top:2px;';
    this.mkBtn('◀', () => this.flipPage(-1), pvLabel);
    this.pageLabel = document.createElement('span');
    pvLabel.appendChild(this.pageLabel);
    this.mkBtn('▶', () => this.flipPage(1), pvLabel);
    this.formEl.appendChild(pvLabel);

    this.preview = document.createElement('canvas');
    this.preview.width = BOX_W;
    this.preview.height = BOX_H;
    this.preview.style.cssText = 'image-rendering:pixelated;width:100%;background:#000;border:1px solid #243;';
    this.formEl.appendChild(this.preview);

    this.mkBtn('Save', () => {
      void this.save().catch((err) => this.shell?.toast(`Save failed: ${err}`, true));
    }, this.formEl, true);

    this.updatePageLabel();
    this.drawPreview();
  }

  private flipPage(d: number): void {
    const e = this.selId ? this.entries.get(this.selId) : null;
    if (!e) return;
    this.pageIdx = Math.max(0, Math.min(e.pages.length - 1, this.pageIdx + d));
    this.updatePageLabel();
    this.drawPreview();
  }

  private updatePageLabel(): void {
    const e = this.selId ? this.entries.get(this.selId) : null;
    if (this.pageLabel && e) this.pageLabel.textContent = `preview — page ${this.pageIdx + 1}/${e.pages.length}`;
  }

  /** Render the selected page in the actual EB dialogue window. */
  private drawPreview(): void {
    if (!this.preview) return;
    const ctx = this.preview.getContext('2d')!;
    ctx.clearRect(0, 0, BOX_W, BOX_H);
    drawWindow(ctx, 0, 0, BOX_W, BOX_H, 0);
    const e = this.selId ? this.entries.get(this.selId) : null;
    const page = e?.pages[this.pageIdx] ?? '';
    const lines: string[] = [];
    for (const para of page.split('\n')) lines.push(...wrapText(para, INNER_W, FONT));
    // Show the first box-worth; a ▼ hint if the page overflows one box.
    for (let i = 0; i < Math.min(LINES_PER_BOX, lines.length); i++) {
      drawText(ctx, lines[i], INSET, INSET + i * LINE_H, FONT);
    }
    if (lines.length > LINES_PER_BOX) {
      ctx.fillStyle = '#f0f0f0';
      ctx.fillText('▼', BOX_W - 12, BOX_H - 6);
    }
  }

  // --- helper ---------------------------------------------------------------------------

  private mkBtn(label: string, fn: () => void, parent: HTMLElement, accent = false): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 9px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#143046;color:#6db3e8;border:1px solid #6db3e8;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
  }
}

export const dialogueTool = new DialogueTool();
