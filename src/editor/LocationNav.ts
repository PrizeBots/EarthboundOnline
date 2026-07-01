import { RoomDef, RoomTreeNode, roomAt, SECTOR_W_PX, SECTOR_H_PX } from '../engine/Rooms';
import { regionLabel } from '../engine/Regions';
import { roomTreeService } from './RoomTree';

// Places navigator — the human-facing OUTLINE of every room, nested by parent.
//
// It renders the SAME shared tree the Room Builder shows (roomTreeService), so the
// two lists are always identical. Top level = "main areas" (towns); rooms nest
// under their parent, arbitrarily deep (Onett ▸ Hotel ▸ bedroom). Drag a room onto
// another to nest it; drop it on a town header to make it a top-level room of that
// area. Click any row to select it globally (every tool acts on the selection) and
// jump the editor camera there.

/** A draggable on-map quick-link anchor. Kept for EditorShell's anchor overlay
 *  (the outline never creates one, so it stays inert — type-compat only). */
export interface PlaceAnchor {
  x: number;
  y: number;
  label: string;
  onMove: (x: number, y: number) => void;
  onCommit: () => void;
}

/** EditorShell wiring. Only `goTo` is used by the outline; the rest are accepted
 *  for call-site compatibility with the old anchor/marquee navigator. */
interface NavOpts {
  viewCenter?: () => { x: number; y: number };
  select?: (a: PlaceAnchor | null) => void;
  toast?: (msg: string, isError?: boolean) => void;
  beginMarquee?: (
    cb: (rect: { x: number; y: number; w: number; h: number } | null) => void
  ) => void;
  currentPos?: () => { x: number; y: number };
}

const HEADER_H = 30; // editor top bar — the panel sits below it

export class LocationNav {
  private panel: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private filter = '';
  private collapsed = new Set<string>();
  private visible = true;
  private dragId: string | null = null; // a room being dragged
  private dragArea: string | null = null; // a town/area header being dragged
  private zonesOpen = new Set<string>(); // per-town "BGM Zones" groups the user expanded
  private unsub: (() => void) | null = null;

  constructor(
    private goTo: (x: number, y: number) => void,
    private currentTown: () => string,
    private opts: NavOpts = {}
  ) {}

