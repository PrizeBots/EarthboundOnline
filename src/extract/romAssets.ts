/**
 * Main-thread glue for the ROM-extraction asset path. Three jobs:
 *  - primeBundle:   load an extracted bundle into AssetLoader's caches (JSON
 *                   directly; images rasterized to HTMLImageElements) so the
 *                   engine's existing loadJSON/loadImage transparently serve
 *                   ROM-extracted assets instead of HTTP.
 *  - maybePrimeFromCache: at boot, prime from the IndexedDB cache if present.
 *                   No cache → returns false → engine loads committed assets over
 *                   HTTP exactly as before (dev flow untouched).
 *  - runRomIntake:  file picker → checksum-verify → run the Worker → persist →
 *                   reload (so the next boot primes before any asset loads).
 *
 * This whole path is ADDITIVE: nothing changes until a player supplies a ROM.
 */
import { primeJSONCache, primeImageCache } from '../engine/AssetLoader';
import { loadCachedBundle, saveCachedBundle, clearCachedBundle } from './romCache';
import type { ExtractDone, ExtractResponse } from './extract.worker';

// Clean US EarthBound reference ROM (matches CoilSnake's reference MD5
// a864b2e5…). Other valid dumps need an IPS fix to reach this; our Rom reader
// only handles the clean reference, so accepting only this hash is consistent.
// TODO: accept the full known-dump set once the worker applies the IPS fixes.
const ACCEPTED_SHA256 = new Set<string>([
  'a8fe2226728002786d68c27ddddf0b90a894db52e4dfe268fdf72a68cae5f02e',
]);

type BundleLike = { json: Record<string, unknown>; images: Record<string, Blob> };

/** Decode a PNG blob into a loaded HTMLImageElement (so loadImage's type is unchanged). */
function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = url;
  });
}

/** Load an extracted bundle into the AssetLoader caches under /assets/ paths. */
export async function primeBundle(bundle: BundleLike): Promise<void> {
  for (const [key, val] of Object.entries(bundle.json)) {
    primeJSONCache(`/assets/${key}`, val);
  }
  await Promise.all(
    Object.entries(bundle.images).map(async ([key, blob]) => {
      primeImageCache(`/assets/${key}`, await blobToImage(blob));
    })
  );
}

/** At boot: prime from the IndexedDB cache if a bundle is stored. */
export async function maybePrimeFromCache(): Promise<boolean> {
  const cached = await loadCachedBundle();
  if (!cached) return false;
  await primeBundle(cached);
  console.log(`Primed ${Object.keys(cached.images).length} images from cached ROM extraction`);
  return true;
}

// --- intake ---------------------------------------------------------------

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sfc,.smc';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function stripHeader(b: Uint8Array): Uint8Array {
  return b.length % 0x400 === 0x200 ? b.subarray(0x200) : b;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function overlay(message: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
    'background:#000;color:#fff;font:16px monospace;text-align:center;white-space:pre-line';
  el.textContent = message;
  document.body.appendChild(el);
  return el;
}

function runWorker(
  romBuffer: ArrayBuffer,
  onProgress: (done: number, total: number) => void
): Promise<ExtractDone> {
  const worker = new Worker(new URL('./extract.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ExtractResponse>) => {
      const msg = e.data;
      if ('progress' in msg) {
        onProgress(msg.progress, msg.total);
        return; // keep listening
      }
      worker.terminate();
      if ('error' in msg) reject(new Error(msg.error));
      else resolve(msg);
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage({ rom: romBuffer });
  });
}

/**
 * Player ROM intake: pick a file, checksum-verify it (never uploaded), extract
 * in the Worker, persist to IndexedDB, then reload so the boot path primes the
 * caches before any asset loads. Exposed as `window.__eb.romExtract()`.
 */
export async function runRomIntake(): Promise<void> {
  const file = await pickFile();
  if (!file) return;

  const ui = overlay('Reading ROM…');
  try {
    const bytes = stripHeader(new Uint8Array(await file.arrayBuffer()));
    const hash = await sha256(bytes);
    if (!ACCEPTED_SHA256.has(hash)) {
      ui.textContent = `Unrecognized ROM.\nExpected a clean EarthBound (US) ROM.\nsha256 ${hash.slice(0, 16)}…`;
      setTimeout(() => ui.remove(), 4000);
      return;
    }

    ui.textContent = 'Extracting assets from your ROM…\n(this runs entirely in your browser)';
    const bundle = await runWorker(bytes.slice().buffer, (done, total) => {
      ui.textContent = `Extracting assets from your ROM…\nrendering ${done} / ${total} images\n(this runs entirely in your browser)`;
    });

    ui.textContent = 'Caching assets…';
    await saveCachedBundle({ romHash: hash, json: bundle.json, images: bundle.images });

    ui.textContent = 'Done — reloading.';
    location.reload();
  } catch (err) {
    ui.textContent = `Extraction failed:\n${String(err)}`;
    setTimeout(() => ui.remove(), 6000);
    throw err;
  }
}

/** Clear the cache and reload (re-trigger intake). `window.__eb.romClear()`. */
export async function clearRomCache(): Promise<void> {
  await clearCachedBundle();
  location.reload();
}
