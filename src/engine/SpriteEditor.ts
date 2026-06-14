import { loadJSON, primeJSONCache } from './AssetLoader';
import {
  drawSprite,
  getSpriteGroupMeta,
  loadSpriteGroup,
  getLiveSheet,
  getPristineSheet,
  getSourceSheet,
  refreshDiagSupport,
  SpriteOverrides,
} from './SpriteManager';
import { getSpriteName, setSpriteNameOverride, getNameOverrides } from './SpriteNames';
import { createSpritePicker, drawSpriteGroupThumb, SpritePicker } from './SpritePicker';
import {
  drawHeldItem,
  isItemBehind,
  nextHeldItem,
  getItemName,
  ITEM_W,
  ITEM_H,
  ITEM_PALETTE,
  HELD_ITEM_IDS,
  setItemOverride,
  renderItemArt,
  loadItemSprites,
  getItemSpriteData,
  setItemSpriteData,
  canvasToItemPixels,
  itemSpriteIds,
  loadCustomItems,
  customItemIds,
  addCustomItem,
  customItemsDoc,
} from './Items';
import { allItems, itemEquip } from './Shop';

// The item list is now the whole game catalog (shops.json) — unified with the
// Item Manager. Falls back to the legacy hand-authored ids if the catalog is
// absent (e.g. shops.json not extracted yet).
function itemListIds(): string[] {
  const ids = allItems().map((i) => i.id);
  return ids.length ? ids : [...HELD_ITEM_IDS];
}

// The item picker is split into tabs. Weapons/Items come from the shops catalog
// (a weapon is gear whose equip slot is 'weapon'); Custom holds the legacy seed
// items (bat/pan/yoyo) plus anything the admin makes with "+ New custom item".
type ItemTab = 'weapons' | 'items' | 'custom';
function idsForTab(tab: ItemTab): string[] {
  if (tab === 'custom') {
    const seen = new Set<string>();
    return [...HELD_ITEM_IDS, ...customItemIds()].filter((id) =>
      seen.has(id) ? false : seen.add(id)
    );
  }
  const isWeapon = (id: string) => itemEquip(id)?.slot === 'weapon';
  return allItems()
    .filter((i) => (tab === 'weapons' ? isWeapon(i.id) : !isWeapon(i.id)))
    .map((i) => i.id);
}
/** The tab a given item id belongs to (custom seeds + minted items win). */
function tabForItem(id: string): ItemTab {
  if (HELD_ITEM_IDS.includes(id) || customItemIds().includes(id)) return 'custom';
  return itemEquip(id)?.slot === 'weapon' ? 'weapons' : 'items';
}
import { setMuteButtonHidden } from './MuteButton';
import { Direction, Pose } from '../types';

// Cast sprite editor (admin): a pixel editor for any cast character's
// attack/hurt animation frames, plus their held-item art. Opens as a DOM
// overlay on top of the game canvas (the 256x224 game screen is too small for
// per-pixel work). Pick a character from the dropdown; the editor paints into
// that group's LIVE pose sheet (ROM walk/climb + PoseGen attack/hurt), so the
// world and the test pane update as you draw. Walk/climb rows are ROM and
// locked. Save writes only the attack/hurt diff vs the generated frames to
// public/overrides/sprites.json — no ROM-derived pixels ever land in the file.

const FRAME_W = 16;
const FRAME_H = 24;
const SHEET_COLS = 4;
// Sheet v3: walk rows 0-3, climb row 4 (ladder f0/f1, rope f0/f1), attack
// rows 5-8, hurt rows 9-12 — attack and hurt share the walk direction layout
// (8 dirs x 2 frames). Left/right are mirror-equal in EB, so the editor only
// lets you draw N/S/E/NE/SE and auto-fills W/NW/SW as horizontal flips.
const SHEET_ROWS = 13;
const SHEET_W = FRAME_W * SHEET_COLS;
const SHEET_H = FRAME_H * SHEET_ROWS;
const CLIMB_ROW = 4;
const ATTACK_ROW_START = 5;
const HURT_ROW_START = 9;

const DEFAULT_GROUP = 1; // Ness — the screen opens on him
const BAND_ROWS = SHEET_ROWS - ATTACK_ROW_START; // editable pose rows (attack + hurt)

// Drivable vehicle groups — listed in the dropdown so you can SEE them, but
// NOT editable: they're bigger, directional-only sheets with no attack/hurt
// band. Selecting one shows it in the preview + test pane (view-only). Mirrors
// the Traffic Editor's VEHICLE_SPRITES list.
const VEHICLE_GROUPS: { id: number; name: string }[] = [
  { id: 255, name: 'Car' },
  { id: 206, name: 'Taxi' },
  { id: 459, name: 'Truck' },
  { id: 207, name: 'Delivery Truck' },
  { id: 460, name: 'Moving Van' },
  { id: 208, name: 'Camper Van' },
  { id: 243, name: 'Tour Bus' },
  { id: 254, name: 'Bulldozer' },
];
function vehicleName(id: number): string | null {
  return VEHICLE_GROUPS.find((v) => v.id === id)?.name ?? null;
}

const ZOOM = 16; // edit canvas: 1 sprite pixel = 16 screen pixels
const STRIP_SCALE = 2; // frame-strip preview scale (13 rows, overlay scrolls)
const TEST_W = 192; // WASD test pane, logical pixels
const TEST_H = 144;
const TEST_SCALE = 2;

// FRAMES strip layout: two 2-frame sets per display row, each with a label
// gutter to its LEFT. Only canonical directions are shown (see DISPLAY_ROWS);
// STRIP_H is derived from the display row count below.
const STRIP_FRAME_W = FRAME_W * STRIP_SCALE;
const STRIP_FRAME_H = FRAME_H * STRIP_SCALE;
const STRIP_SET_W = 2 * STRIP_FRAME_W; // a 2-frame set
const STRIP_GUTTER = 54; // label column width (fits "hurt NE")
const STRIP_W = 2 * (STRIP_GUTTER + STRIP_SET_W);

// Light checkerboard tones for the sprite surfaces (strip + edit canvas). A
// dark field swallowed the sprites' dark outlines; light keeps them visible
// while still reading as transparent (and white highlights survive too).
const CHECKER_A = '#d8d8e0';
const CHECKER_B = '#bcbcc8';

const UNDO_LIMIT = 64;

type Tool = 'pencil' | 'eraser' | 'eyedrop';
// The editor edits either the 16x24 character sheet or a 16x16 held-item buffer.
type EditMode = 'char' | 'item';

// ---------------------------------------------------------------------------
// Left/right mirroring. EB's west-facing frames are exact horizontal flips of
// the east-facing ones (verified pixel-for-pixel on the Ness sheet). The editor
// only EDITS — and only SHOWS — the canonical directions (N/S/E/NE/SE); each
// paint auto-fills the W/NW/SW partner cell as a flip. N/S are unique
// (front/back, not mirrorable). The full 8-direction result is visible in the
// live test pane. Applies to every direction-based block: walk, attack, hurt.
// ---------------------------------------------------------------------------

// Each direction's frame-0 cell within a block (frame 1 is col + 1). Matches
// SpriteManager's DIRECTION_LAYOUT.
const DIR_BASE: Record<string, { row: number; col: number }> = {
  N: { row: 0, col: 0 },
  E: { row: 0, col: 2 },
  S: { row: 1, col: 0 },
  W: { row: 1, col: 2 },
  NE: { row: 2, col: 0 },
  SE: { row: 2, col: 2 },
  SW: { row: 3, col: 0 },
  NW: { row: 3, col: 2 },
};
// canonical (drawn) -> derived (auto-mirrored) direction.
const MIRROR: [string, string][] = [
  ['E', 'W'],
  ['NE', 'NW'],
  ['SE', 'SW'],
];
// Canonical (editable + shown) directions.
const CANON_DIRS = ['N', 'S', 'E', 'NE', 'SE'];

// Per-block layout: which sheet rows it occupies and the label prefix.
const BLOCKS = [
  { offset: 0, prefix: '' }, // walk, rows 0-3
  { offset: ATTACK_ROW_START, prefix: 'atk ' }, // rows 5-8
  { offset: HURT_ROW_START, prefix: 'hurt ' }, // rows 9-12
];

/** The block (row offset) a sheet row belongs to, or null for climb / off-grid. */
function blockOffsetForRow(row: number): number | null {
  for (const b of BLOCKS) {
    if (row >= b.offset && row <= b.offset + 3) return b.offset;
  }
  return null; // climb row (4) and anything else: not mirrored
}

/** The W/NW/SW cell that mirrors a canonical E/NE/SE cell, or null. */
function mirrorTargetFor(row: number, col: number): { row: number; col: number } | null {
  const off = blockOffsetForRow(row);
  if (off === null) return null;
  const local = row - off;
  for (const [canon, derived] of MIRROR) {
    const c = DIR_BASE[canon];
    if (local === c.row && (col === c.col || col === c.col + 1)) {
      const frame = col - c.col;
      const d = DIR_BASE[derived];
      return { row: d.row + off, col: d.col + frame };
    }
  }
  return null;
}

// What the FRAMES strip shows: only canonical 2-frame sets, packed two per
// display row and never mixing blocks (a block of 5 dirs takes 3 rows, the last
// holding a single set). Each entry points at its sheet cell (frame 0 col).
type DisplaySet = { label: string; row: number; col: number };
const DISPLAY_ROWS: DisplaySet[][] = (() => {
  const rows: DisplaySet[][] = [];
  const addBlock = (prefix: string, off: number) => {
    for (let i = 0; i < CANON_DIRS.length; i += 2) {
      rows.push(
        CANON_DIRS.slice(i, i + 2).map((d) => ({
          label: prefix + d,
          row: DIR_BASE[d].row + off,
          col: DIR_BASE[d].col,
        }))
      );
    }
  };
  addBlock('', 0);
  rows.push([
    { label: 'ladder', row: CLIMB_ROW, col: 0 },
    { label: 'rope', row: CLIMB_ROW, col: 2 },
  ]);
  addBlock('atk ', ATTACK_ROW_START);
  addBlock('hurt ', HURT_ROW_START);
  return rows;
})();
const STRIP_H = DISPLAY_ROWS.length * STRIP_FRAME_H;

