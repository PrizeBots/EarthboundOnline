// Item-editing surface: the ITEM_FRAMES (3) 16x16 swing-frame buffers, the
// Weapons/Items/Custom tab catalog, the item picker, custom-item minting,
// per-item persistence (overrides/item_sprites.json), and the item-only render
// helpers (thumb, swing preview, strip cells). Shares the pixel engine via
// ./pixelCanvas and the global state object S.
import {
  getItemName,
  ITEM_W,
  ITEM_H,
  ITEM_FRAMES,
  HELD_ITEM_IDS,
  setItemOverride,
  itemHasFrame,
  renderItemArt,
  loadItemSprites,
  getItemSpriteData,
  setItemSpriteData,
  setItemOffset,
  canvasToItemPixels,
  itemSpriteIds,
  loadCustomItems,
  addCustomItem,
  customItemsDoc,
} from '../Items';
import { allItems, loadShops } from '../Shop';
import {
  itemRootCategories,
  itemsInFolder,
  folderOfItem,
  assignItemsTo,
  saveItemFolders,
  loadItemFolders,
  itemFoldersLoaded,
} from '../ItemFolders';
import { createSpritePicker } from '../SpritePicker';
import {
  ItemDocEntry,
  StripCell,
  snapImageToPalette,
  imageToData,
  itemPaletteRGB,
} from './constants';
import { S, ItemTab } from './state';
import { postOverride } from './saveChannel';
import { clearSelection, pushUndo } from './pixelCanvas';

// The item list is now the whole game catalog (shops.json) — unified with the
// Item Manager. Falls back to the legacy hand-authored ids if the catalog is
// absent (e.g. shops.json not extracted yet).
export function itemListIds(): string[] {
  const ids = allItems().map((i) => i.id);
  return ids.length ? ids : [...HELD_ITEM_IDS];
}

// Tabs ARE the Item Manager's category folders (ItemFolders). idsForTab returns
// the items filed in that category; the tab id is the folder id.
export function idsForTab(tab: ItemTab): string[] {
  return itemsInFolder(tab);
}

/** Every category id, in desktop order (the Sprite Editor's tab list). */
export function itemTabIds(): { id: string; name: string }[] {
  return itemRootCategories().map((f) => ({ id: f.id, name: f.name }));
}

/** The category an item belongs to (its folder), falling back to the first tab. */
export function tabForItem(id: string): ItemTab {
  return folderOfItem(id) ?? itemRootCategories()[0]?.id ?? 'custom';
}

// ---------------------------------------------------------------------------
// Item edit buffer & persistence
// ---------------------------------------------------------------------------

/** Create the ITEM_FRAMES 16x16 edit buffers and seed them with the first item. */
export function buildItemBuffer(): void {
  if (!S.itemFrameBuffers.length) {
    for (let f = 0; f < ITEM_FRAMES; f++) {
      const c = document.createElement('canvas');
      c.width = ITEM_W;
      c.height = ITEM_H;
      const cx = c.getContext('2d', { willReadFrequently: true })!;
      cx.imageSmoothingEnabled = false;
      S.itemFrameBuffers.push(c);
      S.itemFrameCtxs.push(cx);
    }
    S.itemEditFrame = 0;
    aliasActiveFrame();
  }
  if (!S.itemEditId) S.itemEditId = itemListIds()[0] ?? '';
  // Seed all frame buffers with the current item's art, but DON'T touch
  // walkerItem — we start in character mode (no held item shown yet).
  if (S.itemEditId) seedFrameBuffers(S.itemEditId);
}

/** Point itemCanvas/itemCtx at the active frame's buffer. */
function aliasActiveFrame(): void {
  S.itemCanvas = S.itemFrameBuffers[S.itemEditFrame] ?? null;
  S.itemCtx = S.itemFrameCtxs[S.itemEditFrame] ?? null;
}

/** Seed the 3 buffers from an item's authored frames; an UNauthored frame is a
 *  copy of the previous frame (so you tweak the pose, and 1-frame weapons stay
 *  static across the swing until you change them). */
function seedFrameBuffers(id: string): void {
  for (let f = 0; f < ITEM_FRAMES; f++) {
    const cx = S.itemFrameCtxs[f];
    cx.clearRect(0, 0, ITEM_W, ITEM_H);
    if (f > 0 && !itemHasFrame(id, f)) {
      cx.drawImage(S.itemFrameBuffers[f - 1], 0, 0); // copy previous frame
    } else {
      const art = renderItemArt(id, f);
      if (art) cx.drawImage(art, 0, 0);
    }
  }
  S.itemUndo = [];
}

/** Load the shared per-item art (overrides/item_sprites.json) so the editor and
 * the live game both start from the same authored gear, plus the category
 * folders that drive the item-mode tabs (only loaded once; the Item Manager may
 * have already loaded them). */
export async function loadSavedItems(): Promise<void> {
  await loadItemSprites();
  await loadCustomItems();
  if (!itemFoldersLoaded()) {
    await loadShops(); // category sort needs the catalog (names/equip slots)
    await loadItemFolders();
  }
}

