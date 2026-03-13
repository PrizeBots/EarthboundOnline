import { loadJSON } from './AssetLoader';
import { RoomBounds } from './Camera';
import { checkCollision } from './Collision';
import { MINITILE_SIZE, TILE_SIZE } from '../types';


export interface DoorData {
  // Pixel position in world space
  worldX: number;
  worldY: number;
  type: string;
  // Destination in pixels (only for type === 'door')
  destX: number;
  destY: number;
  destDir: number;
  style: number;
}

// Raw JSON format from extraction
interface RawDoor {
  x: number; // minitile offset within door area
  y: number;
  type: string;
  destX?: number; // minitile coords in full map
  destY?: number;
  destDir?: number;
  style?: number;
  flag?: number;
  direction?: number;
}

// Door areas are a 32x40 grid, each 256x256 pixels (NOT 1:1 with sectors)
const DOOR_GRID_COLS = 32;
const DOOR_AREA_PX = 256; // each door area is 256x256 pixels

// All warpable doors indexed by door area
let doorsByArea: DoorData[][] = [];

// Zone-transition overrides: style=0 doors that need manual interior links.
// Key: "worldX,worldY" of the zone door. Value: correct interior destination.
// These are buildings whose entrances use zone transitions instead of standard doors.
const ZONE_DOOR_OVERRIDES: Record<string, { destX: number; destY: number; destDir: number; style: number }> = {
};

export async function loadDoors(): Promise<void> {
  const raw = await loadJSON<RawDoor[][]>('/assets/map/doors.json');

  doorsByArea = raw.map((area, idx) => {
    const areaX = idx % DOOR_GRID_COLS;
    const areaY = Math.floor(idx / DOOR_GRID_COLS);
    const originX = areaX * DOOR_AREA_PX;
    const originY = areaY * DOOR_AREA_PX;

    return area
      .filter((d) => {
        if (d.type !== 'door') return false;

        // For style=0 short-range zone transitions: only keep if we have an override
        if (d.style === 0) {
          const destPx = (d.destX ?? 0) * MINITILE_SIZE;
          const destPy = (d.destY ?? 0) * MINITILE_SIZE;
          const worldX = originX + d.x * MINITILE_SIZE;
          const worldY = originY + d.y * MINITILE_SIZE;
          if (Math.abs(destPx - worldX) + Math.abs(destPy - worldY) < 128) {
            const key = `${worldX + 4},${worldY + 4}`;
            return ZONE_DOOR_OVERRIDES[key] !== undefined;
          }
        }
        return true;
      })
      .map((d) => {
        const worldX = originX + d.x * MINITILE_SIZE + 4;
        const worldY = originY + d.y * MINITILE_SIZE + 4;
        const key = `${worldX},${worldY}`;

        // Apply zone door override if available
        const override = ZONE_DOOR_OVERRIDES[key];
        if (override) {
          return {
            worldX, worldY, type: d.type,
            destX: override.destX,
            destY: override.destY,
            destDir: override.destDir,
            style: override.style,
          };
        }

        return {
          worldX, worldY, type: d.type,
          destX: (d.destX ?? 0) * MINITILE_SIZE,
          destY: (d.destY ?? 0) * MINITILE_SIZE,
          destDir: d.destDir ?? 0,
          style: d.style ?? 0,
        };
      });
  });

  const total = doorsByArea.reduce((n, a) => n + a.length, 0);
  console.log(`Loaded ${total} doors across ${doorsByArea.length} areas`);
}

// Trigger size in pixels
const TRIGGER_X = 6;
const TRIGGER_Y = 8;

/**
 * Check if a position overlaps any door in nearby areas.
 * px, py = player feet position. We check from the midsection (py - 12).
 */
export function getDoorAt(px: number, py: number): DoorData | null {
  // Check from player midsection, not feet
  const checkY = py - 12;
  const ax = Math.floor(px / DOOR_AREA_PX);
  const ay = Math.floor(checkY / DOOR_AREA_PX);

  // Check current area and immediate neighbors (doors can be on edges)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cy < 0 || cx >= DOOR_GRID_COLS) continue;
      const idx = cy * DOOR_GRID_COLS + cx;
      if (idx < 0 || idx >= doorsByArea.length) continue;

      const doors = doorsByArea[idx];
      for (const door of doors) {
        const distX = Math.abs(px - door.worldX);
        const distY = Math.abs(checkY - door.worldY);
        if (distX <= TRIGGER_X && distY <= TRIGGER_Y) {
          return door;
        }
      }
    }
  }

  return null;
}

/**
 * Get all doors in nearby areas for rendering door indicators.
 */
export function getDoorsNear(px: number, py: number): DoorData[] {
  const ax = Math.floor(px / DOOR_AREA_PX);
  const ay = Math.floor(py / DOOR_AREA_PX);
  const result: DoorData[] = [];

  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cy < 0 || cx >= DOOR_GRID_COLS) continue;
      const idx = cy * DOOR_GRID_COLS + cx;
      if (idx < 0 || idx >= doorsByArea.length) continue;
      result.push(...doorsByArea[idx]);
    }
  }

  return result;
}
