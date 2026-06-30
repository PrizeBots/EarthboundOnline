import { EditorContext } from './types';
import { EditorShell } from './EditorShell';
import { placementTool } from './tools/PlacementTool';
import { enemySpawnerTool } from './tools/EnemySpawnerTool';
import { entityManagerTool } from './tools/EntityManagerTool';
import { trafficEditorTool } from './tools/TrafficEditorTool';
import { dialogueTool } from './tools/DialogueTool';
import { itemManagerTool } from './tools/ItemManagerTool';
import { psiManagerTool } from './tools/PsiManagerTool';
import { giftManagerTool } from './tools/GiftManagerTool';
import { sourceAssetsTool } from './tools/SourceAssetsTool';
import { soundTool } from './tools/SoundTool';
import { combatTool } from './tools/CombatTool';
import { roomBuilderTool } from './tools/RoomBuilderTool';
import { roomManagerTool } from './tools/RoomManagerTool';
import { eventManagerTool } from './tools/EventManagerTool';
import { registerEditorTool, registerSaveHandler } from './registry';
import { saveOverride } from './saveOverride';
import { getNameOverrides } from '../engine/SpriteNames';
import { getSongNameOverrides } from '../engine/SongNames';
import { openSpriteEditor } from '../engine/spriteEditor';

// Entry point for the dev-only editor layer. Game loads this module via a
// dev-gated dynamic import (`if (import.meta.env.DEV) import('../editor')`),
// so none of `src/editor/` exists in production bundles.

export interface EditorHooks {
  isActive(): boolean;
  update(): void;
  drawOverlay(): void;
}

// Planned tools (EDITOR_TOOLS.md) appear in the hub as WIP until built. Empty
// now — all planned tools are built; keep the hook for the next WIP stub.
const PLANNED: { id: string; name: string; description: string }[] = [];

export function initEditorTools(context: EditorContext): EditorHooks {
  const shell = new EditorShell(context);

  registerEditorTool(placementTool);
  registerEditorTool(enemySpawnerTool);
  registerEditorTool(entityManagerTool);
  registerEditorTool(trafficEditorTool);
  registerEditorTool(dialogueTool);
  registerEditorTool(itemManagerTool);
  registerEditorTool(psiManagerTool);
  registerEditorTool(giftManagerTool);
  registerEditorTool(sourceAssetsTool);
  registerEditorTool(soundTool);
  registerEditorTool(combatTool);
  registerEditorTool(roomBuilderTool);
  registerEditorTool(roomManagerTool);
  registerEditorTool(eventManagerTool);
  for (const t of PLANNED) registerEditorTool({ ...t, status: 'wip' });

  // Sprite Editor (engine/SpriteEditor.ts): a self-contained overlay that owns
  // overrides/sprites.json. Its dock tab opens it docked to the LEFT of the tool
  // column (the shell stays up, yielding the keyboard while it's open); Esc — or
  // clicking another tab — closes it.
  registerEditorTool({
    id: 'cast-sprites',
    name: 'Sprite Editor',
    description: 'Fix attack/hurt frames + held items for any cast character.',
    status: 'ready',
    launch: () => {
      // Dock it to the left of the tool column (the shell stays up); the shell
      // yields the keyboard to it while it's open (see isSpriteEditorOpen).
      void openSpriteEditor();
    },
  });

  // Admin sprite renames (✎ in placement panel) persist here.
  registerSaveHandler('names', () => saveOverride('names.json', getNameOverrides()));

  // Admin song renames (Sound Manager) persist here, parallel to sprite names.
  registerSaveHandler('song_names', () => saveOverride('song_names.json', getSongNameOverrides()));

  const enter = async () => {
    if (shell.isActive()) return;
    // F2 from a non-gameplay screen (character select / loading): drop the
    // admin straight in by starting the game as the default character first.
    if (!context.canEnter()) {
      const playing = await context.ensurePlaying();
      if (!playing || !context.canEnter()) return;
    }
    shell.enter(); // the dock (right column) is always present while editing
  };

  // F2 toggles in; the shell handles F2-out itself while active.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F2' && !shell.isActive()) {
      e.preventDefault();
      void enter();
    }
  });

  // Console hook: __eb.admin()
  const eb = ((window as unknown as Record<string, unknown>).__eb ?? {}) as Record<string, unknown>;
  eb.admin = enter;
  (window as unknown as Record<string, unknown>).__eb = eb;

  console.log('[editor] dev editor loaded — F2 or __eb.admin() to enter');

  return {
    isActive: () => shell.isActive(),
    update: () => shell.update(),
    drawOverlay: () => shell.drawOverlay(),
  };
}
