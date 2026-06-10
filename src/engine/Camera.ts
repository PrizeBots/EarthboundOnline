import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  MAP_WIDTH_TILES,
  MAP_HEIGHT_TILES,
  TILE_SIZE,
} from '../types';

export interface RoomBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  // Tile keys (tileY * MAP_WIDTH_TILES + tileX) belonging to the room — its
  // floor plus surrounding walls. The renderer clips to these tiles so that
  // neighboring rooms inside the bounding rect (e.g. across a staircase
  // complex) stay hidden behind black.
  tiles: Set<number>;
  // World-pixel positions of 8x8 minitiles inside the masked tiles that
  // belong to a NEIGHBORING room's floor (walls aren't always tile-aligned).
  // The renderer paints these black on top of the world.
  holes: { x: number; y: number }[];
}

export class Camera {
  x = 0;
  y = 0;
  roomBounds: RoomBounds | null = null;

  follow(targetX: number, targetY: number) {
    // Center camera on target
    this.x = targetX - SCREEN_WIDTH / 2;
    this.y = targetY - SCREEN_HEIGHT / 2;

    if (this.roomBounds) {
      // Clamp to room bounds
      const roomW = this.roomBounds.maxX - this.roomBounds.minX;
      const roomH = this.roomBounds.maxY - this.roomBounds.minY;

      if (roomW <= SCREEN_WIDTH) {
        // Room fits on screen — center it
        this.x = this.roomBounds.minX + (roomW - SCREEN_WIDTH) / 2;
      } else {
        this.x = Math.max(this.roomBounds.minX, Math.min(this.x, this.roomBounds.maxX - SCREEN_WIDTH));
      }

      if (roomH <= SCREEN_HEIGHT) {
        this.y = this.roomBounds.minY + (roomH - SCREEN_HEIGHT) / 2;
      } else {
        this.y = Math.max(this.roomBounds.minY, Math.min(this.y, this.roomBounds.maxY - SCREEN_HEIGHT));
      }
    } else {
      // Clamp to map bounds
      const maxX = MAP_WIDTH_TILES * TILE_SIZE - SCREEN_WIDTH;
      const maxY = MAP_HEIGHT_TILES * TILE_SIZE - SCREEN_HEIGHT;
      this.x = Math.max(0, Math.min(this.x, maxX));
      this.y = Math.max(0, Math.min(this.y, maxY));
    }
  }

  /** Get range of visible tiles (inclusive) */
  getVisibleTileRange() {
    const startCol = Math.floor(this.x / TILE_SIZE);
    const startRow = Math.floor(this.y / TILE_SIZE);
    const endCol = Math.ceil((this.x + SCREEN_WIDTH) / TILE_SIZE);
    const endRow = Math.ceil((this.y + SCREEN_HEIGHT) / TILE_SIZE);
    return { startCol, startRow, endCol, endRow };
  }
}
