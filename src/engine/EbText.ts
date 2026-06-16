/**
 * EarthBound DOM chrome — renders the game's real bitmap font (TextRenderer) into
 * the HTML overlay, plus EB-style windows/buttons. The Start Screen + character
 * creator use these so the UI matches EarthBound's look (rounded windows, the ▸
 * cursor, the actual EB font) instead of system fonts.
 *
 * There is no TTF — the font is a glyph sheet — so each text label is drawn to a
 * small <canvas> and embedded inline.
 */
import { loadFont, drawText, measureText, getLineHeight } from './TextRenderer';

const EB_FONT = 0; // regular EB dialogue font (font 1 is Mr. Saturn)

let ready: Promise<void> | null = null;
/** Load the EB font once; await before rendering EB text. */
export function ensureEbFont(): Promise<void> {
  if (!ready) ready = loadFont(EB_FONT);
  return ready;
}

/**
 * Render `text` to a pixel canvas in the EB font, tinted to `color`. Integer
 * `scale` keeps it crisp. Falls back to a monospace draw if the font hasn't
 * loaded yet (ensureEbFont resolves quickly).
 */
export function ebText(
  text: string,
  scale = 2,
  color = '#ffffff',
  fontId = EB_FONT,
  tracking = 1
): HTMLCanvasElement {
  const w = Math.max(1, measureText(text, fontId, tracking));
  const h = getLineHeight(fontId);
  const cv = document.createElement('canvas');
  cv.width = w * scale;
  cv.height = h * scale;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.scale(scale, scale);
  drawText(ctx, text, 0, 0, fontId, tracking);
  ctx.restore();
  // Tint the glyphs to `color` (works whether the sheet's glyphs are white or
  // black — source-in keeps the glyph shape, replaces the color).
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalCompositeOperation = 'source-over';
  cv.style.imageRendering = 'pixelated';
  cv.style.display = 'block';
  cv.style.width = `${w * scale}px`;
  cv.style.height = `${h * scale}px`;
  return cv;
}

/** A centered EB-font label (wraps the canvas so flexbox centers it). */
export function ebLabel(text: string, scale = 2, color = '#ffffff'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'eb-label';
  wrap.appendChild(ebText(text, scale, color));
  return wrap;
}

/** An EarthBound menu-item button: ▸ cursor on hover/focus + EB-font label. */
export function ebButton(label: string, onClick: () => void, scale = 2): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'eb-btn2';
  const cursor = document.createElement('span');
  cursor.className = 'eb-cursor';
  b.appendChild(cursor);
  b.appendChild(ebText(label, scale));
  b.addEventListener('click', () => void onClick());
  return b;
}

/** An EarthBound window frame (black fill, rounded white border). */
export function ebWindow(extraClass = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.className = `eb-win ${extraClass}`.trim();
  return d;
}

let injected = false;
/** Inject the shared EB chrome CSS once. */
export function injectEbChrome(): void {
  if (injected) return;
  injected = true;
  const css = `
  .eb-label { display: flex; justify-content: center; }
  .eb-label canvas { image-rendering: pixelated; }
  /* EarthBound window: black fill, rounded white border, black outer edge. */
  .eb-win {
    background: #000;
    border: 2px solid #fff;
    border-radius: 8px;
    box-shadow: 0 0 0 2px #000;
    padding: 12px 14px;
  }
  /* EB menu-item button: hidden ▸ cursor that appears (yellow) on hover/focus. */
  .eb-btn2 {
    display: flex; align-items: center; gap: 7px;
    width: 100%; background: transparent; border: none; cursor: pointer;
    padding: 7px 10px; border-radius: 6px;
  }
  .eb-btn2:hover, .eb-btn2:focus-visible { background: rgba(255,255,255,0.07); outline: none; }
  .eb-btn2 .eb-cursor {
    width: 0; height: 0; flex: none;
    border-top: 6px solid transparent; border-bottom: 6px solid transparent;
    border-left: 10px solid #ffd23f; opacity: 0; transition: opacity .04s;
  }
  .eb-btn2:hover .eb-cursor, .eb-btn2:focus-visible .eb-cursor { opacity: 1; }
  .eb-btn2:disabled { opacity: 0.4; cursor: default; }
  .eb-btn2:disabled .eb-cursor { opacity: 0 !important; }
  .eb-btn2 canvas { image-rendering: pixelated; }
  `;
  const style = document.createElement('style');
  style.id = 'eb-chrome-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
