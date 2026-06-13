import { EditorCommand } from './types';

// Shared undo/redo history across all editor tools (Ctrl+Z / Ctrl+Y in the
// shell). Executing a new command clears the redo branch, like every editor.

const UNDO_LIMIT = 200;

export class CommandStack {
  private undoStack: EditorCommand[] = [];
  private redoStack: EditorCommand[] = [];

  run(cmd: EditorCommand): void {
    cmd.do();
    this.undoStack.push(cmd);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): EditorCommand | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(): EditorCommand | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.do();
    this.undoStack.push(cmd);
    return cmd;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
