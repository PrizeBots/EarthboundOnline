import { EditorTool, EditorShellApi } from '../types';
import { listSpriteGroupIds, loadSpriteGroup, getSpriteGroupMeta, drawSprite } from '../../engine/SpriteManager';
import { getSpriteName, setSpriteNameOverride } from '../../engine/SpriteNames';
import { createSpritePicker, drawSpriteGroupThumb, SpritePicker } from '../../engine/SpritePicker';
import { loadNPCs } from '../../engine/NPCManager';
import { EntityStats, EntityDefs, EntityCol, entityStatsFor } from '../../engine/EntityStats';
import { loadJSON } from '../../engine/AssetLoader';
import { Direction } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';

// Entity Manager — the single home for per-entity combat stats (HP, level, XP,
// damage, attack rate, speed), keyed by sprite group. Enemy Spawners reference
// a sprite and inherit its stats (shown read-only there), so every shark shares
// one definition edited here. Stats live in enemy_spawns.json under `entities`;
// the server applies them to spawned enemies. Reuses the sprite-preview
// dropdown so you can pick (and SEE) any entity.

interface EnemyFile {
  version?: number;
  enemySpriteGroups?: number[];
  entities?: EntityDefs;
  spawners?: unknown[];
}

// UI field descriptors. `scale` shows/edits a ms value in seconds; `float`
// keeps fractional precision (speed); the rest are clamped positive integers.
// Numeric stat fields only (col is edited separately, in the collision section).
const STAT_FIELDS: {
  key: Exclude<keyof EntityStats, 'col'>; label: string; min: number; scale?: number; float?: boolean;
}[] = [
  { key: 'hp', label: 'HP', min: 1 },
  { key: 'level', label: 'level', min: 1 },
  { key: 'xp', label: 'XP', min: 0 },
  { key: 'damage', label: 'damage', min: 0 },
  { key: 'attackCooldownMs', label: 'atk cd s', min: 50, scale: 1000 },
  { key: 'speed', label: 'speed', min: 0.1, float: true },
  { key: 'detectRange', label: 'detect px', min: 1 },
  { key: 'attackRange', label: 'atk px', min: 1 },
];

// Collision-box preview geometry. The sprite is drawn at COL_SCALE with its
// feet at (COL_ANCHOR_X, COL_FEET_Y); the box overlay maps with the same anchor.
const COL_PREVIEW_W = 152;
const COL_PREVIEW_H = 140;
const COL_SCALE = 2;
const COL_ANCHOR_X = 76;
const COL_FEET_Y = 116;
// Directions to cycle in the preview (friendly order), with their labels.
const DIR_CYCLE: [Direction, string][] = [
  [Direction.S, 'S'], [Direction.E, 'E'], [Direction.N, 'N'], [Direction.W, 'W'],
  [Direction.SE, 'SE'], [Direction.SW, 'SW'], [Direction.NE, 'NE'], [Direction.NW, 'NW'],
];

class EntityManagerTool implements EditorTool {
  id = 'entity-manager';
  name = 'Entity Manager';
  description = 'Per-entity stats (HP, level, XP, damage, attack rate, speed) for any sprite.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private entities: EntityDefs = {};
  private sprite = 0; // currently selected sprite group
  private pending: number | null = null; // cross-tool handoff target
  private panel: HTMLDivElement | null = null;
  private headerEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private fields = new Map<string, HTMLInputElement>();
  private picker: SpritePicker | null = null;
  private nameInput: HTMLInputElement | null = null;

