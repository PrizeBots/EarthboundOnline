import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { Direction } from '../../types';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import { getNearbyNPCs } from '../../engine/NPCManager';
import { getSpriteName } from '../../engine/SpriteNames';

// Event Manager (EVENT_MANAGER.md — Phase 1: authoring + overlay viz only; the
// server-side runtime state machine + client timers come in Phase 2). Author
// "events" like the Frank battle: a trigger circle that, when players stand in
// it, counts down and warps the group to a dedicated room (door-style), runs a
// timer, and warps everyone back to a single exit on any end condition.
//
// One live instance PER EVENT DEFINITION (decided): each event guards its own
// single instance; different events can run at once. Saves the WHOLE file to
// the overrides layer (public/overrides/events.json — OUR authored content, no
// ROM base to merge), like enemy_spawns.json.

const ACCENT = '#b07cff'; // event-manager purple
const PICK_R = 14; // world-px pick radius for markers

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

// End conditions: ANY one fires the end → warp survivors to the single exit,
// despawn the boss, re-arm after cooldown. Phase 1 authors which are active;
// Phase 2's server runtime evaluates them.
type EndType = 'bossDefeated' | 'allPlayersDead' | 'timer';
const END_LABELS: [EndType, string][] = [
  ['bossDefeated', 'Boss defeated (win)'],
  ['allPlayersDead', 'All players dead (wipe)'],
  ['timer', 'Event timer expires'],
];

// How an event's countdown ARMS. Extensible on purpose — talk-to-NPC
// ('dialogue') is the first concrete source and 'proximity' (walk into the
// circle) the fallback; more start sources get added as we work through the
// game (item used, flag set, time-of-day, …). Whatever the source, the trigger
// CIRCLE still defines the party that gets warped in at zero.
type StartKind = 'proximity' | 'dialogue';
const START_LABELS: [StartKind, string][] = [
  ['dialogue', 'Talk to NPC'],
  ['proximity', 'Walk into circle'],
];

interface Warp {
  enabled: boolean; // optional — an event can omit its entrance and/or exit
  x: number;
  y: number;
  dir: number; // 8-way facing on arrival (Direction)
}

interface EventDef {
  id: string;
  name: string;
  enabled: boolean;
  // Trigger circle on the overworld.
  trigger: {
    start: StartKind; // how the countdown arms (talk-to-NPC / proximity / …)
    npcTextId: number | null; // 'dialogue' start: the NPC whose talk arms it (also anchors the circle); matches dialogue:done.npc
    npcName: string | null; // display label captured at bind time (sprite name), for the UI
    x: number;
    y: number;
    radius: number; // px — players inside at countdown-zero get warped in
    countdownMs: number; // arming countdown once ≥minPlayers stand inside
    minPlayers: number; // re-checked at zero against who's still inside
    cooldownMs: number; // lock after the event ends before re-arming
  };
  entrance: Warp; // where the group lands in the event room
  exit: Warp; // single exit — every outcome (win/wipe/timeout) warps here
  eventTimerMs: number; // the in-room event timer (drives the 'timer' end cond)
  end: EndType[]; // active end conditions (any fires)
}

interface EventsFile {
  version: number;
  events: EventDef[];
}

const FILE = 'events.json';

function blankEvent(id: string, x: number, y: number): EventDef {
  return {
    id,
    name: id,
    enabled: true,
    trigger: {
      start: 'dialogue',
      npcTextId: null,
      npcName: null,
      x,
      y,
      radius: 48,
      countdownMs: 5000,
      minPlayers: 1,
      cooldownMs: 30000,
    },
    // entrance/exit are optional — start unset (disabled) at the trigger spot
    // until the author enables + places them.
    entrance: { enabled: false, x, y, dir: Direction.S },
    exit: { enabled: false, x, y, dir: Direction.S },
    eventTimerMs: 120000,
    end: ['bossDefeated', 'allPlayersDead', 'timer'],
  };
}

