import { EditorContext } from './types';
import { EditorShell } from './EditorShell';
import { EditorHub, registerEditorTool } from './EditorHub';
import { placementTool } from './tools/PlacementTool';
import { collisionTool } from './tools/CollisionTool';
import { spriteAnimatorTool } from './tools/SpriteAnimatorTool';
import { registerSaveHandler } from './registry';
import { saveOverride } from './saveOverride';
import { getNameOverrides } from '../engine/SpriteNames';

// Entry point for the dev-only editor layer. Game loads this module via a
// dev-gated dynamic import (`if (import.meta.env.DEV) import('../editor')`),
// so none of `src/editor/` exists in production bundles.

export interface EditorHooks {
  isActive(): boolean;
  update(): void;
  drawOverlay(): void;
}

// Planned tools (EDITOR_TOOLS.md §2-5) appear in the hub as WIP until built.
// Real tools replace these stubs and self-register the same way.
const PLANNED: { id: string; name: string; description: string }[] = [
  {
    id: 'dialogue',
    name: 'Dialogue Editor',
    description: 'Author NPC text through the real DialogueManager window.',
  },
];

export function initEditorTools(context: EditorContext): EditorHooks {
  const shell = new EditorShell(context);
  const hub = new EditorHub(shell);
  shell.onHubRequest = () => (hub.isOpen() ? hub.close() : hub.open());
  shell.isHubOpen = () => hub.isOpen();

  registerEditorTool(placementTool);
  registerEditorTool(collisionTool);
  registerEditorTool(spriteAnimatorTool);
  for (const t of PLANNED) registerEditorTool({ ...t, status: 'wip' });

  // Admin sprite renames (✎ in placement panel / animator) persist here.
  registerSaveHandler('names', () => saveOverride('names.json', getNameOverrides()));

  const enter = () => {
    if (shell.isActive() || !context.canEnter()) return;
    shell.enter();
    hub.open(); // land on the hub, like a desktop
  };

  // F2 toggles in; the shell handles F2-out itself while active.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F2' && !shell.isActive()) {
      e.preventDefault();
      enter();
    }
  });

  // Console hook: __eb.admin()
  const eb = ((window as unknown as Record<string, unknown>).__eb ?? {}) as Record<string, unknown>;
  eb.admin = enter;
  (window as unknown as Record<string, unknown>).__eb = eb;

  console.log('[editor] dev editor loaded — F2 or __eb.admin() to enter');

  return {
    isActive: () => shell.isActive(),
    update: () => {
      if (hub.isOpen()) return; // world holds still behind the hub
      shell.update();
    },
    drawOverlay: () => shell.drawOverlay(),
  };
}
