// RoomTree — the single source of truth the Places column AND the Room Builder
// tree both read, so the two outlines are always identical. It merges the two
// room stores into one list, owns the globally-selected room, and routes every
// edit (reparent via drag-drop, property change) back to that room's HOME doc:
//
//   • CUSTOM rooms  → overrides/rooms.json (band geometry; RoomBuilder's domain)
//   • REGION rooms  → DB 'rooms' world doc (sector/bgm zones; seeded from music)
//
// Tools/panels subscribe() to re-render on any change. Edits live-push into the
// engine registry (setRoomList / setRegionRooms) so the running game's camera /
// music / behaviors update without a reboot. Nesting is the `parent` field on
// RoomDef; the tree shape comes from Rooms.roomTree().

import { RoomDef, RoomTreeNode, roomTree, setRoomList, setRegionRooms } from '../engine/Rooms';
import { regionAt, regionOrder } from '../engine/Regions';
import { loadWorldDoc, saveWorldDoc } from '../engine/Auth';
import { loadOverride, saveOverride } from './saveOverride';

/** Band-shaped custom room (mirror of MapManager's private CustomRoom). We only
 *  name the fields we read/edit; the rest (tiles, composites, sector) ride along
 *  untouched via the index signature so saving never drops geometry. */
interface CustomRoom {
  id: string;
  label: string;
  town?: string | null;
  parent?: string | null;
  type?: string | null;
  bgm?: number | null;
  storeId?: number;
  healCost?: number;
  cost?: number;
  wakeBgm?: number;
  bedroomWarp?: { x: number; y: number; dir: number };
  isSaveRoom?: boolean;
  bandX: number;
  bandY: number;
  w: number;
  h: number;
  spawnDX: number;
  spawnDY: number;
  spawnDir: number;
  [k: string]: unknown;
}
interface CustomRoomsDoc {
  version: number;
  rooms: CustomRoom[];
}
interface RegionRoomsDoc {
  version?: number;
  rooms?: RoomDef[];
}

/** Navigation-only UI state (NOT room data): the manual area order + per-parent
 *  child order the outline persists so a drag-to-reorder sticks. Lives in the DB
 *  'places' world doc, same as the old navigator (whose `order.__root__` we seed
 *  from so a previously-pinned "custom to the top" survives this refactor). */
interface PlacesDoc {
  version?: number;
  areaOrder?: string[]; // town keys in manual order; unlisted towns follow region order
  roomOrder?: Record<string, string[]>; // parentKey → ordered child room ids
  order?: Record<string, string[]>; // legacy navigator order (read once to seed)
  [k: string]: unknown;
}

/** An area (town) group in the outline: its ordered top-level room nodes. */
export interface OutlineArea {
  town: string;
  nodes: RoomTreeNode[];
}

/** Which store owns a room — picks the persistence + live-push path. */
export type RoomSource = 'custom' | 'region';

/** The editable property set shared by the Room Manager + Builder panels. */
export type RoomProps = Partial<
  Pick<
    RoomDef,
    | 'label'
    | 'town'
    | 'parent'
    | 'type'
    | 'bgm'
    | 'storeId'
    | 'healCost'
    | 'cost'
    | 'wakeBgm'
    | 'bedroomWarp'
    | 'isSaveRoom'
  >
>;

const SECTOR_W_PX = 256; // mirror Rooms.SECTOR_W_PX (avoid a cyclic-looking import)

class RoomTreeService {
  private customDoc: CustomRoomsDoc = { version: 1, rooms: [] };
  private regionDoc: RegionRoomsDoc = { version: 1, rooms: [] };
  private placesDoc: PlacesDoc = { version: 1 };
  private selectedId: string | null = null;
  private loaded = false;
  private subs = new Set<() => void>();
  private toast: ((msg: string, isError?: boolean) => void) | null = null;

  setToast(fn: (msg: string, isError?: boolean) => void): void {
    this.toast = fn;
  }

  // --- loading ---------------------------------------------------------------

