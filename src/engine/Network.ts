import { RemotePlayer, Direction } from '../types';

type NetworkCallback = {
  onWelcome: (playerId: string, players: RemotePlayer[]) => void;
  onPlayerJoin: (player: RemotePlayer) => void;
  onPlayerMove: (id: string, x: number, y: number, direction: Direction, frame: number) => void;
  onPlayerLeave: (id: string) => void;
};

let ws: WebSocket | null = null;
let callbacks: NetworkCallback | null = null;
let sendInterval: number | null = null;

export function connect(
  spriteGroupId: number,
  name: string,
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
    }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'welcome':
        callbacks?.onWelcome(msg.playerId, msg.players);
        break;
      case 'player_join':
        callbacks?.onPlayerJoin(msg.player);
        break;
      case 'player_move':
        callbacks?.onPlayerMove(msg.id, msg.x, msg.y, msg.direction, msg.frame);
        break;
      case 'player_leave':
        callbacks?.onPlayerLeave(msg.id);
        break;
    }
  };

  ws.onclose = () => {
    console.log('Disconnected from server');
    if (sendInterval) clearInterval(sendInterval);
  };
}

export function sendPosition(x: number, y: number, direction: Direction, frame: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'move',
      x: Math.round(x),
      y: Math.round(y),
      direction,
      frame,
    }));
  }
}
