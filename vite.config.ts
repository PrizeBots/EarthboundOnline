import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { createNpcSim } from './server/npcSim.js';
import { loadShops } from './server/shops.js';

// --- Dev-only editor save channel (EDITOR_TOOLS.md "Save-Back Channel") ---
// Lives ONLY in the Vite dev server: not bundled, never on the deployed
// express/Render server, so editor writes cannot ship by construction.
// Writes go to public/overrides/ — OUR authored data layer applied on top of
// extraction — never to the generated asset files.
const OVERRIDES_DIR = path.resolve(__dirname, 'public', 'overrides');
const OVERRIDE_ALLOW = new Set([
  'npcs.json',
  'doors.json',
  'spawn.json',
  'collision.json',
  'dialogue.json',
  'sprites.json',
  'names.json',
  'enemy_spawns.json',
  'places.json',
  'car_traffic.json',
  'music.json',
  'item_sprites.json',
]);
const SAVE_BODY_LIMIT = 8 * 1024 * 1024; // sprite overrides carry data URLs

// Verifier registry for editor "Verify" buttons (EDITOR_TOOLS.md: surface the
// canonical py checkers inside the tools). Fixed commands only — the client
// sends a NAME, never arguments. Python path per CLAUDE.md (the `python`
// alias may hang).
const PYTHON = 'C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe';
const VERIFIERS: Record<string, string[]> = {
  rooms: [PYTHON, 'tools/debug_room_crop_check.py'],
  anchors: [PYTHON, 'tools/debug_person_anchor_stats.py'],
};
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

function editorSavePlugin() {
  return {
    name: 'editor-save-channel',
    apply: 'serve' as const, // dev server only — excluded from `vite build`
    configureServer(server: any) {
      server.middlewares.use('/__editor/save', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        let size = 0;
        req.on('data', (chunk: any) => {
          size += chunk.length;
          if (size > SAVE_BODY_LIMIT) {
            res.statusCode = 413;
            res.end('override too large');
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('end', () => {
          try {
            const { name, data } = JSON.parse(body);
            // Allow-list (not just sanitization): only known override files.
            if (typeof name !== 'string' || !OVERRIDE_ALLOW.has(name)) {
              res.statusCode = 400;
              res.end(`unknown override file '${name}'`);
              return;
            }
            fs.mkdirSync(OVERRIDES_DIR, { recursive: true });
            const file = path.join(OVERRIDES_DIR, name);
            if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
            // Atomic-ish write: temp file then rename, pretty-printed for
            // clean git diffs (key order is the client's responsibility).
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
            fs.renameSync(tmp, file);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file: `public/overrides/${name}` }));
            console.log(`[editor] saved override ${name}`);
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });

      // Run a registered verifier script and return its output.
      server.middlewares.use('/__editor/verify', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
          let name = '';
          try {
            name = JSON.parse(body).name;
          } catch {
            /* fall through to allow-list rejection */
          }
          const cmd = VERIFIERS[name];
          if (!cmd) {
            res.statusCode = 400;
            res.end(`unknown verifier '${name}'`);
            return;
          }
          console.log(`[editor] running verifier '${name}'...`);
          const { execFile } = require('child_process');
          execFile(
            cmd[0],
            cmd.slice(1),
            { cwd: __dirname, timeout: VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
            (err: any, stdout: string, stderr: string) => {
              const output = `${stdout}\n${stderr}`.trim().slice(-8000);
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: !err, output }));
              console.log(`[editor] verifier '${name}' ${err ? 'FAILED' : 'done'}`);
            }
          );
        });
      });
    },
  };
}

