// All mutable Cast Sprite Editor state, centralized in one object so the editor's
// modules (pixel engine, cast editor, item editor, test walker, DOM) can share it.
// ES modules can't share reassignable `let` bindings across files, so what used to
// be ~60 module-level `let`s now live as fields on `S`. Every module mutates `S.x`
// directly. Reset on close in ./index closeSpriteEditor().
import { SpriteOverrides } from '../SpriteManager';
import { SpritePicker } from '../SpritePicker';
import { Direction, Pose } from '../../types';
import {
  DEFAULT_GROUP,
  FRAME_W,
  FRAME_H,
  SHEET_W,
  SHEET_H,
  TEST_W,
  TEST_H,
  Tool,
  EditMode,
  PixelRect,
  CustomFrame,
  FramesDoc,
  SpriteEditorCallbacks,
} from './constants';
import { HELD_ITEM_IDS } from '../Items';

// The item picker is split into category tabs — the SAME category folders the
// Item Manager organizes (overrides/item_folders.json, see ItemFolders.ts). An
// ItemTab is just a category/folder id (e.g. 'weapons', 'food', 'custom').
export type ItemTab = string;

interface MoveState {
  pixels: HTMLCanvasElement; // the lifted region's art
  w: number;
  h: number;
  grabX: number; // pixel offset of the grab point inside the region
  grabY: number;
  x: number; // current top-left in region coords
  y: number;
}
interface XformState {
  kind: 'rotate' | 'skew';
  src: HTMLCanvasElement; // lifted region art
  r: PixelRect; // the region being transformed (region-local coords)
  startX: number; // grab point (fractional region px)
  startY: number;
  angle: number; // radians (rotate)
  shearX: number; // x += shearX*y (skew)
  shearY: number; // y += shearY*x
}
interface TestPointer {
  startLX: number;
  startLY: number;
  lastLX: number;
  lastLY: number;
  moved: boolean;
  canDragItem: boolean;
}

