import { Game } from './engine/Game';
import { initMuteButton } from './engine/MuteButton';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  initMuteButton();

  const game = new Game(canvas);
  // Dev hook for the browser console and verification scripts
  // (e.g. __eb.game.debugTeleport(1080, 2136) jumps into the Onett cave).
  (window as unknown as Record<string, unknown>).__eb = { game };

  try {
    await game.init();
    game.start();
  } catch (err) {
    console.error(err);
  }
}

main();
