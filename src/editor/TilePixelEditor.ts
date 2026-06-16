// Tile Pixel Editor — a focused RGBA pixel painter used by the Room Builder to
// turn a copied stamp into author-drawn art (Path B). Renders a starting bitmap
// (the stamp, flattened from its tiles) onto a zoomed canvas and lets you paint
// pixels: pencil, flood-fill, eyedropper, eraser (transparent). On Save it hands
// back the edited RGBA, which the caller slices into 8x8 custom tiles.
//
// Dev-only editor UI (no DOM frameworks). One instance at a time.

export interface TileEditorOptions {
  width: number; // bitmap width in pixels (multiple of 8)
  height: number; // bitmap height in pixels (multiple of 8)
  initial: Uint8ClampedArray; // width*height*4 RGBA, the starting image
  title?: string;
  onSave: (rgba: Uint8ClampedArray) => void;
  onCancel?: () => void;
}

type Tool = 'pencil' | 'fill' | 'pick' | 'erase';

let activeRoot: HTMLDivElement | null = null;

export function openTilePixelEditor(o: TileEditorOptions): void {
  closeActive();
  const { width: W, height: H } = o;
  const buf = new Uint8ClampedArray(o.initial); // working copy

  // pick a zoom that fits ~70% of the viewport
  const fit = Math.max(
    2,
    Math.floor(Math.min((window.innerWidth * 0.7) / W, (window.innerHeight * 0.7) / H))
  );
  let scale = Math.min(24, fit);

  let tool: Tool = 'pencil';
  let color = { r: 255, g: 255, b: 255, a: 255 };
  let showGrid = true;

  // ── DOM scaffold ────────────────────────────────────────────────────────
  const root = document.createElement('div');
  activeRoot = root;
  root.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:10px;background:rgba(6,8,12,0.92);font-family:monospace;color:#cfe;';

  const head = document.createElement('div');
  head.textContent = o.title ?? 'Edit pixels';
  head.style.cssText = 'font-size:14px;color:#9fd2ef;';
  root.appendChild(head);

  const toolbar = document.createElement('div');
  toolbar.style.cssText =
    'display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;max-width:90vw;';
  root.appendChild(toolbar);

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  canvas.style.cssText =
    'image-rendering:pixelated;background:#222;border:1px solid #3a4655;cursor:crosshair;max-width:88vw;max-height:70vh;';
  root.appendChild(canvas);
  const cx = canvas.getContext('2d')!;

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:10px;';
  root.appendChild(footer);

  document.body.appendChild(root);

  // ── rendering ─────────────────────────────────────────────────────────────
  const redraw = () => {
    canvas.width = W * scale;
    canvas.height = H * scale;
    cx.imageSmoothingEnabled = false;
    // checkerboard for transparency
    const cell = Math.max(4, Math.floor(scale / 2));
    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        cx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? '#202833' : '#161c24';
        cx.fillRect(x, y, cell, cell);
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = buf[i + 3];
        if (a === 0) continue;
        cx.fillStyle = `rgba(${buf[i]},${buf[i + 1]},${buf[i + 2]},${a / 255})`;
        cx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    if (showGrid && scale >= 6) {
      cx.strokeStyle = 'rgba(255,255,255,0.08)';
      cx.lineWidth = 1;
      for (let x = 0; x <= W; x++) {
        cx.beginPath();
        cx.moveTo(x * scale + 0.5, 0);
        cx.lineTo(x * scale + 0.5, H * scale);
        cx.stroke();
      }
      for (let y = 0; y <= H; y++) {
        cx.beginPath();
        cx.moveTo(0, y * scale + 0.5);
        cx.lineTo(W * scale, y * scale + 0.5);
        cx.stroke();
      }
      // bolder lines on the 8x8 tile boundaries
      cx.strokeStyle = 'rgba(120,200,255,0.35)';
      for (let x = 0; x <= W; x += 8) {
        cx.beginPath();
        cx.moveTo(x * scale + 0.5, 0);
        cx.lineTo(x * scale + 0.5, H * scale);
        cx.stroke();
      }
      for (let y = 0; y <= H; y += 8) {
        cx.beginPath();
        cx.moveTo(0, y * scale + 0.5);
        cx.lineTo(W * scale, y * scale + 0.5);
        cx.stroke();
      }
    }
  };

  // ── pixel ops ──────────────────────────────────────────────────────────────
  const setPx = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };
  const getPx = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]] as const;
  };

  const floodFill = (sx: number, sy: number) => {
    const [tr, tg, tb, ta] = getPx(sx, sy);
    if (tr === color.r && tg === color.g && tb === color.b && ta === color.a) return;
    const stack: [number, number][] = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const [r, g, b, a] = getPx(x, y);
      if (r !== tr || g !== tg || b !== tb || a !== ta) continue;
      setPx(x, y, color.r, color.g, color.b, color.a);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  };

  const applyAt = (px: number, py: number) => {
    const x = Math.floor(px / scale);
    const y = Math.floor(py / scale);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (tool === 'pencil') setPx(x, y, color.r, color.g, color.b, 255);
    else if (tool === 'erase') setPx(x, y, 0, 0, 0, 0);
    else if (tool === 'pick') {
      const [r, g, b, a] = getPx(x, y);
      if (a > 0) {
        color = { r, g, b, a: 255 };
        colorInput.value = rgbToHex(r, g, b);
        swatch.style.background = colorInput.value;
      }
    } else if (tool === 'fill') floodFill(x, y);
    redraw();
  };

  // ── input ───────────────────────────────────────────────────────────────
  let painting = false;
  canvas.addEventListener('mousedown', (e) => {
    painting = true;
    applyAt(e.offsetX, e.offsetY);
  });
  canvas.addEventListener('mousemove', (e) => {
    if (painting && (tool === 'pencil' || tool === 'erase')) applyAt(e.offsetX, e.offsetY);
  });
  window.addEventListener('mouseup', () => (painting = false));

  // ── toolbar widgets ─────────────────────────────────────────────────────
  const toolBtns: Record<Tool, HTMLButtonElement> = {} as Record<Tool, HTMLButtonElement>;
  const mkTool = (t: Tool, label: string, hint: string) => {
    const b = mkButton(label, () => {
      tool = t;
      for (const k of Object.keys(toolBtns) as Tool[]) toolBtns[k].style.outline = '';
      b.style.outline = '2px solid #4db6e8';
    });
    b.title = hint;
    toolBtns[t] = b;
    toolbar.appendChild(b);
  };
  mkTool('pencil', '✏ Pencil', 'Paint pixels (P)');
  mkTool('fill', '🪣 Fill', 'Flood fill (F)');
  mkTool('pick', '💧 Pick', 'Eyedropper (I)');
  mkTool('erase', '⌫ Erase', 'Transparent (E)');
  toolBtns.pencil.style.outline = '2px solid #4db6e8';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#ffffff';
  colorInput.style.cssText =
    'width:34px;height:26px;padding:0;border:1px solid #3a4655;background:#0a0e14;cursor:pointer;';
  colorInput.oninput = () => {
    const [r, g, b] = hexToRgb(colorInput.value);
    color = { r, g, b, a: 255 };
    swatch.style.background = colorInput.value;
    tool = tool === 'erase' ? 'pencil' : tool;
    toolBtns.pencil.style.outline = tool === 'pencil' ? '2px solid #4db6e8' : '';
  };
  toolbar.appendChild(colorInput);
  const swatch = document.createElement('div');
  swatch.style.cssText = 'width:22px;height:22px;border:1px solid #3a4655;background:#fff;';
  toolbar.appendChild(swatch);

  // palette swatches: unique colors present in the source art (most useful)
  const palWrap = document.createElement('div');
  palWrap.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;max-width:280px;';
  for (const hex of uniqueColors(o.initial, 24)) {
    const sw = document.createElement('div');
    sw.style.cssText = `width:16px;height:16px;border:1px solid #2a3340;cursor:pointer;background:${hex};`;
    sw.title = hex;
    sw.onclick = () => {
      const [r, g, b] = hexToRgb(hex);
      color = { r, g, b, a: 255 };
      colorInput.value = hex;
      swatch.style.background = hex;
      if (tool === 'erase') tool = 'pencil';
    };
    palWrap.appendChild(sw);
  }
  toolbar.appendChild(palWrap);

  mkButton('Grid', () => {
    showGrid = !showGrid;
    redraw();
  }).style.marginLeft = '4px';
  mkButton('+', () => {
    scale = Math.min(40, scale + 2);
    redraw();
  });
  mkButton('−', () => {
    scale = Math.max(2, scale - 2);
    redraw();
  });
  for (const b of toolbar.querySelectorAll('button')) toolbar.appendChild(b); // keep order tidy

  // ── footer ────────────────────────────────────────────────────────────────
  const save = mkButton('✔ Save as new stamp', () => {
    o.onSave(buf);
    closeActive();
  });
  save.style.cssText += ';background:#1f7a3f;border-color:#2ea05a;';
  const cancel = mkButton('✕ Cancel', () => {
    o.onCancel?.();
    closeActive();
  });
  footer.append(save, cancel);

  // keyboard shortcuts
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      o.onCancel?.();
      closeActive();
    } else if (e.key === 'p') toolBtns.pencil.click();
    else if (e.key === 'f') toolBtns.fill.click();
    else if (e.key === 'i') toolBtns.pick.click();
    else if (e.key === 'e') toolBtns.erase.click();
  };
  window.addEventListener('keydown', onKey);
  root.dataset.cleanup = '1';
  (root as unknown as { _cleanup: () => void })._cleanup = () =>
    window.removeEventListener('keydown', onKey);

  redraw();
}

function closeActive(): void {
  if (!activeRoot) return;
  (activeRoot as unknown as { _cleanup?: () => void })._cleanup?.();
  activeRoot.remove();
  activeRoot = null;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function mkButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'font-family:monospace;font-size:12px;padding:5px 8px;border-radius:4px;cursor:pointer;' +
    'background:#1c2530;color:#cfe;border:1px solid #34404d;';
  b.onclick = onClick;
  return b;
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function uniqueColors(rgba: Uint8ClampedArray, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < rgba.length && out.length < max; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const hex = rgbToHex(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }
  return out;
}
