import { Direction } from '../types';
import { drawSprite, getSpriteGroupMeta, loadSpriteGroup } from './SpriteManager';

// ---------------------------------------------------------------------------
// Sprite-preview dropdown. A native <select> can't render a sprite in its
// option list, so this is a custom dropdown whose trigger AND every row draw
// the real art (via a caller-supplied drawThumb). Shared by the Cast Sprite
// Editor (character + held-item pickers) and the editor tools that assign a
// sprite group (enemy spawner, placement, traffic).
// ---------------------------------------------------------------------------

const PICK_THUMB_W = 26;
const PICK_THUMB_H = 28;

export interface SpritePicker {
  el: HTMLDivElement;
  /** Set the selection + redraw the trigger (does NOT fire onSelect). */
  setValue(v: string): void;
  /** Redraw the current trigger (and open row) thumb in place — for live edits. */
  redraw(): void;
  /** Rebuild rows + trigger after labels changed (e.g. a rename). */
  refresh(): void;
}

export interface SpritePickerOpts {
  /** Grouped option values; an optional section label renders a header row. */
  sections: { label?: string; values: string[] }[];
  initial: string;
  labelFor: (v: string) => string;
  drawThumb: (canvas: HTMLCanvasElement, v: string) => void;
  onSelect: (v: string) => void;
}

