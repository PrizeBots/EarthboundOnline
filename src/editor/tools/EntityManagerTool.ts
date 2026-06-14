import { EditorTool, EditorShellApi } from '../types';
import { listSpriteGroupIds, loadSpriteGroup } from '../../engine/SpriteManager';
import { getSpriteName, setSpriteNameOverride } from '../../engine/SpriteNames';
import { createSpritePicker, drawSpriteGroupThumb, SpritePicker } from '../../engine/SpritePicker';
import { loadNPCs } from '../../engine/NPCManager';
import { EntityStats, EntityDefs, entityStatsFor } from '../../engine/EntityStats';
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
const STAT_FIELDS: {
  key: keyof EntityStats; label: string; min: number; scale?: number; float?: boolean;
}[] = [
  { key: 'hp', label: 'HP', min: 1 },
  { key: 'level', label: 'level', min: 1 },
  { key: 'xp', label: 'XP', min: 0 },
  { key: 'damage', label: 'damage', min: 0 },
  { key: 'attackCooldownMs', label: 'atk cd s', min: 50, scale: 1000 },
  { key: 'speed', label: 'speed', min: 0.1, float: true },
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

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('entities', () => this.save());
    this.buildPanel();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.picker = null;
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
