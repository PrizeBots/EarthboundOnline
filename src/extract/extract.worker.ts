/**
 * Extraction Web Worker. Receives the player's ROM bytes, runs the full binary
 * pipeline off the main thread, and posts back the data JSON + PNG-encoded image
 * blobs.
 *
 * Images are rendered AND PNG-encoded one at a time (imageEntries generator +
 * OffscreenCanvas.convertToBlob), so the raw 1024×1024 RGBA of each atlas (~4 MB)
 * is freed before the next — the full set is ~1.2 GB raw but ~23 MB as PNG, so
 * holding them all (or cloning them into IndexedDB) OOMs. Progress is posted so
 * the intake UI can show a bar.
 */
import { Rom } from './Rom';
import { extractAll } from './extractAll';
import { dataAssets, imageEntries, imageCount } from './bundle';

export type ExtractProgress = { progress: number; total: number };
export type ExtractDone = { json: Record<string, unknown>; images: Record<string, Blob> };
export type ExtractError = { error: string };
export type ExtractResponse = ExtractDone | ExtractProgress | ExtractError;

self.onmessage = async (e: MessageEvent<{ rom: ArrayBuffer }>) => {
  const post = (msg: ExtractResponse) => (self as unknown as Worker).postMessage(msg);
  try {
    const rom = new Rom(new Uint8Array(e.data.rom));
    const a = extractAll(rom);
    const json = dataAssets(rom, a);

    const total = imageCount(rom, a);
    const images: Record<string, Blob> = {};
    let done = 0;
    for (const [path, img] of imageEntries(rom, a)) {
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d')!;
      // Fresh ArrayBuffer-backed copy (ImageData requires that exact type); freed each loop.
      ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
      images[path] = await canvas.convertToBlob({ type: 'image/png' });
      // img.rgba is now unreferenced and freed before the next render.
      if (++done % 16 === 0) post({ progress: done, total });
    }

    post({ json, images } satisfies ExtractDone);
  } catch (err) {
    post({ error: String(err) } satisfies ExtractError);
  }
};
