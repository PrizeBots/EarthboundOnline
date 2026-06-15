/**
 * Dev-only console hook for the flag system. Exposes window.__eb.flags so the
 * whole spine (dialogue branch → dialogue:done event → trigger → setFlag →
 * branch flips) can be proven live on ANY NPC without authoring override files.
 *
 * Gated behind import.meta.env.DEV at the call site (Game.init), so it never
 * reaches production. Not part of the shipped flag runtime — purely a probe.
 */

import { hasFlag, setFlag, clearFlag, allFlags, resetFlags } from './PlayerFlags';
import { setDialogueBranchLive } from './NPCManager';
import { getTriggers, setTriggers } from './FlagTriggers';

const DEMO_FLAG = 901000;

export function installFlagConsole(): void {
  const eb = ((window as unknown as Record<string, unknown>).__eb ?? {}) as Record<string, unknown>;
  eb.flags = {
    list: () => allFlags(),
    has: (id: number) => hasFlag(id),
    set: (id: number) => setFlag(id),
    clear: (id: number) => clearFlag(id),
    reset: () => resetFlags(),
    /**
     * Wire a full live demo on one NPC's textId: branch its dialogue on
     * DEMO_FLAG, and add a runtime trigger that sets the flag when you finish
     * talking. Talk once → "(NEW)" line; close → trigger sets the flag; talk
     * again → "(SEEN)" line. clear(901000) to reset.
     */
    demo: (textId: number) => {
      setDialogueBranchLive(String(textId), {
        flag: DEMO_FLAG,
        ifClear: ['(NEW PLAYER) Oh, be careful out there!'],
        ifSet: ['(AFTER EVENT) Welcome back! Did you have a good time?'],
      });
      setTriggers([
        ...getTriggers().filter((t) => t.id !== 'demo'),
        { id: 'demo', on: { event: 'dialogue:done', text: Number(textId) }, set: [DEMO_FLAG] },
      ]);
      const msg = `Demo armed on textId ${textId}. Talk to it (NEW line), close, talk again (SEEN line). __eb.flags.clear(${DEMO_FLAG}) to reset.`;
      console.log(`[flags] ${msg}`);
      return msg;
    },
  };
  (window as unknown as Record<string, unknown>).__eb = eb;
  console.log('[flags] dev console ready — __eb.flags.demo(textId), .set/.clear/.list/.reset');
}
