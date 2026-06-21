// Cast Sprite Editor (admin): a pixel editor for any cast character's
// attack/hurt animation frames, plus their held-item art. Opens as a DOM overlay
// on top of the game canvas (the 256x224 game screen is too small for per-pixel
// work). Pick a character from the dropdown; the editor paints into that group's
// LIVE pose sheet (ROM walk/climb + PoseGen attack/hurt), so the world and the
// test pane update as you draw. Walk/climb rows are ROM and locked-equivalent.
// Save writes only the attack/hurt diff vs the generated frames to
// public/overrides/sprites.json — no ROM-derived pixels ever land in the file.
//
// This module is the orchestrator: public open/close, edit-mode switching, the
// save dispatcher, keyboard input, and the render loop. The surfaces live in
// ./pixelCanvas (shared engine), ./castEditor, ./itemEditor, ./testWalker; the
// DOM is built in ./dom; mutable state is centralized in ./state.
import { setMuteButtonHidden } from '../MuteButton';
import { nextHeldItem, getItemName, setItemMirror } from '../Items';
import { CUSTOM_GROUP_BASE, setGroupMirror } from '../SpriteManager';
import { DEFAULT_GROUP, EditMode, SpriteEditorCallbacks } from './constants';
import { S } from './state';
import { flashSaved, postOverride, setSaveStatus } from './saveChannel';
import { setAutosaver, flushAutosave, requestAutosave } from './autosave';
import {
  clearSelection,
  undo,
  copySelection,
  pasteClipboard,
  setTool,
  renderSwatches,
  sheetReady,
  drawEditCanvas,
  finishEditInteraction,
  pushUndo,
  remirrorAll,
} from './pixelCanvas';
import {
  loadRoster,
  loadOverridesDoc,
  loadGroupIntoEditor,
  captureGroupDiff,
  captureCustomFramePixels,
  updateCharNote,
  drawStrip,
  drawSheetPanel,
  onSheetUp,
} from './castEditor';
import {
  loadSavedItems,
  idsForTab,
  itemTabIds,
  tabForItem,
  buildItemBuffer,
  loadItemIntoBuffer,
  commitItemEdit,
  persistItem,
  rebuildItemPicker,
  highlightItemTabs,
  drawItemPreview,
} from './itemEditor';
import { loadEntityIntoBuffer, commitEntityEdit, persistEntity } from './entityEditor';
import { loadStampIntoBuffer, persistStamp, rebuildStampList } from './stampEditor';
import { loadStamps, getStamps } from '../Stamps';
import { updateWalker, drawTestPane, finishTestPointer } from './testWalker';
import { buildPsiBuffer, rebuildPsiPicker, loadPsiIntoBuffer, drawPsiPreview } from './psiEditor';
import { loadPsiCatalog, listPsi } from '../PsiCatalog';
import { loadPsiAnims } from '../PsiAnim';
import { buildDom } from './dom';

export type { SpriteEditorCallbacks };

// When the dev editor SHELL owns this overlay it registers a "return to game"
// hook here. F2 then exits all the way to the game (close overlay + exit shell)
// instead of just closing the overlay back to the shell — independent of which
// window keydown listener (shell's or ours) happens to fire first. Null when the
// editor is opened standalone (e.g. from character select), where F2 just closes.
let shellExit: (() => void) | null = null;
export function setSpriteEditorShellExit(fn: (() => void) | null): void {
  shellExit = fn;
}

export function isSpriteEditorOpen(): boolean {
  return S.open;
}

