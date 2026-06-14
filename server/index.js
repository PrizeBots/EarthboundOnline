const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { createNpcSim } = require('./npcSim');
const { loadShops } = require('./shops');

const PORT = process.env.PORT || 3333;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from Vite's build output (or let Vite proxy handle it in dev)
app.use(express.static(path.join(__dirname, '..', 'dist')));

// --- Game State ---
const players = new Map(); // id -> { id, name, spriteGroupId, x, y, direction, frame, pose, itemId, hp, maxHp, level }
let nextId = 1;

const POSES = ['walk', 'climb', 'attack', 'hurt'];
const PLAYER_MAX_HP = 60;

// Server-authoritative goods registry + shop catalog, loaded from the authored
// shops.json (see tools/extract_shops.py and server/shops.js). Each player's
// inventory is an array of numeric-string item ids (one entry per carried item,
// EarthBound-style slots). Effects are resolved here so a client can't grant
// itself HP or money — it only asks to use/buy/sell ids it claims to own, and
// every transaction is validated against GOODS/STORES.
const { goods: GOODS, storeHas, startingInventory: STARTING_INVENTORY } = loadShops(
  path.join(__dirname, '..', 'public', 'assets')
);
const MAX_SLOTS = 14; // EarthBound's Goods menu holds 14 items per character

// Money ($). Server-authoritative: granted on join, the sole authority on the
// balance once shops/drops spend it.
const STARTING_MONEY = 1000;

// Project an inventory (array of ids) to the wire shape the client renders:
// [{ id, name }]. Unknown ids are dropped rather than sent nameless.
function inventoryView(inventory) {
  return inventory
    .filter((id) => GOODS[id])
    .map((id) => ({ id, name: GOODS[id].name }));
}

function clampLevel(v) {
  const n = v | 0;
  return n >= 1 && n <= 99 ? n : 1;
}

// Spawn point: editor override (public/overrides/spawn.json) wins over the
// src/spawn.json default the client also uses. Read once at startup (nodemon
// restarts on server-code changes; a moved spawn only matters for new joins).
function readSpawn() {
  const fs = require('fs');
  for (const rel of ['../public/overrides/spawn.json', '../src/spawn.json']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
    } catch {
      /* try next */
    }
  }
  return { x: 1296, y: 1168, dir: 0 };
}
const SPAWN = readSpawn();

// Apply an enemy's landed hit to a player (server-authoritative HP). Broadcast
// the new HP so every client updates that player's bar; the victim's own client
// plays the hurt pose. At 0 HP the player respawns at the spawn point.
function damagePlayer(playerId, dmg) {
  const p = players.get(playerId);
  if (!p || p.hp <= 0) return;
  // Defense (stat + equipped armor) softens hits; always at least 1.
  const eff = Math.max(1, dmg - Math.floor(((p.defense || 0) + (p.armorDefense || 0)) / 2));
  p.hp = Math.max(0, p.hp - eff);
  broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: eff });
  if (p.hp <= 0) {
    p.hp = p.maxHp;
    p.x = SPAWN.x;
    p.y = SPAWN.y;
    p.direction = SPAWN.dir || 0;
    p.frame = 0;
    p.pose = 'walk';
    npcSim.noteRespawn(playerId); // exempt this teleport from enemy door-warp follow
    broadcastAll({ type: 'player_respawn', id: playerId, x: p.x, y: p.y, dir: p.direction });
    broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
  }
}

// Server-authoritative NPC simulation: same world for every client.
const npcSim = createNpcSim(path.join(__dirname, '..', 'public', 'assets'));
npcSim.start(
  () => [...players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, level: p.level, hp: p.hp })),
  (data) => broadcastAll(data),
  (playerId, dmg) => damagePlayer(playerId, dmg)
);

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  for (const [id, ws] of players) {
    if (id !== excludeId && ws._socket && ws._socket.writable) {
      ws._ws.send(msg);
    }
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [, entry] of players) {
    if (entry._ws.readyState === 1) {
      entry._ws.send(msg);
    }
  }
}

