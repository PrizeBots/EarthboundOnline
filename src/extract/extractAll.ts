/**
 * Composition entry point for the client-side extraction pipeline — runs every
 * ported extractor over a player's ROM and returns the full structured asset
 * set. This is the core the Web Worker will call (and what the integration smoke
 * test diffs against the committed `public/assets/` the engine loads today).
 *
 * Image atlases (build_atlases.py) are NOT produced here yet — only the data
 * assets plus the decoded pixel/palette inputs an atlas builder needs.
 */
import { Rom } from './Rom';
import { extractTilesets, type DecodedTileset } from './tileset';
import { extractMap } from './map';
import { extractSprites, type ExtractedSprites } from './sprites';
import { extractDoors, type DoorRecord } from './doors';
import { bakeSectorSettings, type TaggedSector } from './sectorSettings';
import { extractMapChanges, applyMapChanges } from './mapChanges';

export type ExtractedAssets = {
  tilesets: DecodedTileset[];
  tiles: number[]; // baked tile plane
  sectors: TaggedSector[]; // with indoor/dungeon/town
  tilesetMapping: number[];
  sprites: ExtractedSprites;
  doors: DoorRecord[][];
};

/** Run the full extraction + bake pipeline over a ROM's bytes. */
export function extractAll(rom: Rom): ExtractedAssets {
  const tableAddrs = {
    graphics: rom.readTable(0xef105b, 20, 4),
    arrangements: rom.readTable(0xef10ab, 20, 4),
    collisions: rom.readTable(0xef117b, 20, 4),
    mapTileset: rom.readTable(0xef101b, 32, 2),
    palette: rom.readTable(0xef10fb, 32, 4),
  };

  const tilesets = extractTilesets(rom, tableAddrs);
  const { tiles, sectors, tilesetMapping } = extractMap(rom);

  // Bake: open-world tile-changes, then sector indoor/dungeon/town tags.
  const baked = applyMapChanges(tiles, sectors, tilesetMapping, extractMapChanges(rom));
  const taggedSectors = bakeSectorSettings(rom, sectors);

  return {
    tilesets,
    tiles: baked,
    sectors: taggedSectors,
    tilesetMapping,
    sprites: extractSprites(rom),
    doors: extractDoors(rom),
  };
}
