import { loadJSON } from '../../engine/AssetLoader';
import { drawSprite, loadSpriteGroup, getSpriteGroupMeta } from '../../engine/SpriteManager';
import { getSpriteName, setSpriteNameOverride } from '../../engine/SpriteNames';
import { spriteAnimatorTool } from './SpriteAnimatorTool';
import { RawNPC, NpcOverrides } from '../../engine/NPCManager';
import { DoorOverrides, EditorDoor, getEditorDoorBase, loadDoors } from '../../engine/DoorManager';
import { checkCollision } from '../../engine/Collision';
import { Camera } from '../../engine/Camera';
import { Direction } from '../../types';
import { saveOverride } from '../saveOverride';
import { registerSaveHandler } from '../EditorHub';
import { EditorShellApi, EditorTool, WorldPoint } from '../types';
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
  [Direction.S, 'S'], [Direction.N, 'N'], [Direction.W, 'W'], [Direction.E, 'E'],
  [Direction.NW, 'NW'], [Direction.SW, 'SW'], [Direction.SE, 'SE'], [Direction.NE, 'NE'],
];

interface NpcEntry {
  k: string;
  added: boolean;
  deleted: boolean;
  x: number;
  y: number;
  sprite: number;
  dir: number;
  kind: 'person' | 'prop';
  t: number | null;
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
}