// Recompute combat bonuses from equipped gear (weapon offense + armor defense);
// held sprite = equipped weapon. Mirror of vite.config.ts recomputeEquipStats.
const EQUIP_SLOTS = ['weapon', 'body', 'arms', 'other'];
function recomputeEquipStats(entry) {
  const w = entry.equipped.weapon;
  const we = w ? GOODS[w] && GOODS[w].equip : null;
  entry.weaponOffense = we && we.slot === 'weapon' ? (we.offense | 0) : 0;
  let def = 0;
  for (const s of ['body', 'arms', 'other']) {
    const id = entry.equipped[s];
    const e = id ? GOODS[id] && GOODS[id].equip : null;
    if (e && e.slot === s) def += (e.defense | 0);
  }
  entry.armorDefense = def;
  entry.itemId = entry.equipped.weapon;
}

wss.on('connection', (ws) => {
  const playerId = String(nextId++);
  console.log(`Player ${playerId} connected`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const playerData = {
          id: playerId,
          name: msg.name || `Player${playerId}`,
          spriteGroupId: msg.spriteGroupId || 1,
          // Pixel-edited sheet as a PNG data URL (~1-3KB); cap so a hostile
          // client can't make every join broadcast megabytes.
          appearance:
            typeof msg.appearance === 'string' && msg.appearance.length <= 65536
              ? msg.appearance
              : null,
          x: SPAWN.x,
          y: SPAWN.y,
          direction: SPAWN.dir || 0,
          frame: 0,
          pose: 'walk',
          itemId: null, // held item (equipped weapon's sprite), set by 'equip'
          // EarthBound equip slots (server-authoritative); offense/defense apply.
          equipped: { weapon: null, body: null, arms: null, other: null },
          weaponOffense: 0, // offense from the equipped weapon
          armorDefense: 0,  // total defense from equipped body/arms/other
          inventory: [...STARTING_INVENTORY], // Goods slots, mutated by 'use_item'
          money: STARTING_MONEY, // starting cash, shown in the menu
          hp: PLAYER_MAX_HP,
          maxHp: PLAYER_MAX_HP,
          level: clampLevel(msg.level), // entities carry a level (no flee AI yet)
          // PK (player-kill) flag — see npcSim canHurt. All players start
          // non-PK; a per-player toggle is backlogged (TODO).
          pk: false,
        };
        players.set(playerId, { ...playerData, _ws: ws });

        // Send the new player their ID and current players list
        const otherPlayers = [];
        for (const [id, p] of players) {
          if (id !== playerId) {
            const { _ws, ...data } = p;
            otherPlayers.push(data);
          }
        }
        ws.send(JSON.stringify({
          type: 'welcome',
          playerId,
          players: otherPlayers,
          npcs: npcSim.snapshot(),
          npcHps: npcSim.hpSnapshot(),
          inventory: inventoryView(playerData.inventory), // own Goods
          money: playerData.money,                        // own balance
        }));

        // Tell everyone else about the new player
        const { _ws, ...publicData } = players.get(playerId);
        broadcastAll({
          type: 'player_join',
          player: publicData,
        });
        break;
      }

      case 'move': {
        const entry = players.get(playerId);
        if (!entry) break;
        entry.x = msg.x;
        entry.y = msg.y;
        entry.direction = msg.direction;
        entry.frame = msg.frame;
        entry.pose = POSES.includes(msg.pose) ? msg.pose : 'walk';

        // Broadcast to all OTHER players
        const moveMsg = JSON.stringify({
          type: 'player_move',
          id: playerId,
          x: msg.x,
          y: msg.y,
          direction: msg.direction,
          frame: msg.frame,
          pose: entry.pose,
        });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) {
            p._ws.send(moveMsg);
          }
        }
        break;
      }

      case 'attack': {
        const entry = players.get(playerId);
        if (!entry) break;
        // Server-authoritative: resolve the swing from the player's tracked
        // position (not client-sent coords) so reach can't be spoofed.
        npcSim.handleAttack(
          entry.x, entry.y, msg.dir | 0, playerId,
          entry.offense + (entry.weaponOffense || 0), entry.pk
        );
        break;
      }

      case 'equip': {
        const entry = players.get(playerId);
        if (!entry) break;
        // Per-slot equip { slot, itemId|null }. Authoritative: equipping needs
        // the item owned + fitting that slot; null unequips. Recompute bonuses.
        const slot = typeof msg.slot === 'string' ? msg.slot : null;
        const itemId =
          typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
        if (!slot || !EQUIP_SLOTS.includes(slot)) break;
        if (itemId !== null) {
          const eq = GOODS[itemId] && GOODS[itemId].equip;
          if (!eq || eq.slot !== slot || !entry.inventory.includes(itemId)) break;
        }
        entry.equipped[slot] = itemId;
        recomputeEquipStats(entry);
        entry._ws.send(JSON.stringify({ type: 'equipped', slots: entry.equipped }));
        const equipMsg = JSON.stringify({ type: 'equip', id: playerId, itemId: entry.itemId });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) p._ws.send(equipMsg);
        }
        break;
      }

      case 'use_item': {
        const entry = players.get(playerId);
        if (!entry || entry.hp <= 0) break;
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
        const def = GOODS[itemId];
        const slot = entry.inventory.indexOf(itemId);
        // Must actually own a slot of a known item to consume it.
        if (!def || slot === -1) break;
        // Equippable gear is never consumed by "use" — it's equipped instead.
        if (def.equip) break;

        // Apply the effect. Cookie (and any future `heal` good) restores HP up
        // to the cap; broadcast so every client redraws this player's bar, and
        // tag `heal` so the user's own client can pop a green number.
        if (def.heal) {
          const healed = Math.min(entry.maxHp, entry.hp + def.heal) - entry.hp;
          entry.hp += healed;
          broadcastAll({
            type: 'player_hp',
            id: playerId,
            hp: entry.hp,
            maxHp: entry.maxHp,
            dmg: 0,
            heal: healed,
          });
        }

        // Consume the slot and send the owner their updated Goods list.
        entry.inventory.splice(slot, 1);
        entry._ws.send(JSON.stringify({
          type: 'inventory',
          items: inventoryView(entry.inventory),
        }));
        break;
      }

      case 'buy': {
        const entry = players.get(playerId);
        if (!entry) break;
        const store = msg.store | 0;
        const itemId = String(msg.item);
        const def = GOODS[itemId];
        // Validate: real item, actually stocked by that store (no off-list buys),
        // affordable, and room in the bag. Price comes from the catalog, never
        // the client, so it can't be spoofed.
        if (!def || !storeHas(store, itemId)) break;
        if (entry.inventory.length >= MAX_SLOTS) break;
        if (entry.money < def.cost) break;
        entry.money -= def.cost;
        entry.inventory.push(itemId);
        entry._ws.send(JSON.stringify({ type: 'inventory', items: inventoryView(entry.inventory) }));
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        break;
      }

      case 'sell': {
        const entry = players.get(playerId);
        if (!entry) break;
        const itemId = String(msg.item);
        const def = GOODS[itemId];
        const slot = entry.inventory.indexOf(itemId);
        // Must own a slot of a known item. EarthBound buys back at half price.
        if (!def || slot === -1) break;
        entry.inventory.splice(slot, 1);
        entry.money += Math.floor(def.cost / 2);
        entry._ws.send(JSON.stringify({ type: 'inventory', items: inventoryView(entry.inventory) }));
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        break;
      }

      case 'chat': {
        if (!players.has(playerId)) break;
        const text = String(msg.text || '').slice(0, 100).trim();
        if (!text) break;

        // Broadcast to everyone else; the sender shows its own bubble locally.
        const chatMsg = JSON.stringify({ type: 'chat', id: playerId, text });
        for (const [id, p] of players) {
          if (id !== playerId && p._ws.readyState === 1) {
            p._ws.send(chatMsg);
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    players.delete(playerId);
    broadcastAll({ type: 'player_leave', id: playerId });
  });
});

server.listen(PORT, () => {
  console.log(`EarthBound Online server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
