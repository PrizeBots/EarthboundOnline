import { RemotePlayer, Direction, Pose, CharacterAppearance } from '../types';

/** Server NPC state row: [npcId, x, y, direction, frame] */
export type NpcUpdate = [number, number, number, number, number];
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
  /** A player equipped (or unequipped) a held item. */
  onEquip: (id: string, itemId: string | null) => void;
  /** Authoritative NPC positions (welcome snapshot + periodic deltas). */
  onNpcUpdate: (npcs: NpcUpdate[]) => void;
  /** Authoritative enemy HP (welcome snapshot + on-damage deltas). */
  onNpcHp: (hps: NpcHp[]) => void;
};

let ws: WebSocket | null = null;
let callbacks: NetworkCallback | null = null;
let sendInterval: number | null = null;

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
    ws!.send(JSON.stringify({
      type: 'join',
      spriteGroupId,
      name,
      appearance,
    }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'welcome':
        callbacks?.onWelcome(msg.playerId, msg.players);
        if (msg.npcs) callbacks?.onNpcUpdate(msg.npcs);
        if (msg.npcHps) callbacks?.onNpcHp(msg.npcHps);
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
    }
  };

  ws.onclose = () => {
    console.log('Disconnected from server');
    if (sendInterval) clearInterval(sendInterval);
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
    ws.send(JSON.stringify({
      type: 'move',
      x: Math.round(x),
      y: Math.round(y),
      direction,
      frame,
      pose,
    }));
  }
}

/** Request a melee swing; the server resolves the hit against enemies. */
export function sendAttack(x: number, y: number, dir: Direction) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'attack', x: Math.round(x), y: Math.round(y), dir }));
  }
}

export function sendEquip(itemId: string | null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'equip', itemId }));
  }
}

export function sendChat(text: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text }));
  }
}
