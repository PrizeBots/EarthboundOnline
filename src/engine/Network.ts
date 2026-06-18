import { RemotePlayer, Direction, Pose, CharacterAppearance } from '../types';
import { GoodsItem } from './Inventory';
import { GroundDrop } from './DropManager';

/** A pickup notification: an item ("Found Cookie!") or money ("Got $40"). */
export interface LootPayload {
  item?: string;
  name?: string;
  money?: number;
}

/**
 * Server NPC state row: [npcId, x, y, direction, frame, poseCode?].
 * poseCode indexes POSES (src/types.ts); absent = walk (back-compat).
 */
export type NpcUpdate = [number, number, number, number, number, number?];
/** Server enemy HP row: [npcId, hp, maxHp]. hp <= 0 means dead/hidden. */
export type NpcHp = [number, number, number];

type NetworkCallback = {
  onWelcome: (playerId: string, players: RemotePlayer[]) => void;
  onPlayerJoin: (player: RemotePlayer) => void;
  onPlayerMove: (
    id: string,
    x: number,
    y: number,
    direction: Direction,
    frame: number,
    pose: Pose
  ) => void;
  onPlayerLeave: (id: string) => void;
  onChat: (id: string, text: string) => void;
  /** A player equipped (or unequipped) a held item (the weapon, for the sprite). */
  onEquip: (id: string, itemId: string | null) => void;
  /** The LOCAL player's full equipped set (server-authoritative, per slot).
   *  attackSpeed is the equipped weapon's swing-rate multiplier (1 = baseline). */
  onEquipped: (slots: Record<string, string | null>, attackSpeed?: number) => void;
  /** Authoritative NPC positions (welcome snapshot + periodic deltas). */
  onNpcUpdate: (npcs: NpcUpdate[]) => void;
  /** Authoritative enemy HP (welcome snapshot + on-damage deltas). */
  onNpcHp: (hps: NpcHp[]) => void;
  /** An actor's active status set changed: [npcId, [statusId,…]] rows. */
  onNpcStatus?: (rows: [number, string[]][]) => void;
  /** An actor's held weapon changed: [npcId, itemId|null] rows (welcome + deltas). */
  onNpcEquip?: (rows: [number, string | null][]) => void;
  /**
   * A player's HP changed (enemy hit / respawn refill / item use). dmg>0 = took
   * a hit; heal>0 = restored HP (e.g. ate a Cookie).
   */
  onPlayerHp: (id: string, hp: number, maxHp: number, dmg: number, heal: number) => void;
  /**
   * A crit or a miss happened at world (x, y). `byPlayer` is the attacking
   * player's id (null for enemy/NPC swings); `targetPlayer` is the defending
   * player's id (null for enemy/NPC targets). Drives floating text + the
   * SMAAAASH! / just-missed / dodge SFX. Plain hits don't fire this — their
   * damage arrives via onNpcHp / onPlayerHp.
   */
  onCombat: (
    evt: 'crit' | 'miss',
    x: number,
    y: number,
    byPlayer: string | null,
    targetPlayer: string | null
  ) => void;
  /** The local player's Goods list (welcome snapshot + post-use deltas). */
  onInventory: (items: GoodsItem[]) => void;
  /** The local player's on-hand cash (welcome snapshot + deltas). */
  onMoney: (amount: number) => void;
  /** Restore the saved quick-select hotbar (welcome only): per slot a weapon /
   *  usable item id, a 'psi:<id>' tag, or null. */
  onHotbar?: (hotbar: (string | null)[]) => void;
  /** The local player's bank/ATM balance (welcome snapshot + deltas). */
  onBank?: (amount: number) => void;
  /**
   * Dad's phone report: money banked from kills (`earned`) and cash spent at
   * shops (`spent`) since the last call, plus the current `bank` total. Drives
   * the "I put $X in your account…" save prompt. Reply to a `dad_call`.
   */
  onDadReport?: (earned: number, spent: number, bank: number) => void;
  /** A player respawned — snap them to (x, y). */
  onPlayerRespawn: (id: string, x: number, y: number, dir: Direction) => void;
  /**
   * A player was knocked back by a hit — snap them to (x, y). Server already
   * collision-clamped the spot; the local player applies it authoritatively and
   * reports from there, remote players just snap their interpolated copy.
   */
  onPlayerPush?: (id: string, x: number, y: number) => void;
  /** A player's active status-condition set changed (paralysis, poison, …). */
  onPlayerStatus?: (id: string, statuses: string[]) => void;
  /** A PSI was cast — play its effect. (x,y)=caster, (tx,ty)=target (projectile
   *  flies between them). Sent to everyone incl. the caster. Visual only. */
  onPsiCast?: (id: string, casterId: string, x: number, y: number, tx: number, ty: number) => void;
  /** Another player used a consumable — play its "use" animation at (x,y).
   *  `item` is the item id; the caster already plays its own. Visual only. */
  onItemUse?: (id: string, item: string, x: number, y: number) => void;
  /**
   * A status was just inflicted on a player — drives the floating EB battle-text
   * ("became numb!") at (x, y). `blocks` = it locks action (paralysis/sleep/
   * diamond); `ms` = its duration, used as the local input-lock deadline.
   */
  onStatusApplied?: (
    id: string,
    x: number,
    y: number,
    statusType: string,
    text: string,
    ms: number,
    blocks: boolean
  ) => void;
  /** Server-authoritative progression: EXP gained / level-up / stat growth. */
  onPlayerStats: (id: string, stats: PlayerStatsPayload, leveled: boolean, gained: number) => void;
  /**
   * The LOCAL player's banked skill points + current stat allocation (private —
   * server pushes this on level-up, after a spend, and on join). Drives the
   * level-up icon + the spend pentagon.
   */
  onPoints?: (points: number, alloc: Record<string, number>) => void;
  /**
   * The LOCAL player's persisted quest/progress flags (PlayerFlags), restored
   * from the character save on `welcome`. Anonymous joins get an empty list.
   */
  onFlags?: (ids: number[]) => void;
  /**
   * A player's PK (player-kill) state changed. `lockMs` is the REMAINING in-game
   * ms on the enable-lock (only meaningful for the LOCAL player; 0 when off). The
   * client turns it into a local deadline — sending remaining ms (not an absolute
   * timestamp) keeps it correct across client/server clock differences.
   */
  onPlayerPk?: (id: string, pk: boolean, lockMs: number) => void;
  /** Ground loot already lying in the world on join (welcome snapshot). */
  onDrops?: (drops: GroundDrop[]) => void;
  /** A new ground drop appeared (enemy/player death). */
  onDropSpawn?: (drop: GroundDrop) => void;
  /** A ground drop was claimed/removed. */
  onDropRemove?: (id: string) => void;
  /** The LOCAL player picked something up — drives the "Found X!" toast. */
  onLoot?: (loot: LootPayload) => void;
  /** A server notice for the LOCAL player (e.g. "Your bag is full!"). */
  onNotice?: (text: string, code?: string) => void;
  /** Server confirmed a present open (by placement key) — play the open→fade. */
  onGiftOpened?: (k: string) => void;
  /**
   * Ness's mom's food response (server-authoritative). `healed` HP restored this
   * meal (0 if on cooldown or already full); `readyInMs` is the wait before the
   * next meal (>0 only when on cooldown); `food` is the player's favorite food
   * name (empty → the client uses a generic fallback). Drives her dialogue.
   */
  onMomFood?: (healed: number, readyInMs: number, food: string) => void;
  /**
   * The LOCAL player's active timed stat buffs changed (owner-only; drives the
   * buff HUD). Each entry's `ms` is REMAINING time (the client turns it into a
   * local deadline, so it stays correct across clock skew). Empty = no buffs.
   */
  onPlayerBuffs?: (buffs: BuffPayload[]) => void;
  /** A player was KO'd (downed). `ms` = the revive window length; the client lays
   *  them out, counts down, and (for the owner) draws the closing vignette. */
  onPlayerDowned?: (id: string, ms: number) => void;
  /** A downed player was revived (by an ally) — stand them back up. */
  onPlayerRevived?: (id: string) => void;
};