export async function openSpriteEditor(callbacks: SpriteEditorCallbacks = {}): Promise<void> {
  if (S.open) return;
  S.open = true;
  S.editorCallbacks = callbacks;
  setMuteButtonHidden(true); // this overlay is its own screen — hide game chrome

  await loadRoster();
  await loadOverridesDoc();
  await loadSavedItems(); // restore saved item edits before seeding the buffer
  await loadPsiCatalog(); // PSI ability list for the editor's PSI mode
  await loadPsiAnims(); // any authored PSI animations (overrides/psi_anim.json)
  await loadStamps(); // Room Builder tile-stamp library for the editor's Stamp mode
  if (callbacks.focusItem) S.itemEditId = callbacks.focusItem; // Item Manager handoff
  // Make sure itemEditId is a real, selectable item in some category (the module
  // default is a legacy seed id). If it isn't, fall back to the first item in the
  // first category. Then open on the tab/category that holds it.
  const cats = itemTabIds();
  const allTabIds = new Set(cats.flatMap((c) => idsForTab(c.id)));
  if (!S.itemEditId || !allTabIds.has(S.itemEditId)) {
    S.itemEditId = cats.map((c) => idsForTab(c.id)[0]).find(Boolean) ?? '';
  }
  S.itemTab = S.itemEditId ? tabForItem(S.itemEditId) : (cats[0]?.id ?? 'custom');
  buildItemBuffer();
  if (callbacks.focusPsi) S.psiEditId = callbacks.focusPsi; // PSI Manager handoff
  if (!S.psiEditId) S.psiEditId = listPsi()[0]?.id ?? '';
  buildPsiBuffer(); // seed the PSI frame buffers (Lifeup / first ability)

  buildDom();
  // Always seed a valid cast sheet first so Character mode is ready to switch to.
  await loadGroupIntoEditor(DEFAULT_GROUP);
  // Item Manager handoff: jump straight into Item mode on the chosen item.
  if (callbacks.focusItem) {
    setEditMode('item');
    loadItemIntoBuffer(callbacks.focusItem);
    S.itemPicker?.setValue(callbacks.focusItem);
  } else if (callbacks.focusPsi) {
    // PSI Manager handoff: S.psiEditId was set above, so the picker + buffer are
    // already on this move; just switch into PSI mode.
    setEditMode('psi');
  } else if (callbacks.focusChar != null && Number.isInteger(callbacks.focusChar)) {
    // Entity Manager handoff: a custom group → Entity mode (paintable); a ROM
    // cast/vehicle group → Character mode.
    if (callbacks.focusChar >= CUSTOM_GROUP_BASE) await selectEntity(callbacks.focusChar);
    else await loadGroupIntoEditor(callbacks.focusChar);
  } else if (callbacks.focusStamp) {
    // Room Builder handoff: clean up a tile stamp. setEditMode('stamp') loads it.
    S.stampEditId = callbacks.focusStamp;
    setEditMode('stamp');
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mouseup', onGlobalMouseUp);
  setAutosaver(() => persistGroup(true)); // realtime: edits save themselves
  S.dirty = true;
  S.rafId = requestAnimationFrame(tick);
}

export function closeSpriteEditor(): void {
  if (!S.open) return;
  flushAutosave(); // write any pending edit before tearing down (still open here)
  S.open = false;
  setMuteButtonHidden(false); // back to the game — restore the mute button
  cancelAnimationFrame(S.rafId);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('mouseup', onGlobalMouseUp);
  S.heldKeys.clear();
  S.overlay?.remove();
  S.overlay = null;
  S.toolButtons.clear();
  S.modeButtons.clear();
  S.swatchEls = [];
  S.paletteGrid = null;
  S.itemPicker = null;
  S.itemRow = null;
  S.itemPickerHost = null;
  S.charPicker = null;
  S.charRow = null;
  S.mirrorToggle = null;
  S.mirrorRow = null;
  S.psiPicker = null;
  S.psiRow = null;
  S.psiPickerHost = null;
  S.psiDeliverySel = null;
  S.psiNote = null;
  S.psiFrameBuffers = [];
  S.psiFrameCtxs = [];
  S.psiCanvas = null;
  S.psiCtx = null;
  S.entityCanvas = null;
  S.entityCtx = null;
  S.entityUndo = [];
  S.entityRow = null;
  S.entityNote = null;
  S.entityScaleInput = null;
  S.stampRow = null;
  S.stampNote = null;
  S.stampListHost = null;
  S.stampEditId = '';
  S.charNote = null;
  S.nameInput = null;
  S.copyNote = null;
  S.clipboard = null;
  S.selection = null;
  S.marqueeAnchor = null;
  S.moveState = null;
  S.sheet = null;
  S.sheetCtx = null;
  S.pristineSheet = null;
  S.editMode = 'char';
}

function cancelEditor(): void {
  if (!S.open) return;
  const cb = S.editorCallbacks.onCancel;
  closeSpriteEditor();
  cb?.();
}

/** Enter Entity mode on a custom sprite group (Source Assets import): load its
 *  frame into the paint buffer, then switch mode. Used by the character picker
 *  (custom ids) and the Entity Manager handoff. */
export async function selectEntity(id: number): Promise<void> {
  await loadEntityIntoBuffer(id);
  // Per-entity mirror setting (custom ids default OFF — stay as-is every facing).
  const mv = S.overridesDoc.groups?.[String(id)]?.mirror;
  S.mirrorLR = mv !== undefined ? mv : id < CUSTOM_GROUP_BASE;
  if (S.mirrorToggle) S.mirrorToggle.checked = S.mirrorLR;
  setEditMode('entity');
}

/** Toggle left↔right mirroring for the current sprite (character OR entity). ON:
 *  west facings render as a flip of east. OFF: each facing renders its own cell
 *  as-is (independent west art / a static entity). Applies live to the world +
 *  test pane and persists per group to overrides/sprites.json. */
export function setMirrorLR(on: boolean): void {
  if (S.mirrorLR === on) return;
  S.mirrorLR = on;
  if (S.mirrorToggle) S.mirrorToggle.checked = on;

  if (S.editMode === 'item') {
    // Held items mirror via their own flag in item_sprites.json (a different art
    // pipeline from character/entity sheets).
    setItemMirror(S.itemEditId, on); // live: drawHeldItem stops/starts flipping
    persistItem(); // writes the flag (persistItem carries mirror through)
    S.dirty = true;
    return;
  }

  const id = S.editMode === 'entity' ? S.entityEditId : S.groupId;
  setGroupMirror(id, on); // live: the renderer flips (or stops) immediately

  if (S.editMode === 'char') {
    // Character sheets edit only the east cells when mirroring; turning it back
    // ON resyncs the west cells to flips of east so the strip/export stay tidy.
    if (on) {
      pushUndo();
      remirrorAll();
    }
    persistGroup(true); // captureGroupDiff writes the flag (+ any resync'd pixels)
  } else {
    persistMirrorFlag(id, on); // entity: write just the flag to sprites.json
  }
  S.dirty = true; // char strip switches between 5-dir and 8-dir layouts
}

/** Write a group's mirror flag into the editor's sprites.json doc and save it.
 *  Used for entities (whose pixels live in custom_sprites.json), so the runtime
 *  renderer — which reads sprites.json — picks the flag up on reload. */
function persistMirrorFlag(id: number, on: boolean): void {
  const groups = (S.overridesDoc.groups ??= {});
  const key = String(id);
  if (on === id < CUSTOM_GROUP_BASE) {
    // Back to the default for this id: drop the flag (and a now-empty entry).
    if (groups[key]) {
      delete groups[key].mirror;
      if (!groups[key].paint && !groups[key].erase) delete groups[key];
    }
  } else {
    groups[key] = { ...(groups[key] ?? {}), mirror: on };
  }
  setSaveStatus('saving');
  void postOverride('sprites.json', S.overridesDoc)
    .then(() => setSaveStatus('saved'))
    .catch(() => setSaveStatus('error'));
}

export function setEditMode(m: EditMode): void {
  for (const [key, btn] of S.modeButtons) {
    btn.style.borderColor = key === m ? '#9af' : '#444';
    btn.style.color = key === m ? '#fff' : '#ddd';
  }
  if (S.editMode === m) return;
  S.editMode = m;
  clearSelection(); // char cells, item buffers, and PSI frames differ in geometry
  // CHARACTER picker/rename only belong to Character + Entity modes (both pick
  // from that dropdown). In Item/PSI mode it's irrelevant clutter — hide it.
  if (S.charRow) S.charRow.style.display = m === 'char' || m === 'entity' ? 'flex' : 'none';
  // Mirror toggle applies to any directional sprite — character, entity, or item;
  // PSI (no facing) and stamps (flat tiles) hide it.
  if (S.mirrorRow) S.mirrorRow.style.display = m === 'psi' || m === 'stamp' ? 'none' : 'flex';
  if (S.itemRow) S.itemRow.style.display = m === 'item' ? 'flex' : 'none';
  if (S.psiRow) S.psiRow.style.display = m === 'psi' ? 'flex' : 'none';
  if (S.entityRow) S.entityRow.style.display = m === 'entity' ? 'flex' : 'none';
  if (S.stampRow) S.stampRow.style.display = m === 'stamp' ? 'flex' : 'none';
  if (m === 'item') {
    S.colorIndex = 1;
    S.itemTab = tabForItem(S.itemEditId); // open on the tab holding the current item
    rebuildItemPicker();
    highlightItemTabs();
    loadItemIntoBuffer(S.itemEditId); // also sets walkerItem so it previews on the character
  } else if (m === 'psi') {
    S.colorIndex = 1;
    S.walkerItem = null;
    rebuildPsiPicker();
    if (S.psiEditId) loadPsiIntoBuffer(S.psiEditId);
  } else if (m === 'stamp') {
    S.walkerItem = null;
    rebuildStampList();
    const list = getStamps();
    if (!S.stampEditId || !list.some((s) => s.id === S.stampEditId)) {
      S.stampEditId = list[0]?.id ?? '';
    }
    if (S.stampEditId) void loadStampIntoBuffer(S.stampEditId).then(rebuildStampList);
  } else if (m === 'char') {
    S.walkerItem = null;
    // Returning to Character mode while the selection is a custom entity (or the
    // cast sheet was torn down) would paint the wrong surface — reload a real cast
    // group so Character mode always has a 16×24 sheet.
    if (S.groupId >= CUSTOM_GROUP_BASE || !S.sheet) {
      void loadGroupIntoEditor(DEFAULT_GROUP); // sets the mirror toggle itself
    } else {
      // Sheet kept — refresh the mirror toggle to THIS character's saved flag
      // (it was showing the item/entity we switched away from).
      const mv = S.overridesDoc.groups?.[String(S.groupId)]?.mirror;
      S.mirrorLR = mv !== undefined ? mv : S.groupId < CUSTOM_GROUP_BASE;
      if (S.mirrorToggle) S.mirrorToggle.checked = S.mirrorLR;
    }
    if (S.itemNote) S.itemNote.textContent = 'Item: none (G cycles)';
  } else {
    // entity mode: the buffer + palette were set by loadEntityIntoBuffer already.
    S.walkerItem = null;
  }
  renderSwatches();
  S.dirty = true;
}

/**
 * Save the active surface. In Item mode this commits + persists the held-item
 * art and confirms on the item note. In Character mode it diffs the whole sheet
 * vs pristine into overrides/sprites.json (+ custom frames into sprite_frames.json).
 */
/** Manual save (Ctrl+S). Edits already auto-save in realtime; this just forces
 *  one now and flashes the banner. */
export function saveCurrentGroup(): void {
  persistGroup(false);
}

/**
 * Persist the active surface. `quiet` is the realtime auto-save path (status pip
 * only); loud (false) is a manual Ctrl+S that also flashes the banner. Mid-stroke
 * it re-arms the debounce so the finished stroke is what gets written.
 */
function persistGroup(quiet: boolean): void {
  if (!S.open) return;
  // An edit gesture in flight (paint stroke, marquee, move-drag, or transform)
  // leaves the sheet mid-operation — e.g. a move lifts pixels, leaving a hole.
  // Defer the save until it settles so we never persist a transient state.
  if (S.painting || S.moveState || S.xformState || S.marqueeAnchor) {
    requestAutosave();
    return;
  }
  if (S.editMode === 'item') {
    commitItemEdit();
    persistItem();
    setSaveStatus('saved');
    if (!quiet) {
      const label = `Item saved: ${getItemName(S.itemEditId) ?? S.itemEditId}`;
      if (S.itemNote) S.itemNote.textContent = label;
      flashSaved(`💾 ${label}`);
    }
    return;
  }
  if (S.editMode === 'entity') {
    commitEntityEdit();
    persistEntity();
    setSaveStatus('saved');
    if (!quiet) flashSaved('💾 Entity sprite saved');
    return;
  }
  if (S.editMode === 'stamp') {
    setSaveStatus('saving');
    void persistStamp()
      .then(() => {
        setSaveStatus('saved');
        if (!quiet) flashSaved('💾 Stamp saved');
      })
      .catch(() => setSaveStatus('error'));
    return;
  }
  if (!sheetReady()) return;
  captureGroupDiff();
  captureCustomFramePixels(); // snapshot each custom frame's pixels into framesDoc
  setSaveStatus('saving');
  void Promise.all([
    postOverride('sprites.json', S.overridesDoc),
    postOverride('sprite_frames.json', S.framesDoc),
  ])
    .then(() => {
      setSaveStatus('saved');
      updateCharNote(' — saved');
      if (!quiet) flashSaved('💾 Saved');
    })
    .catch((err) => {
      setSaveStatus('error');
      if (S.charNote) S.charNote.textContent = `save failed: ${String(err)}`;
      flashSaved(`⚠ Save failed: ${String(err)}`, true);
    });
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent): void {
  // F2 closes the editor from ANYWHERE — even with a field focused. It's a
  // function key (never a text character), so we don't let the typing bail
  // below swallow it; blur the field first so its keystrokes stop. When the
  // shell owns this editor it intercepts F2 before us and tears us down too;
  // this branch only matters when the editor is opened standalone (char select).
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (e.key === 'F2') {
    e.preventDefault();
    // Don't let this bubble to the entry listener (index.ts) — it would see the
    // shell inactive and open the editor shell right as we close.
    e.stopImmediatePropagation();
    if (typing) (document.activeElement as HTMLElement | null)?.blur();
    // Shell-owned: F2 means "back to the game", so close the overlay AND exit the
    // shell. Standalone: just close the overlay (cancelEditor → onCancel).
    if (shellExit) {
      const exit = shellExit;
      closeSpriteEditor();
      exit();
    } else {
      cancelEditor();
    }
    return;
  }
  // While typing in a field (the sprite picker's search, the rename box), let
  // the key reach the input — don't steal it for WASD/tool hotkeys.
  if (typing) return;
  e.stopPropagation();
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    if (S.selection || S.moveState) {
      clearSelection(); // drop the selection first; press again to exit
      S.dirty = true;
      return;
    }
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
    copySelection();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'v') {
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (k === '1' || k === 'q') setTool('pencil');
  else if (k === '2' || k === 'e') setTool('eraser');
  else if (k === '3') setTool('eyedrop');
  else if (k === '4' || k === 'm') setTool('select');
  else if (k === '5') setTool('move');
  else if (k === '6' || k === 'b') setTool('fill');
  else if (k === '7' || k === 'r') setTool('rotate');
  else if (k === '8' || k === 'k') setTool('skew');
  else if (k === 'w' || k === 'a' || k === 's' || k === 'd') S.heldKeys.add(k);
  else if (k === 'f' && S.walkerPose === 'walk') {
    S.walkerPose = 'attack'; // preview the attack rows
    S.walkerPoseTimer = 0;
  } else if (k === 'h' && S.walkerPose === 'walk') {
    S.walkerPose = 'hurt'; // preview the hurt row
    S.walkerPoseTimer = 0;
  } else if (k === 'p' && S.walkerPose === 'walk') {
    S.walkerPose = 'peace'; // hold the victory pose until you move
    S.walkerClimb = null;
    S.walkerPoseTimer = 0;
  } else if (k === 'l' && S.walkerPose === 'walk') {
    S.walkerPose = 'laying'; // hold the laying pose until you move
    S.walkerClimb = null;
    S.walkerPoseTimer = 0;
  } else if (k === 'g') {
    if (S.editMode === 'item') {
      // Cycle which item is being edited within the active tab (picker in sync).
      const list = idsForTab(S.itemTab);
      const i = list.indexOf(S.itemEditId);
      const next = list[(i + 1) % list.length];
      loadItemIntoBuffer(next); // updates the item buffer/thumb
      S.itemPicker?.setValue(next); // keep the dropdown in sync
      S.dirty = true;
    } else {
      S.walkerItem = nextHeldItem(S.walkerItem); // preview held-item overlays
      if (S.itemNote)
        S.itemNote.textContent = `Item: ${S.walkerItem ? getItemName(S.walkerItem) : 'none'} (G cycles)`;
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  e.stopPropagation();
  S.heldKeys.delete(e.key.toLowerCase());
}

function onGlobalMouseUp(): void {
  if (S.addingFrame && S.frameDrag) {
    onSheetUp();
    return;
  }
  if (finishTestPointer()) return;
  finishEditInteraction();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function tick(): void {
  if (!S.open) return;
  updateWalker();
  if (S.dirty) {
    drawEditCanvas();
    drawStrip();
    drawSheetPanel();
    S.dirty = false;
  }
  drawTestPane();
  if (S.editMode === 'psi') drawPsiPreview();
  else drawItemPreview();
  S.rafId = requestAnimationFrame(tick);
}
