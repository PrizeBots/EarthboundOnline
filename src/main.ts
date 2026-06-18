import { Game } from './engine/Game';
import { initMuteButton } from './engine/MuteButton';
import { imageLoadProgress } from './engine/AssetLoader';
import { maybePrimeFromCache, runRomIntake, clearRomCache } from './extract/romAssets';

// The boot screen (index.html) — present before any module runs. Optional so a
// stripped-down host page without it still works.
declare global {
  interface Window {
    __boot?: { set: (frac: number, text?: string) => void; done: () => void };
  }
}

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  initMuteButton();

  // Drive the boot bar off the AssetLoader image counters while we load. Capped
  // at 90% (more images can still be discovered); done() snaps it to 100%.
  const boot = window.__boot;
  let booting = true;
  if (boot) {
    const poll = () => {
      if (!booting) return;
      const { started, finished } = imageLoadProgress();
      boot.set(started > 0 ? (finished / started) * 0.9 : 0.04);
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  try {
    // ROM-extraction path (additive): if the player has supplied a ROM before, its
    // extracted assets are cached in IndexedDB — prime them into AssetLoader BEFORE
    // anything loads so the engine serves them instead of HTTP. No cache → no-op,
    // and the committed dev assets load over HTTP exactly as before.
    try {
      const primed = await maybePrimeFromCache();
      if (primed) console.log('Running from ROM-extracted assets');
    } catch (err) {
      console.warn('ROM asset prime failed; falling back to HTTP assets', err);
    }

    const game = new Game(canvas);
    // Dev hooks for the browser console and verification scripts
    // (e.g. __eb.game.debugTeleport(1080, 2136) jumps into the Onett cave;
    //  __eb.romExtract() opens the ROM picker to extract+cache client-side;
    //  __eb.romClear() drops the cache and reloads).
    (window as unknown as Record<string, unknown>).__eb = {
      game,
      romExtract: runRomIntake,
      romClear: clearRomCache,
    };

    await game.init();
    game.start();
  } catch (err) {
    console.error(err);
  } finally {
    // Reveal the game whether init succeeded or failed (a stuck boot screen is
    // worse than a visible error in the console).
    booting = false;
    boot?.set(1);
    boot?.done();
  }
}

main();