/** One active timed stat buff the server reports (server/buffs.js). */
export interface BuffPayload {
  stat: string;
  amount: number;
  ms: number; // remaining duration in ms at send time
}

/** Progression block the server pushes (field names match StatusModal). */
export interface PlayerStatsPayload {
  level: number;
  hp: number;
  hpMax: number;
  pp: number;
  ppMax: number;
  exp: number;
  expToNext: number;
  offense: number;
  defense: number;
  speed: number;
  guts: number;
  vitality: number;
  iq: number;
  luck: number;
}

let ws: WebSocket | null = null;
let callbacks: NetworkCallback | null = null;
// Desired editor-mode state, kept as persistent module state (not a one-shot).
// The server only knows we're in the editor via a message, and it forgets on a
// fresh `welcome` (every entry defaults editor:false). So we MUST re-assert this
// on every (re)open — F2-from-char-select connect races AND, crucially, any
// reconnect (server restart on save, network blip, idle timeout). Without the
// re-send the reconnected avatar becomes a live target mid-edit and enemies
// start hitting it again. Flushed in onopen.
let editorModeActive = false;

// --- Auto-reconnect state ---
// The args from the last connect() call, replayed to re-join after a dropped
// socket (server restart, network blip, idle-timeout). null until first connect.
let joinArgs: {
  spriteGroupId: number;
  name: string;
  appearance: CharacterAppearance | null;
  auth: JoinAuth | null;
} | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUs = false; // a deliberate disconnect() must not trigger reconnect
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Optional signed-in join: load a persistent character by id, authenticated by
 * the session token. When present, the server ignores the anonymous sprite/name/
 * appearance and rebuilds everything from the saved character.
 */