  /** Load both stores. Cheap to call repeatedly; pass force to re-fetch. */
  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    const [cust, reg, places] = await Promise.all([
      loadOverride<CustomRoomsDoc>('rooms.json').catch(() => null),
      loadWorldDoc<RegionRoomsDoc>('rooms').catch(() => null),
      loadWorldDoc<PlacesDoc>('places').catch(() => null),
    ]);
    this.customDoc = cust && cust.rooms ? cust : { version: 1, rooms: [] };
    this.regionDoc = reg && reg.rooms ? reg : { version: 1, rooms: [] };
    this.placesDoc = places ?? { version: 1 };
    // Seed the manual area order from the OLD navigator's `order.__root__` (its
    // entries are "t:onett"-style keys) so a previously-pinned order survives.
    if (!this.placesDoc.areaOrder && Array.isArray(this.placesDoc.order?.__root__)) {
      this.placesDoc.areaOrder = this.placesDoc
        .order!.__root__.filter((k) => typeof k === 'string' && k.startsWith('t:'))
        .map((k) => k.slice(2));
    }
    this.loaded = true;
    this.notify();
  }

  // --- the merged view -------------------------------------------------------

  /** A custom band-room as a registry RoomDef (props + derived rect/spawn). */
  private customToDef(r: CustomRoom): RoomDef {
    return {
      id: r.id,
      label: r.label,
      town: r.town,
      parent: r.parent,
      type: r.type,
      bgm: r.bgm,
      storeId: r.storeId,
      healCost: r.healCost,
      cost: r.cost,
      wakeBgm: r.wakeBgm,
      bedroomWarp: r.bedroomWarp,
      isSaveRoom: r.isSaveRoom,
      rect: { x: r.bandX * 32, y: r.bandY * 32, w: r.w * 32, h: r.h * 32 },
      spawn: { x: r.bandX * 32 + r.spawnDX, y: r.bandY * 32 + r.spawnDY, dir: r.spawnDir },
    };
  }

  private customDefs(): RoomDef[] {
    return this.customDoc.rooms.map((r) => this.customToDef(r));
  }

  /** Every room (custom + region) as RoomDefs — the list the tree is built from. */
  all(): RoomDef[] {
    return [...this.customDefs(), ...(this.regionDoc.rooms ?? [])];
  }

  source(id: string): RoomSource | null {
    if (this.customDoc.rooms.some((r) => r.id === id)) return 'custom';
    if ((this.regionDoc.rooms ?? []).some((r) => r.id === id)) return 'region';
    return null;
  }

  get(id: string): RoomDef | null {
    return this.all().find((r) => r.id === id) ?? null;
  }

  /**
   * The full nested outline both the Places column and the Room Builder render:
   * areas (towns) → top-level rooms → nested children. Areas follow the manual
   * `areaOrder` first, then region story-order; within any level, a manual
   * `roomOrder` wins, then alpha by label. One shape, so the two lists match.
   */
  outline(): OutlineArea[] {
    const roots = roomTree(this.all());
    const byTown = new Map<string, RoomTreeNode[]>();
    for (const n of roots) {
      const t = this.townFor(n.room);
      const list = byTown.get(t) ?? byTown.set(t, []).get(t)!;
      list.push(n);
    }

    const areaOrder = this.placesDoc.areaOrder ?? [];
    const rankTown = (t: string): [number, number, string] => {
      const i = areaOrder.indexOf(t);
      return i !== -1 ? [0, i, t] : [1, regionOrder(t), t];
    };
    const towns = [...byTown.keys()].sort((a, b) => {
      const [ga, ia] = rankTown(a);
      const [gb, ib] = rankTown(b);
      return ga - gb || ia - ib || a.localeCompare(b);
    });

    const orderChildren = (nodes: RoomTreeNode[], parentKey: string): void => {
      const ord = this.placesDoc.roomOrder?.[parentKey] ?? [];
      nodes.sort((a, b) => {
        const ia = ord.indexOf(a.room.id);
        const ib = ord.indexOf(b.room.id);
        if (ia !== -1 || ib !== -1) return ia === -1 ? 1 : ib === -1 ? -1 : ia - ib;
        return (a.room.label || a.room.id).localeCompare(b.room.label || b.room.id);
      });
      for (const n of nodes) orderChildren(n.children, n.room.id);
    };

    return towns.map((t) => {
      const nodes = byTown.get(t)!;
      orderChildren(nodes, 'town:' + t);
      return { town: t, nodes };
    });
  }

  /** The town order as currently displayed (manual order resolved). */
  areaOrder(): string[] {
    return this.outline().map((a) => a.town);
  }

  /** Drag-reorder areas: move `dragTown` to just before `targetTown` (or to the
   *  end when target is null), and persist the full explicit order. */
  async moveArea(dragTown: string, targetTown: string | null): Promise<void> {
    if (dragTown === targetTown) return;
    const order = this.areaOrder();
    const from = order.indexOf(dragTown);
    if (from < 0) return;
    order.splice(from, 1);
    let to = targetTown ? order.indexOf(targetTown) : order.length;
    if (to < 0) to = order.length;
    order.splice(to, 0, dragTown);
    this.placesDoc.areaOrder = order;
    await this.savePlaces();
    this.notify();
  }

  /** Make `roomId` a top-level room of `town`, pinned to the TOP of that area. */
  async moveRoomToAreaTop(roomId: string, town: string): Promise<void> {
    await this.setProps(roomId, { parent: null, town });
    const key = 'town:' + town;
    const cur =
      this.outline()
        .find((a) => a.town === town)
        ?.nodes.map((n) => n.room.id) ?? [];
    (this.placesDoc.roomOrder ??= {})[key] = [roomId, ...cur.filter((id) => id !== roomId)];
    await this.savePlaces();
    this.notify();
  }

  private async savePlaces(): Promise<void> {
    try {
      await saveWorldDoc('places', this.placesDoc);
    } catch (e) {
      this.toast?.(`Save failed: ${e}`, true);
    }
  }

  // --- selection -------------------------------------------------------------

  getSelectedId(): string | null {
    return this.selectedId;
  }
  getSelected(): RoomDef | null {
    return this.selectedId ? this.get(this.selectedId) : null;
  }
  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.notify();
  }

  // --- subscriptions ---------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  private notify(): void {
    for (const fn of this.subs) fn();
  }

  // --- editing ---------------------------------------------------------------

  /** True if making `parentId` the parent of `childId` would create a cycle (the
   *  parent is the child itself or one of its descendants). */
  private wouldCycle(childId: string, parentId: string): boolean {
    if (childId === parentId) return true;
    const byId = new Map(this.all().map((r) => [r.id, r] as const));
    let cur: string | null | undefined = parentId;
    const seen = new Set<string>();
    while (cur) {
      if (cur === childId) return true;
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = byId.get(cur)?.parent ?? null;
    }
    return false;
  }

  /** Drag-drop re-home: nest `childId` under `parentId` (null = top level). */
  async reparent(childId: string, parentId: string | null): Promise<boolean> {
    if (parentId && this.wouldCycle(childId, parentId)) {
      this.toast?.('Can’t nest a room inside its own descendant', true);
      return false;
    }
    return this.setProps(childId, { parent: parentId });
  }

  /** Apply a property patch to a room and persist to its home doc + live-push. */
  async setProps(id: string, patch: RoomProps): Promise<boolean> {
    const src = this.source(id);
    if (!src) return false;
    if (src === 'custom') {
      const r = this.customDoc.rooms.find((x) => x.id === id);
      if (!r) return false;
      Object.assign(r, patch);
      await this.saveCustom();
    } else {
      const r = (this.regionDoc.rooms ?? []).find((x) => x.id === id);
      if (!r) return false;
      Object.assign(r, patch);
      await this.saveRegion();
    }
    this.notify();
    return true;
  }

  private async saveCustom(): Promise<void> {
    // Pure props/parent edits don't move tiles, so push the updated defs straight
    // into the registry (no expensive band re-stamp) and persist the doc.
    setRoomList(this.customDefs());
    try {
      await saveOverride('rooms.json', this.customDoc);
    } catch (e) {
      this.toast?.(`Save failed: ${e}`, true);
    }
  }

  private async saveRegion(): Promise<void> {
    setRegionRooms(this.regionDoc.rooms ?? []);
    try {
      await saveWorldDoc('rooms', this.regionDoc);
    } catch (e) {
      this.toast?.(`Save failed: ${e}`, true);
    }
  }

  /** Best-effort town for a room from the center of its footprint (region anchor
   *  partition). Used by seeding/grouping when a room carries no explicit town. */
  townFor(r: RoomDef): string {
    if (r.town) return r.town;
    const s = r.sectors?.[0];
    const rc = r.regions?.[0] ?? r.rect;
    const cx = s ? (s[0] + 0.5) * SECTOR_W_PX : rc ? rc.x + rc.w / 2 : 0;
    const cy = s ? (s[1] + 0.5) * 128 : rc ? rc.y + rc.h / 2 : 0;
    return regionAt(cx, cy);
  }
}

/** The singleton shared by Places, Room Builder, and Room Manager. */
export const roomTreeService = new RoomTreeService();
