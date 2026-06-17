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
import { createStatRadar, Alloc, STAT_KEYS, STAT_MIN } from './StatRadar';
import { deriveCombatStats } from './deriveCombatStats';
import { createDerivedAttrs } from './DerivedStatsPanel';
import { Recolorer } from './Recolor';
import {
  loadSpriteCatalog,
  pickRandomSprites,
  loadSpriteImage,
  drawSouthFrame,
} from './spritePreview';
import { ensureEbFont, ebText, ebButton, ebWindow, injectEbChrome } from '../EbText';
import { playCharSelectMusic } from '../MusicManager';

const NAME_MAX = 24;
const FAV_MAX = 24; // favorite thing / favorite food (EarthBound naming prompts)
const SPRITE_CHOICES = 3;

export async function mountCreateFlow(
  container: HTMLElement,
  opts: { onCancel: () => void; onCreated: (c: CharacterSummary) => void }
): Promise<void> {
  injectStyles();
  injectEbChrome();
  // Same naming-screen song as character select ("Your Name, Please"). Called
  // before any await so it stays inside the click gesture that opened this screen
  // (the AudioContext can only resume from a gesture); idempotent if it's already
  // playing — e.g. you came straight here without leaving the select music.
  playCharSelectMusic();
  await Promise.all([loadSpriteCatalog(), ensureEbFont()]);

  let chosenSprite: number | null = null;
  let recolorer: Recolorer | null = null;
  let alloc: Alloc | null = null;
  let pointsLeft = 10;

  const outer = el('div', 'eb-cc');
  container.innerHTML = '';
  container.appendChild(outer);

  // EarthBound-style scrolling green/blue checkerboard, behind everything. Fixed
  // + z-index:-1 so it fills the viewport under the panes and scrolls while the
  // content scrolls over it. Mounted/unmounted with this screen only, so the
  // other Start Screen tabs keep the plain dark backdrop. (We don't have the ROM
  // background — this is a procedural recreation; tune colors in injectStyles.)
  outer.appendChild(el('div', 'eb-cc-bg'));

  // Title banner, then a few separate EarthBound menu windows ("panes") laid out
  // across the checkerboard (they wrap to a column on narrow screens). Actions
  // get their own pane at the bottom.
  outer.appendChild(heading('CREATE CHARACTER'));
  const panes = el('div', 'eb-cc-panes');
  outer.appendChild(panes);

  // --- LEFT COLUMN: one pane stacking Choose a Character → Tweak Colors →
  // Name Your Character. Colors reveal once a sprite is picked. ---
  const idPane = ebWindow('eb-cc-pane');
  panes.appendChild(idPane);

  // 1) Choose a Character (top).
  idPane.appendChild(sectionTitle('Choose a Character'));
  const tiles = el('div', 'eb-cc-sprites');
  idPane.appendChild(tiles);
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

  // 2) Tweak Colors — in the same pane, just under the character choices.
  // Hidden until a sprite is chosen (buildRecolorUI fills recolorBox).
  const colorPane = el('div', 'eb-cc-colorsec');
  colorPane.style.display = 'none';
  idPane.appendChild(colorPane);
  const recolorBox = el('div', 'eb-cc-recolor');
  colorPane.appendChild(recolorBox);
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = 64;
  previewCanvas.height = 72;
  previewCanvas.className = 'eb-cc-preview';

  // 3) Name Your Character (bottom): name + favorite thing + favorite food.
  idPane.appendChild(sectionTitle('Name Your Character'));
  const name = document.createElement('input');
  name.className = 'eb-cc-name';
  name.placeholder = 'Character name';
  name.maxLength = NAME_MAX;
  name.spellcheck = false;
  name.addEventListener('input', refreshCreate);
  idPane.appendChild(labeled('NAME', name));
  const favThing = document.createElement('input');
  favThing.className = 'eb-cc-name';
  favThing.placeholder = 'e.g. baseball';
  favThing.maxLength = FAV_MAX;
  favThing.spellcheck = false;
  favThing.addEventListener('input', refreshCreate);
  idPane.appendChild(labeled('FAVORITE THING', favThing));
  const favFood = document.createElement('input');
  favFood.className = 'eb-cc-name';
  favFood.placeholder = 'e.g. steak';
  favFood.maxLength = FAV_MAX;
  favFood.spellcheck = false;
  favFood.addEventListener('input', refreshCreate);
  idPane.appendChild(labeled('FAVORITE FOOD', favFood));

  // --- Pane: stats. The pentagon PLUS the SAME derived-stat preview the in-game
  // level-up modal shows (createDerivedAttrs), so you see what the pentagon does
  // to HP / Offense / Defense / … live as you allocate. ---
  const statPane = ebWindow('eb-cc-pane');
  panes.appendChild(statPane);
  statPane.appendChild(sectionTitle('ALLOCATE STATS'));
  // Declared BEFORE the radar: createStatRadar fires onChange during its initial
  // draw, and the callbacks write to these.
  const pointsReadout = el('div', 'eb-cc-points');
  const setPoints = (left: number): void => {
    pointsReadout.innerHTML = '';
    pointsReadout.appendChild(
      left > 0
        ? ebText(`${left} POINT${left === 1 ? '' : 'S'} LEFT`, 1, '#ffb84d')
        : ebText('ALL POINTS SPENT', 1, '#6fdc8c')
    );
  };
  // The "+N" is measured against the all-minimum build, so each row shows both
  // the level-1 derived value AND how much the allocation has earned.
  const baseDerived = deriveCombatStats(
    STAT_KEYS.reduce((o, k) => ((o[k] = STAT_MIN), o), {} as Alloc)
  );
  const attrs = createDerivedAttrs((dkey, d) => ({
    shown: d[dkey],
    delta: d[dkey] - baseDerived[dkey],
  }));
  const radar = createStatRadar((a, left) => {
    alloc = a;
    pointsLeft = left;
    setPoints(left);
    attrs.render(a);
    refreshCreate();
  });
  statPane.appendChild(radar.el);
  statPane.appendChild(pointsReadout);
  statPane.appendChild(sectionTitle('YOUR STATS'));
  statPane.appendChild(attrs.el);
  alloc = radar.getAlloc();
  pointsLeft = radar.pointsLeft();
  attrs.render(alloc);

  // --- Pane: actions ---
  const actions = ebWindow('eb-cc-actions');
  outer.appendChild(actions);
  const err = el('div', 'eb-ss-error');
  actions.appendChild(err);
  const create = ebButton('Create', () => void doCreate(), 2);
  create.style.justifyContent = 'center';
  actions.appendChild(create);
  const back = ebButton('< Back', () => opts.onCancel(), 2);
  back.style.justifyContent = 'center';
  actions.appendChild(back);

  setPoints(pointsLeft);
  refreshCreate();

  async function selectSprite(id: number, btn: HTMLButtonElement): Promise<void> {
    chosenSprite = id;
    for (const t of tileEls) t.classList.toggle('selected', t === btn);
    const img = await loadSpriteImage(id);
    recolorer = new Recolorer(img);
    buildRecolorUI();
    colorPane.style.display = '';
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
    const ok =
      !!name.value.trim() &&
      !!favThing.value.trim() &&
      !!favFood.value.trim() &&
      chosenSprite != null &&
      pointsLeft === 0;
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
        favoriteThing: favThing.value.trim(),
        favoriteFood: favFood.value.trim(),
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
  .eb-cc { display: flex; flex-direction: column; align-items: center; gap: 14px; position: relative; }
  /* A few separate EB menu windows on the checkerboard. They flow in a row and
     wrap to a column on narrow screens; the hidden Colors pane just collapses. */
  .eb-cc-panes {
    display: flex; flex-wrap: wrap; gap: 16px;
    justify-content: center; align-items: flex-start; width: 100%;
  }
  /* Each pane is an EB window (.eb-win supplies the black fill + white border). */
  .eb-cc-pane {
    width: 340px; max-width: 100%; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 8px;
  }
  .eb-cc-actions {
    width: 340px; max-width: 100%; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 8px;
  }
  /* EarthBound "Choose a file" backdrop: a green/blue checkerboard that drifts
     diagonally. repeating-conic-gradient draws a 2x2 checker per tile (axis-aligned
     edges = crisp pixels); --sq is the square size, tile = 2*--sq. Tweak the two
     colors / speed here to taste. */
  .eb-cc-bg {
    --eb-checker-green: #38b038;
    --eb-checker-blue: #2a52d8;
    --sq: 44px;
    position: fixed; inset: 0; z-index: -1;
    background:
      repeating-conic-gradient(
        var(--eb-checker-blue) 0% 25%, var(--eb-checker-green) 0% 50%
      ) 0 0 / calc(var(--sq) * 2) calc(var(--sq) * 2);
    animation: eb-cc-bg-scroll 3.2s linear infinite;
  }
  @keyframes eb-cc-bg-scroll {
    to { background-position: calc(var(--sq) * 2) calc(var(--sq) * 2); }
  }
  @media (prefers-reduced-motion: reduce) { .eb-cc-bg { animation: none; } }
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