export interface JoinAuth {
  sessionToken: string;
  characterId: number;
}

export function connect(
  spriteGroupId: number,
  name: string,
  appearance: CharacterAppearance | null,
  cb: NetworkCallback,
  auth?: JoinAuth | null
) {
  callbacks = cb;
  joinArgs = { spriteGroupId, name, appearance, auth: auth ?? null };
  closedByUs = false;
  reconnectAttempt = 0;
  openSocket();
}

/** Deliberately close the socket and stop auto-reconnect. */
export function disconnect() {
  closedByUs = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) ws.close();
}

// Open (or re-open) the socket and replay the stored join. Wired by connect() and
// the reconnect backoff; all handlers read module state so they survive re-opens.
function openSocket() {
  if (!joinArgs) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectAttempt = 0; // a clean connection resets the backoff
    const { spriteGroupId, name, appearance, auth } = joinArgs!;
    // Signed-in: join by token+characterId (server loads the save). Anonymous:
    // the dev/char-select join (fresh ephemeral player; the server is still
    // authoritative on progression, so no level is sent).
    ws!.send(
      JSON.stringify(
        auth
          ? { type: 'join', sessionToken: auth.sessionToken, characterId: auth.characterId }
          : { type: 'join', spriteGroupId, name, appearance }
      )
    );
    // Re-assert editor mode on every (re)open: the server forgets it on each
    // fresh welcome, so a reconnect mid-edit would otherwise make our avatar a
    // live, damageable target again. Only send `true` — a fresh join already
    // defaults to false server-side.
    if (editorModeActive) {
      ws!.send(JSON.stringify({ type: 'editor', on: true }));
    }
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'welcome':
        callbacks?.onWelcome(msg.playerId, msg.players);
        if (msg.npcs) callbacks?.onNpcUpdate(msg.npcs);
        if (msg.npcHps) callbacks?.onNpcHp(msg.npcHps);
        if (msg.npcEquips) callbacks?.onNpcEquip?.(msg.npcEquips);
        if (msg.inventory) callbacks?.onInventory(msg.inventory);
        if (typeof msg.money === 'number') callbacks?.onMoney(msg.money);
        if (typeof msg.bank === 'number') callbacks?.onBank?.(msg.bank);
        // Signed-in characters restore saved stats + gear right away (reusing the
        // live progression/equip handlers). Anonymous joins omit these.
        if (msg.stats) callbacks?.onPlayerStats(msg.playerId, msg.stats, false, 0);
        if (msg.equipped) callbacks?.onEquipped(msg.equipped, msg.attackSpeed);
        // Restore the saved quick-select hotbar (incl. an assigned PSI, which —
        // unlike the weapon — can't be re-derived from the equip set). After
        // onEquipped so the saved layout wins over the weapon auto-placement.
        if (Array.isArray(msg.hotbar)) callbacks?.onHotbar?.(msg.hotbar);
        // Restore saved player flags (empty for anonymous joins).
        callbacks?.onFlags?.(Array.isArray(msg.flags) ? msg.flags : []);
        // Restore PK state + remaining lock (a player who logged out PK stays PK).
        callbacks?.onPlayerPk?.(msg.playerId, !!msg.pk, msg.lockMs ?? 0);
        if (Array.isArray(msg.drops)) callbacks?.onDrops?.(msg.drops);
        break;
      case 'join_error':
        console.error('Join rejected:', msg.error);
        break;
      case 'points_update':
        callbacks?.onPoints?.(msg.points ?? 0, msg.alloc ?? {});
        break;
      case 'inventory':
        callbacks?.onInventory(msg.items ?? []);
        break;
      case 'money':
        // Server sends { type:'money', money } (same field as welcome) — NOT
        // `amount`. Reading the wrong field zeroed the balance on every buy/sell.
        callbacks?.onMoney(typeof msg.money === 'number' ? msg.money : 0);
        break;
      case 'npc_update':
        callbacks?.onNpcUpdate(msg.npcs);
        break;
      case 'npc_status':
        if (msg.statuses) callbacks?.onNpcStatus?.(msg.statuses);
        break;
      case 'npc_equip':
        if (msg.equips) callbacks?.onNpcEquip?.(msg.equips);
        break;
      case 'npc_hp':
        callbacks?.onNpcHp(msg.hps);
        break;
      case 'player_join':
        callbacks?.onPlayerJoin(msg.player);
        break;
      case 'player_move':
        callbacks?.onPlayerMove(msg.id, msg.x, msg.y, msg.direction, msg.frame, msg.pose ?? 'walk');
        break;
      case 'player_leave':
        callbacks?.onPlayerLeave(msg.id);
        break;
      case 'chat':
        callbacks?.onChat(msg.id, msg.text);
        break;
      case 'equip':
        callbacks?.onEquip(msg.id, msg.itemId ?? null);
        break;
      case 'equipped':
        callbacks?.onEquipped(msg.slots ?? {}, msg.attackSpeed);
        break;
      case 'player_hp':
        callbacks?.onPlayerHp(msg.id, msg.hp, msg.maxHp, msg.dmg ?? 0, msg.heal ?? 0);
        break;
      case 'combat':
        callbacks?.onCombat(msg.evt, msg.x, msg.y, msg.byPlayer ?? null, msg.targetPlayer ?? null);
        break;
      case 'player_push':
        callbacks?.onPlayerPush?.(msg.id, msg.x, msg.y);
        break;
      case 'player_status':
        callbacks?.onPlayerStatus?.(msg.id, Array.isArray(msg.statuses) ? msg.statuses : []);
        break;
      case 'psi_cast':
        callbacks?.onPsiCast?.(
          msg.id,
          msg.caster,
          msg.x,
          msg.y,
          typeof msg.tx === 'number' ? msg.tx : msg.x,
          typeof msg.ty === 'number' ? msg.ty : msg.y
        );
        break;
      case 'item_use':
        callbacks?.onItemUse?.(msg.id, msg.item, msg.x, msg.y);
        break;
      case 'status_applied':
        callbacks?.onStatusApplied?.(
          msg.id,
          msg.x,
          msg.y,
          msg.status,
          msg.text ?? '',
          typeof msg.ms === 'number' ? msg.ms : 0,
          !!msg.blocks
        );
        break;
      case 'player_respawn':
        callbacks?.onPlayerRespawn(msg.id, msg.x, msg.y, (msg.dir ?? 0) as Direction);
        break;
      case 'player_stats':
        callbacks?.onPlayerStats(msg.id, msg.stats, !!msg.leveled, msg.gained ?? 0);
        break;
      case 'player_pk':
        callbacks?.onPlayerPk?.(msg.id, !!msg.pk, msg.lockMs ?? 0);
        break;
      case 'player_buffs':
        callbacks?.onPlayerBuffs?.(Array.isArray(msg.buffs) ? msg.buffs : []);
        break;
      case 'player_downed':
        callbacks?.onPlayerDowned?.(msg.id, typeof msg.ms === 'number' ? msg.ms : 0);
        break;
      case 'player_revived':
        callbacks?.onPlayerRevived?.(msg.id);
        break;
      case 'drop_spawn':
        if (msg.drop) callbacks?.onDropSpawn?.(msg.drop);
        break;
      case 'drop_remove':
        callbacks?.onDropRemove?.(msg.id);
        break;
      case 'loot':
        callbacks?.onLoot?.(msg);
        break;
      case 'gift_opened':
        // Server confirmed a one-time present open: play the open→fade. The item
        // (if any) arrives separately via 'inventory' + 'loot'.
        if (typeof msg.k === 'string') callbacks?.onGiftOpened?.(msg.k);
        break;
      case 'mom_food':
        callbacks?.onMomFood?.(msg.healed ?? 0, msg.readyInMs ?? 0, msg.food ?? '');
        break;
      case 'notice':
        callbacks?.onNotice?.(msg.text ?? '', msg.code);
        break;
      case 'bank':
        callbacks?.onBank?.(typeof msg.bank === 'number' ? msg.bank : 0);
        break;
      case 'dad_report':
        callbacks?.onDadReport?.(
          typeof msg.earned === 'number' ? msg.earned : 0,
          typeof msg.spent === 'number' ? msg.spent : 0,
          typeof msg.bank === 'number' ? msg.bank : 0
        );
        break;
    }
  };

  ws.onclose = () => {
    if (closedByUs || !joinArgs) return; // deliberate disconnect — stay down
    // Unexpected drop: retry with exponential backoff (1s, 2s, 4s … capped 8s)
    // so a server restart or network blip transparently re-joins. The server
    // treats the re-join as a fresh connection; a signed-in player reloads their
    // save, the old socket is reaped server-side by the idle sweep.
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`Disconnected — gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      return;
    }
    const delay = Math.min(8000, 1000 * 2 ** reconnectAttempt);
    reconnectAttempt++;
    console.log(`Disconnected — reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(openSocket, delay);
  };
}

