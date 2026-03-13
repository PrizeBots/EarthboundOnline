import { Camera } from './Camera';
import { Player } from './Player';
import { getTileAt, getSectorForTile } from './MapManager';
import { drawTile, drawForegroundTile } from './TilesetManager';
import { drawSprite } from './SpriteManager';
import { getDoorsNear, DoorData } from './DoorManager';
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

    // Pass 2: Draw all sprites Y-sorted
    const sprites: { worldY: number; draw: () => void }[] = [];

    sprites.push({
      worldY: player.state.y,
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
      sprites.push({
        worldY: rp.y,
        draw: () => drawSprite(this.ctx, rp.spriteGroupId, rp.direction, rp.frame, rpScreenX, rpScreenY),
      });
    }

    sprites.sort((a, b) => a.worldY - b.worldY);
    for (const s of sprites) s.draw();

    // Pass 3: Draw foreground layer on top of sprites (tree canopies, building eaves, etc.)
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const sector = getSectorForTile(col, row);
        if (!sector) continue;
        const arrangementId = getTileAt(col, row);
        const screenX = Math.floor(col * TILE_SIZE - camera.x);
        const screenY = Math.floor(row * TILE_SIZE - camera.y);
        drawForegroundTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, screenX, screenY);
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
  }
}
