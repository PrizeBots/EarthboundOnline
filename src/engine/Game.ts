import { Camera } from './Camera';
import { Player } from './Player';
import { Renderer } from './Renderer';
import { initInput, isActionPressed, getKeySet } from './Input';
import { loadMapData, getSector, getDrawTilesetId } from './MapManager';
import { loadDoors, getDoorAt, DoorData } from './DoorManager';
import { loadAtlas } from './TilesetManager';
import { loadCollision, checkCollision } from './Collision';
import { loadSpriteMetadata, loadSpriteGroup } from './SpriteManager';
import { connect, sendPosition } from './Network';
import { loadMusicMap, initMusic, updateMusic } from './MusicManager';
import {
  loadCharacterSelect,
  updateCharacterSelect,
  drawCharacterSelect,
  handleCharSelectInput,
  getSelectedSpriteGroupId,
} from './CharacterSelect';
import { loadFont }                             from './TextRenderer';
import { loadWindowStyle }                      from './WindowRenderer';
import { initMenu, updateMenu, isMenuOpen, renderMenu } from './MenuManager';
import {
  RemotePlayer,
  Direction,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
  MAP_WIDTH_SECTORS,
  MAP_HEIGHT_SECTORS,
  TILE_SIZE,
} from '../types';

type GamePhase = 'loading' | 'charselect' | 'playing';

