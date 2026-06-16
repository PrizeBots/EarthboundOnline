/**
 * Sector-settings bake — the worker equivalent of add_sector_settings.py, but
 * reading the sector attribute tables straight from the ROM instead of the
 * CoilSnake `map_sectors.yml` decompile (which is itself ROM-derived and can't
 * ship). Tags each sector with `indoor` / `dungeon` / `town`, exactly as the
 * Python bake does, driving the room crop + editor location navigator.
 */
import { Rom, fromSnesAddress } from './Rom';
import type { Sector } from './map';

const SECTOR_MISC_TABLE = 0xd7b200; // 2 bytes/sector: setting in byte0 & 7
const SECTOR_TOWN_MAP_TABLE = 0xefa70f; // 3 bytes/sector: town image in byte0 & 0xf

// Enum names (lowercased, matching CoilSnake's yml output).
const SETTINGS = [
  'none',
  'indoors',
  'exit mouse usable',
  'lost underworld sprites',
  'magicant sprites',
  'robot sprites',
  'butterflies',
  'indoors and butterflies',
];
const TOWN_IMAGES = ['none', 'onett', 'twoson', 'threed', 'fourside', 'scaraba', 'summers'];

export type TaggedSector = Sector & { indoor: boolean; dungeon: boolean; town?: string };

/**
 * Tag sectors in place with indoor/dungeon/town. `indoor` = the "indoors"
 * setting; `dungeon` = any non-"none"/non-"indoors" setting (caves, magicant,
 * robot, lost-underworld) — all room-cropped like interiors. `town` is the
 * overworld region name (absent for "none").
 */
export function bakeSectorSettings(rom: Rom, sectors: Sector[]): TaggedSector[] {
  const miscBase = fromSnesAddress(SECTOR_MISC_TABLE);
  const townBase = fromSnesAddress(SECTOR_TOWN_MAP_TABLE);

  return sectors.map((sector, i) => {
    const setting = SETTINGS[rom.byte(miscBase + i * 2) & 7] ?? 'none';
    const townImage = TOWN_IMAGES[rom.byte(townBase + i * 3) & 0xf] ?? 'none';

    const tagged: TaggedSector = {
      ...sector,
      indoor: setting === 'indoors',
      dungeon: setting !== 'none' && setting !== 'indoors',
    };
    if (townImage !== 'none') tagged.town = townImage;
    return tagged;
  });
}
