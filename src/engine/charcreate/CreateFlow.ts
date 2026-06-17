/**
 * NEW CHARACTER flow (START_SCREEN.md phase 5). Mounts into the Start Screen
 * panel: name field → pick 1 of 3 random roster sprites → recolor 3 color groups
 * → allocate the 5 stats on the pentagon radar → Create. On success it calls
 * `onCreated(character)`; the host then spawns into the game (join-by-token).
 *
 * The allocation + recolored sheet are sent to POST /api/characters; the server
 * re-validates the alloc and owns the canonical save.
 */
import { CharacterSummary, createCharacter, ApiError } from '../Auth';
import { createStatRadar, Alloc } from './StatRadar';
import { Recolorer } from './Recolor';
import {
  loadSpriteCatalog,
  pickRandomSprites,
  loadSpriteImage,
  drawSouthFrame,
} from './spritePreview';
import { ensureEbFont, ebText, ebButton, injectEbChrome } from '../EbText';

const NAME_MAX = 24;
const SPRITE_CHOICES = 3;

export async function mountCreateFlow(
  container: HTMLElement,
  opts: { onCancel: () => void; onCreated: (c: CharacterSummary) => void }
): Promise<void> {
  injectStyles();
  injectEbChrome();
  await Promise.all([loadSpriteCatalog(), ensureEbFont()]);

  let chosenSprite: number | null = null;
  let recolorer: Recolorer | null = null;
  let alloc: Alloc | null = null;
  let pointsLeft = 10;

  const root = el('div', 'eb-cc');
  container.innerHTML = '';
  container.appendChild(root);

  root.appendChild(heading('CREATE CHARACTER'));

  // --- name ---
  const name = document.createElement('input');
  name.className = 'eb-cc-name';
  name.placeholder = 'Character name';
  name.maxLength = NAME_MAX;
  name.spellcheck = false;
  name.addEventListener('input', refreshCreate);
  root.appendChild(labeled('NAME', name));

  // --- sprite picker (3 random) ---
  root.appendChild(sectionTitle('Choose a Character'));
  const tiles = el('div', 'eb-cc-sprites');
  root.appendChild(tiles);
  const ids = pickRandomSprites(SPRITE_CHOICES);
  const tileEls: HTMLButtonElement[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const btn = document.createElement('button');
      btn.className = 'eb-cc-tile';
      const cv = document.createElement('canvas');
      cv.width = 48;
      cv.height = 56;
      btn.appendChild(cv);
      btn.addEventListener('click', () => void selectSprite(id, btn));
      tiles.appendChild(btn);
      tileEls.push(btn);
      const img = await loadSpriteImage(id);
      drawSouthFrame(cv.getContext('2d')!, img, id, cv.width, cv.height, 2);
    })
  );

  // --- recolor (revealed after a sprite is chosen) ---
  const recolorBox = el('div', 'eb-cc-recolor');
  recolorBox.style.display = 'none';
  root.appendChild(recolorBox);
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = 64;
  previewCanvas.height = 72;
  previewCanvas.className = 'eb-cc-preview';

  // --- stat radar ---
  root.appendChild(sectionTitle('ALLOCATE STATS'));
  // Declared BEFORE the radar: createStatRadar fires onChange synchronously
  // during construction, and the callback writes to pointsReadout.
  const pointsReadout = el('div', 'eb-cc-points');
  const setPoints = (left: number): void => {
    pointsReadout.innerHTML = '';
    pointsReadout.appendChild(
      left > 0
        ? ebText(`${left} POINT${left === 1 ? '' : 'S'} LEFT`, 1, '#ffb84d')
        : ebText('ALL POINTS SPENT', 1, '#6fdc8c')
    );
  };
  const radar = createStatRadar((a, left) => {
    alloc = a;
    pointsLeft = left;
    setPoints(left);
    refreshCreate();
  });
  root.appendChild(radar.el);
  root.appendChild(pointsReadout);
  alloc = radar.getAlloc();
  pointsLeft = radar.pointsLeft();

  // --- actions ---
  const err = el('div', 'eb-ss-error');
  root.appendChild(err);
  const create = ebButton('Create', () => void doCreate(), 2);
  create.style.justifyContent = 'center';
  root.appendChild(create);
  const back = ebButton('< Back', () => opts.onCancel(), 2);
  back.style.justifyContent = 'center';
  root.appendChild(back);

  setPoints(pointsLeft);
  refreshCreate();

  async function selectSprite(id: number, btn: HTMLButtonElement): Promise<void> {
    chosenSprite = id;
    for (const t of tileEls) t.classList.toggle('selected', t === btn);
    const img = await loadSpriteImage(id);
    recolorer = new Recolorer(img);
    buildRecolorUI();
    recolorBox.style.display = '';
    refreshCreate();
  }

  function buildRecolorUI(): void {
    recolorBox.innerHTML = '';
    recolorBox.appendChild(sectionTitle('TWEAK COLORS'));
    const row = el('div', 'eb-cc-recolor-row');
    row.appendChild(previewCanvas);
    const sliders = el('div', 'eb-cc-sliders');
    recolorer!.groups.forEach((_, i) => {
      const wrap = el('div', 'eb-cc-slider');
      const swatch = el('span', 'eb-cc-swatch');
      swatch.style.background = recolorer!.shiftedAnchor(i);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '359';
      range.value = '0';
      range.addEventListener('input', () => {
        recolorer!.setHue(i, Number(range.value));
        swatch.style.background = recolorer!.shiftedAnchor(i);
        drawPreview();
      });
      wrap.appendChild(swatch);
      wrap.appendChild(range);
      sliders.appendChild(wrap);
    });
    row.appendChild(sliders);
    recolorBox.appendChild(row);
    drawPreview();
  }

  function drawPreview(): void {
    if (!recolorer || chosenSprite == null) return;
    const ctx = previewCanvas.getContext('2d')!;
    drawSouthFrame(
      ctx,
      recolorer.getCanvas(),
      chosenSprite,
      previewCanvas.width,
      previewCanvas.height,
      3
    );
  }

  function refreshCreate(): void {
    const ok = !!name.value.trim() && chosenSprite != null && pointsLeft === 0;
    create.disabled = !ok;
  }

  async function doCreate(): Promise<void> {
    if (chosenSprite == null || !recolorer || !alloc) return;
    err.textContent = '';
    create.disabled = true; // (label is an EB-font canvas; don't overwrite it)
    try {
      const character = await createCharacter({
        name: name.value.trim(),
        spriteGroupId: chosenSprite,
        appearance: recolorer.toDataURL(),
        alloc,
      });
      opts.onCreated(character);
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : 'Could not create character.';
      create.disabled = false;
    }
  }
}

