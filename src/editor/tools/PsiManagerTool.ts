import { EditorTool, EditorShellApi } from '../types';
import { FolderDesktop, FolderDesktopStore, FolderDesktopFolder } from '../FolderDesktop';
import { registerSaveHandler } from '../registry';
import { saveOverride, loadOverride } from '../saveOverride';
import { openSpriteEditor } from '../../engine/spriteEditor';
import {
  PSI_BASE,
  allPsiIds,
  psiBase,
  effectivePsi,
  PsiOverride,
  PsiInflict,
  PsiCategory,
  PSI_CATEGORY_LABEL,
} from '../../engine/PsiTuning';
import { loadPsiAnims, getPsiAnim, hasPsiAnim, PSI_W, PSI_H } from '../../engine/PsiAnim';

// Status ids selectable in the inflict editor — KEEP IN SYNC with server/status.js
// STATUS (mirrors ItemManagerTool's list; the same wire-stable strings).
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

// Category tile/accent colors for the gallery (PSI's theme is purple).
const CATEGORY_COLOR: Record<PsiCategory, string> = {
  offense: '#d8553a',
  recover: '#3aa86a',
  assist: '#4ea3ff',
  other: '#a45ad0',
};

interface PsiFoldersDoc {
  version: number;
  folders?: FolderDesktopFolder[];
  assign?: Record<string, string | null>;
}

let folderCounter = 0;

// PSI Manager — the master library of every PSI move, organized like the Item
// Manager: a file-explorer "desktop" of tiles (the move's cast-animation icon)
// in category folders (Offense / Recover / Assist / Other). The right panel
// tunes every property (PP, power, range, status inflicts, revive…) into
// overrides/psi.json — the SAME file the server merges (gameHost _loadPsi) and
// the client base layers (PsiTuning). "Edit animation →" hands off to the Sprite
// Editor's PSI mode, the way Item Manager hands off held art. Folder layout saves
// to overrides/psi_folders.json.
class PsiManagerTool implements EditorTool {
  id = 'psi-manager';
  name = 'PSI Manager';
  description = 'Every PSI move, libraried with its cast art. Tune properties + edit animations.';
  status: 'ready' = 'ready';
  private accent = '#a45ad0';

  private shell: EditorShellApi | null = null;
  private psiId = '';
  private panel: HTMLDivElement | null = null;
  private detailsEl: HTMLDivElement | null = null;
  private statsEl: HTMLDivElement | null = null;
  private desktop: FolderDesktop | null = null;

