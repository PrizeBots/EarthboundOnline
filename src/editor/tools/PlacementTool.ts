import { loadJSON } from '../../engine/AssetLoader';
import {
  drawSprite,
  loadSpriteGroup,
  getSpriteGroupMeta,
  listSpriteGroupIds,
} from '../../engine/SpriteManager';
import { customSpriteGroupIds } from '../../engine/CustomSprites';
import { createSpritePicker, drawSpriteGroupThumb, SpritePicker } from '../../engine/SpritePicker';
import { getSpriteName, setSpriteNameOverride } from '../../engine/SpriteNames';
import {
  RawNPC,
  NpcOverrides,
  reloadNpcsLive,
  loadNPCs,
  Vehicle,
  CarTraffic,
  liveNpcForKey,
  entityBaseline,
} from '../../engine/NPCManager';
import { NPCKind } from '../../engine/NPC';
import { giftForKey } from '../../engine/Gifts';
import type { EntityPropsOverride, CombatPersonality } from '../../engine/EntityStats';
import { COMBAT_PERSONALITY_OPTIONS } from '../../engine/EntityStats';
import { EntityPropsForm, PropFieldDesc } from '../components/EntityPropsForm';
import { DoorOverrides, EditorDoor, getEditorDoorBase, loadDoors } from '../../engine/DoorManager';
import { DOOR_SFX, DEFAULT_DOOR_SFX, normalizeDoorSfx } from '../../engine/DoorSfx';
import { playSfx } from '../../engine/MusicManager';
import { checkCollision } from '../../engine/Collision';
import { Camera } from '../../engine/Camera';
import { Direction } from '../../types';
import { saveOverride } from '../saveOverride';
import { registerSaveHandler } from '../EditorHub';
import { EditorShellApi, EditorTool, WorldPoint } from '../types';
import { dialogueTool } from './DialogueTool';
import { trafficEditorTool } from './TrafficEditorTool';
import { entityManagerTool } from './EntityManagerTool';
import spawnBase from '../../spawn.json';

// Placement Editor (EDITOR_TOOLS.md §2) — three tabs:
//   NPCs:  move/add/delete NPC & prop placements -> overrides/npcs.json
//   Spawn: the player spawn marker               -> overrides/spawn.json
//   Doors: triggers, destinations, links         -> overrides/doors.json
// All tabs edit working copies (base + current overrides) and save DIFFS to
// the overrides layer; generated assets are never written. NPC person edits
// go live via npcSim's override watch; door saves re-run loadDoors() in this
// client immediately.

const FOOT_W = 14;
const FOOT_H = 8;
const VIEW_MARGIN = 48;

const DIR_NAMES: [Direction, string][] = [
  [Direction.S, 'S'],
  [Direction.N, 'N'],
  [Direction.W, 'W'],
  [Direction.E, 'E'],
  [Direction.NW, 'NW'],
  [Direction.SW, 'SW'],
  [Direction.SE, 'SE'],
  [Direction.NE, 'NE'],
];

/** Heading vector -> 8-way Direction, for facing a vehicle marker down its route. */
function dir8(dx: number, dy: number): Direction {
  if (dx === 0 && dy === 0) return Direction.S;
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
  return [3, 6, 0, 5, 2, 4, 1, 7][oct] as Direction;
}

interface NpcEntry {
  k: string;
  added: boolean;
  deleted: boolean;
  x: number;
  y: number;
  sprite: number;
  dir: number;
  kind: NPCKind;
  t: number | null;
  /** Sparse per-instance property override (folded over sprite-group/kind). */
  props: EntityPropsOverride;
}

/** Normalize a placement's stored kind for the NPC tab (cars live in the
 *  traffic list, not here). Preserves person + enemy; everything else is a prop. */
function npcKind(k: string | undefined): NPCKind {
  return k === 'person' ? 'person' : k === 'enemy' ? 'enemy' : k === 'gift' ? 'gift' : 'prop';
}

