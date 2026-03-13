import { Camera } from './Camera';
import { Player } from './Player';
import { getTileAt, getSectorForTile } from './MapManager';
import { drawTile, drawForegroundTile, hasForegroundTile } from './TilesetManager';
import { drawSprite } from './SpriteManager';
import { getDoorsNear, DoorData } from './DoorManager';
import { tileHasAnySolid } from './Collision';
import { RemotePlayer, SCREEN_WIDTH, SCREEN_HEIGHT, TILE_SIZE } from '../types';

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

    // Pass 2: Collect sprites and FG tiles into a Y-sorted draw list
    // FG tiles on solid ground (fences, walls, signs) → Y-sorted with sprites
    // FG tiles on walkable ground (tree canopies, overhangs) → always on top (pass 3)
    const drawList: { sortY: number; draw: () => void }[] = [];
    const overheadFG: (() => void)[] = [];

    // Add sprites
    drawList.push({
      sortY: player.state.y,
      draw: () => {
        const sx = Math.floor(player.state.x - camera.x);
        const sy = Math.floor(player.state.y - camera.y);
        drawSprite(this.ctx, player.spriteGroupId, player.state.direction, player.state.frame, sx, sy);
      },
    });

    for (const [, rp] of remotePlayers) {
      const rpScreenX = Math.floor(rp.x - camera.x);
      const rpScreenY = Math.floor(rp.y - camera.y);
      if (rpScreenX < -32 || rpScreenX > SCREEN_WIDTH + 32) continue;
      if (rpScreenY < -48 || rpScreenY > SCREEN_HEIGHT + 48) continue;
      drawList.push({
        sortY: rp.y,
        draw: () => drawSprite(this.ctx, rp.spriteGroupId, rp.direction, rp.frame, rpScreenX, rpScreenY),
      });
    }

    // Add FG tiles, categorized by collision
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const sector = getSectorForTile(col, row);
        if (!sector) continue;
        if (!hasForegroundTile(sector.tilesetId, sector.paletteId)) continue;

        const arrangementId = getTileAt(col, row);
        const screenX = Math.floor(col * TILE_SIZE - camera.x);
        const screenY = Math.floor(row * TILE_SIZE - camera.y);
        const drawFn = () =>
          drawForegroundTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, screenX, screenY);

        // If this tile or the tile below has any solid collision,
        // it's a ground-level object (fence, wall, sign) → depth sort.
        // Otherwise it's overhead (tree canopy, bridge) → always on top.
        if (tileHasAnySolid(col, row) || tileHasAnySolid(col, row + 1)) {
          drawList.push({
            sortY: (row + 1) * TILE_SIZE, // bottom of tile = depth position
            draw: drawFn,
          });
        } else {
          overheadFG.push(drawFn);
        }
      }
    }

    // Draw Y-sorted: sprites and depth-based FG interleaved
    drawList.sort((a, b) => a.sortY - b.sortY);
    for (const item of drawList) item.draw();

    // Pass 3: Overhead FG always on top (tree canopies, etc.)
    for (const fn of overheadFG) fn();

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
  }
}
