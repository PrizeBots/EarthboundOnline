import { RoomDef, roomsByTownAndType, roomAt, SECTOR_W_PX, SECTOR_H_PX } from '../engine/Rooms';
import { REGION_ORDER as TOWN_ORDER, REGION_LABEL as TOWN_LABEL } from '../engine/Regions';

// Places navigator — a flat OUTLINE of every room/shard in the registry.
//
// This used to derive a town→building→room tree from the door graph (with
// thumbnails + an editable overrides layer). That machinery is gone: rooms are now
// a first-class, sector-authored partition (see Rooms.ts + the Room Manager), so
// the navigator is simply that registry, grouped town → type. Each row jumps to the
// room. Authoring lives in the Room Manager; this is read-only navigation.

/** A draggable on-map quick-link anchor. Kept for EditorShell's anchor overlay
 *  (the flat outline never creates one, so it stays inert — type-compat only). */
export interface PlaceAnchor {
  x: number;
  y: number;
  label: string;
  onMove: (x: number, y: number) => void;
  onCommit: () => void;
}

/** EditorShell wiring. Only `goTo` is used by the flat outline; the rest are
 *  accepted for call-site compatibility with the old anchor/marquee navigator. */
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
    title.title = 'Every room / shard, grouped by town → type. Click a row to jump there.';
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

    this.render();
  }

  destroy(): void {
    this.panel?.remove();
    this.panel = null;
    this.body = null;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.panel) this.panel.style.display = this.visible ? 'block' : 'none';
  }

  /** Re-read the registry and rebuild the outline (call after Room Manager edits). */
  refresh(): void {
    if (this.body) this.render();
  }

  // --- rendering -------------------------------------------------------------

  private render(): void {
    if (!this.body) return;
    this.body.innerHTML = '';

    const byTown = roomsByTownAndType();
    if (byTown.size === 0) {
      const e = document.createElement('div');
      e.textContent = 'No rooms yet — author them in the Room Manager.';
      e.style.cssText = 'color:#667;padding:6px;';
      this.body.appendChild(e);
      return;
    }

    const hereId = this.currentRoomId();
    const towns = this.orderedTowns([...byTown.keys()]);
    let totalShown = 0;

    for (const town of towns) {
      const types = byTown.get(town)!;
      // Flatten + filter this town's rooms so empty groups don't render a header.
      const groups: { type: string; rooms: RoomDef[] }[] = [];
      for (const [type, rooms] of types) {
        const matched = rooms.filter((r) => this.matches(r, town, type));
        if (matched.length) groups.push({ type, rooms: matched });
      }
      if (!groups.length) continue;
      totalShown += groups.reduce((n, g) => n + g.rooms.length, 0);

      const townKey = 'town:' + town;
      const open = !this.collapsed.has(townKey) || this.filter !== '';
      const townLabel = (TOWN_LABEL as Record<string, string>)[town] ?? town;
      const count = groups.reduce((n, g) => n + g.rooms.length, 0);
      this.body.appendChild(
        this.headerRow(`${open ? '▾' : '▸'} ${townLabel}`, `${count}`, '#e8a33d', () => {
          if (open) this.collapsed.add(townKey);
          else this.collapsed.delete(townKey);
          this.render();
        })
      );
      if (!open) continue;

      for (const { type, rooms } of groups) {
        this.body.appendChild(this.headerRow(`  ${type}`, `${rooms.length}`, '#7fa8c0'));
        for (const room of rooms.sort((a, b) => (a.label || '').localeCompare(b.label || ''))) {
          this.body.appendChild(this.roomRow(room, room.id === hereId));
        }
      }
    }

    if (totalShown === 0) {
      const e = document.createElement('div');
      e.textContent = 'No rooms match.';
      e.style.cssText = 'color:#667;padding:6px;';
      this.body.appendChild(e);
    }
  }

  private matches(r: RoomDef, town: string, type: string): boolean {
    if (!this.filter) return true;
    const hay = `${r.label} ${r.id} ${town} ${type}`.toLowerCase();
    return hay.includes(this.filter);
  }

  /** Known towns in display order, then any extras (alpha), '(unsorted)' last. */
  private orderedTowns(keys: string[]): string[] {
    const set = new Set(keys);
    const out: string[] = [];
    for (const t of TOWN_ORDER as string[])
      if (set.has(t)) {
        out.push(t);
        set.delete(t);
      }
    const rest = [...set].filter((t) => t !== '(unsorted)').sort();
    out.push(...rest);
    if (set.has('(unsorted)')) out.push('(unsorted)');
    return out;
  }

  private headerRow(
    text: string,
    badge: string,
    color: string,
    onClick?: () => void
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:2px 6px;white-space:pre;' +
      `color:${color};font-weight:bold;` +
      (onClick ? 'cursor:pointer;' : '');
    const label = document.createElement('span');
    label.textContent = text;
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
    row.appendChild(label);
    const b = document.createElement('span');
    b.textContent = badge;
    b.style.cssText = 'color:#5a6b7a;font-weight:normal;';
    row.appendChild(b);
    if (onClick) row.onclick = onClick;
    return row;
  }

  private roomRow(room: RoomDef, here: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:2px 6px 2px 18px;cursor:pointer;border-radius:3px;' +
      (here ? 'background:#15282c;' : '');
    row.title = `${room.id} · ${room.sectors?.length ?? 0} sector(s)`;
    const dot = document.createElement('span');
    dot.textContent = here ? '◉' : '•';
    dot.style.cssText = `color:${here ? '#5ad06a' : '#456'};flex:none;`;
    row.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = room.label || room.id;
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    row.appendChild(label);
    row.onclick = () => {
      const c = this.roomCenter(room);
      if (c) this.goTo(c.x, c.y);
      else this.opts.toast?.('Room has no sectors yet', true);
    };
    return row;
  }

  /** Center of a room's first sector (fallback: its first rect / nowhere). */
  private roomCenter(room: RoomDef): { x: number; y: number } | null {
    const s = room.sectors?.[0];
    if (s) return { x: (s[0] + 0.5) * SECTOR_W_PX, y: (s[1] + 0.5) * SECTOR_H_PX };
    const rc = room.regions?.[0] ?? room.rect;
    if (rc) return { x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 };
    return null;
  }

  /** The room the (frozen) editor player is standing in, for the "here" dot. */
  private currentRoomId(): string | null {
    const p = this.opts.currentPos?.();
    if (!p) return null;
    return roomAt(p.x, p.y)?.id ?? null;
  }
}
