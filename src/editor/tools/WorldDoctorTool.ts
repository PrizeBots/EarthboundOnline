import { EditorTool, EditorShellApi } from '../types';
import { Camera } from '../../engine/Camera';
import { MAP_WIDTH_TILES, MAP_HEIGHT_TILES, TILE_SIZE } from '../../types';
import { mkButton } from '../ui';
import { loadJSON } from '../../engine/AssetLoader';
import { checkCollision, loadCollision } from '../../engine/Collision';
import { RawNPC, NpcOverrides, mergeNpcOverrides } from '../../engine/NPCManager';
import { getSpriteName } from '../../engine/SpriteNames';
import { getEditorDoorBase, loadDoors } from '../../engine/DoorManager';
import { allGifts, loadGifts } from '../../engine/Gifts';

// World Doctor — a read-only validation pass over the authored world data. It
// scans every NPC/prop placement, enemy spawner, door, and gift container for
// the broken-state classes that recur in bugs.md (placements standing in solid
// collision, doors warping into walls, spawners sealed off a walkable tile,
// gifts with no contents, dialogue links pointing at missing text) and lists
// each one as a clickable issue that flies you to the spot. It writes NOTHING —
// it only reports, so you fix the cause in the owning tool.
//
// Collision is keyed by DRAWING TILESET (not map position) and cached once
// loaded, so the scan first pulls every tileset's collision (≈20 small files)
// to make the in-solid checks reliable map-wide — otherwise an unstreamed
// sector would read as walkable and the check would miss it.

type Severity = 'error' | 'warn';

interface Issue {
  severity: Severity;
  category: string;
  message: string;
  x: number;
  y: number;
}

// The gameplay foot box (mirrors NPCManager / EnemySpawnerTool): collision is by
// the entity's feet, not its whole sprite cell.
const FOOT_W = 14;
const FOOT_H = 8;
const FOOT_OY = -8;
const DRAW_TILESET_MAX = 31; // upper bound; missing ids are skipped

function footSolid(x: number, y: number): boolean {
  return checkCollision(x - FOOT_W / 2, y + FOOT_OY, FOOT_W, FOOT_H);
}
function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_WIDTH_TILES * TILE_SIZE && y < MAP_HEIGHT_TILES * TILE_SIZE;
}

