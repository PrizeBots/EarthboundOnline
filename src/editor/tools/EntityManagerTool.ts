import { EditorTool, EditorShellApi } from '../types';
import {
  listSpriteGroupIds,
  loadSpriteGroup,
  getSpriteGroupMeta,
  drawSprite,
} from '../../engine/SpriteManager';
import { getSpriteName, setSpriteNameOverride } from '../../engine/SpriteNames';
import { customSpriteGroupIds } from '../../engine/CustomSprites';
import { createSpritePicker, drawSpriteGroupThumb, SpritePicker } from '../../engine/SpritePicker';
import { loadNPCs } from '../../engine/NPCManager';
import {
  EntityStats,
  EntityDefs,
  EntityCol,
  DEFAULT_ENTITY_STATS,
  CombatPersonality,
  COMBAT_PERSONALITY_OPTIONS,
  EntityProps,
} from '../../engine/EntityStats';
import { EntityPropsForm, ENTITY_STAT_FIELDS, FieldKey } from '../components/EntityPropsForm';
import { loadJSON } from '../../engine/AssetLoader';
import { Direction } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import { openSpriteEditor } from '../../engine/spriteEditor';

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

// --- desktop / folder organization -----------------------------------------------------
// The gallery is a file-explorer-style "desktop": entities are icons that live
// in folders. A folder is just a named container with an optional parent (so
// folders can nest). `assign` maps a sprite id -> the folder it lives in; an
// absent entry means it sits on the Desktop (root). All of this is OUR authored
// metadata (no ROM pixels), saved to overrides/entity_folders.json.
interface EntityFolder {
  id: string;
  name: string;
  parent: string | null; // null = on the Desktop
}
interface FoldersFile {
  version?: number;
  folders?: EntityFolder[];
  assign?: Record<string, string>; // spriteId -> folderId
}
// What the drag is carrying: the current entity selection, or a single folder
// being re-parented. Set on dragstart, consumed on drop.
type DragPayload = { type: 'entities' } | { type: 'folder'; id: string };

// Combat-stat fields now come from the shared EntityPropsForm (ENTITY_STAT_FIELDS).

