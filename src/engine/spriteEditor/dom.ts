// DOM construction for the editor overlay: the tool/character/item panel, the
// FRAMES strip, the EDIT canvas, the LIVE TEST pane, and the full-width SHEET
// panel. Wires each control to the handlers in the concern modules.
import { createSpritePicker, drawSpriteGroupThumb } from '../SpritePicker';
import { getSpriteName } from '../SpriteNames';
import { ITEM_W, ITEM_H } from '../Items';
import {
  FRAME_W,
  FRAME_H,
  ZOOM,
  TEST_W,
  TEST_H,
  TEST_SCALE,
  STRIP_W,
  STRIP_FRAME_W,
  STRIP_FRAME_H,
  STRIP_SET_W,
  VEHICLE_GROUPS,
  vehicleName,
  setSrc,
  stripFramesX,
  Tool,
  EditMode,
} from './constants';
import { S } from './state';
import {
  setTool,
  setColor,
  renderSwatches,
  onEditDown,
  onEditMove,
  clearSelection,
  flipH,
  flipV,
  rotate90,
  copySelection,
  pasteClipboard,
} from './pixelCanvas';
import {
  loadGroupIntoEditor,
  saveCharName,
  exportPNG,
  importPNG,
  resetSelectedFrame,
  allDisplayRows,
  stripHeight,
  syncNewFrameBtn,
  onSheetDown,
  onSheetMove,
} from './castEditor';
import {
  selectItemTab,
  rebuildItemPicker,
  highlightItemTabs,
  createCustomItem,
  resetItemToHand,
  setItemEditFrame,
  itemTabIds,
} from './itemEditor';
import { onTestDown, onTestMove } from './testWalker';
import { setEditMode } from './index';

