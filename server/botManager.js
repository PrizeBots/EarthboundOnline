/**
 * In-process bot fleet — simulated players for server load + (Phase 2) gameplay
 * tuning, controlled live from the `?netdebug` BOTS tab (see Network.ts) via the
 * dev-gated `bot` control message (gameHost `case 'bot'`).
 *
 * Each bot reuses the REAL connection path — `host.handleConnection(stub)` then a
 * normal `join` — but over a StubSocket instead of TCP. The server only ever
 * touches a tiny ws surface (.send / .close / .terminate / .readyState===1 /
 * .on('message'|'close')); the stub implements exactly that and its send() tallies
 * bytes then DISCARDS. So we exercise the full encode + AOI + broadcast path
 * (realistic CPU/egress) with zero TCP overhead — cheaper than real loopback
 * sockets (server/measure_net.js), so it scales to thousands.
 *
 * Bots ACT only through the normal message handlers (input/attack/chat/use_psi/
 * use_item), so movement and combat stay server-authoritative — nothing is cheated.
 * Bot POSITION is read straight from the authoritative entry (host.players) rather
 * than parsing a wire feed the stub throws away.
 *
 * Two behaviors (set per spawn): 'wander' lifts the proven roam from server/
 * loadtest.js (blind timed swings, pure load/egress realism); 'play' seeks the
 * nearest enemy, closes to melee, swings, fires offense PSI from range, and quaffs a
 * heal item when low (see _playStep). Metrics (kills/deaths/TTK) are still TODO.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { STAT_KEYS, ALLOC_POINTS } = require('./charStats');

// Progression knobs — KEEP IN SYNC with server/gameHost.js (POINTS_PER_LEVEL,
// STAT_SPEND_MAX). Bots build a random level + allocation locally, then hand it to
// host.applyBuild() which derives the authoritative stats, so a drift here only
// affects how bots ROLL a build, never how the server values it.
const MAX_LEVEL = 100; // current level cap
const POINTS_PER_LEVEL = 1; // skill points earned per level
const STAT_SPEND_MAX = 99; // per-stat hard cap

const MAX_BOTS = parseInt(process.env.MAX_BOTS, 10) || 5000; // runaway backstop
// One input per ~60Hz frame — the SAME cadence as the real fixed-timestep client
// (Game.ts sends one input per movement frame). The server credits ~2 steps per
// 33ms tick, so anything slower than this (the old 50ms/20Hz) starves the step
// budget and the bot walks at a fraction of normal speed — which read as "stacked
// and not moving" when a pile of them sat on the single spawn point.
const MOVE_MS = 16;
const SPREAD = 2000; // fan-out dispersal radius target (px)
// Golden angle — spreads successive bots' headings evenly around the circle so the
// fleet disperses from the spawn point in all directions instead of in 8 clumps.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const STUCK_TICKS = 8; // tried-to-move-but-didn't ticks (~130ms) before turning
// Per-bot action cadence (ticks @ 60Hz). Each bot rolls its OWN next-action tick in
// these ranges so the fleet doesn't attack/chat in lockstep (which looked like one
// synchronized pulse). Chat is deliberately sparse to avoid flooding the channel.
const ATTACK_MIN = 120; // ~2s
const ATTACK_JITTER = 300; // → 2–7s between swings
const CHAT_MIN = 1200; // ~20s
const CHAT_JITTER = 2400; // → 20–60s between lines

// Phase-2 ('play') combat tuning (ticks @ 60Hz / px). Bots seek the nearest enemy,
// close to melee, swing, and fire PSI / quaff a heal item when it makes sense. The
// server still gates everything (stamina, PP, cooldown, Mental unlock), so these are
// just how OFTEN a bot TRIES — the authoritative rate is whatever the sim allows.
const ENGAGE_RANGE = 480; // only chase an enemy within this many px (else roam)
const RETARGET_CD = 12; // re-pick nearest enemy every ~0.2s (cheap, but not per-tick)
const MELEE_REACH = 26; // close enough to swing (px)
const MELEE_CD = 36; // ~0.6s between attempted swings (server cooldown is the real cap)
const PSI_RANGE = 220; // try offense PSI when the target is within this (px)
const PSI_CD = 150; // ~2.5s between PSI attempts
const LOW_HP = 0.4; // quaff a heal item below this fraction of max HP
const HEAL_CD = 90; // ~1.5s between heal attempts (also throttles the bag rescan)

// Roll a random level + a valid allocation: base 1 in each stat, then scatter the
// creation points (ALLOC_POINTS) plus one-per-level skill points randomly across the
// 5 stats, each capped at STAT_SPEND_MAX. Mirrors what a real player of that level
// could have built.
function randomBuild() {
  const level = 1 + Math.floor(Math.random() * MAX_LEVEL); // 1..MAX_LEVEL
  const alloc = {};
  for (const k of STAT_KEYS) alloc[k] = 1; // STAT_MIN base
  let points = ALLOC_POINTS + (level - 1) * POINTS_PER_LEVEL;
  while (points > 0) {
    if (STAT_KEYS.every((k) => alloc[k] >= STAT_SPEND_MAX)) break; // everything maxed
    const k = STAT_KEYS[Math.floor(Math.random() * STAT_KEYS.length)];
    if (alloc[k] < STAT_SPEND_MAX) {
      alloc[k]++;
      points--;
    }
  }
  return { level, alloc };
}

/** A null-sink socket: looks like a `ws` to GameHost, sends nothing on the wire. */
class StubSocket extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // handleConnection adds message+close; status pushes none
    this.readyState = 1; // OPEN — the server gates every send on `=== 1`
    this.bytes = 0; // cumulative egress to this bot (for the egress readout)
  }
  send(data) {
    this.bytes +=
      typeof data === 'string'
        ? Buffer.byteLength(data)
        : data && (data.byteLength || data.length)
          ? data.byteLength || data.length
          : 0;
  }
  close() {
    if (this.readyState === 1) {
      this.readyState = 3; // CLOSED
      this.emit('close');
    }
  }
  terminate() {
    this.close();
  }
}