  // --- collision box state ---
  // Precomputed exact per-direction boxes (sprites/colboxes.json); shown as the
  // default for vehicles. A manual override (entities[sprite].col) wins.
  private colBoxes: Record<string, Record<string, EntityCol>> = {};
  private colSection: HTMLDivElement | null = null;
  private colCanvas: HTMLCanvasElement | null = null;
  private colFields = new Map<keyof EntityCol, HTMLInputElement>();
  private previewDir: Direction = Direction.E;
  private colDrag: 'move' | 'w' | 'h' | null = null;
  private dragStart = { mx: 0, my: 0, box: { w: 0, h: 0, offX: 0, offY: 0 } as EntityCol };
  // Bound window listeners (drag can leave the canvas) — removed on deactivate.
  private onColMoveBound = (e: MouseEvent) => this.onColMouseMove(e);
  private onColUpBound = () => (this.colDrag = null);

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('entities', () => this.save());
    this.buildPanel();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    window.removeEventListener('mousemove', this.onColMoveBound);
    window.removeEventListener('mouseup', this.onColUpBound);
    this.colDrag = null;
    this.panel?.remove();
    this.panel = null;
    this.picker = null;
    this.colSection = null;
    this.colCanvas = null;
    this.colFields.clear();
  }

  /** Cross-tool handoff (Enemy Spawner's "Edit entity"): open with `sprite` selected. */
  requestEntity(sprite: number): void {
    this.pending = sprite;
    if (this.picker) this.applyPending();
  }

  private applyPending(): void {
    if (this.pending == null) return;
    this.sprite = this.pending;
    this.pending = null;
    this.picker?.setValue(String(this.sprite));
    this.rebuildForm();
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      await this.load();
    } catch (e) {
      this.shell?.toast(`Couldn't load entities: ${e}`, true);
      return;
    }
    this.applyPending();
    this.picker?.setValue(String(this.sprite));
    this.rebuildForm();
  }

  private async load(): Promise<void> {
    const cfg = await this.readConfig();
    this.entities = { ...(cfg?.entities ?? {}) };
    this.colBoxes = await loadJSON<Record<string, Record<string, EntityCol>>>(
      '/assets/sprites/colboxes.json',
    ).catch(() => ({}));
    if (!this.sprite) {
      this.sprite = cfg?.spawners?.length
        ? (cfg.spawners[0] as { sprite?: number }).sprite ?? listSpriteGroupIds()[0] ?? 1
        : listSpriteGroupIds()[0] ?? 1;
    }
  }

  /** Override (live authoring) wins over the committed default. */
  private async readConfig(): Promise<EnemyFile | null> {
    let cfg: EnemyFile | null = null;
    try {
      cfg = await loadOverride<EnemyFile>('enemy_spawns.json');
    } catch {
      cfg = null;
    }
    if (!cfg) {
      cfg = await fetch('/assets/map/enemy_spawns.json')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return cfg;
  }

  private setStat(sprite: number, key: keyof EntityStats, val: number): void {
    const cur = entityStatsFor(this.entities, sprite);
    this.entities[String(sprite)] = { ...cur, [key]: val };
    this.shell?.markDirty('entities');
  }

  // --- save (read-merge-write: only the `entities` section) ----------------------------

  private async save(): Promise<void> {
    const cfg: EnemyFile = (await this.readConfig()) ?? { version: 1 };
    cfg.version = cfg.version ?? 1;
    cfg.entities = this.entities;
    await saveOverride('enemy_spawns.json', cfg);
    await loadNPCs(); // hp shows on this client; server picks it up via file watch
    this.shell?.clearDirty('entities');
    this.shell?.toast('Saved entity stats — live here; other clients refresh to resync');
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;color:#cde;font:12px monospace;' +
      'border:1px solid #b06de8;border-radius:5px;padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'ENTITY MANAGER';
    title.style.cssText = 'color:#b06de8;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    // Entity picker — every sprite group, each row drawing the real sprite.
    const ids = listSpriteGroupIds();
    this.picker = createSpritePicker({
      sections: [{ values: ids.map(String) }],
      initial: String(this.sprite || ids[0] || 1),
      labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? ''}`.trim(),
      drawThumb: drawSpriteGroupThumb,
      onSelect: (v) => {
        this.sprite = Number(v) | 0;
        void loadSpriteGroup(this.sprite).catch(() => {}); // ensure the preview art is loaded
        this.rebuildForm();
      },
    });
    this.panel.appendChild(this.picker.el);

    // Rename the selected entity — writes the shared sprite-name override (same
    // mechanism as the Sprite/Placement editors). Save-all persists names.json.
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const nameLbl = document.createElement('span');
    nameLbl.textContent = 'name';
    nameLbl.style.cssText = 'width:56px;color:#9fb8cc;';
    nameRow.appendChild(nameLbl);
    this.nameInput = document.createElement('input');
    this.nameInput.placeholder = '(default)';
    this.nameInput.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;' +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    this.nameInput.onchange = () => {
      const v = this.nameInput!.value.trim();
      setSpriteNameOverride(this.sprite, v || null);
      this.shell?.markDirty('names');
      this.picker?.refresh(); // update the dropdown's label
      this.rebuildForm();     // update the header
      this.shell?.toast(`Renamed entity #${this.sprite} to "${v || '(default)'}" — Save all writes names.json`);
    };
    nameRow.appendChild(this.nameInput);
    this.panel.appendChild(nameRow);

    this.headerEl = document.createElement('div');
    this.headerEl.style.cssText = 'color:#9fb8cc;font-size:11px;';
    this.panel.appendChild(this.headerEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.panel.appendChild(this.formEl);

    this.buildColSection();

    this.mkBtn('Save', () => {
      void this.save().catch((e) => this.shell?.toast(`Save failed: ${e}`, true));
    }, this.panel, true);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private rebuildForm(): void {
    if (!this.formEl || !this.headerEl) return;
    this.formEl.innerHTML = '';
    this.fields.clear();
    this.headerEl.textContent = `${getSpriteName(this.sprite) ?? `#${this.sprite}`}  ·  entity #${this.sprite}`;
    if (this.nameInput) this.nameInput.value = getSpriteName(this.sprite) ?? '';

    const stats = entityStatsFor(this.entities, this.sprite);
    for (const f of STAT_FIELDS) {
      const shown = f.scale ? stats[f.key] / f.scale : stats[f.key];
      const i = this.mkInput(this.formEl, f.key, f.label, (v) => {
        const n = parseFloat(v);
        if (Number.isNaN(n)) return;
        const val = f.scale
          ? Math.max(f.min, Math.round(n * f.scale))
          : f.float
            ? Math.max(f.min, n)
            : Math.max(f.min, Math.round(n));
        this.setStat(this.sprite, f.key, val);
      });
      i.value = String(shown);
    }
    this.refreshColSection();
  }

  // --- collision box editor ------------------------------------------------------------

  /** The box shown for a sprite+dir: manual override, else exact per-dir box,
   *  else the kind default (full cell for vehicles, 14x8 foot box otherwise). */
  private effectiveBox(sprite: number, dir: Direction): EntityCol {
    const manual = this.entities[String(sprite)]?.col;
    if (manual) return manual;
    const perDir = this.colBoxes[String(sprite)]?.[String(dir)];
    if (perDir) return perDir;
    const meta = getSpriteGroupMeta(sprite);
    if (this.colBoxes[String(sprite)] && meta) {
      return { w: meta.width, h: meta.height, offX: 0, offY: 0 };
    }
    return { w: 14, h: 8, offX: 0, offY: 0 };
  }

  private hasOverride(sprite: number): boolean {
    return !!this.entities[String(sprite)]?.col;
  }

  /** Set (or clear, with null) the manual box override for a sprite group. */
  private setCol(sprite: number, col: EntityCol | null): void {
    const cur = entityStatsFor(this.entities, sprite);
    const next: EntityStats = { ...cur };
    if (col) next.col = col;
    else delete next.col;
    this.entities[String(sprite)] = next;
    this.shell?.markDirty('entities');
  }

  private buildColSection(): void {
    this.colSection = document.createElement('div');
    this.colSection.style.cssText =
      'display:flex;flex-direction:column;gap:6px;border-top:1px solid #2a3540;padding-top:7px;';

    const title = document.createElement('div');
    title.textContent = 'COLLISION BOX';
    title.style.cssText = 'color:#9fb8cc;font-size:11px;letter-spacing:0.5px;';
    this.colSection.appendChild(title);

    // Direction stepper (preview which facing's box to show).
    const dirRow = document.createElement('div');
    dirRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    this.mkBtn('◀', () => this.stepDir(-1), dirRow);
    const dirLbl = document.createElement('span');
    dirLbl.dataset.role = 'col-dir';
    dirLbl.style.cssText = 'flex:1;text-align:center;color:#cde;';
    dirRow.appendChild(dirLbl);
    this.mkBtn('▶', () => this.stepDir(1), dirRow);
    this.colSection.appendChild(dirRow);

    // Preview canvas (sprite + box overlay; drag to edit when overriding).
    this.colCanvas = document.createElement('canvas');
    this.colCanvas.width = COL_PREVIEW_W;
    this.colCanvas.height = COL_PREVIEW_H;
    this.colCanvas.style.cssText =
      'align-self:center;image-rendering:pixelated;background:#0c1014;border:1px solid #243;cursor:crosshair;';
    this.colCanvas.addEventListener('mousedown', (e) => this.onColMouseDown(e));
    window.addEventListener('mousemove', this.onColMoveBound);
    window.addEventListener('mouseup', this.onColUpBound);
    this.colSection.appendChild(this.colCanvas);

    // Numeric fields for the override box.
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;';
    for (const k of ['w', 'h', 'offX', 'offY'] as (keyof EntityCol)[]) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const l = document.createElement('span');
      l.textContent = k;
      l.style.cssText = 'width:30px;color:#9fb8cc;font-size:11px;';
      row.appendChild(l);
      const i = document.createElement('input');
      i.style.cssText =
        'width:48px;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 4px;';
      i.onchange = () => {
        const n = parseInt(i.value, 10);
        if (Number.isNaN(n)) return;
        const box = { ...this.effectiveBox(this.sprite, this.previewDir), [k]: n };
        if (k === 'w' || k === 'h') box[k] = Math.max(2, n);
        this.setCol(this.sprite, box);
        this.refreshColSection();
      };
      this.colFields.set(k, i);
      row.appendChild(i);
      grid.appendChild(row);
    }
    this.colSection.appendChild(grid);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('Reset to art (exact)', () => {
      this.setCol(this.sprite, null);
      this.refreshColSection();
      this.shell?.toast('Box reset to the exact per-direction art bounds');
    }, btnRow);
    this.colSection.appendChild(btnRow);

    const hint = document.createElement('div');
    hint.dataset.role = 'col-hint';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.colSection.appendChild(hint);

    this.panel!.appendChild(this.colSection);
  }

  private stepDir(d: number): void {
    const idx = DIR_CYCLE.findIndex(([dir]) => dir === this.previewDir);
    const next = (idx < 0 ? 0 : idx + d + DIR_CYCLE.length) % DIR_CYCLE.length;
    this.previewDir = DIR_CYCLE[next][0];
    this.refreshColSection();
  }

  private refreshColSection(): void {
    if (!this.colSection) return;
    const override = this.hasOverride(this.sprite);
    const dirName = DIR_CYCLE.find(([d]) => d === this.previewDir)?.[1] ?? 'S';
    const dirLbl = this.colSection.querySelector<HTMLSpanElement>('[data-role=col-dir]');
    if (dirLbl) dirLbl.textContent = `facing ${dirName}${override ? '  ·  override (all dirs)' : ''}`;
    const box = this.effectiveBox(this.sprite, this.previewDir);
    for (const [k, input] of this.colFields) {
      if (document.activeElement !== input) input.value = String(box[k]);
    }
    const hint = this.colSection.querySelector<HTMLDivElement>('[data-role=col-hint]');
    if (hint) {
      hint.textContent = override
        ? 'manual box — applies to every direction · drag the box, or "Reset to art"'
        : this.colBoxes[String(this.sprite)]
          ? 'exact per-direction box from the art (step ◀▶) · drag to override'
          : 'foot box default (non-vehicle) · drag to set a custom box';
    }
    void loadSpriteGroup(this.sprite).then(() => this.drawColPreview()).catch(() => this.drawColPreview());
  }

  private drawColPreview(): void {
    if (!this.colCanvas) return;
    const ctx = this.colCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, COL_PREVIEW_W, COL_PREVIEW_H);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.scale(COL_SCALE, COL_SCALE);
    drawSprite(ctx, this.sprite, this.previewDir, 0, COL_ANCHOR_X / COL_SCALE, COL_FEET_Y / COL_SCALE);
    ctx.restore();

    const override = this.hasOverride(this.sprite);
    const box = this.effectiveBox(this.sprite, this.previewDir);
    const bx = COL_ANCHOR_X + (box.offX - box.w / 2) * COL_SCALE;
    const by = COL_FEET_Y + (box.offY - box.h) * COL_SCALE;
    const bw = box.w * COL_SCALE;
    const bh = box.h * COL_SCALE;
    ctx.strokeStyle = override ? '#6ad08a' : '#e8a33d';
    ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    // Feet anchor marker.
    ctx.fillStyle = '#fff';
    ctx.fillRect(COL_ANCHOR_X - 1, COL_FEET_Y - 1, 2, 2);
    // Drag handles (right edge = width, top edge = height).
    ctx.fillStyle = override ? '#6ad08a' : '#e8a33d';
    ctx.fillRect(bx + bw - 2, by + bh / 2 - 2, 4, 4);
    ctx.fillRect(bx + bw / 2 - 2, by - 2, 4, 4);
  }

  private colBoxScreen(): { bx: number; by: number; bw: number; bh: number } {
    const box = this.effectiveBox(this.sprite, this.previewDir);
    return {
      bx: COL_ANCHOR_X + (box.offX - box.w / 2) * COL_SCALE,
      by: COL_FEET_Y + (box.offY - box.h) * COL_SCALE,
      bw: box.w * COL_SCALE,
      bh: box.h * COL_SCALE,
    };
  }

  private onColMouseDown(e: MouseEvent): void {
    if (!this.colCanvas) return;
    const rect = this.colCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { bx, by, bw, bh } = this.colBoxScreen();
    const right = bx + bw;
    const bottom = by + bh;
    let mode: 'move' | 'w' | 'h' | null = null;
    if (Math.abs(mx - right) < 7 && my > by - 7 && my < bottom + 7) mode = 'w';
    else if (Math.abs(my - by) < 7 && mx > bx - 7 && mx < right + 7) mode = 'h';
    else if (mx >= bx && mx <= right && my >= by && my <= bottom) mode = 'move';
    if (!mode) return;
    e.preventDefault();
    // Starting a drag promotes the current (possibly auto) box to an override.
    const box = { ...this.effectiveBox(this.sprite, this.previewDir) };
    if (!this.hasOverride(this.sprite)) this.setCol(this.sprite, box);
    this.colDrag = mode;
    this.dragStart = { mx, my, box };
  }

  private onColMouseMove(e: MouseEvent): void {
    if (!this.colDrag || !this.colCanvas) return;
    const rect = this.colCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = Math.round((mx - this.dragStart.mx) / COL_SCALE);
    const dy = Math.round((my - this.dragStart.my) / COL_SCALE);
    const s = this.dragStart.box;
    const box: EntityCol = { ...s };
    if (this.colDrag === 'move') {
      box.offX = s.offX + dx;
      box.offY = s.offY + dy;
    } else if (this.colDrag === 'w') {
      box.w = Math.max(2, s.w + dx * 2); // right edge out -> symmetric width grow
    } else {
      box.h = Math.max(2, s.h - dy); // top edge up (dy<0) -> taller
    }
    this.setCol(this.sprite, box);
    this.refreshColSection();
  }

  // --- small DOM helpers ---------------------------------------------------------------

  private mkBtn(label: string, fn: () => void, parent: HTMLElement, accent = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#2c1a3d;color:#b06de8;border:1px solid #b06de8;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  private mkInput(parent: HTMLElement, name: string, label: string, onChange: (v: string) => void): HTMLInputElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'width:56px;color:#9fb8cc;';
    r.appendChild(l);
    const i = document.createElement('input');
    i.style.cssText =
      'width:72px;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    i.onchange = () => onChange(i.value);
    r.appendChild(i);
    parent.appendChild(r);
    this.fields.set(name, i);
    return i;
  }
}

export const entityManagerTool = new EntityManagerTool();
