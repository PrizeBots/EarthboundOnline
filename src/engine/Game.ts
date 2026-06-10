import { Camera } from './Camera';
import { Player } from './Player';
import { Renderer } from './Renderer';
import { initInput, isActionPressed, getKeySet } from './Input';
import { loadMapData, getSector, getDrawTilesetId } from './MapManager';
import { loadDoors, getDoorAt, DoorData } from './DoorManager';
import { loadAtlas } from './TilesetManager';
import { loadCollision, checkCollision, computeRoomBounds } from './Collision';
import { loadSpriteMetadata, loadSpriteGroup, CUSTOM_GROUP_BASE } from './SpriteManager';
import { connect, sendPosition } from './Network';
import { loadMusicMap, initMusic, updateMusic } from './MusicManager';
import {
  loadCharacterSelect,
  updateCharacterSelect,
  drawCharacterSelect,
  handleCharSelectInput,
  getSelectedSpriteGroupId,
} from './CharacterSelect';
import {
  loadCharacterCreate,
  updateCharacterCreate,
  drawCharacterCreate,
  handleCharCreateInput,
  getCreatedAppearance,
} from './CharacterCreate';
import { registerCustomAppearance } from './CharacterComposite';
import { loadFont }                             from './TextRenderer';
import { loadWindowStyle }                      from './WindowRenderer';
import { initMenu, updateMenu, isMenuOpen, renderMenu } from './MenuManager';
import {
  initChat,
  handleChatKey,
  isChatTyping,
  updateChatBubbles,
  renderChat,
  addRemoteBubble,
  removeBubble,
} from './ChatManager';
import {
  RemotePlayer,
  CharacterAppearance,
  Direction,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
  MAP_WIDTH_SECTORS,
  MAP_HEIGHT_SECTORS,
  TILE_SIZE,
} from '../types';

type GamePhase = 'loading' | 'charselect' | 'charcreate' | 'playing';

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
      loadFont(0), // regular EB dialogue font (chat input, command menu)
      loadFont(1), // Mr. Saturn font (backlogged chat option)
      loadFont(4), // small 8px battle font (speech bubbles)
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
      } else if (result === 'create') {
        loadCharacterCreate().then(() => {
          if (this.phase === 'charselect') this.phase = 'charcreate';
        });
      }
      return;
    }

    if (this.phase === 'charcreate') {
      const result = handleCharCreateInput(e.key);
      if (result === 'confirm') {
        initMusic(); // Must be called from user gesture for AudioContext
        this.startGame(getCreatedAppearance());
      } else if (result === 'back') {
        this.phase = 'charselect';
      }
      return;
    }

    if (this.phase === 'playing') {
      // While typing, chat captures every key. Otherwise Enter opens chat,
      // but not over the menu or during a door transition.
      if (isChatTyping()) {
        handleChatKey(e);
        return;
      }
      if (isMenuOpen() || this.transitioning) return;
      handleChatKey(e);
    }
  }

  private async startGame(appearance?: CharacterAppearance) {
    this.phase = 'loading';

    let spriteGroupId: number;
    if (appearance) {
      spriteGroupId = await registerCustomAppearance(appearance);
      console.log(`Custom character: ${JSON.stringify(appearance)}`);
    } else {
      spriteGroupId = getSelectedSpriteGroupId();
      console.log(`Selected character: sprite group ${spriteGroupId}`);
    }
    this.player.spriteGroupId = spriteGroupId;

    // Load map, player sprite, and tilesets
    console.log('Loading map data...');
    await Promise.all([loadMapData(), loadDoors()]);

    if (!appearance) {
      console.log('Loading player sprite...');
      await loadSpriteGroup(spriteGroupId);
    }

    console.log('Loading tilesets around spawn...');
    await this.loadNearbySectors();

    // In case the spawn point is inside an interior, crop to that room.
    this.updateRoomBounds(this.player.state.x, this.player.state.y);

    initInput();
    initMenu(getKeySet());
    initChat(getKeySet());

    // Connect to multiplayer server
    connect(spriteGroupId, `Player`, appearance ?? null, {
      onWelcome: (playerId, players) => {
        this.localPlayerId = playerId;
        for (const p of players) {
          this.remotePlayers.set(p.id, p);
          this.resolveRemoteSprite(p);
        }
        console.log(`Connected as ${playerId}, ${players.length} other players online`);
      },
      onPlayerJoin: (player) => {
        this.remotePlayers.set(player.id, player);
        this.resolveRemoteSprite(player);
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
        removeBubble(id);
        console.log(`Player ${id} left`);
      },
      onChat: (id, text) => {
        addRemoteBubble(id, text);
      },
    });

    this.phase = 'playing';
    console.log('Ready! Use arrow keys or WASD to move');
  }

  /**
   * Make a remote player's sprite drawable: composite their custom appearance
   * or load their ROM sprite group. Falls back to Ness if neither resolves.
   */
  private resolveRemoteSprite(rp: RemotePlayer) {
    const fallback = () => {
      rp.spriteGroupId = 1;
      loadSpriteGroup(1);
    };
    if (rp.appearance) {
      registerCustomAppearance(rp.appearance as CharacterAppearance)
        .then((id) => {
          rp.spriteGroupId = id;
        })
        .catch(fallback);
    } else if (rp.spriteGroupId >= CUSTOM_GROUP_BASE) {
      fallback(); // custom id with no appearance data — can't render it
    } else {
      loadSpriteGroup(rp.spriteGroupId).catch(fallback);
    }
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

  /**
   * Recompute the camera's room crop for a world pixel position. Interiors get
   * clamped/cropped to the current room; outdoor areas scroll freely (null).
   */
  private updateRoomBounds(worldX: number, worldY: number) {
    this.camera.roomBounds = computeRoomBounds(worldX, worldY);
  }

  private startTransition(door: DoorData) {
    console.log(`Door: (${door.worldX},${door.worldY}) -> (${door.destX},${door.destY}) player:(${Math.round(this.player.state.x)},${Math.round(this.player.state.y)})`);
    this.transitioning = true;
    this.transitionAlpha = 0;
    this.pendingDoor = door;
    // Keep the current room crop while fading out — the destination's bounds
    // are computed on arrival. Dropping it here would flash adjacent rooms.
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

          // Crop the camera to the destination room if it's an interior.
          this.updateRoomBounds(destX, destY);

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

    if (this.phase === 'charcreate') {
      updateCharacterCreate();
      return;
    }

    if (this.phase !== 'playing') return;

    // Float/fade chat bubbles regardless of other state.
    updateChatBubbles();

    // Handle door transition animation
    if (this.transitioning) {
      this.updateTransition();
      return;
    }

    // While typing a chat message, freeze movement, menu, and door triggers.
    if (isChatTyping()) return;

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

    if (this.phase === 'charcreate') {
      drawCharacterCreate(this.ctx);
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

    // Chat bubbles (world) + typing box (screen), above the world but below
    // the transition fade and menu.
    renderChat(this.ctx, this.camera, this.player, this.remotePlayers);

    // Draw fade overlay during transitions
    if (this.transitionAlpha > 0) {
      this.ctx.fillStyle = `rgba(0, 0, 0, ${this.transitionAlpha})`;
      this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    }

    // Draw menu on top of game world (including during transitions)
    renderMenu(this.ctx);
  }
}
