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
  // Every walkable minitile of the room (keys: mty * mapWidthMT + mtx).
  // The local player's movement is constrained to these — packed rooms
  // share walkable under-wall strips, so leaving a room takes a door.
  cells: Set<number>;
}

/** A pure camera-scroll boundary in world pixels. Unlike RoomBounds it does NOT
 *  mask or seal — it only limits how far follow() may scroll. Used outdoors to
 *  keep the camera inside the current town so neighboring stitched chunks (e.g.
 *  the water/bridge below a town) don't bleed into view. */
export interface ScrollClamp {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Camera {
  x = 0;
  y = 0;
  roomBounds: RoomBounds | null = null;
  /** Outdoor town camera bound (null = scroll freely to the map edges). Only
   *  consulted when roomBounds is null — interior crop takes precedence. */
  scrollClamp: ScrollClamp | null = null;
  /**
   * View scale: 1 = native SNES view (always, during gameplay). The dev
   * editor zooms OUT by lowering this (<1 renders more world into the same
   * canvas) via mouse wheel; reset to 1 on editor exit.
   */
  zoom = 1;

  /** Visible world width/height in pixels at the current zoom. */
  get viewW(): number {
    return SCREEN_WIDTH / this.zoom;
  }

  get viewH(): number {
    return SCREEN_HEIGHT / this.zoom;
  }

  follow(targetX: number, targetY: number) {
    // Center camera on target
    this.x = targetX - this.viewW / 2;
    this.y = targetY - this.viewH / 2;

    if (this.roomBounds) {
      // Clamp to room bounds
      const roomW = this.roomBounds.maxX - this.roomBounds.minX;
      const roomH = this.roomBounds.maxY - this.roomBounds.minY;

      if (roomW <= this.viewW) {
        // Room fits on screen — center it
        this.x = this.roomBounds.minX + (roomW - this.viewW) / 2;
      } else {
        this.x = Math.max(
          this.roomBounds.minX,
          Math.min(this.x, this.roomBounds.maxX - this.viewW)
        );
      }

      if (roomH <= this.viewH) {
        this.y = this.roomBounds.minY + (roomH - this.viewH) / 2;
      } else {
        this.y = Math.max(
          this.roomBounds.minY,
          Math.min(this.y, this.roomBounds.maxY - this.viewH)
        );
      }
    } else {
      // Clamp to map bounds, then tighten to the outdoor room bound (no mask/
      // seal) PER AXIS — but only where the room is bigger than the view. A room
      // shorter/narrower than the screen can't hide its neighbors anyway, so we
      // leave that axis free-scrolling instead of locking the camera onto it.
      const mapMaxX = MAP_WIDTH_TILES * TILE_SIZE - this.viewW;
      const mapMaxY = MAP_HEIGHT_TILES * TILE_SIZE - this.viewH;
      let loX = 0,
        hiX = mapMaxX,
        loY = 0,
        hiY = mapMaxY;
      const c = this.scrollClamp;
      if (c) {
        if (c.maxX - c.minX > this.viewW) {
          loX = c.minX;
          hiX = c.maxX - this.viewW;
        }
        if (c.maxY - c.minY > this.viewH) {
          loY = c.minY;
          hiY = c.maxY - this.viewH;
        }
      }
      this.x = Math.max(loX, Math.min(this.x, hiX));
      this.y = Math.max(loY, Math.min(this.y, hiY));
    }
  }

  /** Get range of visible tiles (inclusive) */
  getVisibleTileRange() {
    const startCol = Math.floor(this.x / TILE_SIZE);
    const startRow = Math.floor(this.y / TILE_SIZE);
    const endCol = Math.ceil((this.x + this.viewW) / TILE_SIZE);
    const endRow = Math.ceil((this.y + this.viewH) / TILE_SIZE);
    return { startCol, startRow, endCol, endRow };
  }
}