/** Load an item's current art into all 3 frame buffers. */
export function loadItemIntoBuffer(id: string): void {
  clearSelection(); // a new frame's pixels — old selection no longer applies
  S.itemEditId = id;
  S.itemEditFrame = 0;
  aliasActiveFrame();
  seedFrameBuffers(id);
  commitItemEdit(); // push all frames as live overrides so the previews animate
  S.walkerItem = id; // show it on the test-pane character immediately
  if (S.itemNote)
    S.itemNote.textContent = `Editing ${getItemName(id) ?? id} — frame ${S.itemEditFrame + 1}/${ITEM_FRAMES}`;
  renderItemThumb();
}

/** Switch which animation frame is being edited (commits the current one first).
 *  Driven by clicking a frame in the FRAMES strip (drawFramesGrid highlights it). */
export function setItemEditFrame(frame: number): void {
  if (frame === S.itemEditFrame || frame < 0 || frame >= ITEM_FRAMES) return;
  commitItemEdit(); // keep the frame we're leaving in the live preview
  clearSelection();
  S.itemEditFrame = frame;
  aliasActiveFrame();
  S.itemUndo = [];
  if (S.itemNote)
    S.itemNote.textContent = `Editing ${getItemName(S.itemEditId) ?? S.itemEditId} — frame ${frame + 1}/${ITEM_FRAMES}`;
  S.dirty = true;
}

/** Push all 3 frame buffers as runtime overrides + refresh the preview.
 *  Stores an independent COPY of each buffer, not the shared buffer canvas
 *  itself: the 3 itemFrameBuffers are reused for every item, so aliasing them
 *  into the override map meant switching items (which redraws the buffers)
 *  silently overwrote the previous item's art — it'd show the wrong sprite (or
 *  none) until a reload rebuilt overrides from the saved file. Snapshotting here
 *  gives each item its own pixels. */
export function commitItemEdit(): void {
  for (let f = 0; f < ITEM_FRAMES; f++) {
    const copy = document.createElement('canvas');
    copy.width = ITEM_W;
    copy.height = ITEM_H;
    copy.getContext('2d')!.drawImage(S.itemFrameBuffers[f], 0, 0);
    setItemOverride(S.itemEditId, f, copy);
  }
  S.walkerItem = S.itemEditId;
  renderItemThumb();
}

// Persist the edited item (all frames) to the SHARED store +
// overrides/item_sprites.json, so every client renders this gear. Keyed by id.
export function persistItem(): void {
  const frames = S.itemFrameBuffers.map((c) => canvasToItemPixels(c));
  const existing = getItemSpriteData(S.itemEditId);
  const grip = existing?.grip;
  const offset = existing?.offset; // body-mount position (set by dragging in the test)
  setItemSpriteData(S.itemEditId, {
    pixels: frames[0],
    frames,
    ...(grip ? { grip } : {}),
    ...(offset ? { offset } : {}),
  });
  void postOverride('item_sprites.json', buildItemSpriteDoc()).catch(() => {
    if (S.itemNote) S.itemNote.textContent = 'Item save failed (dev save channel?)';
  });
}

/** The whole authored item-art map, for the overrides/item_sprites.json file. */
function buildItemSpriteDoc(): Record<string, ItemDocEntry> {
  const doc: Record<string, ItemDocEntry> = {};
  for (const id of itemSpriteIds()) {
    const d = getItemSpriteData(id);
    if (!d) continue;
    doc[id] = {
      pixels: d.pixels,
      ...(d.frames ? { frames: d.frames } : {}),
      ...(d.grip ? { grip: d.grip } : {}),
      ...(d.offset ? { offset: d.offset } : {}),
    };
  }
  return doc;
}

// --- item tabs + custom items --------------------------------------------------

/** Rebuild the item dropdown for the active tab, keeping the current selection
 *  if it's in this tab (else select the tab's first item). */
export function rebuildItemPicker(): void {
  if (!S.itemPickerHost) return;
  S.itemPickerHost.innerHTML = '';
  const ids = idsForTab(S.itemTab);
  const initial = ids.includes(S.itemEditId) ? S.itemEditId : (ids[0] ?? '');
  S.itemPicker = createSpritePicker({
    sections: [{ values: ids }],
    initial,
    labelFor: (v) => `${v} ${getItemName(v) ?? ''}`.trim(),
    drawThumb: drawItemThumb,
    onSelect: (v) => {
      loadItemIntoBuffer(v);
      S.dirty = true;
    },
  });
  S.itemPickerHost.appendChild(S.itemPicker.el);
}

export function highlightItemTabs(): void {
  if (!S.itemRow) return;
  for (const b of S.itemRow.querySelectorAll<HTMLButtonElement>('button[data-itab]')) {
    const on = b.dataset.itab === S.itemTab;
    b.style.color = on ? '#fff' : '#ddd';
    b.style.borderColor = on ? '#9af' : '#444';
  }
}

