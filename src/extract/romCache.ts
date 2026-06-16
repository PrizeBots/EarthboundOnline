/**
 * IndexedDB persistence for the extracted asset bundle. After a player supplies
 * their ROM once, the extracted assets are cached here so subsequent loads skip
 * extraction entirely. Images are stored as PNG **Blobs** (structured-cloneable,
 * compact — the full atlas set is ~23 MB as PNG vs ~1.2 GB raw, which OOMs IDB).
 *
 * Versioned by ROM hash so a different/clean re-dump invalidates the cache.
 */

const DB_NAME = 'eb-rom-assets';
const STORE = 'bundle';
const KEY = 'current';

export type StoredBundle = {
  romHash: string;
  json: Record<string, unknown>;
  images: Record<string, Blob>;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Load the cached bundle, or null if none is stored. */
export async function loadCachedBundle(): Promise<StoredBundle | null> {
  try {
    const db = await open();
    return await new Promise<StoredBundle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as StoredBundle) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // no IDB / blocked → behave as "no cache"
  }
}

/** Persist the extracted bundle (replaces any previous one). */
export async function saveCachedBundle(bundle: StoredBundle): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bundle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Clear the cache (e.g. to re-extract from a different ROM). */
export async function clearCachedBundle(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
