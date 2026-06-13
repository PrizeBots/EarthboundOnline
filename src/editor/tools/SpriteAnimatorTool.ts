import { loadJSON } from '../../engine/AssetLoader';
import {
  drawSprite,
  loadSpriteGroup,
  getSpriteGroupMeta,
  getLiveSheet,
  getPristineSheet,
  SpriteOverrides,
} from '../../engine/SpriteManager';
import { getSpriteName, setSpriteNameOverride } from '../../engine/SpriteNames';
import { ATTACK_ROW_START, POSE_SHEET_ROWS } from '../../engine/PoseGen';
import { Direction, Pose } from '../../types';
import { saveOverride } from '../saveOverride';
import { registerSaveHandler } from '../registry';
import { EditorShellApi, EditorTool } from '../types';

// NPC Sprite Animator (EDITOR_TOOLS.md §5). Every ROM group already gets
// procedurally generated attack/hurt bands at load (PoseGen, from the
// player's own extraction). This tool polishes them: pick any group, paint
// the pose frames at the group's native dimensions, preview through the real
// drawSprite path, and save ONLY the hand-painted diff vs the generated
// pristine (paint + erase PNGs) to overrides/sprites.json — no ROM-derived
// pixels ever land in the override file. Edits paint into the LIVE engine
// sheet, so the world updates as you draw.

const DOMAIN = 'sprites';
const EDIT_ROW_START = ATTACK_ROW_START; // rows 0-4 (walk/climb) are ROM — read-only
const BAND_ROWS = POSE_SHEET_ROWS - EDIT_ROW_START; // attack 4 + hurt 4

type PaintTool = 'pencil' | 'eraser' | 'eyedrop';

const POSE_CYCLE: Pose[] = ['walk', 'attack', 'hurt'];
const DIR_CYCLE: Direction[] = [
  Direction.S, Direction.SW, Direction.W, Direction.NW,
  Direction.N, Direction.NE, Direction.E, Direction.SE,
];

class SpriteAnimatorTool implements EditorTool {
  id = 'sprite-animator';
  name = 'NPC Sprite Animator';
  description =
    'Polish any group\'s generated attack/hurt frames. Saves only hand-painted diffs to overrides/sprites.json.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private overridesDoc: SpriteOverrides = { version: 1, groups: {} };
  private palettes: number[][][] = [];

  // Picker panel
  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private allIds: number[] = [];

  // Open editor state
  private groupId: number | null = null;
  private frameW = 16;
  private frameH = 24;
  private live: HTMLCanvasElement | null = null;
  private pristine: HTMLCanvasElement | null = null;
  private overlay: HTMLDivElement | null = null;
  private stripCanvas: HTMLCanvasElement | null = null;
  private editCanvas: HTMLCanvasElement | null = null;
  private testCanvas: HTMLCanvasElement | null = null;
  private headerName: HTMLSpanElement | null = null;
  private swatchEls: HTMLDivElement[] = [];
  private toolBtns = new Map<PaintTool, HTMLButtonElement>();
  private palette: [number, number, number][] = [];
  private tool: PaintTool = 'pencil';
  private colorIndex = 1;
  private selRow = EDIT_ROW_START;
  private selCol = 0;
  private zoom = 12;
  private stripScale = 2;
  private painting = false;
  private strokeBefore: ImageData | null = null;
  private dirty = true;
  private rafId = 0;
  // Test pane animation
  private testPose: Pose = 'attack';
  private testDirIdx = 0;
  private testFrame = 0;
  private testTimer = 0;