export class Game {
  private camera = new Camera();
  private player = new Player();
  private renderer: Renderer;
  private ctx: CanvasRenderingContext2D;
  private loadedAtlases = new Set<string>();
  private loadingPromise: Promise<void> | null = null;
  private phase: GamePhase = 'loading';
  private remotePlayers = new Map<string, RemotePlayer>();
  private localPlayerId = '';
  private sendTimer = 0;
  private transitioning = false;
  private transitionAlpha = 0;
  private pendingDoor: DoorData | null = null;
  private waitingForSectors = false;
  private doorSuppressed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.ctx = canvas.getContext('2d')!;
  }

  async init() {
    console.log('Loading sprite metadata...');
    await loadSpriteMetadata();

    console.log('Loading character select...');
    await Promise.all([
      loadCharacterSelect(),
      loadMusicMap(),
      loadFont(1),
      loadWindowStyle(0),
    ]);

    // Set up character select input
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.phase = 'charselect';
    console.log('Character select ready!');
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.phase === 'charselect') {
      const result = handleCharSelectInput(e.key);
      if (result === 'confirm') {
        initMusic(); // Must be called from user gesture for AudioContext
        this.startGame();
      }
    }
  }

  private async startGame() {
    this.phase = 'loading';
    const spriteGroupId = getSelectedSpriteGroupId();
    this.player.spriteGroupId = spriteGroupId;

    console.log(`Selected character: sprite group ${spriteGroupId}`);

    // Load map, player sprite, and tilesets
    console.log('Loading map data...');
    await Promise.all([loadMapData(), loadDoors()]);

    console.log('Loading player sprite...');
    await loadSpriteGroup(spriteGroupId);

    console.log('Loading tilesets around spawn...');
    await this.loadNearbySectors();

    initInput();
    initMenu(getKeySet());

    // Connect to multiplayer server
    connect(spriteGroupId, `Player`, {
      onWelcome: (playerId, players) => {
        this.localPlayerId = playerId;
        for (const p of players) {
          this.remotePlayers.set(p.id, p);
          loadSpriteGroup(p.spriteGroupId);
        }
        console.log(`Connected as ${playerId}, ${players.length} other players online`);
      },
      onPlayerJoin: (player) => {
        this.remotePlayers.set(player.id, player);
        loadSpriteGroup(player.spriteGroupId);
        console.log(`${player.name} joined`);
      },
      onPlayerMove: (id, x, y, direction, frame) => {
        const rp = this.remotePlayers.get(id);
        if (rp) {
          rp.x = x;
          rp.y = y;
          rp.direction = direction;
          rp.frame = frame;
        }
      },
      onPlayerLeave: (id) => {
        this.remotePlayers.delete(id);
        console.log(`Player ${id} left`);
      },
    });

    this.phase = 'playing';
    console.log('Ready! Use arrow keys or WASD to move');
  }

  private async loadNearbySectors() {
    const sectorX = Math.floor(this.player.state.x / (SECTOR_TILES_X * TILE_SIZE));
    const sectorY = Math.floor(this.player.state.y / (SECTOR_TILES_Y * TILE_SIZE));

    const rangeX = 4;
    const rangeY = 6;

    const promises: Promise<void>[] = [];

    for (let sy = sectorY - rangeY; sy <= sectorY + rangeY; sy++) {
      for (let sx = sectorX - rangeX; sx <= sectorX + rangeX; sx++) {
        if (sx < 0 || sx >= MAP_WIDTH_SECTORS) continue;
        if (sy < 0 || sy >= MAP_HEIGHT_SECTORS) continue;

        const sector = getSector(sx, sy);
        if (!sector) continue;

        const atlasKey = `${sector.tilesetId}_${sector.paletteId}`;
        if (this.loadedAtlases.has(atlasKey)) continue;
        this.loadedAtlases.add(atlasKey);

        const drawTilesetId = getDrawTilesetId(sector.tilesetId);

        promises.push(
          Promise.all([
            loadAtlas(sector.tilesetId, sector.paletteId),
            loadCollision(drawTilesetId),
          ]).then(() => {})
        );
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  private startTransition(door: DoorData) {
    console.log(`Door: (${door.worldX},${door.worldY}) -> (${door.destX},${door.destY}) player:(${Math.round(this.player.state.x)},${Math.round(this.player.state.y)})`);
    this.transitioning = true;
    this.transitionAlpha = 0;
    this.pendingDoor = door;
    this.camera.roomBounds = null;
  }

  private updateTransition() {
    const FADE_SPEED = 0.06;

    if (this.pendingDoor) {
      // Fading out
      this.transitionAlpha += FADE_SPEED;
      if (this.transitionAlpha >= 1) {
        this.transitionAlpha = 1;
        const door = this.pendingDoor;
        this.pendingDoor = null;
        this.waitingForSectors = true;

        // Move player to destination area so loadNearbySectors loads the right tiles
        this.player.state.x = door.destX;
        this.player.state.y = door.destY;

        // Load sectors FIRST, then nudge and detect room
        this.loadNearbySectors().then(() => {
          const dirMap = [Direction.S, Direction.N, Direction.E, Direction.W];
          const dir = dirMap[door.destDir] ?? Direction.S;

          // Now collision data is loaded — nudge out of walls
          let destX = door.destX;
          let destY = door.destY;
          const COL_W = 14, COL_H = 8, COL_OY = -8;

          if (checkCollision(destX - COL_W/2, destY + COL_OY, COL_W, COL_H)) {
            // Try nudging in all directions, facing direction first
            const allNudges: [number, number][] = [];
            for (let dist = 8; dist <= 32; dist += 8) {
              if (dir === Direction.S) allNudges.push([0,dist]);
              else if (dir === Direction.N) allNudges.push([0,-dist]);
              else if (dir === Direction.W) allNudges.push([-dist,0]);
              else if (dir === Direction.E) allNudges.push([dist,0]);
            }
            // Also try all 4 directions
            for (let dist = 8; dist <= 32; dist += 8) {
              allNudges.push([0,dist],[0,-dist],[dist,0],[-dist,0]);
            }

            for (const [nx, ny] of allNudges) {
              const tx = door.destX + nx;
              const ty = door.destY + ny;
              if (!checkCollision(tx - COL_W/2, ty + COL_OY, COL_W, COL_H)) {
                destX = tx;
                destY = ty;
                break;
              }
            }
          }

          this.player.state.x = destX;
          this.player.state.y = destY;
          this.player.state.direction = dir;
          this.player.state.moving = false;
          this.player.state.frame = 0;

          this.camera.roomBounds = null;

          this.camera.follow(destX, destY);
          // Suppress doors until player walks out of all trigger zones
          this.doorSuppressed = true;
          this.waitingForSectors = false;
        });
      }
    } else if (this.waitingForSectors) {
      // Stay black until sectors are loaded
    } else {
      // Fading in
      this.transitionAlpha -= FADE_SPEED;
      if (this.transitionAlpha <= 0) {
        this.transitionAlpha = 0;
        this.transitioning = false;
      }
    }
  }

  start() {
    const loop = () => {
      this.update();
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private update() {
    if (this.phase === 'charselect') {
      updateCharacterSelect();
      return;
    }

    if (this.phase !== 'playing') return;

    // Handle door transition animation
    if (this.transitioning) {
      this.updateTransition();
      return;
    }

    // Update menu state — when open, suppress game movement
    updateMenu();
    if (isMenuOpen()) return;

    this.player.update();
    this.camera.follow(this.player.state.x, this.player.state.y);

    // Suppress doors until player has fully left all trigger zones
    const door = getDoorAt(this.player.state.x, this.player.state.y);
    if (this.doorSuppressed) {
      if (!door) this.doorSuppressed = false;
    } else if (door) {
      if (this.player.state.moving) {
        this.startTransition(door);
        return;
      }
      if (isActionPressed()) {
        this.startTransition(door);
        return;
      }
    }

    // Update music based on current sector
    updateMusic(this.player.state.x, this.player.state.y);

    // Send position to server every 3 frames
    this.sendTimer++;
    if (this.sendTimer >= 3) {
      this.sendTimer = 0;
      sendPosition(
        this.player.state.x,
        this.player.state.y,
        this.player.state.direction,
        this.player.state.frame
      );
    }

    if (!this.loadingPromise) {
      this.loadingPromise = this.loadNearbySectors().finally(() => {
        this.loadingPromise = null;
      });
    }
  }

  private render() {
    if (this.phase === 'charselect') {
      drawCharacterSelect(this.ctx);
      return;
    }

    if (this.phase === 'loading') {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      this.ctx.fillStyle = '#fff';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('Loading...', SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
      this.ctx.textAlign = 'left';
      return;
    }

    this.renderer.render(this.camera, this.player, this.remotePlayers);

    // Draw fade overlay during transitions
    if (this.transitionAlpha > 0) {
      this.ctx.fillStyle = `rgba(0, 0, 0, ${this.transitionAlpha})`;
      this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    }

    // Draw menu on top of game world (including during transitions)
    renderMenu(this.ctx);
  }
}
