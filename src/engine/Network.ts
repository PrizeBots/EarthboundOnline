import { RemotePlayer, Direction, Pose, CharacterAppearance } from '../types';
import { GoodsItem } from './Inventory';

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
  /** The LOCAL player's full equipped set (server-authoritative, per slot). */
  onEquipped: (slots: Record<string, string | null>) => void;
  /** Authoritative NPC positions (welcome snapshot + periodic deltas). */
  onNpcUpdate: (npcs: NpcUpdate[]) => void;
  /** Authoritative enemy HP (welcome snapshot + on-damage deltas). */
  onNpcHp: (hps: NpcHp[]) => void;
  /**
   * A player's HP changed (enemy hit / respawn refill / item use). dmg>0 = took
   * a hit; heal>0 = restored HP (e.g. ate a Cookie).
   */
  onPlayerHp: (id: string, hp: number, maxHp: number, dmg: number, heal: number) => void;
  /** The local player's Goods list (welcome snapshot + post-use deltas). */
  onInventory: (items: GoodsItem[]) => void;
  /** The local player's money balance (welcome snapshot + future deltas). */
  onMoney: (amount: number) => void;
  /** A player respawned — snap them to (x, y). */
  onPlayerRespawn: (id: string, x: number, y: number, dir: Direction) => void;
  /** Server-authoritative progression: EXP gained / level-up / stat growth. */
  onPlayerStats: (id: string, stats: PlayerStatsPayload, leveled: boolean, gained: number) => void;
};

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

export function connect(
  spriteGroupId: number,
  name: string,
  appearance: CharacterAppearance | null,
  cb: NetworkCallback
) {
  callbacks = cb;

  // Connect to WS server — same host/port, /ws path
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    // Level is NOT sent: the server is authoritative on progression (every join
    // starts at level 1 until the save system lands) and ignores client-supplied
    // levels, so sending one would only imply a control the client doesn't have.
    ws!.send(
      JSON.stringify({
        type: 'join',
        spriteGroupId,
        name,
        appearance,
      })
    );
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'welcome':
        callbacks?.onWelcome(msg.playerId, msg.players);
        if (msg.npcs) callbacks?.onNpcUpdate(msg.npcs);
        if (msg.npcHps) callbacks?.onNpcHp(msg.npcHps);
        if (msg.inventory) callbacks?.onInventory(msg.inventory);
        if (typeof msg.money === 'number') callbacks?.onMoney(msg.money);
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
        callbacks?.onEquipped(msg.slots ?? {});
        break;
      case 'player_hp':
        callbacks?.onPlayerHp(msg.id, msg.hp, msg.maxHp, msg.dmg ?? 0, msg.heal ?? 0);
        break;
      case 'player_respawn':
        callbacks?.onPlayerRespawn(msg.id, msg.x, msg.y, (msg.dir ?? 0) as Direction);
        break;
      case 'player_stats':
        callbacks?.onPlayerStats(msg.id, msg.stats, !!msg.leveled, msg.gained ?? 0);
        break;
    }
  };

  ws.onclose = () => {
    console.log('Disconnected from server');
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'editor', on }));
  }
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

/** Ask the server to use a Goods item; it validates ownership and resolves it. */
export function sendUseItem(itemId: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'use_item', itemId }));
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

export function sendChat(text: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text }));
  }
}