  // --- lifecycle -----------------------------------------------------------

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    void this.loadDoc();
    this.buildPanel();
  }

  deactivate(): void {
    this.closeEditor();
    this.panel?.remove();
    this.panel = null;
    this.listEl = null;
  }

  private async loadDoc(): Promise<void> {
    try {
      this.overridesDoc = await loadJSON<SpriteOverrides>('/overrides/sprites.json');
      this.overridesDoc.groups ??= {};
    } catch {
      this.overridesDoc = { version: 1, groups: {} };
    }
    try {
      this.palettes = await loadJSON<number[][][]>('/assets/sprites/palettes.json');
    } catch {
      this.palettes = [];
    }
    this.refreshList();
  }

  async save(): Promise<void> {
    this.captureOpenGroupDiff();
    await saveOverride('sprites.json', this.overridesDoc);
  }

  onKey(key: string): boolean {
    if (!this.overlay) return false;
    if (key === 'escape') {
      this.closeEditor();
      return true;
    }
    if (key === '1') this.setTool('pencil');
    else if (key === '2') this.setTool('eraser');
    else if (key === '3') this.setTool('eyedrop');
    else if (key === 'p') this.cycleTestPose();
    // Swallow everything else (pan keys etc.) while the overlay is up.
    return true;
  }

  // --- picker panel -----------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;top:36px;right:8px;z-index:91;width:240px;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #e8a33d;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';

    const head = document.createElement('div');
    head.textContent = 'SPRITE ANIMATOR';
    head.style.cssText = 'color:#e8a33d;letter-spacing:1px;';
    this.panel.appendChild(head);

    const note = document.createElement('div');
    note.style.cssText = 'color:#9fb8cc;font-size:10px;';
    note.textContent =
      'Attack/hurt frames are auto-generated for every group; pick one to hand-polish. ✎ renames.';
    this.panel.appendChild(note);

    const search = document.createElement('input');
    search.placeholder = 'search name or id…';
    search.style.cssText =
      'font:12px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;' +
      'border-radius:3px;padding:3px 6px;';
    search.oninput = () => this.refreshList(search.value.trim().toLowerCase());
    this.panel.appendChild(search);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText =
      'display:flex;flex-direction:column;gap:3px;overflow-y:auto;max-height:55vh;';
    this.panel.appendChild(this.listEl);

    document.body.appendChild(this.panel);
    this.refreshList();
  }

  private refreshList(filter = ''): void {
    if (!this.listEl) return;
    if (this.allIds.length === 0) {
      // All groups with metadata (the full 463), names included.
      for (let id = 0; id < 1024; id++) {
        if (getSpriteGroupMeta(id)) this.allIds.push(id);
      }
    }
    const matches = this.allIds.filter((id) => {
      if (!filter) return true;
      const name = (getSpriteName(id) ?? '').toLowerCase();
      return String(id).includes(filter) || name.includes(filter);
    });
    this.listEl.innerHTML = '';
    for (const id of matches.slice(0, 40)) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:2px 4px;cursor:pointer;' +
        'border:1px solid #243;border-radius:3px;background:#0c1014;';
      const thumb = document.createElement('canvas');
      thumb.width = 24;
      thumb.height = 32;
      thumb.style.cssText = 'image-rendering:pixelated;flex:none;';
      void loadSpriteGroup(id)
        .then(() => {
          const tctx = thumb.getContext('2d')!;
          tctx.imageSmoothingEnabled = false;
          drawSprite(tctx, id, Direction.S, 0, 12, 30);
        })
        .catch(() => {});
      row.appendChild(thumb);
      const label = document.createElement('span');
      const authored = this.overridesDoc.groups?.[String(id)] ? ' ★' : '';
      label.textContent = `${id} ${getSpriteName(id) ?? ''}${authored}`;
      label.style.cssText = 'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.appendChild(label);
      row.onclick = () => void this.openGroup(id);
      this.listEl.appendChild(row);
    }
    if (matches.length > 40) {
      const more = document.createElement('div');
      more.textContent = `…${matches.length - 40} more — narrow the search`;
      more.style.cssText = 'color:#667;font-size:10px;';
      this.listEl.appendChild(more);
    }
  }

  // --- group editor overlay ------------------------------------------------------

  async openGroup(groupId: number): Promise<void> {
    this.closeEditor();
    const meta = getSpriteGroupMeta(groupId);
    if (!meta) {
      this.shell?.toast(`No metadata for sprite group ${groupId}`, true);
      return;
    }
    await loadSpriteGroup(groupId);
    const live = getLiveSheet(groupId);
    const pristine = getPristineSheet(groupId);
    if (!live || !pristine) {
      this.shell?.toast(`Group ${groupId} has no editable sheet (custom group?)`, true);
      return;
    }
    this.groupId = groupId;
    this.frameW = meta.width;
    this.frameH = meta.height;
    this.live = live;
    this.pristine = pristine;
    this.palette = (this.palettes[meta.palette] ?? []).map((c) => [c[0], c[1], c[2]]);
    this.selRow = EDIT_ROW_START;
    this.selCol = 0;
    this.zoom = Math.max(4, Math.min(16, Math.floor(360 / Math.max(meta.width, meta.height))));
    this.stripScale = meta.height * POSE_SHEET_ROWS > 360 ? 1 : 2;
    this.buildOverlay();
    this.dirty = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private closeEditor(): void {
    if (this.groupId !== null) this.captureOpenGroupDiff();
    cancelAnimationFrame(this.rafId);
    this.overlay?.remove();
    this.overlay = null;
    this.groupId = null;
    this.live = null;
    this.pristine = null;
    this.swatchEls = [];
    this.toolBtns.clear();
    this.painting = false;
  }

  private buildOverlay(): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText =
      'position:fixed;inset:0;z-index:95;background:#16161eee;color:#ddd;' +
      'font:12px monospace;display:flex;flex-direction:column;align-items:center;' +
      'overflow:auto;user-select:none;padding:8px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;gap:12px;align-items:center;padding:6px;color:#fff;';
    this.headerName = document.createElement('span');
    this.headerName.style.cssText = 'color:#e8a33d;letter-spacing:1px;';
    header.appendChild(this.headerName);
    const mkBtn = (label: string, fn: () => void, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:12px monospace;padding:3px 10px;cursor:pointer;border-radius:3px;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = fn;
      header.appendChild(b);
      return b;
    };
    mkBtn('✎ Rename', () => this.renameGroup());
    mkBtn('Reset frame', () => this.resetCell());
    mkBtn('Save', () => {
      void this.save()
        .then(() => {
          this.shell?.clearDirty(DOMAIN);
          this.shell?.toast('Saved overrides/sprites.json');
          this.refreshList();
        })
        .catch((err) => this.shell?.toast(String(err), true));
    }, true);
    mkBtn('Close (Esc)', () => this.closeEditor());
    this.overlay.appendChild(header);
    this.updateHeader();

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:14px;align-items:flex-start;';
    this.overlay.appendChild(row);

    // Tools + palette
    const toolsPanel = document.createElement('div');
    toolsPanel.style.cssText =
      'display:flex;flex-direction:column;gap:5px;background:#1f1f2a;border:1px solid #333;' +
      'border-radius:4px;padding:8px;';
    for (const [t, label] of [['pencil', '1 ✏ Pencil'], ['eraser', '2 ▭ Eraser'], ['eyedrop', '3 ⊕ Eyedrop']] as [PaintTool, string][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:11px monospace;padding:4px 7px;background:#2a2a3a;color:#ddd;' +
        'border:1px solid #444;border-radius:3px;cursor:pointer;text-align:left;';
      b.onclick = () => this.setTool(t);
      this.toolBtns.set(t, b);
      toolsPanel.appendChild(b);
    }
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,22px);gap:3px;margin-top:6px;';
    this.palette.forEach((c, i) => {
      const sw = document.createElement('div');
      sw.style.cssText = 'width:22px;height:22px;border:2px solid #444;cursor:pointer;border-radius:2px;';
      sw.style.background =
        i === 0
          ? 'repeating-conic-gradient(#555 0% 25%, #2a2a2a 0% 50%) 0 0 / 11px 11px'
          : `rgb(${c[0]},${c[1]},${c[2]})`;
      sw.onclick = () => this.setColor(i);
      this.swatchEls.push(sw);
      grid.appendChild(sw);
    });
    toolsPanel.appendChild(grid);
    const note = document.createElement('div');
    note.style.cssText = 'color:#888;font-size:10px;max-width:120px;margin-top:6px;';
    note.textContent = 'Rows F-M (attack/hurt) are editable; walk rows are ROM and locked. P cycles preview pose.';
    toolsPanel.appendChild(note);
    row.appendChild(toolsPanel);

    // Frame strip
    this.stripCanvas = document.createElement('canvas');
    this.stripCanvas.width = this.frameW * 4 * this.stripScale;
    this.stripCanvas.height = this.frameH * POSE_SHEET_ROWS * this.stripScale;
    this.stripCanvas.style.cssText = 'image-rendering:pixelated;cursor:pointer;background:#1f1f2a;';
    this.stripCanvas.onmousedown = (e) => {
      const r = this.stripCanvas!.getBoundingClientRect();
      const col = Math.floor((e.clientX - r.left) / (this.frameW * this.stripScale));
      const rowI = Math.floor((e.clientY - r.top) / (this.frameH * this.stripScale));
      if (rowI < EDIT_ROW_START) {
        this.shell?.toast('Walk/climb rows are ROM frames — read-only here');
        return;
      }
      this.selCol = Math.max(0, Math.min(col, 3));
      this.selRow = Math.max(EDIT_ROW_START, Math.min(rowI, POSE_SHEET_ROWS - 1));
      this.dirty = true;
    };
    row.appendChild(this.stripCanvas);

    // Edit canvas
    this.editCanvas = document.createElement('canvas');
    this.editCanvas.width = this.frameW * this.zoom;
    this.editCanvas.height = this.frameH * this.zoom;
    this.editCanvas.style.cssText = 'image-rendering:pixelated;cursor:crosshair;background:#26262e;';
    this.editCanvas.oncontextmenu = (e) => e.preventDefault();
    this.editCanvas.onmousedown = (e) => {
      this.painting = true;
      this.strokeBefore = this.bandSnapshot();
      this.applyAt(e);
    };
    this.editCanvas.onmousemove = (e) => {
      if (this.painting) this.applyAt(e);
    };
    window.addEventListener('mouseup', this.onGlobalUp);
    row.appendChild(this.editCanvas);

    // Test pane
    const testPanel = document.createElement('div');
    testPanel.style.cssText =
      'display:flex;flex-direction:column;gap:5px;background:#1f1f2a;border:1px solid #333;' +
      'border-radius:4px;padding:8px;';
    this.testCanvas = document.createElement('canvas');
    this.testCanvas.width = 192;
    this.testCanvas.height = 160;
    this.testCanvas.style.cssText = 'image-rendering:pixelated;background:#3a6a44;';
    testPanel.appendChild(this.testCanvas);
    const poseBtn = document.createElement('button');
    poseBtn.dataset.role = 'pose';
    poseBtn.style.cssText =
      'font:11px monospace;padding:3px 7px;background:#2a2a3a;color:#ddd;border:1px solid #444;' +
      'border-radius:3px;cursor:pointer;';
    poseBtn.textContent = `Pose: ${this.testPose} (P)`;
    poseBtn.onclick = () => this.cycleTestPose();
    testPanel.appendChild(poseBtn);
    row.appendChild(testPanel);

    document.body.appendChild(this.overlay);
    this.setTool('pencil');
    this.setColor(this.colorIndex < this.palette.length ? this.colorIndex : 1);
  }

  private updateHeader(): void {
    if (this.headerName && this.groupId !== null) {
      this.headerName.textContent = `#${this.groupId} ${getSpriteName(this.groupId) ?? '(unnamed)'}`;
    }
  }

  private renameGroup(): void {
    if (this.groupId === null) return;
    const current = getSpriteName(this.groupId) ?? '';
    const name = window.prompt(`Rename sprite group #${this.groupId} (applies everywhere)`, current);
    if (name === null) return;
    setSpriteNameOverride(this.groupId, name.trim() || null);
    this.shell?.markDirty('names');
    this.updateHeader();
    this.refreshList();
    this.shell?.toast(`Renamed to "${name.trim() || '(default)'}" — Save-all writes names.json`);
  }

  private cycleTestPose(): void {
    this.testPose = POSE_CYCLE[(POSE_CYCLE.indexOf(this.testPose) + 1) % POSE_CYCLE.length];
    const btn = this.overlay?.querySelector<HTMLButtonElement>('button[data-role=pose]');
    if (btn) btn.textContent = `Pose: ${this.testPose} (P)`;
  }

  private setTool(t: PaintTool): void {
    this.tool = t;
    for (const [key, b] of this.toolBtns) {
      b.style.borderColor = key === t ? '#9af' : '#444';
      b.style.color = key === t ? '#fff' : '#ddd';
    }
  }

  private setColor(i: number): void {
    this.colorIndex = i;
    this.swatchEls.forEach((sw, j) => {
      sw.style.borderColor = j === i ? '#fff' : '#444';
    });
  }

  // --- painting ---------------------------------------------------------------

  private applyAt(e: MouseEvent): void {
    if (!this.editCanvas || !this.live) return;
    const r = this.editCanvas.getBoundingClientRect();
    const px = Math.floor((e.clientX - r.left) / this.zoom);
    const py = Math.floor((e.clientY - r.top) / this.zoom);
    if (px < 0 || py < 0 || px >= this.frameW || py >= this.frameH) return;
    const sx = this.selCol * this.frameW + px;
    const sy = this.selRow * this.frameH + py;
    const ctx = this.live.getContext('2d')!;

    if (this.tool === 'eyedrop') {
      const d = ctx.getImageData(sx, sy, 1, 1).data;
      if (d[3] === 0) this.setColor(0);
      else {
        let best = 1;
        let bestDist = Infinity;
        for (let i = 1; i < this.palette.length; i++) {
          const [pr, pg, pb] = this.palette[i];
          const dist = (pr - d[0]) ** 2 + (pg - d[1]) ** 2 + (pb - d[2]) ** 2;
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        }
        this.setColor(best);
      }
      this.setTool('pencil');
      return;
    }

    ctx.clearRect(sx, sy, 1, 1);
    if (this.tool === 'pencil' && this.colorIndex > 0 && (e.buttons & 2) === 0) {
      const [cr, cg, cb] = this.palette[this.colorIndex] ?? [255, 255, 255];
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(sx, sy, 1, 1);
    }
    this.dirty = true;
    this.shell?.markDirty(DOMAIN);
  }

  private onGlobalUp = (): void => {
    if (!this.painting || !this.live || !this.strokeBefore) {
      this.painting = false;
      return;
    }
    this.painting = false;
    const before = this.strokeBefore;
    const after = this.bandSnapshot()!;
    this.strokeBefore = null;
    const live = this.live;
    const bandY = this.frameH * EDIT_ROW_START;
    let changed = false;
    for (let i = 0; i < before.data.length; i++) {
      if (before.data[i] !== after.data[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.shell?.run({
      label: `paint sprite #${this.groupId}`,
      do: () => {
        live.getContext('2d')!.putImageData(after, 0, bandY);
        this.dirty = true;
        this.shell?.markDirty(DOMAIN);
      },
      undo: () => {
        live.getContext('2d')!.putImageData(before, 0, bandY);
        this.dirty = true;
        this.shell?.markDirty(DOMAIN);
      },
    });
  };

  private bandSnapshot(): ImageData | null {
    if (!this.live) return null;
    return this.live
      .getContext('2d')!
      .getImageData(0, this.frameH * EDIT_ROW_START, this.frameW * 4, this.frameH * BAND_ROWS);
  }

  /** Restore the selected frame to its generated (pristine) pixels. */
  private resetCell(): void {
    if (!this.live || !this.pristine) return;
    const before = this.bandSnapshot()!;
    const ctx = this.live.getContext('2d')!;
    const x = this.selCol * this.frameW;
    const y = this.selRow * this.frameH;
    ctx.clearRect(x, y, this.frameW, this.frameH);
    ctx.drawImage(this.pristine, x, y, this.frameW, this.frameH, x, y, this.frameW, this.frameH);
    const after = this.bandSnapshot()!;
    const live = this.live;
    const bandY = this.frameH * EDIT_ROW_START;
    this.shell?.run({
      label: 'reset frame',
      do: () => {
        live.getContext('2d')!.putImageData(after, 0, bandY);
        this.dirty = true;
        this.shell?.markDirty(DOMAIN);
      },
      undo: () => {
        live.getContext('2d')!.putImageData(before, 0, bandY);
        this.dirty = true;
        this.shell?.markDirty(DOMAIN);
      },
    });
    this.dirty = true;
  }

  // --- override diffing ----------------------------------------------------------

  /** Diff the open group's live bands vs pristine into paint/erase patches. */
  private captureOpenGroupDiff(): void {
    if (this.groupId === null || !this.live || !this.pristine) return;
    const w = this.frameW * 4;
    const h = this.frameH * BAND_ROWS;
    const bandY = this.frameH * EDIT_ROW_START;
    const liveD = this.live.getContext('2d')!.getImageData(0, bandY, w, h);
    const prisD = this.pristine.getContext('2d')!.getImageData(0, bandY, w, h);

    const paint = document.createElement('canvas');
    const erase = document.createElement('canvas');
    paint.width = erase.width = w;
    paint.height = erase.height = h;
    const paintD = paint.getContext('2d')!.createImageData(w, h);
    const eraseD = erase.getContext('2d')!.createImageData(w, h);
    let paintCount = 0;
    let eraseCount = 0;
    for (let i = 0; i < liveD.data.length; i += 4) {
      const same =
        liveD.data[i] === prisD.data[i] &&
        liveD.data[i + 1] === prisD.data[i + 1] &&
        liveD.data[i + 2] === prisD.data[i + 2] &&
        liveD.data[i + 3] === prisD.data[i + 3];
      if (same) continue;
      if (liveD.data[i + 3] === 0) {
        eraseD.data[i + 3] = 255; // pixel removed vs generated
        eraseCount++;
      } else {
        paintD.data[i] = liveD.data[i];
        paintD.data[i + 1] = liveD.data[i + 1];
        paintD.data[i + 2] = liveD.data[i + 2];
        paintD.data[i + 3] = liveD.data[i + 3];
        paintCount++;
      }
    }
    const groups = (this.overridesDoc.groups ??= {});
    const key = String(this.groupId);
    if (paintCount === 0 && eraseCount === 0) {
      delete groups[key];
      return;
    }
    paint.getContext('2d')!.putImageData(paintD, 0, 0);
    erase.getContext('2d')!.putImageData(eraseD, 0, 0);
    const entry: { paint?: string; erase?: string } = {};
    if (paintCount > 0) entry.paint = paint.toDataURL();
    if (eraseCount > 0) entry.erase = erase.toDataURL();
    groups[key] = entry;
  }

  // --- render loop ------------------------------------------------------------------

  private tick = (): void => {
    if (!this.overlay) return;
    if (this.dirty) {
      this.drawStrip();
      this.drawEdit();
      this.dirty = false;
    }
    this.drawTest();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private drawStrip(): void {
    if (!this.stripCanvas || !this.live) return;
    const ctx = this.stripCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#26262e';
    ctx.fillRect(0, 0, this.stripCanvas.width, this.stripCanvas.height);
    ctx.drawImage(this.live, 0, 0, this.stripCanvas.width, this.stripCanvas.height);
    // Dim the read-only ROM rows.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, this.stripCanvas.width, EDIT_ROW_START * this.frameH * this.stripScale);
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      this.selCol * this.frameW * this.stripScale + 1,
      this.selRow * this.frameH * this.stripScale + 1,
      this.frameW * this.stripScale - 2,
      this.frameH * this.stripScale - 2
    );
  }

  private drawEdit(): void {
    if (!this.editCanvas || !this.live) return;
    const ctx = this.editCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#26262e';
    ctx.fillRect(0, 0, this.editCanvas.width, this.editCanvas.height);
    ctx.fillStyle = '#2e2e38';
    for (let y = 0; y < this.frameH; y++) {
      for (let x = y % 2 === 0 ? 0 : 1; x < this.frameW; x += 2) {
        ctx.fillRect(x * this.zoom, y * this.zoom, this.zoom, this.zoom);
      }
    }
    ctx.drawImage(
      this.live,
      this.selCol * this.frameW, this.selRow * this.frameH, this.frameW, this.frameH,
      0, 0, this.frameW * this.zoom, this.frameH * this.zoom
    );
  }

  private drawTest(): void {
    if (!this.testCanvas || this.groupId === null) return;
    if (++this.testTimer >= 20) {
      this.testTimer = 0;
      this.testFrame = this.testFrame === 0 ? 1 : 0;
      if (this.testFrame === 0) this.testDirIdx = (this.testDirIdx + 1) % DIR_CYCLE.length;
    }
    const ctx = this.testCanvas.getContext('2d')!;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#3a6a44';
    ctx.fillRect(0, 0, 96, 80);
    drawSprite(ctx, this.groupId, DIR_CYCLE[this.testDirIdx], this.testFrame, 48, 56, 'full', this.testPose);
  }
}

export const spriteAnimatorTool = new SpriteAnimatorTool();
registerSaveHandler(DOMAIN, () => spriteAnimatorTool.save());
