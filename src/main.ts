import { Game } from './engine/Game';
import { initMuteButton } from './engine/MuteButton';
import { maybePrimeFromCache, runRomIntake, clearRomCache } from './extract/romAssets';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  initMuteButton();

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

  try {
    await game.init();
    game.start();
  } catch (err) {
    console.error(err);
  }
}

main();
