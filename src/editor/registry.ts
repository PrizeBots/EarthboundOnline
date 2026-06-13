import { EditorTool } from './types';

// Tool + save-handler registry, in its own module so tools, the hub, and the
// shell can all use it without import cycles.

const tools: EditorTool[] = [];
const saveHandlers = new Map<string, () => Promise<void>>();

export function registerEditorTool(tool: EditorTool): void {
  tools.push(tool);
}

export function getEditorTools(): readonly EditorTool[] {
  return tools;
}

export function findEditorTool(id: string): EditorTool | undefined {
  return tools.find((t) => t.id === id);
}

/** Tools register how their domain persists; the hub's Save-all runs them. */
export function registerSaveHandler(domain: string, save: () => Promise<void>): void {
  saveHandlers.set(domain, save);
}

export function getSaveHandler(domain: string): (() => Promise<void>) | undefined {
  return saveHandlers.get(domain);
}
