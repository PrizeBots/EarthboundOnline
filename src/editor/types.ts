import { Camera } from '../engine/Camera';
import { Player } from '../engine/Player';

// Shared contracts for the dev-only editor layer (EDITOR_TOOLS.md). The whole
// `src/editor/` directory is loaded via a dev-gated dynamic import in Game and
// compiles out of production builds.

/** What Game hands the editor at init — the live world, not a copy. */
export interface EditorContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  player: Player;
  /** Proper jump with sector load + room crop (wraps Game.debugTeleport). */
  teleport: (x: number, y: number) => void;
  /** Stream tile atlases for the camera's current view (editor free-fly). */
  streamView: () => void;
  /** Gameplay states in which entering the editor is allowed. */
  canEnter: () => boolean;
  /**
   * Get into an editable state from a non-gameplay screen (e.g. character
   * select): starts the game as the default/selected character (Ness) and
   * resolves true once `canEnter()` would pass. Lets admins F2 in from any
   * screen instead of having to pick a character first.
   */
  ensurePlaying: () => Promise<boolean>;
}

export interface WorldPoint {
  x: number;
  y: number;
}

/** One undoable edit. Tools push these onto the shell's shared stack. */
export interface EditorCommand {
  label: string;
  do(): void;
  undo(): void;
}

/** What the shell offers an active tool. */
export interface EditorShellApi {
  context: EditorContext;
  /** The dock's panel area — a tool appends its DOM panel here (not body). */
  panelHost: HTMLElement;
  /** Push (and immediately execute) an undoable command. */
  run(cmd: EditorCommand): void;
  toast(message: string, isError?: boolean): void;
  markDirty(domain: string): void;
  clearDirty(domain: string): void;
  /** Switch to another registered tool by id (tool-to-tool handoff). */
  openTool(toolId: string): void;
}

/**
 * A tool that runs inside the Editor Shell. Tools self-register with the hub
 * (registerEditorTool) so adding one needs no hub edits.
 */
export interface EditorTool {
  id: string;
  name: string;
  description: string;
  status: 'ready' | 'wip';
  /**
   * Self-contained launcher: a tool that runs as its own full-screen overlay
   * (e.g. the Cast Sprite Editor) rather than inside the shell. When present,
   * clicking its hub tile closes the hub and calls this instead of setTool().
   */
  launch?(): void;
  activate?(shell: EditorShellApi): void;
  deactivate?(): void;
  /** Per-frame overlay, drawn in screen space after the shell's grids. */
  drawOverlay?(ctx: CanvasRenderingContext2D, camera: Camera): void;
  /** Return true to consume the event (otherwise the shell pans the camera). */
  onMouseDown?(p: WorldPoint): boolean;
  onMouseMove?(p: WorldPoint, dragging: boolean): void;
  onMouseUp?(p: WorldPoint): void;
  /** Lowercased key while the shell is active; return true to consume. */
  onKey?(key: string): boolean;
}