// 8-direction unit vector for a heading angle (server input dx/dy ∈ {-1,0,1}).
function headingToStep(theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dx = Math.abs(c) < 0.38 ? 0 : Math.sign(c);
  const dy = Math.abs(s) < 0.38 ? 0 : Math.sign(s);
  return dx === 0 && dy === 0 ? [Math.sign(c) || 1, 0] : [dx, dy];
}

class BotFleet {
  constructor(host) {
    this.host = host;
    this.bots = []; // { idx, stub, playerId, seq, dir, ticks, heading, attackAt, chatAt }
    this.behavior = 'wander';
    this._spawned = 0; // monotonic — names + headings stay unique across despawns
    this._driveTimer = null;
    this._sampleTimer = null;
    this._egressMbPerSec = 0;
    this._roster = null; // cached char-select sprite-group roster (lazy)
  }

  get count() {
    return this.bots.length;
  }

  // The curated char-select roster (public/assets/sprites/characters.json) — the
  // SAME list the player browses on the char-select screen. Bots pick from it so a
  // fleet looks like a crowd of real, varied characters instead of 8 repeats. Falls
  // back to sprite groups 1–8 if the file is missing.
  roster() {
    if (this._roster) return this._roster;
    try {
      const file = path.join(this.host._assetsDir, 'sprites', 'characters.json');
      const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
      this._roster = Array.isArray(ids) && ids.length ? ids : null;
    } catch {
      this._roster = null;
    }
    if (!this._roster) this._roster = [1, 2, 3, 4, 5, 6, 7, 8];
    return this._roster;
  }