// ------------------------------- DOM helpers -------------------------------

function el(tag: string, cls: string): HTMLDivElement {
  const d = document.createElement(tag) as HTMLDivElement;
  d.className = cls;
  return d;
}
function heading(text: string): HTMLElement {
  const h = el('div', 'eb-cc-heading');
  h.appendChild(ebText(text, 3, '#f8e85a'));
  return h;
}
function sectionTitle(text: string): HTMLElement {
  const s = el('div', 'eb-cc-section');
  s.appendChild(ebText(text, 1, '#9fb0d0'));
  return s;
}
function labeled(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('div', 'eb-cc-field');
  wrap.appendChild(ebText(label, 1, '#9fb0d0'));
  wrap.appendChild(input);
  return wrap;
}

function injectStyles(): void {
  if (document.getElementById('eb-cc-styles')) return;
  const css = `
  .eb-cc { display: flex; flex-direction: column; gap: 8px; }
  .eb-cc-heading { display: flex; justify-content: center; margin-bottom: 2px; }
  .eb-cc-section { display: flex; justify-content: flex-start; margin-top: 8px; }
  .eb-cc-heading canvas, .eb-cc-section canvas, .eb-cc-field canvas, .eb-cc-points canvas { image-rendering: pixelated; }
  .eb-cc-field { display: flex; flex-direction: column; gap: 4px; }
  .eb-cc-name { font-family: 'Courier New', monospace; font-size: 15px; padding: 9px; background: #000; color: #fff; border: 2px solid #fff; border-radius: 5px; }
  .eb-cc-name:focus { outline: none; border-color: #f8e85a; }
  .eb-cc-sprites { display: flex; gap: 10px; justify-content: center; }
  /* EB window tiles for the 3 character choices. */
  .eb-cc-tile { background: #000; border: 2px solid #fff; box-shadow: 0 0 0 2px #000; border-radius: 7px; padding: 3px; cursor: pointer; line-height: 0; }
  .eb-cc-tile canvas { image-rendering: pixelated; }
  .eb-cc-tile:hover { border-color: #9fb0d0; }
  .eb-cc-tile.selected { border-color: #f8e85a; }
  .eb-cc-recolor-row { display: flex; gap: 12px; align-items: center; }
  .eb-cc-preview { image-rendering: pixelated; background: #000; border: 2px solid #fff; box-shadow: 0 0 0 2px #000; border-radius: 7px; }
  .eb-cc-sliders { display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .eb-cc-slider { display: flex; align-items: center; gap: 8px; }
  .eb-cc-slider input[type=range] { flex: 1; accent-color: #f8e85a; }
  .eb-cc-swatch { width: 18px; height: 18px; border-radius: 3px; border: 2px solid #fff; flex: none; }
  .eb-radar { display: block; max-width: 100%; height: auto; align-self: center; overflow: visible; }
  .eb-radar-ring { fill: none; stroke: #2a2a3e; stroke-width: 1.2; }
  .eb-radar-spoke { stroke: #2a2a3e; stroke-width: 1.2; }
  .eb-radar-web { fill: rgba(248,232,90,0.22); stroke: #f8e85a; stroke-width: 2.5; }
  .eb-radar-dot { fill: #f8e85a; stroke: #fff; stroke-width: 2; }
  .eb-radar-dot-spent {
    fill: #ffd23f; transform-box: fill-box; transform-origin: center;
    animation: eb-radar-dot-pulse 0.85s ease-in-out infinite;
  }
  @keyframes eb-radar-dot-pulse {
    0%, 100% { transform: scale(1);   filter: drop-shadow(0 0 1px #ffae3a); }
    50%      { transform: scale(1.55); filter: drop-shadow(0 0 4px #ffae3a); }
  }
  .eb-radar-label {
    fill: #e6edff; font: bold 15px 'Courier New', monospace; letter-spacing: 0.5px;
    paint-order: stroke; stroke: #0a0a12; stroke-width: 3.5px; stroke-linejoin: round;
  }
  .eb-radar-val {
    fill: #fff; font: bold 14px 'Courier New', monospace;
    paint-order: stroke; stroke: #0a0a12; stroke-width: 3.5px; stroke-linejoin: round;
  }
  .eb-cc-points { display: flex; justify-content: center; }
  `;
  const style = document.createElement('style');
  style.id = 'eb-cc-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