type Mode = 'npcs' | 'spawn' | 'doors';
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
  private nextAddId = 0;

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
  private requestedSheets = new Set<number>();

  // --- lifecycle -----------------------------------------------------------

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadAll();
    this.buildPanel();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.formEl = null;
    this.infoEl = null;
    this.fields.clear();
    this.selNpc = null;
    this.selDoor = null;
    this.placingKind = null;
    this.placingDoor = false;
    this.dragNpc = null;
    this.doorDragPart = null;
  }

  private async loadAll(): Promise<void> {
    const [rawNpcs, npcOv, doorOv, spawnOv] = await Promise.all([
      loadJSON<RawNPC[]>('/assets/map/npcs.json'),
      loadJSON<NpcOverrides>('/overrides/npcs.json').catch(() => null),
      loadJSON<DoorOverrides>('/overrides/doors.json').catch(() => null),
      loadJSON<{ x: number; y: number; dir: number }>('/overrides/spawn.json').catch(() => null),
    ]);

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
        kind: v.kind === 'person' ? 'person' : 'prop',
        t: v.t ?? null,
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
        kind: a.kind === 'person' ? 'person' : 'prop',
        t: a.t ?? null,
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
      });
    }
    for (const a of doorOv?.additions ?? []) {
      this.doors.push({
        key: `+${this.nextDoorAddId++}`,
        added: true,
        deleted: false,
        zone: false,
        ...a,
      });
    }

    this.shell?.toast(
      `Placement: ${this.npcs.length} NPCs, ${this.doors.length} doors loaded`
    );
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
      const b = this.npcBase.get(e.k)!;
      if (e.deleted) edits![e.k] = null;
      else if (
        e.x !== b.x || e.y !== b.y || e.sprite !== b.sprite ||
        e.dir !== b.dir || e.kind !== b.kind || e.t !== (b.t ?? null)
      ) {
        edits![e.k] = this.npcToRaw(e);
      }
    }
    return { version: 1, edits, additions };
  }

  private npcToRaw(e: NpcEntry): Omit<RawNPC, 'k'> {
    const r: Omit<RawNPC, 'k'> = { x: e.x, y: e.y, sprite: e.sprite, dir: e.dir, kind: e.kind };
    if (e.t !== null) r.t = e.t;
    return r;
  }

  private buildDoorOverrides(): DoorOverrides {
    const edits: DoorOverrides['edits'] = {};
    const additions: DoorOverrides['additions'] = [];
    for (const e of this.doors) {
      if (e.added) {
        if (!e.deleted) {
          additions!.push({
            worldX: e.worldX, worldY: e.worldY,
            destX: e.destX, destY: e.destY, destDir: e.destDir, style: e.style,
          });
        }
        continue;
      }
      const b = this.doorBase.get(e.key)!;
      const changed =
        e.worldX !== b.worldX || e.worldY !== b.worldY || e.destX !== b.destX ||
        e.destY !== b.destY || e.destDir !== b.destDir || e.style !== b.style;
      if (e.deleted) {
        // Disabling a zone door = just don't author a link for it.
        if (!e.zone) edits![e.key] = null;
      } else if (changed) {
        const o: NonNullable<DoorOverrides['edits']>[string] = {
          destX: e.destX, destY: e.destY, destDir: e.destDir, style: e.style,
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
  }

  async saveSpawn(): Promise<void> {
    await saveOverride('spawn.json', this.spawn);
  }

  async saveDoors(): Promise<void> {
    await saveOverride('doors.json', this.buildDoorOverrides());
    await loadDoors(); // re-apply live in this client
  }

  // --- generic undoable mutation -------------------------------------------------

  private mutate<T extends object>(label: string, target: T, change: Partial<T>, domain: string): void {
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
  private commitDrag<T extends object>(label: string, target: T, applied: Partial<T>, domain: string): void {
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
        this.mutate(this.selNpc.deleted ? 'restore' : 'delete placement', this.selNpc,
          { deleted: !this.selNpc.deleted }, 'npcs');
        return true;
      }
      if (this.mode === 'doors' && this.selDoor) {
        this.mutate(this.selDoor.deleted ? 'restore door' : 'delete door', this.selDoor,
          { deleted: !this.selDoor.deleted }, 'doors');
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

  private snapV(v: number): number {
    return Math.round(v / this.snap) * this.snap;
  }

  // --- NPC mode -----------------------------------------------------------------

  private npcMouseDown(p: WorldPoint): boolean {
    if (this.placingKind) {
      this.addNpc(p, this.placingKind);
      this.placingKind = null;
      return true;
    }
    const hit = this.npcHitTest(p);
    if (!hit) {
      this.selNpc = null;
      this.refreshPanel();
      return false;
    }
    this.selNpc = hit;
    this.dragNpc = hit;
    this.dragStart = { x: hit.x, y: hit.y };
    this.grabOffset = { x: hit.x - p.x, y: hit.y - p.y };
    this.refreshPanel();
    return true;
  }

  private npcHitTest(p: WorldPoint): NpcEntry | null {
    let best: NpcEntry | null = null;
    for (const e of this.npcs) {
      const meta = getSpriteGroupMeta(e.sprite);
      const w = meta?.width ?? 16;
      const h = meta?.height ?? 24;
      if (p.x < e.x - w / 2 || p.x > e.x + w / 2 || p.y < e.y - h || p.y > e.y) continue;
      if (!best || e.y > best.y) best = e;
    }
    return best;
  }

  private addNpc(p: WorldPoint, kind: 'person' | 'prop'): void {
    const e: NpcEntry = {
      k: `+${this.nextAddId++}`,
      added: true,
      deleted: false,
      x: this.snapV(p.x),
      y: this.snapV(p.y),
      sprite: 1,
      dir: Direction.S,
      kind,
      t: null,
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
      if (Math.abs(e.x - this.spawn.x) <= 32 + FOOT_W && Math.abs(e.y - this.spawn.y) <= 32 + FOOT_H) {
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
    if (this.selDoor && Math.abs(p.x - this.selDoor.destX) <= 6 && Math.abs(p.y - this.selDoor.destY) <= 6) {
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

  private drawNpcs(ctx: CanvasRenderingContext2D, camX: number, camY: number, vw: number, vh: number): void {
    for (const e of this.npcs) {
      const sx = e.x - camX;
      const sy = e.y - camY;
      if (sx < -VIEW_MARGIN || sx > vw + VIEW_MARGIN) continue;
      if (sy < -VIEW_MARGIN || sy > vh + VIEW_MARGIN) continue;

      if (e.deleted) {
        ctx.strokeStyle = 'rgba(255,80,80,0.9)';
        ctx.beginPath();
        ctx.moveTo(sx - 4, sy - 4);
        ctx.lineTo(sx + 4, sy + 4);
        ctx.moveTo(sx + 4, sy - 4);
        ctx.lineTo(sx - 4, sy + 4);
        ctx.stroke();
        continue;
      }
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
    if (this.placingKind) this.drawPlaceCursor(ctx, camX, camY);
  }

  private drawSpawn(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    const sx = this.spawn.x - camX;
    const sy = this.spawn.y - camY;
    // Marker: player-sized outline + facing arrow + label.
    ctx.strokeStyle = '#7fe07f';
    ctx.strokeRect(sx - 8.5, sy - 24.5, 17, 25);
    ctx.strokeRect(sx - FOOT_W / 2 + 0.5, sy - FOOT_H + 0.5, FOOT_W, FOOT_H);
    const ARROWS: Record<number, [number, number]> = {
      0: [0, 1], 1: [0, -1], 2: [-1, 0], 3: [1, 0],
      4: [-0.7, -0.7], 5: [-0.7, 0.7], 6: [0.7, 0.7], 7: [0.7, -0.7],
    };
    const [ax, ay] = ARROWS[this.spawn.dir] ?? [0, 1];
    ctx.beginPath();
    ctx.moveTo(sx, sy - 12);
    ctx.lineTo(sx + ax * 12, sy - 12 + ay * 12);
    ctx.stroke();
    ctx.fillStyle = '#7fe07f';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SPAWN', sx, sy - 28);
    ctx.textAlign = 'left';
  }

  private drawDoors(ctx: CanvasRenderingContext2D, camX: number, camY: number, vw: number, vh: number): void {
    for (const d of this.doors) {
      const sx = d.worldX - camX;
      const sy = d.worldY - camY;
      const onScreen =
        sx >= -VIEW_MARGIN && sx <= vw + VIEW_MARGIN &&
        sy >= -VIEW_MARGIN && sy <= vh + VIEW_MARGIN;
      if (onScreen) {
        if (d.deleted) {
          ctx.strokeStyle = 'rgba(255,80,80,0.8)';
        } else if (d.zone && !this.isDoorAuthored(d)) {
          ctx.strokeStyle = 'rgba(140,140,140,0.5)'; // inactive zone door
        } else if (d.added) {
          ctx.strokeStyle = 'rgba(120,255,120,0.9)';
        } else {
          ctx.strokeStyle = 'rgba(232,163,61,0.85)';
        }
        ctx.strokeRect(sx - 8.5, sy - 8.5, 17, 17);
        if (d.deleted) {
          ctx.beginPath();
          ctx.moveTo(sx - 8, sy - 8);
          ctx.lineTo(sx + 8, sy + 8);
          ctx.stroke();
        }
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
      d.worldX !== b.worldX || d.worldY !== b.worldY || d.destX !== b.destX ||
      d.destY !== b.destY || d.destDir !== b.destDir || d.style !== b.style
    );
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;top:36px;right:8px;z-index:91;width:236px;background:#101418f2;' +
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

    document.body.appendChild(this.panel);
    this.rebuildForm();
  }

  private mkBtn(label: string, fn: () => void, parent: HTMLElement, accent = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 7px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  private mkRow(parent: HTMLElement, label: string): HTMLDivElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'width:46px;color:#9fb8cc;';
    r.appendChild(l);
    parent.appendChild(r);
    return r;
  }

  private mkInput(parent: HTMLElement, name: string, label: string, onChange: (v: string) => void, width = 64): HTMLInputElement {
    const r = this.mkRow(parent, label);
    const i = document.createElement('input');
    i.style.cssText =
      `width:${width}px;font:11px monospace;background:#0c1014;color:#cde;` +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    i.onchange = () => onChange(i.value);
    r.appendChild(i);
    this.fields.set(name, i);
    return i;
  }

  private mkSelect(parent: HTMLElement, name: string, label: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
    const r = this.mkRow(parent, label);
    const s = document.createElement('select');
    s.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;';
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
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      const on = b.dataset.tab === this.mode;
      b.style.color = on ? '#e8a33d' : '#cde';
      b.style.borderColor = on ? '#e8a33d' : '#3a4a5a';
    }
    if (this.mode === 'npcs') this.buildNpcForm();
    else if (this.mode === 'spawn') this.buildSpawnForm();
    else this.buildDoorForm();
    this.refreshPanel();
  }

  private buildNpcForm(): void {
    const form = this.formEl!;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    form.appendChild(btns);
    this.mkBtn('+ person', () => {
      this.placingKind = 'person';
      this.shell?.toast('Click the map to place a person');
    }, btns);
    this.mkBtn('+ prop', () => {
      this.placingKind = 'prop';
      this.shell?.toast('Click the map to place a prop');
    }, btns);
    this.mkBtn('snap (G)', () => this.onKey('g'), btns);

    const sel = (fn: (e: NpcEntry) => void) => () => {
      if (this.selNpc) fn(this.selNpc);
    };
    const num = (v: string) => parseInt(v, 10);

    const keyRow = this.mkRow(form, 'key');
    const keySpan = document.createElement('span');
    keySpan.dataset.role = 'key';
    keySpan.style.cssText = 'color:#778;font-size:10px;';
    keyRow.appendChild(keySpan);

    this.mkInput(form, 'x', 'x', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('x', e, { x: num(v) }, 'npcs'))());
    this.mkInput(form, 'y', 'y', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('y', e, { y: num(v) }, 'npcs'))());

    const spriteRow = this.mkRow(form, 'sprite');
    const spriteIn = document.createElement('input');
    spriteIn.style.cssText =
      'width:44px;font:11px monospace;background:#0c1014;color:#cde;' +
      'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    spriteIn.onchange = () =>
      sel((e) => !Number.isNaN(num(spriteIn.value)) && this.mutate('sprite', e, { sprite: Math.max(0, num(spriteIn.value)) }, 'npcs'))();
    spriteRow.appendChild(spriteIn);
    this.fields.set('sprite', spriteIn);
    this.mkBtn('◀', sel((e) => this.mutate('sprite', e, { sprite: Math.max(0, e.sprite - 1) }, 'npcs')), spriteRow);
    this.mkBtn('▶', sel((e) => this.mutate('sprite', e, { sprite: e.sprite + 1 }, 'npcs')), spriteRow);

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
    this.mkBtn('✎', () => {
      const e = this.selNpc;
      if (!e) return;
      const current = getSpriteName(e.sprite) ?? '';
      const name = window.prompt(
        `Rename sprite group #${e.sprite} (renames every NPC using this sprite)`,
        current
      );
      if (name === null) return;
      setSpriteNameOverride(e.sprite, name.trim() || null);
      this.shell?.markDirty('names');
      this.refreshPanel();
      this.shell?.toast(`Renamed to "${name.trim() || '(default)'}" — Save-all writes names.json`);
    }, nameRow);
    this.mkBtn('Edit sprite', () => {
      const e = this.selNpc;
      if (!e) return;
      const sprite = e.sprite;
      this.shell?.openTool('sprite-animator');
      void spriteAnimatorTool.openGroup(sprite);
    }, nameRow);
    form.appendChild(nameRow);

    this.mkSelect(form, 'dir', 'facing', DIR_NAMES.map(([d, n]) => [String(d), n] as [string, string]),
      (v) => sel((e) => this.mutate('facing', e, { dir: num(v) }, 'npcs'))());
    this.mkSelect(form, 'kind', 'kind', [['person', 'person'], ['prop', 'prop']],
      (v) => sel((e) => this.mutate('kind', e, { kind: v === 'person' ? 'person' : 'prop' }, 'npcs'))());
    this.mkInput(form, 't', 'text id', (v) =>
      sel((e) => {
        const t = v.trim() === '' ? null : num(v);
        if (t === null || !Number.isNaN(t)) this.mutate('text id', e, { t }, 'npcs');
      })());

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;';
    form.appendChild(actions);
    this.mkBtn('Delete (Del)', sel((e) => this.mutate(e.deleted ? 'restore' : 'delete placement', e, { deleted: !e.deleted }, 'npcs')), actions);
    this.mkBtn('Save', () => {
      void this.saveNpcs()
        .then(() => {
          this.shell?.clearDirty('npcs');
          this.shell?.toast('Saved npcs — persons go live in ~2s; refresh for props');
        })
        .catch((err) => this.shell?.toast(String(err), true));
    }, actions, true);
  }

  private buildSpawnForm(): void {
    const form = this.formEl!;
    const note = document.createElement('div');
    note.style.cssText = 'color:#9fb8cc;font-size:11px;';
    note.textContent = 'Drag the green marker, or edit below. Saved spawn applies to new sessions (client + server join).';
    form.appendChild(note);

    const num = (v: string) => parseInt(v, 10);
    this.mkInput(form, 'sx', 'x', (v) => {
      if (!Number.isNaN(num(v))) this.mutate('spawn x', this.spawn, { x: num(v) }, 'spawn');
    });
    this.mkInput(form, 'sy', 'y', (v) => {
      if (!Number.isNaN(num(v))) this.mutate('spawn y', this.spawn, { y: num(v) }, 'spawn');
    });
    this.mkSelect(form, 'sdir', 'facing', DIR_NAMES.map(([d, n]) => [String(d), n] as [string, string]),
      (v) => this.mutate('spawn facing', this.spawn, { dir: num(v) }, 'spawn'));

    const warn = document.createElement('div');
    warn.dataset.role = 'spawn-warn';
    warn.style.cssText = 'color:#ff9a8a;font-size:11px;min-height:14px;';
    form.appendChild(warn);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;flex-wrap:wrap;';
    form.appendChild(actions);
    this.mkBtn('Center view', () => {
      const cam = this.shell!.context.camera;
      cam.x = this.spawn.x - cam.viewW / 2;
      cam.y = this.spawn.y - cam.viewH / 2;
    }, actions);
    this.mkBtn('Test spawn', () => {
      this.shell!.context.teleport(this.spawn.x, this.spawn.y);
      this.shell?.toast('Teleported to spawn');
    }, actions);
    this.mkBtn('Save', () => {
      void this.saveSpawn()
        .then(() => {
          this.shell?.clearDirty('spawn');
          this.shell?.toast('Saved overrides/spawn.json');
        })
        .catch((err) => this.shell?.toast(String(err), true));
    }, actions, true);
  }

  private buildDoorForm(): void {
    const form = this.formEl!;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    form.appendChild(btns);
    this.mkBtn('+ door', () => {
      this.placingDoor = true;
      this.shell?.toast('Click the map to place a door trigger');
    }, btns);
    this.mkBtn('snap (G)', () => this.onKey('g'), btns);

    const sel = (fn: (e: DoorEntry) => void) => () => {
      if (this.selDoor) fn(this.selDoor);
    };
    const num = (v: string) => parseInt(v, 10);

    const keyRow = this.mkRow(form, 'key');
    const keySpan = document.createElement('span');
    keySpan.dataset.role = 'key';
    keySpan.style.cssText = 'color:#778;font-size:10px;';
    keyRow.appendChild(keySpan);

    this.mkInput(form, 'dwx', 'trig x', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('trigger x', e, { worldX: num(v) }, 'doors'))());
    this.mkInput(form, 'dwy', 'trig y', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('trigger y', e, { worldY: num(v) }, 'doors'))());
    this.mkInput(form, 'ddx', 'dest x', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('dest x', e, { destX: num(v) }, 'doors'))());
    this.mkInput(form, 'ddy', 'dest y', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('dest y', e, { destY: num(v) }, 'doors'))());
    this.mkSelect(form, 'ddir', 'arrive', DIR_NAMES.map(([d, n]) => [String(d), n] as [string, string]),
      (v) => sel((e) => this.mutate('arrive dir', e, { destDir: num(v) }, 'doors'))());
    this.mkInput(form, 'dstyle', 'style', (v) => sel((e) => !Number.isNaN(num(v)) && this.mutate('style', e, { style: num(v) }, 'doors'))());

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;flex-wrap:wrap;';
    form.appendChild(actions);
    this.mkBtn('Go to dest', sel((e) => {
      const cam = this.shell!.context.camera;
      cam.x = e.destX - cam.viewW / 2;
      cam.y = e.destY - cam.viewH / 2;
    }), actions);
    this.mkBtn('Walk-test', sel((e) => {
      this.shell!.context.teleport(e.destX, e.destY);
      this.shell?.toast(`Teleported through ${e.key}`);
    }), actions);
    this.mkBtn('Delete (Del)', sel((e) => this.mutate(e.deleted ? 'restore door' : 'delete door', e, { deleted: !e.deleted }, 'doors')), actions);
    this.mkBtn('Save', () => {
      void this.saveDoors()
        .then(() => {
          this.shell?.clearDirty('doors');
          this.shell?.toast('Saved overrides/doors.json — applied live');
        })
        .catch((err) => this.shell?.toast(String(err), true));
    }, actions, true);
  }

  /** Light refresh: only positional fields (used during drags). */
  private refreshFields(): void {
    const setVal = (name: string, v: string) => {
      const el = this.fields.get(name);
      if (el && document.activeElement !== el) el.value = v;
    };
    if (this.mode === 'npcs' && this.selNpc) {
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
      const e = this.selNpc;
      if (e) {
        setVal('sprite', String(e.sprite));
        setVal('dir', String(e.dir));
        setVal('kind', e.kind);
        setVal('t', e.t === null ? '' : String(e.t));
      }
      const edited = this.npcs.filter((x) => x.deleted || x.added || this.isNpcEdited(x)).length;
      this.infoEl.textContent = e
        ? `${getSpriteName(e.sprite) ?? `sprite ${e.sprite}`} (${e.kind}) · snap ${snapLabel}`
        : `${this.npcs.length} placements · ${edited} authored · snap ${snapLabel} — click a sprite to select`;
      if (keySpan) keySpan.textContent = e ? `${e.k}${e.deleted ? ' (deleted)' : ''}` : '—';
      const nameEl = this.panel.querySelector<HTMLDivElement>('[data-role=sprite-name]');
      if (nameEl) {
        nameEl.textContent = e ? (getSpriteName(e.sprite) ?? '(unnamed sprite)') : '';
      }
      if (e && this.thumb) {
        const tctx = this.thumb.getContext('2d')!;
        tctx.imageSmoothingEnabled = false;
        tctx.clearRect(0, 0, 48, 56);
        void loadSpriteGroup(e.sprite)
          .then(() => {
            tctx.save();
            tctx.scale(2, 2);
            drawSprite(tctx, e.sprite, e.dir as Direction, 0, 12, 27);
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
      }
      const authored = this.doors.filter((d) => d.deleted || d.added || this.isDoorAuthored(d)).length;
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
      e.x !== b.x || e.y !== b.y || e.sprite !== b.sprite ||
      e.dir !== b.dir || e.kind !== b.kind || e.t !== (b.t ?? null)
    );
  }
}

export const placementTool = new PlacementTool();
registerSaveHandler('npcs', () => placementTool.saveNpcs());
registerSaveHandler('spawn', () => placementTool.saveSpawn());
registerSaveHandler('doors', () => placementTool.saveDoors());
