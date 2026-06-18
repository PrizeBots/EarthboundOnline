import { EditorTool, EditorShellApi, WorldPoint } from '../types';
import { Camera } from '../../engine/Camera';
import { Direction } from '../../types';
import { drawSprite, loadSpriteGroup, getSpriteGroupMeta } from '../../engine/SpriteManager';
import { loadNPCs, Vehicle, CarTraffic } from '../../engine/NPCManager';
import { saveOverride, loadOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import { dialogueTool } from './DialogueTool';

// Traffic Editor (EDITOR_TOOLS.md). Place vehicles and draw each one's waypoint
// route; the server drives the car along it (server/npcSim.js), facing its
// travel direction. A car plows foes (enemies + PKers) it runs over for its
// `damage`, nudges friendlies out of the lane, and is itself attackable (PK
// rules) with `hp` HP — destroyed cars respawn at the route start. Saves the
// WHOLE file to the overrides layer (public/overrides/car_traffic.json — OUR
// authored content, no ROM base), preferred over the committed default by both
// NPCManager (client) and npcSim (server). One car per vehicle.

// The ONLY sprites traffic may use — EarthBound's drivable vehicle groups.
// The picker is restricted to these so no townsperson/prop can be chosen.
const VEHICLE_SPRITES: { id: number; name: string }[] = [
  { id: 255, name: 'Car' },
  { id: 206, name: 'Taxi' },
  { id: 459, name: 'Truck' },
  { id: 207, name: 'Delivery Truck' },
  { id: 460, name: 'Moving Van' },
  { id: 208, name: 'Camper Van' },
  { id: 243, name: 'Tour Bus' },
  { id: 254, name: 'Bulldozer' },
];
const DEFAULT_SPRITE = VEHICLE_SPRITES[0].id; // Car
const WP_PICK = 9; // world-px pick radius for a waypoint dot
// Combat defaults — KEEP IN SYNC with npcSim VEHICLE_HP / VEHICLE_DAMAGE so an
// unauthored car behaves the same whether or not the editor wrote these fields.
const VEHICLE_DEFAULT_HP = 80;
const VEHICLE_DEFAULT_DAMAGE = 14;

let idCounter = 0;

/** Client mirror of npcSim.dir8 — only used to face the editor preview sprite. */
function dir8(dx: number, dy: number): Direction {
  if (dx === 0 && dy === 0) return Direction.S;
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
  return [3, 6, 0, 5, 2, 4, 1, 7][oct] as Direction;
}

class TrafficEditorTool implements EditorTool {
  id = 'traffic';
  name = 'Traffic Editor';
  description = 'Place vehicles and draw the waypoint routes they drive around town.';
  status: 'ready' = 'ready';

  private shell: EditorShellApi | null = null;
  private vehicles: Vehicle[] = [];
  private sel: Vehicle | null = null;
  private selWp: number | null = null;
  private placing = false; // next click drops a brand-new vehicle
  private addWp = false; // clicks append waypoints to the selected vehicle
  private pendingSelectId: string | null = null; // select-on-open (Placement handoff)
  private dragging = false;
  private hover: WorldPoint = { x: 0, y: 0 };
  private requestedSheets = new Set<number>();

  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private formEl: HTMLDivElement | null = null;
  private fields = new Map<string, HTMLInputElement>();
  private addBtn: HTMLButtonElement | null = null;
  private thumb: HTMLCanvasElement | null = null;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    registerSaveHandler('traffic', () => this.save());
    this.buildPanel();
    this.refreshList();
    this.rebuildForm();
    void this.loadAndRefresh();
  }

  private async loadAndRefresh(): Promise<void> {
    try {
      await this.load();
    } catch (e) {
      this.shell?.toast(`Couldn't load traffic: ${e}`, true);
      return;
    }
    this.refreshList();
    this.rebuildForm();
    this.applyPendingSelect();
  }

  /**
   * Jump to a vehicle by id when this tool opens — the Placement Editor's
   * "Edit route in Traffic" handoff for a selected vehicle NPC. Applied now if
   * the panel is up, else after the next load().
   */
  requestVehicle(id: string): void {
    if (this.panel) this.selectVehicle(id);
    else this.pendingSelectId = id;
  }

  private applyPendingSelect(): void {
    const id = this.pendingSelectId;
    if (id == null) return;
    this.pendingSelectId = null;
    this.selectVehicle(id);
  }

  /** Select a vehicle by id, center the view on it, and show its form. */
  private selectVehicle(id: string): void {
    const v = this.vehicles.find((veh) => veh.id === id);
    if (!v) {
      this.shell?.toast(`Vehicle ${id} not found`, true);
      return;
    }
    this.sel = v;
    this.selWp = null;
    this.setAddWp(false);
    if (v.waypoints[0]) this.shell?.context.teleport(v.waypoints[0][0], v.waypoints[0][1]);
    this.refreshList();
    this.rebuildForm();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.placing = false;
    this.addWp = false;
    this.dragging = false;
    this.sel = null;
    this.selWp = null;
  }

  private async load(): Promise<void> {
    let cfg: CarTraffic | null = null;
    try {
      cfg = await loadOverride<CarTraffic>('car_traffic.json');
    } catch {
      cfg = null;
    }
    if (!cfg) {
      cfg = await fetch('/assets/map/car_traffic.json')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    this.vehicles = (cfg?.vehicles ?? []).map((v) => ({
      id: v.id || this.genId(),
      name: v.name || 'car',
      sprite: v.sprite ?? DEFAULT_SPRITE,
      speed: v.speed ?? 1,
      loop: v.loop !== false,
      enabled: v.enabled !== false,
      hp: v.hp ?? VEHICLE_DEFAULT_HP,
      damage: v.damage ?? VEHICLE_DEFAULT_DAMAGE,
      waypoints: Array.isArray(v.waypoints)
        ? v.waypoints.map(([x, y]) => [x, y] as [number, number])
        : [],
      t: v.t ?? null,
    }));
  }

  private genId(): string {
    return `v_${Date.now().toString(36)}${idCounter++}`;
  }

  // --- save ----------------------------------------------------------------------------

  private async save(): Promise<void> {
    const file: CarTraffic = {
      version: 1,
      vehicles: this.vehicles.map((v) => {
        const meta = getSpriteGroupMeta(v.sprite);
        return {
          id: v.id,
          name: v.name,
          sprite: v.sprite,
          w: meta?.width ?? 40,
          h: meta?.height ?? 28,
          speed: v.speed,
          loop: v.loop,
          enabled: v.enabled,
          hp: v.hp ?? VEHICLE_DEFAULT_HP,
          damage: v.damage ?? VEHICLE_DEFAULT_DAMAGE,
          waypoints: v.waypoints.map(
            ([x, y]) => [Math.round(x), Math.round(y)] as [number, number]
          ),
          ...(v.t != null ? { t: v.t } : {}),
        };
      }),
    };
    await saveOverride('car_traffic.json', file);
    // Reload this client's cars immediately; the server picks the override up via
    // its file watch. A change to the active-vehicle count shifts wire ids, so
    // other connected clients must refresh — see the toast.
    await loadNPCs();
    this.shell?.clearDirty('traffic');
    this.shell?.toast('Saved traffic — live here; other clients refresh to resync');
  }

  // --- input ---------------------------------------------------------------------------

  onMouseMove(p: WorldPoint, dragging: boolean): void {
    this.hover = p;
    if (dragging && this.dragging && this.sel && this.selWp !== null) {
      this.sel.waypoints[this.selWp] = [Math.round(p.x), Math.round(p.y)];
    }
  }

  onMouseDown(p: WorldPoint): boolean {
    if (this.placing) {
      const v: Vehicle = {
        id: this.genId(),
        name: this.nextName(),
        sprite: DEFAULT_SPRITE,
        speed: 1,
        loop: true,
        enabled: true,
        hp: VEHICLE_DEFAULT_HP,
        damage: VEHICLE_DEFAULT_DAMAGE,
        waypoints: [[Math.round(p.x), Math.round(p.y)]],
      };
      this.vehicles.push(v);
      this.sel = v;
      this.selWp = 0;
      this.placing = false;
      this.setAddWp(true); // immediately ready to drop the rest of the route
      this.shell?.markDirty('traffic');
      this.refreshList();
      this.rebuildForm();
      this.shell?.toast('Click to add waypoints; toggle "Add waypoints" off when done');
      return true;
    }
    // Grab an existing waypoint (any vehicle) to select + drag it.
    const hit = this.pickWaypoint(p);
    if (hit) {
      this.sel = hit.veh;
      this.selWp = hit.idx;
      this.dragging = true;
      this.refreshList();
      this.rebuildForm();
      return true;
    }
    // Append a waypoint to the selected vehicle while in add mode.
    if (this.addWp && this.sel) {
      this.sel.waypoints.push([Math.round(p.x), Math.round(p.y)]);
      this.selWp = this.sel.waypoints.length - 1;
      this.dragging = true;
      this.shell?.markDirty('traffic');
      this.rebuildForm();
      return true;
    }
    // Click the vehicle's body (its sprite) to select it — same feel as the
    // Placement Editor's NPC picking. Selecting via the body (not just a dot)
    // makes any car with traffic logic directly editable.
    const veh = this.pickVehicle(p);
    if (veh) {
      this.sel = veh;
      this.selWp = null;
      this.setAddWp(false);
      this.refreshList();
      this.rebuildForm();
      return true;
    }
    return false; // let the shell pan
  }

  onMouseUp(): void {
    if (this.dragging) {
      this.shell?.markDirty('traffic');
      this.rebuildForm();
    }
    this.dragging = false;
  }

  onKey(key: string): boolean {
    if (key === 'n') {
      this.startPlacing();
      return true;
    }
    if (key === 'delete' || key === 'backspace') {
      if (this.sel && this.selWp !== null) {
        this.sel.waypoints.splice(this.selWp, 1);
        this.selWp = null;
        this.shell?.markDirty('traffic');
        this.refreshList();
        this.rebuildForm();
        return true;
      }
      if (this.sel) {
        this.deleteVehicle();
        return true;
      }
    }
    return false;
  }

  private pickWaypoint(p: WorldPoint): { veh: Vehicle; idx: number } | null {
    let best: { veh: Vehicle; idx: number } | null = null;
    let bestD = WP_PICK;
    // Prefer the selected vehicle's points, then everyone else's.
    const order = this.sel
      ? [this.sel, ...this.vehicles.filter((v) => v !== this.sel)]
      : this.vehicles;
    for (const veh of order) {
      for (let i = 0; i < veh.waypoints.length; i++) {
        const [wx, wy] = veh.waypoints[i];
        const d = Math.hypot(wx - p.x, wy - p.y);
        if (d < bestD) {
          bestD = d;
          best = { veh, idx: i };
        }
      }
    }
    return best;
  }

  /**
   * The vehicle whose body (sprite cell at its first waypoint) is under a point,
   * front-most by feet-Y — mirrors PlacementTool's NPC/vehicle hit test so a car
   * is selectable by clicking it, not only its waypoint dots.
   */
  private pickVehicle(p: WorldPoint): Vehicle | null {
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

  private nextName(): string {
    let n = this.vehicles.length + 1;
    const taken = new Set(this.vehicles.map((v) => v.name));
    while (taken.has(`car-${n}`)) n++;
    return `car-${n}`;
  }

  private startPlacing(): void {
    this.placing = true;
    this.setAddWp(false);
    this.shell?.toast('Click the map to drop the new vehicle (its first waypoint)');
  }

  private setAddWp(on: boolean): void {
    this.addWp = on;
    if (this.addBtn) {
      this.addBtn.style.color = on ? '#7fe0a0' : '#cde';
      this.addBtn.style.borderColor = on ? '#7fe0a0' : '#3a4a5a';
    }
  }

  private deleteVehicle(): void {
    if (!this.sel) return;
    const i = this.vehicles.indexOf(this.sel);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.sel = null;
    this.selWp = null;
    this.setAddWp(false);
    this.shell?.markDirty('traffic');
    this.refreshList();
    this.rebuildForm();
  }

  // --- overlay -------------------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);

    for (const v of this.vehicles) {
      const wps = v.waypoints;
      if (wps.length === 0) continue;
      const on = v === this.sel;
      const base = !v.enabled
        ? 'rgba(150,150,150,0.6)'
        : on
          ? 'rgba(127,224,160,0.95)'
          : 'rgba(232,163,61,0.8)';

      // Route polyline (closed if looping).
      if (wps.length >= 2) {
        ctx.strokeStyle = base;
        ctx.lineWidth = on ? 2 : 1;
        ctx.setLineDash(on ? [] : [5, 4]);
        ctx.beginPath();
        ctx.moveTo(wps[0][0] - camX, wps[0][1] - camY);
        for (let i = 1; i < wps.length; i++) ctx.lineTo(wps[i][0] - camX, wps[i][1] - camY);
        if (v.loop) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;

        // Direction arrowheads at each segment midpoint.
        const segs = v.loop ? wps.length : wps.length - 1;
        for (let i = 0; i < segs; i++) {
          const a = wps[i];
          const b = wps[(i + 1) % wps.length];
          this.drawArrow(ctx, a[0] - camX, a[1] - camY, b[0] - camX, b[1] - camY, base);
        }
      }

      // Vehicle preview sprite at the first waypoint, facing the first segment.
      if (!this.requestedSheets.has(v.sprite)) {
        this.requestedSheets.add(v.sprite);
        loadSpriteGroup(v.sprite).catch(() => {});
      }
      const sx = wps[0][0] - camX;
      const sy = wps[0][1] - camY;
      const face =
        wps.length >= 2 ? dir8(wps[1][0] - wps[0][0], wps[1][1] - wps[0][1]) : Direction.S;
      ctx.globalAlpha = v.enabled ? 0.6 : 0.3;
      drawSprite(ctx, v.sprite, face, 0, sx, sy);
      ctx.globalAlpha = 1;

      // Waypoint dots.
      for (let i = 0; i < wps.length; i++) {
        const wx = wps[i][0] - camX;
        const wy = wps[i][1] - camY;
        const selPt = on && i === this.selWp;
        ctx.fillStyle = selPt ? '#fff' : base;
        ctx.beginPath();
        ctx.arc(wx, wy, selPt ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
        if (i === 0) {
          ctx.strokeStyle = base;
          ctx.strokeRect(wx - 5.5, wy - 5.5, 11, 11); // start marker
        }
      }

      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = base;
      ctx.fillText(`${v.name} (${wps.length}wp)`, sx, sy - 14);
      ctx.textAlign = 'left';
    }

    if (this.placing) {
      const sx = this.hover.x - camX;
      const sy = this.hover.y - camY;
      ctx.strokeStyle = 'rgba(127,224,160,0.9)';
      ctx.strokeRect(sx - 7, sy - 7, 14, 14);
    }
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    color: string
  ): void {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const ang = Math.atan2(by - ay, bx - ax);
    const s = 5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(ang) * s, my + Math.sin(ang) * s);
    ctx.lineTo(mx + Math.cos(ang + 2.5) * s, my + Math.sin(ang + 2.5) * s);
    ctx.lineTo(mx + Math.cos(ang - 2.5) * s, my + Math.sin(ang - 2.5) * s);
    ctx.closePath();
    ctx.fill();
  }

  // --- panel ---------------------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #6ad08a;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = '🚗 TRAFFIC';
    title.style.cssText = 'color:#6ad08a;font-weight:bold;letter-spacing:1px;';
    this.panel.appendChild(title);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    this.mkBtn('+ New vehicle (N)', () => this.startPlacing(), actions);
    this.addBtn = this.mkBtn(
      'Add waypoints',
      () => {
        if (!this.sel) {
          this.shell?.toast('Select or place a vehicle first', true);
          return;
        }
        this.setAddWp(!this.addWp);
      },
      actions
    );
    // No Save button — edits auto-save via the shell (registered 'traffic' handler).
    this.panel.appendChild(actions);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:2px;max-height:140px;overflow:auto;' +
      'border-top:1px solid #2a3540;border-bottom:1px solid #2a3540;padding:4px 0;';
    this.panel.appendChild(this.listEl);

    this.formEl = document.createElement('div');
    this.formEl.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    this.panel.appendChild(this.formEl);

    const hint = document.createElement('div');
    hint.textContent = 'drag a dot to move it · Del removes the selected waypoint (or vehicle)';
    hint.style.cssText = 'color:#667;font-size:10px;';
    this.panel.appendChild(hint);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private refreshList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (this.vehicles.length === 0) {
      const e = document.createElement('div');
      e.textContent = 'No vehicles yet.';
      e.style.cssText = 'color:#667;';
      this.listEl.appendChild(e);
      return;
    }
    for (const v of this.vehicles) {
      const row = document.createElement('div');
      const sel = v === this.sel;
      row.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (sel ? 'background:#16301f;' : '');
      const dot = document.createElement('span');
      dot.textContent = '●';
      dot.style.color = !v.enabled ? '#667' : v.waypoints.length >= 2 ? '#6ad08a' : '#e8a33d';
      const label = document.createElement('span');
      label.textContent = `${v.name}  (#${v.sprite}, ${v.waypoints.length}wp)`;
      label.style.cssText =
        'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        (v.enabled ? '' : 'color:#778;');
      row.appendChild(dot);
      row.appendChild(label);
      row.onclick = () => {
        this.sel = v;
        this.selWp = null;
        this.setAddWp(false);
        if (v.waypoints[0]) this.shell?.context.teleport(v.waypoints[0][0], v.waypoints[0][1]);
        this.refreshList();
        this.rebuildForm();
      };
      this.listEl.appendChild(row);
    }
  }

  private rebuildForm(): void {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    this.fields.clear();
    this.thumb = null;
    if (!this.sel) {
      const e = document.createElement('div');
      e.textContent = 'Select or place a vehicle.';
      e.style.cssText = 'color:#667;';
      this.formEl.appendChild(e);
      return;
    }
    const v = this.sel;
    const form = this.formEl;

    const nameIn = this.mkInput(
      form,
      'name',
      'name',
      (val) => {
        v.name = val || 'car';
        this.shell?.markDirty('traffic');
        this.refreshList();
      },
      120
    );
    nameIn.value = v.name;

    // vehicle picker — restricted to the vehicle sprite groups only
    const spriteRow = this.mkRow(form, 'vehicle');
    const sel = document.createElement('select');
    sel.style.cssText =
      'flex:1;font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;' +
      'border-radius:3px;padding:2px;';
    // Show the known vehicles; if an older file referenced something else, keep
    // it visible as a one-off "custom" entry rather than silently changing it.
    const opts = VEHICLE_SPRITES.slice();
    if (!opts.some((o) => o.id === v.sprite)) opts.unshift({ id: v.sprite, name: 'custom' });
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = String(o.id);
      op.textContent = `${o.name} (#${o.id})`;
      sel.appendChild(op);
    }
    sel.value = String(v.sprite);
    sel.onchange = () => {
      v.sprite = parseInt(sel.value, 10);
      this.shell?.markDirty('traffic');
      this.refreshList();
      this.drawThumb();
    };
    spriteRow.appendChild(sel);

    this.thumb = document.createElement('canvas');
    this.thumb.width = 64;
    this.thumb.height = 52;
    this.thumb.style.cssText =
      'image-rendering:pixelated;background:#0c1014;border:1px solid #243;align-self:center;';
    form.appendChild(this.thumb);
    this.drawThumb();

    const speedIn = this.mkInput(form, 'speed', 'speed', (val) => {
      const n = parseFloat(val);
      if (!Number.isNaN(n)) {
        v.speed = Math.max(0.1, n);
        this.shell?.markDirty('traffic');
      }
    });
    speedIn.value = String(v.speed);

    // HP — the car is attackable (PK rules); this is its max health.
    const hpIn = this.mkInput(form, 'hp', 'HP', (val) => {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) {
        v.hp = Math.max(1, n);
        this.shell?.markDirty('traffic');
      }
    });
    hpIn.value = String(v.hp ?? VEHICLE_DEFAULT_HP);

    // damage — what the car deals to a foe (enemy / PKer) it plows.
    const dmgIn = this.mkInput(form, 'damage', 'damage', (val) => {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) {
        v.damage = Math.max(0, n);
        this.shell?.markDirty('traffic');
      }
    });
    dmgIn.value = String(v.damage ?? VEHICLE_DEFAULT_DAMAGE);

    // loop + enabled toggles
    const loopRow = this.mkRow(form, 'loop');
    const loop = document.createElement('input');
    loop.type = 'checkbox';
    loop.checked = v.loop;
    loop.onchange = () => {
      v.loop = loop.checked;
      this.shell?.markDirty('traffic');
    };
    loopRow.appendChild(loop);
    const loopHint = document.createElement('span');
    loopHint.textContent = v.loop ? 'circuit' : 'back-and-forth';
    loopHint.style.cssText = 'color:#778;font-size:10px;';
    loop.addEventListener(
      'change',
      () => (loopHint.textContent = loop.checked ? 'circuit' : 'back-and-forth')
    );
    loopRow.appendChild(loopHint);

    const enRow = this.mkRow(form, 'on');
    const en = document.createElement('input');
    en.type = 'checkbox';
    en.checked = v.enabled;
    en.onchange = () => {
      v.enabled = en.checked;
      this.shell?.markDirty('traffic');
      this.refreshList();
    };
    enRow.appendChild(en);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:10px;color:#8ab;';
    status.textContent =
      v.waypoints.length >= 2
        ? `✓ ${v.waypoints.length} waypoints`
        : '⚠ add at least 2 waypoints to drive';
    if (v.waypoints.length < 2) status.style.color = '#e8a33d';
    form.appendChild(status);

    // A vehicle is an NPC that drives — it can also be talkable. Author/edit its
    // line in the Dialogue Editor, same handoff the Placement Editor uses.
    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;gap:6px;border-top:1px solid #243;padding-top:7px;flex-wrap:wrap;';
    form.appendChild(actions);
    this.mkBtn(
      v.t != null ? 'Dialogue ✎' : '+ Dialogue',
      () => void this.authorDialogue(v),
      actions
    );
    this.mkBtn('Delete vehicle', () => this.deleteVehicle(), actions);

    const talk = document.createElement('div');
    talk.style.cssText = 'font-size:10px;color:#778;';
    talk.textContent =
      v.t != null ? `talkable · textId ${v.t}` : 'silent — add dialogue to make it talkable';
    form.appendChild(talk);
  }

  /** Lowest unused textId in the authored range (kept clear of ROM config ids). */
  private mintTextId(): number {
    let max = 899999;
    for (const v of this.vehicles) if (v.t != null && v.t > max) max = v.t;
    return max + 1;
  }

  /**
   * Author this vehicle's dialogue: assign a fresh textId if it has none, save
   * so the line isn't orphaned, then open the Dialogue Editor on that id.
   */
  private async authorDialogue(v: Vehicle): Promise<void> {
    if (v.t == null) {
      v.t = this.mintTextId();
      this.shell?.markDirty('traffic');
      this.rebuildForm();
    }
    try {
      await this.save();
    } catch (e) {
      this.shell?.toast(`Save failed: ${e}`, true);
      return;
    }
    dialogueTool.requestEntry(String(v.t));
    this.shell?.openTool('dialogue');
  }

  private drawThumb(): void {
    if (!this.thumb || !this.sel) return;
    const c = this.thumb.getContext('2d')!;
    c.clearRect(0, 0, this.thumb.width, this.thumb.height);
    const meta = getSpriteGroupMeta(this.sel.sprite);
    if (!meta) {
      loadSpriteGroup(this.sel.sprite)
        .then(() => this.drawThumb())
        .catch(() => {});
      return;
    }
    drawSprite(c, this.sel.sprite, Direction.E, 0, this.thumb.width / 2, this.thumb.height - 6);
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
        ? 'background:#143d22;color:#6ad08a;border:1px solid #6ad08a;'
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

  private mkInput(
    parent: HTMLElement,
    name: string,
    label: string,
    onChange: (v: string) => void,
    width = 64
  ): HTMLInputElement {
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
}

export const trafficEditorTool = new TrafficEditorTool();