export function selectItemTab(tab: ItemTab): void {
  S.itemTab = tab;
  const ids = idsForTab(tab);
  if (!ids.includes(S.itemEditId) && ids.length) loadItemIntoBuffer(ids[0]); // sets itemEditId
  rebuildItemPicker();
  highlightItemTabs();
  S.dirty = true;
}

function persistCustomItems(): void {
  void postOverride('custom_items.json', customItemsDoc()).catch(() => {
    if (S.itemNote) S.itemNote.textContent = 'Custom-item save failed (dev save channel?)';
  });
}

/** Mint a blank custom item, drop into the Custom tab, and open it for drawing. */
export function createCustomItem(): void {
  const name = window.prompt('New custom item name:', 'Custom item');
  if (name === null) return; // cancelled
  const id = addCustomItem(name.trim() || 'Custom item');
  persistCustomItems(); // register it now so the id isn't orphaned
  // File it under the Custom category so it shows in the desktop + this tab.
  assignItemsTo([id], 'custom');
  void saveItemFolders().catch(() => {});
  S.itemTab = 'custom';
  loadItemIntoBuffer(id); // blank buffer (no art yet) + sets itemEditId
  rebuildItemPicker();
  highlightItemTabs();
  S.itemPicker?.setValue(id);
  if (S.itemNote)
    S.itemNote.textContent = `New item "${getItemName(id) ?? id}" — draw it, then Save`;
  S.dirty = true;
}

// ---------------------------------------------------------------------------
// Item render helpers
// ---------------------------------------------------------------------------

/** drawThumb for a held item: its art (live edit buffer for the active item). */
export function drawItemThumb(canvas: HTMLCanvasElement, v: string): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const src: CanvasImageSource | null =
    v === S.itemEditId && S.itemFrameBuffers.length ? S.itemFrameBuffers[0] : renderItemArt(v, 0);
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

/** Point the item picker at the current selection and redraw its preview. */
export function renderItemThumb(): void {
  S.itemPicker?.setValue(S.itemEditId);
}

/** Loop the active item's frames in the 2nd test pane (item mode only). */
export function drawItemPreview(): void {
  const wrap = S.itemTestCanvas?.parentElement as HTMLElement | null;
  if (!S.itemTestCanvas || !wrap) return;
  const show = S.editMode === 'item';
  wrap.style.display = show ? 'flex' : 'none';
  if (!show) return;
  // Advance the loop: hold each frame a few ticks so the swing reads.
  if (++S.itemPreviewTimer >= 9) {
    S.itemPreviewTimer = 0;
    S.itemPreviewFrame = (S.itemPreviewFrame + 1) % ITEM_FRAMES;
  }
  const ctx = S.itemTestCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, S.itemTestCanvas.width, S.itemTestCanvas.height);
  const buf = S.itemFrameBuffers[S.itemPreviewFrame];
  if (buf) {
    ctx.drawImage(buf, 0, 0, ITEM_W, ITEM_H, 0, 0, S.itemTestCanvas.width, S.itemTestCanvas.height);
  }
}

/** Clear the body-mount offset — back to a hand-held weapon. */
export function resetItemToHand(): void {
  if (!S.itemEditId) return;
  setItemOffset(S.itemEditId, null);
  persistItem();
  if (S.itemNote)
    S.itemNote.textContent = `${getItemName(S.itemEditId) ?? S.itemEditId} — hand-held (weapon)`;
}

/** Snap + write an imported 16x16 PNG into the active item buffer (Import PNG in
 *  item mode). Dimensions must match; colors snap to the item palette. */
export function applyImportedItemImage(img: HTMLImageElement): void {
  if (img.width !== ITEM_W || img.height !== ITEM_H) {
    if (S.itemNote)
      S.itemNote.textContent = `Import needs ${ITEM_W}×${ITEM_H} PNG (got ${img.width}×${img.height})`;
    return;
  }
  const data = imageToData(img, ITEM_W, ITEM_H);
  pushUndo();
  S.itemCtx!.putImageData(snapImageToPalette(data, itemPaletteRGB), 0, 0);
  commitItemEdit();
  if (S.itemNote)
    S.itemNote.textContent = `Imported ${getItemName(S.itemEditId) ?? S.itemEditId} — Save to persist`;
  S.dirty = true;
}

/** The current held item's ITEM_FRAMES animation frames (live edit buffers). */
export function itemStripCells(): StripCell[] {
  if (!S.itemFrameBuffers.length) return [];
  const labels = ['1 wind-up', '2 swing', '3 follow'];
  return S.itemFrameBuffers.map((buf, f) => ({
    label: labels[f] ?? `frame ${f + 1}`,
    w: ITEM_W,
    h: ITEM_H,
    draw: (ctx, dx, dy, dw, dh) => ctx.drawImage(buf, 0, 0, ITEM_W, ITEM_H, dx, dy, dw, dh),
  }));
}