  /** Add up to `want` bots (clamped to MAX_BOTS). `opts.behavior` sets the mode. */
  spawn(want, opts = {}) {
    if (opts.behavior === 'wander' || opts.behavior === 'play') this.behavior = opts.behavior;
    const room = MAX_BOTS - this.bots.length;
    const n = Math.max(0, Math.min(want | 0, room));
    const roster = this.roster();
    for (let i = 0; i < n; i++) {
      const idx = this._spawned++;
      const stub = new StubSocket();
      // handleConnection assigns playerId = String(nextId++) synchronously, so the
      // id is nextId's value *before* the call.
      const playerId = String(this.host.nextId);
      this.host.handleConnection(stub);
      // Anon join (no auth) — the same path loadtest.js / measure_net.js use. The
      // entry lands in host.players synchronously (no await before the set). Pick a
      // random character from the real char-select roster for variety.
      const spriteGroupId = roster[Math.floor(Math.random() * roster.length)];
      stub.emit('message', JSON.stringify({ type: 'join', name: `Bot${idx}`, spriteGroupId }));
      // Give the bot a random level + allocation (server derives the authoritative
      // stats), exactly as if a real player of that level had joined.
      const { level, alloc } = randomBuild();
      this.host.applyBuild(playerId, level, alloc);
      this.bots.push({
        idx,
        stub,
        playerId,
        seq: 1,
        dir: 0,
        ticks: 0,
        heading: idx * GOLDEN, // even fan-out around the spawn point (no 8-way clumps)
        // Stagger first action so the fleet never attacks/chats on the same tick.
        attackAt: Math.floor(Math.random() * (ATTACK_MIN + ATTACK_JITTER)),
        chatAt: Math.floor(Math.random() * (CHAT_MIN + CHAT_JITTER)),
      });
    }
    this._ensureTimers();
    return this.count;
  }

  /** Remove up to `want` bots (LIFO). Closing the stub runs the normal cleanup. */
  despawn(want) {
    const n = Math.max(0, Math.min(want | 0, this.bots.length));
    for (let i = 0; i < n; i++) {
      const b = this.bots.pop();
      try {
        b.stub.close(); // → host 'close' handler: removes the player, AOI, etc.
      } catch {
        /* already gone */
      }
    }
    if (!this.bots.length) this._stopTimers();
    return this.count;
  }

  /** Remove every bot. */
  stop() {
    return this.despawn(this.bots.length);
  }

  /** Snapshot for the BOTS-tab readout. No side effects (does NOT touch the
   *  server's netStats() accumulator — that belongs to the NET_DEBUG logger). */
  stats() {
    return {
      count: this.count,
      behavior: this.behavior,
      players: this.host.players.size,
      egressMbPerSec: this._egressMbPerSec,
      maxBots: MAX_BOTS,
    };
  }

  _ensureTimers() {
    if (!this._driveTimer) this._driveTimer = setInterval(() => this._drive(), MOVE_MS);
    if (!this._sampleTimer) {
      this._sampleAt = Date.now();
      this._sampleBytes = this._totalBytes();
      this._sampleTimer = setInterval(() => this._sample(), 1000);
    }
  }

  _stopTimers() {
    if (this._driveTimer) clearInterval(this._driveTimer);
    if (this._sampleTimer) clearInterval(this._sampleTimer);
    this._driveTimer = this._sampleTimer = null;
    this._egressMbPerSec = 0;
  }

  _totalBytes() {
    let b = 0;
    for (const x of this.bots) b += x.stub.bytes;
    return b;
  }

  // Per-second egress sampler — bot DOWNLINK (server→bots), independent of the
  // server's own netStats() window so the two don't steal each other's counts.
  _sample() {
    const now = Date.now();
    const bytes = this._totalBytes();
    const dt = Math.max(0.001, (now - this._sampleAt) / 1000);
    this._egressMbPerSec = +((bytes - this._sampleBytes) / 1048576 / dt).toFixed(2);
    this._sampleAt = now;
    this._sampleBytes = bytes;
  }