  // Per-move tuning overrides (overrides/psi.json `moves`), keyed by PSI id.
  private overrides: Record<string, PsiOverride> = {};
  // Folder layout (overrides/psi_folders.json): category folders + per-move file.
  private folders: FolderDesktopFolder[] = [];
  private assign: Record<string, string | null> = {};
  // Cache of decoded anim-frame images for the gallery thumbs, by data URL.
  private thumbCache = new Map<string, HTMLImageElement>();

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('psi-stats', () => this.saveStats());
    registerSaveHandler('psi-folders', () => this.saveFolders());
    // Build the dock panel + gallery SYNCHRONOUSLY (the pattern the other shell
    // tools use) so the column always populates even before async data arrives.
    // Defaults first; saved overrides/anim art layer in via loadAndRefresh.
    this.seedFolders(null);
    if (!this.psiId) this.psiId = allPsiIds()[0] ?? '';
    this.buildPanel();
    this.buildDesktop();
    this.desktop?.open(); // big center gallery, open by default (like Item Manager)
    this.refreshDetails();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    this.desktop?.close();
    this.desktop = null;
    this.panel?.remove();
    this.panel = null;
    this.detailsEl = null;
    this.statsEl = null;
  }

  /** Load saved tuning + folder layout + cast-anim art, then refresh the (already
   *  built) UI. Tolerant of missing override files: in dev a missing /overrides/*
   *  can come back as index.html (200), so a raw loadOverride would throw — we
   *  swallow that and keep the defaults seeded in activate(). */
  private async loadAndRefresh(): Promise<void> {
    try {
      await loadPsiAnims(); // cast-animation frames for the tile thumbnails
      this.overrides =
        (await this.safeLoad<{ moves?: Record<string, PsiOverride> }>('psi.json'))?.moves ?? {};
      const fdoc = await this.safeLoad<PsiFoldersDoc>('psi_folders.json');
      if (fdoc) this.seedFolders(fdoc);
    } catch (e) {
      console.error('[PsiManager] load failed:', e);
      this.shell?.toast(`PSI Manager: couldn't load saved data (${e})`, true);
    }
    this.refreshDetails();
    this.desktop?.render();
  }

  /** loadOverride that never throws on a missing file (returns null). */
  private async safeLoad<T>(name: string): Promise<T | null> {
    try {
      return await loadOverride<T>(name);
    } catch {
      return null;
    }
  }

  /** Seed the folder model from the saved doc, or default each move to its
   *  category folder (so the library is organized on first run). */
  private seedFolders(doc: PsiFoldersDoc | null): void {
    const cats: PsiCategory[] = ['offense', 'recover', 'assist', 'other'];
    if (doc?.folders?.length) {
      this.folders = doc.folders.map((f) => ({ ...f }));
      this.assign = { ...(doc.assign ?? {}) };
    } else {
      this.folders = cats.map((c) => ({ id: c, name: PSI_CATEGORY_LABEL[c], parent: null }));
      this.assign = {};
      for (const m of PSI_BASE) this.assign[m.id] = m.category;
    }
    // Guarantee every move has a home folder (new moves added after a save).
    for (const m of PSI_BASE) {
      if (this.assign[m.id] === undefined) this.assign[m.id] = m.category;
    }
  }

  // --- persistence ---------------------------------------------------------------------

  /** Save the tuning overrides (only non-empty entries) to overrides/psi.json. */
  private async saveStats(): Promise<void> {
    const moves: Record<string, PsiOverride> = {};
    for (const [id, ov] of Object.entries(this.overrides)) {
      if (ov && Object.keys(ov).length) moves[id] = ov;
    }
    this.overrides = moves;
    await saveOverride('psi.json', { version: 1, moves });
    this.shell?.clearDirty('psi-stats');
    this.shell?.toast(
      'Saved PSI tuning → psi.json (combat values apply on server restart; menu shows base)'
    );
  }

  /** Save the folder layout to overrides/psi_folders.json. */
  private async saveFolders(): Promise<void> {
    await saveOverride('psi_folders.json', {
      version: 1,
      folders: this.folders,
      assign: this.assign,
    });
    this.shell?.clearDirty('psi-folders');
  }

  // --- override mutators (mirror ItemManagerTool's prune-on-empty semantics) ------------

  private ovOf(id: string): PsiOverride {
    if (!this.overrides[id]) this.overrides[id] = {};
    return this.overrides[id];
  }

  private prune(id: string): void {
    const ov = this.overrides[id];
    if (ov && !Object.keys(ov).length) delete this.overrides[id];
    this.shell?.markDirty('psi-stats');
  }

  /** Set (number) or clear (undefined) a scalar field; clearing reverts to base. */
  private setNum(id: string, key: keyof PsiOverride, val: number | undefined): void {
    const ov = this.ovOf(id);
    if (val === undefined || Number.isNaN(val)) delete ov[key];
    else (ov[key] as number) = val;
    this.prune(id);
  }

  /** Set a boolean field; matching the base value clears the override (revert). */
  private setBool(id: string, key: 'multi' | 'cures', val: boolean): void {
    const ov = this.ovOf(id);
    const baseVal = !!(psiBase(id) as Record<string, unknown> | undefined)?.[key];
    if (val === baseVal) delete ov[key];
    else (ov[key] as boolean) = val;
    this.prune(id);
  }

  /** Set the offense targeting shape; matching the base value reverts (clears). */
  private setShape(id: string, val: 'radius' | 'line' | 'screen' | 'bolts'): void {
    const ov = this.ovOf(id);
    const baseVal = psiBase(id)?.shape ?? 'radius';
    if (val === baseVal) delete ov.shape;
    else ov.shape = val;
    this.prune(id);
  }

  /** Set/clear the status-inflict list. Empty list reverts to the base move. */
  private setInflict(id: string, list: PsiInflict[]): void {
    const ov = this.ovOf(id);
    if (list.length) ov.inflict = list;
    else delete ov.inflict;
    this.prune(id);
  }

  /** Override the display name (empty reverts to the base name). */
  private setName(id: string, name: string): void {
    const ov = this.ovOf(id);
    const trimmed = name.trim();
    if (trimmed && trimmed !== psiBase(id)?.name) ov.name = trimmed;
    else delete ov.name;
    this.prune(id);
  }

  // --- desktop store -------------------------------------------------------------------

  private genFolderId(): string {
    return `pf_${Date.now().toString(36)}${folderCounter++}`;
  }

  private folderOf(id: string): string | null {
    const f = this.assign[id];
    return f !== undefined ? f : (psiBase(id)?.category ?? null);
  }

  private store(): FolderDesktopStore {
    return {
      foldersWithParent: (p) => this.folders.filter((f) => f.parent === p),
      folderOf: (id) => this.folderOf(id),
      itemsInFolder: (p) => allPsiIds().filter((id) => this.folderOf(id) === p),
      folderName: (id) => this.folders.find((f) => f.id === id)?.name ?? '?',
      childCount: (id) => {
        const items = allPsiIds().filter((i) => this.folderOf(i) === id).length;
        const subs = this.folders.filter((f) => f.parent === id).length;
        return items + subs;
      },
      addFolder: (name, parent) => {
        const fid = this.genFolderId();
        this.folders.push({ id: fid, name, parent });
        return fid;
      },
      renameFolder: (id, name) => {
        const f = this.folders.find((x) => x.id === id);
        if (f) f.name = name;
      },
      deleteFolder: (id) => {
        const f = this.folders.find((x) => x.id === id);
        if (!f) return;
        // Reparent child folders + reassign its moves up to its parent.
        for (const c of this.folders) if (c.parent === id) c.parent = f.parent;
        for (const k of Object.keys(this.assign))
          if (this.assign[k] === id) this.assign[k] = f.parent;
        this.folders = this.folders.filter((x) => x.id !== id);
      },
      assignTo: (ids, folder) => {
        for (const id of ids) this.assign[id] = folder;
      },
      setParent: (child, parent) => {
        if (child === parent) return false;
        // Reject moving a folder into its own descendant (cycle).
        let cur: string | null = parent;
        while (cur) {
          if (cur === child) return false;
          cur = this.folders.find((f) => f.id === cur)?.parent ?? null;
        }
        const f = this.folders.find((x) => x.id === child);
        if (f) f.parent = parent;
        return true;
      },
      autoOrganize: () => {
        for (const m of PSI_BASE) this.assign[m.id] = m.category;
      },
      allIds: () => allPsiIds(),
    };
  }

  private buildDesktop(): void {
    this.desktop = new FolderDesktop({
      title: '🔮 PSI LIBRARY',
      accent: this.accent,
      store: this.store(),
      drawThumb: (c, id) => this.drawThumb(c, id),
      labelFor: (id) => this.nameOf(id),
      matches: (id, q) => `${id} ${this.nameOf(id).toLowerCase()}`.includes(q),
      onFocus: (id) => {
        this.psiId = id;
        this.refreshDetails();
      },
      onSave: () => this.shell?.markDirty('psi-folders'),
      toast: (m, err) => this.shell?.toast(m, err),
    });
    this.desktop.setFocused(this.psiId);
  }

  private nameOf(id: string): string {
    return effectivePsi(id, this.overrides)?.name ?? id;
  }

  /** Tile thumbnail: the move's first authored cast frame, else a category swatch
   *  with the move name. Async frame loads redraw the tile when ready. */
  private drawThumb(canvas: HTMLCanvasElement, id: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cat = psiBase(id)?.category ?? 'assist';
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Category-tinted backdrop.
    ctx.fillStyle = '#0c1014';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = CATEGORY_COLOR[cat] + '22';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const anim = getPsiAnim(id);
    const frame = anim?.frames[0];
    if (frame) {
      let img = this.thumbCache.get(frame);
      if (!img) {
        img = new Image();
        img.onload = () => this.desktop?.render();
        img.src = frame;
        this.thumbCache.set(frame, img);
      }
      if (img.complete && img.naturalWidth) {
        const s = Math.max(1, Math.floor(Math.min(canvas.width / PSI_W, canvas.height / PSI_H)));
        ctx.drawImage(
          img,
          0,
          0,
          PSI_W,
          PSI_H,
          (canvas.width - PSI_W * s) / 2,
          (canvas.height - PSI_H * s) / 2,
          PSI_W * s,
          PSI_H * s
        );
        return;
      }
    }
    // No art yet: the move's tier letter (last char of its name) on the swatch.
    const nm = this.nameOf(id);
    const glyph = nm.trim().slice(-1) || '?';
    ctx.fillStyle = CATEGORY_COLOR[cat];
    ctx.font = '40px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, canvas.width / 2, canvas.height / 2 - 6);
    ctx.fillStyle = '#8a93a8';
    ctx.font = '9px monospace';
    ctx.fillText('no art', canvas.width / 2, canvas.height - 12);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // --- right panel ---------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      `border:1px solid ${this.accent};border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;`;
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'PSI MANAGER';
    title.style.cssText = `color:${this.accent};font-weight:bold;letter-spacing:1px;`;
    this.panel.appendChild(title);

    const hint = document.createElement('div');
    hint.textContent =
      'Drag moves between category folders. Tune properties below; values save to psi.json (the server reads it).';
    hint.style.cssText = 'color:#8a93a8;font-size:10px;line-height:1.4;';
    this.panel.appendChild(hint);

    this.mkBtn(
      '🔮 Open PSI library (center)',
      () => this.desktop?.toggle(),
      this.panel,
      true,
      'Show/hide the big center gallery of all PSI moves, organized into category folders.'
    );

    this.detailsEl = document.createElement('div');
    this.detailsEl.style.cssText =
      'display:flex;flex-direction:column;gap:4px;color:#9fb8cc;font-size:11px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.detailsEl);

    this.statsEl = document.createElement('div');
    this.statsEl.style.cssText =
      'display:flex;flex-direction:column;gap:5px;border-top:1px solid #2a3540;padding-top:7px;';
    this.panel.appendChild(this.statsEl);

    const edit = document.createElement('button');
    edit.textContent = '✎ Edit animation in Sprite Editor →';
    edit.style.cssText =
      'font:11px monospace;padding:3px 8px;cursor:pointer;border-radius:3px;' +
      `background:#2a1a38;color:${this.accent};border:1px solid ${this.accent};`;
    edit.onclick = () => {
      if (this.psiId) void openSpriteEditor({ focusPsi: this.psiId });
    };
    this.panel.appendChild(edit);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refreshDetails(): void {
    if (!this.detailsEl) return;
    const id = this.psiId;
    const base = psiBase(id);
    this.detailsEl.innerHTML = '';
    const rows: [string, string][] = [
      ['id', id || '—'],
      ['category', base ? PSI_CATEGORY_LABEL[base.category] : '—'],
      ['target', base?.target ?? '—'],
      ['cast art', hasPsiAnim(id) ? 'set ✓' : 'NEEDS ART'],
    ];
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.textContent = `${k}: ${v}`;
      if (k === 'cast art' && v === 'NEEDS ART') r.style.color = '#e07820';
      this.detailsEl.appendChild(r);
    }
    this.refreshStats();
  }

  /** Build the editable property form for the selected move (per category). */
  private refreshStats(): void {
    if (!this.statsEl) return;
    const id = this.psiId;
    this.statsEl.innerHTML = '';
    const base = psiBase(id);
    if (!base) return;
    const ov = this.overrides[id] ?? {};

    const title = document.createElement('div');
    title.textContent = 'PROPERTIES';
    title.style.cssText = `color:${this.accent};font-size:11px;letter-spacing:0.5px;`;
    this.statsEl.appendChild(title);

    // Name (override; placeholder = base name) + PP (every move).
    this.mkTextRow(
      'name',
      ov.name,
      base.name,
      (v) => {
        this.setName(id, v);
        this.desktop?.render(); // reflect rename in tiles
      },
      'Display name override; blank reverts to the base move name.'
    );
    this.mkNumRow(
      'PP cost',
      ov.pp,
      base.pp,
      0,
      undefined,
      false,
      (v) => this.setNum(id, 'pp', v),
      'PP spent to cast; blank reverts to the base cost. Caster needs at least this much PP.'
    );

    if (base.category === 'recover') {
      this.mkNumRow(
        'heal HP',
        ov.heal,
        base.heal ?? 0,
        0,
        undefined,
        false,
        (v) => this.setNum(id, 'heal', v),
        'HP restored to the target on cast; blank reverts to base. 0 = heals no HP.'
      );
      this.mkCheckRow(
        'cures status',
        effectivePsi(id, this.overrides)?.cures ?? false,
        (on) => this.setBool(id, 'cures', on),
        'On = casting also clears the target’s status ailments.'
      );
      // reviveFrac is 0..1 stored; edited as a percent of max HP (0 = not a revive).
      const curRevive = ov.reviveFrac === undefined ? undefined : Math.round(ov.reviveFrac * 100);
      this.mkNumRow(
        'revive %',
        curRevive,
        Math.round((base.reviveFrac ?? 0) * 100),
        0,
        100,
        false,
        (v) => this.setNum(id, 'reviveFrac', v === undefined ? undefined : v / 100),
        'Revives a downed ally to this % of max HP (0 = not a revive, 100 = full HP).'
      );
      const note = document.createElement('div');
      note.textContent = 'revive: cast on a DOWNED ally. 100% = full HP. 0 = no revive.';
      note.style.cssText = 'color:#667;font-size:10px;margin-left:62px;';
      this.statsEl.appendChild(note);
    } else if (base.category === 'offense') {
      this.mkNumRow(
        'damage',
        ov.damage,
        base.damage ?? 0,
        0,
        undefined,
        false,
        (v) => this.setNum(id, 'damage', v),
        'Base damage dealt to each enemy hit; blank reverts to the base value.'
      );
      // Targeting shape decides which reach fields are relevant.
      const eff = effectivePsi(id, this.overrides);
      const shape = eff?.shape ?? 'radius';
      this.mkSelectRow(
        'shape',
        shape,
        [
          { value: 'radius', label: 'Radius (circle)' },
          { value: 'line', label: 'Line (forward beam)' },
          { value: 'screen', label: 'Screen (all in view)' },
          { value: 'bolts', label: 'Bolts (random)' },
        ],
        base.shape ?? 'radius',
        (v) => {
          this.setShape(id, v);
          this.refreshStats(); // swap in the fields for the new shape
        },
        'Targeting shape: radius (circle), line (forward beam), screen (every enemy in view), or bolts (random strikes).'
      );
      if (shape === 'line') {
        this.mkNumRow(
          'length px',
          ov.length,
          base.length ?? 240,
          16,
          1024,
          false,
          (v) => this.setNum(id, 'length', v),
          'Beam reach forward in pixels (16–1024); blank uses the base length.'
        );
        this.mkNumRow(
          'muzzle ½w',
          ov.width,
          base.width ?? 32,
          4,
          512,
          false,
          (v) => this.setNum(id, 'width', v),
          'Half-width of the beam at the caster, in pixels (4–512); blank uses base.'
        );
        this.mkNumRow(
          'spread',
          ov.spread,
          base.spread ?? 0,
          0,
          4,
          true,
          (v) => this.setNum(id, 'spread', v),
          'Extra ½-width gained per pixel forward (cone flare); 0 = straight beam.'
        );
        const note = document.createElement('div');
        note.textContent =
          'Cone shoots the way you face; spread = ½-width gained per px forward (0 = straight beam).';
        note.style.cssText = 'color:#667;font-size:10px;margin-left:62px;';
        this.statsEl.appendChild(note);
      } else if (shape === 'bolts') {
        this.mkNumRow(
          'bolts',
          ov.bolts,
          base.bolts ?? 1,
          1,
          32,
          false,
          (v) => this.setNum(id, 'bolts', v),
          'How many random enemies in range are struck (1–32); blank uses base.'
        );
        this.mkNumRow(
          'range px',
          ov.range,
          base.range ?? 520,
          16,
          1024,
          false,
          (v) => this.setNum(id, 'range', v),
          'Radius in pixels within which targets can be struck (16–1024); blank uses base.'
        );
        const note = document.createElement('div');
        note.textContent = 'Strikes that many RANDOM enemies within range.';
        note.style.cssText = 'color:#667;font-size:10px;margin-left:62px;';
        this.statsEl.appendChild(note);
      } else if (shape === 'screen') {
        const note = document.createElement('div');
        note.textContent =
          'Hits every enemy in the caster’s screen view (reach is fixed to the viewport).';
        note.style.cssText = 'color:#667;font-size:10px;margin-left:62px;';
        this.statsEl.appendChild(note);
      } else {
        this.mkNumRow(
          'range px',
          ov.range,
          base.range ?? 240,
          16,
          640,
          false,
          (v) => this.setNum(id, 'range', v),
          'Radius of the effect circle around the caster, in pixels (16–640); blank uses base.'
        );
        this.mkCheckRow(
          'hits all in range',
          eff?.multi ?? false,
          (on) => this.setBool(id, 'multi', on),
          'On = damages every enemy in the radius; off = the single nearest target.'
        );
      }
      this.buildInflictEditor(id);
    } else if ((effectivePsi(id, this.overrides)?.inflict?.length ?? 0) > 0 || base.range) {
      // Ailment-style assist (Hypnosis/Paralysis/Brainshock): a status inflicter,
      // not a buff. Edit its reach + the status procs.
      this.mkNumRow(
        'range px',
        ov.range,
        base.range ?? 240,
        16,
        640,
        false,
        (v) => this.setNum(id, 'range', v),
        'Radius around the caster in which enemies are affected, in pixels (16–640); blank uses base.'
      );
      this.mkNumRow(
        'damage',
        ov.damage,
        base.damage ?? 0,
        0,
        undefined,
        false,
        (v) => this.setNum(id, 'damage', v),
        'Direct damage dealt alongside the status proc; blank reverts to base. 0 = no damage.'
      );
      this.buildInflictEditor(id);
    } else {
      const note = document.createElement('div');
      note.textContent = 'Buff/teleport/magnet effects aren’t wired yet — anim + PP only.';
      note.style.cssText = 'color:#667;font-size:10px;line-height:1.4;';
      this.statsEl.appendChild(note);
    }
  }

  /** The status-inflict list editor (rows of {status, chance%}). Empty reverts to
   *  the move's base inflicts. Seeded from the effective list so you edit current. */
  private buildInflictEditor(id: string): void {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;flex-direction:column;gap:4px;border-top:1px solid #2a3540;padding-top:6px;';
    const head = document.createElement('div');
    head.textContent = 'STATUS INFLICTS (on hit)';
    head.style.cssText = 'color:#9fb8cc;font-size:11px;';
    wrap.appendChild(head);

    const eff = effectivePsi(id, this.overrides);
    const list = (this.overrides[id]?.inflict ?? eff?.inflict ?? []).map((e) => ({ ...e }));
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
        sel.title = 'Status ailment this move may inflict on hit.';
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
        pct.title = 'Proc chance % (1–100), scaled by the target’s resistance.';
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
        del.title = 'Remove this status inflict.';
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
        none.textContent = 'none → no status proc';
        none.style.cssText = 'color:#667;font-size:10px;';
        rowsEl.appendChild(none);
      }
    };
    renderRows();

    this.mkBtn(
      '+ Add status',
      () => {
        list.push({ type: 'paralysis', chance: 50 });
        commit();
        renderRows();
      },
      wrap,
      false,
      'Add another status this move can inflict on hit.'
    );
    const hint = document.createElement('div');
    hint.textContent = 'Chance is scaled by the target’s resistance to that status.';
    hint.style.cssText = 'color:#667;font-size:10px;line-height:1.4;';
    wrap.appendChild(hint);
    this.statsEl!.appendChild(wrap);
  }

  // --- small DOM helpers (mirror ItemManagerTool) --------------------------------------

  private mkNumRow(
    label: string,
    cur: number | undefined,
    base: number,
    min: number,
    max: number | undefined,
    float: boolean,
    onSet: (v: number | undefined) => void,
    tip?: string
  ): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'width:62px;color:#9fb8cc;' + (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    row.appendChild(l);
    const i = document.createElement('input');
    i.type = 'number';
    i.value = cur === undefined ? '' : String(cur);
    i.placeholder = `${base}`;
    if (tip) i.title = tip;
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
    rev.textContent = cur === undefined ? `(base ${base})` : '•';
    rev.title =
      cur === undefined ? 'using base value' : 'overridden — clear the field to revert to base';
    rev.style.cssText = `color:${cur === undefined ? '#667' : this.accent};font-size:10px;`;
    row.appendChild(rev);
    this.statsEl!.appendChild(row);
  }

  private mkSelectRow<T extends string>(
    label: string,
    cur: T,
    opts: { value: T; label: string }[],
    base: T,
    onSet: (v: T) => void,
    tip?: string
  ): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'width:62px;color:#9fb8cc;' + (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    row.appendChild(l);
    const sel = document.createElement('select');
    if (tip) sel.title = tip;
    sel.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 4px;';
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label + (o.value === base ? ' (base)' : '');
      if (o.value === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => onSet(sel.value as T);
    row.appendChild(sel);
    this.statsEl!.appendChild(row);
  }

  private mkCheckRow(label: string, on: boolean, onSet: (v: boolean) => void, tip?: string): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'width:62px;color:#9fb8cc;' + (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    row.appendChild(l);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    if (tip) cb.title = tip;
    cb.style.cursor = 'pointer';
    cb.onchange = () => onSet(cb.checked);
    row.appendChild(cb);
    this.statsEl!.appendChild(row);
  }

  private mkTextRow(
    label: string,
    cur: string | undefined,
    base: string,
    onSet: (v: string) => void,
    tip?: string
  ): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'width:62px;color:#9fb8cc;' + (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    row.appendChild(l);
    const i = document.createElement('input');
    i.type = 'text';
    i.value = cur ?? '';
    i.placeholder = base;
    i.maxLength = 40;
    if (tip) i.title = tip;
    i.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    i.onchange = () => onSet(i.value);
    row.appendChild(i);
    this.statsEl!.appendChild(row);
  }

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false,
    tip?: string
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    if (tip) b.title = tip;
    b.style.cssText =
      'font:11px monospace;padding:4px 8px;cursor:pointer;border-radius:3px;' +
      (accent
        ? `background:#2a1a38;color:${this.accent};border:1px solid ${this.accent};`
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }
}

export const psiManagerTool = new PsiManagerTool();