export function sendPosition(
  x: number,
  y: number,
  direction: Direction,
  frame: number,
  pose: Pose
) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'move',
        x: Math.round(x),
        y: Math.round(y),
        direction,
        frame,
        pose,
      })
    );
  }
}

/** ATM: ask the server to move `amount` from the bank to on-hand cash. */
export function sendAtmWithdraw(amount: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'atm_withdraw', amount: Math.floor(amount) }));
  }
}

/** ATM: ask the server to move `amount` from on-hand cash to the bank. */
export function sendAtmDeposit(amount: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'atm_deposit', amount: Math.floor(amount) }));
  }
}

/** Phone: call Dad. The server replies with a `dad_report` (earned/spent/bank). */
export function sendDadCall() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'dad_call' }));
  }
}

/**
 * Tell the server we entered (true) or finished (false) a door transition.
 * While warping the client freezes its reported position for the whole fade, so
 * the server shields the motionless player from enemy hits (see GameHost).
 */
export function sendWarpState(warping: boolean) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'warp', warping }));
  }
}

/**
 * Dev editor only: tell the server we entered (true) / left (false) editor mode.
 * The server then pulls our avatar out of the NPC sim — enemies ignore it and no
 * death can respawn-yank our free camera. No-op in production (editor never loads).
 */
