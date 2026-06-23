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
import {
  comboAnimations,
  tileAnimations,
  animGraphics,
  lcm,
  type PaletteAnim,
  type TileAnim,
} from './anim';
import type { Tile, RGBA } from './tileset';
import { extractMusicMap } from './music';
import { extractShops } from './shops';
import { extractDialogue } from './dialogue';
import { extractItemNames } from './items';
import worldFlags from '../world_flags.json';

const SECTOR_TILESETS_PALETTES = 0xd7a800;
const ARRANGEMENTS_PTR_TABLE = 0xef10ab;

// Drawing tilesets whose TILE-GRAPHIC animation we bake (matches build_atlases.py's
// ESCALATOR_DRAW_TS): the dept-store escalators (Twoson drawTS 12, Fourside 13).
// Water/waterfall tilesets animate the same way but are left off pending review.
const ESCALATOR_DRAW_TS = new Set([12, 13]);

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
  json['atlases/anim.json'] = animManifest(rom, a);
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
  const rawFor = rawArrangementsFactory(rom);

  // Animation data (both EB systems). Decoded once; combos without animation
  // render only their static atlas.
  const palAnims = comboAnimations(rom);
  const tileAnims = tileAnimations(rom);
  const animGfx = new Map<number, Tile[]>();
  for (const ts of ESCALATOR_DRAW_TS) if (tileAnims.has(ts)) animGfx.set(ts, animGraphics(rom, ts));

  for (const [mapTs, pal] of usedCombos(rom, a.sectors)) {
    const drawTs = a.tilesetMapping[mapTs];
    const tileset = a.tilesets[drawTs];
    const subpalettes =
      tileset.palettes[`${mapTs}_${pal}`] ??
      tileset.palettes[`${mapTs}_0`] ??
      Object.values(tileset.palettes)[0];
    if (!subpalettes) continue;
    const key = `${mapTs}_${pal}`;
    const rawArr = rawFor(drawTs);

    // Static atlas (frame 0's fallback). Always emitted.
    const { bg, fg } = renderAtlas(tileset.minitiles, subpalettes, rawArr);
    yield [`atlases/${key}.png`, { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: bg }];
    if (fg) {
      yield [`atlases/${key}_fg.png`, { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: fg }];
    }

    // Animation frames ({key}_f{k}.png + _f{k}_fg.png), merging palette + tile.
    const tileAnim = ESCALATOR_DRAW_TS.has(drawTs) ? tileAnims.get(drawTs) : undefined;
    const { frames } = planFrames(subpalettes, palAnims.get(key), tileAnim);
    const animTiles = animGfx.get(drawTs);
    for (let k = 0; k < frames.length; k++) {
      const { colors, remap } = frames[k];
      const fr = renderAtlas(tileset.minitiles, colors, rawArr, remap ?? undefined, animTiles);
      yield [`atlases/${key}_f${k}.png`, { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: fr.bg }];
      if (fr.fg) {
        yield [
          `atlases/${key}_f${k}_fg.png`,
          { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: fr.fg },
        ];
      }
    }
  }
}

/** Memoized decoder of a drawing tileset's raw (atlas-layout) arrangement cells. */
function rawArrangementsFactory(rom: Rom): (drawTs: number) => (number[] | null)[] {
  const arrange = rom.readTable(ARRANGEMENTS_PTR_TABLE, 20, 4);
  const cache = new Map<number, (number[] | null)[]>();
  return (drawTs: number) => {
    let r = cache.get(drawTs);
    if (!r) {
      r = decodeRawArrangements(decompress(rom.data, fromSnesAddress(arrange[drawTs])));
      cache.set(drawTs, r);
    }
    return r;
  };
}

type FramePlan = {
  frames: { colors: RGBA[][]; remap: Map<number, number> | null }[];
  durations: number[];
};

/**
 * Plan a combo's animation frames from the two ROM systems (ports build_atlases'
 * frame-merge). A combo can use BOTH (e.g. Fourside 29_4): palette cycling swaps
 * colours, tile animation swaps minitile graphics; we merge to lcm(frames) and use
 * the tile delay (the visible motion). Returns no frames for a static combo.
 */
function planFrames(baseColors: RGBA[][], palAnim?: PaletteAnim, tileAnim?: TileAnim): FramePlan {
  if (palAnim && tileAnim) {
    const pf = palAnim.frames.length;
    const tf = tileAnim.frames;
    const count = lcm(pf, tf);
    const frames: FramePlan['frames'] = [];
    const durations: number[] = [];
    for (let k = 0; k < count; k++) {
      frames.push({ colors: palAnim.frames[k % pf], remap: tileAnim.remaps[k % tf] });
      durations.push(tileAnim.delay);
    }
    return { frames, durations };
  }
  if (palAnim) {
    return {
      frames: palAnim.frames.map((colors) => ({ colors, remap: null })),
      durations: [...palAnim.durations],
    };
  }
  if (tileAnim) {
    const frames: FramePlan['frames'] = [];
    const durations: number[] = [];
    for (let k = 0; k < tileAnim.frames; k++) {
      frames.push({ colors: baseColors, remap: tileAnim.remaps[k] });
      durations.push(tileAnim.delay);
    }
    return { frames, durations };
  }
  return { frames: [], durations: [] };
}

/** True if any present arrangement cell draws a non-empty foreground minitile —
 *  matches renderAtlas's `has_fg` (which gates whether a `_fg` atlas exists). */
function hasForegroundLayer(minitiles: Tile[], rawArr: (number[] | null)[]): boolean {
  for (let i = 0; i < 1024; i++) {
    const cells = rawArr[i];
    if (!cells) continue;
    for (let c = 0; c < 16; c++) {
      const mtIndex = cells[c] & 0x3ff;
      if (mtIndex < 384) {
        const f = minitiles[mtIndex + 512];
        if (f) for (const row of f) for (const v of row) if (v !== 0) return true;
      }
    }
  }
  return false;
}

/**
 * The `atlases/anim.json` runtime manifest: which combos animate, frame counts,
 * per-frame durations (game frames @60Hz), and whether they have a FG layer.
 * Combos are emitted in sorted (mapTs, pal) order to match build_atlases.py.
 */
export function animManifest(rom: Rom, a: ExtractedAssets): unknown {
  const palAnims = comboAnimations(rom);
  const tileAnims = tileAnimations(rom);
  const rawFor = rawArrangementsFactory(rom);
  const combos: Record<string, { frames: number; durations: number[]; fg: boolean }> = {};

  const sorted = [...usedCombos(rom, a.sectors)].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (const [mapTs, pal] of sorted) {
    const drawTs = a.tilesetMapping[mapTs];
    const tileset = a.tilesets[drawTs];
    const subpalettes =
      tileset.palettes[`${mapTs}_${pal}`] ??
      tileset.palettes[`${mapTs}_0`] ??
      Object.values(tileset.palettes)[0];
    if (!subpalettes) continue;
    const key = `${mapTs}_${pal}`;
    const tileAnim = ESCALATOR_DRAW_TS.has(drawTs) ? tileAnims.get(drawTs) : undefined;
    const { durations } = planFrames(subpalettes, palAnims.get(key), tileAnim);
    if (durations.length === 0) continue;
    combos[key] = {
      frames: durations.length,
      durations,
      fg: hasForegroundLayer(tileset.minitiles, rawFor(drawTs)),
    };
  }
  return { version: 1, frameRateHz: 60, combos };
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