  // One shared driver tick for the whole fleet (cheaper than N intervals).
  _drive() {
    const spawn = this.host.SPAWN;
    for (const b of this.bots) {
      if (b.stub.readyState !== 1) continue;
      const entry = this.host.players.get(b.playerId);
      if (!entry) continue; // join still in flight / evicted
      b.ticks++;
      // KO'd: a downed / bleeding-out player can't act — a real client suppresses
      // input here, so the bot does too (the server now freezes them either way).
      // Reset the wander baseline so it doesn't count the KO as "stuck" on revive.
      if (entry.dying || entry.downed) {
        b.prevX = entry.x;
        b.prevY = entry.y;
        continue;
      }
      const playing = this.behavior === 'play';
      const [dx, dy] = playing ? this._playStep(b, entry) : this._wanderStep(b, entry, spawn);
      if (dx || dy) b.dir = ((Math.atan2(dy, dx) / (Math.PI / 4) + 8) | 0) % 8;
      this._send(b, { type: 'input', seq: b.seq++, dx, dy });
      // Wander: blind timed swings (exercises the attack broadcast path under load).
      // Play mode drives its OWN targeted attack/PSI/heal inside _playStep, so the
      // generic timer is skipped there to avoid double-firing.
      if (!playing && b.ticks >= b.attackAt) {
        this._send(b, { type: 'attack', dir: b.dir });
        b.attackAt = b.ticks + ATTACK_MIN + Math.floor(Math.random() * ATTACK_JITTER);
      }
      if (b.ticks >= b.chatAt) {
        this._send(b, { type: 'chat', text: `bot ${b.idx} reporting` });
        b.chatAt = b.ticks + CHAT_MIN + Math.floor(Math.random() * CHAT_JITTER);
      }
    }
  }

  // Stateful wander: walk along a heading and TURN when we stop making progress
  // (blocked by a wall) or after a random interval — so bots roam the world instead
  // of marching into the first wall and freezing. Position is authoritative (read
  // straight from the entry the server steps), so "did I actually move?" is exact.
  _wanderStep(b, entry, spawn) {
    if (b.prevX === undefined) {
      b.prevX = entry.x;
      b.prevY = entry.y;
      b.stuck = 0;
      b.sinceTurn = 0;
      b.turnEvery = this._turnEvery();
      b.movedIntent = false;
    }
    const moved = Math.hypot(entry.x - b.prevX, entry.y - b.prevY);
    b.prevX = entry.x;
    b.prevY = entry.y;
    b.sinceTurn++;
    // Tried to move last tick but barely did ⇒ we're up against a wall.
    if (b.movedIntent && moved < 0.3) b.stuck++;
    else b.stuck = 0;

    const tooFar = Math.hypot(entry.x - spawn.x, entry.y - spawn.y) > SPREAD;
    if (b.stuck >= STUCK_TICKS || b.sinceTurn >= b.turnEvery || tooFar) {
      if (tooFar) {
        // Drifted too far — steer back toward spawn (± a wide jitter) so the fleet
        // stays in populated areas instead of wandering off into the void.
        b.heading = Math.atan2(spawn.y - entry.y, spawn.x - entry.x) + (Math.random() - 0.5);
      } else if (b.stuck >= STUCK_TICKS) {
        // Blocked: turn hard (90°–270°) so the new heading leaves the wall.
        b.heading += Math.PI / 2 + Math.random() * Math.PI;
      } else {
        // Natural roam: pick a fresh random heading every few seconds.
        b.heading = Math.random() * Math.PI * 2;
      }
      b.stuck = 0;
      b.sinceTurn = 0;
      b.turnEvery = this._turnEvery();
    }
    const step = headingToStep(b.heading);
    b.movedIntent = step[0] !== 0 || step[1] !== 0;
    return step;
  }

  _turnEvery() {
    return 120 + Math.floor(Math.random() * 240); // 2–6s between voluntary turns @ 60Hz
  }