export function sendEditorMode(on: boolean) {
  // Remember the desired state so onopen can re-assert it across reconnects.
  editorModeActive = on;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'editor', on }));
  }
  // If the socket is still connecting / reconnecting, onopen reads editorModeActive.
}

/** Request a melee swing; the server resolves the hit against enemies. */
export function sendAttack(x: number, y: number, dir: Direction) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'attack', x: Math.round(x), y: Math.round(y), dir }));
  }
}

/** Equip (or unequip with null) an item into one of the 4 EB slots. */
export function sendEquip(slot: string, itemId: string | null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'equip', slot, itemId }));
  }
}

/** Persist the quick-select hotbar layout (the server validates + saves it with
 *  the character, so an assigned PSI survives a relog). */
export function sendHotbar(hotbar: (string | null)[]) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'hotbar', hotbar }));
  }
}

/** Ask the server to use a Goods item; it validates ownership and resolves it.
 *  `targetId` aims a revive item at a specific downed ally (else the server uses
 *  the nearest downed ally in range). */
export function sendUseItem(itemId: string, targetId?: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'use_item', itemId, ...(targetId ? { targetId } : {}) }));
  }
}

/** Give up the ghost during the downed window → true death now (server-gated). */
export function sendGiveUp() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'give_up' }));
  }
}

