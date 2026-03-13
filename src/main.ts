import { Game } from './engine/Game';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  const game = new Game(canvas);

  try {
    await game.init();
    game.start();
  } catch (err) {
    console.error(err);
  }
}

main();
