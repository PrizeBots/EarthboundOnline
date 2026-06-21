import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { Direction } from '../../types';
import { drawSprite, loadSpriteGroup, listSpriteGroupIds } from '../../engine/SpriteManager';
import { customSpriteGroupIds } from '../../engine/CustomSprites';
import { getSpriteName } from '../../engine/SpriteNames';
import { createSpritePicker, drawSpriteGroupThumb, SpritePicker } from '../../engine/SpritePicker';
import { checkCollision } from '../../engine/Collision';
import { loadNPCs } from '../../engine/NPCManager';
import {
  EntityDefs,
  EntityStats,
  EntityProps,
  EntityPropsOverride,
  DEFAULT_ENTITY_STATS,
} from '../../engine/EntityStats';
import { EntityPropsForm, SPAWNER_STAT_FIELDS } from '../components/EntityPropsForm';
import { loadJSON } from '../../engine/AssetLoader';
import { regionAt, regionLabel, regionOrder } from '../../engine/Regions';
import { entityManagerTool } from './EntityManagerTool';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';

// Enemy Spawner editor (EDITOR_TOOLS.md §Backlog). Place/configure the enemy
// spawners in enemy_spawns.json visually: assign the enemy sprite, where it
// spawns, how far it roams, how often, and the live cap. Saves the WHOLE file
// to the overrides layer (public/overrides/enemy_spawns.json — OUR authored
// content, no ROM base to merge), preferred over the committed default by both
// NPCManager (client) and server/npcSim.js. The committed assets file stays
// the fallback/default. One enemy type per spawner (mix by adding spawners).
//
// The marker turns RED when a spawn point is on a solid tile or sealed off from
// the street network — the exact bug that trapped the arcade sharks in a pocket
// (enemies that can't reach the road). The check mirrors npcSim's collision.

const FOOT_W = 14;
const FOOT_H = 8;
const FOOT_OY = -8;
// A spot whose reachable walkable area floods to fewer than this many 8px cells
// is a sealed pocket: roamers spawned there can never reach the streets.
const SEALED_MIN_CELLS = 60;
const FLOOD_CAP = 600;

// A spawner holds PLACEMENT/spawn-rate fields PLUS an optional sparse combat
// override (`props`). The override is the instance layer over the entity (sprite
// group) "mother" stats: blank fields inherit the entity's stats, a typed value
// overrides them for THIS spawner only. The server's resolveProps reads the
// override fields flat off the spawner object, so they're spread flat on save.
interface Spawner {
  name: string;
  sprite: number;
  x: number;
  y: number;
  // Behavior ranges are OPTIONAL per-spawner overrides: undefined = inherit the
  // entity's authored value (Entity Manager), the SAME blank-means-inherit model
  // as the combat `props` below. The server's resolveProps only honors these when
  // set, so leaving them blank lets the entity table drive a spawner's roam/aggro.
  wanderRadius?: number; // px — how far enemies roam from home (blank = inherit entity)
  detectRange?: number; // px — player within this aggros THIS spawner's enemies (blank = inherit)
  giveUpRange?: number; // px — once locked on, the chase breaks off past this (blank = inherit)
  maxActive: number;
  spawnIntervalMs: number;
  respawnDelayMs: number;
  enabled: boolean;
  // Sparse per-spawner combat override (hp/level/xp/damage/atk cd/speed/atk px).
  // Empty = inherit the entity's stats wholesale. Spread flat into the saved
  // spawner JSON so npcSim's resolveProps(over=spawner) picks them up.
  props: EntityPropsOverride;
  // Derived validity (recomputed on place / move / position edit), not saved.
  solid?: boolean;
  reach?: number;
}

interface EnemyFile {
  version?: number;
  enemySpriteGroups?: number[];
  entities?: EntityDefs;
  spawners?: (Partial<Spawner> & Partial<EntityStats>)[]; // legacy files may still carry per-spawner stats
}

// A fresh spawner carries only its spawn-rate/pool fields; roam/aggro/chase are
// left UNSET so they inherit the entity's authored values (Entity Manager). The
// inherited defaults live in DEFAULT_ENTITY_STATS (detect 220 / giveUp 560 /
// wander 256 — KEEP IN SYNC with npcSim).
const DEFAULTS: Omit<
  Spawner,
  'name' | 'x' | 'y' | 'props' | 'wanderRadius' | 'detectRange' | 'giveUpRange'
> = {
  sprite: 284,
  maxActive: 4,
  spawnIntervalMs: 3500,
  respawnDelayMs: 9000,
  enabled: true,
};

// Pool slots per spawner: a buffer above the live cap so killed enemies can
// keep respawning toward the cap without stalling on the respawn delay. Must
// match the value the loaders build from, so it is computed here at save time.
function derivePoolSize(maxActive: number): number {
  return Math.max(maxActive + 3, Math.round(maxActive * 1.6));
}

