import { Camera, RoomBounds } from './Camera';
import { Player } from './Player';
import { Renderer, setDebugBoxes, debugBoxesOn } from './Renderer';
import { loadJSON, loadImage, imageLoadProgress } from './AssetLoader';
import {
  initInput,
  isActionPressed,
  isTalkPressed,
  isAttackPressed,
  isHurtPressed,
  consumeHotbarSlot,
  isToggleBoxesPressed,
  getKeySet,
  consumePointerClick,
  isPointerDown,
  flushKeys,
  releaseVirtualTaps,
} from './Input';
import { mountTouchControls, setTouchContext } from './TouchControls';
import { pollGamepads, mountGamepadDebug, consumeGamepadNav } from './Gamepad';
import { hotbarBoxAt } from './menu/layout';
import { loadMapData, getSector, getDrawTilesetId } from './MapManager';
import { loadDoors, getDoorAt, getStairAt, DoorData } from './DoorManager';
import { setActiveRoomFromPoint, loadRegionRooms } from './Rooms';
import {
  loadNPCs,
  getNearbyNPCs,
  getNpcsInRect,
  applyNpcUpdates,
  applyNpcHp,
  applyNpcStatus,
  applyNpcEquip,
  applyNpcDeath,
  applyGiftFlagStates,
  getNpcDialogue,
  interpolateNpcs,
  predictPlayerPush,
  predictMeleeKnockback,
  liveNpcForKey,
} from './NPCManager';
import { NPC } from './NPC';
import { beginGiftOpen, giftOpened } from './Gifts';
import { loadAtlas } from './TilesetManager';
import { loadCollision, checkPlayerCollision, computeRoomBounds, setActiveRoom } from './Collision';
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
  sendInput,
  sendUseDoor,
  sendRideWarp,
  sendEditorTeleport,
  sendEquip,
  sendAttack,
  sendWarpState,
  sendEditorMode,
  sendSpendPoints,
  sendFlag,
  sendSetPk,
  sendOpenGift,
  sendMomFood,
  sendGiveUp,
  sendUsePsi,
  sendEventTalk,
  mountNetDebug,
  JoinAuth,
  EventStateWire,
} from './Network';
import { drawText, measureText } from './TextRenderer';
import { FONT_ID } from './menu/layout';
import { getToken, CharacterSummary } from './Auth';
import { initNameplates } from './NamePlate';
import { initLevelUpButton, setLevelUpPoints } from './LevelUpButton';
import { openLevelUp, isLevelUpOpen } from './LevelUpModal';
import { loadNameOverrides, getSpriteName } from './SpriteNames';
import { loadCustomSprites } from './CustomSprites';
import { loadSongNameOverrides } from './SongNames';
import { setStatus } from './StatusModal';
import {
  pushRemoteSnapshot,
  dropRemoteBuffer,
  interpolateRemotePlayer,
  applyPredOffset,
  applyRemoteSwing,
  applyRemoteHurt,
  injectPredOffset,
} from './RemoteInterp';
import { loadItemSprites, loadCustomItems } from './Items';
import { loadItemFolders } from './ItemFolders';
import { loadCustomTiles } from './CustomTiles';
import { getEquipped, setEquipped, setEquippedFromServer } from './Equipment';
import {
  loadMusicMap,
  initMusic,
  updateMusic,
  playCharSelectMusic,
  armCharSelectAudioUnlock,
  disarmCharSelectAudioUnlock,
  playSfx,
} from './MusicManager';
import { initSettings } from './Settings';
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
  renderHotbarOverlay,
  renderMoneyOverlay,
  triggerHotbarSlot,
  triggerHotbarConsumable,
  setHotbar,
  autoHotbarNewItems,
  openShop,
  openPhoneMenu,
  openAtmMenu,
  applyDadReport,
} from './MenuManager';
import { renderXpBar, XP_BAR_BOTTOM } from './XpBar';
import { preloadSwirl, swirlReady, drawSwirl } from './SwirlTransition';
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
  spawnOwnDamageNumber,
  spawnHealNumber,
  spawnXpNumber,
  spawnLevelUp,
  spawnCritText,
  spawnMissText,
  spawnLootText,
  spawnNoticeText,
  spawnMortalText,
} from './Emitter';
import {
  noteHealthDamage,
  startMortalRoll,
  tickMortalRoll,
  clearMortalRoll,
  HpHolder,
} from './HealthRoll';
import { triggerHitstop, tickHitstop, addShake, tickShake, FLASH_MS } from './Juice';
import { initPsiFx, updatePsiFx, renderPsiFx, spawnPsiFx } from './PsiFx';
import { spawnProjectile, endProjectile, updateProjectiles } from './Projectiles';
import { updateDeathFx } from './DeathFx';
import { spawnKoThrow, advanceKoThrow, clearKoThrow } from './KoThrow';
import { updateItemFx, renderItemFx, spawnItemFx } from './ItemFx';
import { setDrops, addDrop, removeDrop } from './DropManager';
import { playEventSfx, loadSfxEvents } from './SfxEvents';
import { loadCombatJuice } from './CombatJuice';
import { setGoods } from './Inventory';
import { setMoney, setBank, formatMoney } from './Wallet';
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

// Status ids that lock the player out of acting (mirror of the blocksAction
// statuses in server/status.js). Their presence in our status set freezes input.
const BLOCKING_STATUSES = new Set(['paralysis', 'diamond', 'sleep']);

type GamePhase = 'loading' | 'charselect' | 'playing';

/** Options for starting the game: anonymous (char-select) or a signed-in save. */
interface StartOpts {
  spriteGroupId?: number;
  appearance?: CharacterAppearance | null;
  name?: string;
  spawn?: { x: number; y: number; dir: number };
  auth?: JoinAuth | null;
}