let open = false;
let overlay: HTMLDivElement | null = null;
// The LIVE pose sheet of the character being edited (shared with the engine's
// sprite cache — edits show in the world immediately) + a pristine copy of its
// generated frames for diffing on save.
let sheet: HTMLCanvasElement | null = null;
let sheetCtx: CanvasRenderingContext2D | null = null;
let pristineSheet: HTMLCanvasElement | null = null;
let groupId = DEFAULT_GROUP;
let viewOnly = false; // true while previewing a non-editable group (vehicles)
let roster: number[] = [];
let overridesDoc: SpriteOverrides = { version: 1, groups: {} };
let palette: [number, number, number][] = [];

let tool: Tool = 'pencil';
let colorIndex = 1;

// --- Item-editing mode ---
let editMode: EditMode = 'char';
let itemEditId: string = HELD_ITEM_IDS[0] ?? '';
let itemCanvas: HTMLCanvasElement | null = null; // 16x16 edit buffer
let itemCtx: CanvasRenderingContext2D | null = null;
let itemUndo: ImageData[] = [];
// ITEM_PALETTE parsed to RGB for the eyedropper's nearest-color match.
const itemPaletteRGB: [number, number, number][] = ITEM_PALETTE.map(parseHexColor);
let selRow = 1; // start on the south-facing frame — the classic editing view
let selCol = 0;
let painting = false;
let strokeChanged = false;
let undoStack: ImageData[] = [];
let dirty = true;
// One copied frame (16x24 pixels), pasted into any selected cell. Survives
// reselection so you can author one direction and copy it across the others.
let frameClipboard: ImageData | null = null;

let editCanvas: HTMLCanvasElement;
let stripCanvas: HTMLCanvasElement;
let testCanvas: HTMLCanvasElement;
let itemNote: HTMLDivElement | null = null;
let copyNote: HTMLDivElement | null = null;
const toolButtons = new Map<Tool, HTMLButtonElement>();
let swatchEls: HTMLDivElement[] = [];
let paletteGrid: HTMLDivElement | null = null;
const modeButtons = new Map<EditMode, HTMLButtonElement>();
// Custom sprite-preview dropdowns: the trigger AND every option row render the
// real sprite (a native <option> can't). See createSpritePicker.
let charPicker: SpritePicker | null = null;
let itemPicker: SpritePicker | null = null;
let itemRow: HTMLDivElement | null = null; // the whole item UI (tabs + picker + new)
let itemPickerHost: HTMLDivElement | null = null; // the picker is rebuilt in here per tab
let itemTab: ItemTab = 'weapons';
let charNote: HTMLDivElement | null = null;
let nameInput: HTMLInputElement | null = null;
let rafId = 0;

// --- WASD walker state for the test pane ---
const heldKeys = new Set<string>();
let walkerX = TEST_W / 2;
let walkerY = TEST_H / 2 + 12;
let walkerDir = Direction.S;
let walkerFrame = 0;
let walkerTimer = 0;
let walkerPose: Pose = 'walk';
let walkerPoseTimer = 0;
let walkerItem: string | null = null;

export interface SpriteEditorCallbacks {
  /** Closed the editor (Esc) — return to character select. */
  onCancel?: () => void;
  /** Open straight into Item mode editing this catalog item (Item Manager handoff). */
  focusItem?: string;
}

let editorCallbacks: SpriteEditorCallbacks = {};

export function isSpriteEditorOpen(): boolean {
  return open;
}

export async function openSpriteEditor(callbacks: SpriteEditorCallbacks = {}): Promise<void> {
  if (open) return;
  open = true;
  editorCallbacks = callbacks;
  setMuteButtonHidden(true); // this overlay is its own screen — hide game chrome

  await loadRoster();
  await loadOverridesDoc();
  await loadSavedItems(); // restore saved item edits before seeding the buffer
  if (callbacks.focusItem) itemEditId = callbacks.focusItem; // Item Manager handoff
  // Make sure itemEditId is a real, selectable item across the three tabs (the
  // module default is a legacy seed id). If it isn't, fall back to the first
  // weapon/item/custom available. Then open on the tab that holds it.
  const allTabIds = new Set([
    ...idsForTab('weapons'),
    ...idsForTab('items'),
    ...idsForTab('custom'),
  ]);
  if (!itemEditId || !allTabIds.has(itemEditId)) {
    itemEditId = idsForTab('weapons')[0] ?? idsForTab('items')[0] ?? idsForTab('custom')[0] ?? '';
  }
  itemTab = itemEditId ? tabForItem(itemEditId) : 'weapons';
  buildItemBuffer();

  buildDom();
  await loadGroupIntoEditor(DEFAULT_GROUP);
  // Item Manager handoff: jump straight into Item mode on the chosen item.
  if (callbacks.focusItem) {
    setEditMode('item');
    loadItemIntoBuffer(callbacks.focusItem);
    itemPicker?.setValue(callbacks.focusItem);
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mouseup', onGlobalMouseUp);
  dirty = true;
  rafId = requestAnimationFrame(tick);
}

export function closeSpriteEditor(): void {
  if (!open) return;
  open = false;
  setMuteButtonHidden(false); // back to the game — restore the mute button
  cancelAnimationFrame(rafId);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('mouseup', onGlobalMouseUp);
  heldKeys.clear();
  overlay?.remove();
  overlay = null;
  toolButtons.clear();
  modeButtons.clear();
  swatchEls = [];
  paletteGrid = null;
  itemPicker = null;
  itemRow = null;
  itemPickerHost = null;
  charPicker = null;
  charNote = null;
  nameInput = null;
  copyNote = null;
  frameClipboard = null;
  sheet = null;
  sheetCtx = null;
  pristineSheet = null;
  editMode = 'char';
}

// ---------------------------------------------------------------------------
// Item edit buffer & persistence
// ---------------------------------------------------------------------------

/** Create the 16x16 item edit canvas and seed it with the first item's art. */
function buildItemBuffer(): void {
  if (!itemCanvas) {
    itemCanvas = document.createElement('canvas');
    itemCanvas.width = ITEM_W;
    itemCanvas.height = ITEM_H;
    itemCtx = itemCanvas.getContext('2d', { willReadFrequently: true })!;
    itemCtx.imageSmoothingEnabled = false;
  }
  if (!itemEditId) itemEditId = itemListIds()[0] ?? '';
  // Seed the buffer with the current item's art, but DON'T touch walkerItem —
  // we start in character mode and the test pane should show no held item yet.
  if (itemEditId) {
    const art = renderItemArt(itemEditId);
    itemCtx!.clearRect(0, 0, ITEM_W, ITEM_H);
    if (art) itemCtx!.drawImage(art, 0, 0);
    itemUndo = [];
  }
}

/** Load the shared per-item art (overrides/item_sprites.json) so the editor and
 * the live game both start from the same authored gear. */
async function loadSavedItems(): Promise<void> {
  await loadItemSprites();
  await loadCustomItems();
}

/** Load an item's current art (override or base) into the edit buffer. */
function loadItemIntoBuffer(id: string): void {
  itemEditId = id;
  const art = renderItemArt(id);
  itemCtx!.clearRect(0, 0, ITEM_W, ITEM_H);
  if (art) itemCtx!.drawImage(art, 0, 0);
  itemUndo = [];
  walkerItem = id; // show it on the test-pane character immediately
  if (itemNote) itemNote.textContent = `Editing item: ${getItemName(id) ?? id}`;
  renderItemThumb();
}

/** Push the live item buffer as the runtime override + refresh the preview. */
function commitItemEdit(): void {
  setItemOverride(itemEditId, itemCanvas!);
  walkerItem = itemEditId;
  renderItemThumb();
}

// Persist the edited item to the SHARED store + overrides/item_sprites.json, so
// every client renders this gear (not just this browser). Keyed by catalog id.
function persistItem(): void {
  const pixels = canvasToItemPixels(itemCanvas!);
  const grip = getItemSpriteData(itemEditId)?.grip;
  setItemSpriteData(itemEditId, grip ? { pixels, grip } : { pixels });
  void postOverride('item_sprites.json', buildItemSpriteDoc()).catch(() => {
    if (itemNote) itemNote.textContent = 'Item save failed (dev save channel?)';
  });
}

/** The whole authored item-art map, for the overrides/item_sprites.json file. */
function buildItemSpriteDoc(): Record<
  string,
  { pixels: string[]; grip?: { x: number; y: number } }
> {
  const doc: Record<string, { pixels: string[]; grip?: { x: number; y: number } }> = {};
  for (const id of itemSpriteIds()) {
    const d = getItemSpriteData(id);
    if (d) doc[id] = d.grip ? { pixels: d.pixels, grip: d.grip } : { pixels: d.pixels };
  }
  return doc;
}

// --- item tabs + custom items --------------------------------------------------

/** Rebuild the item dropdown for the active tab, keeping the current selection
 *  if it's in this tab (else select the tab's first item). */
function rebuildItemPicker(): void {
  if (!itemPickerHost) return;
  itemPickerHost.innerHTML = '';
  const ids = idsForTab(itemTab);
  const initial = ids.includes(itemEditId) ? itemEditId : (ids[0] ?? '');
  itemPicker = createSpritePicker({
    sections: [{ values: ids }],
    initial,
    labelFor: (v) => `${v} ${getItemName(v) ?? ''}`.trim(),
    drawThumb: drawItemThumb,
    onSelect: (v) => {
      loadItemIntoBuffer(v);
      dirty = true;
    },
  });
  itemPickerHost.appendChild(itemPicker.el);
}

function highlightItemTabs(): void {
  if (!itemRow) return;
  for (const b of itemRow.querySelectorAll<HTMLButtonElement>('button[data-itab]')) {
    const on = b.dataset.itab === itemTab;
    b.style.color = on ? '#fff' : '#ddd';
    b.style.borderColor = on ? '#9af' : '#444';
  }
}

function selectItemTab(tab: ItemTab): void {
  itemTab = tab;
  const ids = idsForTab(tab);
  if (!ids.includes(itemEditId) && ids.length) loadItemIntoBuffer(ids[0]); // sets itemEditId
  rebuildItemPicker();
  highlightItemTabs();
  dirty = true;
}

function persistCustomItems(): void {
  void postOverride('custom_items.json', customItemsDoc()).catch(() => {
    if (itemNote) itemNote.textContent = 'Custom-item save failed (dev save channel?)';
  });
}

/** Mint a blank custom item, drop into the Custom tab, and open it for drawing. */
function createCustomItem(): void {
  const name = window.prompt('New custom item name:', 'Custom item');
  if (name === null) return; // cancelled
  const id = addCustomItem(name.trim() || 'Custom item');
  persistCustomItems(); // register it now so the id isn't orphaned
  itemTab = 'custom';
  loadItemIntoBuffer(id); // blank buffer (no art yet) + sets itemEditId
  rebuildItemPicker();
  highlightItemTabs();
  itemPicker?.setValue(id);
  if (itemNote) itemNote.textContent = `New item "${getItemName(id) ?? id}" — draw it, then Save`;
  dirty = true;
}

function sheetReady(): boolean {
  return !!sheet && !!sheetCtx && !!pristineSheet;
}

// ---------------------------------------------------------------------------
// Cast roster + per-character loading
// ---------------------------------------------------------------------------

/** Load the char-select roster (the 16x24 cast) for the character dropdown. */
async function loadRoster(): Promise<void> {
  if (roster.length) return;
  try {
    roster = await loadJSON<number[]>('/assets/sprites/characters.json');
  } catch {
    roster = [DEFAULT_GROUP];
  }
}

/** Load any saved attack/hurt overrides so edits start from the live state. */
async function loadOverridesDoc(): Promise<void> {
  try {
    overridesDoc = await loadJSON<SpriteOverrides>('/overrides/sprites.json');
    overridesDoc.groups ??= {};
  } catch {
    overridesDoc = { version: 1, groups: {} };
  }
}

async function loadGroupPalette(palIdx: number): Promise<void> {
  const palettes = await loadJSON<number[][][]>('/assets/sprites/palettes.json');
  const pal = palettes[palIdx] ?? palettes[5] ?? [];
  palette = pal.map((c) => [c[0], c[1], c[2]]);
}

/**
 * Point the editor at a cast character. Loads the group's live pose sheet
 * (ROM walk/climb + PoseGen attack/hurt + any saved overrides) plus a pristine
 * copy for diffing. The editor paints straight into the live sheet, so the
 * test pane and the running world both update as you draw.
 */
async function loadGroupIntoEditor(id: number): Promise<void> {
  await loadSpriteGroup(id);
  const meta = getSpriteGroupMeta(id);
  const live = getLiveSheet(id);
  if (!meta || !live || meta.width !== FRAME_W || meta.height !== FRAME_H) {
    // Non-cast sprite (vehicles): show it in the preview + test pane, but keep
    // the 16x24 paint pipeline off. sheet=null gates every editing path.
    viewOnly = true;
    groupId = id;
    sheet = null;
    sheetCtx = null;
    pristineSheet = null;
    undoStack = [];
    walkerPose = 'walk';
    walkerDir = Direction.S;
    walkerFrame = 0;
    walkerItem = null;
    charPicker?.setValue(String(id));
    if (nameInput) nameInput.value = getSpriteName(id) ?? '';
    const nm = getSpriteName(id) ?? vehicleName(id) ?? `#${id}`;
    if (charNote) {
      charNote.textContent = meta
        ? `View only — ${nm} (${meta.width}×${meta.height})`
        : `#${id} has no sprite metadata`;
    }
    renderCharThumb();
    dirty = true;
    return;
  }
  viewOnly = false;
  groupId = id;
  sheet = live;
  sheetCtx = live.getContext('2d', { willReadFrequently: true })!;
  pristineSheet = getPristineSheet(id);
  undoStack = [];
  await loadGroupPalette(meta.palette);
  // Land on the south-facing attack frame — the first editable cell.
  selRow = ATTACK_ROW_START + DIR_BASE.S.row;
  selCol = DIR_BASE.S.col;
  walkerPose = 'walk';
  walkerDir = Direction.S;
  charPicker?.setValue(String(id));
  if (nameInput) nameInput.value = getSpriteName(id) ?? '';
  updateCharNote();
  renderCharThumb();
  renderSwatches();
  dirty = true;
}

// The sprite-preview dropdown (createSpritePicker) and the generic sprite-group
// thumb (drawSpriteGroupThumb, formerly drawCharThumb) now live in
// ./SpritePicker so the editor tools can reuse them. drawItemThumb stays here
// because it renders the live item-edit buffer, which is editor-only state.

/** drawThumb for a held item: its art (live edit buffer for the active item). */
function drawItemThumb(canvas: HTMLCanvasElement, v: string): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const src: CanvasImageSource | null =
    v === itemEditId && itemCanvas ? itemCanvas : renderItemArt(v);
  if (!src) return;
  const s = Math.max(
    1,
    Math.floor(Math.min(canvas.width / (ITEM_W + 2), canvas.height / (ITEM_H + 2)))
  );
  const dw = ITEM_W * s;
  const dh = ITEM_H * s;
  ctx.drawImage(
    src,
    0,
    0,
    ITEM_W,
    ITEM_H,
    (canvas.width - dw) / 2,
    (canvas.height - dh) / 2,
    dw,
    dh
  );
}

