import { Camera, RoomBounds } from './Camera';
import { Player } from './Player';
import { Renderer, setDebugBoxes, debugBoxesOn } from './Renderer';
import { loadJSON, loadImage } from './AssetLoader';
import {
  initInput,
  isActionPressed,
  isTalkPressed,
  isAttackPressed,
  isCycleItemPressed,
  isHurtPressed,
  isToggleBoxesPressed,
  getKeySet,
  consumePointerClick,
  flushKeys,
} from './Input';
import { loadMapData, getSector, getDrawTilesetId } from './MapManager';
import { loadDoors, getDoorAt, getStairAt, getStairExit, DoorData } from './DoorManager';
import { setActiveRoomFromPoint } from './Rooms';
import {
  loadNPCs,
  getNearbyNPCs,
  applyNpcUpdates,
  applyNpcHp,
  getNpcDialogue,
  interpolateNpcs,
} from './NPCManager';
import { NPC } from './NPC';
import { loadAtlas } from './TilesetManager';
import {
  loadCollision,
  checkPlayerCollision,
  isSolidAtPoint,
  computeRoomBounds,
  setActiveRoom,
} from './Collision';
import {
  loadSpriteMetadata,
  loadSpriteGroup,
  registerCustomSheet,
  registerRecoloredSprite,
  CUSTOM_GROUP_BASE,
} from './SpriteManager';
import {
  connect,
  sendPosition,
  sendEquip,
  sendAttack,
  sendWarpState,
  sendEditorMode,
  sendSpendPoints,
  sendFlag,
  JoinAuth,
} from './Network';
import { getToken, CharacterSummary } from './Auth';
import { initNameplates } from './NamePlate';
import { initLevelUpButton, setLevelUpPoints } from './LevelUpButton';
import { openLevelUp, isLevelUpOpen } from './LevelUpModal';
import { loadNameOverrides, getSpriteName } from './SpriteNames';
import { loadSongNameOverrides } from './SongNames';
import { setStatus } from './StatusModal';
import { pushRemoteSnapshot, dropRemoteBuffer, interpolateRemotePlayer } from './RemoteInterp';
import { getItemName, loadItemSprites } from './Items';
import { loadCustomTiles } from './CustomTiles';
import { itemEquip } from './Shop';
import { getEquipped, setEquipped, setEquippedFromServer } from './Equipment';
import {
  loadMusicMap,
  loadMusicAreas,
  initMusic,
  updateMusic,
  playCharSelectMusic,
  playSfx,
} from './MusicManager';
import {
  loadCharacterSelect,
  updateCharacterSelect,
  drawCharacterSelect,
  handleCharSelectInput,
  handleCharSelectClick,
  getSelectedSpriteGroupId,
} from './CharacterSelect';
import {
  initStartScreen,
  openStartScreen,
  isStartScreenOpen,
  setStartScreenPlayHandler,
} from './StartScreen';
import { loadFont } from './TextRenderer';
import { loadWindowStyle } from './WindowRenderer';
import {
  initMenu,
  updateMenu,
  isMenuOpen,
  renderMenu,
  openShop,
  openPhoneMenu,
} from './MenuManager';
import {
  initDialogue,
  openDialogue,
  isDialogueOpen,
  updateDialogue,
  renderDialogue,
} from './DialogueManager';
import { emitGameEvent } from './EventBus';
import { loadFlagRegistry, getPlayerDefaultFlags } from './FlagRegistry';
import { setFlagSink, hydrateFlags, seedDefaults } from './PlayerFlags';
import { initFlagTriggers } from './FlagTriggers';
import { installFlagConsole } from './flagConsole';
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
  updateEmitters,
  renderEmitters,
  spawnDamageNumber,
  spawnHealNumber,
  spawnXpNumber,
  spawnLevelUp,
  spawnCritText,
  spawnMissText,
} from './Emitter';
import { playEventSfx } from './SfxEvents';
import { setGoods, getGoods } from './Inventory';
import { setMoney } from './Wallet';
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
  MAP_WIDTH_TILES,
  TILE_SIZE,
  MINITILE_SIZE,
} from '../types';

type GamePhase = 'loading' | 'charselect' | 'playing';

/** Options for starting the game: anonymous (char-select) or a signed-in save. */
interface StartOpts {
  spriteGroupId?: number;
  appearance?: CharacterAppearance | null;
  name?: string;
  spawn?: { x: number; y: number; dir: number };
  auth?: JoinAuth | null;
}

// Unit facing vectors, indexed by Direction, for the talk/check probe.
const DIAG = Math.SQRT1_2;
const DIR_VECTORS: Record<Direction, [number, number]> = {
  [Direction.S]: [0, 1],
  [Direction.N]: [0, -1],
  [Direction.W]: [-1, 0],
  [Direction.E]: [1, 0],
  [Direction.NW]: [-DIAG, -DIAG],
  [Direction.SW]: [-DIAG, DIAG],
  [Direction.SE]: [DIAG, DIAG],
  [Direction.NE]: [DIAG, -DIAG],
};