  // Phase 2: seek the nearest enemy, close to melee, swing, fire PSI from range, and
  // quaff a heal item when low. Combat sends (attack/use_psi/use_item) happen HERE so
  // they're aimed at the target — the generic blind-swing timer in _drive is skipped
  // in play mode. Returns the movement step; _drive sends the 'input' from it.
  // When there's no enemy in range it falls back to wander, so a 'play' fleet still
  // roams toward populated areas instead of standing idle.
  // TODO: accumulate kills/deaths/TTK metrics for the BOTS tab (needs server-side
  // damage attribution back to the bot's playerId — not wired yet).
  _playStep(b, entry) {
    if (b.combatInit === undefined) {
      b.combatInit = true;
      b.target = null; // cached {id,x,y,hp} of the enemy we're chasing
      b.retargetAt = 0; // tick to re-acquire the nearest enemy
      b.atkAt = 0; // next allowed melee attempt
      b.psiAt = Math.floor(Math.random() * PSI_CD); // stagger first PSI across the fleet
      b.healAt = 0; // next heal attempt / bag rescan
      b.psiId = this._pickPsi(entry); // strongest offense PSI this build can cast (or null)
    }

    // Emergency heal: low HP and a healing consumable in the bag. Throttled so a bot
    // that has no heal item doesn't rescan its inventory every tick.
    if (entry.maxHp > 0 && entry.hp / entry.maxHp <= LOW_HP && b.ticks >= b.healAt) {
      const itemId = this._findHealItem(entry);
      if (itemId) this._send(b, { type: 'use_item', itemId });
      b.healAt = b.ticks + HEAL_CD;
    }

    // (Re)acquire the nearest live enemy in range. Cheap single-object query, but we
    // still only poll it a few times a second per bot.
    if (!b.target || b.ticks >= b.retargetAt) {
      b.target = this.host.npcSim.nearestEnemy(entry.x, entry.y, ENGAGE_RANGE);
      b.retargetAt = b.ticks + RETARGET_CD;
    }
    const t = b.target;
    if (!t) return this._wanderStep(b, entry, this.host.SPAWN); // nobody to fight → roam

    const ddx = t.x - entry.x;
    const ddy = t.y - entry.y;
    const dist = Math.hypot(ddx, ddy) || 1;
    b.dir = ((Math.atan2(ddy, ddx) / (Math.PI / 4) + 8) | 0) % 8; // face the target
    const aimx = ddx / dist;
    const aimy = ddy / dist;

    // Offense PSI from a distance (server owns target selection + the Mental/PP gate).
    if (b.psiId && dist <= PSI_RANGE && b.ticks >= b.psiAt) {
      const def = this.host.PSI[b.psiId];
      if (def && entry.pp >= def.pp) {
        this._send(b, { type: 'use_psi', psiId: b.psiId, dir: b.dir, aimx, aimy });
        b.psiAt = b.ticks + PSI_CD;
      }
    }

    // In melee range: hold position and swing. Otherwise step toward the target.
    if (dist <= MELEE_REACH) {
      if (b.ticks >= b.atkAt) {
        this._send(b, { type: 'attack', dir: b.dir, aimx, aimy });
        b.atkAt = b.ticks + MELEE_CD;
      }
      return [0, 0];
    }
    return headingToStep(Math.atan2(ddy, ddx));
  }

  // Pick the strongest OFFENSE PSI this build has unlocked, or null. Mirrors gameHost
  // mentalLevelOf/psiUnlocked (Mental = round((ppMax-2)/2); unlocked at Mental >=
  // unlockMental) — KEEP IN SYNC. Anon bots have no dev role, so no bypass. Among the
  // unlocked offense moves it favors the highest unlock tier the bot can afford by PP.
  _pickPsi(entry) {
    const psi = this.host.PSI;
    if (!psi) return null;
    const mental = Math.max(0, Math.round((((entry && entry.ppMax) || 0) - 2) / 2));
    let bestId = null;
    let bestTier = -1;
    for (const id of Object.keys(psi)) {
      const def = psi[id];
      if (!def || !(def.damage > 0)) continue; // offense only
      if (def.heal || def.cures || def.reviveFrac) continue; // skip support moves
      const tier = def.unlockMental || 1;
      if (mental < tier) continue; // not learned
      if ((def.pp || 0) > ((entry && entry.ppMax) || 0)) continue; // can never afford a full cast
      if (tier > bestTier) {
        bestTier = tier;
        bestId = id;
      }
    }
    return bestId;
  }

  // First non-equip healing consumable in the bag (GOODS def with heal > 0), or null.
  _findHealItem(entry) {
    const goods = this.host.GOODS;
    if (!goods || !entry.inventory) return null;
    for (const id of entry.inventory) {
      const g = goods[id];
      if (g && !g.equip && g.heal > 0) return id;
    }
    return null;
  }

  _send(b, obj) {
    b.stub.emit('message', JSON.stringify(obj)); // drives the real message handler
  }
}

module.exports = { BotFleet, StubSocket, MAX_BOTS };
