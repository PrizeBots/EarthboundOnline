/**
 * Door / warp extraction — ports CoilSnake's `DoorModule` + door decode (the
 * slice extract_rom.py's extract_doors uses). 1280 door areas; each area is a
 * count-prefixed list of 5-byte door records that point into the destination
 * bank (0xF0000) for their full data.
 *
 * Output matches extract_rom.py's doors.json: one array per area, each door a
 * plain object tagged by kind. Parity: `test/extract/doors.test.ts`.
 */
import { Rom, fromSnesAddress } from './Rom';

const DOOR_POINTER_TABLE = 0xd00000;
const NUM_DOOR_AREAS = 1280;
const DEST_BANK = 0xf0000;

// StairDirection / ClimbableType / DestinationDirection valid sets (decode bails
// to "invalid door" — which ends the area — on anything else, like CoilSnake).
const STAIR_DIRECTIONS = new Set([0x000, 0x100, 0x200, 0x300, 0x8000]);
const CLIMBABLE_LADDER = 0x0000;
const CLIMBABLE_ROPE = 0x8000;

/**
 * A door's destination text pointer (3 bytes) must be 0 or a valid ROM address
 * (0xC00000–0xFFFFFF); otherwise CoilSnake treats the whole door as invalid
 * (EbTextPointer.from_block). Clean ROMs use this to terminate door areas.
 */
function validTextPointer(rom: Rom, offset: number): boolean {
  const addr = rom.readMulti(offset, 3);
  return addr === 0 || (addr >= 0xc00000 && addr <= 0xffffff);
}

export type DoorRecord =
  | {
      x: number;
      y: number;
      type: 'door';
      destX: number;
      destY: number;
      destDir: number;
      style: number;
      flag: number;
    }
  | { x: number; y: number; type: 'stair'; direction: number }
  | { x: number; y: number; type: 'ladder' | 'rope' }
  | { x: number; y: number; type: 'switch'; flag: number }
  | { x: number; y: number; type: 'npc' };

/**
 * Decode a single 5-byte door at `offset`, or null if it's invalid (which tells
 * the caller to stop reading the current area — clean ROMs pad with invalids).
 */
function doorFromBlock(rom: Rom, offset: number): DoorRecord | null {
  const y = rom.byte(offset);
  const x = rom.byte(offset + 1);
  const typeId = rom.byte(offset + 2);

  switch (typeId) {
    case 0: {
      // SwitchDoor — flag lives at the destination, then a text pointer (+2)
      const dest = rom.readMulti(offset + 3, 2) | DEST_BANK;
      const flag = rom.readMulti(dest, 2);
      if (!validTextPointer(rom, dest + 2)) return null;
      return { x, y, type: 'switch', flag };
    }
    case 1: {
      // RopeOrLadderDoor
      const climb = rom.readMulti(offset + 3, 2);
      if (climb !== CLIMBABLE_LADDER && climb !== CLIMBABLE_ROPE) return null;
      return { x, y, type: climb === CLIMBABLE_LADDER ? 'ladder' : 'rope' };
    }
    case 2: {
      // Door — full destination record (text pointer first, like CoilSnake)
      const dest = rom.readMulti(offset + 3, 2) | DEST_BANK;
      if (!validTextPointer(rom, dest)) return null;
      const flag = rom.readMulti(dest + 4, 2);
      const destY = rom.byte(dest + 6) | ((rom.byte(dest + 7) & 0x3f) << 8);
      const destDir = (rom.byte(dest + 7) & 0xc0) >> 6;
      if (destDir > 3) return null; // not a valid DestinationDirection
      const destX = rom.readMulti(dest + 8, 2);
      const style = rom.byte(dest + 10);
      return { x, y, type: 'door', destX, destY, destDir, style, flag };
    }
    case 3:
    case 4: {
      // EscalatorOrStairwayDoor
      const direction = rom.readMulti(offset + 3, 2);
      if (!STAIR_DIRECTIONS.has(direction)) return null;
      return { x, y, type: 'stair', direction };
    }
    case 5:
    case 6: {
      // NpcDoor (person / object) — validate its text pointer; tagged "npc"
      const dest = rom.readMulti(offset + 3, 2) | DEST_BANK;
      if (!validTextPointer(rom, dest)) return null;
      return { x, y, type: 'npc' };
    }
    default:
      return null; // type >= 7 — invalid, ends the area
  }
}

/** Extract all door areas — the TS equivalent of extract_rom.py's extract_doors. */
export function extractDoors(rom: Rom): DoorRecord[][] {
  const pointers = rom.readTable(DOOR_POINTER_TABLE, NUM_DOOR_AREAS, 4);
  const areas: DoorRecord[][] = [];

  for (let i = 0; i < NUM_DOOR_AREAS; i++) {
    let offset = fromSnesAddress(pointers[i]);
    const numDoors = rom.readMulti(offset, 2);
    offset += 2;
    const area: DoorRecord[] = [];
    for (let j = 0; j < numDoors; j++) {
      const door = doorFromBlock(rom, offset);
      if (door === null) break; // invalid door ends the area
      area.push(door);
      offset += 5;
    }
    areas.push(area);
  }
  return areas;
}
