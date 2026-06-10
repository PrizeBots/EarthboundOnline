import { Camera } from './Camera';
import { Player } from './Player';
import { getTileAt, getSectorForTile } from './MapManager';
import { drawTile, drawForegroundTile, hasForegroundTile } from './TilesetManager';
import { drawSprite, SpritePart } from './SpriteManager';
import { getDoorsNear, DoorData } from './DoorManager';
import { getSpritePriority } from './Collision';
import { RemotePlayer, SCREEN_WIDTH, SCREEN_HEIGHT, TILE_SIZE, MAP_WIDTH_TILES } from '../types';

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;

    this.resizeToFit();
    window.addEventListener('resize', () => this.resizeToFit());
  }

  private resizeToFit() {
    const scaleX = window.innerWidth / SCREEN_WIDTH;
    const scaleY = window.innerHeight / SCREEN_HEIGHT;
    const scale = Math.max(1, Math.floor(Math.min(scaleX, scaleY)));
    this.canvas.style.width = `${SCREEN_WIDTH * scale}px`;
    this.canvas.style.height = `${SCREEN_HEIGHT * scale}px`;
  }

  render(camera: Camera, player: Player, remotePlayers: Map<string, RemotePlayer>) {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    const { startCol, startRow, endCol, endRow } = camera.getVisibleTileRange();

    // In interiors, clip everything to the current room's tiles so adjacent
    // rooms (packed next to each other on the map) stay hidden behind black.
    const room = camera.roomBounds;
    if (room) {
      const camX = Math.floor(camera.x);
      const camY = Math.floor(camera.y);
      this.ctx.save();
      this.ctx.beginPath();
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          if (!room.tiles.has(row * MAP_WIDTH_TILES + col)) continue;
          this.ctx.rect(col * TILE_SIZE - camX, row * TILE_SIZE - camY, TILE_SIZE, TILE_SIZE);
        }
      }
      this.ctx.clip();
    }

    // Pass 1: Draw all tiles as background
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const sector = getSectorForTile(col, row);
        if (!sector) continue;
        const arrangementId = getTileAt(col, row);
        const screenX = Math.floor(col * TILE_SIZE - camera.x);
        const screenY = Math.floor(row * TILE_SIZE - camera.y);
        drawTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, screenX, screenY);
      }
    }

    // SNES layering model: sprites render ABOVE the whole FG layer unless the
    // ground under their feet is flagged. Bit 0x01 drops the sprite's LOWER
    // half behind FG (bed feet, sofa backs, counters); bit 0x02 drops the
    // UPPER half (under tree canopies). The map data encodes all depth
    // relationships through these flags — no Y-sorting against FG tiles.

    const behindFG: { sortY: number; draw: () => void }[] = [];
    const aboveFG: { sortY: number; draw: () => void }[] = [];

    const enqueueSprite = (
      worldX: number,
      worldY: number,
      drawPart: (part: SpritePart) => void
    ) => {
      const pri = getSpritePriority(worldX, worldY);
      const lowerBehind = (pri & 0x01) !== 0;
      const upperBehind = (pri & 0x02) !== 0;
      if (lowerBehind && upperBehind) {
        behindFG.push({ sortY: worldY, draw: () => drawPart('full') });
      } else if (!lowerBehind && !upperBehind) {
        aboveFG.push({ sortY: worldY, draw: () => drawPart('full') });
      } else {
        behindFG.push({ sortY: worldY, draw: () => drawPart(lowerBehind ? 'lower' : 'upper') });
        aboveFG.push({ sortY: worldY, draw: () => drawPart(lowerBehind ? 'upper' : 'lower') });
      }
    };

    enqueueSprite(player.state.x, player.state.y, (part) => {
      const sx = Math.floor(player.state.x - camera.x);
      const sy = Math.floor(player.state.y - camera.y);
      drawSprite(this.ctx, player.spriteGroupId, player.state.direction, player.state.frame, sx, sy, part);
    });

    for (const [, rp] of remotePlayers) {
      const rpScreenX = Math.floor(rp.x - camera.x);
      const rpScreenY = Math.floor(rp.y - camera.y);
      if (rpScreenX < -32 || rpScreenX > SCREEN_WIDTH + 32) continue;
      if (rpScreenY < -48 || rpScreenY > SCREEN_HEIGHT + 48) continue;
      enqueueSprite(rp.x, rp.y, (part) =>
        drawSprite(this.ctx, rp.spriteGroupId, rp.direction, rp.frame, rpScreenX, rpScreenY, part)
      );
    }

    // Pass 2: sprite halves dropped behind the FG layer (Y-sorted among themselves)
    behindFG.sort((a, b) => a.sortY - b.sortY);
    for (const item of behindFG) item.draw();

    // Pass 3: the FG layer (flat, like a high-priority SNES BG layer)
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const sector = getSectorForTile(col, row);
        if (!sector) continue;
        if (!hasForegroundTile(sector.tilesetId, sector.paletteId)) continue;
        const arrangementId = getTileAt(col, row);
        const screenX = Math.floor(col * TILE_SIZE - camera.x);
        const screenY = Math.floor(row * TILE_SIZE - camera.y);
        drawForegroundTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, screenX, screenY);
      }
    }

    // Pass 4: sprite halves above the FG layer (Y-sorted among themselves)
    aboveFG.sort((a, b) => a.sortY - b.sortY);
    for (const item of aboveFG) item.draw();

    // Black out minitiles of neighboring rooms that share an edge tile with
    // the current room (sub-tile leftovers of the room mask).
    if (room && room.holes.length > 0) {
      this.ctx.fillStyle = '#000';
      for (const hole of room.holes) {
        const hx = Math.floor(hole.x - camera.x);
        const hy = Math.floor(hole.y - camera.y);
        if (hx < -8 || hx > SCREEN_WIDTH || hy < -8 || hy > SCREEN_HEIGHT) continue;
        this.ctx.fillRect(hx, hy, 8, 8);
      }
    }

    // Door indicators (UI overlay, always on top)
    const nearbyDoors = getDoorsNear(player.state.x, player.state.y);
    for (const door of nearbyDoors) {
      const doorScreenX = Math.floor(door.worldX - camera.x);
      const doorScreenY = Math.floor(door.worldY - camera.y);
      if (doorScreenX < -16 || doorScreenX > SCREEN_WIDTH + 16) continue;
      if (doorScreenY < -16 || doorScreenY > SCREEN_HEIGHT + 16) continue;

      this.ctx.fillStyle = 'rgba(255, 255, 100, 0.7)';
      const ax = doorScreenX;
      const ay = doorScreenY - 18;
      this.ctx.beginPath();
      this.ctx.moveTo(ax - 4, ay);
      this.ctx.lineTo(ax + 4, ay);
      this.ctx.lineTo(ax, ay + 5);
      this.ctx.closePath();
      this.ctx.fill();
    }

    if (room) {
      this.ctx.restore();
    }
  }
}
