// The Admin Hub used to be a modal overlay that tools launched from. It's been
// replaced by the EditorShell's persistent right-side tool dock (a tab menu +
// the active tool's panel), so admins flip between tools without leaving the
// editor. This module remains only as a convenience re-export of the tool/
// save-handler registry (a couple of tools import it from here).
export { registerEditorTool, registerSaveHandler } from './registry';