export function buildDom(): void {
  S.overlay = document.createElement('div');
  // Docked to the LEFT of the editor's right-side tool column (256px wide, see
  // EditorShell.buildDock) rather than full-screen, so the tool dock stays
  // visible. `right:256px` leaves that column clear; top:31px sits below the
  // shell's HUD bar.
  S.overlay.style.cssText =
    'position:fixed;left:0;top:31px;right:256px;bottom:0;z-index:95;background:#16161e;color:#ddd;' +
    'font:12px monospace;display:flex;flex-direction:column;align-items:center;' +
    'overflow:auto;user-select:none;';

  const title = document.createElement('div');
  title.textContent =
    'SPRITE EDITOR — attack/hurt frames + held items   (pick a character · Character/Item modes · WASD: test walk · F attack · H hurt · tools 1-8: pencil/eraser/eyedrop/select/move/fill/rotate/skew · marquee a region then ⇄⇅ mirror, ⟲⟳ 90°, or DRAG to free-rotate (Shift=15° snap) / skew · Alt+click: eyedrop · G: cycle item · Ctrl+C/V: copy/paste selection or frame · Ctrl+Z: undo · Esc: deselect/back · edits save automatically · Export/Import PNG)';
  title.style.cssText = 'padding:10px;color:#fff;letter-spacing:1px;';
  S.overlay.appendChild(title);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:16px;align-items:flex-start;';
  S.overlay.appendChild(row);

  row.appendChild(buildToolPanel());
  row.appendChild(buildStripPanel());
  row.appendChild(buildEditPanel());
  row.appendChild(buildTestPanel());

  // Full-width SHEET panel below the row: the whole sheet + add-frame tool.
  S.overlay.appendChild(buildSheetPanel());

  document.body.appendChild(S.overlay);
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
  S.charPicker = createSpritePicker({
    sections: [
      { values: S.roster.map(String) },
      { label: 'Vehicles (view only)', values: VEHICLE_GROUPS.map((v) => String(v.id)) },
    ],
    initial: String(S.groupId),
    labelFor: (v) => `${v} ${getSpriteName(Number(v)) ?? vehicleName(Number(v)) ?? ''}`.trim(),
    drawThumb: drawSpriteGroupThumb,
    onSelect: (v) => void loadGroupIntoEditor(Number(v)),
  });
  div.appendChild(S.charPicker.el);

  S.charNote = document.createElement('div');
  S.charNote.style.cssText = 'color:#9fd; font-size:10px; min-height:12px;';
  div.appendChild(S.charNote);

  // Rename: edit the display name, written to overrides/names.json on save.
  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;gap:6px;';
  S.nameInput = document.createElement('input');
  S.nameInput.type = 'text';
  S.nameInput.placeholder = 'rename…';
  S.nameInput.style.cssText =
    'flex:1;min-width:0;font:11px monospace;padding:4px;background:#2a2a3a;' +
    'color:#ddd;border:1px solid #444;border-radius:3px;';
  // Don't let the editor's global hotkeys fire while typing a name.
  S.nameInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') saveCharName();
  };
  nameRow.appendChild(S.nameInput);
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
    S.modeButtons.set(m, btn);
    modeRow.appendChild(btn);
  }
  div.appendChild(modeRow);

  // Item UI (item mode only): one tab per item CATEGORY (the same Food/Weapons/…
  // folders the Item Manager organizes — see ItemFolders), the item dropdown
  // (rebuilt per tab), and a New-item button. Hidden until Item mode.
  S.itemRow = document.createElement('div');
  S.itemRow.style.cssText = 'display:none;flex-direction:column;gap:5px;';

  const itemTabs = document.createElement('div');
  // Many categories — wrap into rows of compact chips so they all stay visible.
  itemTabs.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
  for (const { id: t, name } of itemTabIds()) {
    const b = document.createElement('button');
    b.textContent = name;
    b.dataset.itab = t;
    b.style.cssText =
      'flex:1 0 auto;font:11px monospace;padding:4px 7px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;white-space:nowrap;';
    b.onclick = () => selectItemTab(t);
    itemTabs.appendChild(b);
  }
  S.itemRow.appendChild(itemTabs);

  S.itemPickerHost = document.createElement('div');
  S.itemRow.appendChild(S.itemPickerHost);

  // Frame selection is on the FRAMES strip itself — click a frame to edit it.

  const newItemBtn = document.createElement('button');
  newItemBtn.textContent = '+ New custom item';
  newItemBtn.title = 'Create a blank custom item (stored in overrides/custom_items.json)';
  newItemBtn.style.cssText =
    'font:11px monospace;padding:4px 8px;background:#10301c;color:#7fe0a0;' +
    'border:1px solid #2e6e44;border-radius:3px;cursor:pointer;';
  newItemBtn.onclick = createCustomItem;
  S.itemRow.appendChild(newItemBtn);

  // Drag the item on the live-test character to position it (badge → chest);
  // this button reverts to a hand-held weapon (clears the body offset).
  const posNote = document.createElement('div');
  posNote.textContent = 'Position: drag the item on the test character (e.g. badge → chest)';
  posNote.style.cssText = 'color:#9ab;font-size:10px;';
  S.itemRow.appendChild(posNote);
  const resetHandBtn = document.createElement('button');
  resetHandBtn.textContent = '↩ Hand-held (reset position)';
  resetHandBtn.title = 'Clear the body-mount offset — back to a hand-held weapon';
  resetHandBtn.style.cssText =
    'font:11px monospace;padding:4px 8px;background:#2a2433;color:#cdb6ff;' +
    'border:1px solid #5a4a78;border-radius:3px;cursor:pointer;';
  resetHandBtn.onclick = resetItemToHand;
  S.itemRow.appendChild(resetHandBtn);

  div.appendChild(S.itemRow);
  rebuildItemPicker();
  highlightItemTabs();

  const tools: [Tool, string][] = [
    ['pencil', '1/Q ✏ Pencil'],
    ['eraser', '2/E ▭ Eraser'],
    ['eyedrop', '3 ⊕ Eyedrop'],
    ['fill', '6/B ▥ Fill'],
    ['select', '4/M ⛶ Select'],
    ['move', '5 ✥ Move'],
    ['rotate', '7/R ⟳ Rotate (drag)'],
    ['skew', '8/K ▱ Skew (drag)'],
  ];
  for (const [t, label] of tools) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      'font:12px monospace;padding:5px 8px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;text-align:left;';
    btn.onclick = () => setTool(t);
    S.toolButtons.set(t, btn);
    div.appendChild(btn);
  }

  const palHead = document.createElement('div');
  palHead.textContent = 'PALETTE';
  palHead.style.cssText = 'margin-top:8px;color:#9af;font-size:11px;letter-spacing:1px;';
  div.appendChild(palHead);

  S.paletteGrid = document.createElement('div');
  S.paletteGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,24px);gap:3px;';
  div.appendChild(S.paletteGrid);
  renderSwatches();

  const reset = document.createElement('button');
  reset.textContent = 'Reset frame';
  reset.title = 'Restore the selected attack/hurt frame to its generated default';
  reset.style.cssText =
    'margin-top:10px;font:11px monospace;padding:4px 6px;background:#3a2a2a;' +
    'color:#fbb;border:1px solid #644;border-radius:3px;cursor:pointer;';
  reset.onclick = resetSelectedFrame;
  div.appendChild(reset);

  // Realtime auto-save status — edits persist automatically; no Save button.
  const status = document.createElement('div');
  status.dataset.role = 'save-status';
  status.textContent = '✓ saved';
  status.title = 'Edits save automatically as you draw (Ctrl+S forces one now)';
  status.style.cssText = 'margin-top:6px;font:11px monospace;color:#7c7;min-height:14px;';
  div.appendChild(status);

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
      'Load an edited PNG back in (colors snap to palette). Saves automatically.',
      importPNG
    )
  );
  div.appendChild(ioRow);

  setTool('pencil');
  setColor(S.colorIndex);
  setEditMode('char'); // highlight the default mode button
  return div;
}