function isSolidSpot(x: number, y: number): boolean {
  return checkCollision(x - FOOT_W / 2, y + FOOT_OY, FOOT_W, FOOT_H);
}

// Bounded flood fill of the walkable area around a point (8px grid), capped so
// it is cheap to run on placement. A small result = a sealed pocket.
function floodReach(x: number, y: number): number {
  const STEP = 8;
  const seen = new Set<string>();
  const start = `${Math.round(x / STEP)},${Math.round(y / STEP)}`;
  seen.add(start);
  const stack: [number, number][] = [[Math.round(x / STEP), Math.round(y / STEP)]];
  let count = 0;
  while (stack.length && count < FLOOD_CAP) {
    const [gx, gy] = stack.pop()!;
    if (isSolidSpot(gx * STEP, gy * STEP)) continue;
    count++;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const k = `${gx + dx},${gy + dy}`;
      if (!seen.has(k)) {
        seen.add(k);
        stack.push([gx + dx, gy + dy]);
      }
    }
  }
  return count;
}

class EnemySpawnerTool implements EditorTool {
  id = 'enemies';
  name = 'Enemy Spawner';
  description = 'Place enemy spawn points: assign the enemy, roam range, rate and live cap.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private spawners: Spawner[] = [];
  private spriteGroupExtras: number[] = []; // hostile sprites not tied to a spawner
  // Per-entity stats (Entity Manager's domain). These are the "mother" stats a
  // spawner inherits; round-tripped untouched on save and shown as the inherited
  // placeholders under each spawner's combat override.
  private entities: EntityDefs = {};
  // Canon ROM enemy catalog (enemies.json bySprite) — the stat baseline beneath
  // the authored `entities` table, mirrored from the Entity Manager so the
  // inherited stats shown here MATCH what the mother entity shows there.
  private catalogStats: Record<string, Partial<EntityStats>> = {};
  private sel: Spawner | null = null;
  private placing = false;
  private dragging = false;
  private hover: WorldPoint = { x: 0, y: 0 };
  private requestedSheets = new Set<number>();

  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private fields = new Map<string, HTMLInputElement>();
  private spritePicker: SpritePicker | null = null;
  // Spawner-list organization (the list grows large once ROM placements are
  // imported): a free-text filter (name or #sprite) + a state filter, with a
  // result count. Sorted by name so same-enemy spawners group together.
  private listSearch = '';
  private listFilter: 'all' | 'on' | 'off' | 'bad' = 'all';
  private countEl: HTMLSpanElement | null = null;
  // How the list is grouped: by enemy TYPE (sprite) or by AREA (town/region the
  // spawn point sits in — via Regions.regionAt). Area grouping answers "where are
  // my spawners" once they're scattered across the whole map. Persisted so the
  // choice sticks between sessions (localStorage idiom, like MuteButton/Auth).
  private groupBy: 'enemy' | 'area' =
    (typeof localStorage !== 'undefined' && localStorage.getItem('eb_spawner_groupby')) === 'area'
      ? 'area'
      : 'enemy';
  // Outline state: which group headers are expanded (keyed `e:<sprite>` for enemy
  // grouping, `a:<region>` for area grouping). Collapsed is the resting state, so
  // dozens of spawners collapse to a handful of headers. A search/state filter
  // auto-expands matching groups.
  private expanded = new Set<string>();

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('enemies', () => this.save());
    // Build the panel synchronously FIRST so it always appears on launch — the
    // shell ignores activate()'s return, so an async throw here would otherwise
    // vanish silently and leave no panel. Data loads after, non-blocking.
    this.buildPanel();
    this.refreshList();
    this.rebuildForm();
    void this.loadAndRefresh();
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      await this.load();
    } catch (e) {
      console.error('[EnemySpawner] failed to load enemy_spawns', e);
      this.shell?.toast(`Couldn't load spawners: ${e}`, true);
      return;
    }
    this.refreshList();
    this.rebuildForm();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.placing = false;
    this.dragging = false;
    this.sel = null;
  }

  private async load(): Promise<void> {
    // Override (live authoring) wins over the committed default. Guard each
    // fetch: a missing/!ok response or a non-JSON body (dev-server fallbacks)
    // must degrade to the next source, never reject and kill the panel.
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
    // Read-only entity stats (to show what a spawner's sprite inherits) come from
    // the master table — overrides/entities.json (Entity Manager). Back-compat:
    // pre-split saves kept it inside enemy_spawns.json under `entities`.
    const entOv = await loadOverride<{ entities?: EntityDefs }>('entities.json').catch(() => null);
    this.entities = { ...(entOv?.entities ?? cfg?.entities ?? {}) };
    await this.loadCatalog();
    const spawnerSprites = new Set<number>();
    this.spawners = (cfg?.spawners ?? []).map((s) => {
      const sprite = s.sprite ?? DEFAULTS.sprite;
      const sp: Spawner = {
        name: s.name ?? 'spawner',
        sprite,
        x: s.x ?? 0,
        y: s.y ?? 0,
        // Optional overrides: absent in the file = inherit the entity. Legacy
        // files that baked in explicit values keep them (they load as overrides).
        wanderRadius: s.wanderRadius ?? undefined,
        detectRange: s.detectRange ?? undefined,
        giveUpRange: s.giveUpRange ?? undefined,
        maxActive: s.maxActive ?? DEFAULTS.maxActive,
        spawnIntervalMs: s.spawnIntervalMs ?? DEFAULTS.spawnIntervalMs,
        respawnDelayMs: s.respawnDelayMs ?? DEFAULTS.respawnDelayMs,
        enabled: s.enabled !== false,
        // Gather the flat combat fields the file carries into the sparse override.
        props: this.readOverride(s),
      };
      spawnerSprites.add(sp.sprite);
      this.revalidate(sp);
      return sp;
    });
    // Preserve any hostile sprite ids that aren't represented by a spawner.
    this.spriteGroupExtras = (cfg?.enemySpriteGroups ?? []).filter((id) => !spawnerSprites.has(id));
  }

  /** Load the canon ROM enemy catalog as the stat baseline beneath `entities`,
   *  mirroring EntityManagerTool so inherited stats match what it shows. */
  private async loadCatalog(): Promise<void> {
    const cat = await loadJSON<{
      bySprite?: Record<string, { hp?: number; xp?: number; level?: number; damage?: number }>;
    }>('/assets/map/enemies.json').catch(() => null);
    this.catalogStats = {};
    for (const [k, v] of Object.entries(cat?.bySprite ?? {})) {
      const cs: Partial<EntityStats> = {};
      if (typeof v?.hp === 'number') cs.hp = v.hp;
      if (typeof v?.xp === 'number') cs.xp = v.xp;
      if (typeof v?.level === 'number') cs.level = v.level;
      if (typeof v?.damage === 'number') cs.damage = v.damage;
      this.catalogStats[k] = cs;
    }
  }

  /** Pull a spawner's sparse combat override out of its flat saved fields (only
   *  the keys the form/server honor — see SPAWNER_STAT_FIELDS / resolveProps). */
  private readOverride(s: Partial<EntityStats>): EntityPropsOverride {
    const o: EntityPropsOverride = {};
    for (const f of SPAWNER_STAT_FIELDS) {
      const v = s[f.key] as number | undefined;
      if (v != null) o[f.key] = v;
    }
    return o;
  }

  /** Inherited "mother" stats for a sprite: DEFAULT < canon catalog < authored
   *  entity table — the SAME effective values the Entity Manager shows. */
  private baselineFor(sprite: number): EntityProps {
    return {
      ...DEFAULT_ENTITY_STATS,
      ...this.catalogStats[String(sprite)],
      ...this.entities[String(sprite)],
    } as EntityProps;
  }

  private revalidate(sp: Spawner): void {
    sp.solid = isSolidSpot(sp.x, sp.y);
    sp.reach = sp.solid ? 0 : floodReach(sp.x, sp.y);
  }

  // Effective behavior ranges: the spawner's own override if set, else the value
  // the entity (Entity Manager → DEFAULT_ENTITY_STATS floor) resolves to — what
  // the server actually uses. Drives the wander ring + the inherited placeholders.
  private effWander(sp: Spawner): number {
    return sp.wanderRadius ?? this.baselineFor(sp.sprite).wanderRadius ?? 256;
  }
  private effDetect(sp: Spawner): number {
    return sp.detectRange ?? this.baselineFor(sp.sprite).detectRange ?? 220;
  }
  private effGiveUp(sp: Spawner): number {
    return sp.giveUpRange ?? this.baselineFor(sp.sprite).giveUpRange ?? 560;
  }

  // --- save ----------------------------------------------------------------------------

  private async save(): Promise<void> {
    const groups = new Set<number>(this.spriteGroupExtras);
    for (const s of this.spawners) if (s.enabled) groups.add(s.sprite);
    // enemy_spawns.json is now PURELY the spawner config (spawners + enemy
    // classification). The entity master table lives in entities.json (Entity
    // Manager), so we no longer write `entities` here — saving a spawner also
    // strips any legacy `entities` left over from before the split.
    const file: EnemyFile = {
      version: 1,
      enemySpriteGroups: [...groups],
      spawners: this.spawners.map((s) => ({
        name: s.name,
        sprite: s.sprite,
        x: Math.round(s.x),
        y: Math.round(s.y),
        // Roam/aggro/chase are written ONLY when overridden; omitted = the spawner
        // inherits the entity's authored ranges (resolveProps pick/entityStat).
        ...(s.wanderRadius != null ? { wanderRadius: s.wanderRadius } : {}),
        ...(s.detectRange != null ? { detectRange: s.detectRange } : {}),
        ...(s.giveUpRange != null ? { giveUpRange: s.giveUpRange } : {}),
        poolSize: derivePoolSize(s.maxActive),
        maxActive: s.maxActive,
        spawnIntervalMs: s.spawnIntervalMs,
        respawnDelayMs: s.respawnDelayMs,
        enabled: s.enabled,
        // Sparse combat override, flat so npcSim's resolveProps(over=spawner)
        // reads it. Empty = nothing written, spawner inherits the entity stats.
        ...s.props,
      })),
    };
    await saveOverride('enemy_spawns.json', file);
    // Reload the editing client's enemies immediately; the server picks the
    // override up via its file watch. A change to the live pool size (add /
    // remove / enable / disable / max) shifts wire ids, so other connected
    // clients must refresh — see the toast.
    await loadNPCs();
    this.shell?.clearDirty('enemies');
    this.shell?.toast('Saved enemy spawners — live here; other clients refresh to resync');
  }

  // --- input ---------------------------------------------------------------------------

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (dragging && this.dragging && this.sel) {
      this.sel.x = Math.round(p.x);
      this.sel.y = Math.round(p.y);
      this.syncPositionFields();
    }
  }

  onMouseDown(p: WorldPoint): boolean {
    if (this.placing) {
      const sp: Spawner = {
        ...DEFAULTS,
        name: this.nextName(),
        x: Math.round(p.x),
        y: Math.round(p.y),
        props: {}, // fresh per-spawner override (starts fully inherited)
      };
      this.revalidate(sp);
      this.spawners.push(sp);
      this.sel = sp;
      this.placing = false;
      this.shell?.markDirty('enemies');
      this.refreshList();
      this.rebuildForm();
      if (sp.solid || (sp.reach ?? 0) < SEALED_MIN_CELLS) {
        this.shell?.toast(
          "Heads up: this spot is solid or sealed off — enemies can't reach the streets",
          true
        );
      }
      return true;
    }
    const hit = this.pickAt(p);
    if (hit) {
      this.sel = hit;
      this.dragging = true;
      this.refreshList();
      this.rebuildForm();
      return true;
    }
    return false; // let the shell pan
  }

  onMouseUp(): void {
    if (this.dragging && this.sel) {
      this.revalidate(this.sel);
      this.shell?.markDirty('enemies');
      this.rebuildForm();
    }
    this.dragging = false;
  }

  onKey(key: string): boolean {
    if (key === 'n') {
      this.startPlacing();
      return true;
    }
    if ((key === 'delete' || key === 'backspace') && this.sel) {
      this.deleteSelected();
      return true;
    }
    return false;
  }

  private pickAt(p: WorldPoint): Spawner | null {
    let best: Spawner | null = null;
    let bestD = 14; // world-px pick radius
    for (const s of this.spawners) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  private nextName(): string {
    let n = this.spawners.length + 1;
    const taken = new Set(this.spawners.map((s) => s.name));
    while (taken.has(`spawner-${n}`)) n++;
    return `spawner-${n}`;
  }

  private startPlacing(): void {
    this.placing = true;
    this.shell?.toast('Click the map to place the spawn point');
  }

  private deleteSelected(): void {
    if (!this.sel) return;
    const i = this.spawners.indexOf(this.sel);
    if (i >= 0) this.spawners.splice(i, 1);
    this.sel = null;
    this.shell?.markDirty('enemies');
    this.refreshList();
    this.rebuildForm();
  }

  // --- overlay -------------------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    for (const s of this.spawners) {
      const sx = s.x - camX;
      const sy = s.y - camY;
      const bad = s.solid || (s.reach ?? 0) < SEALED_MIN_CELLS;
      const color = !s.enabled
        ? 'rgba(140,140,140,0.7)'
        : bad
          ? 'rgba(255,70,70,0.95)'
          : 'rgba(232,80,80,0.9)';

      if (!this.requestedSheets.has(s.sprite)) {
        this.requestedSheets.add(s.sprite);
        loadSpriteGroup(s.sprite).catch(() => {});
      }
      ctx.globalAlpha = s.enabled ? 0.5 : 0.25;
      drawSprite(ctx, s.sprite, Direction.S, 0, sx, sy);
      ctx.globalAlpha = 1;

      // Wander-radius ring (effective: override, else inherited entity roam).
      ctx.strokeStyle = color;
      ctx.setLineDash(s === this.sel ? [] : [4, 4]);
      ctx.beginPath();
      ctx.arc(sx, sy, this.effWander(s), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Spawn-point marker (diamond) + foot box.
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6);
      ctx.lineTo(sx + 6, sy);
      ctx.lineTo(sx, sy + 6);
      ctx.lineTo(sx - 6, sy);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeRect(sx - FOOT_W / 2 + 0.5, sy + FOOT_OY + 0.5, FOOT_W, FOOT_H);

      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(s.name, sx, sy - 12);
      if (bad && s.enabled) {
        ctx.fillStyle = 'rgba(255,90,90,1)';
        ctx.fillText(s.solid ? '⚠ SOLID' : '⚠ SEALED', sx, sy + 18);
      }
      if (s === this.sel) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(sx - 9.5, sy - 9.5, 19, 19);
      }
      ctx.textAlign = 'left';
    }

    if (this.placing) {
      const sx = this.hover.x - camX;
      const sy = this.hover.y - camY;
      ctx.strokeStyle = 'rgba(255,120,120,0.9)';
      ctx.strokeRect(sx - 7, sy - 7, 14, 14);
    }
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #e85050;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'ENEMY SPAWNERS';
    title.style.cssText = 'color:#e85050;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn('+ New spawner (N)', () => this.startPlacing(), actions);
    // No Save button — edits (incl. a freshly placed spawner) auto-save via the
    // shell (registered 'enemies' handler), debounced and flushed on exit.
    this.panel.appendChild(actions);

    // Group-by toggle: organize the list by enemy type or by world area.
    const groupRow = document.createElement('div');
    groupRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const groupLbl = document.createElement('span');
    groupLbl.textContent = 'group by';
    groupLbl.title =
      'Organize the spawner list by enemy TYPE, or by the AREA (town/region) each spawn point sits in.';
    groupLbl.style.cssText = 'color:#9fb8cc;cursor:help;border-bottom:1px dotted #4a5a6a;';
    groupRow.appendChild(groupLbl);
    const groupSel = document.createElement('select');
    groupSel.title = groupLbl.title;
    groupSel.style.cssText =
      'flex:1;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 3px;';
    for (const [v, label] of [
      ['enemy', 'Enemy type'],
      ['area', 'Area (town / region)'],
    ] as [typeof this.groupBy, string][]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      o.selected = this.groupBy === v;
      groupSel.appendChild(o);
    }
    groupSel.onchange = () => {
      this.groupBy = groupSel.value as typeof this.groupBy;
      try {
        localStorage.setItem('eb_spawner_groupby', this.groupBy);
      } catch {
        /* private-mode / blocked storage — non-fatal */
      }
      this.expanded.clear(); // keys differ between groupings; start collapsed
      this.refreshList();
    };
    groupRow.appendChild(groupSel);
    this.panel.appendChild(groupRow);

    // Filter row: free-text search + a state dropdown + a result count. Keeps the
    // list usable once dozens/hundreds of ROM-imported spawners are present.
    const filterRow = document.createElement('div');
    filterRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const search = document.createElement('input');
    search.placeholder = 'filter name / #sprite…';
    search.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;' +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    search.oninput = () => {
      this.listSearch = search.value.trim().toLowerCase();
      this.refreshList();
    };
    filterRow.appendChild(search);
    const sel = document.createElement('select');
    sel.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 3px;';
    for (const [v, label] of [
      ['all', 'All'],
      ['on', 'Enabled'],
      ['off', 'Disabled'],
      ['bad', '⚠ Issues'],
    ] as [typeof this.listFilter, string][]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      this.listFilter = sel.value as typeof this.listFilter;
      this.refreshList();
    };
    filterRow.appendChild(sel);
    this.countEl = document.createElement('span');
    this.countEl.style.cssText = 'color:#7a8aa0;font-size:10px;white-space:nowrap;';
    filterRow.appendChild(this.countEl);
    this.panel.appendChild(filterRow);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.panel.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.panel.appendChild(this.formEl);

    const hint = document.createElement('div');
    hint.textContent = 'drag marker to move · Del to remove';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.panel.appendChild(hint);

    this.shell!.panelHost.appendChild(this.panel);
  }

  /** True if a spawner is geometrically invalid (in a wall / not enough room). */
  private isBad(s: Spawner): boolean {
    return !!s.solid || (s.reach ?? 0) < SEALED_MIN_CELLS;
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (this.spawners.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No spawners yet.';
      e.style.cssText = 'color:#667;';
      this.listEl.appendChild(e);
      if (this.countEl) this.countEl.textContent = '';
      return;
    }
    // Filter (search + state) first.
    const q = this.listSearch;
    const shown = this.spawners.filter((s) => {
      if (this.listFilter === 'on' && !s.enabled) return false;
      if (this.listFilter === 'off' && s.enabled) return false;
      if (this.listFilter === 'bad' && !this.isBad(s)) return false;
      if (!q) return true;
      return `${s.name} #${s.sprite}`.toLowerCase().includes(q);
    });
    if (this.countEl) this.countEl.textContent = `${shown.length}/${this.spawners.length}`;
    if (shown.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No matches.';
      e.style.cssText = 'color:#667;';
      this.listEl.appendChild(e);
      return;
    }

    // Group the visible spawners (by enemy type or by world area), collapsing
    // dozens of rows to a handful of headers.
    const groups = this.buildGroups(shown);

    // While filtering, force every matching group open so results are visible
    // without hunting for the toggle.
    const forceOpen = !!q || this.listFilter !== 'all';
    // Keep the selected spawner's group open so the highlight is never hidden.
    if (this.sel) this.expanded.add(this.groupKeyFor(this.sel));

    // In area mode the child rows name the enemy (the header is the place, not
    // the enemy); in enemy mode the header already is the enemy, so rows show
    // just the spawner name.
    const showEnemy = this.groupBy === 'area';

    for (const g of groups) {
      const open = forceOpen || this.expanded.has(g.key);
      const anyBad = g.kids.some((k) => this.isBad(k));

      // --- group header -------------------------------------------------------
      const header = document.createElement('div');
      header.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;' +
        'border-radius:3px;background:#161c24;';
      const caret = document.createElement('span');
      caret.textContent = open ? '▾' : '▸';
      caret.style.cssText = 'color:#7a8aa0;width:9px;';
      const hname = document.createElement('span');
      hname.textContent = g.label;
      hname.style.cssText =
        'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cde;font-weight:bold;';
      const cnt = document.createElement('span');
      cnt.textContent = anyBad ? `${g.kids.length} ⚠` : String(g.kids.length);
      cnt.style.cssText = `font-size:10px;color:${anyBad ? '#ff6a6a' : '#7a8aa0'};white-space:nowrap;`;
      header.append(caret, hname, cnt);
      header.onclick = () => {
        // Toggle is a no-op while a filter forces everything open.
        if (forceOpen) return;
        if (this.expanded.has(g.key)) this.expanded.delete(g.key);
        else this.expanded.add(g.key);
        this.refreshList();
      };
      this.listEl.appendChild(header);
      if (!open) continue;

      // --- children -----------------------------------------------------------
      for (const s of g.kids) this.listEl.appendChild(this.renderSpawnerRow(s, showEnemy));
    }
  }

  /** The group key a spawner falls under for the current grouping mode. */
  private groupKeyFor(s: Spawner): string {
    return this.groupBy === 'area' ? `a:${regionAt(s.x, s.y)}` : `e:${s.sprite}`;
  }

  /** Bucket the visible spawners into ordered, labeled groups for the current
   *  grouping mode. Enemy: by sprite, sorted/labeled by enemy name. Area: by the
   *  region each spawn point sits in, sorted by story order. */
  private buildGroups(shown: Spawner[]): { key: string; label: string; kids: Spawner[] }[] {
    const byKey = new Map<string, Spawner[]>();
    for (const s of shown) {
      const k = this.groupKeyFor(s);
      const g = byKey.get(k);
      if (g) g.push(s);
      else byKey.set(k, [s]);
    }

    if (this.groupBy === 'area') {
      // Sort kids within an area by enemy name then spawner name, so same enemies
      // cluster together under the place header.
      const enemyName = (s: Spawner) => getSpriteName(s.sprite) ?? `#${s.sprite}`;
      return [...byKey.keys()]
        .sort((a, b) => regionOrder(a.slice(2)) - regionOrder(b.slice(2)) || a.localeCompare(b))
        .map((key) => ({
          key,
          label: regionLabel(key.slice(2)),
          kids: byKey
            .get(key)!
            .sort(
              (a, b) => enemyName(a).localeCompare(enemyName(b)) || a.name.localeCompare(b.name)
            ),
        }));
    }

    // Enemy grouping: header = enemy name (#sprite), sorted by name.
    const nameOf = (key: string) => {
      const sprite = Number(key.slice(2));
      return `${getSpriteName(sprite) ?? 'enemy'} (#${sprite})`;
    };
    return [...byKey.keys()]
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .map((key) => ({
        key,
        label: nameOf(key),
        kids: byKey.get(key)!.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }

  /** One selectable spawner row. `showEnemy` prefixes the enemy name (area mode,
   *  where the header is the place rather than the enemy). */
  private renderSpawnerRow(s: Spawner, showEnemy: boolean): HTMLDivElement {
    const row = document.createElement('div');
    const bad = this.isBad(s);
    const sel = s === this.sel;
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:2px 4px 2px 18px;cursor:pointer;border-radius:3px;' +
      (sel ? 'background:#2a1818;' : '');
    const dot = document.createElement('span');
    dot.textContent = '●';
    dot.style.color = !s.enabled ? '#667' : bad ? '#ff5a5a' : '#e85050';
    const label = document.createElement('span');
    label.textContent = showEnemy
      ? `${getSpriteName(s.sprite) ?? `#${s.sprite}`} · ${s.name}`
      : s.name;
    label.style.cssText =
      'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      (s.enabled ? '' : 'color:#778;');
    row.appendChild(dot);
    row.appendChild(label);
    row.onclick = () => {
      this.sel = s;
      // Fly the view to the spawner so it's actually on screen (they're
      // scattered across town, usually off the current view).
      this.shell?.context.teleport(s.x, s.y);
      this.refreshList();
      this.rebuildForm();
    };
    return row;
  }

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    this.fields.clear();
    this.spritePicker = null;
    if (!this.sel) {
      const e = document.createElement('div');
      e.textContent = 'Select or place a spawner.';
      e.style.cssText = 'color:#667;';
      this.formEl.appendChild(e);
      return;
    }
    const s = this.sel;
    const form = this.formEl;

    // name + enabled
    const nameIn = this.mkInput(
      form,
      'name',
      'name',
      (v) => {
        s.name = v || 'spawner';
        this.refreshList();
      },
      120,
      'Display name for this spawner — shown on the map marker and in the list. Editor-only label.'
    );
    nameIn.value = s.name;

    const enRow = this.mkRow(
      form,
      'on',
      'Enable/disable this spawner. Disabled spawners produce no enemies and are skipped when building the live enemy groups on save.'
    );
    const en = document.createElement('input');
    en.type = 'checkbox';
    en.checked = s.enabled;
    en.onchange = () => {
      s.enabled = en.checked;
      this.shell?.markDirty('enemies');
      this.refreshList();
    };
    enRow.appendChild(en);

    // enemy sprite — the shared sprite-preview dropdown (same component as the
    // Cast editor): a scrollable list of every sprite group, each row drawing
    // the real sprite next to its id + name.
    const spriteRow = this.mkRow(
      form,
      'enemy',
      'Which enemy sprite/entity spawns here. One enemy type per spawner — mix types by adding more spawners. Combat stats come from this entity (see read-only block below).'
    );
    spriteRow.style.alignItems = 'stretch'; // let the dropdown fill the row width
    this.spritePicker = createSpritePicker({
      // ROM sprite groups + standalone custom entities (Source Assets imports).
      sections: [{ values: [...listSpriteGroupIds(), ...customSpriteGroupIds()].map(String) }],
      initial: String(s.sprite),
      labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? ''}`.trim(),
      drawThumb: drawSpriteGroupThumb,
      onSelect: (v) => {
        s.sprite = Math.max(0, Number(v) | 0);
        this.shell?.markDirty('enemies');
        this.refreshList();
        this.rebuildForm(); // refresh inherited placeholders + entity-override block
      },
    });
    this.spritePicker.el.style.flex = '1';
    spriteRow.appendChild(this.spritePicker.el);

    // numeric stats
    const numField = (
      name: string,
      label: string,
      get: () => number,
      set: (n: number) => void,
      tip: string,
      revalidate = false
    ) => {
      const i = this.mkInput(
        form,
        name,
        label,
        (v) => {
          const n = parseFloat(v);
          if (Number.isNaN(n)) return;
          set(n);
          this.shell?.markDirty('enemies');
          if (revalidate && this.sel) {
            this.revalidate(this.sel);
            this.refreshList();
            this.rebuildForm();
          }
        },
        64,
        tip
      );
      i.value = String(get());
    };

    // Optional override field: BLANK = inherit the entity's value (shown as the
    // greyed placeholder); a typed number overrides it for this spawner only.
    const optField = (
      name: string,
      label: string,
      get: () => number | undefined,
      set: (n: number | undefined) => void,
      inherited: () => number,
      tip: string,
      clampMin = 1
    ) => {
      const i = this.mkInput(
        form,
        name,
        label,
        (v) => {
          const raw = v.trim();
          set(raw === '' ? undefined : Math.max(clampMin, Math.round(parseFloat(raw) || 0)));
          this.shell?.markDirty('enemies');
          this.refreshList();
          this.rebuildForm(); // refresh placeholder + the ring + dependent clamps
        },
        64,
        tip
      );
      const ov = get();
      i.value = ov != null ? String(ov) : '';
      i.placeholder = `${inherited()} (entity)`;
    };

    numField(
      'x',
      'x',
      () => s.x,
      (n) => (s.x = Math.round(n)),
      'World X (pixels) of the spawn point. Tip: drag the marker on the map instead.',
      true
    );
    numField(
      'y',
      'y',
      () => s.y,
      (n) => (s.y = Math.round(n)),
      'World Y (pixels) of the spawn point. Tip: drag the marker on the map instead.',
      true
    );
    optField(
      'radius',
      'roam',
      () => s.wanderRadius,
      (n) => (s.wanderRadius = n == null ? undefined : Math.max(0, n)),
      () => this.effWander(s),
      'Wander radius in px — how far enemies roam from the spawn point (the map ring). BLANK = inherit the entity’s roam. 0 = stationary.',
      0
    );
    optField(
      'aggro',
      'aggro',
      () => s.detectRange,
      (n) => (s.detectRange = n),
      () => this.effDetect(s),
      'Aggro radius in px — how close a player must get to wake this spawner’s enemies. BLANK = inherit the entity’s aggro.'
    );
    optField(
      'chase',
      'chase',
      () => s.giveUpRange,
      (n) => (s.giveUpRange = n == null ? undefined : Math.max(this.effDetect(s), n)),
      () => this.effGiveUp(s),
      'Chase give-up distance in px — a locked-on enemy pursues until the target is this far, then returns home. BLANK = inherit the entity’s value. Never below aggro.'
    );
    numField(
      'rate',
      'rate s',
      () => s.spawnIntervalMs / 1000,
      (n) => (s.spawnIntervalMs = Math.max(200, Math.round(n * 1000))),
      'Spawn interval in seconds — how often this spawner tries to add an enemy, up to the live cap. Min 0.2s.'
    );
    numField(
      'max',
      'max',
      () => s.maxActive,
      (n) => (s.maxActive = Math.max(1, Math.round(n))),
      'Live cap — the most enemies from this spawner alive at once. Min 1.'
    );
    numField(
      'respawn',
      'resp s',
      () => s.respawnDelayMs / 1000,
      (n) => (s.respawnDelayMs = Math.max(0, Math.round(n * 1000))),
      'Respawn delay in seconds after an enemy dies before its slot refills toward the cap.'
    );

    // Combat stats — EDITABLE per-spawner override. Blank inherits the entity's
    // ("mother") stats; a typed value overrides it for this spawner only.
    this.addEntityOverride(form, s);

    // validity readout
    const status = document.createElement('div');
    const bad = s.solid || (s.reach ?? 0) < SEALED_MIN_CELLS;
    status.textContent = s.solid
      ? '⚠ on a solid tile — move it'
      : (s.reach ?? 0) < SEALED_MIN_CELLS
        ? `⚠ sealed pocket (${s.reach} cells) — won't reach streets`
        : `✓ on open streets (${s.reach}${(s.reach ?? 0) >= FLOOD_CAP ? '+' : ''} cells)`;
    status.style.cssText = `font-size:10px;color:${bad ? '#ff6a6a' : '#7fe07f'};`;
    form.appendChild(status);

    this.mkBtn('Delete spawner', () => this.deleteSelected(), form);
  }

  /** Editable per-spawner combat override. Each field is BLANK when inherited
   *  (placeholder = the entity's "mother" stat) and overrides for this spawner
   *  only when typed. A jump to the shared entity stays available below. */
  private addEntityOverride(form: HTMLElement, s: Spawner): void {
    const propsForm = new EntityPropsForm({
      fields: SPAWNER_STAT_FIELDS,
      onChange: (key, value) => {
        if (value === undefined) delete s.props[key];
        else (s.props as Record<string, number>)[key] = value;
        this.shell?.markDirty('enemies');
        // Re-render so the set/inherited styling (label colour + ✕ reset) updates.
        propsForm.update({
          kind: 'enemy',
          baseline: this.baselineFor(s.sprite),
          override: s.props,
        });
      },
    });
    propsForm.update({ kind: 'enemy', baseline: this.baselineFor(s.sprite), override: s.props });
    form.appendChild(propsForm.el);

    const note = document.createElement('div');
    note.textContent = `blank = inherits entity #${s.sprite} (the shared "mother" stats)`;
    note.style.cssText = 'color:#667;font-size:9px;';
    form.appendChild(note);

    this.mkBtn(
      'Edit shared entity →',
      () => {
        entityManagerTool.requestEntity(s.sprite);
        this.shell?.openTool('entity-manager');
      },
      form
    );
  }

  private syncPositionFields(): void {
    const xi = this.fields.get('x');
    const yi = this.fields.get('y');
    if (xi) xi.value = String(this.sel?.x ?? '');
    if (yi) yi.value = String(this.sel?.y ?? '');
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
        ? 'background:#3d1414;color:#e85050;border:1px solid #e85050;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  private mkRow(parent: HTMLElement, label: string, tip?: string): HTMLDivElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'width:46px;color:#9fb8cc;' + (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    r.appendChild(l);
    parent.appendChild(r);
    return r;
  }

  private mkInput(
    parent: HTMLElement,
    name: string,
    label: string,
    onChange: (v: string) => void,
    width = 64,
    tip?: string
  ): HTMLInputElement {
    const r = this.mkRow(parent, label, tip);
    const i = document.createElement('input');
    i.style.cssText =
      `width:${width}px;font:11px monospace;background:#0c1014;color:#cde;` +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    if (tip) i.title = tip;
    i.onchange = () => onChange(i.value);
    r.appendChild(i);
    this.fields.set(name, i);
    return i;
  }
}

export const enemySpawnerTool = new EnemySpawnerTool();