/** Human-friendly countdown, e.g. 90000 → "1m 30s", 45000 → "45s". */
function fmtDuration(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
  // AOI crowd overflow (§4.6): nearby players beyond the per-client visible cap,
  // shown as a "+N nearby" aggregate. 0 unless the server has AOI on and a crowd
  // exceeds the cap. Fed by the 'crowd' message (onCrowd).
  private crowdOverflow = 0;
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
  // Transition visual: 'fade' = plain black (doors), 'swirl' = EB battle-swirl
  // mask (event warps, when its frames are loaded — else falls back to fade).
  private transitionStyle: 'fade' | 'swirl' = 'fade';
  // Event runtime (EVENT_MANAGER.md): latest broadcast event UI state + the id of
  // the event the LOCAL player is currently inside (null when not in one).
  private eventStates: EventStateWire[] = [];
  private myEventId: string | null = null;
  // Door prefetch: the destination's visible sectors, loaded at fade START so the
  // fade hides the load instead of stalling on a black screen after it.
  private destLoad: Promise<void> | null = null;
  // Image-load counter snapshot taken at the start of a wait (boot / transition);
  // the loading bar shows progress since this baseline. See loadRatio.
  private loadBaseline = { started: 0, finished: 0 };
  // Active escalator/stairway ride: the player glides `dx,dy` straight to the
  // paired landing at `destX,destY` (precomputed at load — see DoorManager). The
  // ride never warps; on arrival we re-crop to the destination floor in place.
  private riding: {
    dx: number;
    dy: number;
    destX: number; // paired ROM trigger = the exact, known stop
    destY: number;
    dist: number; // pixels glided (runaway safety only)
    sameFloor: boolean; // start & landing share one room — never touch the crop
  } | null = null;
  private stairSuppressed = false;
  private talkingNpc: NPC | null = null;
  // Status input-lock deadline (ms epoch) for the LOCAL player — set when an
  // action-blocking status (paralysis/sleep/diamond) lands, cleared on its
  // server-side wear-off/cure. While active, field actions are suppressed.
  private statusLockUntil = 0;
  // Epoch-ms the current give-up hold began (0 = not holding). The downed player
  // must hold for GIVE_UP_HOLD_MS to die; releasing early resets it.
  private giveUpHoldStart = 0;
  // Active PSI target-selection (party-target PSI: Lifeup/Healing/revive). While
  // set, the world is in "pick a target" mode (self/ally, or a downed ally for
  // revive) instead of normal play. Null = not targeting.
  private psiTargeting: { abilityId: string; kind: 'ally' | 'downed' } | null = null;

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
      loadRegionRooms(), // region rooms (DB 'rooms' doc) — THE runtime bgm source now
      // music.json is no longer loaded at boot: its areas were seeded into the
      // 'rooms' doc and a room's `bgm` drives playback (with hysteresis). The Sound
      // Manager still loads music.json itself for live authoring/preview.
      loadSfxEvents(), // authored event→sfx assignments (overrides/sfx_events.json)
      loadCombatJuice(), // authored combat-number feel (overrides/combat_juice.json)
      loadFont(0), // regular EB dialogue font (chat input, command menu)
      loadFont(1), // Mr. Saturn font (backlogged chat option)
      loadFont(4), // small 8px battle font (speech bubbles)
      loadFont('credits', 6), // EB credits font (16x6 grid, 8x16 cells) — KO prompt + downed timer
      loadWindowStyle(0),
    ]);

    // Standalone custom entity sprites minted from ROM source art (Source Assets
    // tool). After name overrides so each group's authored name is in place;
    // registers the art so these entities draw like any other sprite group.
    await loadCustomSprites();

    // Set up character select input. initInput here (idempotent) attaches the
    // pointer listeners NOW so clicks work on the character-select screen, not
    // just after the game starts.
    initInput(this.canvasEl);
    // On phones/tablets, mount the on-screen joystick + buttons (no-op on
    // desktop). They synthesize the same key codes the keyboard uses.
    mountTouchControls();
    // Opt-in live gamepad readout (?gpdebug) for diagnosing handhelds.
    mountGamepadDebug();
    // Opt-in live network readout (?netdebug) — RTT/jitter for diagnosing lag.
    mountNetDebug();
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
    // Unlock audio + naming music on the FIRST interaction anywhere on the
    // char-select / start screen — incl. the DOM account overlay, whose button
    // clicks never reach the canvas input path. Disarmed when the game starts.
    armCharSelectAudioUnlock();
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
    disarmCharSelectAudioUnlock(); // leaving char-select — stop the naming-music gesture hook
    this.loadBaseline = imageLoadProgress(); // boot loading-bar baseline
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
      loadNPCs(), // also loads the shops catalog (clerk→store + item equip data)
      loadItemSprites(),
      loadCustomItems(), // admin-minted items — needed before the folder layout
      loadCustomTiles(), // author-drawn custom room tiles (overrides/custom_tiles.json)
    ]);
    // Item category folders (food/weapons/…). The game reads them at runtime —
    // e.g. only FOOD plays the eat SFX. After shops + custom items are loaded so
    // a first-run seed (absent override file) can categorize the full catalog.
    await loadItemFolders();

    // Flag/quest system: load the catalog (seeds new-player defaults) and the
    // trigger table (subscribes to the EventBus). After loadNPCs so dialogue
    // branches resolve against a populated PlayerFlags store.
    await Promise.all([loadFlagRegistry(), initFlagTriggers(), initPsiFx()]);

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

    // Get into the world ASAP: block on ONLY the player sprite + the sectors
    // VISIBLE at the spawn point (camera centered on the player) — not the 9x13
    // neighborhood, most of which the room crop hides anyway. The rest streams
    // in afterward via the per-frame loader (update → loadNearbySectors). Both
    // loads run in parallel.
    console.log('Loading player sprite + spawn view...');
    this.camera.follow(this.player.x, this.player.y); // so "visible" is accurate
    await Promise.all([
      appearance ? Promise.resolve() : loadSpriteGroup(spriteGroupId),
      this.loadVisibleSectors(this.player.x, this.player.y),
    ]);

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
    initSettings(); // apply saved BGM/SFX volumes to the audio engine
    initMenu(getKeySet(), {
      getEquipped: (slot) => getEquipped(slot),
      equip: (slot, id) => {
        setEquipped(slot, id);
        // Equipping a weapon is self-contained: it sets the held sprite and the
        // server applies its offense. The quick-select hotbar is OPTIONAL and
        // separate — it's only for switching between weapons you've parked there,
        // so equipping never forces the weapon onto a slot.
        if (slot === 'weapon') this.player.heldItemId = id;
        sendEquip(slot, id);
        if (id) playEventSfx('equip'); // only on equip, not take-off
      },
      // PK toggle (server-authoritative): the menu reads our flag + lock expiry
      // and asks the server to flip it; the result returns via onPlayerPk.
      getPk: () => ({ on: this.player.pk, lockedUntil: this.player.pkUntil }),
      setPk: (on) => sendSetPk(on),
      // Float a short notice over the player (e.g. a blocked "Not enough PP" cast).
      notify: (text) => spawnNoticeText(this.player.x, this.player.y, text),
      psiBlocked: () => this.player.statuses.includes('noPsi'),
      // Play a used item's animation on the local player (server networks it to others).
      itemUseFx: (id) => spawnItemFx(id, this.player.x, this.player.y),
      // Party-target PSI: enter target mode (pick self or an ally), then cast.
      beginPsiTarget: (abilityId) => this._beginPsiTarget(abilityId),
    });
    initChat(getKeySet());
    initDialogue(getKeySet());

    // Route player-flag writes to the server (it owns the persisted copy in the
    // character save). Set before connect so optimistic writes always have a sink.
    setFlagSink((action, id) => sendFlag(action, id));

    // Connect to multiplayer server (anonymous, or signed-in via opts.auth).
    connect(
      spriteGroupId,
      // Broadcast the SAME name shown locally (line ~422): fall back to the
      // sprite's name so others don't just see a generic 'Player'.
      opts.name ?? getSpriteName(spriteGroupId) ?? 'Player',
      appearance,
      {
        onWelcome: (playerId, players) => {
          this.localPlayerId = playerId;
          // A reconnect re-welcomes us under a fresh id. Drop any remotes carried
          // over from the previous session so stale copies don't linger as ghosts;
          // the fresh AOI spawns (player_join) repopulate the current neighbours.
          this.remotePlayers.clear();
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
          // Gifts were tagged at boot, before these flags existed — re-apply so
          // presents opened in a prior session load showing the OPEN frame.
          applyGiftFlagStates();
        },
        onPlayerPk: (id, pk, lockMs) => {
          // Server-authoritative PK state → red nameplate + PvP eligibility. The
          // lock is sent as REMAINING in-game ms; convert to a local deadline for
          // the menu's countdown (only matters for the local player). While the
          // client stays connected, wall-clock ≈ in-game time, so this is accurate.
          if (id === this.localPlayerId) {
            this.player.pk = pk;
            this.player.pkUntil = lockMs > 0 ? Date.now() + lockMs : 0;
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) rp.pk = pk;
          }
        },
        // Server-authoritative position for OUR player: reconcile prediction.
        onPos: (x, y, _direction, _frame, seq) => {
          this.player.reconcile(x, y, seq);
        },
        // Server-authoritative door warp landed: jump our prediction to the dest.
        onWarp: (x, y) => {
          this.player.warpTo(x, y);
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
        onCrowd: (players) => {
          this.crowdOverflow = players;
        },
        onEquip: (id, itemId) => {
          const rp = this.remotePlayers.get(id);
          if (rp) rp.itemId = itemId;
        },
        onPlayerAttack: (id, attackSpeed) => {
          // Stamp the swing start; applyRemoteSwing animates the attack pose each
          // frame and reverts to walk on its own (the position stream only ever
          // carries 'walk' under server-authoritative movement).
          const rp = this.remotePlayers.get(id);
          if (rp) {
            rp.attackStart = performance.now();
            rp.attackSpeed = attackSpeed;
          }
        },
        onEquipped: (slots, attackSpeed) => {
          // Authoritative equipped set for the local player — re-sync the mirror
          // and the held-weapon sprite.
          setEquippedFromServer(slots);
          this.player.heldItemId = slots.weapon ?? null;
          // Weapon swing-rate multiplier (server-authoritative) scales the local
          // swing-pose duration so a fast weapon animates as fast as it resolves.
          this.player.attackSpeed = attackSpeed && attackSpeed > 0 ? attackSpeed : 1;
        },
        onHotbar: (slots) => {
          // Restore the saved quick-select layout exactly as the player left it
          // (incl. an assigned PSI). The hotbar is independent of what's equipped —
          // the equipped weapon shows its own green ring on the Equip screen / on
          // a slot only if the player parked it there.
          setHotbar(slots);
        },
        onNpcUpdate: (rows) => {
          applyNpcUpdates(rows);
        },
        onNpcHp: (rows) => {
          applyNpcHp(rows);
        },
        onNpcStatus: (rows) => {
          applyNpcStatus(rows);
        },
        onNpcEquip: (rows) => {
          applyNpcEquip(rows);
        },
        onNpcDeath: (id, dx, dy, force) => {
          applyNpcDeath(id, dx, dy, force);
        },
        onPlayerHp: (id, hp, maxHp, dmg, heal) => {
          if (id === this.localPlayerId) {
            // Any authoritative HP settles a mortal roll (survived a heal, or a
            // plain hit/refill) — stop the death slide and snap to the real value.
            clearMortalRoll(this.player);
            this.player.hp = hp;
            this.player.maxHp = maxHp;
            if (dmg > 0) {
              // Roll the bar: hold the pre-hit fill, flash the lost chunk, drain it.
              noteHealthDamage(this.player, hp + dmg, performance.now());
              spawnOwnDamageNumber(this.player.x, this.player.y, dmg); // red — only we see our own
              this.player.hurt(); // flinch pose; broadcast to others via sendPosition
              // Impact juice: YOU got hit — flash, freeze, and a heavier shake
              // (taking a hit should feel weightier than landing one).
              this.player.flashUntil = Date.now() + FLASH_MS;
              triggerHitstop(3);
              addShake(Math.min(0.65, 0.3 + dmg * 0.02));
              // Lethal blow gets the death sting instead of the hurt grunt.
              playEventSfx(hp <= 0 ? 'player-die' : 'player-hurt');
            }
            if (heal > 0) spawnHealNumber(this.player.x, this.player.y, heal);
            setStatus({ hp, hpMax: maxHp }); // reflect in the Status screen
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              clearMortalRoll(rp as HpHolder); // settled — stop any death slide
              rp.hp = hp;
              rp.maxHp = maxHp;
              if (dmg > 0) {
                noteHealthDamage(rp as HpHolder, hp + dmg, performance.now());
                spawnDamageNumber(rp.x, rp.y, dmg);
                rp.flashUntil = Date.now() + FLASH_MS; // blink, but no shake/freeze — not our hit
                rp.hurtStart = performance.now(); // play the flinch (server-auth move drops the pose)
                rp.attackStart = undefined; // a hit interrupts any swing in progress
              }
              if (heal > 0) spawnHealNumber(rp.x, rp.y, heal);
            }
          }
        },
        onPlayerMortal: (id, fromHp, maxHp, ms, banner, dmg) => {
          // EB rolling-HP death: the bar slides fromHp→0 over `ms` while the player
          // stays up and can heal to survive. We drive the slide client-side; the
          // server holds the real death deadline. MORTAL DAMAGE! shows only when the
          // window is long enough to actually react (server-decided `banner`).
          const tnow = performance.now();
          if (id === this.localPlayerId) {
            this.player.maxHp = maxHp;
            startMortalRoll(this.player, fromHp, ms, tnow);
            if (dmg > 0) {
              spawnOwnDamageNumber(this.player.x, this.player.y, dmg);
              this.player.hurt();
              this.player.flashUntil = Date.now() + FLASH_MS;
              triggerHitstop(3);
              addShake(Math.min(0.7, 0.35 + dmg * 0.02));
              playEventSfx('player-hurt'); // still alive (rolling) — not the death sting yet
            }
            if (banner) spawnMortalText(this.player.x, this.player.y);
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              rp.maxHp = maxHp;
              startMortalRoll(rp as HpHolder, fromHp, ms, tnow);
              if (dmg > 0) {
                spawnDamageNumber(rp.x, rp.y, dmg);
                rp.flashUntil = Date.now() + FLASH_MS;
              }
              if (banner) spawnMortalText(rp.x, rp.y);
            }
          }
        },
        onInventory: (items) => {
          setGoods(items); // mirror the server's Goods list for the menu (hotbar
          // count badges read this live; a depleted slot greys out, see renderHotbar)
          autoHotbarNewItems(); // a newly-picked-up weapon/consumable fills an open hot slot
        },
        onMoney: (amount) => {
          setMoney(amount); // mirror the server's on-hand cash for the menu
        },
        onBank: (amount) => {
          setBank(amount); // mirror the server's bank/ATM balance
        },
        onDadReport: (earned, spent, bank) => {
          applyDadReport(earned, spent, bank); // fill in Dad's save-prompt summary
        },
        // --- Ground loot drops (server-authoritative; pickup is first-touch) ---
        onDrops: (list) => {
          setDrops(list); // full set on join / re-join
        },
        onDropSpawn: (drop) => {
          addDrop(drop);
        },
        onDropRemove: (id) => {
          removeDrop(id);
        },
        onLoot: (loot) => {
          // We picked something up — float a gold toast off the player.
          const label =
            typeof loot.money === 'number'
              ? `Got $${formatMoney(loot.money)}`
              : `Found ${loot.name || 'item'}!`;
          spawnLootText(this.player.x, this.player.y, label);
          if (typeof loot.money !== 'number') playEventSfx('get-item'); // grabbed an item off the ground
        },
        onNotice: (text) => {
          if (text) spawnNoticeText(this.player.x, this.player.y, text);
        },
        onGiftOpened: (k) => {
          // Server granted the present — play the open→fade on the live box.
          const npc = liveNpcForKey(k);
          if (npc) beginGiftOpen(npc);
          playEventSfx('get-item'); // present opened → "got item from present" jingle
        },
        onMomFood: (healed, readyInMs, food) => {
          // Ness's mom's response — render her line from the server's facts. The
          // heal itself already arrived via player_hp (green number on the bar).
          const dish = food || 'a home-cooked meal';
          let pages: string[];
          if (healed > 0) {
            pages = [
              `Oh, you must be starving! Here, I made your favorite — ${dish}.`,
              `You recovered ${healed} HP!`,
              `Now don't push yourself too hard out there, dear.`,
            ];
          } else if (readyInMs > 0) {
            pages = [
              `You just ate, dear! Let me cook more ${dish} — it'll be ready in ${fmtDuration(readyInMs)}.`,
            ];
          } else {
            pages = [`You look full of energy! Come back when you're hungry, dear.`];
          }
          openDialogue(pages);
        },
        onPlayerPush: (id, x, y) => {
          // Knockback: slide to the server's collision-clamped spot over a few
          // frames (Player.knockTo) instead of teleporting — the per-frame
          // camera.follow then glides instead of jolting. Keep facing and pose
          // (it's a shove, not a respawn). Don't snap the camera to the final
          // spot here; the main loop follows the gliding position each frame.
          if (id === this.localPlayerId) {
            this.player.knockTo(x, y);
            if (!this.editor?.isActive()) {
              this.updateRoomBounds(x, y);
            }
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              rp.x = x;
              rp.y = y;
            }
            dropRemoteBuffer(id); // snap the shove, don't glide to it
          }
        },
        onStatusApplied: (id, x, y, _statusType, text, ms, blocks) => {
          // Floating EB battle-text over whoever caught it ("became numb!").
          if (text) spawnNoticeText(x, y, text);
          // If WE were action-locked (paralysis/sleep/diamond), freeze our input
          // until the status' deadline. The server's player_status clear (cure /
          // wear-off) lifts it early; this deadline is the backstop.
          if (id === this.localPlayerId && blocks && ms > 0) {
            this.statusLockUntil = Math.max(this.statusLockUntil, Date.now() + ms);
            this.player.freezeUntil(this.statusLockUntil);
          }
        },
        onPlayerStatus: (id, statuses) => {
          if (id === this.localPlayerId) {
            this.player.statuses = statuses; // drives our HP-bar pips
            // No blocking status left → release the input lock immediately.
            if (!statuses.some((s) => BLOCKING_STATUSES.has(s))) {
              this.statusLockUntil = 0;
              this.player.freezeUntil(0);
            }
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) rp.statuses = statuses;
          }
        },
        onPlayerBuffs: (list) => {
          // Owner-only: turn each remaining-ms into a local deadline for the HUD.
          const now = Date.now();
          this.player.buffs = list.map((b) => ({
            stat: b.stat,
            amount: b.amount,
            expiresAt: now + b.ms,
          }));
        },
        onPlayerDowned: (id, ms, dx, dy, force) => {
          const until = Date.now() + ms;
          // The mortal roll ran out (or a path that downs directly) — stop the
          // slide and lay them out. The MORTAL DAMAGE! banner already fired at the
          // start of the roll (onPlayerMortal), not here. Seed the rotate-and-fling
          // KO throw so the body tumbles into the laying pose (KoThrow).
          if (id === this.localPlayerId) {
            clearMortalRoll(this.player);
            this.player.hp = 0;
            this.player.downed = true;
            this.player.downedUntil = until;
            this.player.downedTotalMs = ms;
            this.player.giveUpProgress = 0;
            this.player.moving = false;
            spawnKoThrow(this.player, dx, dy, force);
            playEventSfx('player-die'); // the meter hit 0 — you fell
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              clearMortalRoll(rp as HpHolder);
              rp.hp = 0;
              rp.downed = true;
              rp.downedUntil = until;
              spawnKoThrow(rp, dx, dy, force);
            }
          }
        },
        onPlayerRevived: (id) => {
          if (id === this.localPlayerId) {
            clearMortalRoll(this.player);
            this.player.downed = false;
            this.player.giveUpProgress = 0;
            clearKoThrow(this.player);
          } else {
            const rp = this.remotePlayers.get(id);
            if (rp) {
              clearMortalRoll(rp as HpHolder);
              rp.downed = false;
              clearKoThrow(rp);
            }
          }
        },
        onPsiCast: (id, _casterId, x, y, tx, ty, hits, beams) => {
          // Server-driven (everyone incl. the caster): play the effect, flying
          // caster (x,y) → target (tx,ty) for projectile-delivery PSI.
          if (beams && beams.length) {
            // `beams` (Fire cone) — spray a fan of projectiles from the caster,
            // one per pellet, so the cast reads as a shotgun blast.
            for (const b of beams) spawnPsiFx(id, x, y, b.tx, b.ty);
          } else if (hits && hits.length) {
            // `hits` (Thunder bolts) — strike EACH enemy with its own bolt that
            // falls from above onto it (projectile-delivery anims need travel to
            // read; a zero-length cast would flash and vanish).
            const DROP = 140; // px above the enemy each bolt starts
            for (const h of hits) spawnPsiFx(id, h.x, h.y - DROP, h.x, h.y);
          } else {
            spawnPsiFx(id, x, y, tx, ty);
          }
        },
        onItemUse: (_id, item, x, y) => {
          // Another player used a consumable — play its "use" animation on them
          // (the local user already spawned their own via the itemUseFx hook).
          spawnItemFx(item, x, y);
        },
        onProjectile: (id, x, y, vx, vy, speed, dist, sprite) => {
          // A ranged weapon fired (anyone's, incl. ours) — render the flying shot.
          // Server owns travel/damage; this is the visual only.
          spawnProjectile({ id, x, y, vx, vy, speed, dist, sprite });
        },
        onProjEnd: (id, x, y, hit) => {
          // The shot landed — snap to the impact point + pop a spark.
          endProjectile(id, x, y, hit);
        },
        onPlayerRespawn: (id, x, y, dir) => {
          if (id === this.localPlayerId) {
            this.player.x = x;
            this.player.y = y;
            this.player.direction = dir;
            this.player.moving = false;
            this.player.frame = 0;
            // True death resolved the KO — clear the downed/vignette/throw state.
            this.player.downed = false;
            this.player.giveUpProgress = 0;
            clearKoThrow(this.player);
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
              rp.downed = false; // true death respawn clears the laying pose
              clearKoThrow(rp);
            }
            dropRemoteBuffer(id); // snap across the map, don't glide
          }
        },
        onEventState: (events) => {
          this.eventStates = events;
          // Preload the battle-swirl as soon as a countdown is visible, so its
          // frames are cached by the time the warp fires (~5s lead).
          if (events.some((e) => e.phase === 'arming')) preloadSwirl();
        },
        onEventWarp: (x, y, dir, eventId) => {
          // Server-driven warp into/out of an event room — EarthBound battle-swirl
          // wipe to black, teleport at full black, swirl back to reveal. Falls back
          // to the plain door fade if the swirl frames aren't loaded yet.
          this.myEventId = eventId;
          this.startTransition(
            {
              destX: x,
              destY: y,
              destDir: this._dirToDoorIdx(dir),
              sfx: 'door-open',
              worldX: 0,
              worldY: 0,
              type: 'door',
              style: 0,
              key: '',
            } as DoorData,
            swirlReady() ? 'swirl' : 'fade'
          );
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
          this.player.speed = stats.speed; // drives walk speed — faster as Speed grows
          this.player.level = stats.level; // weight-class walk-push (blockedByNPC)
          if (gained > 0) spawnXpNumber(this.player.x, this.player.y, gained);
          if (leveled) {
            spawnLevelUp(this.player.x, this.player.y);
            playEventSfx('level-up');
          }
        },
        onPoints: (points, alloc) => {
          // Authoritative banked points + alloc (server pushes on level-up / spend /
          // join). Mirror for the icon + spend pentagon.
          this.unspentPoints = points;
          this.pointsAlloc = alloc;
          setLevelUpPoints(points);
        },
        onCombat: (evt, x, y, byPlayer, targetPlayer, dmg) => {
          // Crit/miss events: floating SMAAAASH!/MISS text for everyone, plus the
          // right SFX for the LOCAL player (see SfxEvents / ARCHITECTURE combat).
          if (evt === 'hit') {
            // Server-confirmed: a swing of YOURS connected with an enemy. Hit juice
            // (freeze + shake, scaled by damage) fires only here — never off a raw
            // enemy-HP drop — so swinging at air can't be rattled by some off-screen
            // brawl, and only the attacker feels their own landed blow.
            if (byPlayer === this.localPlayerId) {
              triggerHitstop(2);
              addShake(Math.min(0.5, 0.18 + dmg * 0.02));
            }
            return;
          }
          if (evt === 'crit') {
            spawnCritText(x, y);
            // SMAAAASH! — a crit you dealt or took gets an extra-heavy punch on top
            // of the normal hit juice (the enemy-HP / player-HP handlers already
            // fired theirs). Distant players' crits don't rattle your screen.
            if (byPlayer === this.localPlayerId || targetPlayer === this.localPlayerId) {
              triggerHitstop(6);
              addShake(0.7);
            }
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

  // Player foot box (mirrors Player.ts COL_* and the server COL_*). Used by the
  // remote-player prediction below.
  private static readonly COL_W = 14;
  private static readonly COL_H = 8;
  private static readonly COL_OY = -8;
  private static readonly PRED_PUSH_STEP = 1.4;
  private static readonly PRED_PUSH_MAX_LEAD = 12;
  private static readonly PRED_HIT_KB = 10;
  private static readonly PRED_HIT_MAX_LEAD = 26;
  private static readonly ATTACK_REACH = 14;
  private static readonly ATTACK_HALF = 8;
  // Unit dir per Direction enum — MIRROR of server/npcSim.js DIR_VEC.
  private static readonly DIR_VEC: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [0, -1],
    [-1, 0],
    [1, 0],
    [-Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
  ];

  // Weight-class recoil scale (mirrors server massKnockScale).
  private massScale(attLevel: number, vicLevel: number): number {
    const a = 1 + Math.max(0, attLevel);
    const v = 1 + Math.max(0, vicLevel);
    return Math.max(0.15, Math.min(2, (2 * a) / (a + v)));
  }

  /** Predict the local player plowing LIGHTER remote players aside (mirrors the
   *  server's pushPlayers). Instant, then the player_push stream reconciles. */
  private predictPushRemotePlayers(moving: boolean): void {
    if (!moving) return;
    const W = Game.COL_W;
    const H = Game.COL_H;
    const fx = this.player.x - W / 2;
    const fy = this.player.y + Game.COL_OY;
    const mine = this.player.level;
    for (const [, rp] of this.remotePlayers) {
      if (rp.downed || (rp.hp !== undefined && rp.hp <= 0)) continue;
      if (mine <= (rp.level ?? 1)) continue; // only plow strictly-lighter players
      const rx = rp.x - W / 2;
      const ry = rp.y + Game.COL_OY;
      if (!(fx < rx + W && fx + W > rx && fy < ry + H && fy + H > ry)) continue;
      let dx = rp.x - this.player.x;
      let dy = rp.y - this.player.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.001) {
        const v = Game.DIR_VEC[this.player.direction] ?? Game.DIR_VEC[0];
        dx = v[0];
        dy = v[1];
      } else {
        dx /= d;
        dy /= d;
      }
      const tx = rx + (rp.predOffX ?? 0) + dx * Game.PRED_PUSH_STEP;
      const ty = ry + (rp.predOffY ?? 0) + dy * Game.PRED_PUSH_STEP;
      if (!checkPlayerCollision(tx, ty, W, H)) {
        injectPredOffset(rp, dx, dy, Game.PRED_PUSH_STEP, Game.PRED_PUSH_MAX_LEAD);
      }
    }
  }

  /** Predict the local player's swing knocking back remote players (PvP). Mirrors
   *  the server hitbox + canHurt gate (you may hit a player if you OR they are PK). */
  private predictPvpKnockback(px: number, py: number, dir: number): void {
    const v = Game.DIR_VEC[dir] ?? Game.DIR_VEC[0];
    const half = Game.ATTACK_HALF;
    const hx = px + v[0] * Game.ATTACK_REACH - half;
    const hy = py - 10 + v[1] * Game.ATTACK_REACH - half;
    const hw = half * 2;
    const W = Game.COL_W;
    const H = Game.COL_H;
    for (const [, rp] of this.remotePlayers) {
      if (rp.downed || (rp.hp !== undefined && rp.hp <= 0)) continue;
      if (!this.player.pk && !rp.pk) continue; // canHurt: PvP needs an aggressor
      const rx = rp.x - W / 2;
      const ry = rp.y + Game.COL_OY;
      if (!(hx < rx + W && hx + hw > rx && hy < ry + H && hy + hw > ry)) continue;
      let dx = rp.x - px;
      let dy = rp.y - py;
      const d = Math.hypot(dx, dy);
      if (d < 0.001) {
        dx = v[0];
        dy = v[1];
      } else {
        dx /= d;
        dy /= d;
      }
      const dist = Game.PRED_HIT_KB * this.massScale(this.player.level, rp.level ?? 1);
      const tx = rx + (rp.predOffX ?? 0) + dx * dist;
      const ty = ry + (rp.predOffY ?? 0) + dy * dist;
      if (!checkPlayerCollision(tx, ty, W, H)) {
        injectPredOffset(rp, dx, dy, dist, Game.PRED_HIT_MAX_LEAD);
      }
    }
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

  /** Sector range that covers the screen if the camera were centered on (x,y),
   *  plus a 1-sector ring. This is the MINIMUM needed to render that spot — far
   *  smaller than loadNearbySectors' 9x13 neighborhood. Used to get into the
   *  world (and through a door) fast: block on just this, stream the rest. */
  private visibleSectorRange(x: number, y: number) {
    const left = x - this.camera.viewW / 2;
    const top = y - this.camera.viewH / 2;
    const startCol = Math.floor(left / TILE_SIZE);
    const startRow = Math.floor(top / TILE_SIZE);
    const endCol = Math.ceil((left + this.camera.viewW) / TILE_SIZE);
    const endRow = Math.ceil((top + this.camera.viewH) / TILE_SIZE);
    return {
      sx0: Math.floor(startCol / SECTOR_TILES_X) - 1,
      sy0: Math.floor(startRow / SECTOR_TILES_Y) - 1,
      sx1: Math.floor(endCol / SECTOR_TILES_X) + 1,
      sy1: Math.floor(endRow / SECTOR_TILES_Y) + 1,
    };
  }

  /** Block-load ONLY the sectors visible around a world point (atlas+collision).
   *  The wider neighborhood streams in afterward via the per-frame loader. */
  private async loadVisibleSectors(x: number, y: number) {
    const r = this.visibleSectorRange(x, y);
    await this.loadSectorRange(r.sx0, r.sy0, r.sx1, r.sy1);
  }

  /** Fraction [0..1] of the current load done, since loadBaseline. Images (the
   *  heavy atlases/sprites) drive it; 0 until the first one starts. */
  private loadRatio(): number {
    const p = imageLoadProgress();
    const total = p.started - this.loadBaseline.started;
    if (total <= 0) return 0;
    return Math.min(1, (p.finished - this.loadBaseline.finished) / total);
  }

  /** Draw the EB-style "Loading…" + a centered progress bar at `ratio` fill. */
  private drawLoadingBar(ratio: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Loading...', SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - 4);
    ctx.textAlign = 'left';
    const w = 120;
    const h = 6;
    const x = Math.floor((SCREEN_WIDTH - w) / 2);
    const y = Math.floor(SCREEN_HEIGHT / 2 + 4);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#7ec8ff';
    ctx.fillRect(x + 1, y + 1, Math.max(0, Math.min(1, ratio)) * (w - 2), h - 2);
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
  private computeRideBounds(destX: number, destY: number): RoomBounds | null {
    const src = computeRoomBounds(this.player.x, this.player.y);
    // March straight to the known landing, collecting the tiles glided across.
    const pathTiles = new Set<number>();
    let x = this.player.x;
    let y = this.player.y;
    const dx = Math.sign(destX - x);
    const dy = Math.sign(destY - y);
    for (let i = 0; i < 64; i++) {
      pathTiles.add(Math.floor(y / TILE_SIZE) * MAP_WIDTH_TILES + Math.floor(x / TILE_SIZE));
      if (Math.abs(x - destX) <= MINITILE_SIZE && Math.abs(y - destY) <= MINITILE_SIZE) break;
      x += dx * MINITILE_SIZE;
      y += dy * MINITILE_SIZE;
    }
    const dst = computeRoomBounds(destX, destY);
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
   * walkable diagonal ramp bounded by SOLID at each landing; the ramp is too
   * narrow (and corner-connected) for normal foot-box movement, so we glide the
   * player along it ignoring collision. The destination is the PAIRED trigger,
   * known before the ride starts (DoorManager), so there is exactly ONE stop
   * condition: we've reached it. No warp — the floors are contiguous map coords.
   */
  private updateRide() {
    const r = this.riding!;
    const RIDE_MAX = 512; // pixels; longest ROM ramp is ~31 tiles — runaway safety

    r.dist += this.player.rideStep(r.dx, r.dy);
    this.camera.follow(this.player.x, this.player.y);

    // Stop the moment we've reached/passed the known landing on BOTH axes (the
    // remaining vector to dest no longer points the way we're riding). The
    // runaway cap is a pure safety net that should never fire on real data.
    const reached = (r.destX - this.player.x) * r.dx <= 0 && (r.destY - this.player.y) * r.dy <= 0;
    if (reached || r.dist >= RIDE_MAX) {
      // Settle exactly on the landing trigger's tile.
      this.player.x = r.destX;
      this.player.y = r.destY;
      const sameFloor = r.sameFloor;
      this.riding = null;
      this.stairSuppressed = true;
      this.player.moving = false;
      this.player.endRide(); // re-enable reconciliation, drop glide-queued inputs
      // Re-crop ONLY for a true floor change — a same-floor dept-store hop never
      // left its room, so re-cropping it is what blacked the player out / sealed
      // them at the top (bugs.md). A cross-floor ride re-crops to the new floor.
      if (!sameFloor) this.updateRoomBounds(this.player.x, this.player.y);
      // The landing sits at the ramp/floor boundary, so the foot box can straddle
      // OUTSIDE the (re-sealed) room and read every move as a wall. Nudge off the
      // seam onto the floor (ride direction first), like a door warp's nudge-out.
      this.nudgeIntoRoom(r.dx, r.dy);
      // Resync the server to where the glide left us (it held us at the foot).
      sendRideWarp(this.player.x, this.player.y);
    }
  }

  /**
   * After an escalator ride, the player can land on the ramp/room seam where the
   * foot box overlaps a wall or the sealed-room edge — leaving them unable to move
   * (stuck at the top). If so, nudge them to the nearest free spot, preferring the
   * ride direction (= deeper onto the destination floor). Mirrors the door-warp
   * nudge; uses checkPlayerCollision so it respects walls AND the active-room seal.
   */
  private nudgeIntoRoom(rideDx: number, rideDy: number) {
    const COL_W = 14,
      COL_H = 8,
      COL_OY = -8;
    const free = (x: number, y: number) =>
      !checkPlayerCollision(x - COL_W / 2, y + COL_OY, COL_W, COL_H);
    if (free(this.player.x, this.player.y)) return;
    const nudges: [number, number][] = [];
    for (let d = 8; d <= 48; d += 8) nudges.push([rideDx * d, rideDy * d]); // forward off the ramp
    for (let d = 8; d <= 48; d += 8) nudges.push([0, d], [0, -d], [d, 0], [-d, 0]);
    for (const [nx, ny] of nudges) {
      if (free(this.player.x + nx, this.player.y + ny)) {
        this.player.x += nx;
        this.player.y += ny;
        return;
      }
    }
  }

  private startTransition(door: DoorData, style: 'fade' | 'swirl' = 'fade', serverDoor = false) {
    this.transitioning = true;
    this.transitionAlpha = 0;
    this.transitionStyle = style;
    this.pendingDoor = door;
    // A real walk-through door: ask the server to warp us authoritatively (it
    // validates we're on the door + uses the door's OWN dest). We're still on the
    // trigger right now, so the server confirms. Escalator floor-exits and
    // server-initiated event warps don't go through this (serverDoor=false).
    if (serverDoor) sendUseDoor();
    // Prefetch the destination's visible sectors NOW, during the fade-out — so by
    // the time the screen is black the tiles are usually already in, and we fade
    // straight back in instead of stalling on black. The loading bar (if the load
    // outruns the fade) tracks progress from this baseline.
    this.loadBaseline = imageLoadProgress();
    this.destLoad = this.loadVisibleSectors(door.destX, door.destY);
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

        // Move player to destination area so the right tiles are in view. warpTo
        // also drops stale pre-warp predicted inputs so they don't replay here.
        this.player.warpTo(door.destX, door.destY);

        // Wait on the prefetch started at fade-out — usually already resolved, so
        // this continues immediately (no black stall). The wider neighborhood
        // streams in after arrival via the per-frame loader.
        const load = this.destLoad ?? this.loadVisibleSectors(door.destX, door.destY);
        load.then(() => {
          this.destLoad = null;
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
        // Just lift the warp shield — DON'T volunteer a position. The door warp is
        // fully server-authoritative now: the server validated the door, resolved a
        // clear landing (findPlayerLanding) and sent it back via `warp` (adopted in
        // onWarp). That server-side jump is also what npcSim reads to let chasing
        // enemies follow through — so the old client `move` report (a trusted
        // client position) is gone, closing the last movement cheat vector.
        sendWarpState(false);
      }
    }
  }

  start() {
    // Fixed-timestep simulation. update() runs at a constant 60Hz regardless of
    // the display's refresh rate, so movement and animation cover the same ground
    // PER SECOND on a 60/90/120/144Hz screen. They're authored as px/frame, so a
    // raw rAF loop ran the sim fast on high-refresh handhelds/phones (and slow on
    // 30Hz) — and the server, which also steps once per input, would have moved a
    // high-refresh client proportionally faster. render() still runs once per
    // animation frame at the display's native rate.
    const FRAME_MS = 1000 / 60;
    const MAX_CATCHUP = 5; // cap sim steps per frame (a stall/tab-out can't fast-forward)
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      let delta = now - last;
      last = now;
      // A long gap (backgrounded tab, devtools pause) must not unleash a flood of
      // catch-up steps — resume at real time, not warp speed.
      if (delta > 250) delta = FRAME_MS;
      acc += delta;
      let steps = 0;
      while (acc >= FRAME_MS && steps < MAX_CATCHUP) {
        this.update();
        acc -= FRAME_MS;
        steps++;
      }
      if (steps === MAX_CATCHUP) acc = 0; // drop the remaining backlog
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
    this.player.warpTo(x, y); // set pos + drop stale predicted inputs
    this.player.moving = false;
    // Tell the server this is a deliberate reposition (not a camera pan), so it
    // persists as the authoritative spot when we exit the editor.
    sendEditorTeleport(x, y);
    await this.loadNearbySectors();
    this.updateRoomBounds(x, y);
    this.camera.follow(x, y);
    this.doorSuppressed = true;
  }

  private update() {
    // A virtual (touch/gamepad) tap is injected as a one-frame key press. With the
    // fixed-timestep loop several sim steps can run in a single animation frame, so
    // the tap must be released at the end of EVERY step — otherwise one tap would
    // be read by multiple steps (e.g. a menu toggle opening then closing). The
    // try/finally guards the many early returns in the step body.
    try {
      this._stepUpdate();
    } finally {
      releaseVirtualTaps();
    }
  }

  private _stepUpdate() {
    // Physical gamepad (Steam Deck / Retroid / any controller) → virtual keys.
    // Polled every step, before any input is read, so it drives the same code
    // paths the keyboard does. Action buttons adapt to whether UI is open.
    pollGamepads({
      menuOpen: isMenuOpen(),
      dialogueOpen: isDialogueOpen(),
      charSelect: this.phase === 'charselect',
    });

    if (this.phase === 'charselect') {
      updateCharacterSelect();
      // While the account overlay is up it owns input (DOM); don't also drive
      // the canvas grid underneath it.
      if (isStartScreenOpen()) return;
      // Gamepad → char-select grid. The grid reads DOM-style e.key strings, so
      // the pad's virtual-key path can't reach it; forward discrete nav/confirm
      // events here, mirroring the keydown handler above.
      for (const key of consumeGamepadNav()) {
        playCharSelectMusic();
        if (handleCharSelectInput(key) === 'confirm') {
          initMusic();
          void this.startGame();
          return;
        }
      }
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

    // Hitstop: a landed hit freezes the whole world sim for a few frames so the
    // impact reads. render() still runs, so the held frame is a crisp freeze (and
    // screen shake, which decays in render, keeps animating through the freeze).
    if (tickHitstop()) return;

    // Float/fade chat bubbles + damage/heal popups regardless of other state.
    updateChatBubbles();
    updateEmitters();
    updatePsiFx(); // PSI cast animations advance even while a menu/dialogue is up
    updateProjectiles(); // ranged-weapon shots fly + retire on the same cadence
    updateDeathFx(); // slain bodies tumble + bounce + fade on the same cadence
    updateItemFx(); // item-use animations (eating a Cookie, etc.) advance too

    // Remote players + server NPCs/enemies keep gliding even while menus/
    // dialogue/transitions freeze the local world — their senders haven't stopped.
    const mortalNow = performance.now();
    tickMortalRoll(this.player, mortalNow); // local HP death-slide advances always
    advanceKoThrow(this.player); // KO rotate/fling/bounce settles into the laying pose
    for (const [, rp] of this.remotePlayers) {
      interpolateRemotePlayer(rp);
      applyRemoteSwing(rp, mortalNow); // override snapshot 'walk' with the swing pose
      applyRemoteHurt(rp, mortalNow); // a hit interrupts the swing — hurt wins (runs after)
      applyPredOffset(rp); // layer predicted push/knockback on top, then decay
      tickMortalRoll(rp as HpHolder, mortalNow); // ally's death-slide too
      advanceKoThrow(rp); // ally's KO throw advances identically (deterministic)
    }
    interpolateNpcs();

    // Editor mode (dev only): free camera replaces gameplay simulation; the
    // world stays visible (remotes/NPCs keep updating above) but the player,
    // doors, and music hold still.
    if (this.editor?.isActive()) {
      this.editor.update();
      // Anchor the server's NPC sim on what the free camera is observing so the
      // world keeps ticking under it. The sim only animates NPCs within
      // ACTIVE_RADIUS of a player position (npcSim.js); without this the anchor
      // stays frozen at our editor-entry spot and NPCs we pan to sit still.
      // Reported as the avatar's `move` — the server exempts editor avatars from
      // the jump clamp so this can leap across the map as we pan. Throttled like
      // gameplay's send.
      this.sendTimer++;
      if (this.sendTimer >= 3) {
        this.sendTimer = 0;
        const cam = this.camera;
        sendPosition(
          cam.x + cam.viewW / 2,
          cam.y + cam.viewH / 2,
          this.player.direction,
          this.player.frame,
          this.player.pose
        );
      }
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

    // PSI target-selection (party-target PSI): pick self/ally, then cast. Freezes
    // movement/actions while choosing. (Menu was closed when targeting began.)
    if (this.psiTargeting) {
      this._updatePsiTargeting();
      return;
    }

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
          // Report the talk so the server can arm a dialogue-start event (no-op
          // unless an event is bound to this NPC and we're in its circle).
          sendEventTalk(tid);
        }
        this.talkingNpc = null;
      }
      return;
    }

    // Status-locked (paralyzed / asleep / diamondized): can't act. Skip talk,
    // attack, hotbar and movement — player.update() (called below) self-freezes
    // movement via freezeUntil. Animation/poses still advance.
    if (Date.now() < this.statusLockUntil) {
      this.player.update();
      return;
    }

    // Downed (KO): can't act except "give up the ghost" (hold ANY key/touch ~2s)
    // OR claw back up with a last-ditch healing/revive item on the hotbar — the EB
    // "heal before the counter runs out" survival window. Movement, talk, attack
    // and weapon/PSI hotbar slots stay suppressed until revived or dead. (A quick
    // tap of a hotbar slot uses its item; only a sustained hold gives up.)
    if (this.player.downed) {
      this._updateGiveUp();
      const slot = consumeHotbarSlot();
      if (slot >= 0) triggerHotbarConsumable(slot);
      // Tapping a hotbar slot uses its consumable too (a quick tap, not the
      // sustained hold that gives up the ghost — see _updateGiveUp).
      const tap = consumePointerClick();
      if (tap) {
        const box = hotbarBoxAt(tap.x, tap.y);
        if (box >= 0) triggerHotbarConsumable(box);
      }
      return;
    }

    // E = Talk to / Check whatever is in front of the player.
    if (isTalkPressed()) {
      this.tryTalk();
      return;
    }

    // F = attack swing, H = hurt flinch (debug hook). Weapons are swapped via the
    // 1/2 hotbar now — there's no separate cycle key. A swing that actually starts
    // is sent to the server, which resolves the hit (server-authoritative damage).
    if (isAttackPressed() && this.player.attack()) {
      sendAttack(this.player.x, this.player.y, this.player.direction);
      playEventSfx('player-attack');
      // Predict the swing's knockback so a struck enemy/player lurches THIS frame
      // instead of a round-trip later (server still resolves the real hit).
      predictMeleeKnockback(this.player.x, this.player.y, this.player.direction, this.player.level);
      this.predictPvpKnockback(this.player.x, this.player.y, this.player.direction);
    }
    // 1/2 = trigger the quick-select slot during overworld play (brandish a
    // weapon, use a consumable, or cast an assigned PSI move).
    const slot = consumeHotbarSlot();
    if (slot >= 0) triggerHotbarSlot(slot);
    // Touch/click: a tap on a hotbar box triggers that slot too — the mobile
    // equivalent of the number keys. (No dialogue/menu is open on this path, so
    // the pending click is ours to consume.)
    const tap = consumePointerClick();
    if (tap) {
      const box = hotbarBoxAt(tap.x, tap.y);
      if (box >= 0) triggerHotbarSlot(box);
    }
    if (isHurtPressed()) this.player.hurt();
    if (isToggleBoxesPressed()) setDebugBoxes(!debugBoxesOn());

    this.player.update();
    // Predict the local player's walk-push so plowed NPCs react THIS frame
    // instead of a network round-trip later (the server still authoritatively
    // shoves them; this just hides the latency and reconciles).
    predictPlayerPush(this.player.x, this.player.y, this.player.level, this.player.moving);
    this.predictPushRemotePlayers(this.player.moving);
    // NPC simulation is server-authoritative; getNearbyNPCs (in render) still
    // triggers lazy sprite-sheet loads as NPCs come into range.
    this.camera.follow(this.player.x, this.player.y);

    // Escalator/stairway: step the trigger to start a ride (suppress until the
    // player has fully left the trigger, so the arrival landing — often next to
    // the paired down-escalator — doesn't immediately bounce them back).
    const stair = getStairAt(this.player.x, this.player.y);
    if (this.stairSuppressed) {
      if (!stair) this.stairSuppressed = false;
    } else if (stair && this.player.moving && !(stair.dx === 0 && stair.dy === 0)) {
      // Start a ride toward the paired landing (precomputed at load — its vector
      // and destination are known, including for NOWHERE ends, so no runtime
      // direction guessing). dx/dy=0 means this trigger has no partner — skip it.
      const dx = stair.dx;
      const dy = stair.dy;
      const destX = stair.destX;
      const destY = stair.destY;
      // Same-floor ride? (dept-store stairways hop a few tiles within ONE room.)
      // If the landing is already inside the room we're standing in, the ride
      // never changes floors, so we must NOT touch the camera crop — re-cropping
      // a room we never left is what blacked out / sealed the player (bugs.md).
      // Only a TRUE floor change gets the reveal-both-floors union below.
      const cur = this.camera.roomBounds;
      const landTile =
        Math.floor(destY / TILE_SIZE) * MAP_WIDTH_TILES + Math.floor(destX / TILE_SIZE);
      const sameFloor = cur ? cur.tiles.has(landTile) : !computeRoomBounds(destX, destY);
      this.riding = { dx, dy, destX, destY, dist: 0, sameFloor };
      // Suppress server reconciliation for the glide — the server doesn't know
      // we're riding, so its (stale) pos ACKs would yank us back to the foot.
      this.player.riding = true;
      // Reveal BOTH floors (and the ramp between) for a TRUE floor change. EB
      // stacks floors as separate room-crop regions joined only by the solid
      // ramp, so the source-floor crop leaves the destination floor black — you'd
      // ride into a black void and not see the landing (bugs.md, dept-store
      // escalators). Same-floor hops keep their existing crop.
      if (!sameFloor) {
        const ride = this.computeRideBounds(destX, destY);
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
        this.startTransition(door, 'fade', true); // real door → server-validated warp
        return;
      }
      if (isActionPressed()) {
        this.startTransition(door, 'fade', true);
        return;
      }
    }

    // Update music based on current sector
    updateMusic(this.player.x, this.player.y);

    // Server-authoritative movement: send this frame's INPUT (never a position).
    // The server simulates it and ACKs via `pos` → reconcile. Idle frames send
    // nothing (the server holds position).
    const inp = this.player.lastInputToSend;
    if (inp) sendInput(inp.seq, inp.dx, inp.dy);

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
  // While downed: hold ANY key (or press-and-hold touch/mouse) for GIVE_UP_HOLD_MS
  // to give up the ghost (true death now → respawn at spawn). All other input is
  // suppressed while downed, so any held key is free to mean "give up" and matches
  // the "HOLD TO GIVE UP" prompt. Holding also closes the vignette faster (see
  // Renderer: t = max(timeT, giveUpProgress)). Releasing resets the hold;
  // giveUpProgress (0..1) drives both the on-screen meter and that vignette boost.
  private _updateGiveUp(): void {
    const GIVE_UP_HOLD_MS = 2000;
    const held = getKeySet().size > 0 || isPointerDown();
    const now = Date.now();
    if (!held) {
      this.giveUpHoldStart = 0;
      this.player.giveUpProgress = 0;
      return;
    }
    if (this.giveUpHoldStart === 0) this.giveUpHoldStart = now;
    const dur = now - this.giveUpHoldStart;
    this.player.giveUpProgress = Math.min(1, dur / GIVE_UP_HOLD_MS);
    if (dur >= GIVE_UP_HOLD_MS) {
      sendGiveUp();
      this.giveUpHoldStart = 0;
      this.player.giveUpProgress = 0;
    }
  }

  // Healing γ/Ω revive a downed ally (need a DOWNED target); other party PSI
  // (Lifeup/Healing α) heal/cure a living ally or yourself.
  private static REVIVE_PSI = new Set(['healing_gamma', 'healing_omega']);

  /** Enter PSI target-selection. Returns true (the MenuManager then suppresses
   *  its own immediate cast and the world takes over picking). */
  private _beginPsiTarget(abilityId: string): boolean {
    this.psiTargeting = {
      abilityId,
      kind: Game.REVIVE_PSI.has(abilityId) ? 'downed' : 'ally',
    };
    return true;
  }

  /** Pick mode each frame: Esc cancels; the action key self-casts (ally PSI only);
   *  a click resolves to the nearest valid target (self or ally) and casts. */
  private _updatePsiTargeting(): void {
    const t = this.psiTargeting!;
    if (getKeySet().has('Escape')) {
      this.psiTargeting = null;
      return;
    }
    if (t.kind === 'ally' && isActionPressed()) {
      sendUsePsi(t.abilityId); // no targetId = cast on self
      this.psiTargeting = null;
      return;
    }
    const click = consumePointerClick();
    if (!click) return;
    const wx = click.x + this.camera.x;
    const wy = click.y + this.camera.y;
    const picked = this._pickTargetAt(wx, wy, t.kind);
    if (picked === 'self') {
      sendUsePsi(t.abilityId);
      this.psiTargeting = null;
    } else if (picked) {
      sendUsePsi(t.abilityId, picked);
      this.psiTargeting = null;
    }
    // clicked empty space → stay in targeting mode
  }

  /** Nearest valid target to a world point: 'self', a remote player id, or null.
   *  'ally' kind = self + living players; 'downed' kind = downed players only. */
  private _pickTargetAt(wx: number, wy: number, kind: 'ally' | 'downed'): string | null {
    const PICK = 24;
    let best: string | null = null;
    let bestD2 = PICK * PICK;
    const test = (id: string | null, x: number, y: number) => {
      const dx = x - wx;
      const dy = y - 12 - wy; // bias up to the body center
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = id ?? 'self';
      }
    };
    if (kind === 'ally') test(null, this.player.x, this.player.y);
    for (const [id, rp] of this.remotePlayers) {
      if (kind === 'downed' ? !rp.downed : rp.downed) continue;
      test(id, rp.x, rp.y);
    }
    return best;
  }

  /** Targeting overlay: rings on every valid target + a prompt line. Drawn in
   *  logical screen coords (world − camera), matching the FX pass (gameplay zoom=1). */
  private _renderPsiTargeting(ctx: CanvasRenderingContext2D): void {
    const t = this.psiTargeting;
    if (!t) return;
    const color = t.kind === 'downed' ? '#ff7a7a' : '#7affa0';
    const ring = (wx: number, wy: number) => {
      const sx = Math.round(wx - this.camera.x);
      const sy = Math.round(wy - this.camera.y) - 12;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, 11, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (t.kind === 'ally') ring(this.player.x, this.player.y);
    for (const [, rp] of this.remotePlayers) {
      if (t.kind === 'downed' ? rp.downed : !rp.downed) ring(rp.x, rp.y);
    }
    const label =
      t.kind === 'downed'
        ? 'Click a downed ally   [Esc] cancel'
        : 'Click an ally  ·  Z = self   [Esc] cancel';
    const tw = Math.ceil(measureText(label, FONT_ID) * 0.5);
    const x = Math.round((SCREEN_WIDTH - tw) / 2);
    ctx.fillStyle = '#000a';
    ctx.fillRect(x - 3, 2, tw + 6, 10);
    ctx.save();
    ctx.scale(0.5, 0.5);
    drawText(ctx, label, x * 2, 6, FONT_ID, 1);
    ctx.restore();
  }

  /** Clip the canvas to the current room's tiles (mirrors the renderer's world
   *  clip) so overlays drawn after render() — damage numbers, FX, chat — don't
   *  bleed in from a neighboring room behind the black shroud. Returns true if a
   *  clip+save was pushed (caller must ctx.restore()). Gameplay (zoom 1) only. */
  private _pushRoomClip(): boolean {
    const room = this.camera.roomBounds;
    if (!room || this.camera.zoom !== 1) return false;
    const camX = Math.round(this.camera.x);
    const camY = Math.round(this.camera.y);
    const { startCol, startRow, endCol, endRow } = this.camera.getVisibleTileRange();
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        if (!room.tiles.has(row * MAP_WIDTH_TILES + col)) continue;
        ctx.rect(col * TILE_SIZE - camX, row * TILE_SIZE - camY, TILE_SIZE, TILE_SIZE);
      }
    }
    ctx.clip();
    return true;
  }

  /** Predicate: does a world point's tile belong to the current room? Damage
   *  numbers arc DOWN under gravity, so one spawned in the room packed above us
   *  would fall across the seam and render over our tiles — past the spatial
   *  clip. renderEmitters gates each popup on its spawn origin with this so it
   *  stays in the room it was born in. null in the overworld (no rooms). */
  private _roomOriginGate(): ((x: number, y: number) => boolean) | undefined {
    const room = this.camera.roomBounds;
    if (!room) return undefined;
    return (x: number, y: number) => {
      const col = Math.floor(x / TILE_SIZE);
      const row = Math.floor(y / TILE_SIZE);
      return room.tiles.has(row * MAP_WIDTH_TILES + col);
    };
  }

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
      if ((pages || npc.shopStore !== null || npc.isGift) && score < bestInteractiveScore) {
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
        openPhoneMenu();
        return;
      }
      // An ATM opens the bank menu (withdraw/deposit) — kill money lives in the
      // bank; withdraw to get spendable cash.
      if (target.isAtm) {
        openAtmMenu();
        return;
      }
      // Ness's mom cooks your favorite food: ask the server (it owns the heal +
      // cooldown) and render her line from the response (onMomFood).
      if (target.isMom) {
        sendMomFood();
        this.talkingNpc = target;
        this.faceTalkingNpc();
        return;
      }
      // An item-container (present/trash can/jar…): ask the server to open it
      // (server grants the item once per player and acks 'gift_opened', which
      // flips the container to its lidless/empty open frame). Already-opened
      // containers stay visibly open, so there's nothing to do — don't re-ping.
      if (target.isGift) {
        if (target.placementKey && !giftOpened(target)) {
          sendOpenGift(target.placementKey);
        }
        return;
      }
      // A shop clerk opens its store; anyone else talks (or gives the Check
      // fallback if they have nothing to say).
      if (target.shopStore !== null) {
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

  // Direction enum (S,N,W,E,…) -> the door system's destDir index ([S,N,E,W]).
  // Diagonals fall back to facing south. Used to drive an event warp through the
  // door-transition machinery.
  private _dirToDoorIdx(d: Direction): number {
    switch (d) {
      case Direction.N:
        return 1;
      case Direction.E:
        return 2;
      case Direction.W:
        return 3;
      default:
        return 0; // S + diagonals
    }
  }

  private _fmtTime(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Draw a label with a dark outline so it reads over any tiles.
  private _eventLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string
  ): void {
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
  }

  // Event UI: the world-anchored trigger circle + countdown (arming), the
  // left-behind "in progress" timer (active), and — if the local player is in an
  // event — a screen-anchored event-timer HUD. Fed by the server's event_state.
  private drawEventOverlays(ctx: CanvasRenderingContext2D): void {
    if (this.eventStates.length) {
      const camX = Math.round(this.camera.x);
      const camY = Math.round(this.camera.y);
      for (const ev of this.eventStates) {
        const sx = ev.x - camX;
        const sy = ev.y - camY;
        const margin = ev.radius + 48;
        if (
          sx < -margin ||
          sx > SCREEN_WIDTH + margin ||
          sy < -margin ||
          sy > SCREEN_HEIGHT + margin
        )
          continue; // off-screen (e.g. you're in the event room)
        if (ev.phase === 'arming') {
          ctx.strokeStyle = 'rgba(176,124,255,0.9)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, ev.radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
          this._eventLabel(
            ctx,
            String(Math.ceil((ev.countdownMs ?? 0) / 1000)),
            sx,
            sy - ev.radius - 4,
            '#e6d8ff'
          );
        } else {
          // Active: the "event in progress" marker bystanders see at the trigger.
          this._eventLabel(ctx, ev.name, sx, sy - 12, '#b07cff');
          this._eventLabel(ctx, this._fmtTime(ev.timerMs ?? 0), sx, sy - 3, '#e6d8ff');
        }
      }
    }

    // Local player's event-timer HUD: top-center, stacked directly UNDER the XP
    // bar (anchored to its bottom edge so the two never overlap), while inside.
    if (this.myEventId) {
      const mine = this.eventStates.find((e) => e.id === this.myEventId && e.phase === 'active');
      if (mine) {
        ctx.save();
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = `${mine.name}  ${this._fmtTime(mine.timerMs ?? 0)}`;
        const x = SCREEN_WIDTH / 2;
        const y = XP_BAR_BOTTOM + 3; // small gap below the bar
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(label, x, y);
        ctx.fillStyle = '#c9b0ff';
        ctx.fillText(label, x, y);
        ctx.restore();
      } else {
        this.myEventId = null; // event ended (or we were ejected) — clear the HUD
      }
    }
  }

  private render() {
    // Sync the on-screen touch controls to the current phase (visibility,
    // attack-in-menu, action label). Virtual-tap release happens per sim step in
    // update(), not here — render runs at the display rate, which may differ.
    setTouchContext({
      playing: this.phase === 'playing',
      menuOpen: isMenuOpen(),
      dialogueOpen: isDialogueOpen(),
      downed: !!this.player?.downed,
    });

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
      this.drawLoadingBar(this.loadRatio());
      return;
    }

    // Screen shake: nudge the camera by the decaying shake offset for the world +
    // world-anchored overlays, then restore it before the HUD/dialogue so those
    // stay rock-steady. tickShake() is called unconditionally so trauma decays
    // even in the editor; the offset is only applied during normal play.
    const shake = tickShake();
    const shaking = !this.editor?.isActive() && (shake.x !== 0 || shake.y !== 0);
    if (shaking) {
      this.camera.x += shake.x;
      this.camera.y += shake.y;
    }

    // Editor: render every NPC the free camera shows (its view is decoupled from
    // the frozen avatar). Gameplay stays anchored on the player's AOI window.
    const cam = this.camera;
    const npcsToDraw = this.editor?.isActive()
      ? getNpcsInRect(cam.x, cam.y, cam.x + cam.viewW, cam.y + cam.viewH)
      : getNearbyNPCs(this.player.x, this.player.y);
    this.renderer.render(this.camera, this.player, this.remotePlayers, npcsToDraw);

    // Chat bubbles (world) + typing box (screen), above the world but below
    // the transition fade and menu. Bubbles anchor to world positions, so
    // they ride the editor zoom transform when it's active.
    if (this.camera.zoom !== 1) {
      this.ctx.save();
      this.ctx.scale(this.camera.zoom, this.camera.zoom);
      renderPsiFx(this.ctx, this.camera);
      renderItemFx(this.ctx, this.camera);
      renderEmitters(this.ctx, this.camera);
      renderChat(this.ctx, this.camera, this.player, this.remotePlayers);
      this.ctx.restore();
    } else {
      // Clip these world-anchored overlays (damage/heal numbers, PSI/item FX, chat
      // bubbles) to the current room's tiles, exactly like the world pass — so
      // action in a NEIGHBORING room packed next to this one stays hidden behind
      // the black shroud instead of bleeding numbers/FX through it.
      const clipped = this._pushRoomClip();
      renderPsiFx(this.ctx, this.camera);
      renderItemFx(this.ctx, this.camera);
      renderEmitters(this.ctx, this.camera, this._roomOriginGate());
      renderChat(this.ctx, this.camera, this.player, this.remotePlayers);
      if (clipped) this.ctx.restore();
    }

    // PSI target-selection overlay (rings on valid targets + prompt), gameplay only.
    if (this.psiTargeting) this._renderPsiTargeting(this.ctx);

    // Undo the shake offset so the dialogue box, fade, and HUD don't jitter.
    if (shaking) {
      this.camera.x -= shake.x;
      this.camera.y -= shake.y;
    }

    // Event overlays (trigger circle + countdown, the "in progress" timer, and
    // the local player's event-timer HUD). Below the fade so warps cover them.
    if (!this.editor?.isActive()) this.drawEventOverlays(this.ctx);

    // AOI crowd aggregate (§4.6): when more nearby players exist than the server
    // sends individually, show "+N nearby" so a packed square doesn't look empty
    // beyond the cap. Gameplay only; 0 unless server AOI is on and over the cap.
    if (this.crowdOverflow > 0 && this.phase === 'playing') {
      this._eventLabel(this.ctx, `+${this.crowdOverflow} nearby`, SCREEN_WIDTH - 32, 12, '#ffd86b');
    }

    // NPC dialogue window, above bubbles but below the fade and menu.
    renderDialogue(this.ctx);

    // Draw transition overlay (door fade or event battle-swirl) during warps.
    if (this.transitionAlpha > 0) {
      if (this.transitionStyle === 'swirl' && swirlReady()) {
        // Swirl mask multiplies over the frame: alpha 0→1 eats to black, then
        // 1→0 reveals (the in-phase replays the same frames in reverse).
        drawSwirl(this.ctx, this.transitionAlpha);
      } else {
        this.ctx.fillStyle = `rgba(0, 0, 0, ${this.transitionAlpha})`;
        this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      }
      // If the destination prefetch outran the fade (slow connection), show a
      // progress bar on the black instead of an indefinite wait. Usually the
      // prefetch is already done by now, so this never appears.
      if (this.waitingForSectors && this.transitionAlpha >= 1) {
        const r = this.loadRatio();
        if (r < 1) this.drawLoadingBar(r);
      }
    }

    // Quick-select hotbar HUD — bottom of the UI depth stack: drawn only when
    // the player has plain field control. Any higher layer hides it — the menu,
    // NPC dialogue, the level-up pentagon, chat typing, a door fade, or the
    // editor. (When the menu is open, renderMenu draws the bar itself, and only
    // on its browsing screens.)
    const hudBlocked =
      isMenuOpen() ||
      isDialogueOpen() ||
      isLevelUpOpen() ||
      isChatTyping() ||
      this.transitioning ||
      !!this.editor?.isActive();
    if (!hudBlocked) {
      renderHotbarOverlay(this.ctx);
      renderXpBar(this.ctx); // top-middle progress to next level
    }

    // Always-on money window (top-right), when the player enables it in Settings.
    // Hidden while the menu is open (its own screens draw it) and while the editor
    // is up (the editor owns the screen — no game HUD over it).
    if (!isMenuOpen() && !this.editor?.isActive()) renderMoneyOverlay(this.ctx);

    // Draw menu on top of game world (including during transitions)
    renderMenu(this.ctx);

    // Editor overlays (dev only) — grids, readout highlights, tool overlays.
    if (this.editor?.isActive()) this.editor.drawOverlay();
  }
}
