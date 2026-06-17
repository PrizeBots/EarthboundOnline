// Item categories — the shared "desktop folders" that organize every catalog
// item (shops.json) plus custom-minted ones. OUR authored metadata (no ROM
// pixels), saved to overrides/item_folders.json as { folders, assign }. The
// Item Manager edits this with a file-explorer desktop (drag items into
// folders); the Sprite Editor's item mode reads the same folders as its
// category tabs, so both tools agree on what "Food", "Weapons", etc. contain.
//
// A folder is a named container with an optional parent (folders nest). `assign`
// maps an item id -> the folder it lives in; an absent entry means the item sits
// on the Desktop (root). Mirrors the Entity Manager's entity_folders.json model.

import { loadJSON, primeJSONCache } from './AssetLoader';
import { allItems, itemEquip } from './Shop';
import { HELD_ITEM_IDS, customItemIds } from './Items';

export interface ItemFolder {
  id: string;
  name: string;
  parent: string | null; // null = on the Desktop (a top-level category)
}
interface ItemFoldersFile {
  version?: number;
  folders?: ItemFolder[];
  assign?: Record<string, string>; // itemId -> folderId
}

const FILE = 'item_folders.json';

let folders: ItemFolder[] = [];
let assign: Record<string, string> = {};
let loaded = false;

// --- auto-categorization (seed only; manual drags always win) -----------------
// Solid foods that get "eaten" + drinks that drain, mirroring the animation sets
// in tools/author_item_sprites.py. The rest split into healing/battle/key by id.
const FOOD = new Set([
  88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 109, 118, 119, 122, 124,
  166, 183, 189, 190, 191, 198, 207, 211, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235,
  236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 247, 251,
]);
const DRINK = new Set([105, 106, 107, 108, 110, 111, 120, 121, 123, 126, 223, 232, 246, 252]);
const HEAL = new Set([112, 113, 114, 115, 116, 117, 127, 128, 129, 130, 159, 188, 195, 203, 204]);
const BATTLE = new Set([
  131, 132, 133, 134, 135, 136, 137, 138, 139, 144, 145, 146, 147, 148, 149, 150, 151, 153, 157,
  161,
]);

// Base top-level categories, seeded on first run.
const BASE_FOLDERS: ItemFolder[] = [
  { id: 'weapons', name: 'Weapons', parent: null },
  { id: 'equipment', name: 'Equipment', parent: null },
  { id: 'food', name: 'Food', parent: null },
  { id: 'drinks', name: 'Drinks', parent: null },
  { id: 'healing', name: 'Healing & PSI', parent: null },
  { id: 'battle', name: 'Battle Items', parent: null },
  { id: 'key', name: 'Key Items', parent: null },
  { id: 'custom', name: 'Custom', parent: null },
];

/** Best-guess base category for an item id, from equip slot + curated id sets. */
function categoryFor(id: string): string {
  if (HELD_ITEM_IDS.includes(id) || customItemIds().includes(id) || !/^\d+$/.test(id))
    return 'custom';
  const slot = itemEquip(id)?.slot;
  if (slot === 'weapon') return 'weapons';
  if (slot) return 'equipment'; // body / arms / other
  const n = Number(id);
  if (FOOD.has(n)) return 'food';
  if (DRINK.has(n)) return 'drinks';
  if (BATTLE.has(n)) return 'battle';
  if (HEAL.has(n)) return 'healing';
  return 'key';
}

/** Every item id the catalog knows about (catalog + legacy seeds + custom). */
export function allItemIds(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...allItems().map((i) => i.id), ...HELD_ITEM_IDS, ...customItemIds()]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Load the desktop layout (call after loadShops + loadCustomItems). First run
 *  seeds the base categories and auto-sorts everything; later loads trust the
 *  saved file (manual placements win). */
export async function loadItemFolders(): Promise<void> {
  const f = await loadJSON<ItemFoldersFile>(`/overrides/${FILE}`).catch(() => null);
  if (f?.folders?.length) {
    folders = f.folders;
    assign = f.assign ?? {};
  } else {
    folders = BASE_FOLDERS.map((x) => ({ ...x }));
    assign = {};
    autoOrganizeItems();
  }
  loaded = true;
}