export const S = {
  open: false,
  overlay: null as HTMLDivElement | null,

  // The LIVE pose sheet of the character being edited (shared with the engine's
  // sprite cache — edits show in the world immediately) + a pristine copy of its
  // generated frames for diffing on save.
  sheet: null as HTMLCanvasElement | null,
  sheetCtx: null as CanvasRenderingContext2D | null,
  pristineSheet: null as HTMLCanvasElement | null,
  groupId: DEFAULT_GROUP,
  viewOnly: false, // true while previewing a non-editable group (vehicles)
  roster: [] as number[],
  overridesDoc: { version: 1, groups: {} } as SpriteOverrides,
  palette: [] as [number, number, number][],

  tool: 'pencil' as Tool,
  colorIndex: 1,

  // --- Selection / move state (region-local pixel coords) ---
  selection: null as PixelRect | null,
  marqueeAnchor: null as { x: number; y: number } | null,
  moveState: null as MoveState | null,
  xformState: null as XformState | null,

  // --- Item-editing mode ---
  editMode: 'char' as EditMode,
  itemEditId: (HELD_ITEM_IDS[0] ?? '') as string,
  itemFrameBuffers: [] as HTMLCanvasElement[],
  itemFrameCtxs: [] as CanvasRenderingContext2D[],
  itemEditFrame: 0,
  itemCanvas: null as HTMLCanvasElement | null, // = itemFrameBuffers[itemEditFrame]
  itemCtx: null as CanvasRenderingContext2D | null,
  itemUndo: [] as ImageData[],
  itemTestCanvas: null as HTMLCanvasElement | null,
  itemPreviewFrame: 0,
  itemPreviewTimer: 0,
  // Pointer on the LIVE TEST pane: a CLICK triggers an attack; a DRAG (item mode)
  // repositions the held item's body-mount offset.
  testPointer: null as TestPointer | null,
  // Per-cell hit boxes of the FRAMES strip (set by drawFramesGrid).
  stripCellRects: [] as { x: number; y: number; w: number; h: number }[],

  // --- Custom-entity-editing mode (single variable-size frame; Source Assets) ---
  // One paint buffer sized to the entity's frame (w×h). Palette is extracted from
  // the art into S.palette. Persists to overrides/custom_sprites.json (png layer).
  entityEditId: 0, // the custom sprite-group id being edited (>= CUSTOM_GROUP_BASE)
  entityCanvas: null as HTMLCanvasElement | null,
  entityCtx: null as CanvasRenderingContext2D | null,
  entityUndo: [] as ImageData[],
  entityW: 16,
  entityH: 16,
  entityRow: null as HTMLDivElement | null, // the entity UI (scale control + note)
  entityNote: null as HTMLDivElement | null,
  entityScaleInput: null as HTMLInputElement | null,

  // --- PSI-animation-editing mode (48x48 frames, variable count) ---
  psiEditId: '' as string, // active PSI ability id (from psi.json)
  psiDelivery: 'target' as 'caster' | 'target' | 'projectile',
  psiFrameBuffers: [] as HTMLCanvasElement[], // N 48x48 frame canvases
  psiFrameCtxs: [] as CanvasRenderingContext2D[],
  psiEditFrame: 0,
  psiCanvas: null as HTMLCanvasElement | null, // = psiFrameBuffers[psiEditFrame]
  psiCtx: null as CanvasRenderingContext2D | null,
  psiUndo: [] as ImageData[],
  psiPreviewFrame: 0,
  psiPreviewTimer: 0,
  psiPicker: null as SpritePicker | null,
  psiRow: null as HTMLDivElement | null, // the whole PSI UI (picker + delivery + frames)
  psiPickerHost: null as HTMLDivElement | null,
  psiDeliverySel: null as HTMLSelectElement | null,
  psiNote: null as HTMLDivElement | null,

  selRow: 1, // start on the south-facing frame — the classic editing view
  selCol: 0,
  // Pixel size of the currently selected frame.
  selW: FRAME_W,
  selH: FRAME_H,
  // Pixel origin of the selected region on the sheet.
  selOX: 0,
  selOY: 0,
  painting: false,
  strokeChanged: false,
  undoStack: [] as ImageData[],
  dirty: true,
  // Copied pixels (a whole frame, or a marquee selection).
  clipboard: null as ImageData | null,

  framesDoc: { version: 1, groups: {} } as FramesDoc,
  customFrames: [] as CustomFrame[], // current group's frames (alias into framesDoc)
  sheetPxH: SHEET_H, // live sheet canvas height; grows past SHEET_H for custom frames
  sheetPxW: SHEET_W, // live sheet canvas width; grows past SHEET_W if a frame extends right
  addingFrame: false, // true while the Sheet panel is in drag-to-create mode
  frameDrag: null as { x0: number; y0: number; x1: number; y1: number } | null,

  // DOM refs. editCanvas/stripCanvas/testCanvas are assigned in buildDom before
  // any handler or tick reads them, so they're typed non-null (matching the
  // original definite-assignment `let`s).
  editCanvas: null as unknown as HTMLCanvasElement,
  stripCanvas: null as unknown as HTMLCanvasElement,
  testCanvas: null as unknown as HTMLCanvasElement,
  sheetCanvas: null as HTMLCanvasElement | null, // the Sheet panel preview canvas
  newFrameBtn: null as HTMLButtonElement | null,
  itemNote: null as HTMLDivElement | null,
  copyNote: null as HTMLDivElement | null,
  toolButtons: new Map<Tool, HTMLButtonElement>(),
  swatchEls: [] as HTMLDivElement[],
  paletteGrid: null as HTMLDivElement | null,
  modeButtons: new Map<EditMode, HTMLButtonElement>(),
  charPicker: null as SpritePicker | null,
  itemPicker: null as SpritePicker | null,
  itemRow: null as HTMLDivElement | null, // the whole item UI (tabs + picker + new)
  itemPickerHost: null as HTMLDivElement | null, // the picker is rebuilt in here per tab
  itemTab: '' as ItemTab,
  charNote: null as HTMLDivElement | null,
  nameInput: null as HTMLInputElement | null,
  rafId: 0,

  // --- WASD walker state for the test pane ---
  heldKeys: new Set<string>(),
  walkerX: TEST_W / 2,
  walkerY: TEST_H / 2 + 12,
  walkerDir: Direction.S,
  walkerFrame: 0,
  walkerTimer: 0,
  walkerPose: 'walk' as Pose,
  walkerPoseTimer: 0,
  walkerItem: null as string | null,
  // Climb test: a ladder and a rope prop in the test pane.
  walkerClimb: null as 'ladder' | 'rope' | null,

  editorCallbacks: {} as SpriteEditorCallbacks,
  saveFlashTimer: 0,
};