/** Shallow value-equality for sparse prop overrides (numeric/scalar fields). */
function propsEqual(a: EntityPropsOverride, b: EntityPropsOverride): boolean {
  const ak = Object.keys(a) as (keyof EntityPropsOverride)[];
  const bk = Object.keys(b) as (keyof EntityPropsOverride)[];
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

interface DoorEntry {
  key: string; // base trigger anchor "x,y", or "+n" for additions
  added: boolean;
  deleted: boolean;
  zone: boolean; // style=0 zone door — needs an authored link to be active
  worldX: number;
  worldY: number;
  destX: number;
  destY: number;
  destDir: number;
  style: number;
  sfx: string; // sound effect id played on use (see DoorSfx.ts)
}

type Mode = 'npcs' | 'spawn' | 'doors';

// Defaults for a car dropped here as a PARKED vehicle — its sprite/facing/route
// are refined in the Traffic Editor. KEEP IN SYNC with TrafficEditorTool +
// npcSim VEHICLE_HP / VEHICLE_DAMAGE.
const PLACE_VEHICLE_SPRITE = 255; // Car
const VEHICLE_DEFAULT_HP = 80;
const VEHICLE_DEFAULT_DAMAGE = 14;
type Snap = 1 | 8 | 32;

class PlacementTool implements EditorTool {
  id = 'placement';
  name = 'Placement Editor';
  description =
    'NPCs, the spawn point, and doors — move/add/delete in the live world. Saves diffs to the overrides layer.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private mode: Mode = 'npcs';
  private snap: Snap = 8;
  private hover: WorldPoint = { x: 0, y: 0 };

  // --- NPC state ---
  private npcBase = new Map<string, RawNPC>();
  private npcs: NpcEntry[] = [];
  private selNpc: NpcEntry | null = null;
  private placingKind: 'person' | 'prop' | null = null;
  // When set, the next placed prop uses this sprite (a handoff from another tool,
  // e.g. Room Builder → "→ Furniture"); otherwise a placement defaults to 1.
  private placingSprite: number | null = null;
  // Deferred handoff: a sprite to drop as a prop once this tool is active/built.
  private pendingPlace: number | null = null;
  private nextAddId = 0;

  // Vehicles are driven by the traffic system (car_traffic.json), not stored as
  // NPC placements — but they're surfaced here (read-only markers in the NPCs
  // tab) so a selected vehicle can hop to its route via the Traffic Editor.
  private vehicles: Vehicle[] = [];
  private selVehicle: Vehicle | null = null;
  private placingVehicle = false; // next click drops a parked car into car_traffic.json
  private dragVehicle: Vehicle | null = null; // body-drag to move a car (translates its route)
  private trafficSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Spawn state ---
  private spawn = { x: spawnBase.x, y: spawnBase.y, dir: spawnBase.dir };
  private draggingSpawn = false;

  // --- Door state ---
  private doorBase = new Map<string, EditorDoor>();
  private doors: DoorEntry[] = [];
  private selDoor: DoorEntry | null = null;
  private placingDoor = false;
  private nextDoorAddId = 0;
  private doorDragPart: 'trigger' | 'dest' | null = null;

  // Shared drag bookkeeping. dragStart holds whichever fields the active
  // drag mutates (x/y, worldX/worldY, destX/destY) for commitDrag's undo.
  private dragNpc: NpcEntry | null = null;
  private dragStart: Record<string, number> = {};
  private grabOffset = { x: 0, y: 0 };

  private panel: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private infoEl: HTMLDivElement | null = null;
  private fields = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private thumb: HTMLCanvasElement | null = null;
  private spritePicker: SpritePicker | null = null;
  private propsForm: EntityPropsForm | null = null;
  private requestedSheets = new Set<number>();

  // --- lifecycle -----------------------------------------------------------

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadAll();
    this.buildPanel();
    this.applyPendingPlace();
  }

  /** Tool handoff: arrive ready to drop `sprite` as a prop (Room Builder →
   *  "→ Furniture" uses this). Deferred until the tool is active/built. */
  requestPlaceProp(sprite: number): void {
    this.pendingPlace = sprite;
    if (this.shell && this.panel) this.applyPendingPlace();
  }

  private applyPendingPlace(): void {
    if (this.pendingPlace == null || !this.panel) return;
    const sprite = this.pendingPlace;
    this.pendingPlace = null;
    this.mode = 'npcs';
    this.selNpc = null;
    this.selVehicle = null;
    this.placingVehicle = false;
    this.placingDoor = false;
    this.rebuildForm(); // (re)creates the NPC form + sprite picker
    this.placingKind = 'prop';
    this.placingSprite = sprite;
    this.spritePicker?.setValue(String(sprite));
    this.shell?.toast('Click the map to place the furniture');
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.formEl = null;
    this.infoEl = null;
    this.fields.clear();
    this.selNpc = null;
    this.selDoor = null;
    this.selVehicle = null;
    this.placingKind = null;
    this.placingVehicle = false;
    this.placingDoor = false;
    this.dragNpc = null;
    this.dragVehicle = null;
    this.doorDragPart = null;
  }

  private async loadAll(): Promise<void> {
    const [rawNpcs, npcOv, doorOv, spawnOv, carOv, carBase] = await Promise.all([
      loadJSON<RawNPC[]>('/assets/map/npcs.json'),
      loadJSON<NpcOverrides>('/overrides/npcs.json').catch(() => null),
      loadJSON<DoorOverrides>('/overrides/doors.json').catch(() => null),
      loadJSON<{ x: number; y: number; dir: number }>('/overrides/spawn.json').catch(() => null),
      // Traffic vehicles (override wins over the committed default) — shown as
      // read-only markers so a vehicle can jump to the Traffic Editor.
      loadJSON<CarTraffic>('/overrides/car_traffic.json').catch(() => null),
      loadJSON<CarTraffic>('/assets/map/car_traffic.json').catch(
        () => ({ version: 1 }) as CarTraffic
      ),
    ]);
    this.vehicles = ((carOv ?? carBase)?.vehicles ?? []).filter((v) => v.waypoints?.length);

    // NPCs
    this.npcBase.clear();
    this.npcs = [];
    for (const r of rawNpcs) {
      if (r.k === undefined) continue;
      this.npcBase.set(r.k, r);
      const o = npcOv?.edits?.[r.k];
      const v = o === null ? r : (o ?? r);
      this.npcs.push({
        k: r.k,
        added: false,
        deleted: o === null,
        x: v.x,
        y: v.y,
        sprite: v.sprite,
        dir: v.dir,
        // A placement in the gift catalog (present/trash can/jar/…) shows as
        // kind 'gift' regardless of its stored kind — it's an item-container.
        kind: giftForKey(r.k) ? 'gift' : npcKind(v.kind),
        t: v.t ?? null,
        props: { ...(v.props ?? {}) },
      });
    }
    for (const a of npcOv?.additions ?? []) {
      this.npcs.push({
        k: `+${this.nextAddId++}`,
        added: true,
        deleted: false,
        x: a.x,
        y: a.y,
        sprite: a.sprite,
        dir: a.dir,
        kind: npcKind(a.kind),
        t: a.t ?? null,
        props: { ...(a.props ?? {}) },
      });
    }

    // Spawn
    if (spawnOv) this.spawn = { ...spawnOv };

    // Doors — base comes from DoorManager (already loaded by the game).
    this.doorBase.clear();
    this.doors = [];
    for (const d of getEditorDoorBase()) {
      this.doorBase.set(d.key, d);
      const o = doorOv?.edits?.[d.key];
      this.doors.push({
        key: d.key,
        added: false,
        deleted: o === null,
        zone: d.zone,
        worldX: o && o !== null ? (o.worldX ?? d.worldX) : d.worldX,
        worldY: o && o !== null ? (o.worldY ?? d.worldY) : d.worldY,
        destX: o && o !== null ? o.destX : d.destX,
        destY: o && o !== null ? o.destY : d.destY,
        destDir: o && o !== null ? o.destDir : d.destDir,
        style: o && o !== null ? o.style : d.style,
        sfx: normalizeDoorSfx(o && o !== null ? o.sfx : d.sfx),
      });
    }
    for (const a of doorOv?.additions ?? []) {
      this.doors.push({
        key: `+${this.nextDoorAddId++}`,
        added: true,
        deleted: false,
        zone: false,
        ...a,
        sfx: normalizeDoorSfx(a.sfx),
      });
    }

    this.shell?.toast(`Placement: ${this.npcs.length} NPCs, ${this.doors.length} doors loaded`);
    this.refreshPanel();
  }

  // --- override building -------------------------------------------------------

  private buildNpcOverrides(): NpcOverrides {
    const edits: NpcOverrides['edits'] = {};
    const additions: NpcOverrides['additions'] = [];
    for (const e of this.npcs) {
      if (e.added) {
        if (!e.deleted) additions!.push(this.npcToRaw(e));
        continue;
      }
      if (e.deleted) edits![e.k] = null;
      else if (this.isNpcEdited(e)) {
        edits![e.k] = this.npcToRaw(e);
      }
    }
    return { version: 1, edits, additions };
  }

  /** Set or clear (value === undefined) one per-instance prop on the selected
   *  NPC. Undoable + auto-saved like every other field, via mutate('props'). */
  private setProp(key: PropFieldDesc['key'], value: number | undefined): void {
    const e = this.selNpc;
    if (!e) return;
    const next: EntityPropsOverride = { ...e.props };
    if (value === undefined) delete next[key];
    else next[key] = value;
    if (propsEqual(next, e.props)) return; // no-op (re-typed same value)
    this.mutate('props', e, { props: next }, 'npcs');
  }

  /** Set or clear ('' = inherit) this instance's combat-personality override.
   *  Stored in the same sparse `props` as the numeric fields. */
  private setCombat(val: CombatPersonality | ''): void {
    const e = this.selNpc;
    if (!e) return;
    const next: EntityPropsOverride = { ...e.props };
    if (val) next.combat = val;
    else delete next.combat;
    if (propsEqual(next, e.props)) return;
    this.mutate('props', e, { props: next }, 'npcs');
  }

  private npcToRaw(e: NpcEntry): Omit<RawNPC, 'k'> {
    const r: Omit<RawNPC, 'k'> = { x: e.x, y: e.y, sprite: e.sprite, dir: e.dir, kind: e.kind };
    if (e.t !== null) r.t = e.t;
    if (Object.keys(e.props).length) r.props = { ...e.props };
    return r;
  }

  private buildDoorOverrides(): DoorOverrides {
    const edits: DoorOverrides['edits'] = {};
    const additions: DoorOverrides['additions'] = [];
    for (const e of this.doors) {
      if (e.added) {
        if (!e.deleted) {
          additions!.push({
            worldX: e.worldX,
            worldY: e.worldY,
            destX: e.destX,
            destY: e.destY,
            destDir: e.destDir,
            style: e.style,
            sfx: e.sfx,
          });
        }
        continue;
      }
      const b = this.doorBase.get(e.key)!;
      const changed =
        e.worldX !== b.worldX ||
        e.worldY !== b.worldY ||
        e.destX !== b.destX ||
        e.destY !== b.destY ||
        e.destDir !== b.destDir ||
        e.style !== b.style ||
        e.sfx !== b.sfx;
      if (e.deleted) {
        // Disabling a zone door = just don't author a link for it.
        if (!e.zone) edits![e.key] = null;
      } else if (changed) {
        const o: NonNullable<DoorOverrides['edits']>[string] = {
          destX: e.destX,
          destY: e.destY,
          destDir: e.destDir,
          style: e.style,
          sfx: e.sfx,
        };
        if (e.worldX !== b.worldX || e.worldY !== b.worldY) {
          o!.worldX = e.worldX;
          o!.worldY = e.worldY;
        }
        edits![e.key] = o;
      }
    }
    return { version: 1, edits, additions };
  }

  async saveNpcs(): Promise<void> {
    await saveOverride('npcs.json', this.buildNpcOverrides());
    await reloadNpcsLive(); // apply live in this client (like saveDoors -> loadDoors)
  }

  async saveSpawn(): Promise<void> {
    await saveOverride('spawn.json', this.spawn);
  }

  async saveDoors(): Promise<void> {
    await saveOverride('doors.json', this.buildDoorOverrides());
    await loadDoors(); // re-apply live in this client
  }

  // --- generic undoable mutation -------------------------------------------------

  private mutate<T extends object>(
    label: string,
    target: T,
    change: Partial<T>,
    domain: string
  ): void {
    const before: Partial<T> = {};
    for (const key of Object.keys(change) as (keyof T)[]) before[key] = target[key];
    this.shell!.run({
      label,
      do: () => {
        Object.assign(target, change);
        this.shell!.markDirty(domain);
        this.refreshPanel();
      },
      undo: () => {
        Object.assign(target, before);
        this.shell!.markDirty(domain);
        this.refreshPanel();
      },
    });
  }

  // --- shell events ----------------------------------------------------------------

  onMouseDown(p: WorldPoint): boolean {
    if (this.mode === 'npcs') return this.npcMouseDown(p);
    if (this.mode === 'spawn') return this.spawnMouseDown(p);
    return this.doorMouseDown(p);
  }

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (!dragging) return;
    if (this.dragNpc) {
      this.dragNpc.x = this.snapV(p.x + this.grabOffset.x);
      this.dragNpc.y = this.snapV(p.y + this.grabOffset.y);
      this.refreshFields();
    } else if (this.dragVehicle) {
      const wp0 = this.dragVehicle.waypoints[0];
      if (wp0) {
        const nx = this.snapV(p.x + this.grabOffset.x);
        const ny = this.snapV(p.y + this.grabOffset.y);
        const dx = nx - wp0[0];
        const dy = ny - wp0[1];
        // Move the whole route so a parked car relocates and a routed one keeps
        // its shape (drag the body; edit individual waypoints in Traffic).
        for (const wp of this.dragVehicle.waypoints) {
          wp[0] += dx;
          wp[1] += dy;
        }
      }
      this.refreshFields();
    } else if (this.draggingSpawn) {
      this.spawn.x = this.snapV(p.x);
      this.spawn.y = this.snapV(p.y);
      this.refreshFields();
    } else if (this.selDoor && this.doorDragPart === 'trigger') {
      this.selDoor.worldX = this.snapV(p.x + this.grabOffset.x);
      this.selDoor.worldY = this.snapV(p.y + this.grabOffset.y);
      this.refreshFields();
    } else if (this.selDoor && this.doorDragPart === 'dest') {
      this.selDoor.destX = this.snapV(p.x);
      this.selDoor.destY = this.snapV(p.y);
      this.refreshFields();
    }
  }

  onMouseUp(): void {
    if (this.dragNpc) {
      const e = this.dragNpc;
      this.dragNpc = null;
      this.commitDrag('move placement', e, { x: e.x, y: e.y }, 'npcs');
    } else if (this.dragVehicle) {
      const v = this.dragVehicle;
      this.dragVehicle = null;
      const wp0 = v.waypoints[0];
      // Only persist if it actually moved (a plain select-click also arms drag).
      if (wp0 && (wp0[0] !== this.dragStart.x || wp0[1] !== this.dragStart.y)) {
        void this.saveTraffic().catch((e) =>
          this.shell?.toast(`Couldn't save vehicle: ${e}`, true)
        );
      }
    } else if (this.draggingSpawn) {
      this.draggingSpawn = false;
      this.commitDrag('move spawn', this.spawn, { x: this.spawn.x, y: this.spawn.y }, 'spawn');
    } else if (this.selDoor && this.doorDragPart === 'trigger') {
      const e = this.selDoor;
      this.doorDragPart = null;
      this.commitDrag('move door trigger', e, { worldX: e.worldX, worldY: e.worldY }, 'doors');
    } else if (this.selDoor && this.doorDragPart === 'dest') {
      const e = this.selDoor;
      this.doorDragPart = null;
      this.commitDrag('move door dest', e, { destX: e.destX, destY: e.destY }, 'doors');
    }
  }

  /** Record an already-applied drag as an undoable step. */
  private commitDrag<T extends object>(
    label: string,
    target: T,
    applied: Partial<T>,
    domain: string
  ): void {
    const before: Partial<T> = {};
    let moved = false;
    for (const key of Object.keys(applied) as (keyof T)[]) {
      const startVal = this.dragStart[key as string];
      before[key] = startVal as T[keyof T];
      if (startVal !== applied[key]) moved = true;
    }
    if (!moved) return;
    this.shell!.run({
      label,
      do: () => {
        Object.assign(target, applied);
        this.shell!.markDirty(domain);
        this.refreshPanel();
      },
      undo: () => {
        Object.assign(target, before);
        this.shell!.markDirty(domain);
        this.refreshPanel();
      },
    });
  }

  onKey(key: string): boolean {
    if (key === 'delete' || key === 'backspace') {
      if (this.mode === 'npcs' && this.selNpc) {
        this.deleteSelected();
        return true;
      }
      if (this.mode === 'doors' && this.selDoor) {
        this.deleteSelected();
        return true;
      }
    }
    if (key === 'g') {
      this.snap = this.snap === 1 ? 8 : this.snap === 8 ? 32 : 1;
      this.shell?.toast(`Snap: ${this.snap === 1 ? 'free' : `${this.snap}px`}`);
      this.refreshPanel();
      return true;
    }
    if (key === 'tab') return false;
    return false;
  }

  /**
   * Delete the selected placement/door: mark it deleted (an undoable command —
   * Ctrl+Z restores it) and clear the selection so it vanishes from the world
   * and the panel. Save commits the removal to the overrides layer.
   */
  private deleteSelected(): void {
    if (this.mode === 'npcs' && this.selVehicle) {
      const v = this.selVehicle;
      this.vehicles = this.vehicles.filter((x) => x !== v);
      this.selVehicle = null;
      this.dragVehicle = null;
      void this.saveTraffic().catch((e) =>
        this.shell?.toast(`Couldn't delete vehicle: ${e}`, true)
      );
      this.rebuildForm();
    } else if (this.mode === 'npcs' && this.selNpc) {
      this.mutate('delete placement', this.selNpc, { deleted: true }, 'npcs');
      this.selNpc = null;
      this.refreshPanel();
    } else if (this.mode === 'doors' && this.selDoor) {
      this.mutate('delete door', this.selDoor, { deleted: true }, 'doors');
      this.selDoor = null;
      this.refreshPanel();
    }
  }

  private snapV(v: number): number {
    return Math.round(v / this.snap) * this.snap;
  }

  // --- NPC mode -----------------------------------------------------------------

  private npcMouseDown(p: WorldPoint): boolean {
    if (this.placingVehicle) {
      this.placingVehicle = false;
      void this.addVehicle(p);
      return true;
    }
    if (this.placingKind) {
      this.addNpc(p, this.placingKind);
      this.placingKind = null;
      this.placingSprite = null;
      return true;
    }
    // A vehicle marker takes the click first (it sits where its static prop used
    // to). A car is selected + edited with the SAME NPC form (plus an Edit-route
    // button); body-drag moves it (translating its whole route), like any NPC.
    const vh = this.vehicleHitTest(p);
    if (vh) {
      this.selNpc = null;
      this.selVehicle = vh;
      this.dragVehicle = vh;
      const wp0 = vh.waypoints[0];
      this.dragStart = { x: wp0?.[0] ?? p.x, y: wp0?.[1] ?? p.y };
      this.grabOffset = { x: (wp0?.[0] ?? p.x) - p.x, y: (wp0?.[1] ?? p.y) - p.y };
      this.rebuildForm(); // (re)build the NPC form bound to this car
      return true;
    }
    const hit = this.npcHitTest(p);
    if (!hit) {
      this.selNpc = null;
      if (this.selVehicle) {
        this.selVehicle = null;
        this.rebuildForm();
      } else {
        this.refreshPanel();
      }
      return false;
    }
    const wasVehicle = this.selVehicle !== null;
    this.selVehicle = null;
    this.selNpc = hit;
    this.dragNpc = hit;
    this.dragStart = { x: hit.x, y: hit.y };
    this.grabOffset = { x: hit.x - p.x, y: hit.y - p.y };
    if (wasVehicle)
      this.rebuildForm(); // back from vehicle form to the NPC form
    else this.refreshPanel();
    return true;
  }

  /** The vehicle marker under a point (front-most by feet-Y), or null. */
  private vehicleHitTest(p: WorldPoint): Vehicle | null {
    let best: Vehicle | null = null;
    let bestY = -Infinity;
    for (const v of this.vehicles) {
      const wp = v.waypoints[0];
      if (!wp) continue;
      const meta = getSpriteGroupMeta(v.sprite);
      const w = meta?.width ?? v.w ?? 40;
      const h = meta?.height ?? v.h ?? 28;
      if (p.x < wp[0] - w / 2 || p.x > wp[0] + w / 2 || p.y < wp[1] - h || p.y > wp[1]) continue;
      if (wp[1] > bestY) {
        bestY = wp[1];
        best = v;
      }
    }
    return best;
  }

  private npcHitTest(p: WorldPoint): NpcEntry | null {
    let best: NpcEntry | null = null;
    let bestY = -Infinity;
    for (const e of this.npcs) {
      if (e.deleted) continue;
      const meta = getSpriteGroupMeta(e.sprite);
      const w = meta?.width ?? 16;
      const h = meta?.height ?? 24;
      // Two ways to grab the same placement: its spawn ghost (home x/y) AND the
      // live in-game instance, which may have wandered off (persons/enemies).
      for (const [hx, hy] of this.npcHitSpots(e)) {
        if (p.x < hx - w / 2 || p.x > hx + w / 2 || p.y < hy - h || p.y > hy) continue;
        if (hy > bestY) {
          bestY = hy;
          best = e;
        } // front-most by feet-Y wins
      }
    }
    return best;
  }

  /** Click targets for a placement: its ghost (home), plus the live instance if
   *  it has moved away from home. */
  private npcHitSpots(e: NpcEntry): [number, number][] {
    const spots: [number, number][] = [[e.x, e.y]];
    const live = liveNpcForKey(e.k);
    if (live && !live.dead && (live.x !== e.x || live.y !== e.y)) spots.push([live.x, live.y]);
    return spots;
  }

  /**
   * Drop a PARKED car into the traffic system: one waypoint at the click, South
   * facing, default Car sprite. It persists to car_traffic.json immediately and
   * is selected so you can "Edit route in Traffic →" to give it a route (or just
   * leave it parked). Sprite/facing/route are refined in the Traffic Editor.
   */
  private async addVehicle(p: WorldPoint): Promise<void> {
    const v: Vehicle = {
      id: `v_${Date.now().toString(36)}${this.nextAddId++}`,
      name: this.nextVehicleName(),
      sprite: PLACE_VEHICLE_SPRITE,
      speed: 1,
      loop: true,
      enabled: true,
      hp: VEHICLE_DEFAULT_HP,
      damage: VEHICLE_DEFAULT_DAMAGE,
      dir: Direction.S,
      waypoints: [[this.snapV(p.x), this.snapV(p.y)]],
    };
    this.vehicles.push(v);
    try {
      await this.saveTraffic();
    } catch (e) {
      this.vehicles = this.vehicles.filter((x) => x !== v);
      this.shell?.toast(`Couldn't save vehicle: ${e}`, true);
      return;
    }
    this.selNpc = null;
    this.selVehicle = v;
    this.rebuildForm();
    this.shell?.toast('Parked car placed — use "Edit route in Traffic →" to make it drive.');
  }

  /** Lowest unused car-N name across the current vehicles. */
  private nextVehicleName(): string {
    const taken = new Set(this.vehicles.map((v) => v.name));
    let n = this.vehicles.length + 1;
    while (taken.has(`car-${n}`)) n++;
    return `car-${n}`;
  }

  /**
   * Persist the whole car_traffic.json overrides doc (shared with the Traffic
   * Editor — same shape) and live-reload this client's cars. The server picks the
   * file up via its watch. Changing the active-vehicle count shifts wire ids, so
   * other connected clients must refresh to resync.
   */
  private async saveTraffic(): Promise<void> {
    const file: CarTraffic = {
      version: 1,
      vehicles: this.vehicles.map((v) => {
        const meta = getSpriteGroupMeta(v.sprite);
        return {
          id: v.id,
          name: v.name,
          sprite: v.sprite,
          w: meta?.width ?? v.w ?? 40,
          h: meta?.height ?? v.h ?? 28,
          speed: v.speed,
          loop: v.loop,
          enabled: v.enabled,
          hp: v.hp ?? VEHICLE_DEFAULT_HP,
          damage: v.damage ?? VEHICLE_DEFAULT_DAMAGE,
          dir: v.dir ?? Direction.S,
          waypoints: v.waypoints.map(
            ([x, y]) => [Math.round(x), Math.round(y)] as [number, number]
          ),
          ...(v.t != null ? { t: v.t } : {}),
        };
      }),
    };
    await saveOverride('car_traffic.json', file);
    await loadNPCs();
  }

  /** Debounced car_traffic.json save — vehicle form edits don't go through the
   *  shell 'traffic' dirty channel (the Traffic Editor owns that handler), so we
   *  persist directly a beat after the last edit. */
  private queueTrafficSave(): void {
    if (this.trafficSaveTimer) clearTimeout(this.trafficSaveTimer);
    this.trafficSaveTimer = setTimeout(() => {
      this.trafficSaveTimer = null;
      void this.saveTraffic().catch((e) => this.shell?.toast(`Couldn't save vehicle: ${e}`, true));
    }, 350);
  }

  /** Apply an NPC-shaped field patch to the selected vehicle: x/y move its first
   *  waypoint (parked spot / route start), the rest set the matching field. Then
   *  queue a save. Mirrors `mutate` for the car_traffic.json side. */
  private setVehicleField(
    v: Vehicle,
    patch: { x?: number; y?: number; sprite?: number; dir?: number; t?: number | null }
  ): void {
    const wp = v.waypoints[0];
    if (patch.x != null && wp) wp[0] = patch.x;
    if (patch.y != null && wp) wp[1] = patch.y;
    if (patch.sprite != null) v.sprite = patch.sprite;
    if (patch.dir != null) v.dir = patch.dir;
    if ('t' in patch) v.t = patch.t ?? null;
    this.queueTrafficSave();
    this.refreshPanel();
  }

  /** Lowest unused textId across vehicles (kept clear of ROM config ids). */
  private mintVehicleTextId(): number {
    let max = 899999;
    for (const x of this.vehicles) if (x.t != null && x.t > max) max = x.t;
    return max + 1;
  }

  /** Author the selected car's dialogue — mint a textId if needed, persist, then
   *  open the Dialogue Editor (same handoff as the NPC path). */
  private async authorVehicleDialogue(v: Vehicle): Promise<void> {
    if (v.t == null) {
      v.t = this.mintVehicleTextId();
      this.refreshPanel();
    }
    try {
      await this.saveTraffic();
    } catch (e) {
      this.shell?.toast(String(e), true);
      return;
    }
    dialogueTool.requestEntry(String(v.t));
    this.shell?.openTool('dialogue');
  }

  private addNpc(p: WorldPoint, kind: 'person' | 'prop'): void {
    const e: NpcEntry = {
      k: `+${this.nextAddId++}`,
      added: true,
      deleted: false,
      x: this.snapV(p.x),
      y: this.snapV(p.y),
      sprite: this.placingSprite ?? 1,
      dir: Direction.S,
      kind,
      t: null,
      props: {},
    };
    this.shell!.run({
      label: `add ${kind}`,
      do: () => {
        this.npcs.push(e);
        this.selNpc = e;
        this.shell!.markDirty('npcs');
        this.refreshPanel();
      },
      undo: () => {
        this.npcs = this.npcs.filter((x) => x !== e);
        if (this.selNpc === e) this.selNpc = null;
        this.shell!.markDirty('npcs');
        this.refreshPanel();
      },
    });
  }

  // --- Spawn mode ----------------------------------------------------------------

  private spawnMouseDown(p: WorldPoint): boolean {
    // Remember the pre-click position so the whole gesture is one undo step.
    this.dragStart = { x: this.spawn.x, y: this.spawn.y };
    const onMarker =
      Math.abs(p.x - this.spawn.x) <= 10 && p.y <= this.spawn.y + 4 && p.y >= this.spawn.y - 28;
    // Clicking the marker just grabs it; clicking anywhere else moves the spawn
    // to that tile immediately. Either way we keep dragging so it can be nudged,
    // and onMouseUp commits the move (dragStart..current) as a single undo.
    if (!onMarker) {
      this.spawn.x = this.snapV(p.x);
      this.spawn.y = this.snapV(p.y);
      this.refreshFields();
    }
    this.draggingSpawn = true;
    return true;
  }

  private spawnWarnings(): string[] {
    const warnings: string[] = [];
    if (checkCollision(this.spawn.x - FOOT_W / 2, this.spawn.y - FOOT_H, FOOT_W, FOOT_H)) {
      warnings.push('⚠ spawn foot box overlaps SOLID collision');
    }
    // A wandering person can drift LEASH(32)px from home — spawning inside
    // that reach can trap the player against a moving body.
    for (const e of this.npcs) {
      if (e.deleted || e.kind !== 'person') continue;
      if (
        Math.abs(e.x - this.spawn.x) <= 32 + FOOT_W &&
        Math.abs(e.y - this.spawn.y) <= 32 + FOOT_H
      ) {
        warnings.push(`⚠ inside person ${e.k}'s wander leash`);
        break;
      }
    }
    return warnings;
  }

  // --- Door mode -------------------------------------------------------------------

  private doorMouseDown(p: WorldPoint): boolean {
    if (this.placingDoor) {
      this.addDoor(p);
      this.placingDoor = false;
      return true;
    }
    // Dest handle of the selected door has priority (it can sit under other triggers).
    if (
      this.selDoor &&
      Math.abs(p.x - this.selDoor.destX) <= 6 &&
      Math.abs(p.y - this.selDoor.destY) <= 6
    ) {
      this.doorDragPart = 'dest';
      this.dragStart = { destX: this.selDoor.destX, destY: this.selDoor.destY };
      return true;
    }
    const hit = this.doors.find(
      (d) => Math.abs(p.x - d.worldX) <= 8 && Math.abs(p.y - d.worldY) <= 8
    );
    if (!hit) {
      this.selDoor = null;
      this.refreshPanel();
      return false;
    }
    this.selDoor = hit;
    this.doorDragPart = 'trigger';
    this.dragStart = { worldX: hit.worldX, worldY: hit.worldY };
    this.grabOffset = { x: hit.worldX - p.x, y: hit.worldY - p.y };
    this.refreshPanel();
    return true;
  }

  private addDoor(p: WorldPoint): void {
    const e: DoorEntry = {
      key: `+${this.nextDoorAddId++}`,
      added: true,
      deleted: false,
      zone: false,
      worldX: this.snapV(p.x),
      worldY: this.snapV(p.y),
      destX: this.snapV(p.x),
      destY: this.snapV(p.y) + 32,
      destDir: 0,
      style: 1,
      sfx: DEFAULT_DOOR_SFX,
    };
    this.shell!.run({
      label: 'add door',
      do: () => {
        this.doors.push(e);
        this.selDoor = e;
        this.shell!.markDirty('doors');
        this.refreshPanel();
      },
      undo: () => {
        this.doors = this.doors.filter((x) => x !== e);
        if (this.selDoor === e) this.selDoor = null;
        this.shell!.markDirty('doors');
        this.refreshPanel();
      },
    });
  }

  // --- overlay ------------------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    // Drawn inside the shell's zoom transform; cull to the zoomed view.
    if (this.mode === 'npcs') this.drawNpcs(ctx, camX, camY, camera.viewW, camera.viewH);
    else if (this.mode === 'spawn') this.drawSpawn(ctx, camX, camY);
    else this.drawDoors(ctx, camX, camY, camera.viewW, camera.viewH);
  }

  private drawNpcs(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    vw: number,
    vh: number
  ): void {
    for (const e of this.npcs) {
      const sx = e.x - camX;
      const sy = e.y - camY;
      if (sx < -VIEW_MARGIN || sx > vw + VIEW_MARGIN) continue;
      if (sy < -VIEW_MARGIN || sy > vh + VIEW_MARGIN) continue;

      if (e.deleted) continue; // deleted placements are gone, not marked
      if (!this.requestedSheets.has(e.sprite)) {
        this.requestedSheets.add(e.sprite);
        loadSpriteGroup(e.sprite).catch(() => {});
      }
      ctx.globalAlpha = 0.55;
      drawSprite(ctx, e.sprite, e.dir as Direction, 0, sx, sy);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = e.added
        ? 'rgba(120,255,120,0.9)'
        : e.kind === 'person'
          ? 'rgba(80,200,255,0.8)'
          : 'rgba(232,163,61,0.8)';
      ctx.strokeRect(sx - FOOT_W / 2 + 0.5, sy - FOOT_H + 0.5, FOOT_W, FOOT_H);
      if (e === this.selNpc) {
        const meta = getSpriteGroupMeta(e.sprite);
        const w = meta?.width ?? 16;
        const h = meta?.height ?? 24;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(sx - w / 2 - 1.5, sy - h - 1.5, w + 3, h + 3);
      }
    }
    if (this.selNpc) this.drawLiveLink(ctx, this.selNpc, camX, camY);
    this.drawVehicles(ctx, camX, camY, vw, vh);
    if (this.placingKind || this.placingVehicle) this.drawPlaceCursor(ctx, camX, camY);
  }

  /**
   * When the selected placement's live in-game instance has wandered off its
   * spawn ghost, mark the live body and dash a link to the ghost — so it's clear
   * the two are one NPC, and that clicking either selects it.
   */
  private drawLiveLink(
    ctx: CanvasRenderingContext2D,
    e: NpcEntry,
    camX: number,
    camY: number
  ): void {
    const live = liveNpcForKey(e.k);
    if (!live || live.dead || (live.x === e.x && live.y === e.y)) return;
    const gx = e.x - camX;
    const gy = e.y - camY;
    const lx = live.x - camX;
    const ly = live.y - camY;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    // Box the live body (white, like the ghost selection box).
    const meta = getSpriteGroupMeta(e.sprite);
    const w = meta?.width ?? 16;
    const h = meta?.height ?? 24;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(lx - w / 2 - 1.5, ly - h - 1.5, w + 3, h + 3);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('live', lx, ly - h - 4);
    ctx.textAlign = 'left';
  }

  /** Traffic vehicles as read-only markers (green) at their first waypoint. */
  private drawVehicles(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    vw: number,
    vh: number
  ): void {
    for (const v of this.vehicles) {
      const wp = v.waypoints[0];
      if (!wp) continue;
      const sx = wp[0] - camX;
      const sy = wp[1] - camY;
      if (sx < -VIEW_MARGIN || sx > vw + VIEW_MARGIN) continue;
      if (sy < -VIEW_MARGIN || sy > vh + VIEW_MARGIN) continue;

      if (!this.requestedSheets.has(v.sprite)) {
        this.requestedSheets.add(v.sprite);
        loadSpriteGroup(v.sprite).catch(() => {});
      }
      const face = v.waypoints[1]
        ? dir8(v.waypoints[1][0] - wp[0], v.waypoints[1][1] - wp[1])
        : ((v.dir ?? Direction.S) as Direction);
      ctx.globalAlpha = 0.55;
      drawSprite(ctx, v.sprite, face, 0, sx, sy);
      ctx.globalAlpha = 1;

      const meta = getSpriteGroupMeta(v.sprite);
      const w = meta?.width ?? v.w ?? 40;
      const h = meta?.height ?? v.h ?? 28;
      const sel = v === this.selVehicle;
      ctx.strokeStyle = sel
        ? '#fff'
        : v.enabled === false
          ? 'rgba(150,150,150,0.7)'
          : 'rgba(106,208,138,0.9)';
      ctx.strokeRect(sx - w / 2 + 0.5, sy - h + 0.5, w, h);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`🚗 ${v.name}`, sx, sy - h - 3);
      ctx.textAlign = 'left';
    }
  }

  private drawSpawn(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    const sx = this.spawn.x - camX;
    const sy = this.spawn.y - camY;
    const ARROWS: Record<number, [number, number]> = {
      0: [0, 1],
      1: [0, -1],
      2: [-1, 0],
      3: [1, 0],
      4: [-0.7, -0.7],
      5: [-0.7, 0.7],
      6: [0.7, 0.7],
      7: [0.7, -0.7],
    };
    const [ax, ay] = ARROWS[this.spawn.dir] ?? [0, 1];
    // Gentle pulse so the marker breathes against a busy/animated world.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 320);
    const GREEN = '#5dff9b';
    const bodyX = sx - 8.5;
    const bodyY = sy - 24.5;

    ctx.save();
    ctx.lineJoin = 'round';

    // 1) Dark backing pass: a fat near-black stroke under everything so the bright
    //    green never washes out over light tiles. Drawn first, widest.
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 3.5;
    ctx.strokeRect(bodyX, bodyY, 17, 25);
    ctx.beginPath();
    ctx.moveTo(sx, sy - 12);
    ctx.lineTo(sx + ax * 13, sy - 12 + ay * 13);
    ctx.stroke();

    // 2) Translucent body fill so the silhouette reads as a solid claim on the tile.
    ctx.fillStyle = 'rgba(93,255,155,0.18)';
    ctx.fillRect(bodyX, bodyY, 17, 25);

    // 3) Bright green outline on top, with a pulsing glow halo.
    ctx.shadowColor = GREEN;
    ctx.shadowBlur = 4 + pulse * 7;
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bodyX, bodyY, 17, 25);
    ctx.strokeRect(sx - FOOT_W / 2 + 0.5, sy - FOOT_H + 0.5, FOOT_W, FOOT_H);
    // Facing arrow.
    ctx.beginPath();
    ctx.moveTo(sx, sy - 12);
    ctx.lineTo(sx + ax * 13, sy - 12 + ay * 13);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 4) Exact spawn point: a crosshair diamond at the foot anchor (sx, sy).
    ctx.beginPath();
    ctx.moveTo(sx, sy - 3.5);
    ctx.lineTo(sx + 3.5, sy);
    ctx.lineTo(sx, sy + 3.5);
    ctx.lineTo(sx - 3.5, sy);
    ctx.closePath();
    ctx.fillStyle = GREEN;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // 5) Label on a dark plate so it's legible over any background.
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = 'SPAWN';
    const tw = ctx.measureText(label).width;
    const ly = sy - 33;
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(sx - tw / 2 - 3, ly - 6, tw + 6, 11);
    ctx.fillStyle = GREEN;
    ctx.fillText(label, sx, ly);

    ctx.restore();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  private drawDoors(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    vw: number,
    vh: number
  ): void {
    for (const d of this.doors) {
      // Deleted doors are GONE — not drawn at all. The entry is kept (so Save
      // writes the deletion and Ctrl+Z can restore it), but invisible.
      if (d.deleted) continue;
      const sx = d.worldX - camX;
      const sy = d.worldY - camY;
      const onScreen =
        sx >= -VIEW_MARGIN &&
        sx <= vw + VIEW_MARGIN &&
        sy >= -VIEW_MARGIN &&
        sy <= vh + VIEW_MARGIN;
      if (onScreen) {
        if (d.zone && !this.isDoorAuthored(d)) {
          ctx.strokeStyle = 'rgba(140,140,140,0.5)'; // inactive zone door
        } else if (d.added) {
          ctx.strokeStyle = 'rgba(120,255,120,0.9)';
        } else {
          ctx.strokeStyle = 'rgba(232,163,61,0.85)';
        }
        ctx.strokeRect(sx - 8.5, sy - 8.5, 17, 17);
      }
      if (d === this.selDoor) {
        const dx = d.destX - camX;
        const dy = d.destY - camY;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(sx - 9.5, sy - 9.5, 19, 19);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(127,224,127,0.9)';
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(dx, dy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeRect(dx - 6.5, dy - 6.5, 13, 13);
        ctx.beginPath();
        ctx.moveTo(dx - 4, dy);
        ctx.lineTo(dx + 4, dy);
        ctx.moveTo(dx, dy - 4);
        ctx.lineTo(dx, dy + 4);
        ctx.stroke();
      }
    }
    if (this.placingDoor) this.drawPlaceCursor(ctx, camX, camY);
  }

  private drawPlaceCursor(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    const sx = this.snapV(this.hover.x) - camX;
    const sy = this.snapV(this.hover.y) - camY;
    ctx.strokeStyle = 'rgba(120,255,120,0.9)';
    ctx.strokeRect(sx - 8.5, sy - 8.5, 17, 17);
  }

  private isDoorAuthored(d: DoorEntry): boolean {
    const b = this.doorBase.get(d.key);
    if (!b) return true;
    return (
      d.worldX !== b.worldX ||
      d.worldY !== b.worldY ||
      d.destX !== b.destX ||
      d.destY !== b.destY ||
      d.destDir !== b.destDir ||
      d.style !== b.style ||
      d.sfx !== b.sfx
    );
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #e8a33d;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px;';
    for (const m of ['npcs', 'spawn', 'doors'] as Mode[]) {
      const b = document.createElement('button');
      b.textContent = m.toUpperCase();
      b.dataset.tab = m;
      b.style.cssText =
        'flex:1;font:11px monospace;padding:3px 0;cursor:pointer;border-radius:3px;' +
        'background:#1d2530;color:#cde;border:1px solid #3a4a5a;';
      b.onclick = () => {
        this.mode = m;
        this.placingKind = null;
        this.placingVehicle = false;
        this.placingDoor = false;
        this.rebuildForm();
      };
      tabs.appendChild(b);
    }
    this.panel.appendChild(tabs);

    this.infoEl = document.createElement('div');
    this.infoEl.style.cssText = 'color:#9fb8cc;font-size:11px;min-height:24px;';
    this.panel.appendChild(this.infoEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.panel.appendChild(this.formEl);

    this.shell!.panelHost.appendChild(this.panel);
    this.rebuildForm();
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
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    if (tip) b.title = tip;
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

  private mkSelect(
    parent: HTMLElement,
    name: string,
    label: string,
    options: [string, string][],
    onChange: (v: string) => void,
    tip?: string
  ): HTMLSelectElement {
    const r = this.mkRow(parent, label, tip);
    const s = document.createElement('select');
    s.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;';
    if (tip) s.title = tip;
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      s.appendChild(o);
    }
    s.onchange = () => onChange(s.value);
    r.appendChild(s);
    this.fields.set(name, s);
    return s;
  }

  private rebuildForm(): void {
    if (!this.formEl || !this.panel) return;
    this.formEl.innerHTML = '';
    this.fields.clear();
    this.thumb = null;
    this.spritePicker = null;
    this.propsForm = null;
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      const on = b.dataset.tab === this.mode;
      b.style.color = on ? '#e8a33d' : '#cde';
      b.style.borderColor = on ? '#e8a33d' : '#3a4a5a';
    }
    if (this.mode === 'npcs') {
      this.buildNpcForm(); // also handles a selected vehicle (car NPC)
    } else if (this.mode === 'spawn') this.buildSpawnForm();
    else this.buildDoorForm();
    this.refreshPanel();
  }

  private buildNpcForm(): void {
    const form = this.formEl!;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    form.appendChild(btns);
    this.mkBtn(
      '+ person',
      () => {
        this.placingKind = 'person';
        this.shell?.toast('Click the map to place a person');
      },
      btns,
      false,
      'Place a townsperson (walks/talks, can be made to fight). Click here, then click the map.'
    );
    this.mkBtn(
      '+ prop',
      () => {
        this.placingKind = 'prop';
        this.shell?.toast('Click the map to place a prop');
      },
      btns,
      false,
      'Place a static prop/object (no AI). Click here, then click the map.'
    );
    this.mkBtn(
      '+ vehicle',
      () => {
        this.placingKind = null;
        this.placingVehicle = true;
        this.shell?.toast('Click to drop a parked car — route it later in the Traffic Editor');
      },
      btns,
      false,
      'Drop a parked car into the traffic system. Give it a driving route later in the Traffic Editor.'
    );
    this.mkBtn(
      'snap (G)',
      () => this.onKey('g'),
      btns,
      false,
      'Cycle placement snapping: free → 8px → 32px grid. Shortcut: G.'
    );

    const sel = (fn: (e: NpcEntry) => void) => () => {
      if (this.selNpc) fn(this.selNpc);
    };
    const num = (v: string) => parseInt(v, 10);
    // Unified field setter: routes a patch to the selected NPC (undoable, saved to
    // npcs.json) OR the selected car (saved to car_traffic.json — x/y move its
    // first waypoint). Lets one form drive both, so a car edits like any NPC.
    const apply = (
      label: string,
      patch: { x?: number; y?: number; sprite?: number; dir?: number; t?: number | null }
    ) => {
      if (this.selVehicle) this.setVehicleField(this.selVehicle, patch);
      else if (this.selNpc) this.mutate(label, this.selNpc, patch as Partial<NpcEntry>, 'npcs');
    };
    const selSprite = () => this.selVehicle?.sprite ?? this.selNpc?.sprite;

    const keyRow = this.mkRow(
      form,
      'key',
      'Internal placement id (ROM key, or +N for an added placement). Read-only — identifies this entry in the overrides file.'
    );
    const keySpan = document.createElement('span');
    keySpan.dataset.role = 'key';
    keySpan.style.cssText = 'color:#778;font-size:10px;';
    keyRow.appendChild(keySpan);

    this.mkInput(
      form,
      'x',
      'x',
      (v) => {
        if (!Number.isNaN(num(v))) apply('x', { x: num(v) });
      },
      64,
      'World X (pixels) of this placement. Tip: drag the marker on the map instead.'
    );
    this.mkInput(
      form,
      'y',
      'y',
      (v) => {
        if (!Number.isNaN(num(v))) apply('y', { y: num(v) });
      },
      64,
      'World Y (pixels) of this placement. Tip: drag the marker on the map instead.'
    );

    // Sprite picker — the shared dropdown with a pixel preview per row + a
    // quick-search box (same component as the Cast / Entity / Spawner tools).
    const spriteRow = this.mkRow(
      form,
      'sprite',
      'The sprite group this NPC/prop uses. Search by id or name; each row previews the real sprite.'
    );
    spriteRow.style.alignItems = 'stretch';
    this.spritePicker = createSpritePicker({
      // ROM sprite groups + standalone custom entities (Source Assets imports).
      sections: [{ values: [...listSpriteGroupIds(), ...customSpriteGroupIds()].map(String) }],
      initial: String(selSprite() ?? 1),
      labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? ''}`.trim(),
      drawThumb: drawSpriteGroupThumb,
      onSelect: (v) => apply('sprite', { sprite: Math.max(0, num(v)) }),
    });
    this.spritePicker.el.style.flex = '1';
    spriteRow.appendChild(this.spritePicker.el);

    this.thumb = document.createElement('canvas');
    this.thumb.width = 48;
    this.thumb.height = 56;
    this.thumb.style.cssText =
      'image-rendering:pixelated;background:#0c1014;border:1px solid #243;align-self:center;';
    form.appendChild(this.thumb);

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;';
    const nameEl = document.createElement('div');
    nameEl.dataset.role = 'sprite-name';
    nameEl.style.cssText = 'text-align:center;color:#7fd0ff;font-size:11px;min-height:13px;';
    nameRow.appendChild(nameEl);
    this.mkBtn(
      '✎',
      () => {
        const sp = selSprite();
        if (sp == null) return;
        const current = getSpriteName(sp) ?? '';
        const name = window.prompt(
          `Rename sprite group #${sp} (renames every NPC using this sprite)`,
          current
        );
        if (name === null) return;
        setSpriteNameOverride(sp, name.trim() || null);
        this.shell?.markDirty('names');
        this.spritePicker?.refresh(); // relabel the dropdown rows with the new name
        this.refreshPanel();
        this.shell?.toast(
          `Renamed to "${name.trim() || '(default)'}" — Save-all writes names.json`
        );
      },
      nameRow,
      false,
      'Rename this sprite group (affects every NPC using it). Saved to names.json.'
    );
    form.appendChild(nameRow);

    this.mkSelect(
      form,
      'dir',
      'facing',
      DIR_NAMES.map(([d, n]) => [String(d), n] as [string, string]),
      (v) => apply('facing', { dir: num(v) }),
      'Direction this NPC faces when it spawns (8-way).'
    );
    // 'kind' applies only to real NPC placements — a car is always kind 'car'.
    if (!this.selVehicle) {
      this.mkSelect(
        form,
        'kind',
        'kind',
        [
          ['person', 'person'],
          ['prop', 'prop'],
          ['enemy', 'enemy'],
          ['gift', 'gift'],
        ],
        (v) => {
          const kind: NPCKind =
            v === 'person' ? 'person' : v === 'enemy' ? 'enemy' : v === 'gift' ? 'gift' : 'prop';
          sel((e) => this.mutate('kind', e, { kind }, 'npcs'))();
        },
        'What this placement IS: person (townsfolk AI), prop (static object), enemy (hostile, combat stats), or gift (item-container).'
      );
      // Per-instance combat personality override. '' = inherit (the entity-level
      // default, else npcSim's seeded-by-id random pick). Only meaningful for
      // townsfolk, so the row is shown for `person` only (toggled in refresh).
      this.mkSelect(
        form,
        'combat',
        'combat',
        COMBAT_PERSONALITY_OPTIONS.map((o) => [o.value, o.label] as [string, string]),
        (v) => this.setCombat((v || '') as CombatPersonality | ''),
        'How this townsperson reacts to a fight (flee / defend / pursue…). Blank = inherit the entity default (else a seeded random pick).'
      );
    }
    this.mkInput(
      form,
      't',
      'text id',
      (v) => {
        const t = v.trim() === '' ? null : num(v);
        if (t === null || !Number.isNaN(t)) apply('text id', { t });
      },
      64,
      'Dialogue/text pointer id shown on talk (Q). Blank = no dialogue. Use the Dialogue ✎ button to author it.'
    );

    // Per-instance property override (blank = inherited from the sprite-group /
    // kind defaults). Only for real NPCs — a car's stats live in car_traffic.json.
    this.propsForm = new EntityPropsForm({ onChange: (key, value) => this.setProp(key, value) });
    form.appendChild(this.propsForm.el);

    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;flex-wrap:wrap;';
    form.appendChild(actions);
    this.mkBtn(
      'Dialogue ✎',
      () => {
        if (this.selVehicle) void this.authorVehicleDialogue(this.selVehicle);
        else if (this.selNpc) void this.authorDialogue(this.selNpc);
      },
      actions,
      false,
      'Author this NPC’s dialogue — mints a text id if needed and opens the Dialogue Editor.'
    );
    // Cross-tool handoff to the Entity Manager (same as the Enemy Spawner's
    // "Edit entity →") — tune this enemy's combat stats by sprite group. Only
    // meaningful for enemies, so refreshPanel hides it for people/props/cars.
    const editEntityBtn = this.mkBtn(
      'Edit entity →',
      () => {
        const e = this.selNpc;
        if (!e) return;
        entityManagerTool.requestEntity(e.sprite);
        this.shell?.openTool('entity-manager');
      },
      actions,
      true,
      'Open the Entity Manager to tune this enemy’s combat stats for its whole sprite group.'
    );
    editEntityBtn.dataset.role = 'edit-entity';
    // A car carries the SAME form as any NPC, plus this one extra: jump to the
    // Traffic Editor to draw/edit its waypoint route. Hidden for non-vehicles.
    const editRouteBtn = this.mkBtn(
      '🚗 Edit route in Traffic →',
      () => {
        if (this.selVehicle) {
          trafficEditorTool.requestVehicle(this.selVehicle.id);
          this.shell?.openTool('traffic');
        }
      },
      actions,
      true,
      'Open the Traffic Editor to draw/edit this car’s waypoint driving route.'
    );
    editRouteBtn.dataset.role = 'edit-route';
    this.mkBtn(
      'Delete (Del)',
      () => this.deleteSelected(),
      actions,
      false,
      'Remove the selected placement. Undoable (Ctrl+Z); the removal saves to the overrides layer.'
    );
    // No Save button — NPC edits auto-save via the shell (registered 'npcs'
    // handler); applied live, persons start moving in ~2s.
  }

  /** Lowest unused textId in the authored range (kept clear of ROM config ids). */
  private mintTextId(): number {
    let max = 899999;
    for (const n of this.npcs) if (n.t != null && n.t > max) max = n.t;
    return max + 1;
  }

  /**
   * "Author dialogue" for the selected NPC: assign a fresh textId if it has
   * none, persist the NPC + link now (so the new line isn't orphaned), then
   * open the Dialogue Editor focused on that textId.
   */
  private async authorDialogue(e: NpcEntry): Promise<void> {
    let id = e.t;
    if (id == null) {
      id = this.mintTextId();
      this.mutate('text id', e, { t: id }, 'npcs');
    }
    try {
      await this.saveNpcs();
      this.shell?.clearDirty('npcs');
    } catch (err) {
      this.shell?.toast(String(err), true);
      return;
    }
    dialogueTool.requestEntry(String(id));
    this.shell?.openTool('dialogue');
  }

  private buildSpawnForm(): void {
    const form = this.formEl!;
    const note = document.createElement('div');
    note.style.cssText = 'color:#9fb8cc;font-size:11px;';
    note.textContent =
      'Drag the green marker, or edit below. Saved spawn applies to new sessions (client + server join).';
    form.appendChild(note);

    const num = (v: string) => parseInt(v, 10);
    this.mkInput(
      form,
      'sx',
      'x',
      (v) => {
        if (!Number.isNaN(num(v))) this.mutate('spawn x', this.spawn, { x: num(v) }, 'spawn');
      },
      64,
      'World X (pixels) where new players appear. Tip: drag the green marker instead.'
    );
    this.mkInput(
      form,
      'sy',
      'y',
      (v) => {
        if (!Number.isNaN(num(v))) this.mutate('spawn y', this.spawn, { y: num(v) }, 'spawn');
      },
      64,
      'World Y (pixels) where new players appear. Tip: drag the green marker instead.'
    );
    this.mkSelect(
      form,
      'sdir',
      'facing',
      DIR_NAMES.map(([d, n]) => [String(d), n] as [string, string]),
      (v) => this.mutate('spawn facing', this.spawn, { dir: num(v) }, 'spawn'),
      'Direction the player faces on spawn (8-way).'
    );

    const warn = document.createElement('div');
    warn.dataset.role = 'spawn-warn';
    warn.style.cssText = 'color:#ff9a8a;font-size:11px;min-height:14px;';
    form.appendChild(warn);

    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;flex-wrap:wrap;';
    form.appendChild(actions);
    this.mkBtn(
      'Center view',
      () => {
        const cam = this.shell!.context.camera;
        cam.x = this.spawn.x - cam.viewW / 2;
        cam.y = this.spawn.y - cam.viewH / 2;
      },
      actions,
      false,
      'Pan the editor camera to center on the spawn marker.'
    );
    this.mkBtn(
      'Test spawn',
      () => {
        this.shell!.context.teleport(this.spawn.x, this.spawn.y);
        this.shell?.toast('Teleported to spawn');
      },
      actions,
      false,
      'Teleport your character to the spawn point to check it in-game.'
    );
    // No Save button — spawn point auto-saves via the shell (registered 'spawn' handler).
  }

  private buildDoorForm(): void {
    const form = this.formEl!;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    form.appendChild(btns);
    this.mkBtn(
      '+ door',
      () => {
        this.placingDoor = true;
        this.shell?.toast('Click the map to place a door trigger');
      },
      btns,
      false,
      'Place a new door trigger. Click here, then click the map; set its destination below.'
    );
    this.mkBtn(
      'snap (G)',
      () => this.onKey('g'),
      btns,
      false,
      'Cycle placement snapping: free → 8px → 32px grid. Shortcut: G.'
    );

    const sel = (fn: (e: DoorEntry) => void) => () => {
      if (this.selDoor) fn(this.selDoor);
    };
    const num = (v: string) => parseInt(v, 10);

    const keyRow = this.mkRow(
      form,
      'key',
      'Internal door id (ROM anchor, or +N for an added door). Read-only — identifies this door in the overrides file.'
    );
    const keySpan = document.createElement('span');
    keySpan.dataset.role = 'key';
    keySpan.style.cssText = 'color:#778;font-size:10px;';
    keyRow.appendChild(keySpan);

    this.mkInput(
      form,
      'dwx',
      'trig x',
      (v) =>
        sel(
          (e) => !Number.isNaN(num(v)) && this.mutate('trigger x', e, { worldX: num(v) }, 'doors')
        )(),
      64,
      'Trigger X (pixels) — where the player steps to use the door. Tip: drag the orange box.'
    );
    this.mkInput(
      form,
      'dwy',
      'trig y',
      (v) =>
        sel(
          (e) => !Number.isNaN(num(v)) && this.mutate('trigger y', e, { worldY: num(v) }, 'doors')
        )(),
      64,
      'Trigger Y (pixels) — where the player steps to use the door. Tip: drag the orange box.'
    );
    this.mkInput(
      form,
      'ddx',
      'dest x',
      (v) =>
        sel((e) => !Number.isNaN(num(v)) && this.mutate('dest x', e, { destX: num(v) }, 'doors'))(),
      64,
      'Destination X (pixels) — where the player lands after using the door. Tip: drag the green crosshair.'
    );
    this.mkInput(
      form,
      'ddy',
      'dest y',
      (v) =>
        sel((e) => !Number.isNaN(num(v)) && this.mutate('dest y', e, { destY: num(v) }, 'doors'))(),
      64,
      'Destination Y (pixels) — where the player lands after using the door. Tip: drag the green crosshair.'
    );
    this.mkSelect(
      form,
      'ddir',
      'arrive',
      DIR_NAMES.map(([d, n]) => [String(d), n] as [string, string]),
      (v) => sel((e) => this.mutate('arrive dir', e, { destDir: num(v) }, 'doors'))(),
      'Direction the player faces after arriving through this door (8-way).'
    );
    this.mkInput(
      form,
      'dstyle',
      'style',
      (v) =>
        sel((e) => !Number.isNaN(num(v)) && this.mutate('style', e, { style: num(v) }, 'doors'))(),
      64,
      'Door style id (ROM door type / transition look). 0 = a zone door (needs an authored link to be active).'
    );

    // Sound effect played when the player uses this door — prepopulated picker.
    this.mkSelect(
      form,
      'dsfx',
      'sfx',
      DOOR_SFX.map((s) => [s.id, s.label] as [string, string]),
      (v) =>
        sel((e) => {
          this.mutate('door sfx', e, { sfx: normalizeDoorSfx(v) }, 'doors');
          playSfx(v); // audition the pick (silent until /assets/sfx/ is populated)
        })(),
      'Sound effect played when the player uses this door. Picking one auditions it.'
    );

    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;flex-wrap:wrap;';
    form.appendChild(actions);
    this.mkBtn(
      'Go to dest',
      sel((e) => {
        const cam = this.shell!.context.camera;
        cam.x = e.destX - cam.viewW / 2;
        cam.y = e.destY - cam.viewH / 2;
      }),
      actions,
      false,
      'Pan the editor camera to this door’s destination.'
    );
    this.mkBtn(
      'Walk-test',
      sel((e) => {
        this.shell!.context.teleport(e.destX, e.destY);
        this.shell?.toast(`Teleported through ${e.key}`);
      }),
      actions,
      false,
      'Teleport your character to this door’s destination to check the landing spot in-game.'
    );
    this.mkBtn(
      'Delete (Del)',
      () => this.deleteSelected(),
      actions,
      false,
      'Remove the selected door. Undoable (Ctrl+Z); for a zone door this just drops its authored link.'
    );
    // No Save button — door edits auto-save via the shell (registered 'doors'
    // handler); applied live.
  }

  /** Light refresh: only positional fields (used during drags). */
  private refreshFields(): void {
    const setVal = (name: string, v: string) => {
      const el = this.fields.get(name);
      if (el && document.activeElement !== el) el.value = v;
    };
    if (this.mode === 'npcs' && this.selVehicle) {
      const wp = this.selVehicle.waypoints[0];
      if (wp) {
        setVal('x', String(wp[0]));
        setVal('y', String(wp[1]));
      }
    } else if (this.mode === 'npcs' && this.selNpc) {
      setVal('x', String(this.selNpc.x));
      setVal('y', String(this.selNpc.y));
    } else if (this.mode === 'spawn') {
      setVal('sx', String(this.spawn.x));
      setVal('sy', String(this.spawn.y));
    } else if (this.mode === 'doors' && this.selDoor) {
      setVal('dwx', String(this.selDoor.worldX));
      setVal('dwy', String(this.selDoor.worldY));
      setVal('ddx', String(this.selDoor.destX));
      setVal('ddy', String(this.selDoor.destY));
    }
  }

  private refreshPanel(): void {
    if (!this.panel || !this.infoEl) return;
    this.refreshFields();
    const setVal = (name: string, v: string) => {
      const el = this.fields.get(name);
      if (el && document.activeElement !== el) el.value = v;
    };
    const keySpan = this.panel.querySelector<HTMLSpanElement>('[data-role=key]');
    const snapLabel = this.snap === 1 ? 'free' : `${this.snap}px`;

    if (this.mode === 'npcs') {
      // A car (selVehicle) drives the SAME form as an NPC (selNpc); read fields
      // from whichever is selected.
      const veh = this.selVehicle;
      const e = this.selNpc;
      const sprite = veh ? veh.sprite : e?.sprite;
      const dir = veh ? (veh.dir ?? Direction.S) : e?.dir;
      const t = veh ? (veh.t ?? null) : (e?.t ?? null);
      if (sprite != null) this.spritePicker?.setValue(String(sprite));
      if (dir != null) setVal('dir', String(dir));
      if (e) setVal('kind', e.kind); // the kind field only exists for NPCs
      if (e) setVal('combat', e.props.combat ?? ''); // '' = inherit/seeded
      // Combat personality only affects townsfolk — hide the row otherwise.
      const combatRow = this.fields.get('combat')?.parentElement;
      if (combatRow) combatRow.style.display = !veh && e?.kind === 'person' ? '' : 'none';
      if (veh || e) setVal('t', t === null ? '' : String(t));

      if (veh) {
        const drives = veh.waypoints.length >= 2;
        this.infoEl.textContent =
          `🚗 ${veh.name} · ${getSpriteName(veh.sprite) ?? `sprite ${veh.sprite}`} · ` +
          `${drives ? `${veh.waypoints.length}wp` : 'parked'} · ` +
          `${veh.enabled === false ? 'disabled' : drives ? 'driving' : 'stationary'} (traffic)`;
        if (keySpan) keySpan.textContent = veh.id;
      } else {
        const edited = this.npcs.filter((x) => x.deleted || x.added || this.isNpcEdited(x)).length;
        this.infoEl.textContent = e
          ? `${getSpriteName(e.sprite) ?? `sprite ${e.sprite}`} (${e.kind}) · snap ${snapLabel}`
          : `${this.npcs.length} placements · ${edited} authored · snap ${snapLabel} — click a sprite to select`;
        if (keySpan) keySpan.textContent = e ? `${e.k}${e.deleted ? ' (deleted)' : ''}` : '—';
      }

      const nameEl = this.panel.querySelector<HTMLDivElement>('[data-role=sprite-name]');
      if (nameEl) {
        nameEl.textContent = sprite != null ? (getSpriteName(sprite) ?? '(unnamed sprite)') : '';
      }
      // Per-instance properties: only for a selected NPC (not a car — its stats
      // are authored in the Traffic Editor). Hidden for nothing-selected too.
      this.propsForm?.update(
        !veh && e
          ? { kind: e.kind, baseline: entityBaseline(e.kind, e.sprite), override: e.props }
          : null
      );

      // "Edit entity →" only for enemy NPCs; "Edit route in Traffic →" only for cars.
      const editBtn = this.panel.querySelector<HTMLButtonElement>('[data-role=edit-entity]');
      if (editBtn) editBtn.style.display = !veh && e?.kind === 'enemy' ? '' : 'none';
      const routeBtn = this.panel.querySelector<HTMLButtonElement>('[data-role=edit-route]');
      if (routeBtn) routeBtn.style.display = veh ? '' : 'none';

      if (sprite != null && this.thumb) {
        const tctx = this.thumb.getContext('2d')!;
        tctx.imageSmoothingEnabled = false;
        tctx.clearRect(0, 0, 48, 56);
        const dr = (dir ?? Direction.S) as Direction;
        void loadSpriteGroup(sprite)
          .then(() => {
            tctx.save();
            tctx.scale(2, 2);
            drawSprite(tctx, sprite, dr, 0, 12, 27);
            tctx.restore();
          })
          .catch(() => {});
      }
    } else if (this.mode === 'spawn') {
      setVal('sdir', String(this.spawn.dir));
      this.infoEl.textContent = `spawn (${this.spawn.x},${this.spawn.y}) · snap ${snapLabel}`;
      const warn = this.panel.querySelector<HTMLDivElement>('[data-role=spawn-warn]');
      if (warn) warn.textContent = this.spawnWarnings().join('  ');
    } else {
      const e = this.selDoor;
      if (e) {
        setVal('ddir', String(e.destDir));
        setVal('dstyle', String(e.style));
        setVal('dsfx', e.sfx);
      }
      const authored = this.doors.filter(
        (d) => d.deleted || d.added || this.isDoorAuthored(d)
      ).length;
      const zones = this.doors.filter((d) => d.zone).length;
      this.infoEl.textContent =
        `${this.doors.length} doors (${zones} zone) · ${authored} authored · snap ${snapLabel}` +
        (e ? '' : ' — click a trigger to select');
      if (keySpan) {
        keySpan.textContent = e
          ? `${e.key}${e.deleted ? ' (deleted)' : ''}${e.zone ? ' (zone)' : ''}`
          : '—';
      }
    }
  }

  private isNpcEdited(e: NpcEntry): boolean {
    const b = this.npcBase.get(e.k);
    if (!b) return false;
    return (
      e.x !== b.x ||
      e.y !== b.y ||
      e.sprite !== b.sprite ||
      e.dir !== b.dir ||
      e.kind !== b.kind ||
      e.t !== (b.t ?? null) ||
      !propsEqual(e.props, b.props ?? {})
    );
  }
}

export const placementTool = new PlacementTool();
registerSaveHandler('npcs', () => placementTool.saveNpcs());
registerSaveHandler('spawn', () => placementTool.saveSpawn());
registerSaveHandler('doors', () => placementTool.saveDoors());
