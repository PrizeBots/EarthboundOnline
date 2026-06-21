// Stamp-cleanup surface for the Sprite Editor: opens a Room Builder tile stamp as
// a single paint buffer (reusing the ENTITY buffer surface in S — entityCanvas/
// entityW/H/Undo + the extracted S.palette) so you can erase its background and
// touch up pixels with the full editor. On save it slices the buffer back into
// 8×8 custom-tile minitiles and OVERWRITES the same stamp in place (id/label/
// folder kept), then persists custom_tiles.json + the stamp library.
import { getStamp, getStamps, renderStampToCanvas, applyEditedPixels, saveStamps } from '../Stamps';
import { customTilesDoc } from '../CustomTiles';
import { S } from './state';
import { postOverride } from './saveChannel';
import { extractPalette } from './entityEditor';
import { clearSelection, renderSwatches, setColor } from './pixelCanvas';

/** Point the engine's (shared) entity buffer at this canvas. */
function aliasBuffer(canvas: HTMLCanvasElement): void {
  S.entityCanvas = canvas;
  S.entityCtx = canvas.getContext('2d', { willReadFrequently: true })!;
  S.entityCtx.imageSmoothingEnabled = false;
}

/** Render a stamp into the paint buffer + extract its palette. Async (awaits the
 *  source atlases). Caller switches editMode to 'stamp'. */
export async function loadStampIntoBuffer(id: string): Promise<void> {
  const s = getStamp(id);
  if (!s) return;
  const buf = await renderStampToCanvas(s);
  S.stampEditId = id;
  S.entityW = buf.width;
  S.entityH = buf.height;
  S.entityUndo = [];
  aliasBuffer(buf);
  S.palette = extractPalette(S.entityCtx!, buf.width, buf.height);
  clearSelection();
  renderSwatches();
  setColor(1);
  updateStampNote();
  S.dirty = true;
}

/** (Re)build the in-editor stamp library grid: a clickable thumbnail per stamp,
 *  the active one highlighted. Each thumb renders async from the shared service. */
export function rebuildStampList(): void {
  const host = S.stampListHost;
  if (!host) return;
  host.innerHTML = '';
  const stamps = getStamps();
  if (stamps.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = '(no stamps yet — sample some in the Room Builder)';
    empty.style.cssText = 'color:#678;font-size:11px;';
    host.appendChild(empty);
    return;
  }
  for (const s of stamps) {
    const active = s.id === S.stampEditId;
    const cell = document.createElement('div');
    cell.title = s.label;
    cell.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:2px;padding:3px;width:72px;' +
      'border-radius:4px;cursor:pointer;' +
      (active
        ? 'background:#10303d;border:1px solid #4db6e8;'
        : 'background:#161c24;border:1px solid #2a3340;');
    const thumb = document.createElement('canvas');
    thumb.style.cssText = 'image-rendering:pixelated;background:#000;border-radius:2px;';
    cell.appendChild(thumb);
    const name = document.createElement('div');
    name.textContent = s.label;
    name.style.cssText =
      'font-size:10px;color:#bfe3ff;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    cell.appendChild(name);
    cell.onclick = () => void loadStampIntoBuffer(s.id).then(rebuildStampList);
    host.appendChild(cell);
    // Async-render the preview (atlases may still be loading).
    void renderStampToCanvas(s).then((cv) => {
      const max = 64;
      const scale = Math.max(0.0625, Math.min(2, max / Math.max(cv.width, cv.height)));
      thumb.width = cv.width;
      thumb.height = cv.height;
      thumb.style.width = `${Math.max(1, Math.round(cv.width * scale))}px`;
      thumb.style.height = `${Math.max(1, Math.round(cv.height * scale))}px`;
      thumb.getContext('2d')?.drawImage(cv, 0, 0);
    });
  }
}

export function updateStampNote(suffix = ''): void {
  if (!S.stampNote) return;
  const s = getStamp(S.stampEditId);
  const name = s?.label ?? S.stampEditId;
  S.stampNote.textContent = `Editing stamp "${name}" — ${S.entityW}×${S.entityH}px${suffix}`;
}

/** Persist the edited buffer back onto the SAME stamp (overwrite in place) +
 *  save the minted custom tiles and the stamp library. */
export async function persistStamp(): Promise<void> {
  const s = getStamp(S.stampEditId);
  if (!s || !S.entityCtx) return;
  const { data } = S.entityCtx.getImageData(0, 0, S.entityW, S.entityH);
  applyEditedPixels(s, S.entityW, S.entityH, data);
  await postOverride('custom_tiles.json', customTilesDoc());
  await saveStamps();
}