  async mount(): Promise<void> {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      `position:fixed;top:${HEADER_H}px;left:0;bottom:0;width:248px;z-index:90;overflow:auto;` +
      'background:#101418f2;color:#cde;font:11px monospace;border-right:2px solid #e8a33d;' +
      'padding:6px 4px;user-select:none;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 6px 4px;';
    const title = document.createElement('span');
    title.textContent = '📍 PLACES';
    title.title =
      'Every room, nested by parent. Drag a room onto another to nest it; drop on an area to top-level it. Click to jump.';
    title.style.cssText = 'color:#e8a33d;font-weight:bold;letter-spacing:1px;flex:1;';
    head.appendChild(title);
    this.panel.appendChild(head);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'search rooms…';
    search.style.cssText =
      'width:calc(100% - 12px);margin:0 6px 6px;box-sizing:border-box;font:11px monospace;' +
      'background:#0c1016;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
    search.oninput = () => {
      this.filter = search.value.trim().toLowerCase();
      this.render();
    };
    search.onkeydown = (e) => e.stopPropagation();
    this.panel.appendChild(search);

    this.body = document.createElement('div');
    this.panel.appendChild(this.body);
    document.body.appendChild(this.panel);

    // Re-render whenever the shared tree or selection changes (drag-drop in the
    // Builder, a property edit, a new room) so Places mirrors it live.
    this.unsub = roomTreeService.subscribe(() => this.render());
    await roomTreeService.load();
    this.render();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.panel?.remove();
    this.panel = null;
    this.body = null;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.panel) this.panel.style.display = this.visible ? 'block' : 'none';
  }

  /** Re-read the registry and rebuild the outline. */
  refresh(): void {
    if (this.body) this.render();
  }

  // --- rendering -------------------------------------------------------------

  private render(): void {
    if (!this.body) return;
    this.body.innerHTML = '';

    const areas = roomTreeService.outline();
    if (areas.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No rooms yet — create them in the Room Builder.';
      e.style.cssText = 'color:#667;padding:6px;';
      this.body.appendChild(e);
      return;
    }

    const hereId = this.currentRoomId();
    const selId = roomTreeService.getSelectedId();
    let totalShown = 0;

    for (const { town, nodes } of areas) {
      // Count matches in this whole area subtree so empty areas don't render.
      const shown = nodes.reduce((n, x) => n + this.countMatches(x), 0);
      if (!shown) continue;
      totalShown += shown;

      const townKey = 'town:' + town;
      const open = !this.collapsed.has(townKey) || this.filter !== '';
      this.body.appendChild(
        this.townHeader(town, `${open ? '▾' : '▸'} ${regionLabel(town)}`, `${shown}`, open)
      );
      if (!open) continue;

      // Named places lead; the overworld BGM zones are music regions, not places,
      // so they collapse into their own group per area (their song-name label is
      // fine there — it's a property, not the room's name).
      const places = nodes.filter((n) => (n.room.type ?? '') !== 'overworld');
      const zones = nodes.filter((n) => (n.room.type ?? '') === 'overworld');
      for (const node of places) this.renderNode(node, 1, hereId, selId);
      this.renderZoneGroup(town, zones, hereId, selId);
    }

    if (totalShown === 0) {
      const e = document.createElement('div');
      e.textContent = 'No rooms match.';
      e.style.cssText = 'color:#667;padding:6px;';
      this.body.appendChild(e);
    }
  }

  /** Rooms in a subtree matching the current filter (the room or any descendant). */
  private countMatches(node: RoomTreeNode): number {
    const self = this.matches(node.room) ? 1 : 0;
    return node.children.reduce((n, c) => n + this.countMatches(c), self);
  }

  private matches(r: RoomDef): boolean {
    if (!this.filter) return true;
    return `${r.label} ${r.id} ${r.town ?? ''} ${r.type ?? ''}`.toLowerCase().includes(this.filter);
  }

  /** When filtering, only render nodes whose subtree contains a match. */
  private renderNode(
    node: RoomTreeNode,
    depth: number,
    hereId: string | null,
    selId: string | null
  ): void {
    if (this.filter && !this.countMatches(node)) return;
    const room = node.room;
    const hasKids = node.children.length > 0;
    const key = 'room:' + room.id;
    const open = !this.collapsed.has(key) || this.filter !== '';

    const row = document.createElement('div');
    const here = room.id === hereId;
    const sel = room.id === selId;
    row.style.cssText =
      `display:flex;align-items:center;gap:5px;padding:2px 6px 2px ${6 + depth * 12}px;` +
      'cursor:pointer;border-radius:3px;' +
      (sel ? 'background:#243447;' : here ? 'background:#15282c;' : '');
    row.title = `${room.id}${room.type ? ' · ' + room.type : ''}`;
    row.draggable = true;

    const caret = document.createElement('span');
    caret.textContent = hasKids ? (open ? '▾' : '▸') : '·';
    caret.style.cssText = `width:10px;flex:none;color:${hasKids ? '#e8a33d' : '#456'};`;
    if (hasKids)
      caret.onclick = (e) => {
        e.stopPropagation();
        if (open) this.collapsed.add(key);
        else this.collapsed.delete(key);
        this.render();
      };
    row.appendChild(caret);

    const dot = document.createElement('span');
    dot.textContent = here ? '◉' : '•';
    dot.style.cssText = `color:${here ? '#5ad06a' : '#456'};flex:none;`;
    row.appendChild(dot);

    const label = document.createElement('span');
    const tag =
      room.type && room.type !== 'other' && room.type !== 'overworld' ? `[${room.type}] ` : '';
    label.textContent = tag + (room.label || room.id);
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    if (sel) label.style.color = '#bfe3ff';
    row.appendChild(label);

    row.onclick = () => {
      roomTreeService.select(room.id);
      const c = this.roomCenter(room);
      if (c) this.goTo(c.x, c.y);
      this.render(); // player moved → refresh the "here" dot onto this room
    };

    // Drag-drop: nest this room under the drop target.
    row.ondragstart = (e) => {
      this.dragId = room.id;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', room.id);
    };
    row.ondragend = () => {
      this.dragId = null;
      row.style.outline = '';
    };
    row.ondragover = (e) => {
      if (!this.dragId || this.dragId === room.id) return;
      e.preventDefault();
      row.style.outline = '1px dashed #7fe07f';
    };
    row.ondragleave = () => {
      row.style.outline = '';
    };
    row.ondrop = (e) => {
      e.preventDefault();
      row.style.outline = '';
      const src = this.dragId;
      this.dragId = null;
      if (src && src !== room.id) void roomTreeService.reparent(src, room.id);
    };

    this.body!.appendChild(row);
    if (open) for (const child of node.children) this.renderNode(child, depth + 1, hereId, selId);
  }

  /** The collapsible "BGM Zones (N)" sub-group under an area (default collapsed). */
  private renderZoneGroup(
    town: string,
    zones: RoomTreeNode[],
    hereId: string | null,
    selId: string | null
  ): void {
    const shown = zones.reduce((n, x) => n + this.countMatches(x), 0);
    if (!shown) return;
    const open = this.filter !== '' || this.zonesOpen.has(town);
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:1px 6px 1px 18px;cursor:pointer;color:#6f8296;';
    const label = document.createElement('span');
    label.textContent = `${open ? '▾' : '▸'} ⌁ BGM Zones`;
    label.style.cssText = 'flex:1;';
    row.appendChild(label);
    const b = document.createElement('span');
    b.textContent = `${shown}`;
    b.style.cssText = 'color:#4a5a6a;';
    row.appendChild(b);
    row.onclick = () => {
      if (this.zonesOpen.has(town)) this.zonesOpen.delete(town);
      else this.zonesOpen.add(town);
      this.render();
    };
    this.body!.appendChild(row);
    if (open) for (const node of zones) this.renderNode(node, 2, hereId, selId);
  }

  private townHeader(town: string, text: string, badge: string, open: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:2px 6px;white-space:pre;' +
      'color:#e8a33d;font-weight:bold;cursor:grab;';
    row.draggable = true;
    row.title = 'Drag to reorder areas; drop a room here to top-level it in this area.';
    const label = document.createElement('span');
    label.textContent = text;
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
    row.appendChild(label);
    const b = document.createElement('span');
    b.textContent = badge;
    b.style.cssText = 'color:#5a6b7a;font-weight:normal;';
    row.appendChild(b);
    row.onclick = () => {
      const k = 'town:' + town;
      if (open) this.collapsed.add(k);
      else this.collapsed.delete(k);
      this.render();
    };
    // Dragging the header itself reorders areas (persisted); the row can also
    // receive a dropped room (→ top-level it in this area, pinned to the top).
    row.ondragstart = (e) => {
      this.dragArea = town;
      this.dragId = null;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', 'town:' + town);
    };
    row.ondragend = () => {
      this.dragArea = null;
      row.style.outline = '';
    };
    row.ondragover = (e) => {
      if (this.dragArea === town || (!this.dragId && !this.dragArea)) return;
      e.preventDefault();
      row.style.outline = '1px dashed #e8a33d';
    };
    row.ondragleave = () => {
      row.style.outline = '';
    };
    row.ondrop = (e) => {
      e.preventDefault();
      row.style.outline = '';
      if (this.dragArea && this.dragArea !== town) {
        void roomTreeService.moveArea(this.dragArea, town);
      } else if (this.dragId) {
        void roomTreeService.moveRoomToAreaTop(this.dragId, town);
      }
      this.dragArea = null;
      this.dragId = null;
    };
    return row;
  }

  /** Where clicking a room jumps to: its first sector center, else its rect
   *  center, else its spawn point (door-derived building rooms carry only a
   *  spawn — no geometry — so they stay inert for the running game). */
  private roomCenter(room: RoomDef): { x: number; y: number } | null {
    const s = room.sectors?.[0];
    if (s) return { x: (s[0] + 0.5) * SECTOR_W_PX, y: (s[1] + 0.5) * SECTOR_H_PX };
    const rc = room.regions?.[0] ?? room.rect;
    if (rc) return { x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 };
    if (room.spawn) return { x: room.spawn.x, y: room.spawn.y };
    return null;
  }

  /** The room the (frozen) editor player is standing in, for the "here" dot. */
  private currentRoomId(): string | null {
    const p = this.opts.currentPos?.();
    if (!p) return null;
    return roomAt(p.x, p.y)?.id ?? null;
  }
}