function buildStripPanel(): HTMLDivElement {
  const div = panel('FRAMES');
  S.stripCanvas = document.createElement('canvas');
  S.stripCanvas.width = STRIP_W;
  S.stripCanvas.height = stripHeight();
  S.stripCanvas.style.cssText = 'image-rendering:pixelated;cursor:pointer;';
  S.stripCanvas.onmousedown = (e) => {
    const r = S.stripCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Item mode: the strip IS the frame selector — click a frame to edit it.
    if (S.editMode === 'item') {
      const i = S.stripCellRects.findIndex(
        (c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h
      );
      if (i >= 0) setItemEditFrame(i);
      return;
    }
    if (S.viewOnly) return; // read-only vehicle grid: nothing to select
    const dr = Math.floor(y / STRIP_FRAME_H);
    const displayRow = allDisplayRows()[dr];
    if (!displayRow) return;
    // Select a canonical set only when x lands on it (not a label gutter).
    for (let s = 0; s < displayRow.length; s++) {
      const fx = stripFramesX(s);
      if (x >= fx && x < fx + STRIP_SET_W) {
        const set = displayRow[s];
        S.selRow = set.row;
        if (set.single) {
          S.selCol = set.col; // one sprite — the whole entry is the selection
          S.selW = set.single.w;
          S.selH = set.single.h;
          const src = setSrc(set);
          S.selOX = src.x; // singles may have px/py overrides — honor them
          S.selOY = src.y;
        } else {
          S.selCol = set.col + Math.floor((x - fx) / STRIP_FRAME_W); // frame 0 or 1
          S.selW = FRAME_W;
          S.selH = FRAME_H;
          // Origin must follow the clicked frame, not the set's frame-0 cell.
          S.selOX = S.selCol * FRAME_W;
          S.selOY = S.selRow * FRAME_H;
        }
        clearSelection(); // different cell — drop any pixel selection
        S.dirty = true;
        break;
      }
    }
  };
  div.appendChild(S.stripCanvas);

  const note = document.createElement('div');
  note.textContent = 'W · NW · SW auto-mirror from E · NE · SE';
  note.style.cssText = 'color:#888;font-size:10px;margin-top:4px;';
  div.appendChild(note);
  return div;
}

function buildEditPanel(): HTMLDivElement {
  const div = panel('EDIT — 16×24');
  S.editCanvas = document.createElement('canvas');
  S.editCanvas.width = FRAME_W * ZOOM;
  S.editCanvas.height = FRAME_H * ZOOM;
  S.editCanvas.style.cssText = 'image-rendering:pixelated;cursor:crosshair;';
  S.editCanvas.oncontextmenu = (e) => e.preventDefault();
  S.editCanvas.onmousedown = (e) => onEditDown(e);
  S.editCanvas.onmousemove = (e) => onEditMove(e);
  div.appendChild(S.editCanvas);

  const mkBtn = (label: string, fn: () => void, title?: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (title) b.title = title;
    b.style.cssText =
      'flex:1;font:11px monospace;padding:4px 6px;background:#2a2a3a;color:#ddd;' +
      'border:1px solid #444;border-radius:3px;cursor:pointer;';
    b.onclick = fn;
    return b;
  };

  // Transform row — quick mirror / 90° rotate of the selection (or whole frame).
  // Free-angle rotate and skew are the drag TOOLS (7/R and 8/K).
  const xfRow = document.createElement('div');
  xfRow.style.cssText = 'display:flex;gap:4px;margin-top:2px;';
  xfRow.appendChild(mkBtn('⇄', flipH, 'Mirror horizontally (selection or frame)'));
  xfRow.appendChild(mkBtn('⇅', flipV, 'Mirror vertically'));
  xfRow.appendChild(mkBtn('⟲ 90', () => rotate90(false), 'Rotate 90° counter-clockwise'));
  xfRow.appendChild(mkBtn('90 ⟳', () => rotate90(true), 'Rotate 90° clockwise'));
  div.appendChild(xfRow);

  // Copy / paste the marquee selection (or the whole frame when none is set).
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
  btnRow.appendChild(mkBtn('⧉ Copy', copySelection, 'Ctrl+C — copy selection or frame'));
  btnRow.appendChild(
    mkBtn('⊞ Paste', pasteClipboard, 'Ctrl+V — paste at the selection / frame origin')
  );
  div.appendChild(btnRow);

  S.copyNote = document.createElement('div');
  S.copyNote.textContent = 'Clipboard: empty';
  S.copyNote.style.cssText = 'color:#888;font-size:10px;';
  div.appendChild(S.copyNote);
  return div;
}

function buildTestPanel(): HTMLDivElement {
  const div = panel(
    'LIVE TEST — WASD walk · click or F: attack · H hurt · G item · drag item to position'
  );
  S.testCanvas = document.createElement('canvas');
  S.testCanvas.width = TEST_W * TEST_SCALE;
  S.testCanvas.height = TEST_H * TEST_SCALE;
  S.testCanvas.style.cssText = 'image-rendering:pixelated;background:#3a6a44;';
  // Drag the held item on the character to set its body-mount offset (Item mode).
  S.testCanvas.onmousedown = (e) => onTestDown(e);
  S.testCanvas.onmousemove = (e) => onTestMove(e);
  div.appendChild(S.testCanvas);

  const note = document.createElement('div');
  note.textContent =
    'Compiled through the real game sprite path. Walk onto the ladder/rope to test climb; P = peace pose, L = laying (move to exit).';
  note.style.cssText = 'color:#888;font-size:10px;max-width:' + TEST_W * TEST_SCALE + 'px;';
  div.appendChild(note);

  S.itemNote = document.createElement('div');
  S.itemNote.textContent = 'Item: none (G cycles)';
  S.itemNote.style.cssText = 'color:#888;font-size:10px;';
  div.appendChild(S.itemNote);

  // 2nd live test (item mode only): a close-up that loops just the item's 3
  // frames, so you see the weapon's own swing animation while editing.
  const itemTestWrap = document.createElement('div');
  itemTestWrap.dataset.role = 'item-test';
  itemTestWrap.style.cssText = 'display:none;flex-direction:column;gap:3px;margin-top:6px;';
  const itemTestLbl = document.createElement('div');
  itemTestLbl.textContent = 'ITEM SWING (loops the 3 frames)';
  itemTestLbl.style.cssText = 'color:#9ab;font-size:10px;letter-spacing:0.5px;';
  itemTestWrap.appendChild(itemTestLbl);
  S.itemTestCanvas = document.createElement('canvas');
  const ITEM_TEST_SCALE = 5;
  S.itemTestCanvas.width = ITEM_W * ITEM_TEST_SCALE;
  S.itemTestCanvas.height = ITEM_H * ITEM_TEST_SCALE;
  S.itemTestCanvas.style.cssText =
    'image-rendering:pixelated;background:#222;border:1px solid #444;border-radius:3px;align-self:flex-start;';
  itemTestWrap.appendChild(S.itemTestCanvas);
  div.appendChild(itemTestWrap);
  return div;
}

function buildSheetPanel(): HTMLDivElement {
  const div = panel('SHEET — add & edit frames');
  div.style.maxWidth = '90vw';

  S.newFrameBtn = document.createElement('button');
  S.newFrameBtn.textContent = '+ New Frame';
  S.newFrameBtn.title = 'Drag a region on the sheet (snaps to 8px). Drag past the edge to grow it.';
  S.newFrameBtn.style.cssText =
    'align-self:flex-start;margin-bottom:6px;padding:4px 10px;background:#2a3550;color:#cde;' +
    'border:1px solid #4a5a80;border-radius:3px;cursor:pointer;font:11px monospace;';
  S.newFrameBtn.onclick = () => {
    S.addingFrame = !S.addingFrame;
    S.frameDrag = null;
    syncNewFrameBtn();
    S.dirty = true;
  };
  div.appendChild(S.newFrameBtn);

  S.sheetCanvas = document.createElement('canvas');
  S.sheetCanvas.style.cssText = 'image-rendering:pixelated;border:1px solid #333;cursor:crosshair;';
  S.sheetCanvas.oncontextmenu = (e) => e.preventDefault();
  S.sheetCanvas.onmousedown = onSheetDown;
  S.sheetCanvas.onmousemove = onSheetMove;
  // mouseup is handled by the editor's existing global onGlobalMouseUp.
  div.appendChild(S.sheetCanvas);

  const note = document.createElement('div');
  note.dataset.role = 'sheet-note';
  note.textContent =
    'Click + New Frame, then drag a box on the sheet. Click a frame in FRAMES to edit it.';
  note.style.cssText = 'color:#888;font-size:10px;margin-top:4px;max-width:480px;';
  div.appendChild(note);
  return div;
}