export function createSpritePicker(o: SpritePickerOpts): SpritePicker {
  let current = o.initial;
  let isOpen = false;
  let built = false;
  const rowEls = new Map<string, HTMLDivElement>();
  const rowThumbs = new Map<string, HTMLCanvasElement>();

  const mkThumb = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = PICK_THUMB_W;
    c.height = PICK_THUMB_H;
    c.style.cssText = 'image-rendering:pixelated;background:#15151f;border-radius:2px;flex:none;';
    return c;
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;font:11px monospace;';

  const trigger = document.createElement('button');
  trigger.style.cssText =
    'display:flex;align-items:center;gap:6px;width:100%;padding:3px 6px;background:#2a2a3a;' +
    'color:#ddd;border:1px solid #444;border-radius:3px;cursor:pointer;text-align:left;';
  const triggerThumb = mkThumb();
  const triggerLabel = document.createElement('span');
  triggerLabel.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const caret = document.createElement('span');
  caret.textContent = '▾';
  caret.style.cssText = 'flex:none;color:#9af;';
  trigger.append(triggerThumb, triggerLabel, caret);
  root.appendChild(trigger);

  const menu = document.createElement('div');
  menu.style.cssText =
    'position:absolute;left:0;right:0;top:100%;margin-top:2px;z-index:1000;display:none;' +
    'max-height:280px;overflow:auto;background:#1c1c28;border:1px solid #555;border-radius:3px;' +
    'box-shadow:0 6px 18px rgba(0,0,0,0.5);';
  root.appendChild(menu);

  // Quick-filter: type a few letters to narrow the list by id or name. Sticky
  // at the top of the scrolling menu. Filtering runs off the `input` event so
  // it works even where a parent capture-listener (e.g. the Sprite Editor)
  // intercepts keydown.
  let filter = '';
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'search id or name…';
  search.style.cssText =
    'position:sticky;top:0;z-index:2;box-sizing:border-box;width:100%;margin:0;' +
    'font:11px monospace;background:#101018;color:#cde;border:0;border-bottom:1px solid #3a4a5a;' +
    'padding:5px 8px;outline:none;';
  search.oninput = () => {
    filter = search.value.trim().toLowerCase();
    applyFilter();
  };
  search.onkeydown = (e) => {
    // Typing must not pan the editor camera / fire tool hotkeys.
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (filter) { search.value = ''; filter = ''; applyFilter(); }
      else close();
    } else if (e.key === 'Enter') {
      const vis = visibleValues();
      if (vis.length) {
        const v = vis.includes(current) ? current : vis[0];
        const changed = v !== current;
        setCurrent(v);
        close();
        if (changed) o.onSelect(v);
      }
    }
  };
  menu.appendChild(search);

  // Rows live in their own host so filtering toggles row visibility without
  // touching the search box or redrawing thumbs.
  const rowsHost = document.createElement('div');
  menu.appendChild(rowsHost);

  const rowLabel = new Map<string, string>(); // lowercased label, for filtering
  const sectionHeaders: { el: HTMLElement; values: string[] }[] = [];

  const matches = (v: string): boolean =>
    !filter || (rowLabel.get(v) ?? '').includes(filter) || v.includes(filter);

  const visibleValues = (): string[] => {
    const out: string[] = [];
    for (const v of rowEls.keys()) if (matches(v)) out.push(v);
    return out;
  };

  const applyFilter = (): void => {
    for (const [v, row] of rowEls) row.style.display = matches(v) ? '' : 'none';
    for (const sh of sectionHeaders) sh.el.style.display = sh.values.some(matches) ? '' : 'none';
  };

  const highlight = () => {
    for (const [v, row] of rowEls) row.style.background = v === current ? '#243447' : '';
  };

  const buildRows = () => {
    rowsHost.innerHTML = '';
    rowEls.clear();
    rowThumbs.clear();
    rowLabel.clear();
    sectionHeaders.length = 0;
    for (const section of o.sections) {
    if (section.label) {
      const head = document.createElement('div');
      head.textContent = section.label;
      head.style.cssText =
        'padding:4px 6px 2px;color:#9af;font-size:10px;letter-spacing:1px;border-top:1px solid #333;';
      rowsHost.appendChild(head);
      sectionHeaders.push({ el: head, values: section.values });
    }
    for (const v of section.values) {
      const labelText = o.labelFor(v);
      rowLabel.set(v, labelText.toLowerCase());
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 6px;cursor:pointer;';
      row.onmouseenter = () => { if (v !== current) row.style.background = '#23232f'; };
      row.onmouseleave = () => { if (v !== current) row.style.background = ''; };
      const thumb = mkThumb();
      const label = document.createElement('span');
      label.textContent = labelText;
      label.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd;';
      row.append(thumb, label);
      row.onclick = () => {
        const changed = v !== current;
        setCurrent(v);
        close();
        if (changed) o.onSelect(v);
      };
      rowsHost.appendChild(row);
      rowEls.set(v, row);
      rowThumbs.set(v, thumb);
      o.drawThumb(thumb, v);
    }
    }
    built = true;
    highlight();
    applyFilter();
  };

  const setCurrent = (v: string) => {
    current = v;
    triggerLabel.textContent = o.labelFor(v);
    o.drawThumb(triggerThumb, v);
    if (built) highlight();
  };

  const onDocDown = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) close();
  };
  const open = () => {
    if (!built) buildRows();
    // Start each open with a cleared filter + the full list, focused for typing.
    filter = '';
    search.value = '';
    applyFilter();
    menu.style.display = 'block';
    isOpen = true;
    rowEls.get(current)?.scrollIntoView({ block: 'nearest' });
    setTimeout(() => search.focus(), 0);
    document.addEventListener('mousedown', onDocDown, true);
  };
  function close(): void {
    menu.style.display = 'none';
    isOpen = false;
    document.removeEventListener('mousedown', onDocDown, true);
  }
  trigger.onclick = (e) => {
    e.preventDefault();
    if (isOpen) close();
    else open();
  };

  setCurrent(current);

  return {
    el: root,
    setValue: (v) => setCurrent(v),
    redraw: () => {
      o.drawThumb(triggerThumb, current);
      const t = rowThumbs.get(current);
      if (t) o.drawThumb(t, current);
    },
    refresh: () => {
      setCurrent(current);
      if (built) buildRows();
    },
  };
}

/**
 * drawThumb for a sprite group: its south-facing idle frame, scaled to fit.
 * The generic preview used by every group picker (character, enemy, vehicle,
 * placement). `v` is the group id as a string.
 */
export function drawSpriteGroupThumb(canvas: HTMLCanvasElement, v: string): void {
  const id = Number(v);
  const paint = () => {
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const meta = getSpriteGroupMeta(id);
    if (!meta) return;
    const s = Math.max(1, Math.floor(Math.min(canvas.width / (meta.width + 2), canvas.height / (meta.height + 2))));
    ctx.save();
    ctx.scale(s, s);
    // drawSprite anchors center-x / feet-y; center the frame vertically.
    drawSprite(ctx, id, Direction.S, 0, canvas.width / s / 2, canvas.height / s / 2 + meta.height / 2);
    ctx.restore();
  };
  // Metadata is loaded for ALL groups up front, but the sheet IMAGE drawSprite
  // needs is only present once loadSpriteGroup has run for this group. So always
  // ensure it's loaded (cached groups resolve instantly), then paint. A sync
  // paint first avoids a blank frame for an already-loaded group.
  paint();
  void loadSpriteGroup(id).then(paint).catch(() => {});
}