function gameServerPlugin() {
  const players = new Map<string, any>();
  let nextId = 1;

  const POSES = ['walk', 'climb', 'attack', 'hurt'];
  const PLAYER_MAX_HP = 60;

  // Server-authoritative goods registry + shop catalog, loaded from shops.json
  // (mirror of server/index.js; shared loader in server/shops.js). Each player's
  // inventory is an array of numeric-string item ids; effects + transactions
  // resolve here so a client can't grant itself HP or money.
  const { goods: GOODS, storeHas, startingInventory: STARTING_INVENTORY } = loadShops(
    path.resolve(__dirname, 'public', 'assets')
  ) as {
    goods: Record<string, { name: string; cost: number; heal: number }>;
    storeHas: (store: number, item: string) => boolean;
    startingInventory: string[];
  };
  const MAX_SLOTS = 14; // EarthBound's Goods menu holds 14 items per character
  const inventoryView = (inventory: string[]) =>
    inventory.filter((id) => GOODS[id]).map((id) => ({ id, name: GOODS[id].name }));

  // Money ($). Server-authoritative: granted on join, the sole authority on the
  // balance once shops/drops spend it. Mirror in server/index.js.
  const STARTING_MONEY = 1000;

  // PSI abilities (server-authoritative). `pp` is the cost; `heal` restores HP.
  // Lifeup α heal amount is a placeholder — set it to the exact EarthBound value
  // when confirmed. Mirror in server/index.js if that standalone server is used.
  const PSI: Record<string, { name: string; pp: number; heal?: number }> = {
    lifeup: { name: 'Lifeup α', pp: 3, heal: 30 },
  };

  // --- Player progression (server-authoritative; full stat growth) ---
  // Level-1 baseline mirrors StatusModal's defaults so the client's display
  // matches before the first server stats arrive. No persistence yet, so every
  // join starts at level 1 (a save system is a separate TODO).
  const BASE_STATS: Record<string, number> = {
    level: 1, hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, pp: 7, ppMax: 7, exp: 0,
    offense: 7, defense: 3, speed: 8, guts: 7, vitality: 6, iq: 9, luck: 9,
  };
  // Per-level stat gains (tunable). HP/maxHp, offense and defense are wired into
  // combat today; speed/guts/vitality/iq/luck grow and show on the Status screen
  // but aren't mechanically hooked up yet.
  const GROWTH: Record<string, number> = {
    maxHp: 8, ppMax: 2, offense: 2, defense: 1, speed: 1, guts: 1, vitality: 1, iq: 1, luck: 1,
  };
  // EXP to go from `level` to `level+1` (geometric ramp: 30, 45, 67, 101, …).
  const expCost = (level: number) => Math.floor(30 * Math.pow(1.5, level - 1));
  // Total EXP needed to REACH `level` from level 1.
  const expToReach = (level: number) => {
    let s = 0;
    for (let i = 1; i < level; i++) s += expCost(i);
    return s;
  };

  function newProgression(): Record<string, number> {
    const p = { ...BASE_STATS };
    p.expToNext = expCost(1); // EXP remaining to next level (display)
    return p;
  }

  function levelUp(p: any) {
    p.level++;
    for (const k of Object.keys(GROWTH)) p[k] += GROWTH[k];
    p.hp = p.maxHp; // a level-up fully heals
    p.pp = p.ppMax;
  }

  // StatusModal-shaped payload (field names match PlayerStats: hpMax/ppMax).
  function statsPayload(p: any) {
    return {
      level: p.level, hp: p.hp, hpMax: p.maxHp, pp: p.pp, ppMax: p.ppMax,
      exp: p.exp, expToNext: p.expToNext,
      offense: p.offense, defense: p.defense, speed: p.speed, guts: p.guts,
      vitality: p.vitality, iq: p.iq, luck: p.luck,
    };
  }

  // Award a kill's EXP, apply any level-ups, then push the new stats to that
  // player's client (server is authoritative). A level-up heals, so re-broadcast HP.
  function awardXp(playerId: string, xp: number) {
    const p = players.get(playerId);
    if (!p || xp <= 0) return;
    p.exp += xp;
    let leveled = false;
    while (p.exp >= expToReach(p.level + 1)) { levelUp(p); leveled = true; }
    p.expToNext = expToReach(p.level + 1) - p.exp;
    broadcastAll({ type: 'player_stats', id: playerId, stats: statsPayload(p), leveled, gained: xp });
    if (leveled) broadcastAll({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
  }

  // Spawn point: editor override wins over the src/spawn.json default.
  function readSpawn() {
    for (const rel of ['public/overrides/spawn.json', 'src/spawn.json']) {
      try {
        return JSON.parse(fs.readFileSync(path.resolve(__dirname, rel), 'utf8'));
      } catch {
        /* try next */
      }
    }
    return { x: 1296, y: 1168, dir: 0 };
  }
  const SPAWN = readSpawn();

  function broadcastAll(data: any) {
    const msg = JSON.stringify(data);
    for (const [, entry] of players) {
      if (entry._ws.readyState === 1) {
        entry._ws.send(msg);
      }
    }
  }

  // Apply an enemy's landed hit to a player (server-authoritative HP). Broadcast
  // the new HP so every client updates that player's bar; the victim's own
  // client plays the hurt pose. At 0 HP the player respawns at the spawn point.
  function damagePlayer(playerId: string, dmg: number) {
    const p = players.get(playerId);
    if (!p || p.hp <= 0) return;
    // Defense softens incoming hits (always at least 1 so leveling never makes
    // a player untouchable).
    const eff = Math.max(1, dmg - Math.floor((p.defense || 0) / 2));
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
  const npcSim = createNpcSim(path.resolve(__dirname, 'public', 'assets'));

  return {
    name: 'game-server',
    configureServer(server: any) {
      const wss = new WebSocketServer({ noServer: true });

      npcSim.start(
        () => [...players.values()].map((p: any) => ({ id: p.id, x: p.x, y: p.y, level: p.level, hp: p.hp })),
        (data: any) => broadcastAll(data),
        (playerId: string, dmg: number) => damagePlayer(playerId, dmg),
        (playerId: string, xp: number) => awardXp(playerId, xp)
      );

      server.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
        // Only handle /ws path, let Vite handle its own HMR websocket
        if (req.url === '/ws') {
          wss.handleUpgrade(req, socket, head, (ws: any) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      wss.on('connection', (ws: any) => {
        const playerId = String(nextId++);
        console.log(`Player ${playerId} connected`);

        ws.on('message', (raw: any) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }

          switch (msg.type) {
            case 'join': {
              const playerData = {
                id: playerId,
                name: msg.name || `Player${playerId}`,
                spriteGroupId: msg.spriteGroupId || 1,
                // Pixel-edited sheet as a PNG data URL (~1-3KB); cap so a
                // hostile client can't make every join broadcast megabytes.
                appearance:
                  typeof msg.appearance === 'string' && msg.appearance.length <= 65536
                    ? msg.appearance
                    : null,
                x: SPAWN.x, y: SPAWN.y,
                direction: SPAWN.dir || 0, frame: 0,
                pose: 'walk',
                itemId: null, // held item (equipped weapon's sprite), set by 'equip'
                weaponOffense: 0, // offense bonus from the equipped weapon (server-applied)
                inventory: [...STARTING_INVENTORY], // Goods slots, mutated by 'use_item'
                money: STARTING_MONEY, // starting cash, shown in the menu
                // PK (player-kill) flag — see npcSim canHurt. All players start
                // non-PK; a per-player toggle is backlogged (TODO). A PK player
                // can hurt anyone; anyone can hurt a PK player.
                pk: false,
                // Full server-authoritative progression (level/hp/exp/stats).
                ...newProgression(),
              };
              players.set(playerId, { ...playerData, _ws: ws });

              const otherPlayers: any[] = [];
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

              const { _ws, ...publicData } = players.get(playerId);
              for (const [id, p] of players) {
                if (id !== playerId && p._ws.readyState === 1) {
                  p._ws.send(JSON.stringify({ type: 'player_join', player: publicData }));
                }
              }
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

              const moveMsg = JSON.stringify({
                type: 'player_move', id: playerId,
                x: msg.x, y: msg.y, direction: msg.direction, frame: msg.frame,
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
              // Server-authoritative: resolve from the tracked position so reach
              // can't be spoofed. Damage scales with the player's Offense stat.
              npcSim.handleAttack(
                entry.x, entry.y, msg.dir | 0, playerId,
                entry.offense + (entry.weaponOffense || 0), entry.pk
              );
              break;
            }
            case 'equip': {
              const entry = players.get(playerId);
              if (!entry) break;
              // Item ids are short slugs; clients ignore unknown ids.
              entry.itemId =
                typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
              // Weapon offense is server-authoritative: it only counts if the
              // equipped item is a weapon the player actually owns (no spoofing
              // a strong weapon you don't have). Armor slots don't show a held
              // sprite, so the held item is always the (optional) weapon.
              const eq = entry.itemId ? GOODS[entry.itemId]?.equip : null;
              const owns = entry.itemId ? entry.inventory.includes(entry.itemId) : false;
              entry.weaponOffense = eq && eq.slot === 'weapon' && owns ? (eq.offense | 0) : 0;
              const equipMsg = JSON.stringify({
                type: 'equip', id: playerId, itemId: entry.itemId,
              });
              for (const [id, p] of players) {
                if (id !== playerId && p._ws.readyState === 1) {
                  p._ws.send(equipMsg);
                }
              }
              break;
            }
            case 'use_item': {
              const entry = players.get(playerId);
              if (!entry || entry.hp <= 0) break;
              const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
              const def = itemId ? GOODS[itemId] : null;
              const slot = entry.inventory.indexOf(itemId);
              // Must actually own a slot of a known item to consume it.
              if (!def || slot === -1) break;
              // Equippable gear is NOT a consumable — "using" a weapon/armor must
              // never destroy it. It's equipped via the 'equip' path instead.
              if (def.equip) break;

              // Cookie (and any future `heal` good) restores HP up to the cap;
              // broadcast so every client redraws the bar, tagging `heal` so the
              // owner's client pops a green number.
              if (def.heal) {
                const healed = Math.min(entry.maxHp, entry.hp + def.heal) - entry.hp;
                entry.hp += healed;
                broadcastAll({
                  type: 'player_hp', id: playerId,
                  hp: entry.hp, maxHp: entry.maxHp, dmg: 0, heal: healed,
                });
              }

              entry.inventory.splice(slot, 1);
              entry._ws.send(JSON.stringify({
                type: 'inventory', items: inventoryView(entry.inventory),
              }));
              break;
            }
            case 'buy': {
              const entry = players.get(playerId);
              if (!entry) break;
              const store = (msg.store as number) | 0;
              const itemId = String(msg.item);
              const def = GOODS[itemId];
              // Real item, stocked by that store, affordable, room in the bag.
              // Price is the catalog's, never the client's.
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
              if (!def || slot === -1) break; // must own a slot of a known item
              entry.inventory.splice(slot, 1);
              entry.money += Math.floor(def.cost / 2); // EB buys back at half price
              entry._ws.send(JSON.stringify({ type: 'inventory', items: inventoryView(entry.inventory) }));
              entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
              break;
            }
            case 'use_psi': {
              const entry = players.get(playerId);
              if (!entry || entry.hp <= 0) break;
              const psiId = typeof msg.psiId === 'string' ? msg.psiId : null;
              const def = psiId ? PSI[psiId] : null;
              if (!def || entry.pp < def.pp) break; // unknown ability or not enough PP
              entry.pp -= def.pp;
              if (def.heal) {
                const healed = Math.min(entry.maxHp, entry.hp + def.heal) - entry.hp;
                entry.hp += healed;
                broadcastAll({
                  type: 'player_hp', id: playerId,
                  hp: entry.hp, maxHp: entry.maxHp, dmg: 0, heal: healed,
                });
              }
              // PP changed — push updated stats so the caster's PSI bar redraws.
              broadcastAll({
                type: 'player_stats', id: playerId,
                stats: statsPayload(entry), leveled: false, gained: 0,
              });
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

      console.log('Game WebSocket server attached to Vite');
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [gameServerPlugin(), editorSavePlugin()],
  server: {
    port: 4444,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