class WorldDoctorTool implements EditorTool {
  id = 'world-doctor';
  name = 'World Doctor';
  description = 'Scan world data for broken placements, doors, spawners + gifts. Read-only.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private panel: HTMLDivElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private summaryEl: HTMLDivElement | null = null;
  private issues: Issue[] = [];
  private selected: Issue | null = null;
  private scanning = false;

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    this.buildPanel();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.listEl = null;
    this.summaryEl = null;
    this.selected = null;
  }

  // --- panel -----------------------------------------------------------------

  private buildPanel(): void {
    const panel = document.createElement('div');
    panel.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const blurb = document.createElement('div');
    blurb.textContent =
      'Scans placements, doors, spawners + gifts for broken state. Read-only — fix the cause in its tool.';
    blurb.style.cssText = 'color:#9fb8cc;font-size:11px;line-height:1.4;';
    panel.appendChild(blurb);

    mkButton('▶ Run scan', () => void this.scan(), {
      parent: panel,
      variant: 'gold',
      pad: '4px 8px',
      tip: 'Preload all collision, then check every placement/door/spawner/gift.',
    });

    this.summaryEl = document.createElement('div');
    this.summaryEl.style.cssText = 'color:#cde;font-size:11px;';
    this.summaryEl.textContent = 'Not scanned yet.';
    panel.appendChild(this.summaryEl);

    this.listEl = document.createElement('div');
    this.listEl.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    panel.appendChild(this.listEl);

    this.shell!.panelHost.appendChild(panel);
    this.panel = panel;
  }

  // --- scan ------------------------------------------------------------------

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.selected = null;
    if (this.summaryEl) this.summaryEl.textContent = 'Scanning…';
    if (this.listEl) this.listEl.innerHTML = '';
    try {
      // Make in-solid checks reliable map-wide: pull every drawing tileset's
      // collision (cached + idempotent; missing ids just no-op).
      const jobs: Promise<unknown>[] = [];
      for (let dt = 0; dt <= DRAW_TILESET_MAX; dt++) jobs.push(loadCollision(dt).catch(() => {}));
      await Promise.all(jobs);

      const issues: Issue[] = [];
      await this.checkPlacements(issues);
      await this.checkDoors(issues);
      await this.checkSpawners(issues);
      await this.checkGifts(issues);

      // Errors first, then by category, then north-to-south.
      issues.sort(
        (a, b) =>
          (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
          a.category.localeCompare(b.category) ||
          a.y - b.y
      );
      this.issues = issues;
      this.renderResults();
    } catch (e) {
      this.shell?.toast(`World Doctor scan failed: ${e}`, true);
      if (this.summaryEl) this.summaryEl.textContent = `Scan failed: ${e}`;
    } finally {
      this.scanning = false;
    }
  }

  private async checkPlacements(out: Issue[]): Promise<void> {
    const base = await loadJSON<RawNPC[]>('/assets/map/npcs.json').catch(() => [] as RawNPC[]);
    const ov = await loadJSON<NpcOverrides>('/overrides/npcs.json').catch(() => null);
    const text = await loadJSON<Record<string, unknown>>('/assets/map/npc_text.json').catch(
      () => ({}) as Record<string, unknown>
    );
    const dlg = await loadJSON<{ edits?: Record<string, unknown> }>(
      '/overrides/dialogue.json'
    ).catch(() => null);
    const hasText = (t: number): boolean => {
      const key = String(t);
      const edit = dlg?.edits?.[key];
      if (edit !== undefined) return edit !== null;
      return key in text && text[key] != null;
    };

    for (const n of mergeNpcOverrides(base, ov)) {
      if (!n) continue; // tombstoned (deleted) slot
      const label = `${getSpriteName(n.sprite)} (${n.kind})`;
      if (!inBounds(n.x, n.y)) {
        out.push({
          severity: 'error',
          category: 'Placement off-map',
          message: label,
          x: n.x,
          y: n.y,
        });
        continue;
      }
      // Persons/enemies must stand on walkable ground (props are often invisible
      // interaction hotspots intentionally embedded in wall tiles — skip those).
      if ((n.kind === 'person' || n.kind === 'enemy') && footSolid(n.x, n.y)) {
        out.push({
          severity: 'error',
          category: 'Placement in solid',
          message: label,
          x: n.x,
          y: n.y,
        });
      }
      if (n.t != null && !hasText(n.t)) {
        out.push({
          severity: 'warn',
          category: 'Dialogue link broken',
          message: `${label} → textId ${n.t} has no text`,
          x: n.x,
          y: n.y,
        });
      }
    }
  }

  private async checkDoors(out: Issue[]): Promise<void> {
    await loadDoors();
    for (const d of getEditorDoorBase()) {
      // An unlinked short-range zone door (style 0, no authored dest) is inactive.
      if (d.zone && d.destX === 0 && d.destY === 0) continue;
      if (!inBounds(d.destX, d.destY)) {
        out.push({
          severity: 'error',
          category: 'Door dest off-map',
          message: `door → (${d.destX}, ${d.destY})`,
          x: d.worldX,
          y: d.worldY,
        });
      } else if (footSolid(d.destX, d.destY)) {
        out.push({
          severity: 'error',
          category: 'Door dest in solid',
          message: `door warps into a wall at (${d.destX}, ${d.destY})`,
          x: d.destX,
          y: d.destY,
        });
      }
    }
  }

  private async checkSpawners(out: Issue[]): Promise<void> {
    type Sp = { x: number; y: number; enabled?: boolean; name?: string };
    const file =
      (await loadJSON<{ spawners?: Sp[] }>('/overrides/enemy_spawns.json').catch(() => null)) ??
      (await loadJSON<{ spawners?: Sp[] }>('/assets/map/enemy_spawns.json').catch(() => null));
    for (const s of file?.spawners ?? []) {
      if (s.enabled === false) continue;
      if (!inBounds(s.x, s.y) || footSolid(s.x, s.y)) {
        out.push({
          severity: 'error',
          category: 'Spawner on solid',
          message: s.name ?? `spawner (${Math.round(s.x)}, ${Math.round(s.y)})`,
          x: s.x,
          y: s.y,
        });
      }
    }
  }

  private async checkGifts(out: Issue[]): Promise<void> {
    try {
      await loadGifts();
    } catch {
      /* gifts may already be loaded by the game; allGifts() still works */
    }
    for (const g of allGifts()) {
      if (g.item == null) {
        out.push({
          severity: 'warn',
          category: 'Gift has no contents',
          message: `${g.added ? 'authored' : 'ROM'} container (flag ${g.romFlag})`,
          x: g.x,
          y: g.y,
        });
      }
    }
  }

  // --- results ---------------------------------------------------------------

  private renderResults(): void {
    if (!this.listEl || !this.summaryEl) return;
    const errors = this.issues.filter((i) => i.severity === 'error').length;
    const warns = this.issues.length - errors;
    this.summaryEl.innerHTML = '';
    const big = document.createElement('span');
    big.textContent = this.issues.length
      ? `${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`
      : '✓ No problems found.';
    big.style.cssText = `color:${this.issues.length ? (errors ? '#ff7a6a' : '#e8c54a') : '#7fe07f'};font-weight:bold;`;
    this.summaryEl.appendChild(big);

    this.listEl.innerHTML = '';
    let lastCat = '';
    for (const issue of this.issues) {
      if (issue.category !== lastCat) {
        lastCat = issue.category;
        const count = this.issues.filter((i) => i.category === issue.category).length;
        const h = document.createElement('div');
        h.textContent = `${issue.category} (${count})`;
        h.style.cssText =
          'color:#9fb8cc;font-size:10px;margin-top:6px;border-bottom:1px solid #243;padding-bottom:1px;';
        this.listEl.appendChild(h);
      }
      this.listEl.appendChild(this.makeRow(issue));
    }
  }

  private makeRow(issue: Issue): HTMLButtonElement {
    const dot = issue.severity === 'error' ? '🔴' : '🟡';
    const b = document.createElement('button');
    b.textContent = `${dot} ${issue.message}`;
    const sel = issue === this.selected;
    b.style.cssText =
      'display:block;width:100%;text-align:left;font:10px monospace;padding:3px 5px;cursor:pointer;' +
      'border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      (sel
        ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
        : 'background:#161c24;color:#cde;border:1px solid #283341;');
    b.title = `(${Math.round(issue.x)}, ${Math.round(issue.y)}) — click to fly here`;
    b.onclick = () => {
      this.selected = issue;
      this.shell?.goTo(issue.x, issue.y);
      this.renderResults();
    };
    return b;
  }

  // --- overlay ---------------------------------------------------------------

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);
    for (const issue of this.issues) {
      const x = Math.round(issue.x) - camX;
      const y = Math.round(issue.y) - camY;
      const here = issue === this.selected;
      ctx.strokeStyle = issue.severity === 'error' ? '#ff5a4a' : '#e8c54a';
      ctx.lineWidth = (here ? 2 : 1) / camera.zoom;
      const r = (here ? 9 : 6) / camera.zoom;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      // crosshair on the exact spot
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      ctx.stroke();
    }
  }
}

export const worldDoctorTool = new WorldDoctorTool();
