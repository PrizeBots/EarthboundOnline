import { SECTOR_TILES_X, SECTOR_TILES_Y, TILE_SIZE, SCREEN_WIDTH, SCREEN_HEIGHT } from '../types';
import { getSectorForTile } from '../engine/MapManager';
import { EditorShell } from './EditorShell';
import { getEditorTools, getSaveHandler } from './registry';

// Admin Home Screen (EDITOR_TOOLS.md §1): the hub every tool launches from.
// Tools self-register in ./registry (re-exported here for convenience) —
// adding a tool needs no hub edits, and Save-all runs per-domain handlers.

export { registerEditorTool, registerSaveHandler } from './registry';

export class EditorHub {
  private overlay: HTMLDivElement | null = null;

  constructor(private readonly shell: EditorShell) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  open(): void {
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.style.cssText =
      'position:fixed;inset:0;z-index:100;background:#0a0d11e6;color:#cde;' +
      'font:13px monospace;display:flex;align-items:center;justify-content:center;user-select:none;';
    this.overlay.onkeydown = (e) => e.stopPropagation();
    window.addEventListener('keydown', this.onKey, true);

    const panel = document.createElement('div');
    panel.style.cssText =
      'width:640px;max-width:92vw;max-height:88vh;overflow:auto;background:#101418;' +
      'border:2px solid #e8a33d;border-radius:6px;padding:18px 22px;display:flex;' +
      'flex-direction:column;gap:14px;';
    this.overlay.appendChild(panel);

    const title = document.createElement('div');
    title.innerHTML =
      '<span style="color:#e8a33d;font-size:16px;letter-spacing:2px;">⚒ ADMIN HUB</span>' +
      '<span style="color:#667;margin-left:12px;">dev only — never ships</span>';
    panel.appendChild(title);

    panel.appendChild(this.buildContextRow());
    panel.appendChild(this.buildToolGrid());
    panel.appendChild(this.buildJumpRow());
    panel.appendChild(this.buildButtonRow());

    document.body.appendChild(this.overlay);
  }

  close(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.overlay?.remove();
    this.overlay = null;
  }

  private onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') this.close();
  };

  private buildContextRow(): HTMLDivElement {
    const ctx = this.shell.context;
    const row = document.createElement('div');
    row.style.cssText = 'color:#9fb8cc;background:#0c1014;border:1px solid #243;border-radius:4px;padding:8px 10px;';
    const px = Math.round(ctx.player.x);
    const py = Math.round(ctx.player.y);
    const camCX = Math.round(ctx.camera.x + ctx.camera.viewW / 2);
    const camCY = Math.round(ctx.camera.y + ctx.camera.viewH / 2);
    const tx = Math.floor(camCX / TILE_SIZE);
    const ty = Math.floor(camCY / TILE_SIZE);
    const sec = getSectorForTile(tx, ty);
    const secX = Math.floor(tx / SECTOR_TILES_X);
    const secY = Math.floor(ty / SECTOR_TILES_Y);
    row.textContent =
      `player (${px},${py})   camera center (${camCX},${camCY})   ` +
      `sector (${secX},${secY})${sec ? ` ts${sec.tilesetId} music ${sec.musicId}` : ' void'}   ${this.shell.fps}fps`;
    return row;
  }

  private buildToolGrid(): HTMLDivElement {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;';
    const tools = getEditorTools();
    if (tools.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No tools registered.';
      empty.style.color = '#667';
      grid.appendChild(empty);
    }
    for (const tool of tools) {
      const tile = document.createElement('div');
      const ready = tool.status === 'ready';
      tile.style.cssText =
        'border:1px solid #3a4a5a;border-radius:4px;padding:10px 12px;' +
        (ready ? 'cursor:pointer;background:#16202b;' : 'background:#11161c;opacity:.65;');
      tile.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;">` +
        `<span style="color:${ready ? '#7fd0ff' : '#8899aa'};font-weight:bold;">${tool.name}</span>` +
        `<span style="font-size:10px;padding:1px 6px;border-radius:8px;` +
        `background:${ready ? '#143a14' : '#3a3014'};color:${ready ? '#7fe07f' : '#e8a33d'};">` +
        `${ready ? 'READY' : 'WIP'}</span></div>` +
        `<div style="color:#9fb8cc;font-size:11px;margin-top:5px;">${tool.description}</div>`;
      tile.onclick = () => {
        if (!ready) {
          this.shell.toast(`${tool.name} is not built yet (see EDITOR_TOOLS.md)`, true);
          return;
        }
        this.shell.setTool(tool);
        this.close();
      };
      grid.appendChild(tile);
    }
    return grid;
  }

  private buildJumpRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const label = document.createElement('span');
    label.textContent = 'Jump to world px:';
    label.style.color = '#9fb8cc';
    row.appendChild(label);

    const mkInput = (ph: string) => {
      const i = document.createElement('input');
      i.placeholder = ph;
      i.style.cssText =
        'width:70px;font:12px monospace;background:#0c1014;color:#cde;' +
        'border:1px solid #3a4a5a;border-radius:3px;padding:3px 6px;';
      row.appendChild(i);
      return i;
    };
    const xIn = mkInput('x');
    const yIn = mkInput('y');

    const go = document.createElement('button');
    go.textContent = 'Go';
    go.style.cssText =
      'font:12px monospace;padding:3px 12px;background:#1d2530;color:#cde;' +
      'border:1px solid #3a4a5a;border-radius:3px;cursor:pointer;';
    go.onclick = () => {
      const x = parseInt(xIn.value, 10);
      const y = parseInt(yIn.value, 10);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        this.shell.toast('Enter numeric x and y', true);
        return;
      }
      this.shell.context.teleport(x, y); // moves the player properly
      this.close();
    };
    row.appendChild(go);
    return row;
  }

  private buildButtonRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #243;padding-top:12px;';

    const mk = (label: string, onClick: () => void, accent = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:12px monospace;padding:5px 14px;border-radius:3px;cursor:pointer;' +
        (accent
          ? 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;'
          : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
      b.onclick = onClick;
      row.appendChild(b);
    };

    mk(`Save all${this.shell.dirty.size ? ` (${this.shell.dirty.size})` : ''}`, () => void this.saveAll(), true);
    mk('Close (Esc)', () => this.close());
    mk('Back to game', () => {
      this.close();
      this.shell.exit();
    });
    return row;
  }

  private async saveAll(): Promise<void> {
    if (this.shell.dirty.size === 0) {
      this.shell.toast('Nothing to save');
      return;
    }
    for (const domain of [...this.shell.dirty]) {
      const save = getSaveHandler(domain);
      if (!save) {
        this.shell.toast(`No save handler for '${domain}'`, true);
        continue;
      }
      try {
        await save();
        this.shell.clearDirty(domain);
        this.shell.toast(`Saved ${domain}`);
      } catch (err) {
        this.shell.toast(String(err), true);
        return;
      }
    }
  }
}