// Which marker a click sets next. 'new' creates a fresh event at the click;
// 'npc' binds the dialogue-start NPC under the click.
type Placing = 'new' | 'entrance' | 'exit' | 'npc' | null;
// Which of the selected event's three points the drag is moving.
type DragTarget = 'trigger' | 'entrance' | 'exit' | null;

class EventManagerTool implements EditorTool {
  id = 'events';
  name = 'Event Manager';
  description =
    'Author events (e.g. the Frank battle): a trigger circle, the entrance/exit warps, and the end conditions.';
  status = 'ready' as const; // Phase 1 authoring works; runtime (Phase 2) flagged in-panel

  private shell: EditorShellApi | null = null;
  private events: EventDef[] = [];
  private sel: EventDef | null = null;
  private placing: Placing = null;
  private drag: DragTarget = null;
  private hover: WorldPoint = { x: 0, y: 0 };

  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('events', () => this.save());
    // Build the panel synchronously so it always appears on launch; data loads
    // after (the shell ignores activate()'s return, so an async throw here
    // would vanish and leave no panel).
    this.buildPanel();
    this.refreshList();
    this.rebuildForm();
    void this.loadAndRefresh();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.placing = null;
    this.drag = null;
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      const file = await loadOverride<EventsFile>(FILE);
      this.events = (file?.events ?? []).map((e) => ({
        ...blankEvent(e.id, e.trigger?.x ?? 0, e.trigger?.y ?? 0),
        ...e,
        trigger: {
          ...blankEvent(e.id, e.trigger?.x ?? 0, e.trigger?.y ?? 0).trigger,
          ...e.trigger,
        },
        entrance: Object.assign({ enabled: false, x: 0, y: 0, dir: Direction.S }, e.entrance),
        exit: Object.assign({ enabled: false, x: 0, y: 0, dir: Direction.S }, e.exit),
        end: [...(e.end ?? [])],
      }));
    } catch (err) {
      console.error('[EventManager] failed to load events.json', err);
      this.shell?.toast(`Couldn't load events: ${err}`, true);
      return;
    }
    if (!this.sel && this.events.length) this.sel = this.events[0];
    this.refreshList();
    this.rebuildForm();
  }

  private async save(): Promise<void> {
    const file: EventsFile = { version: 1, events: this.events };
    await saveOverride(FILE, file);
  }

  // --- input ---------------------------------------------------------------

  onMouseDown(p: WorldPoint): boolean {
    if (this.placing === 'new') {
      const ev = blankEvent(this.nextId(), Math.round(p.x), Math.round(p.y));
      this.events.push(ev);
      this.sel = ev;
      this.placing = null;
      this.shell?.markDirty('events');
      this.refreshList();
      this.rebuildForm();
      this.shell?.toast(`Placed "${ev.name}" — now set its entrance & exit`);
      return true;
    }
    if (this.placing === 'npc' && this.sel) {
      const npc = this.pickNpcAt(p);
      this.placing = null;
      if (!npc || npc.textId == null) {
        this.shell?.toast('No talkable NPC there — click one with dialogue', true);
        return true;
      }
      this.sel.trigger.npcTextId = npc.textId;
      this.sel.trigger.npcName = npc.name;
      // Anchor the circle on the NPC (runtime re-follows the live NPC each tick).
      this.sel.trigger.x = Math.round(npc.x);
      this.sel.trigger.y = Math.round(npc.y);
      this.shell?.markDirty('events');
      this.rebuildForm();
      this.shell?.toast(`Bound to ${npc.name ?? 'NPC'} (#${npc.textId})`);
      return true;
    }
    if ((this.placing === 'entrance' || this.placing === 'exit') && this.sel) {
      const w = this.sel[this.placing];
      w.x = Math.round(p.x);
      w.y = Math.round(p.y);
      w.enabled = true; // placing it implies it's set
      this.shell?.markDirty('events');
      this.placing = null;
      this.rebuildForm();
      return true;
    }

    // Otherwise: select / start dragging a marker of the nearest event.
    const hit = this.pickAt(p);
    if (hit) {
      this.sel = hit.ev;
      this.drag = hit.target;
      this.refreshList();
      this.rebuildForm();
      return true;
    }
    return false; // let the shell pan
  }

  onMouseMove(p: WorldPoint, _dragging: boolean): void {
    this.hover = p;
    if (this.drag && this.sel) {
      const pt = this.sel[this.drag];
      pt.x = Math.round(p.x);
      pt.y = Math.round(p.y);
    }
  }

  onMouseUp(): void {
    if (this.drag && this.sel) this.shell?.markDirty('events');
    this.drag = null;
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

  // Pick the closest marker (trigger / entrance / exit) across all events.
  private pickAt(p: WorldPoint): { ev: EventDef; target: DragTarget } | null {
    let best: { ev: EventDef; target: DragTarget } | null = null;
    let bestD = PICK_R;
    for (const ev of this.events) {
      for (const target of ['trigger', 'entrance', 'exit'] as const) {
        // Disabled warps aren't drawn, so they aren't draggable either.
        if ((target === 'entrance' || target === 'exit') && !ev[target].enabled) continue;
        const pt = ev[target];
        const d = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = { ev, target };
        }
      }
    }
    return best;
  }

  // Nearest live NPC to a click (for binding the dialogue-start NPC). Prefers
  // talkable ones (textId != null) so a blank prop standing nearby can't win.
  private pickNpcAt(
    p: WorldPoint
  ): { textId: number | null; name: string | null; x: number; y: number } | null {
    let best: { textId: number | null; name: string | null; x: number; y: number } | null = null;
    let bestD = 24; // world-px pick radius
    for (const npc of getNearbyNPCs(p.x, p.y)) {
      const d = Math.hypot(npc.x - p.x, npc.y - p.y);
      const talkable = npc.textId != null;
      // Talkable NPCs get a generous bonus so they beat a closer inert prop.
      const score = d - (talkable ? 16 : 0);
      if (score < bestD) {
        bestD = score;
        best = { textId: npc.textId, name: getSpriteName(npc.spriteGroupId), x: npc.x, y: npc.y };
      }
    }
    return best;
  }

  private nextId(): string {
    let n = this.events.length + 1;
    const taken = new Set(this.events.map((e) => e.id));
    while (taken.has(`event-${n}`)) n++;
    return `event-${n}`;
  }

  private startPlacing(): void {
    this.placing = 'new';
    this.shell?.toast('Click the map to place the event trigger');
  }

  private deleteSelected(): void {
    if (!this.sel) return;
    const i = this.events.indexOf(this.sel);
    if (i >= 0) this.events.splice(i, 1);
    this.sel = this.events[0] ?? null;
    this.shell?.markDirty('events');
    this.refreshList();
    this.rebuildForm();
  }

  // --- overlay -------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    for (const ev of this.events) {
      const sel = ev === this.sel;
      const color = !ev.enabled ? 'rgba(140,140,140,0.7)' : ACCENT;
      const tx = ev.trigger.x - camX;
      const ty = ev.trigger.y - camY;

      // Trigger circle (the start zone).
      ctx.strokeStyle = color;
      ctx.setLineDash(sel ? [] : [4, 4]);
      ctx.beginPath();
      ctx.arc(tx, ty, ev.trigger.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (sel && ev.enabled) {
        ctx.fillStyle = 'rgba(176,124,255,0.10)';
        ctx.fill();
      }

      // Trigger center (diamond) + name.
      this.diamond(ctx, tx, ty, 6, color);
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(ev.name, tx, ty - ev.trigger.radius - 4);
      // Start-source tag (talk vs walk-in) under the center.
      const tag =
        ev.trigger.start === 'dialogue'
          ? ev.trigger.npcTextId == null
            ? '🗨 no NPC'
            : `🗨 ${ev.trigger.npcName ?? '#' + ev.trigger.npcTextId}`
          : 'walk-in';
      ctx.fillStyle =
        ev.trigger.start === 'dialogue' && ev.trigger.npcTextId == null ? '#e66' : color;
      ctx.fillText(tag, tx, ty + 14);

      // Entrance (purple) + exit (blue) markers with facing ticks — only when set.
      if (ev.entrance.enabled) this.warpMarker(ctx, ev.entrance, camX, camY, ACCENT, 'IN', sel);
      if (ev.exit.enabled) this.warpMarker(ctx, ev.exit, camX, camY, '#5aa9ff', 'OUT', sel);
      ctx.textAlign = 'left';
    }

    // Ghost while placing the trigger of a new event.
    if (this.placing === 'new') {
      const gx = this.hover.x - camX;
      const gy = this.hover.y - camY;
      ctx.strokeStyle = 'rgba(176,124,255,0.9)';
      ctx.beginPath();
      ctx.arc(gx, gy, 48, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private diamond(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string
  ): void {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.stroke();
  }

  private warpMarker(
    ctx: CanvasRenderingContext2D,
    w: Warp,
    camX: number,
    camY: number,
    color: string,
    label: string,
    sel: boolean
  ): void {
    const x = w.x - camX;
    const y = w.y - camY;
    ctx.strokeStyle = color;
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.strokeRect(x - 5, y - 5, 10, 10);
    // Facing tick.
    const [dx, dy] = DIR_VEC[w.dir] ?? [0, 1];
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * 9, y + dy * 9);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(label, x, y - 7);
  }

  // --- panel ---------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      `color:#cde;font:12px monospace;border:1px solid ${ACCENT};border-radius:5px;` +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'EVENT MANAGER';
    title.style.cssText = `color:${ACCENT};font-weight:bold;letter-spacing:1px;`;
    this.panel.appendChild(title);

    const wip = document.createElement('div');
    wip.textContent = 'Phase 1: authoring only — runtime not wired yet';
    wip.style.cssText = 'color:#8a7ab0;font-size:10px;';
    this.panel.appendChild(wip);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;';
    this.mkBtn(
      '+ New event (N)',
      () => this.startPlacing(),
      actions,
      'Arm placement, then click the map to drop a new event trigger.'
    );
    this.panel.appendChild(actions);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:160px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.panel.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.panel.appendChild(this.formEl);

    const hint = document.createElement('div');
    hint.textContent = 'drag markers to move · Del to remove';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.panel.appendChild(hint);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (!this.events.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No events yet — press N to place one.';
      empty.style.cssText = 'color:#667;font-size:11px;padding:4px;';
      this.listEl.appendChild(empty);
      return;
    }
    for (const ev of this.events) {
      const row = document.createElement('div');
      const on = ev === this.sel;
      row.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:2px 5px;border-radius:3px;cursor:pointer;' +
        (on ? `background:${ACCENT}33;` : '') +
        (ev.enabled ? '' : 'opacity:0.5;');
      const dot = document.createElement('span');
      dot.textContent = '●';
      dot.style.color = ev.enabled ? ACCENT : '#777';
      const name = document.createElement('span');
      name.textContent = ev.name;
      name.style.flex = '1';
      row.appendChild(dot);
      row.appendChild(name);
      row.onclick = () => {
        this.sel = ev;
        this.shell?.goTo(ev.trigger.x, ev.trigger.y);
        this.refreshList();
        this.rebuildForm();
      };
      this.listEl.appendChild(row);
    }
  }

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    const ev = this.sel;
    if (!ev) return;

    this.textRow(
      'Name',
      ev.name,
      (v) => {
        ev.name = v || ev.id;
        this.shell?.markDirty('events');
        this.refreshList();
      },
      'Display name for this event (blank falls back to its id).'
    );
    this.checkRow(
      'Enabled',
      ev.enabled,
      (v) => {
        ev.enabled = v;
        this.shell?.markDirty('events');
        this.refreshList();
      },
      'Whether this event is active (disabled events are drawn greyed out).'
    );

    this.section('Start source');
    this.selectRow(
      'Starts on',
      START_LABELS.map(([v, l]) => [String(v), l]),
      ev.trigger.start,
      (v) => {
        ev.trigger.start = v as StartKind;
        this.shell?.markDirty('events');
        this.rebuildForm();
      },
      'How the countdown arms: talking to an NPC, or walking into the circle.'
    );
    if (ev.trigger.start === 'dialogue') {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';
      this.mkBtn(
        'Bind NPC',
        () => {
          this.placing = 'npc';
          this.shell?.toast('Click the NPC whose dialogue starts this event');
        },
        row,
        'Arm, then click the NPC whose dialogue arms this event (also anchors the circle).'
      );
      const tag = document.createElement('span');
      tag.textContent =
        ev.trigger.npcTextId == null
          ? 'none bound'
          : `${ev.trigger.npcName ?? 'NPC'} (#${ev.trigger.npcTextId})`;
      tag.style.cssText = `color:${ev.trigger.npcTextId == null ? '#c66' : '#7a8aa0'};font-size:10px;`;
      row.appendChild(tag);
      this.formEl!.appendChild(row);
    }

    this.section('Trigger circle');
    this.numRow(
      'Radius (px)',
      ev.trigger.radius,
      (v) => (ev.trigger.radius = v),
      'Radius of the start zone in pixels; players inside at countdown-zero get warped in.'
    );
    this.numRow(
      'Min players',
      ev.trigger.minPlayers,
      (v) => (ev.trigger.minPlayers = Math.max(1, v)),
      'How many players must stand inside before the countdown arms (min 1).'
    );
    this.numRow(
      'Countdown (s)',
      ev.trigger.countdownMs / 1000,
      (v) => (ev.trigger.countdownMs = v * 1000),
      'Seconds to count down once min players are inside before warping the group in.'
    );
    this.numRow(
      'Cooldown (s)',
      ev.trigger.cooldownMs / 1000,
      (v) => (ev.trigger.cooldownMs = v * 1000),
      'Seconds the event stays locked after it ends before it can re-arm.'
    );

    this.section('Warps');
    this.warpRow('Entrance', 'entrance');
    this.warpRow('Exit', 'exit');

    this.section('Event room');
    this.numRow(
      'Event timer (s)',
      ev.eventTimerMs / 1000,
      (v) => (ev.eventTimerMs = v * 1000),
      'In-room timer in seconds; drives the "timer expires" end condition.'
    );

    this.section('End conditions (any fires)');
    for (const [type, label] of END_LABELS) {
      this.checkRow(
        label,
        ev.end.includes(type),
        (v) => {
          ev.end = v ? [...new Set([...ev.end, type])] : ev.end.filter((t) => t !== type);
          this.shell?.markDirty('events');
        },
        'Any active end condition ends the event and warps survivors to the exit.'
      );
    }
  }

  // Row: optional toggle + "Set" + "Go to" (like doors) + facing + coords.
  private warpRow(label: string, key: 'entrance' | 'exit'): void {
    const ev = this.sel!;
    const w = ev[key];

    // Toggle row — whether this warp is set at all (either/both are optional).
    const toggle = this.labelRow(
      label,
      key === 'entrance'
        ? 'Optional warp where the group lands in the event room.'
        : 'Optional single exit every outcome (win/wipe/timeout) warps to.'
    );
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = w.enabled;
    cb.title = `Enable the ${label.toLowerCase()} warp (disabled warps aren't placed or drawn).`;
    cb.onchange = () => {
      w.enabled = cb.checked;
      this.shell?.markDirty('events');
      this.rebuildForm();
    };
    toggle.appendChild(cb);
    this.formEl!.appendChild(toggle);
    if (!w.enabled) return; // collapsed when unset

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding-left:10px;';
    this.mkBtn(
      'Set',
      () => {
        this.placing = key;
        this.shell?.toast(`Click the map to set the ${label.toLowerCase()}`);
      },
      row,
      `Arm, then click the map to set the ${label.toLowerCase()} location.`
    );
    this.mkBtn(
      'Go to',
      () => this.shell?.goTo(w.x, w.y),
      row,
      `Jump the camera to the ${label.toLowerCase()}.`
    );
    const dir = document.createElement('select');
    dir.title = 'Facing direction the player arrives in at this warp.';
    dir.style.cssText =
      'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;';
    for (const [v, name] of DIR_NAMES) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = name;
      if (v === w.dir) o.selected = true;
      dir.appendChild(o);
    }
    dir.onchange = () => {
      w.dir = Number(dir.value);
      this.shell?.markDirty('events');
    };
    row.appendChild(dir);
    const coords = document.createElement('span');
    coords.textContent = `${w.x},${w.y}`;
    coords.style.cssText = 'color:#7a8aa0;font-size:10px;';
    row.appendChild(coords);
    this.formEl!.appendChild(row);
  }

  // --- small DOM helpers ---------------------------------------------------

  private section(text: string): void {
    const s = document.createElement('div');
    s.textContent = text;
    s.style.cssText = `color:${ACCENT};font-size:10px;margin-top:4px;border-top:1px solid #2a3540;padding-top:4px;`;
    this.formEl!.appendChild(s);
  }

  private textRow(label: string, value: string, onChange: (v: string) => void, tip?: string): void {
    const row = this.labelRow(label, tip);
    const inp = document.createElement('input');
    inp.value = value;
    if (tip) inp.title = tip;
    inp.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    inp.oninput = () => onChange(inp.value);
    row.appendChild(inp);
    this.formEl!.appendChild(row);
  }

  private numRow(label: string, value: number, onChange: (v: number) => void, tip?: string): void {
    const row = this.labelRow(label, tip);
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.value = String(value);
    if (tip) inp.title = tip;
    inp.style.cssText =
      'width:70px;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
    inp.oninput = () => {
      const n = Number(inp.value);
      if (!Number.isNaN(n)) {
        onChange(n);
        this.shell?.markDirty('events');
      }
    };
    row.appendChild(inp);
    this.formEl!.appendChild(row);
  }

  private selectRow(
    label: string,
    options: [string, string][],
    value: string,
    onChange: (v: string) => void,
    tip?: string
  ): void {
    const row = this.labelRow(label, tip);
    const sel = document.createElement('select');
    if (tip) sel.title = tip;
    sel.style.cssText =
      'flex:1;min-width:0;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;padding:2px 3px;';
    for (const [v, name] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = name;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => onChange(sel.value);
    row.appendChild(sel);
    this.formEl!.appendChild(row);
  }

  private checkRow(
    label: string,
    value: boolean,
    onChange: (v: boolean) => void,
    tip?: string
  ): void {
    const row = this.labelRow(label, tip);
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = value;
    if (tip) inp.title = tip;
    inp.onchange = () => onChange(inp.checked);
    row.appendChild(inp);
    this.formEl!.appendChild(row);
  }

  private labelRow(label: string, tip?: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      'flex:1;color:#9ab;' + (tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (tip) l.title = tip;
    row.appendChild(l);
    return row;
  }

  private mkBtn(label: string, onClick: () => void, host: HTMLElement, tip?: string): void {
    const b = document.createElement('button');
    b.textContent = label;
    if (tip) b.title = tip;
    b.style.cssText =
      `background:${ACCENT}22;color:${ACCENT};border:1px solid ${ACCENT};border-radius:3px;` +
      'font:11px monospace;padding:3px 7px;cursor:pointer;white-space:nowrap;';
    b.onclick = onClick;
    host.appendChild(b);
  }
}

// 8-way facing → unit vector (for the warp-marker facing tick). Indexed by
// Direction enum value.
const DIR_VEC: [number, number][] = [
  [0, 1], // S
  [0, -1], // N
  [-1, 0], // W
  [1, 0], // E
  [-0.7, -0.7], // NW
  [-0.7, 0.7], // SW
  [0.7, 0.7], // SE
  [0.7, -0.7], // NE
];

export const eventManagerTool = new EventManagerTool();