export class Game {
  private camera = new Camera();
  private player = new Player();
  private renderer: Renderer;
  private ctx: CanvasRenderingContext2D;
  private canvasEl: HTMLCanvasElement;
  // Dev-only editor layer (EDITOR_TOOLS.md); null in production builds.
  private editor: import('../editor').EditorHooks | null = null;
  private loadedAtlases = new Set<string>();
  private loadingPromise: Promise<void> | null = null;
  private phase: GamePhase = 'loading';
  private remotePlayers = new Map<string, RemotePlayer>();
  private localPlayerId = '';
  // Banked skill points + current allocation (server-authoritative; mirrored for
  // the level-up icon + the spend pentagon).
  private unspentPoints = 0;
  private pointsAlloc: Record<string, number> = {};
  private sendTimer = 0;
  private transitioning = false;
  private transitionAlpha = 0;
  private pendingDoor: DoorData | null = null;
  private waitingForSectors = false;
  private doorSuppressed = false;
  // Active escalator/stairway ride: the player glides this diagonal along the
  // walkable ramp; on reaching the end we warp through `exit` to the next floor
  // (null = no floor door found, just stop and re-crop in place).
  private riding: { dx: number; dy: number; dist: number; exit: DoorData | null } | null = null;
  private stairSuppressed = false;
  private talkingNpc: NPC | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.ctx = canvas.getContext('2d')!;
    this.canvasEl = canvas;
  }

  async init() {
    console.log('Loading sprite metadata...');
    await loadSpriteMetadata();

    console.log('Loading character select...');
    await Promise.all([
      loadNameOverrides(), // admin renames win over baked sprite names
      loadSongNameOverrides(), // admin song renames win over baked titles
      loadCharacterSelect(),
      loadMusicMap(),
      loadMusicAreas(), // authored music regions (overrides/music.json)
      loadFont(0), // regular EB dialogue font (chat input, command menu)
      loadFont(1), // Mr. Saturn font (backlogged chat option)
      loadFont(4), // small 8px battle font (speech bubbles)
      loadWindowStyle(0),
    ]);

    // Set up character select input. initInput here (idempotent) attaches the
    // pointer listeners NOW so clicks work on the character-select screen, not
    // just after the game starts.
    initInput(this.canvasEl);
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Dev-only editor tools — the dynamic import inside a DEV guard compiles
    // out of production builds entirely (EDITOR_TOOLS.md).
    if (import.meta.env.DEV) {
      void import('../editor').then((m) => {
        this.editor = m.initEditorTools({
          canvas: this.canvasEl,
          ctx: this.ctx,
          camera: this.camera,
          player: this.player,
          teleport: (x, y) => void this.debugTeleport(x, y),
          streamView: () => this.loadSectorsInView(),
          setEditing: (on) => sendEditorMode(on),
          canEnter: () =>
            this.phase === 'playing' &&
            !isChatTyping() &&
            !isMenuOpen() &&
            !isDialogueOpen() &&
            !this.transitioning,
          ensurePlaying: () => this.ensurePlaying(),
        });
      });
    }

    // Dev-only flag console: prove/inspect the flag+trigger+dialogue spine live.
    //   __eb.flags.demo(textId)  — branch that NPC's line on a flag AND register a
    //                              trigger that sets the flag when you finish talking
    //   __eb.flags.set/clear/has/list/reset
    if (import.meta.env.DEV) installFlagConsole();

    // TITLE/AUTH account overlay (START_SCREEN.md). Built hidden; opened from the
    // ACCOUNTS button on character select. Char select stays the dev boot screen.
    // The slot list spawns a chosen/created character into the game via playCharacter.
    initStartScreen();
    setStartScreenPlayHandler((char) => void this.playCharacter(char));
    initNameplates(); // preload the EB font used for in-world name/level tags
    // Corner level-up icon → opens the spend pentagon. The server validates the
    // spend; sendSpendPoints only requests it.
    initLevelUpButton(
      () => void openLevelUp(this.pointsAlloc, this.unspentPoints, (add) => sendSpendPoints(add))
    );

    this.phase = 'charselect';
    console.log('Character select ready!');
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.phase === 'charselect') {
      // The account overlay (DOM) captures its own keys; ignore them here so
      // typing a username doesn't also browse the character grid.
      if (isStartScreenOpen()) return;
      // First key press is a user gesture — start the naming-screen music.
      playCharSelectMusic();
      const result = handleCharSelectInput(e.key);
      if (result === 'confirm') {
        initMusic(); // Must be called from user gesture for AudioContext
        this.startGame();
      }
      return;
    }

    if (this.phase === 'playing') {
      // Editor mode owns the keyboard entirely (its listeners capture first;
      // this is the belt-and-suspenders check).
      if (this.editor?.isActive()) return;
      // While typing, chat captures every key. Otherwise Enter opens chat,
      // but not over the menu or during a door transition.
      if (isChatTyping()) {
        handleChatKey(e);
        return;
      }
      // Dialogue owns Enter while open (it advances pages, not chat).
      if (isMenuOpen() || this.transitioning || isDialogueOpen() || isLevelUpOpen()) return;
      handleChatKey(e);
    }
  }

  /**
   * Bring the game into a playable state so the admin editor can be entered
   * from a non-gameplay screen (F2 on character select / any screen). On
   * character select this starts the game as the default selected character
   * (Ness); a normal `startGame()` flips the phase to 'playing' when done.
   */
  private async ensurePlaying(): Promise<boolean> {
    if (this.phase === 'charselect') {
      initMusic(); // F2 is a user gesture, so the AudioContext may start here
      await this.startGame(); // default selected character (Ness)
    }
    return this.phase === 'playing';
  }

  private async startGame(opts: StartOpts = {}) {
    this.phase = 'loading';
    const appearance = opts.appearance ?? null;

    let spriteGroupId: number;
    if (appearance) {
      spriteGroupId = await registerCustomSheet(appearance);
      console.log(`Custom character sheet registered as group ${spriteGroupId}`);
    } else {
      spriteGroupId = opts.spriteGroupId ?? getSelectedSpriteGroupId();
      console.log(`Selected character: sprite group ${spriteGroupId}`);
    }
    this.player.spriteGroupId = spriteGroupId;

    // Load map, player sprite, and tilesets
    console.log('Loading map data...');
    await Promise.all([
      loadMapData(),
      loadDoors(),
      loadNPCs(),
      loadItemSprites(),
      loadCustomTiles(), // author-drawn custom room tiles (overrides/custom_tiles.json)
    ]);

    // Flag/quest system: load the catalog (seeds new-player defaults) and the
    // trigger table (subscribes to the EventBus). After loadNPCs so dialogue
    // branches resolve against a populated PlayerFlags store.
    await Promise.all([loadFlagRegistry(), initFlagTriggers()]);

    // Editor-authored spawn override (public/overrides/spawn.json) takes
    // precedence over the src/spawn.json default baked into Player.
    const spawnOv = await loadJSON<{ x: number; y: number; dir: number }>(
      '/overrides/spawn.json'
    ).catch(() => null);
    if (spawnOv) {
      this.player.x = spawnOv.x;
      this.player.y = spawnOv.y;
      this.player.direction = spawnOv.dir as Direction;
    }
    // A signed-in character restores its saved position (wins over the defaults).
    if (opts.spawn) {
      this.player.x = opts.spawn.x;
      this.player.y = opts.spawn.y;
      this.player.direction = opts.spawn.dir as Direction;
    }

    if (!appearance) {
      console.log('Loading player sprite...');
      await loadSpriteGroup(spriteGroupId);
    }

    console.log('Loading tilesets around spawn...');
    await this.loadNearbySectors();

    // In case the spawn point is inside an interior, crop to that room.
    this.updateRoomBounds(this.player.x, this.player.y);

    // Status screen shows the character's name: the saved/created name if any,
    // else the sprite's authored name.
    setStatus({ name: opts.name ?? getSpriteName(spriteGroupId) ?? 'Player' });

    initInput(this.canvasEl);
    // Equip/hotbar hooks: the menu equips gear per EB slot. We update the local
    // mirror optimistically (so the screen reflects it at once), set the held
    // sprite for a weapon change, and tell the server (which applies the
    // equipped offense/defense to combat and echoes back the authoritative set).
    initMenu(getKeySet(), {
      getEquipped: (slot) => getEquipped(slot),
      equip: (slot, id) => {
        setEquipped(slot, id);
        if (slot === 'weapon') this.player.heldItemId = id;
        sendEquip(slot, id);
      },
    });
    initChat(getKeySet());
    initDialogue(getKeySet());

    // Route player-flag writes to the server (it owns the persisted copy in the
    // character save). Set before connect so optimistic writes always have a sink.
    setFlagSink((action, id) => sendFlag(action, id));

    // Connect to multiplayer server (anonymous, or signed-in via opts.auth).
    connect(
      spriteGroupId,
      opts.name ?? 'Player',
      appearance,
      {
        onWelcome: (playerId, players) => {
          this.localPlayerId = playerId;
          for (const p of players) {
            this.remotePlayers.set(p.id, p);
            this.resolveRemoteSprite(p);
          }
          console.log(`Connected as ${playerId}, ${players.length} other players online`);
        },
        onFlags: (ids) => {
          // Restore the character's saved flags, THEN seed default-on flags for a
          // fresh character (seedDefaults no-ops if the save already had any).
          hydrateFlags(ids);
          const defaults = getPlayerDefaultFlags();
          if (defaults.length) seedDefaults(defaults);
        },
        onPlayerJoin: (player) => {
          this.remotePlayers.set(player.id, player);
          this.resolveRemoteSprite(player);
          console.log(`${player.name} joined`);
        },
        onPlayerMove: (id, x, y, direction, frame, pose) => {
          // Buffered, not applied directly: update() interpolates each frame
          // (RemoteInterp) so remote players glide instead of stepping once
          // per packet.
          if (this.remotePlayers.has(id)) {
            pushRemoteSnapshot(id, x, y, direction, frame, pose);
          }
        },
        onPlayerLeave: (id) => {
          this.remotePlayers.delete(id);
          dropRemoteBuffer(id);
          removeBubble(id);
          console.log(`Player ${id} left`);
        },
        onChat: (id, text) => {
          addRemoteBubble(id, text);
        },
        onEquip: (id, itemId) => {
          const rp = this.remotePlayers.get(id);
          if (rp) rp.itemId = itemId;
        },
        onEquipped: (slots) => {
          // Authoritative equipped set for the local player — re-sync the mirror
          // and the held-weapon sprite.
          setEquippedFromServer(slots);
          this.player.heldItemId = slots.weapon ?? null;
        },
        onNpcUpdate: (rows) => {
          applyNpcUpdates(rows);
        },
        onNpcHp: (rows) => {
          applyNpcHp(rows);
        },
        onPlayerHp: (id, hp, maxHp, dmg, heal) => {
          if (id === this.localPlayerId) {
            this.player.hp = hp;
            this.player.maxHp = maxHp;
            if (dmg > 0) {
              spawnDamageNumber(this.player.x, this.player.y, dmg);
              this.player.hurt(); // flinch pose; broadcast to others via sendPosition
            }
            if (heal > 0) spawnHealNumber(this.player.x, this.player.y, heal);
            setStatus({ hp, hpMax: maxHp }); // reflect in the Status screen
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              rp.hp = hp;
              rp.maxHp = maxHp;
              if (dmg > 0) spawnDamageNumber(rp.x, rp.y, dmg);
              if (heal > 0) spawnHealNumber(rp.x, rp.y, heal);
            }
          }
        },
        onInventory: (items) => {
          setGoods(items); // mirror the server's Goods list for the menu
        },
        onMoney: (amount) => {
          setMoney(amount); // mirror the server's balance for the menu
        },
        onPlayerRespawn: (id, x, y, dir) => {
          if (id === this.localPlayerId) {
            this.player.x = x;
            this.player.y = y;
            this.player.direction = dir;
            this.player.moving = false;
            this.player.frame = 0;
            // While editing (dev), the free camera owns the view — don't yank it
            // back to the avatar. The server shouldn't respawn us at all in editor
            // mode (we're pulled from the sim); this guards a late in-flight hit.
            if (!this.editor?.isActive()) {
              this.camera.follow(x, y);
              this.updateRoomBounds(x, y);
            }
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              rp.x = x;
              rp.y = y;
            }
            dropRemoteBuffer(id); // snap across the map, don't glide
          }
        },
        onPlayerStats: (id, stats, leveled, gained) => {
          if (id !== this.localPlayerId) {
            // Keep remote players' nameplate level current on their level-ups.
            const rp = this.remotePlayers.get(id);
            if (rp) rp.level = stats.level;
            return;
          }
          // Server-authoritative progression — mirror it into the Status screen
          // and the local HP bar (welcome sends the saved stats this way too, so a
          // high-level character spawns with the right max HP), and pop floats off
          // the player so kills/level-ups feel rewarding.
          setStatus(stats);
          this.player.maxHp = stats.hpMax;
          this.player.hp = stats.hp;
          if (gained > 0) spawnXpNumber(this.player.x, this.player.y, gained);
          if (leveled) spawnLevelUp(this.player.x, this.player.y);
        },
        onPoints: (points, alloc) => {
          // Authoritative banked points + alloc (server pushes on level-up / spend /
          // join). Mirror for the icon + spend pentagon.
          this.unspentPoints = points;
          this.pointsAlloc = alloc;
          setLevelUpPoints(points);
        },
        onCombat: (evt, x, y, byPlayer, targetPlayer) => {
          // Crit/miss events: floating SMAAAASH!/MISS text for everyone, plus the
          // right SFX for the LOCAL player (see SfxEvents / ARCHITECTURE combat).
          if (evt === 'crit') {
            spawnCritText(x, y);
            if (byPlayer === this.localPlayerId) playEventSfx('crit');
          } else {
            spawnMissText(x, y);
            if (byPlayer === this.localPlayerId) playEventSfx('attack-miss');
            else if (targetPlayer === this.localPlayerId) playEventSfx('player-dodge');
          }
        },
      },
      opts.auth ?? null
    );

    // Drop the confirm keypress (E/Enter) that started the game so the first
    // playing frame doesn't read it as a Talk/Check ("no problem here").
    flushKeys();
    this.phase = 'playing';
    console.log('Ready! Use arrow keys or WASD to move');
  }

  /**
   * Spawn into the game as a signed-in, persistent character: join by session
   * token + characterId so the server loads the save (level/inventory/equip/
   * stats), and restore the saved world position. Called by the Start Screen's
   * slot list (new character → spawn, or Continue an existing one).
   */
  async playCharacter(char: CharacterSummary) {
    const token = getToken();
    if (!token) {
      console.error('playCharacter: not signed in');
      return;
    }
    const save = (char.save ?? {}) as { x?: number; y?: number; direction?: number };
    const spawn =
      typeof save.x === 'number' && typeof save.y === 'number'
        ? { x: save.x, y: save.y, dir: typeof save.direction === 'number' ? save.direction : 0 }
        : undefined;
    // The recolored sheet is a ROM-format sprite (not the editor's band format),
    // so register it via registerRecoloredSprite and spawn by that group id —
    // never pass it as `appearance` (registerCustomSheet would reject it).
    let spriteGroupId = char.spriteGroupId;
    if (char.appearance) {
      try {
        const img = await loadImage(char.appearance);
        spriteGroupId = await registerRecoloredSprite(char.spriteGroupId, img);
      } catch (e) {
        console.error('recolored sprite failed; using the base sprite', e);
      }
    }
    await this.startGame({
      spriteGroupId,
      name: char.name,
      spawn,
      auth: { sessionToken: token, characterId: char.id },
    });
  }

  /**
   * Make a remote player's sprite drawable: register their custom pixel-edited
   * sheet or load their ROM sprite group. Falls back to Ness if neither resolves.
   */
  private resolveRemoteSprite(rp: RemotePlayer) {
    const fallback = () => {
      rp.spriteGroupId = 1;
      loadSpriteGroup(1);
    };
    if (rp.appearance) {
      // Discriminate the two appearance formats by the sprite-group id: a real
      // roster id (< CUSTOM_GROUP_BASE) means a recolored ROM sprite from the
      // creator; a synthetic id means the sprite editor's band sheet.
      const resolved =
        rp.spriteGroupId < CUSTOM_GROUP_BASE
          ? loadImage(rp.appearance).then((img) => registerRecoloredSprite(rp.spriteGroupId, img))
          : registerCustomSheet(rp.appearance);
      resolved
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
    const sectorX = Math.floor(this.player.x / (SECTOR_TILES_X * TILE_SIZE));
    const sectorY = Math.floor(this.player.y / (SECTOR_TILES_Y * TILE_SIZE));
    await this.loadSectorRange(sectorX - 4, sectorY - 6, sectorX + 4, sectorY + 6);
  }

  /**
   * Editor free-fly: gameplay streams atlases around the (now frozen) player,
   * so the free camera would pan over un-loaded sectors that render black with
   * only doors/NPCs on them. Stream whatever the camera currently shows instead.
   * Fire-and-forget per frame — the loadedAtlases set makes repeat calls cheap.
   */
  loadSectorsInView(): void {
    const { startCol, startRow, endCol, endRow } = this.camera.getVisibleTileRange();
    void this.loadSectorRange(
      Math.floor(startCol / SECTOR_TILES_X) - 1,
      Math.floor(startRow / SECTOR_TILES_Y) - 1,
      Math.floor(endCol / SECTOR_TILES_X) + 1,
      Math.floor(endRow / SECTOR_TILES_Y) + 1
    );
  }

  /** Load (once) the BG/FG atlas + collision for every sector in a range. */
  private async loadSectorRange(sx0: number, sy0: number, sx1: number, sy1: number) {
    const promises: Promise<void>[] = [];
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
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
    // Seal the room for movement: packed interiors share walkable strips
    // with their neighbors, so the player may only leave through a door.
    setActiveRoom(this.camera.roomBounds);
    // Track which registered interior room (if any) the player is in. With
    // stamped copies each room is a distinct region, so this follows from the
    // position; overworld points resolve to the implicit "world" room.
    setActiveRoomFromPoint(worldX, worldY);
  }

  /**
   * Room bounds for an escalator ride: the UNION of the floor the player is
   * leaving, the floor they're arriving on, and the ramp tiles between. The two
   * floors are separate crop regions (stacked + joined only by the solid ramp),
   * so without this the destination renders black while you glide. Built once at
   * ride start and held until the ride re-crops to the destination on arrival.
   */
  private computeRideBounds(dx: number, dy: number): RoomBounds | null {
    const src = computeRoomBounds(this.player.x, this.player.y);
    // March along the ramp to the landing (same end test the ride uses),
    // collecting the tiles the player will glide across.
    const pathTiles = new Set<number>();
    let x = this.player.x;
    let y = this.player.y;
    for (let i = 0; i < 48; i++) {
      pathTiles.add(Math.floor(y / TILE_SIZE) * MAP_WIDTH_TILES + Math.floor(x / TILE_SIZE));
      const footY = y - MINITILE_SIZE / 2;
      if (isSolidAtPoint(x + dx * MINITILE_SIZE, footY + dy * MINITILE_SIZE)) break;
      x += dx * MINITILE_SIZE;
      y += dy * MINITILE_SIZE;
    }
    const dst = computeRoomBounds(x, y);
    if (!src && !dst) return null;

    const tiles = new Set<number>(pathTiles);
    const cells = new Set<number>();
    for (const b of [src, dst]) {
      if (!b) continue;
      for (const t of b.tiles) tiles.add(t);
      for (const c of b.cells) cells.add(c);
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const t of tiles) {
      const tx = t % MAP_WIDTH_TILES;
      const ty = (t - tx) / MAP_WIDTH_TILES;
      minX = Math.min(minX, tx * TILE_SIZE);
      minY = Math.min(minY, ty * TILE_SIZE);
      maxX = Math.max(maxX, (tx + 1) * TILE_SIZE);
      maxY = Math.max(maxY, (ty + 1) * TILE_SIZE);
    }
    return { minX, minY, maxX, maxY, tiles, holes: [], cells };
  }

  /**
   * Advance an active escalator/stairway ride one frame. EB escalators are a
   * walkable diagonal ramp bounded by SOLID at each landing strip; the ramp is
   * too narrow (and corner-connected) for normal foot-box movement, so we glide
   * the player along it ignoring collision. The ride ends when the next minitile
   * ahead along the ramp is solid — i.e. we've reached the landing strip. The
   * room crop already spans the whole shaft, so we don't touch it mid-ride.
   */
  private updateRide() {
    const r = this.riding!;
    const RIDE_MAX = 256; // pixels; a ramp spans only a few tiles — runaway guard

    r.dist += this.player.rideStep(r.dx, r.dy);
    this.camera.follow(this.player.x, this.player.y);

    // Look one minitile ahead from the foot point along the ramp direction.
    const footY = this.player.y - MINITILE_SIZE / 2;
    const aheadSolid = isSolidAtPoint(
      this.player.x + r.dx * MINITILE_SIZE,
      footY + r.dy * MINITILE_SIZE
    );
    if (aheadSolid || r.dist >= RIDE_MAX) {
      const exit = r.exit;
      this.riding = null;
      this.stairSuppressed = true;
      this.player.moving = false;
      if (exit) {
        // Warp to the next floor — the fade transition reveals it fully.
        this.startTransition(exit);
      } else {
        // No floor door (open-floor bank) — just re-crop/re-seal in place.
        this.updateRoomBounds(this.player.x, this.player.y);
      }
    }
  }

  private startTransition(door: DoorData) {
    console.log(
      `Door: (${door.worldX},${door.worldY}) -> (${door.destX},${door.destY}) player:(${Math.round(this.player.x)},${Math.round(this.player.y)})`
    );
    this.transitioning = true;
    this.transitionAlpha = 0;
    this.pendingDoor = door;
    // Door SFX (door open / stairs / rope …) — authored per door in the
    // Placement Editor; fires once as the player uses it. Silent until the
    // audio is extracted into /assets/sfx/ (playSfx no-ops on a missing file).
    playSfx(door.sfx);
    // Shield against enemy hits while frozen: position sends stop for the whole
    // fade, so the server would otherwise let a pursuer keep swinging at the
    // motionless ghost we leave at the doorway. Cleared when the fade completes.
    sendWarpState(true);
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
        this.player.x = door.destX;
        this.player.y = door.destY;

        // Load sectors FIRST, then nudge and detect room
        this.loadNearbySectors().then(() => {
          const dirMap = [Direction.S, Direction.N, Direction.E, Direction.W];
          const dir = dirMap[door.destDir] ?? Direction.S;

          // Crop to the destination room BEFORE nudging, so the nudge can't
          // push the player out of the room (rooms are sealed; see bugs.md).
          this.updateRoomBounds(door.destX, door.destY);

          // Now collision data is loaded — nudge out of walls
          let destX = door.destX;
          let destY = door.destY;
          const COL_W = 14,
            COL_H = 8,
            COL_OY = -8;

          if (checkPlayerCollision(destX - COL_W / 2, destY + COL_OY, COL_W, COL_H)) {
            // Try nudging in all directions, facing direction first
            const allNudges: [number, number][] = [];
            for (let dist = 8; dist <= 32; dist += 8) {
              if (dir === Direction.S) allNudges.push([0, dist]);
              else if (dir === Direction.N) allNudges.push([0, -dist]);
              else if (dir === Direction.W) allNudges.push([-dist, 0]);
              else if (dir === Direction.E) allNudges.push([dist, 0]);
            }
            // Also try all 4 directions
            for (let dist = 8; dist <= 32; dist += 8) {
              allNudges.push([0, dist], [0, -dist], [dist, 0], [-dist, 0]);
            }

            for (const [nx, ny] of allNudges) {
              const tx = door.destX + nx;
              const ty = door.destY + ny;
              if (!checkPlayerCollision(tx - COL_W / 2, ty + COL_OY, COL_W, COL_H)) {
                destX = tx;
                destY = ty;
                break;
              }
            }
          }

          this.player.x = destX;
          this.player.y = destY;
          this.player.direction = dir;
          this.player.moving = false;
          this.player.frame = 0;

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
        // Fade done — position sends resume; lift the damage shield. (A move
        // would clear it server-side anyway; this ends it promptly.)
        sendWarpState(false);
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

  /**
   * Dev/debug: jump to a world pixel position as if arriving through a door
   * (sector load + room crop + camera snap). Exposed via window.__eb for
   * console use and verification scripts.
   */
  async debugTeleport(x: number, y: number): Promise<void> {
    if (this.phase !== 'playing') return;
    this.player.x = x;
    this.player.y = y;
    this.player.moving = false;
    await this.loadNearbySectors();
    this.updateRoomBounds(x, y);
    this.camera.follow(x, y);
    this.doorSuppressed = true;
  }

  private update() {
    if (this.phase === 'charselect') {
      updateCharacterSelect();
      // While the account overlay is up it owns input (DOM); don't also drive
      // the canvas grid underneath it.
      if (isStartScreenOpen()) return;
      // Mouse: a click selects a character; clicking the selected one confirms.
      // The click is also a user gesture, so it can start the naming music.
      const click = consumePointerClick();
      if (click) {
        const result = handleCharSelectClick(click.x, click.y);
        if (result === 'startscreen') {
          openStartScreen();
          return;
        }
        playCharSelectMusic();
        if (result === 'confirm') {
          initMusic();
          void this.startGame();
        }
      }
      return;
    }

    if (this.phase !== 'playing') return;

    // Float/fade chat bubbles + damage/heal popups regardless of other state.
    updateChatBubbles();
    updateEmitters();

    // Remote players + server NPCs/enemies keep gliding even while menus/
    // dialogue/transitions freeze the local world — their senders haven't stopped.
    for (const [, rp] of this.remotePlayers) interpolateRemotePlayer(rp);
    interpolateNpcs();

    // Editor mode (dev only): free camera replaces gameplay simulation; the
    // world stays visible (remotes/NPCs keep updating above) but the player,
    // doors, and music hold still.
    if (this.editor?.isActive()) {
      this.editor.update();
      return;
    }

    // Handle door transition animation
    if (this.transitioning) {
      this.updateTransition();
      return;
    }

    // Riding an escalator/stairway: auto-walk takes over until the far landing.
    if (this.riding) {
      this.updateRide();
      return;
    }

    // While typing a chat message, freeze movement, menu, and door triggers.
    if (isChatTyping()) return;

    // Update menu state — when open, suppress game movement
    updateMenu();
    if (isMenuOpen()) return;

    // Spending skill points freezes the world behind the pentagon.
    if (isLevelUpOpen()) return;

    // NPC dialogue — while open, freeze movement, doors, and music updates.
    if (isDialogueOpen()) {
      updateDialogue();
      this.faceTalkingNpc();
      if (!isDialogueOpen()) {
        // Conversation finished — fire dialogue:done so flag triggers can react
        // (e.g. mark "met Mom" after her first line). Keyed by textId.
        const done = this.talkingNpc;
        if (done?.textId != null) {
          const tid = Number(done.textId);
          emitGameEvent({ type: 'dialogue:done', text: tid, npc: tid });
        }
        this.talkingNpc = null;
      }
      return;
    }

    // E = Talk to / Check whatever is in front of the player.
    if (isTalkPressed()) {
      this.tryTalk();
      return;
    }

    // F = attack swing, G = cycle held item, H = hurt flinch (debug hook).
    // A swing that actually starts is sent to the server, which resolves the
    // hit against enemies (server-authoritative damage).
    if (isAttackPressed() && this.player.attack()) {
      sendAttack(this.player.x, this.player.y, this.player.direction);
    }
    if (isHurtPressed()) this.player.hurt();
    if (isToggleBoxesPressed()) setDebugBoxes(!debugBoxesOn());
    if (isCycleItemPressed()) {
      // Cycle through the equippable gear in your inventory (+ none). Equipping a
      // catalog item broadcasts its id so everyone renders its held sprite.
      const weapons = getGoods()
        .filter((g) => itemEquip(g.id)?.slot === 'weapon')
        .map((g) => g.id);
      const cycle: (string | null)[] = [null, ...weapons];
      const idx = cycle.indexOf(this.player.heldItemId);
      const next = cycle[(idx + 1) % cycle.length] ?? null;
      this.player.heldItemId = next;
      setEquipped('weapon', next);
      sendEquip('weapon', next);
      console.log(`Equip weapon: ${next ? getItemName(next) : 'none'}`);
    }

    this.player.update();
    // NPC simulation is server-authoritative; getNearbyNPCs (in render) still
    // triggers lazy sprite-sheet loads as NPCs come into range.
    this.camera.follow(this.player.x, this.player.y);

    // Escalator/stairway: step the trigger to start a ride (suppress until the
    // player has fully left the trigger, so the arrival landing — often next to
    // the paired down-escalator — doesn't immediately bounce them back).
    const stair = getStairAt(this.player.x, this.player.y);
    if (this.stairSuppressed) {
      if (!stair) this.stairSuppressed = false;
    } else if (stair && this.player.moving) {
      // Glide the ramp, then warp through the shaft's floor door to the next
      // level. The shaft is already the active room crop, so leave it alone;
      // updateRide bypasses collision to cross the narrow diagonal.
      const exit = getStairExit(this.player.x, this.player.y, stair.dy);
      this.riding = { dx: stair.dx, dy: stair.dy, dist: 0, exit };
      // Reveal BOTH floors (and the ramp between) for the duration of the ride.
      // EB stacks floors as separate room-crop regions joined only by the solid
      // ramp, so the source-floor crop leaves the destination floor (and the
      // down-ramp) black — you ride into a black void and can't see the landing
      // (bugs.md, dept-store escalators). Only when there's no warp door: a
      // door-warp ride fades to its destination, so leave that path alone.
      if (!exit) {
        const ride = this.computeRideBounds(stair.dx, stair.dy);
        if (ride) this.camera.roomBounds = ride;
      }
      return;
    }

    // Suppress doors until player has fully left all trigger zones
    const door = getDoorAt(this.player.x, this.player.y);
    if (this.doorSuppressed) {
      if (!door) this.doorSuppressed = false;
    } else if (door) {
      if (this.player.moving) {
        this.startTransition(door);
        return;
      }
      if (isActionPressed()) {
        this.startTransition(door);
        return;
      }
    }

    // Update music based on current sector
    updateMusic(this.player.x, this.player.y);

    // Send position to server every 3 frames
    this.sendTimer++;
    if (this.sendTimer >= 3) {
      this.sendTimer = 0;
      sendPosition(
        this.player.x,
        this.player.y,
        this.player.direction,
        this.player.frame,
        this.player.pose
      );
    }

    if (!this.loadingPromise) {
      this.loadingPromise = this.loadNearbySectors().finally(() => {
        this.loadingPromise = null;
      });
    }
  }

  /**
   * Q pressed: talk to / check the NPC or prop in front of the player.
   * Mirrors EB's combined "Talk to"+"Check" command: a target with dialogue
   * speaks; empty space gives the classic Check fallback.
   */
  private tryTalk(): void {
    // Reach is measured along the facing direction, not as a radius around a
    // single probe point. A shop clerk's anchor sits a full counter-depth
    // behind the solid counter, so the player (whose foot box stops at the
    // counter's front edge) is ~45-60px from the clerk's anchor — beyond a
    // simple radius. Project each NPC onto the facing axis: allow a long FORWARD
    // reach (clears a counter) but a tight LATERAL band (stays directional, so
    // we don't grab someone standing off to the side).
    const REACH_FORWARD = 60; // how far ahead an anchor may be (≈2 tiles) — clears a counter plus a prop standing in front of the clerk
    const REACH_BACK = 8; // tolerate an anchor slightly behind / overlapping
    const REACH_LATERAL = 20; // must be roughly in line with the facing

    const v = DIR_VECTORS[this.player.direction] ?? DIR_VECTORS[Direction.S];
    const perpX = -v[1];
    const perpY = v[0];

    // Two passes in one loop: the nearest INTERACTIVE target (has dialogue or is
    // a shop clerk), and the nearest target of ANY kind. A shop clerk sits
    // behind its counter, and a blank prop or silent NPC often stands in front
    // of it — that closer, inert thing would otherwise win the probe and you'd
    // "Check" the counter instead of reaching the clerk. So an interactive
    // target always wins when one is in reach; nearest-anything is the Check
    // fallback.
    let best: NPC | null = null;
    let bestScore = Infinity;
    let bestInteractive: NPC | null = null;
    let bestInteractiveScore = Infinity;
    let bestPages: string[] | null = null;
    for (const npc of getNearbyNPCs(this.player.x, this.player.y)) {
      const ox = npc.x - this.player.x;
      const oy = npc.y - this.player.y;
      const forward = ox * v[0] + oy * v[1];
      const lateral = Math.abs(ox * perpX + oy * perpY);
      if (forward < -REACH_BACK || forward > REACH_FORWARD) continue;
      if (lateral > REACH_LATERAL) continue;
      // Nearest target in line with the facing wins (forward distance first,
      // lateral offset as a light tiebreak).
      const score = Math.max(0, forward) + lateral;
      if (score < bestScore) {
        bestScore = score;
        best = npc;
      }
      const pages = getNpcDialogue(npc);
      if ((pages || npc.shopStore !== null) && score < bestInteractiveScore) {
        bestInteractiveScore = score;
        bestInteractive = npc;
        bestPages = pages;
      }
    }

    const target = bestInteractive ?? best;
    if (target) {
      // A telephone opens the contact menu (Dad saves, Mom eases homesickness)
      // — takes priority over the phone's check text.
      if (target.isPhone) {
        console.log('Talk: telephone -> phone menu');
        openPhoneMenu();
        return;
      }
      // A shop clerk opens its store; anyone else talks (or gives the Check
      // fallback if they have nothing to say).
      if (target.shopStore !== null) {
        console.log(`Talk: shop clerk -> store ${target.shopStore}`);
        openShop(target.shopStore);
        return;
      }
      const pages = bestInteractive ? bestPages : null;
      console.log(
        `Talk: npc(${Math.round(target.x)},${Math.round(target.y)}) textId=${
          target.textId ?? '-'
        } score=${Math.round(
          bestInteractive ? bestInteractiveScore : bestScore
        )} ${pages ? `"${pages[0].slice(0, 40)}..."` : 'no dialogue (Check)'}`
      );
      openDialogue(pages ?? ['There was no problem here.']);
      this.talkingNpc = target;
      this.faceTalkingNpc();
    } else {
      console.log('Talk: nothing in reach');
      openDialogue(['There was no problem here.']);
      this.talkingNpc = null;
    }
  }

  /**
   * Keep the conversation partner turned toward the player. Re-applied every
   * frame because server npc_update rows would otherwise restore the wander
   * direction mid-conversation. Props (signs, trash cans) keep their pose.
   */
  private faceTalkingNpc(): void {
    const npc = this.talkingNpc;
    if (!npc || npc.kind !== 'person') return;
    const dx = this.player.x - npc.x;
    const dy = this.player.y - npc.y;
    npc.direction =
      Math.abs(dx) > Math.abs(dy)
        ? dx < 0
          ? Direction.W
          : Direction.E
        : dy < 0
          ? Direction.N
          : Direction.S;
  }

  private render() {
    // Non-gameplay screens draw straight onto the canvas, so set the base
    // transform to match the supersampled backbuffer (render() does this for
    // gameplay itself).
    if (this.phase === 'charselect') {
      this.renderer.prepareUI();
      drawCharacterSelect(this.ctx);
      return;
    }

    if (this.phase === 'loading') {
      this.renderer.prepareUI();
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      this.ctx.fillStyle = '#fff';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('Loading...', SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
      this.ctx.textAlign = 'left';
      return;
    }

    this.renderer.render(
      this.camera,
      this.player,
      this.remotePlayers,
      getNearbyNPCs(this.player.x, this.player.y)
    );

    // Chat bubbles (world) + typing box (screen), above the world but below
    // the transition fade and menu. Bubbles anchor to world positions, so
    // they ride the editor zoom transform when it's active.
    if (this.camera.zoom !== 1) {
      this.ctx.save();
      this.ctx.scale(this.camera.zoom, this.camera.zoom);
      renderEmitters(this.ctx, this.camera);
      renderChat(this.ctx, this.camera, this.player, this.remotePlayers);
      this.ctx.restore();
    } else {
      renderEmitters(this.ctx, this.camera);
      renderChat(this.ctx, this.camera, this.player, this.remotePlayers);
    }

    // NPC dialogue window, above bubbles but below the fade and menu.
    renderDialogue(this.ctx);

    // Draw fade overlay during transitions
    if (this.transitionAlpha > 0) {
      this.ctx.fillStyle = `rgba(0, 0, 0, ${this.transitionAlpha})`;
      this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    }

    // Draw menu on top of game world (including during transitions)
    renderMenu(this.ctx);

    // Editor overlays (dev only) — grids, readout highlights, tool overlays.
    if (this.editor?.isActive()) this.editor.drawOverlay();
  }
}
