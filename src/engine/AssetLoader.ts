const jsonCache = new Map<string, unknown>();
const imageCache = new Map<string, HTMLImageElement>();

export async function loadJSON<T>(path: string): Promise<T> {
  if (jsonCache.has(path)) return jsonCache.get(path) as T;
  const resp = await fetch(path);
  const data = await resp.json();
  jsonCache.set(path, data);
  return data as T;
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
