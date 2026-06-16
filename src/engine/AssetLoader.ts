const jsonCache = new Map<string, unknown>();
const imageCache = new Map<string, HTMLImageElement>();

export async function loadJSON<T>(path: string): Promise<T> {
  if (jsonCache.has(path)) return jsonCache.get(path) as T;
  const resp = await fetch(path);
  const data = await resp.json();
  jsonCache.set(path, data);
  return data as T;
}

/**
 * Replace a cached JSON entry. Used by the editor save channel: override files
 * are rewritten at runtime, so without this a later loadJSON() of an override
 * (e.g. DoorManager re-applying after a save) would return the stale copy
 * cached at game start and silently drop the edit. Seeding with the just-saved
 * object also avoids re-fetching a file the dev server may not have flushed yet.
 */
export function primeJSONCache(path: string, data: unknown): void {
  jsonCache.set(path, data);
}

/** Drop a cached JSON entry so the next loadJSON() re-fetches it. */
export function invalidateJSON(path: string): void {
  jsonCache.delete(path);
}

/**
 * Seed the image cache with an already-decoded image. Used by the ROM-extraction
 * path (romAssets.primeBundle): atlases/sprites rendered from the player's ROM
 * are rasterized to HTMLImageElements and primed here, so loadImage() returns
 * them instead of hitting HTTP. No prime → loadImage falls back to fetch exactly
 * as before (dev keeps loading committed assets).
 */
export function primeImageCache(path: string, img: HTMLImageElement): void {
  imageCache.set(path, img);
}

export async function loadImage(path: string): Promise<HTMLImageElement> {
  if (imageCache.has(path)) return imageCache.get(path)!;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(path, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = path;
  });
}