// Thin shims so existing call sites keep working: point the picker at the
// current selection and redraw its sprite preview (trigger + open row).
function renderCharThumb(): void {
  charPicker?.setValue(String(groupId));
}
function renderItemThumb(): void {
  itemPicker?.setValue(itemEditId);
}

function updateCharNote(suffix = ''): void {
  if (!charNote) return;
  const star = overridesDoc.groups?.[String(groupId)] ? ' ★ edited' : '';
  charNote.textContent = `${getSpriteName(groupId) ?? `#${groupId}`}${star}${suffix}`;
}

/**
 * Every row is editable. Walk/climb frames used to be ROM-locked, but admins
 * need to author the directional frames many NPCs never got (4-direction
 * sheets missing their diagonals). Save still diffs vs the generated/ROM
 * pristine sheet, so only hand-painted pixels are ever stored.
 */
function editableRow(_row: number): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// Save: diff the WHOLE live sheet vs pristine -> overrides/sprites.json. Only
// hand-painted deltas are written (paint + erase PNGs); unedited ROM walk
// frames and the generated bands match pristine, so they never land in the
// file. `band:0` on the entry marks a full-sheet patch (legacy entries with no
// band are the old attack/hurt-only band, applied at row 5).
// ---------------------------------------------------------------------------

const BAND_Y = 0;
const BAND_H = SHEET_H;

function captureGroupDiff(): void {
  if (!sheetReady()) return;
  const w = SHEET_W;
  const liveD = sheetCtx!.getImageData(0, BAND_Y, w, BAND_H);
  const prisD = pristineSheet!.getContext('2d')!.getImageData(0, BAND_Y, w, BAND_H);

  const paint = document.createElement('canvas');
  const erase = document.createElement('canvas');
  paint.width = erase.width = w;
  paint.height = erase.height = BAND_H;
  const paintD = paint.getContext('2d')!.createImageData(w, BAND_H);
  const eraseD = erase.getContext('2d')!.createImageData(w, BAND_H);
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
      eraseD.data[i + 3] = 255; // pixel removed vs the generated frame
      eraseCount++;
    } else {
      paintD.data[i] = liveD.data[i];
      paintD.data[i + 1] = liveD.data[i + 1];
      paintD.data[i + 2] = liveD.data[i + 2];
      paintD.data[i + 3] = liveD.data[i + 3];
      paintCount++;
    }
  }
  const groups = (overridesDoc.groups ??= {});
  const key = String(groupId);
  if (paintCount === 0 && eraseCount === 0) {
    delete groups[key]; // back to the generated frames — drop the entry
    return;
  }
  paint.getContext('2d')!.putImageData(paintD, 0, 0);
  erase.getContext('2d')!.putImageData(eraseD, 0, 0);
  const entry: { paint?: string; erase?: string; band?: number } = { band: 0 };
  if (paintCount > 0) entry.paint = paint.toDataURL();
  if (eraseCount > 0) entry.erase = erase.toDataURL();
  groups[key] = entry;
}

