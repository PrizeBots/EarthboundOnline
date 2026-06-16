/**
 * Asset bundle builder — composes every binary extractor + renderer into the
 * exact set of files the engine loads, keyed by the same `/assets/...`-relative
 * paths AssetLoader fetches today. The Web Worker's core (pure logic, no browser
 * APIs → node-testable).
 *
 * Images are produced via a GENERATOR (`imageEntries`) so the worker can encode
 * each to a PNG blob and free the raw RGBA before rendering the next — a full
 * set of 1024×1024 atlases is ~1.2 GB raw but ~23 MB as PNG, so materializing
 * them all at once OOMs the tab / IndexedDB. `buildAssetBundle` (used by the node
 * test) still collects everything for convenience.
 *
 * Produces the BINARY layer only (tiles/sectors/doors/tilesets/sprites/atlases);
 * the text/authored layer stays HTTP-served in the interim.
 */
import { Rom, fromSnesAddress } from './Rom';
import { extractAll, type ExtractedAssets } from './extractAll';
import { decompress } from './decompress';
import { renderSpriteImage } from './sprites';
import { renderAtlas, decodeRawArrangements, ATLAS_SIZE } from './atlas';
import { extractMusicMap } from './music';
import { extractShops } from './shops';
import { extractDialogue } from './dialogue';
import { extractItemNames } from './items';
import worldFlags from '../world_flags.json';

const SECTOR_TILESETS_PALETTES = 0xd7a800;
const ARRANGEMENTS_PTR_TABLE = 0xef10ab;

export type ImageData8 = { width: number; height: number; rgba: Uint8ClampedArray };
export type AssetBundle = {
  json: Record<string, unknown>;
  images: Record<string, ImageData8>;
};

/** The data (JSON) assets, keyed by `/assets/`-relative path. */
export function dataAssets(rom: Rom, a: ExtractedAssets): Record<string, unknown> {
  const json: Record<string, unknown> = {
    'map/tiles.json': a.tiles,
    'map/sectors.json': a.sectors,
    'map/doors.json': a.doors,
    'map/tileset_mapping.json': a.tilesetMapping,
    'sprites/metadata.json': a.sprites.groups.map((g) => g.meta),
    'sprites/palettes.json': a.sprites.palettes,
    // Text layer (decoded from the ROM via the EB text engine).
    'music/music_map.json': extractMusicMap(rom),
    'map/shops.json': extractShops(rom),
    'map/npc_text.json': extractDialogue(rom, {
      setFlags: new Set(
        (worldFlags as { setFlags: string[] }).setFlags.map((f) => parseInt(f, 16))
      ),
      itemNames: extractItemNames(rom),
    }),
  };
  for (let ts = 0; ts < a.tilesets.length; ts++) {
    json[`tilesets/${ts}/arrangements.json`] = a.tilesets[ts].arrangements;
    json[`tilesets/${ts}/collisions.json`] = a.tilesets[ts].collisions;
    json[`tilesets/${ts}/palettes.json`] = a.tilesets[ts].palettes;
  }
  return json;
}

/**
 * Lazily yield every image (sprites then atlases) one at a time as `[path,
 * {width,height,rgba}]`. The caller MUST consume+release each before pulling the
 * next to keep peak memory bounded to a single image.
 */
export function* imageEntries(rom: Rom, a: ExtractedAssets): Generator<[string, ImageData8]> {
  // sprites — the image is the FULL 4×4 frame grid (g.meta.width/height are a
  // SINGLE frame; the sheet is 4× each), so size the image from the pixel grid.
  for (const g of a.sprites.groups) {
    const height = g.pixels.length;
    const width = g.pixels[0]?.length ?? 0;
    yield [
      `sprites/${g.meta.id}.png`,
      { width, height, rgba: renderSpriteImage(g.pixels, a.sprites.palettes[g.meta.palette]) },
    ];
  }

  // atlases — raw arrangement cells per drawing tileset (atlas bit-layout).
  const arrange = rom.readTable(ARRANGEMENTS_PTR_TABLE, 20, 4);
  const rawArr = new Map<number, (number[] | null)[]>();
  const rawFor = (drawTs: number) => {
    let r = rawArr.get(drawTs);
    if (!r) {
      r = decodeRawArrangements(decompress(rom.data, fromSnesAddress(arrange[drawTs])));
      rawArr.set(drawTs, r);
    }
    return r;
  };

  for (const [mapTs, pal] of usedCombos(rom, a.sectors)) {
    const drawTs = a.tilesetMapping[mapTs];
    const tileset = a.tilesets[drawTs];
    const subpalettes =
      tileset.palettes[`${mapTs}_${pal}`] ??
      tileset.palettes[`${mapTs}_0`] ??
      Object.values(tileset.palettes)[0];
    if (!subpalettes) continue;

    const { bg, fg } = renderAtlas(tileset.minitiles, subpalettes, rawFor(drawTs));
    yield [`atlases/${mapTs}_${pal}.png`, { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: bg }];
    if (fg) {
      yield [`atlases/${mapTs}_${pal}_fg.png`, { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: fg }];
    }
  }
}

/** Count of images `imageEntries` will yield (for progress UI), computed cheaply. */
export function imageCount(rom: Rom, a: ExtractedAssets): number {
  let n = a.sprites.groups.length;
  for (const [mapTs, pal] of usedCombos(rom, a.sectors)) {
    const tileset = a.tilesets[a.tilesetMapping[mapTs]];
    const sub =
      tileset.palettes[`${mapTs}_${pal}`] ??
      tileset.palettes[`${mapTs}_0`] ??
      Object.values(tileset.palettes)[0];
    if (!sub) continue;
    n += 1; // bg always; fg unknown without rendering — undercount is fine for a bar
  }
  return n;
}

/** Build the full binary asset bundle (collects all images — node-test convenience). */
export function buildAssetBundle(rom: Rom): AssetBundle {
  const a = extractAll(rom);
  const images: Record<string, ImageData8> = {};
  for (const [path, img] of imageEntries(rom, a)) images[path] = img;
  return { json: dataAssets(rom, a), images };
}

/** (mapTileset, palette) combos referenced by the sectors UNION the ROM's base
 *  32×40 sector table — matching build_atlases.py's union. */
function usedCombos(
  rom: Rom,
  sectors: { tilesetId: number; paletteId: number }[]
): [number, number][] {
  const set = new Set<string>();
  for (const s of sectors) set.add(`${s.tilesetId},${s.paletteId}`);
  const base = fromSnesAddress(SECTOR_TILESETS_PALETTES);
  for (let i = 0; i < 32 * 40; i++) {
    const val = rom.byte(base + i);
    set.add(`${val >> 3},${val & 7}`);
  }
  return [...set].map((k) => k.split(',').map(Number) as [number, number]);
}