// Collision-box preview geometry. The sprite is drawn at COL_SCALE with its
// feet at (COL_ANCHOR_X, COL_FEET_Y); the box overlay maps with the same anchor.
const COL_PREVIEW_W = 152;
const COL_PREVIEW_H = 140;
const COL_SCALE = 2;
const COL_ANCHOR_X = 76;
const COL_FEET_Y = 116;
// Directions to cycle in the preview (friendly order), with their labels.
const DIR_CYCLE: [Direction, string][] = [
  [Direction.S, 'S'],
  [Direction.E, 'E'],
  [Direction.N, 'N'],
  [Direction.W, 'W'],
  [Direction.SE, 'SE'],
  [Direction.SW, 'SW'],
  [Direction.NE, 'NE'],
  [Direction.NW, 'NW'],
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
  private propsForm: EntityPropsForm | null = null;
  private picker: SpritePicker | null = null;
  private nameInput: HTMLInputElement | null = null;

  // --- center-panel preview picker ---
  // A large gallery of every entity sprite, shown over the editor's center area
  // (left of the right dock). Click a tile to select it; the right panel's
  // stats/collision follow. Toggled from the panel; open by default.
  private browser: HTMLDivElement | null = null;
  private browserGrid: HTMLDivElement | null = null;
  private browserCells = new Map<number, HTMLDivElement>();

  // --- desktop / folder state ---
  private folders: EntityFolder[] = [];
  private assign: Record<string, string> = {}; // spriteId -> folderId (absent = Desktop)
  private cwd: string | null = null; // currently open folder (null = Desktop)
  private selection = new Set<number>(); // multi-selected entity ids (for org)
  private selFolder: string | null = null; // currently picked folder tile (rename/delete)
  private search = '';
  private enemyIds = new Set<number>(); // ROM enemy catalog (auto-categorize)
  private bossIds = new Set<number>();
  // Canon ROM stats per sprite (hp/xp/level/damage) from enemies.json bySprite —
  // the baseline the runtime applies UNDER authored overrides. Shown in the stat
  // form so editing a real EB enemy starts from its canon values, not defaults.
  private catalogStats: Record<string, Partial<EntityStats>> = {};
  private folderTiles = new Map<string, HTMLDivElement>();
  private toolbarEl: HTMLDivElement | null = null;
  private breadcrumbEl: HTMLDivElement | null = null;
  private countEl: HTMLDivElement | null = null;
  private dragPayload: DragPayload | null = null;
  // Marquee (rubber-band) selection.
  private marquee: HTMLDivElement | null = null;
  private marqueeStart = { x: 0, y: 0 };
  private marqueeBase = new Set<number>(); // selection before the drag (ctrl = additive)
  private onMarqueeMoveBound = (e: MouseEvent) => this.onMarqueeMove(e);
  private onMarqueeUpBound = () => this.onMarqueeUp();

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
    registerSaveHandler('entity-folders', () => this.saveFolders());
    this.buildPanel();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    window.removeEventListener('mousemove', this.onColMoveBound);
    window.removeEventListener('mouseup', this.onColUpBound);
    window.removeEventListener('mousemove', this.onMarqueeMoveBound);
    window.removeEventListener('mouseup', this.onMarqueeUpBound);
    this.colDrag = null;
    this.closeBrowser();
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
    this.selection = new Set([this.sprite]);
    this.cwd = this.folderOf(this.sprite); // open into the handed-off entity's folder
    this.picker?.setValue(String(this.sprite));
    this.rebuildForm();
    if (this.browser) this.revealSprite(this.sprite);
    else this.highlightBrowser();
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
    this.openBrowser(); // large center-panel gallery, open by default
  }

  private async load(): Promise<void> {
    this.entities = { ...(await this.readEntities()) };
    this.colBoxes = await loadJSON<Record<string, Record<string, EntityCol>>>(
      '/assets/sprites/colboxes.json'
    ).catch(() => ({}));

    // ROM enemy catalog — drives auto-categorization (enemies/bosses) AND supplies
    // the canon stat baseline (hp/xp/level/damage) the runtime applies under
    // overrides, so the editor shows real EB values instead of generic defaults.
    const cat = await loadJSON<{
      bySprite?: Record<
        string,
        { boss?: boolean; hp?: number; xp?: number; level?: number; damage?: number }
      >;
    }>('/assets/map/enemies.json').catch(() => null);
    this.enemyIds.clear();
    this.bossIds.clear();
    this.catalogStats = {};
    for (const [k, v] of Object.entries(cat?.bySprite ?? {})) {
      const idn = Number(k);
      this.enemyIds.add(idn);
      if (v?.boss) this.bossIds.add(idn);
      const cs: Partial<EntityStats> = {};
      if (typeof v?.hp === 'number') cs.hp = v.hp;
      if (typeof v?.xp === 'number') cs.xp = v.xp;
      if (typeof v?.level === 'number') cs.level = v.level;
      if (typeof v?.damage === 'number') cs.damage = v.damage;
      this.catalogStats[k] = cs;
    }

    // Folder layout (our authored desktop). First run: seed the base folders and
    // auto-sort everything; afterwards we trust the saved file (manual moves win).
    const ff = await loadOverride<FoldersFile>('entity_folders.json').catch(() => null);
    if (ff?.folders?.length) {
      this.folders = ff.folders;
      this.assign = ff.assign ?? {};
    } else {
      this.autoOrganize();
    }

    if (!this.sprite) this.sprite = listSpriteGroupIds()[0] ?? 1;
  }

  /** The authored entity master table. New home: overrides/entities.json. Back-
   *  compat: pre-split saves kept it inside enemy_spawns.json under `entities`. */
  private async readEntities(): Promise<EntityDefs> {
    const ent = await loadOverride<{ entities?: EntityDefs }>('entities.json').catch(() => null);
    if (ent?.entities) return ent.entities;
    const legacy = await loadOverride<EnemyFile>('enemy_spawns.json').catch(() => null);
    return legacy?.entities ?? {};
  }

  /** The inherited baseline shown as placeholders: DEFAULT < canon ROM catalog,
   *  WITHOUT the authored entry (that's the override the form edits). */
  private baselineFor(sprite: number): EntityProps {
    return { ...DEFAULT_ENTITY_STATS, ...this.catalogStats[String(sprite)] } as EntityProps;
  }

  /** Push the current sprite's baseline + sparse override into the props form. */
  private refreshPropsForm(): void {
    this.propsForm?.update({
      kind: 'enemy', // ENTITY_STAT_FIELDS aren't kind-filtered; kind is unused here
      baseline: this.baselineFor(this.sprite),
      override: this.entities[String(this.sprite)] ?? {},
    });
  }

  /** Set (or clear, value === undefined) ONE authored stat — SPARSE: the entry
   *  holds only deltas from the baseline, so untouched fields keep inheriting
   *  (ROM catalog updates flow through). Drops an emptied entry entirely. */
  private setProp(sprite: number, key: FieldKey, value: number | undefined): void {
    const k = String(sprite);
    const e: EntityStats = { ...(this.entities[k] ?? {}) };
    if (value === undefined) delete e[key];
    else e[key] = value;
    if (Object.keys(e).length) this.entities[k] = e;
    else delete this.entities[k];
    this.shell?.markDirty('entities');
    this.refreshPropsForm();
  }

  // Set (or clear, with '') the townsfolk combat personality for a sprite group.
  private setCombat(sprite: number, val: CombatPersonality | ''): void {
    const k = String(sprite);
    const next: EntityStats = { ...(this.entities[k] ?? {}) };
    if (val) next.combat = val;
    else delete next.combat;
    if (Object.keys(next).length) this.entities[k] = next;
    else delete this.entities[k];
    this.shell?.markDirty('entities');
  }

  // --- save (the universal entity master table lives in its own file) ------------------

  private async save(): Promise<void> {
    // entities.json is the master for EVERY entity (all kinds). It's separate
    // from enemy_spawns.json, which is the enemy-spawner config (spawners +
    // enemy classification) — the Enemy Spawner tool owns that.
    await saveOverride('entities.json', { version: 1, entities: this.entities });
    await loadNPCs(); // hp/level apply on this client; server picks it up via file watch
    this.shell?.clearDirty('entities');
    this.shell?.toast('Saved entity stats — live here; other clients refresh to resync');
  }

  /** Select one sprite (from the dropdown, handoff, etc.): become the single
   *  selection, drive the stat form, and reveal it in the open desktop. */
  private selectSprite(sprite: number): void {
    this.selection = new Set([sprite]);
    this.selFolder = null;
    this.focusEntity(sprite);
    if (this.browser) this.revealSprite(sprite);
  }

  /** Make `sprite` the stat-form target (no selection/navigation side effects). */
  private focusEntity(sprite: number): void {
    this.sprite = sprite;
    void loadSpriteGroup(sprite).catch(() => {});
    this.picker?.setValue(String(sprite));
    this.rebuildForm();
    this.highlightBrowser();
  }

  /** Open the folder that holds `sprite` and scroll its icon into view. */
  private revealSprite(sprite: number): void {
    if (this.search) return; // flat search view already shows everything matching
    const folder = this.folderOf(sprite);
    if (this.cwd !== folder) {
      this.cwd = folder;
      this.renderGrid();
    }
    this.browserCells.get(sprite)?.scrollIntoView({ block: 'nearest' });
  }

  // --- desktop / folder organization ---------------------------------------------------

  /** The folder a sprite lives in, or null (Desktop). Orphans (folder deleted
   *  out from under the assignment) read as Desktop too. */
  private folderOf(id: number): string | null {
    const a = this.assign[String(id)];
    return a && this.folders.some((f) => f.id === a) ? a : null;
  }

  private folderName(id: string): string {
    return this.folders.find((f) => f.id === id)?.name ?? id;
  }

  /** Every entity id shown in this tool: the ROM sprite groups plus standalone
   *  custom groups minted from source art (Source Assets → New Entity). */
  private allIds(): number[] {
    return [...listSpriteGroupIds(), ...customSpriteGroupIds()];
  }

  private markFoldersDirty(): void {
    this.shell?.markDirty('entity-folders');
  }

  /** Ensure the base folders exist and file every still-unsorted entity. Manual
   *  placements are never disturbed — only Desktop/orphan entities get sorted. */
  private autoOrganize(): void {
    const ensure = (id: string, name: string) => {
      if (!this.folders.some((f) => f.id === id)) this.folders.push({ id, name, parent: null });
    };
    ensure('players', 'Players');
    ensure('bosses', 'Bosses');
    ensure('enemies', 'Enemies');
    ensure('npcs', 'NPCs & Townsfolk');
    ensure('vehicles', 'Vehicles');
    ensure('objects', 'Objects');
    ensure('custom', 'Custom');
    for (const id of this.allIds()) {
      if (this.folderOf(id)) continue; // already placed somewhere real
      const target = this.categoryFor(id);
      if (target) this.assign[String(id)] = target;
    }
    this.markFoldersDirty();
  }

  // A few proper-vehicle nouns (word-boundary). Only consulted in the object id
  // range so people like "Bus Driver"/"Trucker" (low ids) stay in NPCs.
  private static VEHICLE_RE = /\b(car|bus|taxi|truck|cart|bike|train|cab|wagon|tank|tram)\b/i;

  /** Best-guess base folder for a sprite from the ROM catalog + id ranges/names.
   *  Heroes 1-4, then ROM enemy catalog, then id ranges (NPCs 5-189, objects
   *  190+), pulling clear vehicles out of the objects range by name. */
  private categoryFor(id: number): string | null {
    if (id >= 100000) return 'custom'; // CUSTOM_GROUP_BASE — authored cast members
    if (this.bossIds.has(id)) return 'bosses';
    if (this.enemyIds.has(id)) return 'enemies';
    if (id >= 1 && id <= 4) return 'players'; // Ness, Paula, Jeff, Poo
    if (id <= 189) return 'npcs';
    const name = getSpriteName(id) ?? '';
    if (EntityManagerTool.VEHICLE_RE.test(name) && !/sign|stop/i.test(name)) return 'vehicles';
    return 'objects';
  }

  private async saveFolders(): Promise<void> {
    await saveOverride('entity_folders.json', {
      version: 1,
      folders: this.folders,
      assign: this.assign,
    });
    this.shell?.clearDirty('entity-folders');
    this.shell?.toast('Saved entity folders');
  }

  // --- center-panel desktop ------------------------------------------------------------

  private toggleBrowser(): void {
    if (this.browser) this.closeBrowser();
    else this.openBrowser();
  }

  private closeBrowser(): void {
    window.removeEventListener('mousemove', this.onMarqueeMoveBound);
    window.removeEventListener('mouseup', this.onMarqueeUpBound);
    this.marquee?.remove();
    this.marquee = null;
    this.browser?.remove();
    this.browser = null;
    this.browserGrid = null;
    this.toolbarEl = null;
    this.breadcrumbEl = null;
    this.countEl = null;
    this.dragPayload = null;
    this.browserCells.clear();
    this.folderTiles.clear();
  }

  /** Build the desktop shell (chrome + toolbar + grid); contents via renderGrid. */
  private openBrowser(): void {
    if (this.browser) return;
    const el = document.createElement('div');
    // Sit in the editor's center: clear the top bar (~31px), the left Places nav
    // (248px column) and the right tool dock (256px) so nothing overlaps it.
    el.style.cssText =
      'position:fixed;top:41px;left:258px;right:266px;bottom:10px;z-index:88;display:flex;' +
      'flex-direction:column;background:#0d1014f5;color:#cde;font:12px monospace;' +
      'border:1px solid #b06de8;border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,.6);overflow:hidden;';
    // Keep clicks/keys/scroll inside the desktop (don't pan/zoom the world).
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('keyup', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation());

    // Title bar: name + global search + close.
    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a2438;';
    const title = document.createElement('div');
    title.textContent = 'ENTITY DESKTOP';
    title.style.cssText = 'color:#b06de8;font-weight:bold;letter-spacing:1px;';
    head.appendChild(title);
    const search = document.createElement('input');
    search.placeholder = 'search all id or name…';
    search.style.cssText =
      'flex:1;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    search.oninput = () => {
      this.search = search.value.trim().toLowerCase();
      this.renderGrid();
    };
    head.appendChild(search);
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText =
      'font:12px monospace;padding:2px 9px;cursor:pointer;border-radius:3px;background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
    close.onclick = () => this.closeBrowser();
    head.appendChild(close);
    el.appendChild(head);

    // Toolbar: folder actions + breadcrumb + selection count.
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #2a2438;flex-wrap:wrap;';
    this.mkBtn('+ New Folder', () => this.newFolder(), this.toolbarEl);
    this.mkBtn('✎ Rename', () => this.renameFolder(), this.toolbarEl);
    this.mkBtn('🗑 Delete', () => this.deleteFolder(), this.toolbarEl);
    this.mkBtn(
      '⚙ Auto-organize',
      () => {
        this.autoOrganize();
        this.renderGrid();
        this.shell?.toast('Filed all unsorted entities into the base folders');
      },
      this.toolbarEl
    );
    this.breadcrumbEl = document.createElement('div');
    this.breadcrumbEl.style.cssText =
      'display:flex;align-items:center;gap:3px;flex:1;flex-wrap:wrap;color:#9fb8cc;';
    this.toolbarEl.appendChild(this.breadcrumbEl);
    this.countEl = document.createElement('div');
    this.countEl.style.cssText = 'color:#4ea3ff;white-space:nowrap;';
    this.toolbarEl.appendChild(this.countEl);
    el.appendChild(this.toolbarEl);

    // The icon grid (folders + entities for the current location).
    this.browserGrid = document.createElement('div');
    // Vertical scroll only; flex-wrap of fixed-size cards (predictable layout).
    this.browserGrid.style.cssText =
      'flex:1 1 auto;min-height:0;height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;' +
      'padding:10px;display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start;';
    // Wheel scrolls the grid explicitly (never reaching the editor's zoom handler).
    this.browserGrid.addEventListener(
      'wheel',
      (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.browserGrid!.scrollTop += e.deltaY;
      },
      { passive: false }
    );
    // Empty-space mousedown starts a marquee; dropping on empty space files the
    // dragged selection into the folder we're currently viewing.
    this.browserGrid.addEventListener('mousedown', (e) => this.onGridMouseDown(e));
    this.browserGrid.addEventListener('dragover', (e) => e.preventDefault());
    this.browserGrid.addEventListener('drop', (e) => {
      e.preventDefault();
      this.handleDropOn(this.cwd);
    });
    el.appendChild(this.browserGrid);

    document.body.appendChild(el);
    this.browser = el;
    this.renderGrid();
    this.browserCells.get(this.sprite)?.scrollIntoView({ block: 'nearest' });
  }

  /** Repaint the grid for the current folder (or flat search results). */
  private renderGrid(): void {
    if (!this.browserGrid) return;
    this.browserGrid.innerHTML = '';
    this.browserCells.clear();
    this.folderTiles.clear();
    if (this.search) {
      // Flat global search: every matching entity, folders ignored.
      for (const id of this.allIds()) {
        const name = (getSpriteName(id) ?? '').toLowerCase();
        if (name.includes(this.search) || String(id).includes(this.search))
          this.browserGrid.appendChild(this.makeEntityCell(id));
      }
    } else {
      // Folders that live here, then the entities filed here.
      for (const f of this.folders.filter((f) => f.parent === this.cwd))
        this.browserGrid.appendChild(this.makeFolderTile(f));
      for (const id of this.allIds())
        if (this.folderOf(id) === this.cwd) this.browserGrid.appendChild(this.makeEntityCell(id));
    }
    this.highlightBrowser();
    this.updateToolbar();
  }

  /** Build one entity icon (draggable, selectable, click = focus stats). */
  private makeEntityCell(id: number): HTMLDivElement {
    const cell = document.createElement('div');
    cell.dataset.sprite = String(id);
    cell.draggable = true;
    cell.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px;' +
      'box-sizing:border-box;width:108px;flex:none;' +
      'border:1px solid #2a2438;border-radius:5px;cursor:pointer;background:#12131c;';
    cell.onmouseenter = () => {
      if (id !== this.sprite && !this.selection.has(id)) cell.style.background = '#1a1b28';
    };
    cell.onmouseleave = () => {
      if (id !== this.sprite && !this.selection.has(id)) cell.style.background = '#12131c';
    };
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    // Inner art/label ignore pointer events so the whole card is the drag/click target.
    c.style.cssText =
      'width:94px;height:94px;flex:none;image-rendering:pixelated;background:#0c1014;border-radius:4px;pointer-events:none;';
    drawSpriteGroupThumb(c, String(id));
    const lbl = document.createElement('div');
    lbl.textContent = `${id} ${getSpriteName(id) ?? ''}`.trim();
    lbl.style.cssText =
      'font-size:9px;color:#9fb8cc;text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;';
    cell.append(c, lbl);
    cell.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else {
        this.selection = new Set([id]);
      }
      this.selFolder = null;
      this.focusEntity(id); // show this one's stats in the right panel
      this.updateToolbar();
    };
    cell.ondragstart = (e) => {
      // Dragging an unselected icon first makes it the (sole) selection.
      if (!this.selection.has(id)) {
        this.selection = new Set([id]);
        this.focusEntity(id);
      }
      this.dragPayload = { type: 'entities' };
      e.dataTransfer?.setData('text/plain', 'entities');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    this.browserCells.set(id, cell);
    return cell;
  }

  /** Build one folder icon (open on dbl-click, drop target, re-parent on drag). */
  private makeFolderTile(f: EntityFolder): HTMLDivElement {
    const tile = document.createElement('div');
    tile.dataset.folder = f.id;
    tile.draggable = true;
    const baseBorder = () => (this.selFolder === f.id ? '#e8c14e' : '#3a3324');
    tile.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:5px;padding:6px;' +
      'box-sizing:border-box;width:108px;flex:none;border:1px solid ' +
      baseBorder() +
      ';border-radius:5px;cursor:pointer;background:' +
      (this.selFolder === f.id ? '#2a2410' : '#1a1710') +
      ';';
    const icon = document.createElement('div');
    icon.textContent = '📁';
    icon.style.cssText =
      'width:94px;height:94px;display:flex;align-items:center;justify-content:center;' +
      'font-size:52px;line-height:1;flex:none;background:#0c1014;border-radius:4px;pointer-events:none;';
    const nEnt = this.allIds().filter((id) => this.folderOf(id) === f.id).length;
    const nSub = this.folders.filter((x) => x.parent === f.id).length;
    const lbl = document.createElement('div');
    lbl.textContent = `${f.name} (${nEnt + nSub})`;
    lbl.style.cssText =
      'font-size:9px;color:#e8c14e;text-align:center;width:100%;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap;pointer-events:none;';
    tile.append(icon, lbl);
    tile.onclick = () => {
      this.selFolder = this.selFolder === f.id ? null : f.id;
      this.renderGrid();
    };
    tile.ondblclick = () => this.openFolder(f.id);
    tile.ondragstart = (e) => {
      this.dragPayload = { type: 'folder', id: f.id };
      e.dataTransfer?.setData('text/plain', 'folder');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    tile.ondragover = (e) => {
      e.preventDefault();
      tile.style.borderColor = '#6ad08a';
    };
    tile.ondragleave = () => {
      tile.style.borderColor = baseBorder();
    };
    tile.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation(); // beat the grid's "move to current folder" drop
      this.handleDropOn(f.id);
    };
    this.folderTiles.set(f.id, tile);
    return tile;
  }

  private openFolder(fid: string | null): void {
    this.cwd = fid;
    this.selFolder = null;
    this.selection.clear();
    this.renderGrid();
  }

  /** Rebuild the breadcrumb trail + selection counter. */
  private updateToolbar(): void {
    if (this.breadcrumbEl) {
      this.breadcrumbEl.innerHTML = '';
      const path: EntityFolder[] = [];
      let cur = this.cwd;
      while (cur) {
        const f = this.folders.find((x) => x.id === cur);
        if (!f) break;
        path.unshift(f);
        cur = f.parent;
      }
      const crumb = (label: string, fid: string | null) => {
        const a = document.createElement('span');
        a.textContent = label;
        a.style.cssText =
          'cursor:pointer;padding:1px 5px;border-radius:3px;' +
          (fid === this.cwd ? 'color:#cde;background:#2a2438;' : 'color:#7a8aa0;');
        a.onclick = () => this.openFolder(fid);
        a.ondragover = (e) => {
          e.preventDefault();
          a.style.background = '#1d3a2a';
        };
        a.ondragleave = () => {
          a.style.background = fid === this.cwd ? '#2a2438' : 'transparent';
        };
        a.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.handleDropOn(fid);
        };
        this.breadcrumbEl!.appendChild(a);
      };
      crumb('🖥 Desktop', null);
      for (const f of path) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.color = '#445';
        this.breadcrumbEl.appendChild(sep);
        crumb(f.name, f.id);
      }
    }
    if (this.countEl)
      this.countEl.textContent = this.selection.size ? `${this.selection.size} selected` : '';
  }

  // --- folder mutations ----------------------------------------------------------------

  private newFolder(): void {
    const name = window.prompt('Folder name:', 'New Folder');
    if (name == null) return;
    const id = 'f' + Date.now().toString(36);
    this.folders.push({ id, name: name.trim() || 'New Folder', parent: this.cwd });
    this.markFoldersDirty();
    this.renderGrid();
  }

  private renameFolder(): void {
    if (!this.selFolder) {
      this.shell?.toast('Click a folder to select it first', true);
      return;
    }
    const f = this.folders.find((x) => x.id === this.selFolder);
    if (!f) return;
    const name = window.prompt('Rename folder:', f.name);
    if (name == null) return;
    f.name = name.trim() || f.name;
    this.markFoldersDirty();
    this.renderGrid();
  }

  private deleteFolder(): void {
    if (!this.selFolder) {
      this.shell?.toast('Click a folder to select it first', true);
      return;
    }
    const f = this.folders.find((x) => x.id === this.selFolder);
    if (!f) return;
    if (!window.confirm(`Delete "${f.name}"? Its contents move up to the parent.`)) return;
    const parent = f.parent;
    // Re-home subfolders and entities to the deleted folder's parent.
    for (const x of this.folders) if (x.parent === f.id) x.parent = parent;
    for (const k of Object.keys(this.assign)) {
      if (this.assign[k] !== f.id) continue;
      if (parent) this.assign[k] = parent;
      else delete this.assign[k];
    }
    this.folders = this.folders.filter((x) => x.id !== f.id);
    this.selFolder = null;
    this.markFoldersDirty();
    this.renderGrid();
  }

  /** Resolve a drop (entities -> file them here; folder -> re-parent it here). */
  private handleDropOn(target: string | null): void {
    const p = this.dragPayload;
    this.dragPayload = null;
    if (!p) return;
    if (p.type === 'entities') this.assignSelectionTo(target);
    else this.setFolderParent(p.id, target);
  }

  /** Move every selected entity into `folderId` (null = Desktop). */
  private assignSelectionTo(folderId: string | null): void {
    if (!this.selection.size) return;
    for (const id of this.selection) {
      if (folderId) this.assign[String(id)] = folderId;
      else delete this.assign[String(id)];
    }
    const n = this.selection.size;
    this.markFoldersDirty();
    this.renderGrid();
    this.shell?.toast(
      `Moved ${n} ${n === 1 ? 'entity' : 'entities'} → ${folderId ? this.folderName(folderId) : 'Desktop'}`
    );
  }

  private setFolderParent(childId: string, parentId: string | null): void {
    if (childId === parentId) return;
    if (parentId && this.isAncestor(childId, parentId)) {
      this.shell?.toast("Can't move a folder into its own subfolder", true);
      return;
    }
    const f = this.folders.find((x) => x.id === childId);
    if (!f) return;
    f.parent = parentId;
    this.markFoldersDirty();
    this.renderGrid();
  }

  /** True if `ancestorId` is somewhere up `nodeId`'s parent chain. */
  private isAncestor(ancestorId: string, nodeId: string): boolean {
    let p = this.folders.find((f) => f.id === nodeId)?.parent ?? null;
    while (p) {
      if (p === ancestorId) return true;
      p = this.folders.find((f) => f.id === p)?.parent ?? null;
    }
    return false;
  }

  // --- marquee (rubber-band) selection -------------------------------------------------

  private onGridMouseDown(e: MouseEvent): void {
    if (e.target !== this.browserGrid || e.button !== 0) return; // empty space, left btn
    e.preventDefault();
    this.marqueeStart = { x: e.clientX, y: e.clientY };
    this.marqueeBase = e.ctrlKey || e.metaKey ? new Set(this.selection) : new Set();
    this.selection = new Set(this.marqueeBase);
    this.selFolder = null;
    this.marquee = document.createElement('div');
    this.marquee.style.cssText =
      'position:fixed;border:1px solid #4ea3ff;background:#4ea3ff22;z-index:90;pointer-events:none;';
    document.body.appendChild(this.marquee);
    window.addEventListener('mousemove', this.onMarqueeMoveBound);
    window.addEventListener('mouseup', this.onMarqueeUpBound);
    this.highlightBrowser();
    this.updateToolbar();
  }

  private onMarqueeMove(e: MouseEvent): void {
    if (!this.marquee) return;
    const x1 = Math.min(this.marqueeStart.x, e.clientX);
    const y1 = Math.min(this.marqueeStart.y, e.clientY);
    const x2 = Math.max(this.marqueeStart.x, e.clientX);
    const y2 = Math.max(this.marqueeStart.y, e.clientY);
    this.marquee.style.left = `${x1}px`;
    this.marquee.style.top = `${y1}px`;
    this.marquee.style.width = `${x2 - x1}px`;
    this.marquee.style.height = `${y2 - y1}px`;
    const next = new Set(this.marqueeBase);
    for (const [id, cell] of this.browserCells) {
      const r = cell.getBoundingClientRect();
      const hit = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
      if (hit) next.add(id);
    }
    this.selection = next;
    this.highlightBrowser();
    this.updateToolbar();
  }

  private onMarqueeUp(): void {
    window.removeEventListener('mousemove', this.onMarqueeMoveBound);
    window.removeEventListener('mouseup', this.onMarqueeUpBound);
    this.marquee?.remove();
    this.marquee = null;
    this.highlightBrowser();
    this.updateToolbar();
  }

  private highlightBrowser(): void {
    for (const [id, cell] of this.browserCells) {
      const cur = id === this.sprite;
      const sel = this.selection.has(id);
      cell.style.borderColor = cur ? '#b06de8' : sel ? '#4ea3ff' : '#2a2438';
      cell.style.background = cur ? '#241a33' : sel ? '#16263a' : '#12131c';
      cell.style.outline = sel && !cur ? '1px solid #4ea3ff' : 'none';
    }
  }

  /** Re-label an entity icon after a rename (the label is the cell's last child). */
  private refreshBrowserLabel(id: number): void {
    const lbl = this.browserCells.get(id)?.lastElementChild as HTMLElement | null;
    if (lbl) lbl.textContent = `${id} ${getSpriteName(id) ?? ''}`.trim();
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

    // Entity picker — every sprite group (ROM + custom), each row drawing the real sprite.
    const ids = this.allIds();
    this.picker = createSpritePicker({
      sections: [{ values: ids.map(String) }],
      initial: String(this.sprite || ids[0] || 1),
      labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? ''}`.trim(),
      drawThumb: drawSpriteGroupThumb,
      onSelect: (v) => this.selectSprite(Number(v) | 0),
    });
    this.panel.appendChild(this.picker.el);

    // Toggle for the large center-panel entity desktop (folders + drag-organize).
    this.mkBtn('🖥 Open entity desktop (center)', () => this.toggleBrowser(), this.panel);

    // Hand off to the Sprite Editor on the selected entity's sprite group (same
    // shortcut the Item Manager has for held-item art). Opens in Character mode.
    const editSprite = document.createElement('button');
    editSprite.textContent = '✎ Edit sprite in Sprite Editor →';
    editSprite.style.cssText =
      'font:11px monospace;padding:3px 8px;cursor:pointer;border-radius:3px;' +
      'background:#3a2e10;color:#d8a23a;border:1px solid #d8a23a;';
    editSprite.onclick = () => {
      if (this.sprite) void openSpriteEditor({ focusChar: this.sprite });
    };
    this.panel.appendChild(editSprite);

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
      this.rebuildForm(); // update the header
      this.refreshBrowserLabel(this.sprite); // update the center gallery tile
      this.shell?.toast(
        `Renamed entity #${this.sprite} to "${v || '(default)'}" — auto-saving names.json`
      );
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

    // No Save button — edits auto-save via the shell (registered 'entities' handler).

    this.shell!.panelHost.appendChild(this.panel);
  }

  private rebuildForm(): void {
    if (!this.formEl || !this.headerEl) return;
    this.formEl.innerHTML = '';
    this.headerEl.textContent = `${getSpriteName(this.sprite) ?? `#${this.sprite}`}  ·  entity #${this.sprite}`;
    if (this.nameInput) this.nameInput.value = getSpriteName(this.sprite) ?? '';

    // Combat stats via the shared form. Baseline = DEFAULT < canon ROM catalog
    // (what's inherited); the authored entry holds only the deltas. Editing the
    // sprite-group layer here is the SAME control set as the Placement / Spawner
    // forms, just a different baseline + target.
    this.propsForm = new EntityPropsForm({
      fields: ENTITY_STAT_FIELDS,
      onChange: (key, value) => this.setProp(this.sprite, key, value),
    });
    this.formEl.appendChild(this.propsForm.el);
    this.refreshPropsForm();

    // Combat personality dropdown — how this entity's townsfolk maneuver when an
    // enemy is near (server-driven; see npcSim). Unassigned = seeded mix.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const lbl = document.createElement('span');
    lbl.textContent = 'combat';
    lbl.style.cssText = 'width:56px;color:#9fb8cc;';
    row.appendChild(lbl);
    const sel = document.createElement('select');
    sel.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 4px;';
    const current = this.entities[String(this.sprite)]?.combat ?? '';
    for (const opt of COMBAT_PERSONALITY_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === current) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => this.setCombat(this.sprite, sel.value as CombatPersonality | '');
    row.appendChild(sel);
    this.formEl.appendChild(row);

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
    const k = String(sprite);
    const next: EntityStats = { ...(this.entities[k] ?? {}) };
    if (col) next.col = col;
    else delete next.col;
    if (Object.keys(next).length) this.entities[k] = next;
    else delete this.entities[k];
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
    this.mkBtn(
      'Reset to art (exact)',
      () => {
        this.setCol(this.sprite, null);
        this.refreshColSection();
        this.shell?.toast('Box reset to the exact per-direction art bounds');
      },
      btnRow
    );
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
    if (dirLbl)
      dirLbl.textContent = `facing ${dirName}${override ? '  ·  override (all dirs)' : ''}`;
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
    void loadSpriteGroup(this.sprite)
      .then(() => this.drawColPreview())
      .catch(() => this.drawColPreview());
  }

  private drawColPreview(): void {
    if (!this.colCanvas) return;
    const ctx = this.colCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, COL_PREVIEW_W, COL_PREVIEW_H);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.scale(COL_SCALE, COL_SCALE);
    drawSprite(
      ctx,
      this.sprite,
      this.previewDir,
      0,
      COL_ANCHOR_X / COL_SCALE,
      COL_FEET_Y / COL_SCALE
    );
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

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false
  ): HTMLButtonElement {
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
}

export const entityManagerTool = new EntityManagerTool();