export function itemFoldersLoaded(): boolean {
  return loaded;
}

/** Ensure the base folders exist, then file every still-unsorted item. Manual
 *  placements are never disturbed — only Desktop/orphan items get sorted. */
export function autoOrganizeItems(): void {
  for (const b of BASE_FOLDERS) if (!folders.some((f) => f.id === b.id)) folders.push({ ...b });
  for (const id of allItemIds()) {
    if (folderOfItem(id)) continue; // already filed somewhere real
    assign[id] = categoryFor(id);
  }
}

// --- queries ------------------------------------------------------------------

export function itemFolders(): ItemFolder[] {
  return folders;
}

/** Top-level categories (parent === null) — the Sprite Editor's tab list. */
export function itemRootCategories(): ItemFolder[] {
  return folders.filter((f) => f.parent === null);
}

export function itemFoldersWithParent(parent: string | null): ItemFolder[] {
  return folders.filter((f) => f.parent === parent);
}

/** The folder an item lives in, or null (Desktop). Orphans read as Desktop. */
export function folderOfItem(id: string): string | null {
  const a = assign[id];
  return a && folders.some((f) => f.id === a) ? a : null;
}

export function folderName(id: string): string {
  return folders.find((f) => f.id === id)?.name ?? id;
}

/** Item ids filed directly in `parent` (null = Desktop), id-sorted. */
export function itemsInFolder(parent: string | null): string[] {
  return allItemIds()
    .filter((id) => folderOfItem(id) === parent)
    .sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
}

/** Count of items + subfolders directly under a folder (for the tile badge). */
export function childItemCount(folderId: string): number {
  const items = allItemIds().filter((id) => folderOfItem(id) === folderId).length;
  const subs = folders.filter((f) => f.parent === folderId).length;
  return items + subs;
}

export function isItemFolderAncestor(ancestorId: string, nodeId: string): boolean {
  let p = folders.find((f) => f.id === nodeId)?.parent ?? null;
  while (p) {
    if (p === ancestorId) return true;
    p = folders.find((f) => f.id === p)?.parent ?? null;
  }
  return false;
}

// --- mutations (caller persists via saveItemFolders) --------------------------

export function addItemFolder(name: string, parent: string | null): string {
  const id = 'f' + Math.random().toString(36).slice(2, 9);
  folders.push({ id, name: name.trim() || 'New Folder', parent });
  return id;
}

export function renameItemFolder(id: string, name: string): void {
  const f = folders.find((x) => x.id === id);
  if (f) f.name = name.trim() || f.name;
}

/** Delete a folder; its items + subfolders move up to its parent. */
export function deleteItemFolder(id: string): void {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const parent = f.parent;
  for (const x of folders) if (x.parent === id) x.parent = parent;
  for (const k of Object.keys(assign)) {
    if (assign[k] !== id) continue;
    if (parent) assign[k] = parent;
    else delete assign[k];
  }
  folders = folders.filter((x) => x.id !== id);
}

export function assignItemsTo(ids: Iterable<string>, folderId: string | null): void {
  for (const id of ids) {
    if (folderId) assign[id] = folderId;
    else delete assign[id];
  }
}

export function setItemFolderParent(childId: string, parentId: string | null): boolean {
  if (childId === parentId) return false;
  if (parentId && isItemFolderAncestor(childId, parentId)) return false;
  const f = folders.find((x) => x.id === childId);
  if (!f) return false;
  f.parent = parentId;
  return true;
}

// --- persistence (dev-only save channel, same as saveOverride/postOverride) ---

export function itemFoldersDoc(): ItemFoldersFile {
  return { version: 1, folders, assign };
}

export async function saveItemFolders(): Promise<void> {
  const doc = itemFoldersDoc();
  const res = await fetch('/__editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FILE, data: doc }),
  });
  if (!res.ok) throw new Error(`saveItemFolders: HTTP ${res.status}`);
  primeJSONCache(`/overrides/${FILE}`, doc);
}
