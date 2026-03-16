const keys = new Set<string>();

/** Expose the live key set so other systems (e.g. MenuManager) can read it. */
export function getKeySet(): Set<string> {
  return keys;
}

export function initInput() {
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    // Prevent arrow keys from scrolling the page
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });
}

export function isActionPressed(): boolean {
  if (keys.has('Space') || keys.has('Enter') || keys.has('KeyZ')) {
    // Consume the press so it doesn't repeat
    keys.delete('Space');
    keys.delete('Enter');
    keys.delete('KeyZ');
    return true;
  }
  return false;
}

export function getDirection(): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;

  if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;

  return { dx, dy };
}
