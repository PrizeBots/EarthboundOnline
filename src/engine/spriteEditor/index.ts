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
import { nextHeldItem, getItemName } from '../Items';
import { DEFAULT_GROUP, EditMode, SpriteEditorCallbacks } from './constants';
import { S } from './state';
import { flashSaved, postOverride } from './saveChannel';
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
  tabForItem,
  buildItemBuffer,
  loadItemIntoBuffer,
  commitItemEdit,
  persistItem,
  rebuildItemPicker,
  highlightItemTabs,
  drawItemPreview,
} from './itemEditor';
import { updateWalker, drawTestPane, finishTestPointer } from './testWalker';
import { buildDom } from './dom';

export type { SpriteEditorCallbacks };

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
  if (callbacks.focusItem) S.itemEditId = callbacks.focusItem; // Item Manager handoff
  // Make sure itemEditId is a real, selectable item across the three tabs (the
  // module default is a legacy seed id). If it isn't, fall back to the first
  // weapon/item/custom available. Then open on the tab that holds it.
  const allTabIds = new Set([
    ...idsForTab('weapons'),
    ...idsForTab('items'),
    ...idsForTab('custom'),
  ]);
  if (!S.itemEditId || !allTabIds.has(S.itemEditId)) {
    S.itemEditId = idsForTab('weapons')[0] ?? idsForTab('items')[0] ?? idsForTab('custom')[0] ?? '';
  }
  S.itemTab = S.itemEditId ? tabForItem(S.itemEditId) : 'weapons';
  buildItemBuffer();

  buildDom();
  await loadGroupIntoEditor(DEFAULT_GROUP);
  // Item Manager handoff: jump straight into Item mode on the chosen item.
  if (callbacks.focusItem) {
    setEditMode('item');
    loadItemIntoBuffer(callbacks.focusItem);
    S.itemPicker?.setValue(callbacks.focusItem);
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mouseup', onGlobalMouseUp);
  S.dirty = true;
  S.rafId = requestAnimationFrame(tick);
}

export function closeSpriteEditor(): void {
  if (!S.open) return;
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

export function setEditMode(m: EditMode): void {
  for (const [key, btn] of S.modeButtons) {
    btn.style.borderColor = key === m ? '#9af' : '#444';
    btn.style.color = key === m ? '#fff' : '#ddd';
  }
  if (S.editMode === m) return;
  S.editMode = m;
  clearSelection(); // char cells and item buffers have different geometry
  if (S.itemRow) S.itemRow.style.display = m === 'item' ? 'flex' : 'none';
  if (m === 'item') {
    S.colorIndex = 1;
    S.itemTab = tabForItem(S.itemEditId); // open on the tab holding the current item
    rebuildItemPicker();
    highlightItemTabs();
    loadItemIntoBuffer(S.itemEditId); // also sets walkerItem so it previews on the character
  } else {
    S.walkerItem = null;
    if (S.itemNote) S.itemNote.textContent = 'Item: none (G cycles)';
  }
  renderSwatches();
  S.dirty = true;
}

/**
 * Save the active surface. In Item mode this commits + persists the held-item
 * art and confirms on the item note. In Character mode it diffs the whole sheet
 * vs pristine into overrides/sprites.json (+ custom frames into sprite_frames.json).
 */
export function saveCurrentGroup(): void {
  if (!S.open || S.painting) return;
  if (S.editMode === 'item') {
    commitItemEdit();
    persistItem();
    const label = `Item saved: ${getItemName(S.itemEditId) ?? S.itemEditId}`;
    if (S.itemNote) S.itemNote.textContent = label;
    flashSaved(`💾 ${label}`);
    return;
  }
  if (!sheetReady()) return;
  captureGroupDiff();
  captureCustomFramePixels(); // snapshot each custom frame's pixels into framesDoc
  void Promise.all([
    postOverride('sprites.json', S.overridesDoc),
    postOverride('sprite_frames.json', S.framesDoc),
  ])
    .then(() => {
      updateCharNote(' — saved');
      flashSaved('💾 Saved');
    })
    .catch((err) => {
      if (S.charNote) S.charNote.textContent = `save failed: ${String(err)}`;
      flashSaved(`⚠ Save failed: ${String(err)}`, true);
    });
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
  drawItemPreview();
  S.rafId = requestAnimationFrame(tick);
}