/** Dev-only save-back channel (Vite middleware; absent in production builds). */
async function postOverride(name: string, data: unknown): Promise<void> {
  const res = await fetch('/__editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) throw new Error(`save ${name}: ${res.status}`);
  primeJSONCache(`/overrides/${name}`, data);
}

/**
 * Save the active surface. In Item mode this commits + persists the held-item
 * art (localStorage) and confirms on the item note. In Character mode it diffs
 * the attack/hurt bands vs pristine into overrides/sprites.json.
 */
// Transient save notification — a brief banner pinned to the top of the editor
// overlay (Ctrl+S has no shell toast of its own). Auto-fades; removed with the
// overlay on close. Green for success, red for failure.
let saveFlashTimer = 0;
function flashSaved(msg: string, isError = false): void {
  if (!overlay) return;
  let el = overlay.querySelector<HTMLDivElement>('[data-role=save-flash]');
  if (!el) {
    el = document.createElement('div');
    el.dataset.role = 'save-flash';
    el.style.cssText =
      'position:fixed;top:74px;left:50%;transform:translateX(-50%);z-index:99;' +
      'padding:6px 16px;border-radius:5px;font:bold 13px monospace;pointer-events:none;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.5);transition:opacity .3s;';
    overlay.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? '#3a1f1f' : '#1f3a26';
  el.style.color = isError ? '#f99' : '#9f9';
  el.style.border = `1px solid ${isError ? '#a44' : '#4a6'}`;
  el.style.opacity = '1';
  clearTimeout(saveFlashTimer);
  saveFlashTimer = window.setTimeout(() => {
    if (el) el.style.opacity = '0';
  }, 1400);
}

function saveCurrentGroup(): void {
  if (!open || painting) return;
  if (editMode === 'item') {
    commitItemEdit();
    persistItem();
    const label = `Item saved: ${getItemName(itemEditId) ?? itemEditId}`;
    if (itemNote) itemNote.textContent = label;
    flashSaved(`💾 ${label}`);
    return;
  }
  if (!sheetReady()) return;
  captureGroupDiff();
  void postOverride('sprites.json', overridesDoc)
    .then(() => {
      updateCharNote(' — saved');
      flashSaved('💾 Saved');
    })
    .catch((err) => {
      if (charNote) charNote.textContent = `save failed: ${String(err)}`;
      flashSaved(`⚠ Save failed: ${String(err)}`, true);
    });
}

/**
 * Rename the active character. Writes the display-name override to
 * overrides/names.json (empty / unchanged-from-base clears it) and refreshes
 * the dropdown entry + note. Names ship — no ROM data involved.
 */
function saveCharName(): void {
  if (!open || !nameInput) return;
  const name = nameInput.value.trim();
  setSpriteNameOverride(groupId, name || null);
  // Reflect the resolved name (override or baked base) back into the field + UI.
  const resolved = getSpriteName(groupId) ?? '';
  nameInput.value = resolved;
  charPicker?.refresh(); // relabel the option rows + trigger with the new name
  void postOverride('names.json', getNameOverrides())
    .then(() => updateCharNote(' — renamed'))
    .catch((err) => {
      if (charNote) charNote.textContent = `rename failed: ${String(err)}`;
    });
}

/** Restore the selected frame to its generated (pristine) pixels. */
function resetSelectedFrame(): void {
  if (!sheetReady() || !editableRow(selRow)) return;
  pushUndo();
  const x = selCol * FRAME_W;
  const y = selRow * FRAME_H;
  sheetCtx!.clearRect(x, y, FRAME_W, FRAME_H);
  sheetCtx!.drawImage(pristineSheet!, x, y, FRAME_W, FRAME_H, x, y, FRAME_W, FRAME_H);
  syncMirrorCell(selRow, selCol);
  dirty = true;
}

// ---------------------------------------------------------------------------
// PNG export / import (artist handoff). Export the active surface as a 1x PNG;
// import an edited PNG back in. Imported colors snap to the active palette
// (nearest index), so off-palette art an artist introduced is pulled back onto
// legal colors and the result stays SNES-correct. Character import lands in the
// LIVE sheet — the existing Save still diffs vs the generated/ROM pristine, so
// only hand-painted deltas persist and no ROM pixels leak. Import does NOT save;
// the admin reviews in the test pane, then hits Ctrl+S.
// ---------------------------------------------------------------------------

/** Filesystem-safe slug for an export filename. */
function safeName(s: string): string {
  return s.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'sprite';
}

/** Trigger a browser download of a canvas as a native-size (1x) PNG. */
function downloadCanvasPNG(canvas: HTMLCanvasElement, filename: string): void {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Nearest palette index (>=1; index 0 is reserved transparent) to an RGB. */
function nearestIndexIn(pal: [number, number, number][], r: number, g: number, b: number): number {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < pal.length; i++) {
    const [pr, pg, pb] = pal[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Snap an imported image to the palette: transparent stays transparent, every
 *  opaque pixel becomes its nearest palette color. */
function snapImageToPalette(src: ImageData, pal: [number, number, number][]): ImageData {
  const out = new ImageData(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3] < 128) {
      out.data[i + 3] = 0;
      continue;
    } // transparent
    const idx = nearestIndexIn(pal, src.data[i], src.data[i + 1], src.data[i + 2]);
    const [r, g, b] = pal[idx];
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = 255;
  }
  return out;
}

/** Copy a sub-rectangle out of an ImageData (used to pull one band out of the
 *  labeled export sheet on import, skipping the header margins). */
function cropImageData(src: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * src.width + x) * 4;
    out.data.set(src.data.subarray(s, s + w * 4), row * w * 4);
  }
  return out;
}

/** True if any pixel in the (col,row) sheet cell of ctx is non-transparent. */
function cellHasContent(ctx: CanvasRenderingContext2D, col: number, row: number): boolean {
  const d = ctx.getImageData(col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
  return false;
}

// Labeled comparison export — ONE character per sheet (Ness never appears on
// another character's sheet; open his export alongside as the master reference).
// Two stacked bands, split by what the data IS:
//   ORIGINAL band = the game movement frames (walk rows 0-3 + climb row 4).
//   CUSTOM band   = the combat poses we generate/hand-paint (attack 5-8, hurt 9-12).
// Every slot this character lacks but Ness has is drawn as a faint blank guide-box
// in either band, so the artist can fill in the missing frames by eye.
// Each band is wrapped in label margins: A B C … across the top for columns, and
// the sheet's row number (1-based) down the left, so any frame names uniquely
// ("frame B7" = col B, sheet row 7 = an attack frame).
//
// The label margins are EXTRA pixels. Import reads BOTH sprite bands back (skipping
// the margins) and writes each onto its rows. Untouched ROM frames re-import equal
// to pristine, so Save still won't re-save them — only hand-painted blanks persist.
const EXPORT_ORIG_ROWS = ATTACK_ROW_START; // walk + climb (rows 0-4)
const EXPORT_CUST_ROWS = SHEET_ROWS - ATTACK_ROW_START; // attack + hurt (rows 5-12)
const EXPORT_ORIG_H = EXPORT_ORIG_ROWS * FRAME_H;
const EXPORT_CUST_H = EXPORT_CUST_ROWS * FRAME_H;
const EXPORT_CUST_SRC_Y = ATTACK_ROW_START * FRAME_H; // attack/hurt start in the sheet
const EXPORT_HDR_W = 16; // left margin: row numbers
const EXPORT_HDR_H = 14; // header strip: column letters
const EXPORT_ORIG_Y = EXPORT_HDR_H; // original sprites start
const EXPORT_MID_Y = EXPORT_HDR_H + EXPORT_ORIG_H; // custom band's header strip
const EXPORT_CUST_Y = EXPORT_MID_Y + EXPORT_HDR_H; // custom sprites start
const EXPORT_W = EXPORT_HDR_W + SHEET_W;
const EXPORT_H = EXPORT_HDR_H * 2 + EXPORT_ORIG_H + EXPORT_CUST_H;

/** Y of a sheet row inside the export canvas (walk/climb → top band, attack/hurt
 *  → bottom band, both offset past their header strip). */
function exportRowY(row: number): number {
  return row < ATTACK_ROW_START
    ? EXPORT_ORIG_Y + row * FRAME_H
    : EXPORT_CUST_Y + (row - ATTACK_ROW_START) * FRAME_H;
}

/**
 * Faint EMPTY BOX outlining every slot — in EITHER band — that this character is
 * missing but Ness (the master) has. The artist opens Ness's export alongside,
 * reads the matching frame, and paints the blank in so we can complete every
 * frame for every character. Boxes are low alpha (<128); import treats alpha <128
 * as transparent, so untouched guides are never saved as art.
 */
function drawMissingFrameBoxes(ctx: CanvasRenderingContext2D): void {
  const ness = groupId === DEFAULT_GROUP ? null : getLiveSheet(DEFAULT_GROUP);
  const nessCtx = ness?.getContext('2d', { willReadFrequently: true }) ?? null;
  if (!nessCtx) return;
  ctx.fillStyle = 'rgba(120,150,200,0.30)'; // ~76 alpha — visible, dropped on import
  for (let r = 0; r < SHEET_ROWS; r++) {
    for (let c = 0; c < SHEET_COLS; c++) {
      if (cellHasContent(sheetCtx!, c, r)) continue; // char already has this frame
      if (!cellHasContent(nessCtx, c, r)) continue; // Ness lacks it too — not a "missing" frame
      const x = EXPORT_HDR_W + c * FRAME_W;
      const y = exportRowY(r);
      ctx.fillRect(x, y, FRAME_W, 1); // top
      ctx.fillRect(x, y + FRAME_H - 1, FRAME_W, 1); // bottom
      ctx.fillRect(x, y, 1, FRAME_H); // left
      ctx.fillRect(x + FRAME_W - 1, y, 1, FRAME_H); // right
    }
  }
}

/** Paint the A/B/C column letters + row numbers into the margins. Only the margins
 *  are filled; the sprite bands stay transparent for a clean re-import. */
function drawExportLabels(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#16161e';
  ctx.fillRect(0, 0, EXPORT_HDR_W, EXPORT_H); // left row-number column
  ctx.fillRect(0, 0, EXPORT_W, EXPORT_HDR_H); // original band header strip
  ctx.fillRect(0, EXPORT_MID_Y, EXPORT_W, EXPORT_HDR_H); // custom band header strip

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // column letters A B C … across both header strips
  ctx.fillStyle = '#9af';
  ctx.font = 'bold 11px monospace';
  for (let c = 0; c < SHEET_COLS; c++) {
    const x = EXPORT_HDR_W + c * FRAME_W + FRAME_W / 2;
    const letter = String.fromCharCode(65 + c);
    ctx.fillText(letter, x, EXPORT_HDR_H / 2);
    ctx.fillText(letter, x, EXPORT_MID_Y + EXPORT_HDR_H / 2);
  }

  // row numbers — the sheet's real 1-based row index, so a frame names uniquely
  ctx.fillStyle = '#ddd';
  ctx.font = 'bold 10px monospace';
  for (let r = 0; r < EXPORT_ORIG_ROWS; r++) {
    ctx.fillText(String(r + 1), EXPORT_HDR_W / 2, EXPORT_ORIG_Y + r * FRAME_H + FRAME_H / 2);
  }
  for (let r = 0; r < EXPORT_CUST_ROWS; r++) {
    const sheetRow = ATTACK_ROW_START + r;
    ctx.fillText(String(sheetRow + 1), EXPORT_HDR_W / 2, EXPORT_CUST_Y + r * FRAME_H + FRAME_H / 2);
  }

  // band tags in the corner cells
  ctx.fillStyle = '#6c8';
  ctx.font = 'bold 7px monospace';
  ctx.fillText('ORIG', EXPORT_HDR_W / 2, EXPORT_HDR_H / 2);
  ctx.fillText('CUST', EXPORT_HDR_W / 2, EXPORT_MID_Y + EXPORT_HDR_H / 2);
}

/** Build the labeled comparison export: ROM frames (walk/climb) on top, editable
 *  attack/hurt frames below, with column-letter / row-number headers in the margins. */
function buildExportSheet(): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = EXPORT_W;
  out.height = EXPORT_H;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  // Both bands come from the LIVE sheet so any frame the artist has already added
  // (in either band) shows on re-export. Sprite cells stay transparent — import
  // reads both bands back verbatim; blank cells stay blank.
  // ORIGINAL band: walk + climb (rows 0-4)
  ctx.drawImage(
    sheet!,
    0,
    0,
    SHEET_W,
    EXPORT_ORIG_H,
    EXPORT_HDR_W,
    EXPORT_ORIG_Y,
    SHEET_W,
    EXPORT_ORIG_H
  );
  // CUSTOM band: attack + hurt (rows 5-12)
  ctx.drawImage(
    sheet!,
    0,
    EXPORT_CUST_SRC_Y,
    SHEET_W,
    EXPORT_CUST_H,
    EXPORT_HDR_W,
    EXPORT_CUST_Y,
    SHEET_W,
    EXPORT_CUST_H
  );
  drawMissingFrameBoxes(ctx);

  drawExportLabels(ctx);
  return out;
}

/** Export the active surface (character sheet or item buffer) as a 1x PNG. */
function exportPNG(): void {
  if (editMode === 'item') {
    if (!itemCanvas) return;
    downloadCanvasPNG(itemCanvas, `${safeName(itemEditId)}_item.png`);
    if (itemNote)
      itemNote.textContent = `Exported ${ITEM_W}×${ITEM_H} PNG: ${getItemName(itemEditId) ?? itemEditId}`;
    return;
  }
  if (!sheet) {
    if (charNote) charNote.textContent = 'Nothing to export (view-only group)';
    return;
  }
  const name = safeName(getSpriteName(groupId) ?? `char_${groupId}`);
  downloadCanvasPNG(buildExportSheet(), `${name}_${groupId}_sheet.png`);
  updateCharNote(
    ` — exported ${EXPORT_W}×${EXPORT_H} PNG (original top · custom bottom · A–D cols · 1–${SHEET_ROWS} rows)`
  );
}

/** Open a file picker and import a PNG back into the active surface. */
function importPNG(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/*';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      applyImportedImage(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const note = editMode === 'item' ? itemNote : charNote;
      if (note) note.textContent = 'Import failed: not a readable image';
    };
    img.src = url;
  };
  input.click();
}

/** Snap + write a loaded image into the active surface (dimensions must match). */
function applyImportedImage(img: HTMLImageElement): void {
  if (editMode === 'item') {
    if (img.width !== ITEM_W || img.height !== ITEM_H) {
      if (itemNote)
        itemNote.textContent = `Import needs ${ITEM_W}×${ITEM_H} PNG (got ${img.width}×${img.height})`;
      return;
    }
    const data = imageToData(img, ITEM_W, ITEM_H);
    pushUndo();
    itemCtx!.putImageData(snapImageToPalette(data, itemPaletteRGB), 0, 0);
    commitItemEdit();
    if (itemNote)
      itemNote.textContent = `Imported ${getItemName(itemEditId) ?? itemEditId} — Save to persist`;
    dirty = true;
    return;
  }
  if (!sheetReady()) {
    if (charNote) charNote.textContent = 'Select an editable character first';
    return;
  }
  if (img.width !== EXPORT_W || img.height !== EXPORT_H) {
    if (charNote)
      charNote.textContent = `Import needs ${EXPORT_W}×${EXPORT_H} sheet (got ${img.width}×${img.height})`;
    return;
  }
  // Pull both sprite bands out of the labeled sheet (skipping the header margins)
  // and write each onto its rows. ROM frames re-imported match pristine, so Save
  // still won't re-save them — only the artist's hand-painted blanks persist.
  const full = imageToData(img, EXPORT_W, EXPORT_H);
  const origBand = cropImageData(full, EXPORT_HDR_W, EXPORT_ORIG_Y, SHEET_W, EXPORT_ORIG_H);
  const custBand = cropImageData(full, EXPORT_HDR_W, EXPORT_CUST_Y, SHEET_W, EXPORT_CUST_H);
  pushUndo();
  sheetCtx!.putImageData(snapImageToPalette(origBand, palette), 0, 0);
  sheetCtx!.putImageData(snapImageToPalette(custBand, palette), 0, EXPORT_CUST_SRC_Y);
  refreshDiagSupport(groupId); // import may add/remove diagonal frames
  updateCharNote(' — imported (Ctrl+S to save)');
  dirty = true;
}

/** Rasterize an image to raw RGBA pixels at the given native size. */
function imageToData(img: HTMLImageElement, w: number, h: number): ImageData {
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

function cancelEditor(): void {
  if (!open) return;
  const cb = editorCallbacks.onCancel;
  closeSpriteEditor();
  cb?.();
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDom(): void {
  overlay = document.createElement('div');
  // Docked to the LEFT of the editor's right-side tool column (256px wide, see
  // EditorShell.buildDock) rather than full-screen, so the tool dock stays
  // visible. `right:256px` leaves that column clear; top:31px sits below the
  // shell's HUD bar.
  overlay.style.cssText =
    'position:fixed;left:0;top:31px;right:256px;bottom:0;z-index:95;background:#16161e;color:#ddd;' +
    'font:12px monospace;display:flex;flex-direction:column;align-items:center;' +
    'overflow:auto;user-select:none;';

  const title = document.createElement('div');
  title.textContent =
    'SPRITE EDITOR — attack/hurt frames + held items   (pick a character · Character/Item modes · WASD: test walk · F attack · H hurt · 1/2/3 or Q/E: tools · Alt+click: eyedrop · G: cycle item · Ctrl+C/V: copy/paste frame · Ctrl+Z: undo · Ctrl+S: save · Export/Import PNG for artists · Esc: back)';
  title.style.cssText = 'padding:10px;color:#fff;letter-spacing:1px;';
  overlay.appendChild(title);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:16px;align-items:flex-start;';
  overlay.appendChild(row);

  row.appendChild(buildToolPanel());
  row.appendChild(buildStripPanel());
  row.appendChild(buildEditPanel());
  row.appendChild(buildTestPanel());

  document.body.appendChild(overlay);
}

function panel(label: string): HTMLDivElement {
  const div = document.createElement('div');
  div.style.cssText =
    'display:flex;flex-direction:column;gap:6px;background:#1f1f2a;' +
    'border:1px solid #333;border-radius:4px;padding:10px;';
  const head = document.createElement('div');
  head.textContent = label;
  head.style.cssText = 'color:#9af;font-size:11px;letter-spacing:1px;';
  div.appendChild(head);
  return div;
}

function buildToolPanel(): HTMLDivElement {
  const div = panel('TOOLS');

  // Character picker — load any cast member's sheet to fix its anim frames.
  const charHead = document.createElement('div');
  charHead.textContent = 'CHARACTER';
  charHead.style.cssText = 'color:#9af;font-size:11px;letter-spacing:1px;';
  div.appendChild(charHead);

  // Custom dropdown whose trigger AND every row render the real sprite (a native
  // <option> can't). Cast first, then the view-only vehicle groups.
  charPicker = createSpritePicker({
    sections: [
      { values: roster.map(String) },
      { label: 'Vehicles (view only)', values: VEHICLE_GROUPS.map((v) => String(v.id)) },
    ],
    initial: String(groupId),
    labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? vehicleName(Number(v)) ?? ''}`.trim(),
    drawThumb: drawSpriteGroupThumb,
    onSelect: (v) => void loadGroupIntoEditor(Number(v)),
  });
  div.appendChild(charPicker.el);

  charNote = document.createElement('div');
  charNote.style.cssText = 'color:#9fd; font-size:10px; min-height:12px;';
  div.appendChild(charNote);

  // Rename: edit the display name, written to overrides/names.json on save.
  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;gap:6px;';
  nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'rename…';
  nameInput.style.cssText =
    'flex:1;min-width:0;font:11px monospace;padding:4px;background:#2a2a3a;' +
    'color:#ddd;border:1px solid #444;border-radius:3px;';
  // Don't let the editor's global hotkeys fire while typing a name.
  nameInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') saveCharName();
  };
  nameRow.appendChild(nameInput);
  const nameBtn = document.createElement('button');
  nameBtn.textContent = 'Rename';
  nameBtn.style.cssText =
    'font:11px monospace;padding:4px 8px;background:#2a2a3a;color:#ddd;' +
    'border:1px solid #444;border-radius:3px;cursor:pointer;';
  nameBtn.onclick = saveCharName;
  nameRow.appendChild(nameBtn);
  div.appendChild(nameRow);

  // Edit-target toggle: the character sheet, or a held-item sprite.
  const modeRow = document.createElement('div');
  modeRow.style.cssText = 'display:flex;gap:6px;';
  const modes: [EditMode, string][] = [
    ['char', 'Character'],
    ['item', 'Item'],
  ];
  for (const [m, label] of modes) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      'flex:1;font:12px monospace;padding:5px 8px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;';
    btn.onclick = () => setEditMode(m);
    modeButtons.set(m, btn);
    modeRow.appendChild(btn);
  }
  div.appendChild(modeRow);

  // Item UI (item mode only): Weapons / Items / Custom tabs, the item dropdown
  // (rebuilt per tab), and a New-item button. Hidden until Item mode.
  itemRow = document.createElement('div');
  itemRow.style.cssText = 'display:none;flex-direction:column;gap:5px;';

  const itemTabs = document.createElement('div');
  itemTabs.style.cssText = 'display:flex;gap:4px;';
  for (const [t, label] of [
    ['weapons', 'Weapons'],
    ['items', 'Items'],
    ['custom', 'Custom'],
  ] as [ItemTab, string][]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.itab = t;
    b.style.cssText =
      'flex:1;font:11px monospace;padding:4px 0;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;';
    b.onclick = () => selectItemTab(t);
    itemTabs.appendChild(b);
  }
  itemRow.appendChild(itemTabs);

  itemPickerHost = document.createElement('div');
  itemRow.appendChild(itemPickerHost);

  const newItemBtn = document.createElement('button');
  newItemBtn.textContent = '+ New custom item';
  newItemBtn.title = 'Create a blank custom item (stored in overrides/custom_items.json)';
  newItemBtn.style.cssText =
    'font:11px monospace;padding:4px 8px;background:#10301c;color:#7fe0a0;' +
    'border:1px solid #2e6e44;border-radius:3px;cursor:pointer;';
  newItemBtn.onclick = createCustomItem;
  itemRow.appendChild(newItemBtn);

  div.appendChild(itemRow);
  rebuildItemPicker();
  highlightItemTabs();

  const tools: [Tool, string][] = [
    ['pencil', '1/Q ✏ Pencil'],
    ['eraser', '2/E ▭ Eraser'],
    ['eyedrop', '3 ⊕ Eyedrop'],
  ];
  for (const [t, label] of tools) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      'font:12px monospace;padding:5px 8px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;text-align:left;';
    btn.onclick = () => setTool(t);
    toolButtons.set(t, btn);
    div.appendChild(btn);
  }

  const palHead = document.createElement('div');
  palHead.textContent = 'PALETTE';
  palHead.style.cssText = 'margin-top:8px;color:#9af;font-size:11px;letter-spacing:1px;';
  div.appendChild(palHead);

  paletteGrid = document.createElement('div');
  paletteGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,24px);gap:3px;';
  div.appendChild(paletteGrid);
  renderSwatches();

  const reset = document.createElement('button');
  reset.textContent = 'Reset frame';
  reset.title = 'Restore the selected attack/hurt frame to its generated default';
  reset.style.cssText =
    'margin-top:10px;font:11px monospace;padding:4px 6px;background:#3a2a2a;' +
    'color:#fbb;border:1px solid #644;border-radius:3px;cursor:pointer;';
  reset.onclick = resetSelectedFrame;
  div.appendChild(reset);

  const save = document.createElement('button');
  save.textContent = '💾 Save (Ctrl+S)';
  save.title = "Write this character's attack/hurt edits to overrides/sprites.json";
  save.style.cssText =
    'margin-top:4px;font:12px monospace;padding:6px 8px;background:#1f3a26;' +
    'color:#9f9;border:1px solid #4a6;border-radius:3px;cursor:pointer;';
  save.onclick = saveCurrentGroup;
  div.appendChild(save);

  // Artist handoff: export the current sheet/item as a 1x PNG, import it back
  // (colors snap to palette). Acts on whichever surface (char vs item) is active.
  const ioRow = document.createElement('div');
  ioRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
  const mkIoBtn = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      'flex:1;font:11px monospace;padding:5px 6px;background:#23304a;color:#bcd;' +
      'border:1px solid #456;border-radius:3px;cursor:pointer;';
    b.onclick = fn;
    return b;
  };
  ioRow.appendChild(
    mkIoBtn('⬇ Export PNG', 'Download the current sheet/item as a 1× PNG for an artist', exportPNG)
  );
  ioRow.appendChild(
    mkIoBtn(
      '⬆ Import PNG',
      'Load an edited PNG back in (colors snap to palette). Ctrl+S to persist.',
      importPNG
    )
  );
  div.appendChild(ioRow);

  setTool('pencil');
  setColor(colorIndex);
  setEditMode('char'); // highlight the default mode button
  return div;
}

// X of the gutter / first frame of set s (0 = left, 1 = right) within a row.
function stripGutterX(s: number): number {
  return s * (STRIP_GUTTER + STRIP_SET_W);
}
function stripFramesX(s: number): number {
  return stripGutterX(s) + STRIP_GUTTER;
}

function buildStripPanel(): HTMLDivElement {
  const div = panel('FRAMES');
  stripCanvas = document.createElement('canvas');
  stripCanvas.width = STRIP_W;
  stripCanvas.height = STRIP_H;
  stripCanvas.style.cssText = 'image-rendering:pixelated;cursor:pointer;';
  stripCanvas.onmousedown = (e) => {
    if (viewOnly || editMode === 'item') return; // read-only frame grid: nothing to select
    const r = stripCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const dr = Math.floor(y / STRIP_FRAME_H);
    const displayRow = DISPLAY_ROWS[dr];
    if (!displayRow) return;
    // Select a canonical set only when x lands on it (not a label gutter).
    for (let s = 0; s < displayRow.length; s++) {
      const fx = stripFramesX(s);
      if (x >= fx && x < fx + STRIP_SET_W) {
        const set = displayRow[s];
        selRow = set.row;
        selCol = set.col + Math.floor((x - fx) / STRIP_FRAME_W); // frame 0 or 1
        dirty = true;
        break;
      }
    }
  };
  div.appendChild(stripCanvas);

  const note = document.createElement('div');
  note.textContent = 'W · NW · SW auto-mirror from E · NE · SE';
  note.style.cssText = 'color:#888;font-size:10px;margin-top:4px;';
  div.appendChild(note);
  return div;
}

function buildEditPanel(): HTMLDivElement {
  const div = panel('EDIT — 16×24');
  editCanvas = document.createElement('canvas');
  editCanvas.width = FRAME_W * ZOOM;
  editCanvas.height = FRAME_H * ZOOM;
  editCanvas.style.cssText = 'image-rendering:pixelated;cursor:crosshair;';
  editCanvas.oncontextmenu = (e) => e.preventDefault();
  editCanvas.onmousedown = (e) => {
    painting = true;
    strokeChanged = false;
    pushUndo();
    applyToolAt(e);
  };
  editCanvas.onmousemove = (e) => {
    if (painting) applyToolAt(e);
  };
  div.appendChild(editCanvas);

  // Copy the selected frame, paste it into any other selected frame. The strip
  // selection is the source on Copy and the destination on Paste.
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:2px;';
  const mkBtn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'flex:1;font:11px monospace;padding:4px 6px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;';
    b.onclick = fn;
    return b;
  };
  btnRow.appendChild(mkBtn('⧉ Copy frame', copyFrame));
  btnRow.appendChild(mkBtn('⊞ Paste frame', pasteFrame));
  div.appendChild(btnRow);

  copyNote = document.createElement('div');
  copyNote.textContent = 'Clipboard: empty';
  copyNote.style.cssText = 'color:#888;font-size:10px;';
  div.appendChild(copyNote);
  return div;
}

function buildTestPanel(): HTMLDivElement {
  const div = panel('LIVE TEST — WASD walk · F attack · H hurt · G item');
  testCanvas = document.createElement('canvas');
  testCanvas.width = TEST_W * TEST_SCALE;
  testCanvas.height = TEST_H * TEST_SCALE;
  testCanvas.style.cssText = 'image-rendering:pixelated;background:#3a6a44;';
  div.appendChild(testCanvas);

  const note = document.createElement('div');
  note.textContent = 'Compiled through the real game sprite path.';
  note.style.cssText = 'color:#888;font-size:10px;max-width:' + TEST_W * TEST_SCALE + 'px;';
  div.appendChild(note);

  itemNote = document.createElement('div');
  itemNote.textContent = 'Item: none (G cycles)';
  itemNote.style.cssText = 'color:#888;font-size:10px;';
  div.appendChild(itemNote);
  return div;
}

function setTool(t: Tool): void {
  tool = t;
  for (const [key, btn] of toolButtons) {
    btn.style.borderColor = key === t ? '#9af' : '#444';
    btn.style.color = key === t ? '#fff' : '#ddd';
  }
}

function setColor(i: number): void {
  colorIndex = i;
  swatchEls.forEach((sw, j) => {
    sw.style.borderColor = j === i ? '#fff' : '#444';
  });
}

/** Rebuild the palette swatches for the active edit mode (char vs item). */
function renderSwatches(): void {
  if (!paletteGrid) return;
  paletteGrid.innerHTML = '';
  swatchEls = [];
  const count = editMode === 'item' ? ITEM_PALETTE.length : palette.length;
  for (let i = 0; i < count; i++) {
    const sw = document.createElement('div');
    sw.style.cssText =
      'width:24px;height:24px;border:2px solid #444;cursor:pointer;border-radius:2px;';
    const color = colorFor(i);
    if (color === null) {
      // Color 0 is hardware-transparent on the SNES — painting it erases.
      sw.style.background = 'repeating-conic-gradient(#555 0% 25%, #2a2a2a 0% 50%) 0 0 / 12px 12px';
      sw.title = '0: transparent';
    } else {
      sw.style.background = color;
      sw.title = `${i}: ${color}`;
    }
    sw.onclick = () => setColor(i);
    swatchEls.push(sw);
    paletteGrid.appendChild(sw);
  }
  setColor(Math.min(colorIndex, count - 1));
}

function setEditMode(m: EditMode): void {
  for (const [key, btn] of modeButtons) {
    btn.style.borderColor = key === m ? '#9af' : '#444';
    btn.style.color = key === m ? '#fff' : '#ddd';
  }
  if (editMode === m) return;
  editMode = m;
  if (itemRow) itemRow.style.display = m === 'item' ? 'flex' : 'none';
  if (m === 'item') {
    colorIndex = 1;
    itemTab = tabForItem(itemEditId); // open on the tab holding the current item
    rebuildItemPicker();
    highlightItemTabs();
    loadItemIntoBuffer(itemEditId); // also sets walkerItem so it previews on the character
  } else {
    walkerItem = null;
    if (itemNote) itemNote.textContent = 'Item: none (G cycles)';
  }
  renderSwatches();
  dirty = true;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Parse '#rrggbb' to an RGB tuple ('' / non-hex -> black). */
function parseHexColor(hex: string): [number, number, number] {
  if (!hex || hex[0] !== '#') return [0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The canvas + cell origin + dimensions currently being painted. Character mode
// targets the selected sheet cell (16x24); item mode targets the 16x16 buffer.
function activeTarget(): {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  ox: number;
  oy: number;
} {
  if (editMode === 'item') return { ctx: itemCtx!, w: ITEM_W, h: ITEM_H, ox: 0, oy: 0 };
  return { ctx: sheetCtx!, w: FRAME_W, h: FRAME_H, ox: selCol * FRAME_W, oy: selRow * FRAME_H };
}

/** CSS color for a palette index in the active mode, or null for transparent. */
function colorFor(i: number): string | null {
  if (i === 0) return null;
  if (editMode === 'item') return ITEM_PALETTE[i] || null;
  const c = palette[i];
  return c ? `rgb(${c[0]},${c[1]},${c[2]})` : null;
}

/** Nearest palette index to an RGB color in the active mode (for eyedrop). */
function nearestActiveIndex(r: number, g: number, b: number): number {
  if (editMode !== 'item') return nearestPaletteIndex(r, g, b);
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < itemPaletteRGB.length; i++) {
    const [pr, pg, pb] = itemPaletteRGB[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function applyToolAt(e: MouseEvent): void {
  if (editMode === 'char' && !sheetReady()) return; // view-only group: nothing to paint
  const { ctx, w, h, ox, oy } = activeTarget();
  const r = editCanvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - r.left) / ZOOM);
  const py = Math.floor((e.clientY - r.top) / ZOOM);
  if (px < 0 || py < 0 || px >= w || py >= h) return;

  const sx = ox + px;
  const sy = oy + py;

  // Right mouse button always erases, whatever tool is active.
  const erase = tool === 'eraser' || (e.buttons & 2) !== 0;

  // Alt+click samples a color without switching off the active tool; the
  // eyedrop tool does the same but then drops back to the pencil. (Sampling is
  // allowed on the locked walk rows; only painting them is blocked.)
  if ((tool === 'eyedrop' || e.altKey) && !erase) {
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    setColor(d[3] === 0 ? 0 : nearestActiveIndex(d[0], d[1], d[2]));
    if (tool === 'eyedrop') setTool('pencil');
    return;
  }

  const color = colorFor(colorIndex);
  if (erase || color === null) {
    ctx.clearRect(sx, sy, 1, 1);
  } else {
    ctx.clearRect(sx, sy, 1, 1); // replace, don't blend
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, 1, 1);
  }

  if (editMode === 'item') {
    commitItemEdit(); // push the buffer as a live override so the test pane updates
  } else {
    // Auto-mirror: keep the west/diagonal-left partner cell a flipped copy of the
    // canonical cell being edited (selection is always canonical — see strip click).
    syncMirrorCell(selRow, selCol);
  }
  strokeChanged = true;
  dirty = true;
}

/** Redraw the derived (mirrored) partner of a canonical cell as its h-flip. */
function syncMirrorCell(row: number, col: number): void {
  const t = mirrorTargetFor(row, col);
  if (!t) return;
  const ctx = sheetCtx!;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(t.col * FRAME_W, t.row * FRAME_H, FRAME_W, FRAME_H);
  ctx.translate(t.col * FRAME_W + FRAME_W, t.row * FRAME_H);
  ctx.scale(-1, 1);
  ctx.drawImage(sheet!, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
  ctx.restore();
}

function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function pushUndo(): void {
  if (editMode === 'item') {
    itemUndo.push(itemCtx!.getImageData(0, 0, ITEM_W, ITEM_H));
    if (itemUndo.length > UNDO_LIMIT) itemUndo.shift();
    return;
  }
  if (!sheetCtx) return; // view-only group: no sheet to snapshot
  undoStack.push(sheetCtx.getImageData(0, 0, SHEET_W, SHEET_H));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo(): void {
  if (editMode === 'item') {
    const snap = itemUndo.pop();
    if (!snap) return;
    itemCtx!.putImageData(snap, 0, 0);
    commitItemEdit();
    persistItem();
    dirty = true;
    return;
  }
  const snap = undoStack.pop();
  if (!snap) return;
  sheetCtx!.putImageData(snap, 0, 0);
  refreshDiagSupport(groupId); // an undo may add/remove diagonal frames
  dirty = true;
}

/** Persist whichever surface is currently being edited. Item art autosaves to
 *  localStorage; character anim edits persist only via the explicit Save (to
 *  overrides/sprites.json), so there's nothing to do for the char sheet here. */
function persistActive(): void {
  if (editMode === 'item') persistItem();
}

/** Human label for a sheet cell (selection is always a canonical strip cell). */
function labelForCell(row: number, col: number): string {
  for (const dr of DISPLAY_ROWS) {
    for (const set of dr) {
      if (set.row === row && (col === set.col || col === set.col + 1)) {
        return `${set.label} f${col - set.col}`;
      }
    }
  }
  return `r${row}c${col}`;
}

/** Grab the selected frame's 16x24 pixels into the clipboard. */
function copyFrame(): void {
  if (editMode === 'item') return; // frame copy/paste is character-sheet only
  if (!sheetReady()) return; // view-only group
  frameClipboard = sheetCtx!.getImageData(selCol * FRAME_W, selRow * FRAME_H, FRAME_W, FRAME_H);
  if (copyNote) copyNote.textContent = `Clipboard: ${labelForCell(selRow, selCol)}`;
}

/** Replace the selected frame with the clipboard (undoable; re-mirrors). */
function pasteFrame(): void {
  if (editMode === 'item') return;
  if (!sheetReady()) return; // view-only group
  if (!frameClipboard) return;
  pushUndo();
  // putImageData overwrites the cell wholesale (incl. transparency) — a true
  // frame replace, not an alpha blend.
  sheetCtx!.putImageData(frameClipboard, selCol * FRAME_W, selRow * FRAME_H);
  // Selection is canonical, so refresh its W/NW/SW mirror partner if it has one.
  syncMirrorCell(selRow, selCol);
  dirty = true;
}

function onGlobalMouseUp(): void {
  if (painting && strokeChanged) {
    persistActive();
    // A finished character stroke may have filled (or cleared) diagonal frames;
    // refresh diag support so the test pane + world show them immediately
    // instead of the side-view fallback.
    if (editMode === 'char') refreshDiagSupport(groupId);
  } else if (painting && !strokeChanged) {
    // stroke did nothing (e.g. eyedrop) — drop its snapshot from the active stack
    if (editMode === 'item') itemUndo.pop();
    else undoStack.pop();
  }
  painting = false;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  // While typing in a field (the sprite picker's search, the rename box), let
  // the key reach the input — don't steal it for WASD/tool hotkeys.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.stopPropagation();
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    cancelEditor();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 's') {
    e.preventDefault();
    saveCurrentGroup();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'c') {
    e.preventDefault();
    copyFrame();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'v') {
    e.preventDefault();
    pasteFrame();
    return;
  }
  if (k === '1' || k === 'q') setTool('pencil');
  else if (k === '2' || k === 'e') setTool('eraser');
  else if (k === '3') setTool('eyedrop');
  else if (k === 'w' || k === 'a' || k === 's' || k === 'd') heldKeys.add(k);
  else if (k === 'f' && walkerPose === 'walk') {
    walkerPose = 'attack'; // preview the attack rows
    walkerPoseTimer = 0;
  } else if (k === 'h' && walkerPose === 'walk') {
    walkerPose = 'hurt'; // preview the hurt row
    walkerPoseTimer = 0;
  } else if (k === 'g') {
    if (editMode === 'item') {
      // Cycle which item is being edited within the active tab (picker in sync).
      const list = idsForTab(itemTab);
      const i = list.indexOf(itemEditId);
      const next = list[(i + 1) % list.length];
      loadItemIntoBuffer(next); // updates the item buffer/thumb
      itemPicker?.setValue(next); // keep the dropdown in sync
      dirty = true;
    } else {
      walkerItem = nextHeldItem(walkerItem); // preview held-item overlays
      if (itemNote)
        itemNote.textContent = `Item: ${walkerItem ? getItemName(walkerItem) : 'none'} (G cycles)`;
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  e.stopPropagation();
  heldKeys.delete(e.key.toLowerCase());
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function tick(): void {
  if (!open) return;
  updateWalker();
  if (dirty) {
    drawEditCanvas();
    drawStrip();
    dirty = false;
  }
  drawTestPane();
  rafId = requestAnimationFrame(tick);
}

const DIR_FROM_DELTA: Record<string, Direction> = {
  '0,-1': Direction.N,
  '0,1': Direction.S,
  '-1,0': Direction.W,
  '1,0': Direction.E,
  '1,-1': Direction.NE,
  '1,1': Direction.SE,
  '-1,1': Direction.SW,
  '-1,-1': Direction.NW,
};

function updateWalker(): void {
  // Attack/hurt previews play out like in-game: brief, movement-locked.
  if (walkerPose === 'attack') {
    walkerPoseTimer++;
    walkerFrame = walkerPoseTimer < 8 ? 0 : 1;
    if (walkerPoseTimer >= 16) {
      walkerPose = 'walk';
      walkerFrame = 0;
    }
    return;
  }
  if (walkerPose === 'hurt') {
    walkerPoseTimer++;
    walkerFrame = walkerPoseTimer < 8 ? 0 : 1; // recoil then settle
    if (walkerPoseTimer >= 20) {
      walkerPose = 'walk';
      walkerFrame = 0;
    }
    return;
  }

  const dx = (heldKeys.has('d') ? 1 : 0) - (heldKeys.has('a') ? 1 : 0);
  const dy = (heldKeys.has('s') ? 1 : 0) - (heldKeys.has('w') ? 1 : 0);
  if (dx === 0 && dy === 0) {
    walkerFrame = 0;
    walkerTimer = 0;
    return;
  }
  walkerDir = DIR_FROM_DELTA[`${dx},${dy}`];
  const speed = dx !== 0 && dy !== 0 ? 1.06 : 1.5; // EB-style diagonal slowdown
  walkerX = clamp(walkerX + dx * speed, FRAME_W / 2, TEST_W - FRAME_W / 2);
  walkerY = clamp(walkerY + dy * speed, FRAME_H + 2, TEST_H - 2);
  if (++walkerTimer >= 8) {
    walkerTimer = 0;
    walkerFrame = walkerFrame === 0 ? 1 : 0;
  }
}

function drawTestPane(): void {
  const ctx = testCanvas.getContext('2d')!;
  ctx.setTransform(TEST_SCALE, 0, 0, TEST_SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // Simple grass checker so motion is visible.
  ctx.fillStyle = '#3a6a44';
  ctx.fillRect(0, 0, TEST_W, TEST_H);
  ctx.fillStyle = '#35613e';
  for (let ty = 0; ty < TEST_H; ty += 16) {
    for (let tx = (ty / 16) % 2 === 0 ? 0 : 16; tx < TEST_W; tx += 32) {
      ctx.fillRect(tx, ty, 16, 16);
    }
  }

  // Same overlay ordering as the in-game renderer: far-hand items go under
  // the body, near-hand items on top.
  const itemBehind = walkerItem !== null && isItemBehind(walkerDir);
  if (walkerItem && itemBehind) {
    drawHeldItem(ctx, walkerItem, walkerDir, walkerFrame, walkerPose, walkerX, walkerY);
  }
  drawSprite(ctx, groupId, walkerDir, walkerFrame, walkerX, walkerY, 'full', walkerPose);
  if (walkerItem && !itemBehind) {
    drawHeldItem(ctx, walkerItem, walkerDir, walkerFrame, walkerPose, walkerX, walkerY);
  }
}

/** Edit-area stand-in for view-only groups: the sprite scaled to fit + a flag. */
function drawViewOnlyPreview(): void {
  const cv = editCanvas;
  if (cv.width !== FRAME_W * ZOOM || cv.height !== FRAME_H * ZOOM) {
    cv.width = FRAME_W * ZOOM;
    cv.height = FRAME_H * ZOOM;
  }
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = CHECKER_B;
  for (let y = 0; y < cv.height; y += 16) {
    for (let x = (y / 16) % 2 === 0 ? 0 : 16; x < cv.width; x += 32) ctx.fillRect(x, y, 16, 16);
  }
  const meta = getSpriteGroupMeta(groupId);
  const w = meta?.width ?? FRAME_W;
  const h = meta?.height ?? FRAME_H;
  const s = Math.max(1, Math.floor(Math.min((cv.width - 24) / w, (cv.height - 24) / h)));
  ctx.save();
  ctx.scale(s, s);
  drawSprite(ctx, groupId, Direction.S, 0, cv.width / s / 2, cv.height / s / 2 + h / 2);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('VIEW ONLY', cv.width / 2, 16);
  ctx.textAlign = 'left';
}

function drawEditCanvas(): void {
  // Edit grid follows the active target (16x24 char cell vs 16x16 item).
  const isItem = editMode === 'item';
  // View-only group (vehicle): there's no editable cell — show a scaled preview.
  if (!isItem && viewOnly) {
    drawViewOnlyPreview();
    return;
  }
  const gw = isItem ? ITEM_W : FRAME_W;
  const gh = isItem ? ITEM_H : FRAME_H;
  if (editCanvas.width !== gw * ZOOM || editCanvas.height !== gh * ZOOM) {
    editCanvas.width = gw * ZOOM;
    editCanvas.height = gh * ZOOM;
  }

  const ctx = editCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Light transparency checkerboard under the frame, so the sprite's dark
  // outline stays visible (a dark field hid it).
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, editCanvas.width, editCanvas.height);
  ctx.fillStyle = CHECKER_B;
  for (let y = 0; y < gh; y++) {
    for (let x = y % 2 === 0 ? 0 : 1; x < gw; x += 2) {
      ctx.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
    }
  }

  if (isItem) {
    ctx.drawImage(itemCanvas!, 0, 0, ITEM_W, ITEM_H, 0, 0, gw * ZOOM, gh * ZOOM);
  } else {
    ctx.drawImage(
      sheet!,
      selCol * FRAME_W,
      selRow * FRAME_H,
      FRAME_W,
      FRAME_H,
      0,
      0,
      gw * ZOOM,
      gh * ZOOM
    );
  }

  // Pixel grid (dark, to read on the light checker), heavier on 8x8 SNES tiles.
  for (let x = 0; x <= gw; x++) {
    ctx.fillStyle = x % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(x * ZOOM, 0, 1, editCanvas.height);
  }
  for (let y = 0; y <= gh; y++) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, y * ZOOM, editCanvas.width, 1);
  }
}

/** Light transparency checker filling a device-pixel rect of the strip. */
function fillChecker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const C = 8;
  for (let yy = 0; yy < h; yy += C) {
    for (let xx = 0; xx < w; xx += C) {
      ctx.fillStyle = (xx / C + yy / C) & 1 ? CHECKER_B : CHECKER_A;
      ctx.fillRect(x + xx, y + yy, Math.min(C, w - xx), Math.min(C, h - yy));
    }
  }
}

// Direction label for a source-sheet cell (vehicles reuse the cast walk layout,
// so rows 0-3 / cols 0-3 map to the 8 directions × 2 frames).
const SRC_CELL_LABEL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [dir, { row, col }] of Object.entries(DIR_BASE)) {
    m[`${row},${col}`] = dir;
    m[`${row},${col + 1}`] = dir; // second frame, same direction
  }
  return m;
})();

interface StripCell {
  label: string;
  w: number;
  h: number;
  draw: (ctx: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) => void;
}

/** Read-only frame grid (vehicles, items): every frame the object has, scaled
 *  to fit, labeled. Resizes the strip canvas to the content. */
function drawFramesGrid(cells: StripCell[], cols: number): void {
  const ctx = stripCanvas.getContext('2d')!;
  if (cells.length === 0) {
    stripCanvas.width = STRIP_W;
    stripCanvas.height = 36;
    ctx.fillStyle = '#1f1f2a';
    ctx.fillRect(0, 0, stripCanvas.width, stripCanvas.height);
    ctx.fillStyle = '#8895aa';
    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('no frames', 8, 18);
    return;
  }
  const fw = Math.max(...cells.map((c) => c.w));
  const fh = Math.max(...cells.map((c) => c.h));
  // Integer scale toward a ~52px target: small cast frames enlarge, big vehicle
  // frames sit at 1x.
  const scale = Math.max(1, Math.round(52 / Math.max(fw, fh)));
  const PAD = 4;
  const LABEL = 12;
  const GAP = 4;
  const cw = fw * scale + PAD * 2;
  const ch = fh * scale + PAD * 2 + LABEL;
  const rows = Math.ceil(cells.length / cols);
  stripCanvas.width = cols * cw + GAP * (cols + 1);
  stripCanvas.height = rows * ch + GAP * (rows + 1);
  ctx.imageSmoothingEnabled = false; // resize reset context state
  ctx.fillStyle = '#1f1f2a';
  ctx.fillRect(0, 0, stripCanvas.width, stripCanvas.height);
  ctx.font = '9px monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  cells.forEach((cell, i) => {
    const cx = GAP + (i % cols) * (cw + GAP);
    const cy = GAP + Math.floor(i / cols) * (ch + GAP);
    ctx.fillStyle = '#cdd6e6';
    ctx.fillText(cell.label, cx + cw / 2, cy + LABEL / 2 + 1);
    const bx = cx + PAD;
    const by = cy + LABEL;
    const bw = fw * scale;
    const bh = fh * scale;
    fillChecker(ctx, bx, by, bw, bh);
    const dw = cell.w * scale;
    const dh = cell.h * scale;
    cell.draw(ctx, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh); // center smaller frames
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  });
  ctx.textAlign = 'left';
}

/** Every source frame of the current (view-only) group, in sheet order. */
function vehicleStripCells(): StripCell[] {
  const src = getSourceSheet(groupId);
  if (!src) return [];
  const { img, frameW, frameH, cols, rows } = src;
  const cells: StripCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        label: SRC_CELL_LABEL[`${r},${c}`] ?? `${r},${c}`,
        w: frameW,
        h: frameH,
        draw: (ctx, dx, dy, dw, dh) =>
          ctx.drawImage(img, c * frameW, r * frameH, frameW, frameH, dx, dy, dw, dh),
      });
    }
  }
  return cells;
}

/** The current held item's single frame (its live edit buffer or base art). */
function itemStripCells(): StripCell[] {
  const art: CanvasImageSource | null =
    itemEditId && itemCanvas ? itemCanvas : renderItemArt(itemEditId);
  if (!art) return [];
  return [
    {
      label: getItemName(itemEditId) ?? itemEditId,
      w: ITEM_W,
      h: ITEM_H,
      draw: (ctx, dx, dy, dw, dh) => ctx.drawImage(art, 0, 0, ITEM_W, ITEM_H, dx, dy, dw, dh),
    },
  ];
}

function drawStrip(): void {
  // Item / view-only groups show a read-only grid of every frame they have.
  if (editMode === 'item') {
    drawFramesGrid(itemStripCells(), 1);
    return;
  }
  if (viewOnly) {
    drawFramesGrid(vehicleStripCells(), getSourceSheet(groupId)?.cols ?? 4);
    return;
  }

  // Editable character: the canonical walk/climb/attack/hurt pose strip.
  if (stripCanvas.width !== STRIP_W || stripCanvas.height !== STRIP_H) {
    stripCanvas.width = STRIP_W;
    stripCanvas.height = STRIP_H;
  }
  const ctx = stripCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Panel-dark fill so the label gutters blend in; frame sets get a light
  // checker drawn over them below.
  ctx.fillStyle = '#1f1f2a';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);
  ctx.textBaseline = 'middle';
  ctx.font = '10px monospace';

  if (!sheet) {
    ctx.fillStyle = '#8895aa';
    ctx.fillText('no frames', 8, 18);
    return;
  }

  for (let dr = 0; dr < DISPLAY_ROWS.length; dr++) {
    const y = dr * STRIP_FRAME_H;
    DISPLAY_ROWS[dr].forEach((set, s) => {
      const fx = stripFramesX(s);

      // Label in the gutter to the LEFT of this 2-frame set.
      ctx.fillStyle = '#cdd6e6';
      ctx.fillText(set.label, stripGutterX(s) + 4, y + STRIP_FRAME_H / 2);

      // Light checker, then the set's two frames over it.
      fillChecker(ctx, fx, y, STRIP_SET_W, STRIP_FRAME_H);
      for (let i = 0; i < 2; i++) {
        ctx.drawImage(
          sheet!,
          (set.col + i) * FRAME_W,
          set.row * FRAME_H,
          FRAME_W,
          FRAME_H,
          fx + i * STRIP_FRAME_W,
          y,
          STRIP_FRAME_W,
          STRIP_FRAME_H
        );
      }

      // Per-frame cell borders.
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      for (let i = 0; i < 2; i++) {
        ctx.strokeRect(fx + i * STRIP_FRAME_W + 0.5, y + 0.5, STRIP_FRAME_W - 1, STRIP_FRAME_H - 1);
      }

      // Selection highlight if the active sheet cell lives in this set.
      if (selRow === set.row && (selCol === set.col || selCol === set.col + 1)) {
        const selX = fx + (selCol - set.col) * STRIP_FRAME_W;
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 2;
        ctx.strokeRect(selX + 1, y + 1, STRIP_FRAME_W - 2, STRIP_FRAME_H - 2);
      }
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