/** Buy `item` from `store`; the server validates stock/price and replies with
 * fresh `inventory` + `money`. */
export function sendBuy(store: number, item: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'buy', store, item }));
  }
}

/** Sell one `item` (at half price); the server replies with fresh `inventory` + `money`. */
export function sendSell(item: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'sell', item }));
  }
}

/** Ask the server to cast a PSI ability; it validates PP and resolves the effect. */
export function sendUsePsi(psiId: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'use_psi', psiId }));
  }
}

/** Toggle this player's PK (player-kill) flag. Server broadcasts `player_pk`. */
export function sendSetPk(on: boolean) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_pk', on }));
  }
}

/**
 * Persist a player-flag change server-side (PlayerFlags' sink). `set`/`clear`
 * carry an id; `reset` wipes all of this character's flags (dev Flag Editor).
 * The server stores them in the character save — no echo, writes are optimistic.
 */
export function sendFlag(action: 'set' | 'clear' | 'reset', id?: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (action === 'reset') {
    ws.send(JSON.stringify({ type: 'clear_all_flags' }));
  } else {
    ws.send(JSON.stringify({ type: action === 'set' ? 'set_flag' : 'clear_flag', id }));
  }
}

/**
 * Ask the server to open a present box (by its placement key). The server is
 * authoritative: it grants the item once per player and acks 'gift_opened'.
 */
export function sendOpenGift(k: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'open_gift', k }));
  }
}

/** Ask Ness's mom to cook the player's favorite food (server heals + cooldown). */
export function sendMomFood() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'mom_food' }));
  }
}

export function sendChat(text: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text }));
  }
}

/**
 * Request to spend banked skill points: `add` maps stat -> points to add. The
 * SERVER validates against the authoritative banked total + caps and rejects any
 * cheat; the client just asks. The result comes back via onPoints + onPlayerStats.
 */
export function sendSpendPoints(add: Record<string, number>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'spend_points', add }));
  }
}
