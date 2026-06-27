/**
 * GameHost — the single source of truth for multiplayer host logic.
 *
 * Both the standalone deploy server (server/index.js) and the Vite-embedded dev
 * server (vite.config.ts) used to carry their own copy of this switch, and the
 * two had already DRIFTED apart (the standalone server was missing progression,
 * PSI, and the awardXp wiring). This class is the de-duplicated host: each
 * transport just constructs a GameHost, calls start(), and hands every new
 * socket to handleConnection(ws). The socket only has to look like a `ws`
 * WebSocket — `.send(str)`, `.readyState`, `.on('message')`, `.on('close')` —
 * which is true for both the standalone `WebSocketServer({ server })` and the
 * Vite `noServer` upgrade path.
 *
 * Server-authoritative by construction: the client only ever ASKS (use/buy/sell/
 * equip/attack), and every effect is validated here against GOODS/STORES and the
 * player's tracked state, so a client can't grant itself HP, money, or reach.
 */
const fs = require('fs');
const path = require('path');
const { createNpcSim } = require('./npcSim');
const { SpatialGrid } = require('./aoi');
const wire = require('./wire'); // binary codec for the position firehose (§5)
const { createEventRuntime } = require('./eventRuntime');
const { loadShops } = require('./shops');
const {
  sanitizeBuild,
  deriveCombatStats,
  STAT_KEYS,
  defaultAlloc,
  POINTS_PER_LEVEL,
  STAT_SPEND_MAX,
} = require('./charStats');
const status = require('./status'); // EB status-condition engine (shared with npcSim)
const prof = require('./simProfile'); // per-phase tick profiler (PROFILE_SIM=1; no-op when off)
const buffs = require('./buffs'); // temporary timed stat boosts (consumables / future PSI)

const POSES = ['walk', 'climb', 'attack', 'hurt'];
const MAX_SLOTS = 14; // EarthBound's Goods menu holds 14 items per character
// EarthBound's ATM (cash machine) sprite groups. KEEP IN SYNC with
// src/engine/NPC.ts ATM_SPRITE_GROUPS — the server uses these to know which
// static NPCs are ATMs for withdraw/deposit proximity gating.
const ATM_SPRITE_GROUPS = new Set([259, 447]);

// --- Server-authoritative player movement (input-driven sim) ---
// The client sends INPUTS (held direction + a sequence number); the server
// simulates the actual movement and owns the position. These MUST mirror
// src/engine/Player.ts (moveSpeedFor + COL_* + the per-frame step) so the
// client's local prediction matches the server's result with no drift.
const PLAYER_COL_W = 14;
const PLAYER_COL_H = 8;
const PLAYER_COL_OY = -8;
const SPEED_BASE = 0.8; // KEEP IN SYNC with src/engine/Player.ts
const SPEED_PER_STAT = 0.085;
const SPEED_MIN = 0.75;
const SPEED_MAX = 2.6;
function moveSpeedFor(speedStat) {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, SPEED_BASE + (speedStat || 0) * SPEED_PER_STAT));
}
const SQRT1_2 = Math.SQRT1_2;
const ANIM_INTERVAL = 8; // frames between walk-cycle toggles (mirror Entity.ts)
const SIM_TICK_MS = 33; // ~30Hz player-movement sim. Briefly ran at 16ms/60Hz this
// session, but doubling the player sim + the NPC broadcast starved the prod event
// loop (enemies, which step per-tick with no dt scaling, visibly slowed). Back to
// 30Hz: the player step budget is wall-clock based either way, so this only changes
// CPU load, not travel speed or fairness.
const MAX_INPUT_QUEUE = 240; // ~4s of 60fps inputs — drop overflow (anti-flood)
// Speed authority (anti-speedhack / frame-rate fairness): one movement STEP is
// one 60Hz frame of motion, so the sim applies at most this many steps per tick
// regardless of how many inputs a client sends. A 120Hz display, or a client
// flooding inputs, can't move faster than real time — the server, paced by the
// fixed SIM_TICK_MS interval, is the sole authority on travel-per-second.
const SIM_FRAME_MS = 1000 / 60; // wall-clock duration of one movement step
// Nominal steps an on-time tick earns: SIM_TICK_MS / SIM_FRAME_MS ≈ 2 @ 33ms.
// The actual per-tick budget is time-based (see _simPlayers); this is the baseline.
const NOMINAL_STEPS_PER_TICK = SIM_TICK_MS / SIM_FRAME_MS; // ≈ 2.0
// Catch-up ceiling for the time-based step budget (see _simPlayers). A late tick
// (timer slip / GC / busy prod CPU) earns extra steps so an honest 60Hz input
// stream still drains in real time — but never more than this per tick, so a
// resumed stall can't fling a player across the map and a flooding client still
// can't out-run the wall clock. 3x a nominal tick (~100ms of motion) is enough to
// absorb timer jitter while bounding a single catch-up burst.
const MAX_STEPS_BURST = Math.max(2, Math.round(NOMINAL_STEPS_PER_TICK * 3)); // = 6 @ 33ms
// Run (hold-Shift) + stamina economy. KEEP IN SYNC with src/engine/Player.ts.
// Running multiplies the Speed-derived walk speed and burns stamina; an attack
// costs a fixed chunk (gated like PP). Stamina pool/regen come from stats
// (deriveCombatStats: Spirit→max, Muscle→regen).
const RUN_MULT = 1.4; // run speed = walk speed * this (while you can run)
const RUN_DRAIN_PER_STEP = 24 / 60; // stamina drained per 60Hz movement step
const STAMINA_ATTACK_COST = 8; // stamina per swing (not enough = can't attack)
// "Winded" latch: hitting 0 stamina while running locks OUT running until it
// recharges to this fraction of max. Without it, per-tick regen tops stamina just
// above 0 every step, so `stamina > 0` keeps passing and you sprint forever.
const RUN_RECOVER_FRAC = 0.2;

// Passive PP regen (ABILITIES.md §7). The per-second rate is the build's `ppRegen`
// (Mental + Spirit, deriveCombatStats). It's throttled to a fraction for a short
// window after casting or taking a hit, so PSI still "runs dry" mid-fight (preserves
// the Mental-lane burst identity) and refills you BETWEEN fights. Magnet + items
// remain the active/clutch restores.
const PP_COMBAT_WINDOW_MS = 4000; // "in combat" = a cast or a hit within this window
const PP_COMBAT_FRAC = 0.35; // regen-rate multiplier while in combat (vs out of it)

// Area-of-interest fan-out (NETWORK_REMODEL.md §4). ON by default now (built +
// validated: smoke:net 7/7, ~9.4x bandwidth). Set AOI_ENABLED=0 to fall back to
// the legacy global broadcast. The spatial grid is always maintained.
const AOI_ENABLED = process.env.AOI_ENABLED !== '0';
const NET_DEBUG = process.env.NET_DEBUG === '1';
// In-process bot fleet (server/botManager.js), driven from the ?netdebug BOTS tab.
// The `bot` control message is gated on dev/admin role; BOTS_ENABLED=1 also opens
// it for anonymous LOCAL dev (where everyone is role 'player'). Off in prod by
// default → anon clients opening ?netdebug can't spawn bots.
const BOTS_ENABLED = process.env.BOTS_ENABLED === '1';
const { BotFleet } = require('./botManager');
// Single monotonic server clock (ms), shared by the firehose frame timestamp and
// the pong's `srv` field. The client maps server send-times onto its own clock via
// the ping/pong offset and buffers snapshots on the SERVER-time axis, so arrival
// jitter no longer warps remote playback. performance.now() is ms-since-start; the
// uint32 wire field wraps after ~49 days of uptime — harmless (the offset re-syncs).
const { performance: perfHooks } = require('perf_hooks');
const srvNow = () => Math.round(perfHooks.now());
// WebRTC unreliable DataChannel for the firehose (Stage D). Auto-ON in dev
// (NODE_ENV !== 'production') so we dogfood it every session; OFF in prod because
// Render has no inbound UDP (clients would just fall back to WS) — re-enable with
// RTC_ENABLED=1 once the firehose terminates on a UDP-capable host (the gateway
// tier). Falls back to WS per-frame whenever a peer's channel isn't open.
const RTC_ENABLED = process.env.RTC_ENABLED === '1' || process.env.NODE_ENV !== 'production';
const rtc = require('./rtc');
// Binary + delta wire format for the position firehose (§5). ON by default now;
// set BINARY_WIRE=0 to fall back to JSON. Independent of AOI.
const BINARY_WIRE = process.env.BINARY_WIRE !== '0';
// Per-client crowd cap (§4.6): max NPC position rows shipped to one client per
// tick. Beyond it, nearest-first wins and the remainder rides as an `over` count.
const AOI_MAX_NPCS = parseInt(process.env.AOI_MAX_NPCS, 10) || 120;
// Lag compensation (NETWORK_REMODEL.md, combat pillar): when a player swings,
// rewind enemies to where the attacker SAW them and test the hitbox there, so a
// fleeing target you aimed at still gets hit. Rewind = NPC interp delay + the
// player's measured RTT. ON by default; LAG_COMP=0 tests against live positions.
const LAG_COMP = process.env.LAG_COMP !== '0';
// How far in the past the client renders enemies (NPCManager npcInterp(100)).
// Keep in sync with the client; the per-player RTT is added on top per swing.
const NPC_INTERP_MS = 100;
// Per-client cap on visible PLAYERS, with a rank-hysteresis buffer so a peer
// hovering at the cap boundary doesn't flap spawn/despawn. A periodic relevance
// pass re-ranks each player's neighbourhood so a stationary player in a shifting
// crowd stays current (movement-triggered refresh only covers the mover).
const AOI_MAX_PLAYERS = parseInt(process.env.AOI_MAX_PLAYERS, 10) || 120;
const AOI_PLAYER_HYST = parseInt(process.env.AOI_PLAYER_HYST, 10) || 20;
const REL_TICK_MS = 250; // 4Hz crowd re-rank pass

// Direction enum (src/types.ts) from an input vector — mirror Player.dirFromInput.
function dirFromInput(dx, dy) {
  if (dx === 0 && dy < 0) return 1; // N
  if (dx === 0 && dy > 0) return 0; // S
  if (dx < 0 && dy === 0) return 2; // W
  if (dx > 0 && dy === 0) return 3; // E
  if (dx < 0 && dy < 0) return 4; // NW
  if (dx > 0 && dy < 0) return 7; // NE
  if (dx < 0 && dy > 0) return 5; // SW
  return 6; // SE
}
// How close (px, Euclidean to the interactable's anchor) a player must be to
// transact at a shop clerk / ATM. Generous on purpose: the client already did
// the precise facing+counter-depth check (tryTalk REACH_FORWARD 60 + lateral),
// so this just stops transacting from across the map. False-rejecting a legit
// player is worse than a slightly roomy radius.
const INTERACT_REACH = 80;
// Present boxes: each ROM gift's Event Flag maps to a PRIVATE per-player flag at
// this base, so every player can open each gift exactly once. KEEP IN SYNC with
// src/engine/Gifts.ts GIFT_FLAG_BASE.
const GIFT_FLAG_BASE = 910000;
// Canon EarthBound flavor text shown when a player checks a container that has
// nothing to give (an "empty"/special gift — no resolvable item). Keyed by the
// container's sprite group so a trash can reads like a trash can. Mirrors the
// ROM opener script (eb_project/ccscript/data_33.ccs).
function emptyContainerText(sprite) {
  switch (sprite) {
    case 214:
      return "There was just plain ol' garbage in the trash can.";
    case 195:
      return 'But the present was empty.';
    default:
      return 'But it was empty.';
  }
}
// Ness's mom (sprite 145) cooks the player's favorite food on request: heals a
// fixed amount, then won't cook again until the wall-clock cooldown elapses. The
// ready-at timestamp persists in the save, so relogging can't reset the timer.
const MOM_FOOD_HEAL = 50; // HP restored per home-cooked meal
const MOM_FOOD_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between meals
// Quick-select hotbar: 6 slots (keys 1-6), each holding a weapon, a usable item,
// or a PSI move tagged 'psi:<id>'. Persisted per character so an assigned PSI
// (which, unlike a weapon, can't be re-derived from the equip set) survives a
// relog. KEEP IN SYNC with the client (menu/layout HOTBAR_SLOTS + PSI_TAG). An
// old save's shorter array is padded with nulls on load (sanitize fixes length).
const HOTBAR_SLOTS = 6;
const HOTBAR_PSI_TAG = 'psi:';
const BAG_FULL_NOTICE_MS = 2500; // min gap between "bag full" popups (anti-spam)
const STARTING_MONEY = 0; // every player joins with no money
const DEATH_CASH_PCT = 0.5; // fraction of ON-HAND cash dropped on death (bank is safe)
const DEATH_CASH_ITEM = 'c001'; // custom "cash" item the dropped money renders as
const DEATH_CASH_MAX_OBJECTS = 20; // cap on cash objects per death (each worth ≥ $1)
// KO/downed window: HP→0 lays the player out for this long instead of dying. During
// it, allies can revive them; the cash-drop penalty is DEFERRED to true death, so a
// revived player loses nothing. Elapsing it (or "giving up the ghost") = true death.
const DOWNED_MS = 30000;
// EB "rolling HP" / Mortal Damage: a lethal hit doesn't drop you instantly — the
// HP meter ROLLS to zero over a few seconds and you can heal to survive before it
// lands (use_item/use_psi while `dying`). MORTAL_DRAIN_FULL_MS is how long a FULL
// bar takes to roll to 0; the actual roll scales by how much HP you had, so a hit
// from high HP gives a long window and from low HP a short one. Keep this in sync
// with the client's HealthRoll drain feel. MORTAL_BANNER_MS = only roll windows
// at least this long announce "MORTAL DAMAGE!" (shorter ones just drop fast).
const MORTAL_DRAIN_FULL_MS = 4000;
const MORTAL_BANNER_MS = 2000;
const MORTAL_MIN_MS = 350; // floor so even a near-dead hit rolls a touch, not snap
// How close (px) an ally must be to a downed friend to revive them (item or PSI).
const REVIVE_RANGE = 44;
// Range (px) within which support PSI (Lifeup/Healing) may target an ally; revive
// PSI is ranged, so it's more generous than the hands-on item revive (REVIVE_RANGE).
const PSI_HEAL_RANGE = 160;
const EQUIP_SLOTS = ['weapon', 'body', 'arms', 'other'];
// Skill points granted per level-up (banked until spent on the pentagon) and the
// per-stat cap a spend can raise an allocation to — both server-authoritative,
// canonical in charStats.js (imported above) so the spend + load paths agree.
// Crit (SMAAAASH!) chance as a percentage, derived from the attacker's Luck.
// Tunable in one place; ~1%/Luck so a fresh hero (Luck 9) crits ~9% of landed
// hits, capped so a maxed build can't crit on (nearly) every swing.
const CRIT_PER_LUCK = 1;
const CRIT_CHANCE_CAP = 50;
const critChanceFromLuck = (luck) =>
  Math.min(CRIT_CHANCE_CAP, Math.max(0, (luck | 0) * CRIT_PER_LUCK));
// Chance to dodge an incoming enemy swing, from the defender's Speed. ~0.5%/
// Speed (a fresh hero at Speed 8 dodges ~4% of hits), capped so no build is
// untouchable. npcSim rolls this against the enemy's swing (see resolveMelee).
const DODGE_PER_SPEED = 0.5;
const DODGE_CHANCE_CAP = 30;
const dodgeChanceFromSpeed = (speed) =>
  Math.min(DODGE_CHANCE_CAP, Math.max(0, (speed | 0) * DODGE_PER_SPEED));
// Max lifetime of the door-transition damage shield (see player.warping). A
// door fade + interior asset load is well under this; the cap only guards
// against a dropped 'warp' end signal leaving a player permanently invulnerable.
const WARP_SHIELD_MAX_MS = 8000;
// Move validation: a single non-warp position update bigger than this is a
// teleport / speed hack and gets clamped to this step. Matches npcSim's
// WARP_DELTA (the sim already treats bigger one-tick jumps as door warps), and
// honest walking is ~6px per send, far below it — so this never touches legit
// movement; door warps are exempt while the warp shield is up.
const MAX_MOVE_STEP = 96;
// Graceful disconnect: live clients send a move every ~3 frames (~50ms), so a
// player silent this long is a dead/zombie socket — close it (the close handler
// saves + cleans up). Generous, so only true zombies are reaped.
const IDLE_TIMEOUT_MS = 30000;
const HEARTBEAT_MS = 5000;
// How often the host ticks player status conditions (DoT + expiry). 4Hz — fine
// for ~1s damage-over-time cadence and snappy enough for status wear-off.
const STATUS_TICK_MS = 250;
// Accuracy penalties from status: a Crying attacker whiffs this often, a
// Nauseous one fumbles this often (rolled per swing; either ends the swing).
const CRY_MISS_CHANCE = 0.4;
const FUMBLE_CHANCE = 0.3;
// PK enable-lock: once a player turns PK on they're committed for this much
// IN-GAME (connected) time before they can turn it off. Stored as remaining ms
// (pkLockMs) that only counts down while the player is online — the lock PAUSES
// when they're offline, so logging out can't wait it out, and relogging can't
// escape it (pkLockMs is persisted).
const PK_LOCK_MS = 5 * 60 * 1000;

// Screen-wide PSI ('screen' shape: Rockin'/Starstorm/Flash) reaches every enemy in
// the caster's view — half the logical screen (256×224 at zoom 1), padded a touch so
// enemies at the very edge still count. KEEP near SCREEN_WIDTH/HEIGHT in src/types.ts.
const PSI_SCREEN_HALF_W = 140;
const PSI_SCREEN_HALF_H = 124;

// PSI abilities (server-authoritative). `pp` = cost; `heal` restores the caster's
// HP; `damage` strikes the nearest enemy within `range` px (offense PSI); `anim`
// is the PsiAnim catalog id whose authored frames play on cast. Heal/damage
// amounts are placeholders pending the canon effect values.
//
// This is the BASE table; the PSI Manager tool layers authored tuning on top from
// public/overrides/psi.json (merged in per-host via GameHost._loadPsi → this.PSI,
// read at startup like equip_stats). KEEP IN SYNC with the client base in
// src/engine/PsiTuning.ts (same ids/fields).
// The full canon roster (52 abilities, all families + tiers) is built from a
// COMPACT family spec so there's one short source to keep in sync with the client
// (src/engine/PsiTuning.ts PSI_FAMILY_SPECS — same ids/pp/effect fields). Each
// move's id matches the ROM PSI catalog id AND its psi_anim.json animation key.
// Heal/cure/revive are PARTY-target; Healing γ/Ω also REVIVE a downed ally
// (γ = partial HP, Ω = full HP) — canon (item help text, data_56). Offense
// targeting depends on `shape`:
//   'radius' (default; `multi` = every enemy in it) — assist status moves,
//   'line'  (Fire cone + Ice's single straight bolt) — aimed traveling projectiles
//           that damage ON CONTACT (spread 0 → one pellet),
//   'bolts' (Thunder) — `bolts` lightning strikes that FALL from above onto random
//           enemies in `range`, each a downward projectile (damage on the strike),
//   'screen' (Rockin'/Starstorm/Flash) — bursts every enemy in the caster's view.
// assist buffs/Magnet/Teleport effects
// aren't wired yet — they just play their animation + spend PP.
const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', omega: 'Ω', sigma: 'Σ' };
const PSI_FAMILY_SPECS = [
  // ---- Offense ----
  {
    stem: 'psi',
    family: "PSI Rockin'",
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [10, 14, 40, 98],
    // Screen-wide psychic burst: every enemy in the caster's view takes the hit at
    // once (the FX bursts on each, so damage + visual coincide). See shape 'screen'.
    effect: (i) => ({ damage: [20, 45, 100, 220][i], shape: 'screen' }),
  },
  {
    stem: 'psi_fire',
    family: 'PSI Fire',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [6, 12, 20, 42],
    // Shotgun cone: narrow muzzle, fanning WIDER with distance + per tier, and
    // reaching further — so α is a short jet and Ω sweeps a whole arc of a room.
    // End half-width = width + spread*length → ~45 / 94 / 183 / 339 px by tier.
    effect: (i) => ({
      damage: [14, 30, 60, 130][i],
      shape: 'line',
      length: [160, 240, 340, 460][i],
      width: [16, 22, 30, 40][i],
      spread: [0.18, 0.3, 0.45, 0.65][i],
    }),
  },
  {
    stem: 'psi_freeze',
    family: 'PSI Freeze',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [4, 9, 18, 28],
    // Single aimed bolt: same traveling-projectile path as Fire but with NO spread
    // (one pellet), so it flies straight to the cursor and damages on contact (a
    // wall stops it). Longer reach per tier.
    effect: (i) => ({
      damage: [12, 28, 58, 110][i],
      shape: 'line',
      length: [200, 240, 280, 320][i],
      width: 6,
      spread: 0,
    }),
  },
  {
    stem: 'psi_thunder',
    family: 'PSI Thunder',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [3, 7, 16, 20],
    // Random strikes: stronger tiers zap MORE enemies (and for more) on screen.
    effect: (i) => ({
      damage: [16, 34, 70, 100][i],
      shape: 'bolts',
      bolts: [2, 3, 5, 8][i],
      range: 520,
    }),
  },
  {
    stem: 'psi_flash',
    family: 'PSI Flash',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [8, 16, 24, 32],
    // Group move: bursts every enemy in view, each with a chance of the status.
    effect: (i) => ({
      damage: [10, 22, 40, 70][i],
      shape: 'screen',
      inflict: [{ type: 'paralysis', chance: [40, 50, 60, 70][i] }],
    }),
  },
  {
    stem: 'psi_starstorm',
    family: 'PSI Starstorm',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [24, 42],
    // Screen-wide starfall — hits every enemy in view (see shape 'screen').
    effect: (i) => ({ damage: [30, 60][i], shape: 'screen' }),
  },
  // ---- Recover ----
  {
    stem: 'lifeup',
    family: 'Lifeup',
    target: 'ally',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [5, 8, 13, 24],
    effect: (i) => ({ heal: [40, 80, 150, 300][i] }),
  },
  {
    stem: 'healing',
    family: 'Healing',
    target: 'ally',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [5, 8, 20, 38],
    effect: (i) => ({ cures: true, reviveFrac: [0, 0, 0.5, 1][i] || undefined }),
  },
  {
    stem: 'psi_magnet',
    family: 'PSI Magnet',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [1, 1],
  },
  // ---- Assist ----
  {
    stem: 'hypnosis',
    family: 'Hypnosis',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [6, 18],
    effect: (i) => ({ range: 240, multi: i === 1, inflict: [{ type: 'sleep', chance: 90 }] }),
  },
  {
    stem: 'paralysis',
    family: 'Paralysis',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [8, 24],
    effect: (i) => ({ range: 240, multi: i === 1, inflict: [{ type: 'paralysis', chance: 90 }] }),
  },
  {
    stem: 'brainshock',
    family: 'Brainshock',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [10, 30],
    effect: (i) => ({
      range: 240,
      multi: i === 1,
      inflict: [
        { type: 'strange', chance: 80 },
        { type: 'noPsi', chance: 80 },
      ],
    }),
  },
  {
    stem: 'offense_up',
    family: 'Offense up',
    target: 'self',
    tiers: ['alpha', 'omega'],
    pp: [10, 30],
  },
  {
    stem: 'defense_down',
    family: 'Defense down',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [6, 18],
  },
  {
    stem: 'shield',
    family: 'Shield',
    target: 'self',
    tiers: ['alpha', 'beta', 'omega', 'sigma'],
    pp: [6, 10, 30, 18],
  },
  {
    stem: 'psi_shield',
    family: 'PSI Shield',
    target: 'self',
    tiers: ['alpha', 'beta', 'omega', 'sigma'],
    pp: [8, 14, 42, 24],
  },
  // ---- Other ----
  { stem: 'teleport', family: 'Teleport', target: 'self', tiers: ['alpha', 'beta'], pp: [2, 8] },
];
const PSI_BASE = {};
for (const spec of PSI_FAMILY_SPECS) {
  spec.tiers.forEach((tier, i) => {
    const id = `${spec.stem}_${tier}`;
    PSI_BASE[id] = {
      name: `${spec.family} ${GREEK[tier]}`,
      pp: spec.pp[i],
      target: spec.target,
      anim: id,
      ...(spec.effect ? spec.effect(i) : {}),
    };
  });
}
// Mental level at which each move is LEARNED — its rank when all costed moves are
// sorted by PP (cheap = early). One move per Mental point, no batches/gaps (see
// ABILITIES.md §3.4). Free moves (PSI Magnet, pp<=1) learn at Mental 1. KEEP IN
// SYNC with the same ranking in src/engine/PsiTuning.ts.
assignUnlockMental(Object.values(PSI_BASE));
function assignUnlockMental(moves) {
  moves
    .filter((m) => m.pp > 1)
    .sort((a, b) => a.pp - b.pp) // stable: ties keep family/tier order
    .forEach((m, i) => {
      m.unlockMental = i + 1;
    });
  moves.filter((m) => m.pp <= 1).forEach((m) => (m.unlockMental = 1));
}

// --- PSI/ability unlock gate ------------------------------------------------
// ppMax encodes Mental (ppMax = 2 + 2*Mental), so Mental = (ppMax-2)/2. A move is
// learned once Mental reaches its `unlockMental`. DEV BYPASS: role dev/admin casts
// every move regardless of stats (test all PSI in prod). The bypass is the single
// chokepoint every future ability lane will reuse.
const mentalLevelOf = (entry) => Math.max(0, Math.round((((entry && entry.ppMax) || 0) - 2) / 2));
const isDevPlayer = (entry) => !!entry && (entry.role === 'dev' || entry.role === 'admin');
function psiUnlocked(entry, move) {
  if (isDevPlayer(entry)) return true;
  return mentalLevelOf(entry) >= (move.unlockMental || 1);
}
// Unit facing vectors by Direction (S,N,W,E,NW,SW,SE,NE) — where an offense PSI
// fizzles toward when no enemy is in range (so the projectile still reads).
const PSI_DIR = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
  [-0.7, -0.7],
  [-0.7, 0.7],
  [0.7, 0.7],
  [0.7, -0.7],
];

// --- Player progression (server-authoritative; full stat growth) ---
// Every player's level-1 combat baseline is DERIVED from a creation allocation
// (progressionFromAlloc below); anonymous/dev sessions use defaultAlloc(). One
// stat model for everyone means banked skill points only ever ADD to a build
// (no baseline that a spend would silently re-derive away from).
// Per-level AUTOMATIC stat gains (tunable). Deliberately a thin survival floor:
// real progression comes from the banked skill point each level spent on the
// pentagon (spend_points -> reapplyAlloc -> deriveCombatStats). We keep a small
// maxHp drip so a player who dumps every point into offense/speed doesn't stall
// out on survivability, but offense/defense/speed/etc. now grow ONLY by choice.
const GROWTH = {
  maxHp: 3,
  ppMax: 0,
  staminaMax: 0, // grows only via spending points on Spirit (re-derived)
  staminaRegen: 0, // grows only via spending points on Muscle (re-derived)
  ppRegen: 0, // grows only via spending points on Mental/Spirit (re-derived)
  offense: 0,
  defense: 0,
  speed: 0,
  guts: 0,
  vitality: 0,
  iq: 0,
  luck: 0,
};
// EXP to go from `level` to `level+1` (geometric ramp: 30, 45, 67, 101, …).
const expCost = (level) => Math.floor(30 * Math.pow(1.5, level - 1));
// Total EXP needed to REACH `level` from level 1.
const expToReach = (level) => {
  let s = 0;
  for (let i = 1; i < level; i++) s += expCost(i);
  return s;
};

// Build a full progression block from a creation allocation. The 5 creation
// stats set the LEVEL-1 combat baseline (deriveCombatStats); per-level GROWTH is
// then replayed up to `level`, and `exp` is restored. Combat stats are always
// derived from `alloc` — never trusted from the client save — so a tampered save
// can't grant stats it didn't earn.
function progressionFromAlloc(alloc, level = 1, exp = 0) {
  const d = deriveCombatStats(alloc);
  const p = {
    level: 1,
    hp: d.maxHp,
    maxHp: d.maxHp,
    pp: d.ppMax,
    ppMax: d.ppMax,
    stamina: d.staminaMax,
    staminaMax: d.staminaMax,
    staminaRegen: d.staminaRegen,
    ppRegen: d.ppRegen,
    exp: 0,
    offense: d.offense,
    defense: d.defense,
    speed: d.speed,
    guts: d.guts,
    vitality: d.vitality,
    iq: d.iq,
    luck: d.luck,
  };
  while (p.level < level) levelUp(p); // replay growth (also tops up hp/pp)
  p.exp = exp;
  p.expToNext = expToReach(p.level + 1) - p.exp;
  return p;
}

function levelUp(p) {
  p.level++;
  for (const k of Object.keys(GROWTH)) p[k] += GROWTH[k];
  p.hp = p.maxHp; // a level-up fully heals
  p.pp = p.ppMax;
  p.stamina = p.staminaMax;
}

// StatusModal-shaped payload (field names match PlayerStats: hpMax/ppMax). The
// combat stats are EFFECTIVE values — base progression + any active timed buffs
// (buffs.js) — so the status screen and combat agree on what the player has now.
function statsPayload(p) {
  const now = Date.now();
  const bb = (stat) => buffs.buffBonus(p, stat, now);
  return {
    level: p.level,
    hp: p.hp,
    hpMax: p.maxHp,
    pp: p.pp,
    ppMax: p.ppMax,
    ppRegen: p.ppRegen, // points/sec — drives the client's smooth PP-bar prediction
    stamina: p.stamina,
    staminaMax: p.staminaMax,
    staminaRegen: p.staminaRegen,
    exp: p.exp,
    expToNext: p.expToNext,
    offense: p.offense + bb('offense'),
    defense: p.defense + bb('defense'),
    speed: p.speed + bb('speed'),
    guts: p.guts + bb('guts'),
    vitality: p.vitality + bb('vitality'),
    iq: p.iq + bb('iq'),
    luck: p.luck + bb('luck'),
  };
}

class GameHost {
  /**
   * @param {string} assetsDir absolute path to public/assets
   * @param {object} [store] persistence Store (server/store/) for signed-in
   *   characters. Optional: without it (tests / anonymous dev), join falls back
   *   to a fresh ephemeral player and nothing is saved.
   */
  constructor(assetsDir, store = null) {
    this.players = new Map(); // id -> player record incl. _ws
    this.nextId = 1;
    // AOI spatial index of players (message recipients) — NETWORK_REMODEL.md §4.
    // Maintained on join/move/leave regardless of AOI_ENABLED.
    this.aoi = new SpatialGrid();
    // Phase-0 net instrumentation: rolling per-second send/byte counters, by
    // message type. Lets us measure the true broadcast ceiling before/after AOI.
    this._net = { sends: 0, bytes: 0, byType: new Map(), since: Date.now() };
    this.store = store;
    // Persistence handles for signed-in characters: playerId -> {characterId,alloc}.
    // Held OUT of the player record so the DB id never rides along in a broadcast.
    this.saves = new Map();
    // Per-character save serialization: characterId -> tail Promise of its write
    // chain. The store may be async (Supabase), so back-to-back saves of the SAME
    // character are queued to land in order — a later snapshot can never be
    // overwritten by an earlier one that resolved late. See _persistCharacterSave.
    this._saveChains = new Map();
    // Per-player quest/progress flags (PlayerFlags): playerId -> Set<number>.
    // Kept OUT of the player record too — flags are PRIVATE, never broadcast to
    // other clients. Persisted in the character save for signed-in players;
    // ephemeral (session-only) for anonymous dev/char-select joins.
    this.flags = new Map();
    // Per-player skill points + creation-stat allocation (drives the level-up
    // icon + spend pentagon): playerId -> {alloc, unspentPoints}. Like flags,
    // kept OUT of the player record (PRIVATE, never broadcast). Lives here for
    // EVERY player — anonymous/dev sessions bank + spend ephemerally (reset on
    // reload); signed-in players also persist it via the character save.
    this.points = new Map();

    // Server-authoritative goods registry + shop catalog (shared loader in
    // server/shops.js). Each player's inventory is an array of numeric-string
    // item ids (EarthBound-style slots); effects/transactions resolve here.
    const { goods, storeHas, startingInventory, npcShops } = loadShops(assetsDir);
    this.GOODS = goods;
    this.storeHas = storeHas;
    this.STARTING_INVENTORY = startingInventory;
    this.npcShops = npcShops; // clerk configId → {store} for proximity gating

    // Spawn point: editor override (public/overrides/spawn.json) wins over the
    // src/spawn.json default the client also uses. Read once at startup.
    const root = path.resolve(assetsDir, '..', '..');
    this.SPAWN = GameHost._readSpawn(root);

    // Effective PSI table: base ← authored tuning (overrides/psi.json), read once
    // at startup. The PSI Manager tool edits that file; the client mirrors the
    // same merge over its own base (PsiTuning.ts).
    this.PSI = GameHost._loadPsi(root);

    // Present box catalog: placement key -> { romFlag, item }. ROM-derived
    // (assets/map/gifts.json) with authored contents + new boxes layered on
    // (overrides/gifts.json). Drives the one-time 'open_gift' grant. Paths kept
    // so start() can hot-reload it when the Gift Manager saves (dev).
    this._assetsDir = assetsDir;
    this._root = root;
    this.GIFTS = GameHost._loadGifts(assetsDir, root);

    // Condiment seasoning table: foodId -> {pref, good, bad, effect}. ROM-derived
    // (assets/map/condiments.json, tools/extract_condiments.py). use_item auto-
    // applies the best condiment a player carries onto a food they eat. Absent
    // file = no seasoning (foods still heal their base).
    this.CONDIMENTS = GameHost._loadCondiments(assetsDir);

    // Server-authoritative NPC simulation: same world for every client.
    this.npcSim = createNpcSim(assetsDir);
    // World pixel bounds for move validation (clamp players onto the map).
    this.WORLD = this.npcSim.bounds();

    // Event runtime (EVENT_MANAGER.md Phase 2): timed group encounters authored
    // in the Event Manager tool. Drives countdown -> warp party -> timer -> exit.
    this.eventRuntime = createEventRuntime({
      root,
      getPlayers: () => this.players.values(),
      broadcast: (data) => this.broadcastAll(data),
      warpPlayer: (id, x, y, dir, eventId) => this.warpEventPlayer(id, x, y, dir, eventId),
    });
    this._eventTimer = null; // event tick handle (set in start()).

    // Idle-connection sweep handle (set in start()).
    this._heartbeat = null;
    // Player status-condition tick handle (DoT + expiry; set in start()).
    this._statusTimer = null;
    // Server-authoritative player-movement sim handle (set in start()).
    this._simTimer = null;
    // Gift-override file watcher handle (set in start()).
    this._giftsWatchPath = null;
    // Shop-override (equip_stats.json) file watcher handle (set in start()).
    this._shopsWatchPath = null;
    // Spawn-override (spawn.json) file watcher handle (set in start()).
    this._spawnWatchPath = null;
  }

  static _readSpawn(root) {
    for (const rel of ['public/overrides/spawn.json', 'src/spawn.json']) {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
      } catch {
        /* try next */
      }
    }
    return { x: 1296, y: 1168, dir: 0 };
  }

  /**
   * Effective PSI table: the BASE (PSI_BASE) with authored per-move tuning layered
   * on from public/overrides/psi.json ({ version, moves: { <id>: {pp,heal,…} } }).
   * Edited in the PSI Manager tool; the client mirrors the same merge over its own
   * base (PsiTuning.ts). Missing/bad file -> base only. Read once at startup, so
   * tuning applies on server restart (parallels equip_stats in shops.js).
   */
  static _loadPsi(root) {
    const out = {};
    for (const [id, base] of Object.entries(PSI_BASE)) out[id] = { ...base };
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(root, 'public/overrides/psi.json'), 'utf8'));
      const moves = (doc && doc.moves) || {};
      for (const [id, fields] of Object.entries(moves)) {
        if (!fields || typeof fields !== 'object') continue;
        // Layer authored fields over the base (or seed a new authored move).
        out[id] = Object.assign(out[id] || { name: id, pp: 0, anim: id }, fields);
      }
    } catch {
      /* none authored — base table only */
    }
    return out;
  }

  /**
   * Load the present-box catalog: placement key -> { romFlag, item }. ROM base
   * (assets/map/gifts.json) with authored contents (overrides/gifts.json edits)
   * layered on. Missing files -> empty catalog (gifts simply won't open).
   */
  static _loadGifts(assetsDir, root) {
    const gifts = new Map();
    let base;
    try {
      base = JSON.parse(fs.readFileSync(path.join(assetsDir, 'map', 'gifts.json'), 'utf8'));
    } catch {
      return gifts; // not extracted yet
    }
    for (const g of base) {
      if (g && typeof g.k === 'string')
        gifts.set(g.k, { romFlag: g.romFlag, item: g.item, sprite: g.sprite });
    }
    try {
      const ov = JSON.parse(
        fs.readFileSync(path.join(root, 'public', 'overrides', 'gifts.json'), 'utf8')
      );
      for (const [k, e] of Object.entries(ov?.edits || {})) {
        const g = gifts.get(k);
        if (g && e && e.item !== undefined) g.item = e.item;
      }
      // Admin-placed gift boxes (Gift Manager additions).
      for (const a of ov?.additions || []) {
        if (a && typeof a.k === 'string')
          gifts.set(a.k, { romFlag: a.romFlag, item: a.item, sprite: a.sprite });
      }
    } catch {
      /* no authored overrides yet */
    }
    return gifts;
  }

  /** Load the ROM-derived condiment seasoning table (assets/map/condiments.json).
   *  Returns { byFood: {id:{pref,good,bad,effect}}, set: Set(condiment ids),
   *  universal }. Empty/absent file => seasoning disabled (foods still heal). */
  static _loadCondiments(assetsDir) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(assetsDir, 'map', 'condiments.json'), 'utf8'));
      return {
        byFood: d.byFood || {},
        set: new Set((d.condiments || []).map((n) => String(n))),
        universal: String(d.universal || 126),
      };
    } catch {
      return { byFood: {}, set: new Set(), universal: '126' };
    }
  }

  /** Pick the best condiment in `inv` to season food `foodId`, EarthBound-style:
   *  the food's preferred condiment or the universal delisauce both give the big
   *  `good` bonus; we never auto-spend a condiment for the token `bad` bonus
   *  (that just wastes it). Returns {condId, amount, effect} or null. The caller
   *  removes condId from the bag and adds `amount` to hp/pp. */
  _pickCondiment(inv, foodId) {
    const c = this.CONDIMENTS;
    const rule = c.byFood[String(foodId)];
    if (!rule || (rule.effect !== 'hp' && rule.effect !== 'pp')) return null;
    const pref = String(rule.pref || 0);
    // Prefer the food-specific match so the premium universal delisauce is only
    // burned when it's the only good condiment on hand.
    let condId = null;
    if (pref !== '0' && inv.includes(pref)) condId = pref;
    else if (inv.includes(c.universal)) condId = c.universal;
    if (!condId || !(rule.good > 0)) return null;
    return { condId, amount: rule.good, effect: rule.effect };
  }

  /** Start the NPC simulation. Call once after construction. */
  start() {
    this.npcSim.start(
      () =>
        [...this.players.values()].map((p) => ({
          // editor players stay in the list as a sim ANCHOR (the world keeps
          // living around the parked avatar), but carry `editor` so npcSim skips
          // them for targeting/collision/damage — see npcSim aggroTarget/hitsPlayer.
          id: p.id,
          x: p.x,
          y: p.y,
          level: p.level,
          hp: p.hp,
          editor: !!p.editor,
          // Speed-derived chance to dodge a swing (enemy OR PvP; npcSim resolves it).
          // Speed buffs (e.g. Skip sandwich) raise the effective dodge while active.
          dodge: dodgeChanceFromSpeed(p.speed + buffs.buffBonus(p, 'speed', Date.now())),
          // PK flag, so npcSim's canHurt can gate PvP (and NPC aggro on PKers).
          pk: !!p.pk,
        })),
      // npc_update is the 10Hz NPC position firehose → per-client AOI filter.
      // Everything else from npcSim (hp/status/equip/death) stays global for now.
      (data) =>
        data.type === 'npc_update' ? this.publishNpcUpdate(data.npcs) : this.broadcastAll(data),
      // `inflict` = status procs the hit carries (e.g. paralysis), applied to the
      // victim's status set by damagePlayer; `knock` = the knockback landing spot.
      // `enemy` is the attacker NPC id — forwarded to the victim's client so it can
      // lunge that enemy into range for the hit (it renders ~interp+latency behind).
      (playerId, dmg, enemy, knock, inflict) =>
        this.damagePlayer(playerId, dmg, knock, inflict, enemy),
      (playerId, xp, _enemy, loot) => this.awardKill(playerId, xp, loot),
      // PvP: a player's swing landed on another player — apply it to the victim's
      // server-authoritative HP (same path as an enemy hit).
      (targetId, dmg, _byId, knock, inflict) => this.damagePlayer(targetId, dmg, knock, inflict),
      // Ground-drop claim: the sim found a player on a drop; we own inventory/cash
      // and decide if they can take it (bag room). Return true to consume it.
      (playerId, drop) => this.tryPickup(playerId, drop),
      // Vehicle nudge: a friendly player got clipped by a plowing vehicle — shove
      // them clear of the lane with NO damage (the sim already clamped the spot).
      (playerId, spot) => this.shovePlayer(playerId, spot)
    );
    // Graceful disconnects: reap dead/zombie sockets that stopped sending. A live
    // client sends a move every ~3 frames, so silence past IDLE_TIMEOUT_MS means
    // the connection is gone; close it so the close handler saves + cleans up.
    this._heartbeat = setInterval(() => this._reapIdle(), HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref(); // don't keep tests alive
    // Status conditions tick (DoT + expiry) for players. npcSim ticks its own
    // actors; players live here, so the host drives their poison/etc + clears
    // worn-off statuses (re-broadcasting the set). 4Hz is plenty for ~1s DoT.
    this._statusTimer = setInterval(() => this._tickPlayerStatuses(), STATUS_TICK_MS);
    if (this._statusTimer.unref) this._statusTimer.unref();

    // Server-authoritative player movement: drain queued client inputs and
    // simulate each player's position. No-op for players still on the legacy
    // `move` path (empty input queue), so this is safe to run pre-cutover.
    this._simTimer = setInterval(() => this._simPlayers(), SIM_TICK_MS);
    if (this._simTimer.unref) this._simTimer.unref();

    // Crowd re-rank pass (§4.6): re-evaluate every player's nearest-M visible set
    // so a stationary player in a shifting crowd stays current (move-triggered
    // refresh only updates the mover's own view). Only runs when AOI is on.
    if (AOI_ENABLED) {
      this._relTimer = setInterval(() => {
        for (const id of this.players.keys()) this._refreshAoi(id);
      }, REL_TICK_MS);
      if (this._relTimer.unref) this._relTimer.unref();
    }

    // Phase-0 measurement: log fan-out rates every 5s when NET_DEBUG=1. Zero cost
    // (no interval created) in normal runs. This is how we prove the broadcast
    // ceiling and, later, the AOI win — NETWORK_REMODEL.md §11 Phase 0.
    if (NET_DEBUG) {
      this._netTimer = setInterval(() => {
        if (this.players.size === 0) return;
        const s = this.netStats();
        console.log(
          `[net] players=${s.players} sends/s=${s.sendsPerSec} egress=${s.mbPerSec}MB/s ` +
            `aoi{indexed:${s.aoi.indexed},cells:${s.aoi.occupiedCells},max/cell:${s.aoi.maxPerCell}} ` +
            `top=${Object.entries(s.byType)
              .sort((a, b) => b[1].kbPerSec - a[1].kbPerSec)
              .slice(0, 3)
              .map(([t, v]) => `${t}:${v.kbPerSec}kB/s`)
              .join(' ')}`
        );
      }, 5000);
      if (this._netTimer.unref) this._netTimer.unref();
    }

    // Event runtime tick (countdowns, warps, timers, end conditions). 10Hz is
    // plenty for second-resolution timers and a smooth countdown.
    this._eventTimer = setInterval(() => this.eventRuntime.tick(Date.now()), 100);
    if (this._eventTimer.unref) this._eventTimer.unref();

    // Hot-reload the gift catalog when the Gift Manager saves overrides/gifts.json
    // (dev), so newly-placed boxes are openable without a server restart. Polling
    // watcher (cross-platform); harmless if the file never appears.
    this._giftsWatchPath = path.join(this._root, 'public', 'overrides', 'gifts.json');
    try {
      fs.watchFile(this._giftsWatchPath, { interval: 1500 }, () => {
        this.GIFTS = GameHost._loadGifts(this._assetsDir, this._root);
      });
    } catch {
      /* watch unavailable — gifts still load at startup */
    }

    // Hot-reload the shop catalog (prices, heals, gear stats) when the Item Manager
    // saves overrides/equip_stats.json (dev), so a price/effect edit applies WITHOUT
    // a server restart — the buy handler reads cost from GOODS, which is otherwise
    // built once at boot (the desync that made an edited item un-buyable). Rebuild
    // GOODS/storeHas and refresh every connected player's equipped-gear stats so a
    // weapon/armor edit lands live too. Polling watcher (cross-platform).
    this._shopsWatchPath = path.join(this._root, 'public', 'overrides', 'equip_stats.json');
    try {
      fs.watchFile(this._shopsWatchPath, { interval: 1500 }, () => {
        try {
          const { goods, storeHas, startingInventory, npcShops } = loadShops(this._assetsDir);
          this.GOODS = goods;
          this.storeHas = storeHas;
          this.STARTING_INVENTORY = startingInventory;
          this.npcShops = npcShops;
          for (const entry of this.players.values()) this.recomputeEquipStats(entry);
        } catch (e) {
          console.warn('[shops] hot-reload failed; keeping previous catalog', e);
        }
      });
    } catch {
      /* watch unavailable — shop edits still apply on restart */
    }

    // Hot-reload the spawn point when the Placement Editor saves overrides/spawn.json
    // (dev), so a moved spawn applies to respawns/joins WITHOUT a server restart
    // (SPAWN is otherwise read once at boot). Polling watcher (cross-platform).
    this._spawnWatchPath = path.join(this._root, 'public', 'overrides', 'spawn.json');
    try {
      fs.watchFile(this._spawnWatchPath, { interval: 1500 }, () => {
        this.SPAWN = GameHost._readSpawn(this._root);
      });
    } catch {
      /* watch unavailable — spawn edits still apply on restart */
    }
  }

  // Per-tick player status upkeep: apply due DoT, drop worn-off statuses, and
  // re-broadcast the set when it changes. Skips clean/editor/dead players.
  _tickPlayerStatuses() {
    const now = Date.now();
    for (const [id, p] of this.players) {
      // Mortal roll: the HP meter is rolling to zero. If it lands without a heal
      // saving them, lay them out (KO). They keep acting/healing until then.
      if (p.dying) {
        if (now >= p.dyingUntil) this._mortalExpired(id, p);
        continue;
      }
      // Downed players: tick the KO window; when it elapses they truly die.
      if (p.downed) {
        if (now >= p.downedUntil) this._trueDeath(id);
        continue;
      }
      if (p.editor || p.hp <= 0) continue;
      // Expire timed stat buffs; when one wears off, re-push stats so the client's
      // status screen drops the bonus back down (effective offense/defense/speed).
      if (p.buffs && p.buffs.length && buffs.tickBuffs(p, now).changed) {
        this.broadcastAll({
          type: 'player_stats',
          id,
          stats: statsPayload(p),
          leveled: false,
          gained: 0,
        });
        this._sendPlayerBuffs(p); // a buff wore off — refresh the owner's HUD
      }
      if (!p.statuses || Object.keys(p.statuses).length === 0) continue;
      const r = status.tickStatuses(p, now);
      for (const d of r.dot) {
        this.damagePlayer(id, Math.max(1, Math.floor(p.maxHp * d.pct)), null, null);
        if (p.hp <= 0) break; // death cleared everything + respawned
      }
      if (r.changed && p.hp > 0) this._broadcastPlayerStatus(p);
    }
  }

  // A player's status vulnerability % for an element (100 = no resist). EB grants
  // status protection via EQUIPMENT (e.g. items that "protect from paralysis"),
  // not level — wiring that needs the item-flag data (community source; the ROM
  // decompile doesn't expose it). Until then players are fully susceptible.
  _playerVuln(_p, _element) {
    return 100;
  }

  /** Broadcast a player's current active status-id set (drives client icons + lock). */
  _broadcastPlayerStatus(p) {
    this.broadcastAll({
      type: 'player_status',
      id: p.id,
      statuses: status.activeStatuses(p, Date.now()),
    });
  }

  /** Send a player their active timed buffs (owner-only — it drives their personal
   *  buff HUD). Each entry carries REMAINING ms (not an absolute time) so the
   *  client counts down locally regardless of clock skew, the same trick as the PK
   *  lock. Call whenever the buff set changes (apply / expire / death / revive). */
  _sendPlayerBuffs(p) {
    if (!p || !p._ws) return;
    const now = Date.now();
    const list = buffs.activeBuffs(p, now).map((b) => ({
      stat: b.stat,
      amount: b.amount,
      ms: Math.max(0, b.until - now),
    }));
    p._ws.send(JSON.stringify({ type: 'player_buffs', buffs: list }));
  }

  // Tear down a superseded session (same character reconnected — see the join
  // handler). The NEW session already loaded the character's authoritative state,
  // so we deliberately do NOT save the stale zombie (it could clobber newer
  // state) and we DROP its save handle first, so the old socket's late 'close'
  // event can't re-save it either. Clears AOI indices + despawns it everywhere.
  _evictSession(oldId) {
    const old = this.players.get(oldId);
    if (!old) return;
    this.saves.delete(oldId); // before close fires → no stale re-save
    this.flags.delete(oldId);
    this.points.delete(oldId);
    this._clearAoi(oldId);
    this.players.delete(oldId);
    this.aoi.remove(oldId);
    this.broadcastAll({ type: 'player_leave', id: oldId });
    try {
      if (old._ws && old._ws.close) old._ws.close();
    } catch {
      /* socket already gone */
    }
  }

  // Close any connection silent longer than IDLE_TIMEOUT_MS. Closing triggers the
  // ws 'close' handler (save-back + roster cleanup + player_leave broadcast).
  _reapIdle() {
    const now = Date.now();
    for (const [, entry] of this.players) {
      if (now - (entry.lastSeen || 0) <= IDLE_TIMEOUT_MS) continue;
      try {
        if (entry._ws.terminate) entry._ws.terminate();
        else entry._ws.close();
      } catch {
        /* socket already gone */
      }
    }
  }

  /** Stop the heartbeat + status tick (tests / shutdown). */
  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = null;
    if (this._simTimer) clearInterval(this._simTimer);
    this._simTimer = null;
    if (this._eventTimer) clearInterval(this._eventTimer);
    this._eventTimer = null;
    if (this.eventRuntime) this.eventRuntime.stop();
    if (this._giftsWatchPath) fs.unwatchFile(this._giftsWatchPath);
    if (this._shopsWatchPath) fs.unwatchFile(this._shopsWatchPath);
    if (this._spawnWatchPath) fs.unwatchFile(this._spawnWatchPath);
    this._giftsWatchPath = null;
    this._shopsWatchPath = null;
    this._spawnWatchPath = null;
  }

  // Project an inventory (array of ids) to the wire shape the client renders:
  // [{ id, name }]. Unknown ids are dropped rather than sent nameless.
  inventoryView(inventory) {
    return inventory
      .filter((id) => this.GOODS[id])
      .map((id) => ({ id, name: this.GOODS[id].name }));
  }

  broadcastAll(data) {
    const msg = JSON.stringify(data);
    let n = 0;
    for (const [, entry] of this.players) {
      if (entry._ws.readyState === 1) {
        entry._ws.send(msg);
        n++;
      }
    }
    this._recordSend(data.type, msg.length, n);
  }

  // Broadcast to everyone except one player (their own client handles it locally).
  broadcastExcept(data, exceptId) {
    const msg = JSON.stringify(data);
    let n = 0;
    for (const [id, entry] of this.players) {
      if (id !== exceptId && entry._ws.readyState === 1) {
        entry._ws.send(msg);
        n++;
      }
    }
    this._recordSend(data.type, msg.length, n);
  }

  // Positional fan-out (NETWORK_REMODEL.md §4): deliver `data` only to players
  // whose AOI overlaps (x,y) — the 3×3 cell block around the point. While
  // AOI_ENABLED is off this is identical to broadcastExcept, so callers can be
  // migrated now and the behavior change is gated to one flag flip (after
  // spawn/despawn lands). Same instrumentation either way.
  publishToArea(x, y, data, exceptId) {
    if (!AOI_ENABLED) return this.broadcastExcept(data, exceptId);
    const msg = JSON.stringify(data);
    let n = 0;
    for (const id of this.aoi.around(x, y)) {
      if (id === exceptId) continue;
      const entry = this.players.get(id);
      if (entry && entry._ws.readyState === 1) {
        entry._ws.send(msg);
        n++;
      }
    }
    this._recordSend(data.type, msg.length, n);
  }

  // Per-client AOI fan-out of the NPC position firehose (NETWORK_REMODEL.md §4.3).
  // `rows` = [[id, x, y, dir, frame, pose], ...] for every NPC that moved this
  // tick. Today this whole array ships to EVERY client (the real bottleneck —
  // the sim is already culled to ACTIVE_RADIUS, but the OUTPUT is global). With
  // AOI on, each player gets only the rows whose NPC sits in its 3×3 cell block.
  // Bucket-by-cell once (O(rows)), then each player gathers its block (O(k)).
  // Falls back to the global broadcast while AOI_ENABLED is off → identical.
  // Encode + send one client's npc_update — binary delta (BINARY_WIRE) or JSON
  // (§5). Delta-codes against this client's per-socket baseline (`_npcBase`),
  // which the client mirrors; both update identically per row so reliable,
  // ordered WS keeps them in sync. The baseline is bounded — a clear just forces
  // keyframes next tick (safe, since a missing prev always encodes as KEY).
  _sendNpcUpdate(entry, npcs, over, ts = srvNow()) {
    let msg;
    if (BINARY_WIRE && entry._rtc && entry._rtc.isOpen()) {
      // Unreliable RTC channel: send ABSOLUTE frames (no baseline). A dropped
      // packet just misses one position tick; delta-coding would desync forever.
      msg = wire.encodeNpcUpdate(npcs, over, ts);
      entry._rtc.send(msg);
    } else if (BINARY_WIRE) {
      let base = entry._npcBase;
      if (!base) base = entry._npcBase = new Map();
      if (base.size > 4096) base.clear();
      msg = wire.encodeNpcDelta(npcs, base, over, ts);
      if (entry._ws && entry._ws.readyState === 1) entry._ws.send(msg);
    } else {
      msg = JSON.stringify(
        over > 0 ? { type: 'npc_update', npcs, over, ts } : { type: 'npc_update', npcs, ts }
      );
      entry._ws.send(msg); // JSON control path stays reliable on the WS
    }
    this._recordSend('npc_update', msg.length, 1);
  }

  publishNpcUpdate(rows) {
    const ts = srvNow(); // one server send-time stamped onto every frame this tick
    if (!AOI_ENABLED || !rows || rows.length === 0) {
      if (!BINARY_WIRE || !rows || rows.length === 0) {
        return this.broadcastAll({ type: 'npc_update', npcs: rows, ts });
      }
      // AOI off + binary: one encoded buffer fans out to everyone (no per-client
      // filtering, so the bytes are identical — encode once).
      const buf = wire.encodeNpcUpdate(rows, 0, ts);
      let n = 0;
      for (const [, entry] of this.players) {
        if (entry._ws && entry._ws.readyState === 1) {
          this.sendBin(entry, buf);
          n++;
        }
      }
      this._recordSend('npc_update', buf.length, n);
      return;
    }
    const cell = this.aoi.cellSize;
    const byCell = new Map(); // "cx:cy" -> rows[]
    const dirtyById = new Map(); // id -> row, for the AOI-leave position check below
    for (const r of rows) {
      dirtyById.set(r[0], r);
      const key = Math.floor(r[1] / cell) + ':' + Math.floor(r[2] / cell);
      let arr = byCell.get(key);
      if (!arr) byCell.set(key, (arr = []));
      arr.push(r);
    }
    for (const [pid, entry] of this.players) {
      if (!entry._ws || entry._ws.readyState !== 1) continue;
      // Use the player's hysteretic anchor cell so the inbound NPC set matches
      // its subscription block and doesn't flicker at boundaries (§4.2).
      const a = this.aoi.anchorOf(pid);
      const cx = a ? a[0] : Math.floor(entry.x / cell);
      const cy = a ? a[1] : Math.floor(entry.y / cell);
      let mine = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = byCell.get(cx + dx + ':' + (cy + dy));
          if (arr) (mine || (mine = [])).push(...arr);
        }
      }
      if (mine) {
        // Crowd cap (§4.6): never ship more than AOI_MAX_NPCS rows to one client.
        // Beyond the cap, keep the NEAREST and report the remainder as a count so
        // the client can render an aggregate later. Sort only when over the cap
        // (the common case is well under it, so this stays free). npc_update is
        // stateless per-tick, so capping it can't churn — a dropped far NPC just
        // misses a position tick (it's off-screen / renderer-culled anyway).
        let over = 0;
        if (mine.length > AOI_MAX_NPCS) {
          const px = entry.x;
          const py = entry.y;
          mine.sort(
            (r1, r2) =>
              (r1[1] - px) ** 2 + (r1[2] - py) ** 2 - ((r2[1] - px) ** 2 + (r2[2] - py) ** 2)
          );
          over = mine.length - AOI_MAX_NPCS;
          mine.length = AOI_MAX_NPCS;
        }
        this._sendNpcUpdate(entry, mine, over, ts);
      }
      // AOI despawn (mirrors player_leave): explicitly tell the client to DROP any
      // NPC that has left its 3×3 block — moved out, or the player walked away — so
      // a stale copy is hidden the INSTANT it's bogus instead of lingering until the
      // client's staleness timeout. The per-client delta baseline (_npcBase) is the
      // set the client currently knows; an entry whose CURRENT position (the dirty
      // row if it moved this tick, else its last-sent spot) falls outside the block
      // has left. Deleting it also re-keyframes it cleanly on re-entry. (BINARY+WS
      // path only — RTC/JSON keep the timeout backstop; both are non-default.)
      const base = entry._npcBase;
      if (base && base.size) {
        let gone = null;
        for (const [id, v] of base) {
          const d = dirtyById.get(id);
          const ncx = Math.floor((d ? d[1] : v[0] / 2) / cell);
          const ncy = Math.floor((d ? d[2] : v[1] / 2) / cell);
          if (Math.abs(ncx - cx) > 1 || Math.abs(ncy - cy) > 1) (gone || (gone = [])).push(id);
        }
        if (gone) {
          for (const id of gone) base.delete(id);
          const msg = JSON.stringify({ type: 'npc_leave', ids: gone });
          entry._ws.send(msg);
          this._recordSend('npc_leave', msg.length, 1);
        }
      }
    }
  }

  // Build the AOI-restricted NPC/drop join bundle for a newcomer: the 3×3 block
  // of cells around its anchor (same window its subscription uses). §4.5.
  _aoiJoinSnapshot(playerId, entry) {
    const cell = this.aoi.cellSize;
    const a = this.aoi.anchorOf(playerId) || [
      Math.floor(entry.x / cell),
      Math.floor(entry.y / cell),
    ];
    const minX = (a[0] - 1) * cell;
    const maxX = (a[0] + 2) * cell;
    const minY = (a[1] - 1) * cell;
    const maxY = (a[1] + 2) * cell;
    return this.npcSim.aoiSnapshot((x, y) => x >= minX && x < maxX && y >= minY && y < maxY);
  }

  // Send a binary firehose frame to one client: over its unreliable WebRTC
  // DataChannel when open (no TCP head-of-line blocking), else the WebSocket. The
  // delta/seq codec tolerates the occasional dropped DataChannel frame; control
  // traffic never comes through here, so it stays reliable on the WS.
  sendBin(entry, buf) {
    if (entry._rtc && entry._rtc.isOpen()) entry._rtc.send(buf);
    else if (entry._ws && entry._ws.readyState === 1) entry._ws.send(buf);
  }

  // --- AOI player spawn/despawn (enter/leave) — NETWORK_REMODEL.md §4.5 -------
  // Send `data` to one player's socket. Used for the targeted spawn/despawn that
  // replace the global player_join/player_leave broadcasts when AOI is on.
  _sendTo(id, data) {
    const e = this.players.get(id);
    if (e && e._ws && e._ws.readyState === 1) {
      const msg = JSON.stringify(data);
      e._ws.send(msg);
      this._recordSend(data.type, msg.length, 1);
    }
  }

  // Public (wire) shape of a player for spawn — mirrors welcome.players / the
  // player_join broadcast (strip server-private fields, expose status as array).
  _publicPlayer(id) {
    const p = this.players.get(id);
    if (!p) return null;
    const {
      _ws,
      _rtc,
      _inputs,
      _seen,
      _seenBy,
      _crowdOver,
      _crowdSent,
      _npcBase,
      _pmBase,
      _ackSeq,
      ...data
    } = p;
    data.statuses = status.activeStatuses(p, Date.now());
    return data;
  }

  // Route a PLAYER-CENTRIC event (hp / push / equip / attack / chat, keyed by
  // `data.id`) to just the viewers who currently have that player spawned (its AOI
  // reverse index) — §4.4 event-relevance routing. These fire on every hit / swing
  // / message, so a global broadcast is an O(N) cost per event. `includeSelf` true
  // also sends to the player (hp/push: they need their own state); false mirrors
  // the old broadcastExcept (equip/attack/chat: the sender handles it locally).
  // AOI off: unchanged global broadcast (broadcastAll / broadcastExcept).
  _publishPlayerEvent(data, includeSelf = true) {
    if (!AOI_ENABLED)
      return includeSelf ? this.broadcastAll(data) : this.broadcastExcept(data, data.id);
    const entry = this.players.get(data.id);
    if (!entry) return;
    const msg = JSON.stringify(data);
    let n = 0;
    if (includeSelf && entry._ws && entry._ws.readyState === 1) {
      entry._ws.send(msg); // the player needs their own hp/push
      n++;
    }
    if (entry._seenBy) {
      for (const viewer of entry._seenBy) {
        const v = this.players.get(viewer);
        if (v && v._ws && v._ws.readyState === 1) {
          v._ws.send(msg);
          n++;
        }
      }
    }
    this._recordSend(data.type, msg.length, n);
  }

  // Player position firehose fan-out. AOI on: only to viewers who currently have
  // the mover spawned (its reverse index) — so a packed square costs O(movers ×
  // their viewers), already capped by the per-client nearest-M visible set, not
  // O(crowd²). AOI off: legacy global broadcastExcept. NETWORK_REMODEL.md §4.6.
  _publishMove(id, entry, data) {
    const ts = srvNow(); // server send-time, stamped on every frame (binary + JSON)
    data.ts = ts; // JSON paths (broadcastExcept / per-viewer JSON) carry it inline

    // AOI off + JSON: unchanged global path.
    if (!AOI_ENABLED && !BINARY_WIRE) return this.broadcastExcept(data, id);

    // Binary, AOI off: plain full player_move (0x02) — encode once, broadcast.
    if (!AOI_ENABLED) {
      const msg = wire.encodePlayerMove(data, ts);
      let n = 0;
      for (const [pid, e] of this.players) {
        if (pid === id) continue;
        if (e._ws && e._ws.readyState === 1) {
          this.sendBin(e, msg);
          n++;
        }
      }
      this._recordSend('player_move', msg.length, n);
      return;
    }

    // AOI on: only the mover's viewers (the reverse index).
    const seenBy = entry._seenBy;
    if (!seenBy || seenBy.size === 0) return;

    if (!BINARY_WIRE) {
      // JSON: one encoding to all viewers.
      const msg = JSON.stringify(data);
      let n = 0;
      for (const viewer of seenBy) {
        const v = this.players.get(viewer);
        if (v && v._ws && v._ws.readyState === 1) {
          v._ws.send(msg);
          n++;
        }
      }
      this._recordSend('player_move', msg.length, n);
      return;
    }

    // Binary + AOI: per-viewer delta against each viewer's player baseline (§5).
    // Encoding is per-viewer because each holds a different baseline for the mover
    // (they spawned it at different times); first send to a viewer is a keyframe.
    let n = 0;
    let bytes = 0;
    for (const viewer of seenBy) {
      const v = this.players.get(viewer);
      if (!v || !v._ws || v._ws.readyState !== 1) continue;
      let buf;
      if (v._rtc && v._rtc.isOpen()) {
        // Absolute player_move over the unreliable channel (drop-tolerant).
        buf = wire.encodePlayerMove(data, ts);
        v._rtc.send(buf);
      } else {
        let base = v._pmBase;
        if (!base) base = v._pmBase = new Map();
        if (base.size > 4096) base.clear();
        buf = wire.encodePlayerDelta(data, base, ts);
        v._ws.send(buf);
      }
      n++;
      bytes += buf.length;
    }
    if (n) this._recordSend('player_move', Math.round(bytes / n), n);
  }

  // Reconcile who player `id` should see against who it currently sees, emitting
  // spawn (player_join) / despawn (player_leave) to `id` only. PER-CLIENT and
  // asymmetric (§4.6): peers update their own view on their own pass, because
  // with a nearest-M crowd cap A-sees-B no longer implies B-sees-A. Maintains the
  // reverse index `_seenBy` (who currently has me spawned) so the move firehose
  // routes only to viewers that actually rendered the mover. Candidates come from
  // the hysteretic anchor block (§4.2); when they exceed the cap, nearest-M win
  // with RANK hysteresis so a peer hovering at the M/M+1 boundary doesn't flap.
  // No-op unless AOI_ENABLED. Called on join, on cell-cross, and by the 4Hz pass.
  _refreshAoi(id) {
    if (!AOI_ENABLED) return;
    const entry = this.players.get(id);
    if (!entry) return;
    const seen = entry._seen || (entry._seen = new Set());
    const px = entry.x;
    const py = entry.y;
    const cands = [];
    for (const other of this.aoi.aroundId(id)) {
      if (other !== id && this.players.has(other)) cands.push(other);
    }

    let desired;
    if (cands.length <= AOI_MAX_PLAYERS) {
      desired = new Set(cands); // under the cap: see everyone in the block
    } else {
      // Over the cap: rank by distance, keep nearest M. A peer already spawned
      // survives out to rank M+HYST; a new one must be inside M to enter.
      cands.sort((a, b) => {
        const A = this.players.get(a);
        const B = this.players.get(b);
        return (A.x - px) ** 2 + (A.y - py) ** 2 - ((B.x - px) ** 2 + (B.y - py) ** 2);
      });
      desired = new Set();
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const limit = seen.has(c) ? AOI_MAX_PLAYERS + AOI_PLAYER_HYST : AOI_MAX_PLAYERS;
        if (i < limit) desired.add(c);
      }
    }

    // Spawn newly-visible peers to me; register me in their reverse index.
    for (const c of desired) {
      if (seen.has(c)) continue;
      seen.add(c);
      const o = this.players.get(c);
      (o._seenBy || (o._seenBy = new Set())).add(id);
      const op = this._publicPlayer(c);
      if (op) this._sendTo(id, { type: 'player_join', player: op });
    }
    // Despawn peers that dropped out of my view; unregister me from their reverse.
    for (const c of seen) {
      if (desired.has(c)) continue;
      seen.delete(c);
      const o = this.players.get(c);
      if (o && o._seenBy) o._seenBy.delete(id);
      this._sendTo(id, { type: 'player_leave', id: c });
    }
    // Remainder beyond the cap → aggregate count for the client's "+N nearby"
    // (§4.6). Send only on change so the reliable channel isn't spammed each pass.
    const over = cands.length - desired.size;
    if (over !== entry._crowdSent) {
      entry._crowdSent = over;
      this._sendTo(id, { type: 'crowd', players: over });
    }
    entry._crowdOver = over;
  }

  // Drop a departing player from BOTH AOI indices (disconnect). The global
  // player_leave (close handler) despawns them on every client; this clears the
  // dangling references so neither _seen nor _seenBy can leak. No-op when off.
  _clearAoi(id) {
    const entry = this.players.get(id);
    if (!entry) return;
    if (entry._seen) {
      for (const other of entry._seen) {
        const o = this.players.get(other);
        if (o && o._seenBy) o._seenBy.delete(id); // I no longer view them
      }
      entry._seen.clear();
    }
    if (entry._seenBy) {
      for (const viewer of entry._seenBy) {
        const v = this.players.get(viewer);
        if (v && v._seen) v._seen.delete(id); // they no longer view me
      }
      entry._seenBy.clear();
    }
  }

  // `_refreshAoi(id)` is one-directional: it updates id's OWN view (spawns peers
  // to id, registers id in their reverse index for move routing) but does NOT
  // spawn id TO those peers — that waited for each peer's own 4Hz relevance pass,
  // so a freshly joined/warped player stayed invisible to everyone for up to a
  // tick (the "player only appears after they move" bug, and the asymmetric
  // join in the host tests). This reciprocal form also re-evaluates every peer in
  // id's block so the (re)appearing player spawns to them immediately, both ways.
  // No-op unless AOI_ENABLED. Use on join + every teleport; the 4Hz pass remains
  // the backstop for peers outside id's block (e.g. the area id just LEFT).
  _refreshAoiReciprocal(id) {
    this._refreshAoi(id);
    if (!AOI_ENABLED) return;
    for (const other of this.aoi.aroundId(id)) {
      if (other !== id && this.players.has(other)) this._refreshAoi(other);
    }
  }

  // After a TELEPORT (door / escalator exit / event warp) re-establish the
  // player's AOI state at the new spot. A teleport sets x/y directly — it never
  // flows through _simPlayers' aoi.update — so without this the anchor stays in
  // the OLD cell: the NPC firehose keeps filtering for where the player WAS, and
  // since npc_update is moved-only, the new area's STATIONARY actors (and every
  // enemy's one-shot activation HP) never arrive — you warp into a building and
  // it's empty (the prod "NPCs vanish indoors" bug; masked locally where AOI is
  // off). We re-anchor, resend the new block's NPC positions + HP + held items as
  // a one-shot snapshot (same payload `welcome` uses), drop the stale per-socket
  // delta baseline so the next deltas key cleanly, and refresh player visibility
  // both ways. No-op unless AOI_ENABLED.
  _warpResnapshot(playerId, entry) {
    if (!AOI_ENABLED) {
      this.aoi.update(playerId, entry.x, entry.y); // keep the grid honest even off
      return;
    }
    this.aoi.update(playerId, entry.x, entry.y);
    const snap = this._aoiJoinSnapshot(playerId, entry);
    if (snap.npcs && snap.npcs.length)
      this._sendTo(playerId, { type: 'npc_update', npcs: snap.npcs });
    if (snap.npcHps && snap.npcHps.length)
      this._sendTo(playerId, { type: 'npc_hp', hps: snap.npcHps });
    if (snap.npcEquips && snap.npcEquips.length)
      this._sendTo(playerId, { type: 'npc_equip', equips: snap.npcEquips });
    if (entry._npcBase) entry._npcBase.clear(); // re-keyframe deltas for the new area
    this._refreshAoiReciprocal(playerId);
  }

  // Tally one logical broadcast that hit `recipients` sockets (Phase-0 metrics).
  _recordSend(type, bytesPerMsg, recipients) {
    if (!recipients) return;
    this._net.sends += recipients;
    this._net.bytes += bytesPerMsg * recipients;
    const t = this._net.byType.get(type) || { sends: 0, bytes: 0 };
    t.sends += recipients;
    t.bytes += bytesPerMsg * recipients;
    this._net.byType.set(type, t);
  }

  // Snapshot + reset the rolling net counters into per-second rates. Logged on a
  // timer when NET_DEBUG=1; also handy to expose via a debug route later.
  netStats() {
    const now = Date.now();
    const secs = Math.max(0.001, (now - this._net.since) / 1000);
    const byType = {};
    for (const [type, t] of this._net.byType) {
      byType[type] = {
        sendsPerSec: Math.round(t.sends / secs),
        kbPerSec: +(t.bytes / 1024 / secs).toFixed(1),
      };
    }
    const out = {
      players: this.players.size,
      sendsPerSec: Math.round(this._net.sends / secs),
      mbPerSec: +(this._net.bytes / 1048576 / secs).toFixed(2),
      aoi: this.aoi.stats(),
      byType,
    };
    this._net = { sends: 0, bytes: 0, byType: new Map(), since: now };
    return out;
  }

  // Event runtime warp: snap a player's authoritative position to (x,y) and tell
  // their client to do a door-style fade there. `eventId` is the event they're
  // now in (null when warped back out). Shields them from hits during the fade,
  // exactly like a door transition. Remote copies follow once the warped client
  // resumes reporting its position (same as doors).
  warpEventPlayer(id, x, y, dir, eventId) {
    const entry = this.players.get(id);
    if (!entry) return;
    entry.x = Math.round(x);
    entry.y = Math.round(y);
    entry.direction = dir | 0;
    entry.moving = false;
    entry.frame = 0;
    entry.warping = true;
    entry.warpUntil = Date.now() + WARP_SHIELD_MAX_MS;
    // A scripted event warp is a TELEPORT, not a door — exempt this jump from
    // enemy door-warp follow so a chaser doesn't teleport along and keep hitting
    // the player invisibly (mirrors the respawn / editor-exit exemptions).
    this.npcSim.noteTeleport(id);
    this.sendTo(id, {
      type: 'event_warp',
      x: entry.x,
      y: entry.y,
      dir: entry.direction,
      eventId: eventId || null,
    });
    // Re-anchor AOI + resnapshot the event room (it's a teleport like a door).
    this._warpResnapshot(id, entry);
  }

  // Recompute the combat bonuses from a player's equipped gear: weapon offense
  // (added to attack damage) and total armor defense (subtracted from hits). The
  // held-item sprite is always the equipped weapon.
  recomputeEquipStats(entry) {
    const w = entry.equipped.weapon;
    const we = w ? this.GOODS[w] && this.GOODS[w].equip : null;
    entry.weaponOffense = we && we.slot === 'weapon' ? we.offense | 0 : 0;
    // Swing-rate multiplier from the equipped weapon (1 = bare-handed baseline).
    // Drives the server's per-player attack cooldown AND the client's swing-pose
    // duration (sent in the equipped payload), so a fast weapon both resolves and
    // animates quicker. Future haste items would multiply in here too.
    entry.attackSpeed = we && we.slot === 'weapon' && we.attackSpeed > 0 ? we.attackSpeed : 1;
    // Status-inflict spec the equipped weapon carries ([{type, chance}], sanitized).
    // null = nothing authored → npcSim applies the baseline paralysis proc, so
    // unauthored weapons / bare hands behave exactly as before. An authored spec
    // overrides it (e.g. a weapon that procs sleep instead of paralysis).
    const wInf = status.normalizeInflict(we && we.slot === 'weapon' ? we.inflict : null);
    entry.weaponInflict = wInf.length ? wInf : null;
    // Ranged-weapon reach (px): a gun fires a forward shot this far; 0 = melee.
    entry.weaponRange = we && we.slot === 'weapon' && we.ranged ? we.range | 0 : 0;
    // Projectile shape for a ranged weapon: travel speed (px/tick), whether the
    // shot pierces (hits every target in its path vs the first), and its on-screen
    // look. npcSim picks a default speed when 0. All inert for melee weapons.
    const rng2 = we && we.slot === 'weapon' && we.ranged;
    entry.weaponProjSpeed = rng2 && we.projSpeed > 0 ? we.projSpeed : 0;
    entry.weaponPierce = !!(rng2 && we.pierce);
    entry.weaponProjSprite = rng2 ? we.projSprite || null : null;
    let def = 0;
    for (const s of ['body', 'arms', 'other']) {
      const id = entry.equipped[s];
      const e = id ? this.GOODS[id] && this.GOODS[id].equip : null;
      if (e && e.slot === s) def += e.defense | 0;
    }
    entry.armorDefense = def;
    entry.itemId = entry.equipped.weapon; // held sprite = weapon
  }

  // A PNG data-URL sheet, capped so a hostile client can't make every join
  // broadcast megabytes. Returns the string or null.
  _validAppearance(a) {
    return typeof a === 'string' && a.length <= 65536 ? a : null;
  }

  // Anonymous / dev join: a fresh ephemeral player from the join message. This
  // is the existing char-select path (and what the tests drive) — nothing is
  // persisted, every join starts at level 1.
  _anonInit(playerId, msg) {
    return {
      name: msg.name || `Player${playerId}`,
      spriteGroupId: msg.spriteGroupId || 1,
      appearance: this._validAppearance(msg.appearance),
      progression: progressionFromAlloc(defaultAlloc(), 1, 0),
      inventory: [...this.STARTING_INVENTORY],
      money: STARTING_MONEY, // on-hand cash (shops spend this)
      bank: 0, // ATM balance — kill money lands here; withdraw to spend
      // Running tallies for Dad's phone report: money banked from kills and cash
      // spent at shops since the last time the player called Dad (reset on call).
      earnedSinceCall: 0,
      spentSinceCall: 0,
      equipped: { weapon: null, body: null, arms: null, other: null },
      hotbar: new Array(HOTBAR_SLOTS).fill(null),
      x: this.SPAWN.x,
      y: this.SPAWN.y,
      direction: this.SPAWN.dir || 0,
      characterId: null,
      alloc: defaultAlloc(),
      unspentPoints: 0,
      flags: [],
      pk: false,
      pkLockMs: 0,
      // EB naming flavor (anon players never set these); mom's food cooldown.
      favoriteThing: '',
      favoriteFood: '',
      momFoodReadyAt: 0,
    };
  }

  // Signed-in join: validate the session, load the character it owns, and rebuild
  // its world state from the save. Returns null if the token/character is invalid
  // or not owned by the session's account. Combat stats are RE-DERIVED from the
  // saved alloc (never trusted as raw numbers); inventory/equip are re-validated
  // against the live catalog.
  async _loadCharacterInit(token, characterId) {
    const session = await this.store.getSession(token, Date.now());
    if (!session) return null;
    const character = await this.store.getCharacter(Number(characterId));
    if (!character || character.accountId !== session.accountId) return null;
    // Server-verified account role ('player' | 'dev' | 'admin') — drives the
    // dev unlock bypass (devUnlockAll). Loaded here, never trusted from the client.
    // Guarded so older Store impls (test mocks) without getAccountById still join.
    const account = this.store.getAccountById
      ? await this.store.getAccountById(session.accountId)
      : null;
    const role = account && typeof account.role === 'string' ? account.role : 'player';

    const save = character.save && typeof character.save === 'object' ? character.save : {};
    const level = Number.isInteger(save.level) && save.level >= 1 ? save.level : 1;
    // Validate the alloc AGAINST the level: a leveled build's stats grow past the
    // creation spread (spent skill points), so the creation-strict sanitizeAlloc
    // would reset it to default and silently wipe every spent point on reload.
    const alloc = sanitizeBuild(save.alloc, level);
    const exp = Number.isInteger(save.exp) && save.exp >= 0 ? save.exp : 0;

    const inventory = Array.isArray(save.inventory)
      ? save.inventory.filter((id) => this.GOODS[id])
      : [...this.STARTING_INVENTORY];
    const money = Number.isInteger(save.money) ? save.money : STARTING_MONEY;
    const bank = Number.isInteger(save.bank) && save.bank >= 0 ? save.bank : 0;
    // Dad's-report tallies survive relogging so a reconnect doesn't make Dad
    // forget what he banked / you spent since the last call.
    const earnedSinceCall =
      Number.isInteger(save.earnedSinceCall) && save.earnedSinceCall >= 0
        ? save.earnedSinceCall
        : 0;
    const spentSinceCall =
      Number.isInteger(save.spentSinceCall) && save.spentSinceCall >= 0 ? save.spentSinceCall : 0;

    // Worn gear is stored SEPARATELY from Goods now, so validate it by item
    // type + slot (not by inventory membership), then pull any equipped id back
    // OUT of the loaded Goods — which also migrates old saves that kept a worn
    // item in both places (it would otherwise show in the bag while equipped).
    const equipped = { weapon: null, body: null, arms: null, other: null };
    if (save.equipped && typeof save.equipped === 'object') {
      for (const s of ['weapon', 'body', 'arms', 'other']) {
        const id = save.equipped[s];
        const eq = id && this.GOODS[id] && this.GOODS[id].equip;
        if (eq && eq.slot === s) {
          equipped[s] = id;
          const i = inventory.indexOf(id);
          if (i !== -1) inventory.splice(i, 1);
        }
      }
    }

    return {
      hotbar: this._sanitizeHotbar(save.hotbar),
      name: character.name,
      spriteGroupId: character.spriteGroupId,
      appearance: this._validAppearance(character.appearance),
      progression: progressionFromAlloc(alloc, level, exp),
      inventory,
      money,
      bank,
      earnedSinceCall,
      spentSinceCall,
      equipped,
      x: Number.isFinite(save.x) ? save.x : this.SPAWN.x,
      y: Number.isFinite(save.y) ? save.y : this.SPAWN.y,
      direction: Number.isInteger(save.direction) ? save.direction : this.SPAWN.dir || 0,
      characterId: character.id,
      accountId: session.accountId,
      alloc,
      unspentPoints:
        Number.isInteger(save.unspentPoints) && save.unspentPoints >= 0 ? save.unspentPoints : 0,
      flags: Array.isArray(save.flags) ? save.flags.filter((n) => Number.isInteger(n)) : [],
      // PK mode + its enable-lock survive relogging (you can't escape PK by
      // disconnecting). pkLockMs is REMAINING in-game ms — it only counts down
      // while online, so it resumes (paused) right where it left off.
      pk: !!save.pk,
      pkLockMs: Number.isFinite(save.pkLockMs) ? save.pkLockMs : 0,
      // EB naming prompts (set at creation) + mom's food cooldown (epoch ms),
      // persisted so the timer can't be reset by relogging.
      favoriteThing: typeof save.favoriteThing === 'string' ? save.favoriteThing : '',
      favoriteFood: typeof save.favoriteFood === 'string' ? save.favoriteFood : '',
      momFoodReadyAt: Number.isFinite(save.momFoodReadyAt) ? save.momFoodReadyAt : 0,
      role,
    };
  }

  // Validate a saved/echoed hotbar into a fixed-length array of: null, a known
  // GOODS id (weapon or usable item — never armor), or a 'psi:<id>' tag for a
  // known PSI move. Lenient on inventory membership (a PSI isn't an inventory
  // item, and an equipped weapon is re-synced client-side), strict on the id
  // existing so a tampered/garbage hotbar never persists.
  _sanitizeHotbar(arr) {
    const out = new Array(HOTBAR_SLOTS).fill(null);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const id = arr[i];
      if (typeof id !== 'string' || id.length > 32) continue;
      if (id.startsWith(HOTBAR_PSI_TAG)) {
        if (this.PSI[id.slice(HOTBAR_PSI_TAG.length)]) out[i] = id;
      } else {
        const good = this.GOODS[id];
        const armor = good && good.equip && good.equip.slot !== 'weapon';
        if (good && !armor) out[i] = id;
      }
    }
    return out;
  }

  // Decrement a player's PK lock by the IN-GAME time elapsed since the last tick.
  // Only ever called while the player is connected, so the wall-clock delta IS
  // in-game time; the lock pauses while offline because pkTickAt is reset to now
  // on (re)join. Idempotent — safe to call before any read of pkLockMs.
  _tickPkLock(entry) {
    if (!entry) return;
    const now = Date.now();
    if (entry.pkLockMs > 0) {
      entry.pkLockMs = Math.max(0, entry.pkLockMs - (now - (entry.pkTickAt || now)));
    }
    entry.pkTickAt = now;
  }

  // Write a signed-in player's mutable state back to its character row. No-op for
  // anonymous players (no handle in this.saves) or when there's no store.
  _saveCharacter(playerId) {
    const handle = this.saves.get(playerId);
    const p = this.players.get(playerId);
    if (!handle || !p || !this.store) return;
    this._tickPkLock(p); // bank the in-game time served so the saved lock is current
    const prog = this.points.get(playerId);
    // Snapshot ALL state synchronously — the caller may delete the player right
    // after (disconnect), and the actual write is deferred/queued below.
    const save = {
      alloc: prog ? prog.alloc : handle.alloc,
      level: p.level,
      exp: p.exp,
      unspentPoints: prog ? prog.unspentPoints || 0 : 0,
      inventory: [...p.inventory],
      money: p.money,
      bank: p.bank,
      earnedSinceCall: p.earnedSinceCall | 0,
      spentSinceCall: p.spentSinceCall | 0,
      equipped: { ...p.equipped },
      hotbar: Array.isArray(p.hotbar) ? [...p.hotbar] : new Array(HOTBAR_SLOTS).fill(null),
      x: p.x,
      y: p.y,
      direction: p.direction,
      flags: [...(this.flags.get(playerId) || [])],
      pk: !!p.pk,
      pkLockMs: p.pkLockMs || 0,
      // Preserve the EB naming flavor + advance mom's food cooldown.
      favoriteThing: p.favoriteThing || '',
      favoriteFood: p.favoriteFood || '',
      momFoodReadyAt: p.momFoodReadyAt || 0,
    };
    return this._persistCharacterSave(handle.characterId, save);
  }

  // Queue a character's save behind any in-flight save for the SAME character, so
  // writes land in submission order even with an async store. Errors are caught
  // (a failed save must never crash the host or break the chain). Returns the
  // tail promise so flushSaves()/tests can await durability.
  _persistCharacterSave(characterId, save) {
    const prev = this._saveChains.get(characterId) || Promise.resolve();
    const next = prev
      .catch(() => {}) // a prior failure must not poison later saves
      .then(() => this.store.updateCharacterSave(characterId, save, Date.now()))
      .catch((e) => console.error('[save] failed for character', characterId, e));
    this._saveChains.set(characterId, next);
    // Drop the chain entry once it's the settled tail, so the map doesn't grow.
    next.finally(() => {
      if (this._saveChains.get(characterId) === next) this._saveChains.delete(characterId);
    });
    return next;
  }

  // Await every outstanding character save. Call before process exit (SIGTERM)
  // so a disconnect/level-up write isn't dropped mid-flight; tests use it to read
  // a save back deterministically.
  async flushSaves() {
    await Promise.allSettled([...this._saveChains.values()]);
  }

  // Send a message to a single player's socket (private state like skill points).
  sendTo(playerId, data) {
    const entry = this.players.get(playerId);
    if (entry && entry._ws.readyState === 1) entry._ws.send(JSON.stringify(data));
  }

  // Push a player their authoritative banked points + current alloc (drives the
  // level-up icon + the spend pentagon). Private to the owner; works for anon too.
  _sendPoints(playerId) {
    const prog = this.points.get(playerId);
    if (!prog) return;
    this.sendTo(playerId, {
      type: 'points_update',
      points: prog.unspentPoints || 0,
      alloc: prog.alloc,
    });
  }

  // Recompute a player's combat stats from a (server-side) allocation after a
  // spend, keeping their current level/exp and clamping live HP/PP to the new
  // caps (so spending a point doesn't full-heal). Authoritative.
  reapplyAlloc(p, alloc) {
    const block = progressionFromAlloc(alloc, p.level, p.exp);
    const hp = Math.min(p.hp, block.maxHp);
    const pp = Math.min(p.pp, block.ppMax);
    const stamina = Math.min(p.stamina ?? block.staminaMax, block.staminaMax);
    Object.assign(p, block);
    p.hp = hp;
    p.pp = pp;
    p.stamina = stamina;
    this.recomputeEquipStats(p);
  }

  // Apply a full build (level + creation/level-up allocation) to a player and top
  // them up to the new caps. Used by the bot fleet to give simulated players a
  // random level/build — they get the SAME server-authoritative progression a real
  // player of that level would (reapplyAlloc → deriveCombatStats + replayed growth).
  applyBuild(playerId, level, alloc) {
    const entry = this.players.get(playerId);
    const pts = this.points.get(playerId);
    if (!entry || !pts) return false;
    entry.level = Math.max(1, level | 0);
    entry.exp = expToReach(entry.level);
    pts.alloc = { ...alloc };
    pts.unspentPoints = 0;
    this.reapplyAlloc(entry, pts.alloc); // re-derive combat stats at the new level
    entry.hp = entry.maxHp; // bots spawn at full readiness
    entry.pp = entry.ppMax;
    entry.stamina = entry.staminaMax;
    return true;
  }

  // True if player `entry` is within INTERACT_REACH of a live static interactable
  // (clerk/ATM) that `matchFn` accepts. The sim owns the anchor positions; we
  // measure against the player's tracked position. NOTE: that position is itself
  // client-reported (movement is client-authoritative today), so this stops the
  // trivial "transact from anywhere" cheat but isn't fully airtight until
  // server-authoritative movement lands — see ARCHITECTURE.md netcode.
  _nearInteractable(entry, matchFn) {
    if (!entry) return false;
    const r2 = INTERACT_REACH * INTERACT_REACH;
    for (const a of this.npcSim.interactableAnchors()) {
      if (!matchFn(a)) continue;
      const dx = a.x - entry.x;
      const dy = a.y - entry.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  /** Is the player at an ATM (a static NPC with an ATM sprite within reach)? */
  _nearAtm(entry) {
    return this._nearInteractable(entry, (a) => ATM_SPRITE_GROUPS.has(a.sprite));
  }

  // Apply ONE client input (= one client frame) to a player, AUTHORITATIVELY:
  // mirror src/engine/Player.update movement (speed from stats, axis-separated
  // slide) against npcSim.playerBlocked. Deterministic + identical to the client's
  // local prediction, so reconciliation is a no-op in the common case.
  _stepPlayer(entry, input) {
    const dx = input.dx;
    const dy = input.dy;
    if (dx === 0 && dy === 0) {
      // Idle frame: reset the walk cycle (mirror Entity.resetAnimation).
      entry.frame = 0;
      entry._animTimer = 0;
      entry.pose = 'walk';
      return;
    }
    entry.direction = dirFromInput(dx, dy);
    entry.pose = 'walk';
    const diagonal = dx !== 0 && dy !== 0;
    // Run only if the client held Shift AND there's stamina to burn; drain it per
    // step (authoritative — the client predicts the same drain). Out of stamina =
    // walk speed, no matter the Shift state.
    const running = !!input.run && !entry.winded && (entry.stamina ?? 0) > 0;
    let base = moveSpeedFor(entry.speed);
    if (running) {
      base *= RUN_MULT;
      entry.stamina = Math.max(0, (entry.stamina ?? 0) - RUN_DRAIN_PER_STEP);
      if (entry.stamina <= 0) entry.winded = true; // must catch your breath (recover to 20%)
    }
    const sp = diagonal ? base * SQRT1_2 : base;
    const lvl = entry.level || 1;
    // Start-of-step foot box (the "already inside → let out" reference, like the client).
    const curX = entry.x - PLAYER_COL_W / 2;
    const curY = entry.y + PLAYER_COL_OY;
    const sim = this.npcSim;
    const nx = entry.x + dx * sp;
    const ny = entry.y + dy * sp;
    if (!sim.playerBlocked(nx - PLAYER_COL_W / 2, ny + PLAYER_COL_OY, lvl, curX, curY)) {
      entry.x = nx;
      entry.y = ny;
    } else {
      const hx = entry.x + dx * sp; // horizontal-only retry (entry.x still original here)
      if (!sim.playerBlocked(hx - PLAYER_COL_W / 2, entry.y + PLAYER_COL_OY, lvl, curX, curY)) {
        entry.x = hx;
      }
      const vy = entry.y + dy * sp; // vertical-only retry (uses possibly-updated entry.x)
      if (!sim.playerBlocked(entry.x - PLAYER_COL_W / 2, vy + PLAYER_COL_OY, lvl, curX, curY)) {
        entry.y = vy;
      }
    }
    // 2-frame walk cycle (mirror Entity.stepAnimation).
    entry._animTimer = (entry._animTimer || 0) + 1;
    if (entry._animTimer >= ANIM_INTERVAL) {
      entry._animTimer = 0;
      entry.frame = entry.frame === 1 ? 0 : 1;
    }
  }

  // Server movement tick: drain each player's queued inputs (in order), step them
  // authoritatively, broadcast the result, and ACK the last-processed input seq to
  // the owner so its client can reconcile its prediction. Players with no queued
  // inputs are untouched — so the legacy client-position `move` path (still used
  // until the client cuts over to inputs) is unaffected.
  _simPlayers() {
    const now = Date.now();
    // Smoothed actual tick interval → effective server Hz (reported in the pong).
    // The player + NPC sims share one event loop, so when the box is CPU-bound this
    // interval stretches past SIM_TICK_MS — the client-visible signal that a laggy
    // experience is the SERVER slipping, not the network (so no client tuning helps).
    const rawDt = this._lastSimAt ? now - this._lastSimAt : SIM_TICK_MS;
    // Mean tick interval (→ srvHz) AND its jitter (mean abs deviation → srvJit). The
    // jitter is how IRREGULARLY we tick; the client folds it into its interp buffer so
    // a slipped/bursty tick doesn't underrun (coast). Deviation measured vs the prior
    // mean, before updating it.
    const prevMean = this._simIntervalEma || rawDt;
    this._simIntervalEma = this._simIntervalEma ? this._simIntervalEma * 0.9 + rawDt * 0.1 : rawDt;
    const tickDev = Math.abs(rawDt - prevMean);
    this._simJitterEma =
      this._simJitterEma != null ? this._simJitterEma * 0.9 + tickDev * 0.1 : tickDev;
    // Time-based step budget. Real time — not a fixed per-tick count — decides how
    // many 60Hz movement steps this tick may apply. setInterval(SIM_TICK_MS) drifts
    // late under GC / a busy prod CPU; with a hard 2-steps cap the server then
    // drained slower than an honest client's 60Hz input stream, so the queue (and
    // every remote viewer's picture of that player) fell permanently behind —
    // multi-second lag in prod though it was crisp locally. We accumulate elapsed
    // real time into whole steps (carrying the remainder so rounding never drifts),
    // clamp a single tick's catch-up to MAX_STEPS_BURST, and drop surplus past the
    // clamp — mirroring the client's own accumulator (Game.ts). Steps stay bounded
    // by the wall clock, so a high-refresh or flooding client can't speedhack.
    // Floor at one frame so a tick always credits at least ~1 step's worth of
    // time (prod ticks are ≥SIM_TICK_MS apart, so the floor is inert there; it
    // only matters when _simPlayers is driven back-to-back, e.g. the host tests).
    // Cap at 250ms so a long stall resumes at real time, not a teleport.
    const dt = Math.min(
      250,
      Math.max(SIM_FRAME_MS, this._lastSimAt ? now - this._lastSimAt : SIM_TICK_MS)
    );
    this._lastSimAt = now;
    // Stamina regen for EVERY player (idle ones skip the move loop below, but
    // still recharge). Running drains it per-step in _stepPlayer; net = regen −
    // drain. Owner gets a throttled sync so its predicted bar stays honest.
    const staSec = dt / 1000;
    prof.begin();
    for (const [, e] of this.players) {
      if (e.editor) continue;
      const smax = e.staminaMax || 0;
      if (smax > 0) {
        const cur = e.stamina ?? smax;
        if (cur < smax) e.stamina = Math.min(smax, cur + (e.staminaRegen || 0) * staSec);
        // Catch your breath: a winded player can run again once recharged to 20%.
        if (e.winded && e.stamina >= smax * RUN_RECOVER_FRAC) e.winded = false;
      }
      this._maybeSendStamina(e, now);
      // Passive PP regen: a slow trickle fueled by Mental + Spirit (ppRegen),
      // throttled to PP_COMBAT_FRAC for a few seconds after a cast/hit. Accumulate
      // fractionally but commit only WHOLE points so the integer pp the client sees
      // (statsPayload.pp) stays clean; push a stats update to the owner on a tick.
      const pmax = e.ppMax || 0;
      if (pmax > 0 && (e.pp ?? pmax) < pmax) {
        const inCombat = now - (e._combatAt || 0) < PP_COMBAT_WINDOW_MS;
        const rate = (e.ppRegen || 0) * (inCombat ? PP_COMBAT_FRAC : 1);
        e._ppAccum = (e._ppAccum || 0) + rate * staSec;
        const whole = Math.floor(e._ppAccum);
        if (whole > 0) {
          e._ppAccum -= whole;
          e.pp = Math.min(pmax, (e.pp ?? 0) + whole);
        }
      } else {
        e._ppAccum = 0; // full (or no pool) — don't bank regen toward the next drain
      }
      // Throttled PP sync (mirror of stamina): the client predicts the smooth fill
      // (tickPp) and eases toward this authoritative value (onPlayerPp → reconcilePp),
      // so we send a tiny message ~5/s instead of a full player_stats per regen tick.
      this._maybeSendPp(e, now);
    }
    prof.lap('playerRegen');
    this._stepAccum = (this._stepAccum || 0) + dt / SIM_FRAME_MS;
    let stepBudget = Math.floor(this._stepAccum);
    if (stepBudget > MAX_STEPS_BURST) {
      stepBudget = MAX_STEPS_BURST;
      this._stepAccum = 0; // resumed stall: take the wall-clock rate, don't bank a flood
    } else {
      this._stepAccum -= stepBudget;
    }
    for (const [id, entry] of this.players) {
      const q = entry._inputs;
      if (!q || q.length === 0) continue;
      if (entry.editor) {
        q.length = 0;
        continue;
      }
      // Frozen (paralysis/sleep/diamond), mid door-fade, or KO'd (bleeding out /
      // laid out downed): consume the inputs but don't move (mirror the client's
      // frozen/warp/KO holds), so seq still advances. Without the dying/downed gate
      // a knocked-out player still slid around if inputs kept arriving — visible as
      // KO'd bodies sliding on their sides (a bot feeding inputs surfaced it, but a
      // real client spamming movement while downed had the same hole).
      const held =
        status.isActionBlocked(entry, now) ||
        (entry.warping && now < entry.warpUntil) ||
        entry.dying ||
        entry.downed;
      let lastSeq = entry._ackSeq || 0;
      let x0 = entry.x;
      let y0 = entry.y;
      if (held) {
        // Frozen / mid door-fade: consume the whole queue without moving, so the
        // seq still advances (the client's frozen/warp hold mirrors this).
        lastSeq = q[q.length - 1].seq;
        q.length = 0;
      } else {
        // Apply at most this tick's wall-clock-earned step budget. Any surplus
        // inputs (a high-refresh or flooding client) stay queued, bounded by
        // MAX_INPUT_QUEUE, and drain as later ticks earn more budget. Honest play
        // never out-runs the budget, so packet bunching just drains smoothly while
        // a speedhack is throttled to real time.
        let applied = 0;
        for (const input of q) {
          if (applied >= stepBudget) break;
          this._stepPlayer(entry, input);
          lastSeq = input.seq;
          applied++;
        }
        q.splice(0, applied);
      }
      entry._ackSeq = lastSeq;
      const moved = entry.x !== x0 || entry.y !== y0;
      // Keep the AOI cell current; on a cell crossing, reconcile spawn/despawn.
      if (moved && this.aoi.update(id, entry.x, entry.y)) this._refreshAoi(id);
      // Tell the OWNER the authoritative spot + which input it reflects (reconcile).
      if (entry._ws) {
        entry._ws.send(
          JSON.stringify({
            type: 'pos',
            x: entry.x,
            y: entry.y,
            direction: entry.direction,
            frame: entry.frame,
            seq: lastSeq,
          })
        );
      }
      // Tell everyone else (remote interpolation). Positional firehose → routed
      // to the mover's viewers (AOI) or broadcastExcept (off) — identical until
      // AOI_ENABLED is flipped on.
      if (moved || held) {
        this._publishMove(id, entry, {
          type: 'player_move',
          id,
          x: entry.x,
          y: entry.y,
          direction: entry.direction,
          frame: entry.frame,
          pose: entry.pose || 'walk',
        });
      }
    }
    prof.lap('playerMove');
  }

  // Owner-only stamina sync (reconciliation for the client's predicted bar).
  // Throttled to ~5/s, with a 1s heartbeat when idle, so the cost is one tiny
  // message per player and the predicted value never drifts for long.
  _maybeSendStamina(entry, now) {
    if (!entry._ws) return;
    const v = entry.stamina ?? 0;
    const w = !!entry.winded;
    const since = now - (entry._staminaSentAt || 0);
    if (since < 180) return; // throttle: at most ~5/s
    const changed = Math.abs(v - (entry._staminaSent ?? -1e9)) >= 1 || w !== entry._windedSent;
    if (!changed && since < 1000) return; // idle: heartbeat once a second
    entry._staminaSent = v;
    entry._windedSent = w;
    entry._staminaSentAt = now;
    entry._ws.send(
      JSON.stringify({ type: 'player_stamina', s: Math.round(v), m: entry.staminaMax || 0, w })
    );
  }

  // Owner-only PP sync (reconciliation for the client's predicted bar). Same shape
  // as stamina: throttled ~5/s with a 1s idle heartbeat, one tiny message per player.
  _maybeSendPp(entry, now) {
    if (!entry._ws) return;
    const v = Math.round(entry.pp ?? 0);
    const since = now - (entry._ppSentAt || 0);
    if (since < 180) return; // throttle: at most ~5/s
    if (v === entry._ppSent && since < 1000) return; // idle: heartbeat once a second
    entry._ppSent = v;
    entry._ppSentAt = now;
    entry._ws.send(JSON.stringify({ type: 'player_pp', pp: v, max: entry.ppMax || 0 }));
  }

  /** Is the player at a shop clerk? `store` null = any clerk (sell works at any
   *  shop); a number requires the clerk that runs THAT store (buy). */
  _nearShop(entry, store) {
    return this._nearInteractable(entry, (a) => {
      const m = this.npcShops[String(a.npcId)];
      return !!m && (store == null || m.store === store);
    });
  }

  // Apply an enemy's landed hit to a player (server-authoritative HP). Broadcast
  // the new HP so every client updates that player's bar; the victim's own
  // client plays the hurt pose. At 0 HP the player respawns at the spawn point.
  // Push a player to a sim-computed spot with NO damage (a vehicle clipping a
  // friendly out of its lane). Same client-honored hint as a knockback move.
  shovePlayer(playerId, spot) {
    const p = this.players.get(playerId);
    if (!p || p.hp <= 0 || p.editor || !spot) return;
    if (p.warping && Date.now() < p.warpUntil) return;
    p.x = spot.x;
    p.y = spot.y;
    this._publishPlayerEvent({ type: 'player_push', id: playerId, x: p.x, y: p.y });
  }

  damagePlayer(playerId, dmg, knock, inflict, byNpc) {
    const p = this.players.get(playerId);
    if (!p || p.hp <= 0) return;
    if (p.editor) return; // out of the world in the dev editor — untargetable
    if (p.dying) return; // bleeding out from a mortal blow — invulnerable until it resolves
    // Shielded mid door-transition: the player is a frozen ghost at the doorway
    // and can't move or defend, so enemy swings whiff (see player.warping).
    if (p.warping && Date.now() < p.warpUntil) return;
    p._combatAt = Date.now(); // taking a hit throttles PP regen (in combat)
    // Defense softens incoming hits (stat defense + equipped armor + any active
    // defense buff); always at least 1 so leveling/gear never makes a player
    // untouchable.
    const defBuff = buffs.buffBonus(p, 'defense', Date.now());
    const eff = Math.max(
      1,
      dmg - Math.floor(((p.defense || 0) + (p.armorDefense || 0) + defBuff) / 2)
    );
    const newHp = p.hp - eff;
    if (newHp > 0) {
      // Survivable hit — apply instantly (the client bar still rolls it down for
      // feel; gameplay-wise it's settled).
      p.hp = newHp;
      this._publishPlayerEvent({
        type: 'player_hp',
        id: playerId,
        hp: p.hp,
        maxHp: p.maxHp,
        dmg: eff,
        // Attacker NPC id (enemy hits only): lets the victim's client lunge that
        // enemy into range so the hit reads as a connect, not a swing from a tile away.
        ...(byNpc != null ? { byNpc } : {}),
      });
      this._applyHitStatuses(p, inflict); // break sleep + roll any inflicts
      if (knock) {
        // Knocked back (and lived): the sim already collision-clamped the landing
        // spot. Move our authoritative record and broadcast a push — the victim's
        // client snaps itself there (and reports from there), others snap the
        // remote copy. Player movement is client-authoritative, so this is a hint
        // the client honors, same trust model as ordinary moves.
        p.x = knock.x;
        p.y = knock.y;
        this._publishPlayerEvent({ type: 'player_push', id: playerId, x: p.x, y: p.y });
      }
      return;
    }
    // LETHAL blow → don't drop instantly. Start the EB rolling-HP death: the meter
    // rolls to 0 over a few seconds while the player stays UP and can heal to
    // survive (use_item/use_psi `dying` branch). The laying KO (and its rotate +
    // fling "death throw", see client KoThrow) is deferred to the roll's end
    // (_mortalExpired → _enterDowned). Stash the blow's direction now (from the
    // sim's knockback landing = the spot away from the attacker) + its force, so
    // the collapse can fling the body the right way. No knock (DoT) → in-place.
    if (knock) {
      const kdx = knock.x - p.x;
      const kdy = knock.y - p.y;
      const klen = Math.hypot(kdx, kdy) || 1;
      p.koDx = kdx / klen;
      p.koDy = kdy / klen;
    } else {
      p.koDx = 0;
      p.koDy = 0;
    }
    p.koForce = eff;
    this._enterDying(playerId, p, eff);
  }

  /** Begin the rolling-HP "Mortal Damage" window. The player keeps `hp` (stays
   *  conscious + able to act/heal); `hpReal` carries the true post-hit total (≤0)
   *  that a heal must lift back above 0 to survive. The visible roll + banner are
   *  client-driven from `player_mortal`; the death deadline is `dyingUntil`. */
  _enterDying(playerId, p, eff) {
    const now = Date.now();
    const fromHp = p.hp; // > 0
    const ms = Math.max(
      MORTAL_MIN_MS,
      Math.min(
        MORTAL_DRAIN_FULL_MS,
        Math.round((fromHp / Math.max(1, p.maxHp)) * MORTAL_DRAIN_FULL_MS)
      )
    );
    p.dying = true;
    p.hpReal = fromHp - eff; // ≤ 0 — heal must out-pace the overkill to save you
    p.dyingUntil = now + ms;
    const banner = ms >= MORTAL_BANNER_MS;
    this.broadcastAll({
      type: 'player_mortal',
      id: playerId,
      fromHp,
      maxHp: p.maxHp,
      ms,
      banner,
      dmg: eff,
    });
  }

  /** The mortal roll ran out without a save → the meter hit 0. Lay them out into
   *  the normal KO/downed window (ally/self revive still possible). */
  _mortalExpired(playerId, p) {
    p.dying = false;
    p.dyingUntil = 0;
    p.hp = 0;
    if (!p.downed) this._enterDowned(playerId, p);
  }

  /** Restore HP, honoring an in-progress mortal roll. While `dying`, HP lives on
   *  `hpReal` (can be ≤0); a heal that lifts it above 0 SAVES the player — the roll
   *  cancels and they stay standing. Otherwise it's an ordinary heal. Broadcasts
   *  `player_hp` (heal) so clients pop the green number + settle/stop the bar.
   *  Returns the HP actually restored. */
  healPlayer(p, amount) {
    if (p.dying) {
      const shown = Math.max(0, p.hpReal); // what the meter would read (clamped ≥0)
      p.hpReal = Math.min(p.maxHp, p.hpReal + amount);
      if (p.hpReal > 0) {
        // Out-healed the mortal blow in time — survive, still on your feet.
        p.dying = false;
        p.dyingUntil = 0;
        p.hp = p.hpReal;
        const healed = p.hp - shown;
        this.broadcastAll({
          type: 'player_hp',
          id: p.id,
          hp: p.hp,
          maxHp: p.maxHp,
          dmg: 0,
          heal: Math.max(0, healed),
        });
        return healed;
      }
      return 0; // healed but still below zero — keep bleeding out
    }
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + amount);
    const healed = p.hp - before;
    if (healed > 0) {
      this.broadcastAll({
        type: 'player_hp',
        id: p.id,
        hp: p.hp,
        maxHp: p.maxHp,
        dmg: 0,
        heal: healed,
      });
    }
    return healed;
  }

  /** HP hit 0 → lay the player out (KO) for DOWNED_MS instead of dying. Clears
   *  DoT/buffs (they're unconscious) and tells everyone: remotes draw the laying
   *  pose, the owner gets the countdown + closing vignette. The cash-drop penalty
   *  is DEFERRED to _trueDeath, so an ally revive within the window costs nothing. */
  _enterDowned(playerId, p) {
    p.hp = 0;
    p.downed = true;
    p.downedUntil = Date.now() + DOWNED_MS;
    p.pose = 'walk';
    p.frame = 0;
    status.clearAll(p);
    buffs.clearBuffs(p);
    this._broadcastPlayerStatus(p);
    this._sendPlayerBuffs(p);
    // Carry the killing blow's direction + force so every client plays the same
    // rotate-and-fling KO throw as the body collapses (client KoThrow). Defaults
    // to 0 (rotate in place) for a downing with no recorded knockback.
    this.broadcastAll({
      type: 'player_downed',
      id: playerId,
      ms: DOWNED_MS,
      dx: p.koDx || 0,
      dy: p.koDy || 0,
      force: p.koForce || 0,
    });
    p.koDx = p.koDy = p.koForce = 0; // consumed
  }

  /** Resolve a downed player into TRUE death: apply the cash-drop penalty, then
   *  full-heal + respawn at the spawn point. Fired when the 30s window elapses or
   *  the player gives up the ghost. No-op if they're not (still) downed. */
  _trueDeath(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.downed) return;
    p.downed = false;
    p.downedUntil = 0;
    // Death penalty: drop half on-hand cash where they fell (bank is safe), as a
    // first-touch pickup. Spawn it before the respawn teleport moves p.
    const dropped = Math.floor((p.money | 0) * DEATH_CASH_PCT);
    if (dropped > 0) {
      p.money -= dropped;
      if (p._ws) p._ws.send(JSON.stringify({ type: 'money', money: p.money }));
      // Fountain the dropped cash out of the corpse as up to 20 "cash object"
      // pickups (the c001 item art), each worth an even share of `dropped`.
      this.npcSim.spawnCashFountain(p.x, p.y, dropped, DEATH_CASH_ITEM, DEATH_CASH_MAX_OBJECTS);
    }
    p.hp = p.maxHp;
    p.x = this.SPAWN.x;
    p.y = this.SPAWN.y;
    p.direction = this.SPAWN.dir || 0;
    p.frame = 0;
    p.pose = 'walk';
    status.clearAll(p);
    buffs.clearBuffs(p);
    this._sendPlayerBuffs(p);
    this.npcSim.noteRespawn(playerId); // exempt this teleport from enemy door-warp follow
    // Dying inside an event drops you from its party so the end-of-event sweep
    // won't yank you to the exit — you've just respawned at the spawn point above.
    if (this.eventRuntime) this.eventRuntime.onPlayerDeath(playerId);
    this.broadcastAll({ type: 'player_respawn', id: playerId, x: p.x, y: p.y, dir: p.direction });
    this._publishPlayerEvent({ type: 'player_hp', id: playerId, hp: p.hp, maxHp: p.maxHp, dmg: 0 });
    this._broadcastPlayerStatus(p);
    this._saveCharacter(playerId);
  }

  /** Revive a downed player IN PLACE to `hp` HP (clamped ≥1). Cancels the KO; every
   *  client stands them back up (player_revived) and the owner's vignette lifts. */
  _reviveDowned(p, hp) {
    if (!p || !p.downed) return;
    p.downed = false;
    p.downedUntil = 0;
    p.hp = Math.min(p.maxHp, Math.max(1, hp | 0));
    p.pose = 'walk';
    p.frame = 0;
    this.broadcastAll({ type: 'player_revived', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
    this.broadcastAll({
      type: 'player_hp',
      id: p.id,
      hp: p.hp,
      maxHp: p.maxHp,
      dmg: 0,
      heal: p.hp,
    });
    this._broadcastPlayerStatus(p);
    this._saveCharacter(p.id);
  }

  /** Find the downed player nearest to (x,y) within REVIVE_RANGE, or null. Used to
   *  resolve a proximity revive (and to validate a clicked target's range). */
  _nearestDownedWithin(x, y, range = REVIVE_RANGE) {
    let best = null;
    let bestD2 = range * range;
    for (const q of this.players.values()) {
      if (!q.downed) continue;
      const dx = q.x - x;
      const dy = q.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = q;
      }
    }
    return best;
  }

  // Apply a landed hit's status side-effects to a player: any "breaks on hit"
  // status (Sleep) clears, then each `inflict` {type, chance} is rolled against
  // the status engine (immunity-gated). On a successful proc, broadcast a
  // `status_applied` (drives the floating battle-text + SFX + the local input
  // lock); re-broadcast the active set whenever it changed. `inflict` may be
  // null (a plain hit) — Sleep still breaks. Per-element vulnerability/resist
  // (ROM table) is a TODO; for now `chance` is the attack's flat proc odds.
  _applyHitStatuses(p, inflict) {
    const now = Date.now();
    const before = status.activeStatuses(p, now).join(',');
    status.breakOnHit(p, now); // a hit wakes a sleeper
    for (const inf of inflict || []) {
      // Element-scale by the player's resist for the status' element. Players
      // have no vuln table yet (EB resistance is gear-based, not level-based —
      // a TODO needing community item data), so this is 100% for now.
      const eff = inf.chance * (this._playerVuln(p, status.elementOf(inf.type)) / 100);
      if (status.tryInflict(p, inf.type, eff, now, Math.random)) {
        const def = status.defOf(inf.type) || {};
        this.broadcastAll({
          type: 'status_applied',
          id: p.id,
          x: Math.round(p.x),
          y: Math.round(p.y),
          status: inf.type,
          text: def.text || '',
          ms: def.durationMs || 0, // local input-lock deadline for blocking statuses
          blocks: !!def.blocksAction,
        });
      }
    }
    if (status.activeStatuses(p, now).join(',') !== before) this._broadcastPlayerStatus(p);
  }

  // Award a kill's EXP, apply any level-ups, then push the new stats to that
  // player's client (server is authoritative). A level-up heals, so re-broadcast HP.
  awardXp(playerId, xp) {
    const p = this.players.get(playerId);
    if (!p || xp <= 0) return;
    p.exp += xp;
    let leveled = false;
    const fromLevel = p.level;
    while (p.exp >= expToReach(p.level + 1)) {
      levelUp(p);
      leveled = true;
    }
    p.expToNext = expToReach(p.level + 1) - p.exp;
    this.broadcastAll({
      type: 'player_stats',
      id: playerId,
      stats: statsPayload(p),
      leveled,
      gained: xp,
    });
    if (leveled) {
      this._publishPlayerEvent({
        type: 'player_hp',
        id: playerId,
        hp: p.hp,
        maxHp: p.maxHp,
        dmg: 0,
      });
      // Grant skill points for each level gained and push the new banked total to
      // the owner — they alone decide where to spend it. Banked for everyone
      // (anon sessions too); signed-in players persist it in _saveCharacter.
      const prog = this.points.get(playerId);
      if (prog) {
        prog.unspentPoints = (prog.unspentPoints || 0) + POINTS_PER_LEVEL * (p.level - fromLevel);
        this._sendPoints(playerId);
      }
    }
    this._saveCharacter(playerId); // persist new exp/level/points (signed-in only)
  }

  // A player killed an enemy: award EXP + the kill money. Money goes to the BANK
  // (EarthBound's model — it's wired to your ATM account, not your pocket), so you
  // must visit an ATM to withdraw spendable cash. Items spawn as first-touch GROUND
  // DROPS at the death spot and are claimed via tryPickup.
  awardKill(playerId, xp, loot) {
    this.awardXp(playerId, xp); // also persists; broadcasts player_stats
    const p = this.players.get(playerId);
    if (!p || !loot) return;
    if (loot.money > 0) {
      p.bank = (p.bank | 0) + loot.money;
      p.earnedSinceCall = (p.earnedSinceCall | 0) + loot.money; // for Dad's report
      p._ws.send(JSON.stringify({ type: 'bank', bank: p.bank }));
      this._saveCharacter(playerId);
    }
  }

  // Claim a ground drop for a player (npcSim found them standing on it). We own
  // inventory/cash, so the grant decision lives here. Returns true if the drop was
  // consumed (remove it from the world), false to leave it lying there.
  //   - money: always taken, merged into on-hand cash (→ bank split in Phase E).
  //   - item:  taken only if it's a real good AND the bag has room; a full bag
  //            leaves the drop and (Phase D) notifies the player why.
  tryPickup(playerId, drop) {
    const p = this.players.get(playerId);
    if (!p || !drop) return false;
    if (drop.kind === 'money') {
      const amount = drop.amount | 0;
      if (amount <= 0) return true; // nothing to give; still consume it
      p.money += amount;
      p._ws.send(JSON.stringify({ type: 'money', money: p.money }));
      p._ws.send(JSON.stringify({ type: 'loot', money: amount }));
      this._saveCharacter(playerId);
      return true;
    }
    // item drop
    const itemId = String(drop.item);
    if (!this.GOODS[itemId]) return true; // unknown id — consume so it can't linger
    if (p.inventory.length >= MAX_SLOTS) {
      // Bag full: leave the drop so they can return after making room, and tell
      // them why — debounced, since the sim re-offers the drop every tick while
      // they stand on it (one popup per BAG_FULL_NOTICE_MS, not 60/second).
      const now = Date.now();
      if (now - (p._bagFullAt || 0) >= BAG_FULL_NOTICE_MS) {
        p._bagFullAt = now;
        p._ws.send(JSON.stringify({ type: 'notice', code: 'bag_full', text: 'Your bag is full!' }));
      }
      return false;
    }
    p.inventory.push(itemId);
    p._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(p.inventory) }));
    p._ws.send(JSON.stringify({ type: 'loot', item: itemId, name: this.GOODS[itemId].name || '' }));
    this._saveCharacter(playerId);
    return true;
  }

  /**
   * Wire up a freshly connected socket. The socket must look like a `ws`
   * WebSocket (.send/.readyState/.on). Owns the player's lifecycle: assigns an
   * id, handles every message, and removes the player on close.
   */
  handleConnection(ws) {
    const playerId = String(this.nextId++);
    console.log(`Player ${playerId} connected`);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // Mark the connection alive for the idle-disconnect sweep (any message).
      const entry = this.players.get(playerId);
      if (entry) entry.lastSeen = Date.now();
      // _handleMessage is async (the join path awaits the store). It's
      // fire-and-forget for real sockets; the returned promise (rejection logged,
      // never thrown) lets tests await a message that touches the store.
      return Promise.resolve(this._handleMessage(playerId, ws, msg)).catch((e) =>
        console.error('[msg] handler failed', e)
      );
    });

    ws.on('close', () => {
      console.log(`Player ${playerId} disconnected`);
      const closing = this.players.get(playerId);
      if (closing && closing._rtc) closing._rtc.close(); // tear down the WebRTC peer
      this._saveCharacter(playerId); // persist final state (signed-in only)
      this.saves.delete(playerId);
      this.flags.delete(playerId);
      this.points.delete(playerId);
      this._clearAoi(playerId); // drop reverse _seen refs (needs entry intact)
      this.players.delete(playerId);
      this.aoi.remove(playerId);
      // Global despawn: harmless for clients that never had this entity in view.
      this.broadcastAll({ type: 'player_leave', id: playerId });
    });
  }

  async _handleMessage(playerId, ws, msg) {
    const { GOODS } = this;
    switch (msg.type) {
      case 'ping': {
        // App-level heartbeat: echo the client's timestamp so it can measure RTT
        // and detect a silently-dead socket. lastSeen is already bumped for every
        // message in handleConnection, so this also keeps us off the idle sweep.
        // The client also reports its measured RTT here so the server can lag-
        // compensate this player's hits (rewind enemies to what they saw).
        const pe = this.players.get(playerId);
        if (pe && Number.isFinite(msg.rtt)) pe._rtt = Math.max(0, Math.min(400, msg.rtt | 0));
        // The client also reports how far in the past it renders ENEMIES (its
        // adaptive NPC interp delay). Lag-comp rewinds by exactly this so the
        // server tests the hitbox where the player actually SAW the enemy.
        if (pe && Number.isFinite(msg.interp))
          pe._interp = Math.max(0, Math.min(300, msg.interp | 0));
        try {
          // Echo the client's timestamp (RTT) plus our own clock (`srv`) so the
          // client can estimate the client↔server clock offset and map firehose
          // frame timestamps onto its own clock for jitter-immune interpolation.
          // `srvHz` is the effective sim rate (nominal ~30) — a low value means the
          // box is CPU-bound, distinguishing a server stall from a network problem.
          const srvHz = Math.round(1000 / (this._simIntervalEma || SIM_TICK_MS));
          const srvJit = Math.round(this._simJitterEma || 0); // tick-interval jitter (ms)
          ws.send(JSON.stringify({ type: 'pong', t: msg.t, srv: srvNow(), srvHz, srvJit }));
        } catch {
          /* socket already gone */
        }
        break;
      }
      // --- WebRTC signaling (Stage D) — relayed over the reliable WS ----------
      // The client is the offerer; we lazily create the server peer on its first
      // offer, answer + trickle ICE back, and route the firehose to the channel
      // once open (sendBin). Ignored unless RTC_ENABLED — clients that send these
      // with RTC off simply get no answer and stay on the WS.
      case 'rtc_offer': {
        if (!RTC_ENABLED || !rtc.rtcAvailable()) break;
        const e = this.players.get(playerId);
        if (!e) break;
        if (!e._rtc) {
          e._rtc = rtc.createServerPeer(
            playerId,
            (sig) => {
              try {
                if (e._ws && e._ws.readyState === 1) e._ws.send(JSON.stringify(sig));
              } catch {
                /* ws gone mid-handshake */
              }
            },
            {
              onOpen: () => console.log(`[rtc] ${playerId} DataChannel open`),
              onClose: () => {
                console.log(`[rtc] ${playerId} DataChannel closed → WS fallback`);
                // Drop the per-client delta baselines so the first WS frames after
                // fallback are KEYFRAMES — absolute, so they self-correct whatever
                // the client's baseline drifted to while we were sending RTC.
                const ee = this.players.get(playerId);
                if (ee) {
                  ee._npcBase = null;
                  ee._pmBase = null;
                }
              },
            }
          );
        }
        e._rtc.onOffer(msg.sdp);
        break;
      }
      case 'rtc_ice': {
        if (!RTC_ENABLED) break;
        const e = this.players.get(playerId);
        if (e && e._rtc && typeof msg.cand === 'string') e._rtc.onCandidate(msg.cand, msg.mid);
        break;
      }
      // Bot fleet control (?netdebug BOTS tab). Dev/admin only — or BOTS_ENABLED=1
      // for local dev. {op:'spawn'|'despawn'|'stop'|'stats', count?, behavior?}.
      case 'bot': {
        const requester = this.players.get(playerId);
        if (!BOTS_ENABLED && !isDevPlayer(requester)) {
          ws.send(
            JSON.stringify({ type: 'notice', code: 'forbidden', text: 'Bots are dev-only.' })
          );
          break;
        }
        if (!this.botFleet) this.botFleet = new BotFleet(this);
        const f = this.botFleet;
        if (msg.op === 'spawn') f.spawn(msg.count || 1, { behavior: msg.behavior });
        else if (msg.op === 'despawn') f.despawn(msg.count || 1);
        else if (msg.op === 'stop') f.stop();
        // every op (incl. 'stats') replies with the fresh readout
        try {
          ws.send(JSON.stringify({ type: 'bot_stats', ...f.stats() }));
        } catch {
          /* socket gone */
        }
        break;
      }
      case 'join': {
        // Two paths: a signed-in character (sessionToken + characterId, loaded
        // from the store and saved back), or an anonymous ephemeral player (the
        // dev char-select flow + tests). An invalid auth attempt errors cleanly
        // rather than silently falling back to a fresh player.
        let init;
        if (this.store && msg.sessionToken && msg.characterId != null) {
          init = await this._loadCharacterInit(msg.sessionToken, msg.characterId);
          if (!init) {
            ws.send(JSON.stringify({ type: 'join_error', error: 'invalid session or character' }));
            break;
          }
        } else {
          init = this._anonInit(playerId, msg);
        }

        // Evict any LIVE session belonging to this ACCOUNT. One account = one body
        // in the world: a reconnecting client gets a brand-new playerId (nextId++),
        // so without this the prior session lingers until the idle sweep
        // (IDLE_TIMEOUT_MS). This dedupes on accountId — not just characterId — so
        // SWITCHING characters (e.g. barney → a new char from the same account)
        // also tears down the old body instead of leaving a frozen, uncontrollable
        // zombie standing next to you. A flaky / backgrounded tab that drops +
        // rejoins likewise can't pile up copies. The fresh join just loaded the
        // authoritative state, so the new session supersedes the old. Falls back to
        // a characterId match when accountId is absent (older Store mocks / tests).
        // Anonymous players (no characterId) have no stable identity and are left alone.
        if (init.characterId != null) {
          for (const [oldId, handle] of [...this.saves]) {
            if (oldId === playerId) continue;
            const sameAccount = init.accountId != null && handle.accountId === init.accountId;
            const sameChar = handle.characterId === init.characterId;
            if (sameAccount || sameChar) this._evictSession(oldId);
          }
        }

        const playerData = {
          id: playerId,
          name: init.name,
          spriteGroupId: init.spriteGroupId,
          appearance: init.appearance,
          x: init.x,
          y: init.y,
          direction: init.direction,
          frame: 0,
          pose: 'walk',
          // Active status conditions (see server/status.js): paralysis, poison, …
          // Transient (not persisted); cleared on death/respawn.
          statuses: {},
          itemId: null, // set by recomputeEquipStats (held = equipped weapon)
          // EarthBound equip slots (loaded from the save or empty). Server-
          // authoritative; offense/defense from these apply to combat.
          equipped: init.equipped,
          // Quick-select hotbar (keys 1/2): weapon / usable item / 'psi:<id>'.
          // Persisted so an assigned PSI survives a relog (a weapon would be
          // re-derived from the equip set, but a PSI move has no other anchor).
          hotbar: Array.isArray(init.hotbar) ? init.hotbar : new Array(HOTBAR_SLOTS).fill(null),
          weaponOffense: 0,
          armorDefense: 0,
          attackSpeed: 1, // weapon swing-rate multiplier; set by recomputeEquipStats
          weaponInflict: null, // weapon status-inflict spec; set by recomputeEquipStats
          inventory: init.inventory, // Goods slots, mutated by use/buy/sell
          money: init.money, // on-hand cash
          bank: init.bank | 0, // ATM balance
          // Dad's-report tallies (kills banked / cash spent since last call).
          earnedSinceCall: init.earnedSinceCall | 0,
          spentSinceCall: init.spentSinceCall | 0,
          // PK (player-kill) flag + remaining enable-lock (in-game ms) — see
          // npcSim canHurt and the set_pk handler. Loaded from the save (anon:
          // off). pkTickAt is reset to now so the lock resumes from join, paused
          // for the whole time the player was offline.
          pk: init.pk,
          pkLockMs: init.pkLockMs,
          pkTickAt: Date.now(),
          // EB naming flavor + Ness's-mom food cooldown (epoch ms; 0 = ready).
          favoriteThing: init.favoriteThing ?? '',
          favoriteFood: init.favoriteFood ?? '',
          momFoodReadyAt: init.momFoodReadyAt | 0,
          // Door-transition shield (see 'warp'): whiffs enemy swings on the
          // frozen ghost left at a doorway mid-fade.
          warping: false,
          warpUntil: 0,
          // Dev editor anchor flag (see 'editor').
          editor: false,
          // Server-verified account role ('player' | 'dev' | 'admin'). Drives the
          // dev unlock bypass (devUnlockAll → all PSI/abilities castable). Anonymous
          // joins are 'player'. NEVER set from a client message.
          role: init.role || 'player',
          // Last-message timestamp for the idle-disconnect sweep (_reapIdle).
          lastSeen: Date.now(),
          // Server-authoritative progression: fresh (anon) or rebuilt from the
          // saved alloc + level (signed-in).
          ...init.progression,
        };
        this.players.set(playerId, { ...playerData, _ws: ws });
        const entry = this.players.get(playerId);
        this.aoi.update(playerId, entry.x, entry.y); // index for AOI fan-out
        this.recomputeEquipStats(entry); // apply loaded gear + set held sprite

        // Quest flags: restore the saved set (empty for anonymous joins). Kept
        // private to this player — never broadcast.
        this.flags.set(playerId, new Set(init.flags));

        // Skill points + alloc (private). Banked for EVERY player so the
        // level-up icon + spend pentagon work in anonymous/dev sessions too;
        // signed-in players also persist it (see _saveCharacter).
        this.points.set(playerId, {
          alloc: init.alloc ? { ...init.alloc } : defaultAlloc(),
          unspentPoints: init.unspentPoints || 0,
        });

        // Remember the persistence handle (signed-in only) for save-back +
        // skill-point banking. `alloc` MUST be the SAME object `this.points`
        // holds (the copy above) — spend_points mutates that one, and both
        // _saveCharacter and tests read it back through this handle. (Pointing it
        // at the raw `init.alloc` instead decoupled them, so a valid spend didn't
        // show up here.)
        if (init.characterId != null) {
          this.saves.set(playerId, {
            characterId: init.characterId,
            accountId: init.accountId ?? null,
            alloc: this.points.get(playerId).alloc,
            unspentPoints: init.unspentPoints || 0,
          });
        }

        // The new player gets their id, the current roster, and their own state.
        const otherPlayers = [];
        for (const [id, p] of this.players) {
          if (id !== playerId) {
            const { _ws, ...data } = p;
            // Send the active-status ARRAY (not the internal {} map) so the
            // client can iterate pips — matches _broadcastPlayerStatus.
            data.statuses = status.activeStatuses(p, Date.now());
            otherPlayers.push(data);
          }
        }
        // AOI on: restrict the NPC/drop join burst to the joiner's block (no more
        // O(worldNPCs) per join); off: legacy full-world divergent snapshot.
        const aoiSnap = AOI_ENABLED ? this._aoiJoinSnapshot(playerId, entry) : null;
        ws.send(
          JSON.stringify({
            type: 'welcome',
            playerId,
            // AOI on: spawn nobody up front — _refreshAoi below sends a targeted
            // player_join for each in-range peer (and the newcomer to them).
            // AOI off: legacy full roster.
            players: AOI_ENABLED ? [] : otherPlayers,
            npcs: aoiSnap ? aoiSnap.npcs : this.npcSim.snapshot(),
            npcHps: aoiSnap ? aoiSnap.npcHps : this.npcSim.hpSnapshot(),
            npcEquips: aoiSnap ? aoiSnap.npcEquips : this.npcSim.equipSnapshot(), // townsfolk holding looted weapons
            drops: aoiSnap ? aoiSnap.drops : this.npcSim.dropsSnapshot(), // ground loot already lying around
            inventory: this.inventoryView(entry.inventory), // own Goods
            money: entry.money, // own on-hand cash
            bank: entry.bank | 0, // own ATM balance
            // Signed-in characters restore their saved spawn + stats + gear; the
            // anonymous client ignores these (it spawns from its own spawn.json).
            self: { x: entry.x, y: entry.y, direction: entry.direction },
            stats: statsPayload(entry),
            equipped: entry.equipped,
            hotbar: entry.hotbar, // restore quick-select slots (incl. assigned PSI)
            // EB naming flavor — the client renders the "PSI ????" special as
            // "PSI <favorite thing>" (blank → "Rockin'"). Display-only.
            favoriteThing: entry.favoriteThing || '',
            // Account role — the client unlocks the whole PSI menu for dev/admin
            // (mirrors the server's devUnlockAll). Players gate by Mental.
            role: entry.role || 'player',
            attackSpeed: entry.attackSpeed, // weapon swing-rate mult (scales client swing pose)
            weaponRange: entry.weaponRange || 0, // projectile range (0 = melee) → aim reticle

            // Saved quest/progress flags (PlayerFlags) — private to this player.
            flags: [...this.flags.get(playerId)],
            // Restore PK state + remaining lock (a player who logged out PK
            // stays PK; the lock resumes paused-from-logout). lockMs is the
            // remaining in-game ms — the client renders its own countdown.
            pk: entry.pk,
            lockMs: entry.pkLockMs,
          })
        );

        // Tell everyone else about the new player. AOI on: targeted spawn to
        // (and from) in-range peers only — reciprocal so existing peers see the
        // newcomer at once, not a tick later. AOI off: legacy global join broadcast.
        if (AOI_ENABLED) {
          this._refreshAoiReciprocal(playerId);
        } else {
          const { _ws, ...publicData } = this.players.get(playerId);
          publicData.statuses = status.activeStatuses(this.players.get(playerId), Date.now());
          this.broadcastExcept({ type: 'player_join', player: publicData }, playerId);
        }
        // Restore any banked skill points (shows the level-up icon on rejoin).
        this._sendPoints(playerId);
        break;
      }

      case 'warp': {
        // Client entered (warping:true) or finished (false) a door transition.
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.warping = !!msg.warping;
        entry.warpUntil = entry.warping ? Date.now() + WARP_SHIELD_MAX_MS : 0;
        break;
      }

      case 'event_talk': {
        // Client finished talking to an NPC (textId). May arm a dialogue-start
        // event if this player is standing in its trigger circle. No-op otherwise.
        const npcTextId = Number.isFinite(msg.npcTextId) ? msg.npcTextId : null;
        if (npcTextId != null) this.eventRuntime.onTalk(playerId, npcTextId);
        break;
      }

      case 'editor': {
        // Dev editor opened (on:true) / closed (false). While on, this player is
        // pulled from the NPC sim so its parked avatar can't be aggroed, hit, or
        // killed (which would respawn-yank the admin's free camera).
        const entry = this.players.get(playerId);
        if (!entry) break;
        const turningOn = !!msg.on;
        if (turningOn && !entry.editor) {
          // The editor reports its free CAMERA center as `move`, which overwrites
          // entry.x/y. Stash the real gameplay spot first so we can restore it on
          // exit — otherwise the client (which now reconciles to the server) gets
          // snapped to wherever the camera was panned, often unwalkable = stuck.
          entry._preEditor = { x: entry.x, y: entry.y, direction: entry.direction };
        } else if (!turningOn && entry.editor && entry._preEditor) {
          entry.x = entry._preEditor.x;
          entry.y = entry._preEditor.y;
          entry.direction = entry._preEditor.direction;
          entry._preEditor = null;
          if (entry._inputs) entry._inputs.length = 0; // drop stale queued inputs
          // Re-assert the authoritative spot so the client's prediction resets here
          // (warpTo clears its pending inputs), not at the editor camera.
          if (entry._ws) entry._ws.send(JSON.stringify({ type: 'warp', x: entry.x, y: entry.y }));
        }
        entry.editor = turningOn;
        // Leaving the editor: the avatar may have been teleported far while
        // parked, so exempt the rejoin jump from enemy door-warp follow (else
        // chasers teleport along with the admin).
        if (!entry.editor) this.npcSim.noteEditorExit(playerId);
        break;
      }

      // Editor click-to-teleport (dev-only, editor mode required): a DELIBERATE
      // reposition — set the authoritative spot AND the restore target, so it
      // STICKS when the editor closes. A plain camera pan never sends this, so
      // panning still reverts you to where you entered.
      case 'editor_teleport': {
        const entry = this.players.get(playerId);
        if (!entry || !entry.editor) break;
        const tx = Math.round(Number(msg.x));
        const ty = Math.round(Number(msg.y));
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) break;
        entry.x = tx;
        entry.y = ty;
        entry._preEditor = { x: tx, y: ty, direction: entry.direction || 0 };
        break;
      }

      case 'move': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // 'move' trusts a CLIENT-SENT position, so it is EDITOR-ONLY — the dev
        // free-camera anchor (the only legitimate sender). Normal play is fully
        // server-authoritative: walking goes through 'input'/_simPlayers and door
        // warps are resolved + positioned server-side (use_door + findPlayerLanding,
        // adopted via the 'warp' message). A gameplay client never sends 'move', so
        // anyone who does is rejected here — no client teleport / speedhack.
        if (!entry.editor) break;
        // --- Validation (still belt-and-suspenders for the editor channel). Drop
        // garbage, clamp into the map. ---
        let nx = Number(msg.x);
        let ny = Number(msg.y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
        nx = Math.max(0, Math.min(this.WORLD.w, nx));
        ny = Math.max(0, Math.min(this.WORLD.h, ny));
        // Read the warp shield BEFORE clearing it: a real door warp is exactly
        // the big jump we'd otherwise clamp as a speed hack.
        // The dev editor reports its free-camera center as `move` so the sim
        // anchors on what the admin is observing — that legitimately leaps far
        // each pan, so exempt it from the speed-hack clamp (same as a warp).
        const warping = (entry.warping && Date.now() < entry.warpUntil) || entry.editor;
        if (!warping) {
          const dx = nx - entry.x;
          const dy = ny - entry.y;
          const dist = Math.hypot(dx, dy);
          if (dist > MAX_MOVE_STEP) {
            const s = MAX_MOVE_STEP / dist; // clamp the step toward the request
            nx = Math.round(entry.x + dx * s);
            ny = Math.round(entry.y + dy * s);
          }
        }
        // A move means the client is live again — the fade is over, drop the
        // shield (fallback in case the 'warp' end signal was missed).
        entry.warping = false;
        const direction =
          Number.isInteger(msg.direction) && msg.direction >= 0 && msg.direction <= 7
            ? msg.direction
            : entry.direction;
        const frame = Number.isInteger(msg.frame) && msg.frame >= 0 ? msg.frame : 0;
        entry.x = nx;
        entry.y = ny;
        entry.direction = direction;
        entry.frame = frame;
        entry.pose = POSES.includes(msg.pose) ? msg.pose : 'walk';
        this.broadcastExcept(
          { type: 'player_move', id: playerId, x: nx, y: ny, direction, frame, pose: entry.pose },
          playerId
        );
        break;
      }

      // Server-authoritative movement: the client sends INPUTS (held direction +
      // a monotonic seq), never a position. Queued here; `_simPlayers` drains and
      // simulates them each sim tick, then ACKs the seq for client reconciliation.
      // This is the cheat-proof replacement for `move` (which trusts a client
      // position) — once every client sends inputs, `move` is retired.
      case 'input': {
        const entry = this.players.get(playerId);
        if (!entry || entry.editor) break;
        const seq = Number(msg.seq);
        if (!Number.isFinite(seq)) break;
        // Only ever accept an ADVANCING seq (drops replays / out-of-order packets).
        if (entry._lastSeqIn != null && seq <= entry._lastSeqIn) break;
        entry._lastSeqIn = seq;
        if (!entry._inputs) entry._inputs = [];
        entry._inputs.push({
          seq,
          dx: Math.sign(Number(msg.dx) || 0),
          dy: Math.sign(Number(msg.dy) || 0),
          run: !!msg.run, // hold-Shift; honored only if stamina remains (_stepPlayer)
        });
        if (entry._inputs.length > MAX_INPUT_QUEUE) {
          entry._inputs.splice(0, entry._inputs.length - MAX_INPUT_QUEUE);
        }
        entry.lastSeen = Date.now();
        break;
      }

      // Server-authoritative door warp: the client requests to use the door it's
      // standing on; the server confirms (the player's AUTHORITATIVE position is
      // actually on a door trigger) and warps to the door's OWN destination — the
      // client never picks the spot, so "warp anywhere" is impossible. On a bad
      // request (not on a door) we snap the player back to truth. Pre-warp queued
      // inputs are dropped so they don't apply at the destination.
      case 'use_door': {
        const entry = this.players.get(playerId);
        if (!entry || entry.editor) break;
        const door = this.npcSim.doorAt(entry.x, entry.y);
        if (!door) {
          // Not on a door — reject and re-assert the authoritative position.
          if (entry._ws)
            entry._ws.send(
              JSON.stringify({
                type: 'pos',
                x: entry.x,
                y: entry.y,
                direction: entry.direction,
                frame: entry.frame,
                seq: entry._ackSeq || 0,
              })
            );
          break;
        }
        // Land on a CLEAR tile: if the door's exit is blocked by a wall, an NPC,
        // or another player, drop onto the nearest free spot instead — so a warp
        // never stacks two bodies on the doorway and gets them stuck. (The same
        // free-spot rule NPCs use when they door-follow; the per-tick unstack is
        // the backstop.) The resolved spot is authoritative — the client adopts it
        // from the `warp` message below, so no client-volunteered position.
        const spot = this.npcSim.findPlayerLanding(
          door.destX,
          door.destY,
          Array.from(this.players.values()),
          playerId
        );
        entry.x = Math.round(spot.x);
        entry.y = Math.round(spot.y);
        entry.warping = true;
        entry.warpUntil = Date.now() + WARP_SHIELD_MAX_MS;
        if (entry._inputs) entry._inputs.length = 0; // stale pre-warp inputs don't carry over
        if (entry._ws) entry._ws.send(JSON.stringify({ type: 'warp', x: entry.x, y: entry.y }));
        this.broadcastExcept(
          {
            type: 'player_move',
            id: playerId,
            x: entry.x,
            y: entry.y,
            direction: entry.direction,
            frame: entry.frame,
            pose: 'walk',
          },
          playerId
        );
        // Re-anchor AOI + resend the destination's NPC/HP snapshot so the building
        // we just entered isn't empty (stationary indoor actors never ride the
        // moved-only npc_update). Also spawns us to / from peers at the new spot.
        this._warpResnapshot(playerId, entry);
        break;
      }

      // Escalator/stairway ride finished. The glide across the (solid) steps is
      // client-driven — the server can't recompute the diagonal ramp + landing —
      // so we trust the client's landing spot, but ONLY when its authoritative
      // position is actually on a stair trigger (so it can't warp anywhere). Same
      // movement-trust model as `move`/knockback, gated to a real escalator. The
      // client owns its own visual warp, so we DON'T echo a `warp` (that would
      // reveal the destination before the fade) — we just resync authority here.
      case 'ride_warp': {
        const entry = this.players.get(playerId);
        if (!entry || entry.editor) break;
        if (!this.npcSim.stairAt(entry.x, entry.y)) {
          // Not on an escalator — reject and re-assert the authoritative position.
          if (entry._ws)
            entry._ws.send(
              JSON.stringify({
                type: 'pos',
                x: entry.x,
                y: entry.y,
                direction: entry.direction,
                frame: entry.frame,
                seq: entry._ackSeq || 0,
              })
            );
          break;
        }
        const tx = Math.round(Number(msg.x));
        const ty = Math.round(Number(msg.y));
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) break;
        entry.x = tx;
        entry.y = ty;
        // Do NOT raise the warp shield here. An open escalator ride has no fade to
        // clear it, and while `warping` is set _simPlayers HOLDS the player (ignores
        // inputs) — which froze the rider at the top for the 8s shield window
        // ("stuck at the top of the escalator", bugs.md). The position is set
        // directly (no speed-clamp to dodge) and the client is immediately live, so
        // no shield is needed. A door-exit ride still fades + shields via its own
        // 'warp' message, independent of this.
        if (entry._inputs) entry._inputs.length = 0; // stale pre-ride inputs don't carry over
        this.npcSim.noteRespawn(playerId); // exempt the floor jump from enemy door-warp follow
        this.broadcastExcept(
          {
            type: 'player_move',
            id: playerId,
            x: tx,
            y: ty,
            direction: entry.direction,
            frame: entry.frame,
            pose: 'walk',
          },
          playerId
        );
        // Escalator ride can cross floors/cells — re-anchor AOI + resnapshot the
        // landing area, same as a door warp.
        this._warpResnapshot(playerId, entry);
        break;
      }

      case 'attack': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // Stamina gate (mirrors the PP gate on PSI): too tired = no swing at all.
        // The client predicts this and won't even send, but a hacked client is
        // dropped here too. Actual drain happens only if the swing fires (below).
        if ((entry.stamina ?? 0) < STAMINA_ATTACK_COST) break;
        // Mouse-aim: the client sends a snapped 8-way `dir` (for sprite facing) plus
        // a raw `aimx,aimy` unit vector (for the true-angle hitbox/projectile). Adopt
        // the facing as authoritative so movement/AOI broadcasts + the swing pose
        // point where they aimed; clamp to a valid enum, else keep the old facing.
        const adir = msg.dir | 0;
        const swingDir = adir >= 0 && adir < 8 ? adir : entry.direction | 0;
        entry.direction = swingDir;
        // Tell everyone else to play this player's swing. The authoritative move
        // sim broadcasts every pose as 'walk', so the attack pose can't ride the
        // position stream — other clients replay the swing from this signal
        // (RemoteInterp.applyRemoteSwing). `dir` orients the remote swing pose.
        // Sent for every swing incl. a whiff.
        this._publishPlayerEvent(
          {
            type: 'player_attack',
            id: playerId,
            attackSpeed: entry.attackSpeed || 1,
            dir: swingDir,
          },
          false
        );
        // Status accuracy penalties: Crying lowers your hit rate, Nausea makes
        // you fumble — either can whiff the swing outright (broadcast a MISS).
        const nowA = Date.now();
        if (
          (status.isCrying(entry, nowA) && Math.random() < CRY_MISS_CHANCE) ||
          (status.hasFlag(entry, nowA, 'fumble') && Math.random() < FUMBLE_CHANCE)
        ) {
          this.broadcastAll({
            type: 'combat',
            evt: 'miss',
            x: Math.round(entry.x),
            y: Math.round(entry.y),
            byPlayer: playerId,
            targetPlayer: null,
          });
          break;
        }
        // Server-authoritative: resolve from the tracked position so reach can't
        // be spoofed. Damage scales with the player's Offense stat + weapon; crit
        // chance comes from Luck (SMAAAASH! → 2× damage, broadcast to all).
        const swungFired = this.npcSim.handleAttack(
          entry.x,
          entry.y,
          swingDir,
          playerId,
          entry.offense +
            (entry.weaponOffense || 0) +
            buffs.buffBonus(entry, 'offense', Date.now()),
          entry.pk,
          critChanceFromLuck(entry.luck),
          entry.attackSpeed || 1,
          entry.weaponInflict,
          entry.weaponRange || 0,
          entry.level || 1,
          entry.weaponProjSpeed || 0,
          entry.weaponPierce || false,
          entry.weaponProjSprite || null,
          // Lag-comp rewind: the client's REPORTED enemy interp delay (adaptive,
          // ~60-80ms) + this player's RTT. Falls back to NPC_INTERP_MS until the
          // first ping reports it. Must match what the client renders or melee
          // tests the hitbox at the wrong moment (the "hits don't land" bug).
          LAG_COMP ? (entry._interp ?? NPC_INTERP_MS) + (entry._rtt || 0) : 0,
          // Raw mouse-aim unit vector: when present (and finite/non-zero) the hitbox
          // and projectile fire at this true angle; otherwise they fall back to the
          // 8-way `swingDir`. Server normalizes it, so reach/speed can't be spoofed.
          Number(msg.aimx),
          Number(msg.aimy)
        );
        // Charge stamina only when the swing actually fired (cleared cooldown), so
        // rapid clicks dropped on cooldown don't bleed the bar. Sync is throttled
        // via _maybeSendStamina; force one on the next tick by clearing the gate.
        if (swungFired) {
          entry.stamina = Math.max(0, (entry.stamina ?? 0) - STAMINA_ATTACK_COST);
          entry._staminaSentAt = 0; // let the next sim tick push the new value promptly
        }
        break;
      }

      case 'equip': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        // Per-slot equip: { slot, itemId|null }. Authoritative; null unequips.
        // Worn gear is moved OUT of Goods and the worn piece returns to Goods on
        // unequip (so the bag count reflects only what you're carrying, not what
        // you're wearing). Offense/defense recompute from the whole set.
        const slot = typeof msg.slot === 'string' ? msg.slot : null;
        const itemId =
          typeof msg.itemId === 'string' && msg.itemId.length <= 24 ? msg.itemId : null;
        if (!slot || !EQUIP_SLOTS.includes(slot)) break;
        const prev = entry.equipped[slot]; // the piece currently worn here (or null)
        if (itemId !== null) {
          // EQUIP: must own it (in Goods) and it must fit the slot. Take it out
          // of Goods; a swap returns the old piece, so the count never overflows.
          const eq = GOODS[itemId] && GOODS[itemId].equip;
          const idx = entry.inventory.indexOf(itemId);
          if (!eq || eq.slot !== slot || idx === -1) break;
          entry.inventory.splice(idx, 1);
          if (prev) entry.inventory.push(prev);
          entry.equipped[slot] = itemId;
        } else {
          // UNEQUIP: the worn piece goes back into Goods — refuse if the bag is
          // full (it would have nowhere to land), and tell the player why. Resend
          // the unchanged equipped set so the client reverts its optimistic take-off.
          if (!prev) break; // nothing worn here
          if (entry.inventory.length >= MAX_SLOTS) {
            entry._ws.send(
              JSON.stringify({
                type: 'notice',
                code: 'bag_full',
                text: 'Your bag is full — make room before taking that off.',
              })
            );
            entry._ws.send(
              JSON.stringify({
                type: 'equipped',
                slots: entry.equipped,
                attackSpeed: entry.attackSpeed,
                range: entry.weaponRange || 0,
              })
            );
            break;
          }
          entry.inventory.push(prev);
          entry.equipped[slot] = null;
        }
        this.recomputeEquipStats(entry);
        // The owner gets their authoritative equipped set + the updated Goods...
        entry._ws.send(
          JSON.stringify({
            type: 'equipped',
            slots: entry.equipped,
            attackSpeed: entry.attackSpeed,
            range: entry.weaponRange || 0,
          })
        );
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        // ...everyone else just needs the held-weapon sprite.
        this._publishPlayerEvent({ type: 'equip', id: playerId, itemId: entry.itemId }, false);
        this._saveCharacter(playerId);
        break;
      }

      case 'hotbar': {
        // The client owns hotbar layout (assign by drag); it echoes the full
        // 2-slot array here so the server can persist it with the character. We
        // re-validate every entry (null / known good / known PSI) so a tampered
        // payload can't store junk, then save — same trust model as 'equip'.
        const entry = this.players.get(playerId);
        if (!entry) break;
        entry.hotbar = this._sanitizeHotbar(msg.hotbar);
        this._saveCharacter(playerId);
        break;
      }

      case 'use_item': {
        const entry = this.players.get(playerId);
        // Truly dead-and-gone (not a downed player) can't act; a DOWNED player is
        // allowed through here for the one purpose of self-rescue (see below).
        if (!entry || (entry.hp <= 0 && !entry.downed)) break;
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
        const def = itemId ? GOODS[itemId] : null;
        if (!def) break; // unknown id — ignore
        const slot = entry.inventory.indexOf(itemId);
        // Stock ran out but a hotbar slot still points at it — tell the player
        // instead of a silent no-op (the assignment intentionally lingers).
        if (slot === -1) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: `You're out of ${def.name}.` }));
          break;
        }
        // Equippable gear is NOT a consumable — "using" a weapon/armor must
        // never destroy it. It's equipped via the 'equip' path instead.
        if (def.equip) break;
        // Mortal-roll self-rescue: HP is rolling to zero RIGHT NOW. A healing or
        // revive consumable that lifts your true HP back above 0 saves you before
        // the meter lands — you stay on your feet (healPlayer cancels the roll).
        // Anything that can't restore HP is refused without being consumed.
        if (entry.dying) {
          const restore = def.revive > 0 ? def.revive : def.heal > 0 ? def.heal : 0;
          if (restore <= 0) {
            entry._ws.send(
              JSON.stringify({ type: 'notice', text: 'Only a healing item can save you now!' })
            );
            break;
          }
          this.healPlayer(entry, restore); // may cancel the roll (survive) — broadcasts player_hp
          entry.inventory.splice(slot, 1);
          entry._ws.send(
            JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
          );
          entry._ws.send(
            JSON.stringify({
              type: 'notice',
              text: entry.dying ? `${def.name}... not enough!` : `${def.name} saved you!`,
            })
          );
          this.broadcastExcept(
            {
              type: 'item_use',
              id: playerId,
              item: itemId,
              x: Math.round(entry.x),
              y: Math.round(entry.y),
            },
            playerId
          );
          this._saveCharacter(playerId);
          break;
        }
        // KO'd self-rescue: a downed player is knocked over (MORTAL DAMAGE) but can
        // still claw back up — a healing OR revive consumable used on THEMSELVES
        // stands them up before the KO window runs out (the EB "heal before the
        // counter hits 0" save). Anything that can't restore HP is refused without
        // being consumed; ally-revive (def.revive on someone else) is unaffected.
        if (entry.downed) {
          const restore = def.revive > 0 ? def.revive : def.heal > 0 ? def.heal : 0;
          if (restore <= 0) {
            entry._ws.send(
              JSON.stringify({
                type: 'notice',
                text: 'You can only use a healing item while down!',
              })
            );
            break;
          }
          this._reviveDowned(entry, restore);
          entry.inventory.splice(slot, 1);
          entry._ws.send(
            JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
          );
          entry._ws.send(
            JSON.stringify({ type: 'notice', text: `You used ${def.name} and got back up!` })
          );
          this.broadcastExcept(
            {
              type: 'item_use',
              id: playerId,
              item: itemId,
              x: Math.round(entry.x),
              y: Math.round(entry.y),
            },
            playerId
          );
          this._saveCharacter(playerId);
          break;
        }
        // Revive items (Horn of life / Secret herb / Cup of Lifenoodles) act on a
        // DOWNED ally, never the user (a downed player can't act). Resolve the
        // target: an explicit clicked targetId (must be downed AND within range),
        // else the nearest downed ally in range. No valid target → refuse WITHOUT
        // consuming, so a misclick or out-of-range press never wastes the item.
        if (def.revive > 0) {
          let target = null;
          const tid = typeof msg.targetId === 'string' ? msg.targetId : null;
          if (tid) {
            const t = this.players.get(tid);
            if (t && t.downed) {
              const dx = t.x - entry.x;
              const dy = t.y - entry.y;
              if (dx * dx + dy * dy <= REVIVE_RANGE * REVIVE_RANGE) target = t;
            }
          } else {
            target = this._nearestDownedWithin(entry.x, entry.y);
          }
          if (!target) {
            entry._ws.send(
              JSON.stringify({ type: 'notice', text: 'No downed ally in range to revive.' })
            );
            break;
          }
          this._reviveDowned(target, def.revive);
          entry.inventory.splice(slot, 1);
          entry._ws.send(
            JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
          );
          entry._ws.send(
            JSON.stringify({ type: 'notice', text: `You revived ${target.name} with ${def.name}!` })
          );
          this.broadcastExcept(
            {
              type: 'item_use',
              id: playerId,
              item: itemId,
              x: Math.round(entry.x),
              y: Math.round(entry.y),
            },
            playerId
          );
          this._saveCharacter(playerId);
          break;
        }
        // Stat capsules (EB IQ/Guts/Speed/Vital/Luck) + Rock candy: PERMANENT
        // progression expressed through our level-up pentagon, not a one-off buff.
        // `skill` raises one of the 5 creation stats by 1 — the exact same path a
        // spent level-up point takes (alloc++ -> reapplyAlloc -> derive). `skillPoint`
        // banks a free point the player spends where they like (Rock candy = wildcard).
        // Server-authoritative: only the alloc/derive the server owns ever changes.
        if (def.skill || def.skillPoint) {
          const prog = this.points.get(playerId);
          if (!prog) break;
          if (def.skill) {
            if (!STAT_KEYS.includes(def.skill)) break; // bad data — keep the item, no-op
            if ((prog.alloc[def.skill] || 0) >= STAT_SPEND_MAX) {
              entry._ws.send(
                JSON.stringify({ type: 'notice', text: `${def.name} would have no effect.` })
              );
              break;
            }
            prog.alloc[def.skill] = (prog.alloc[def.skill] || 0) + 1;
            this.reapplyAlloc(entry, prog.alloc); // re-derive combat stats from the new build
            this.broadcastAll({
              type: 'player_stats',
              id: playerId,
              stats: statsPayload(entry),
              leveled: false,
              gained: 0,
            });
            // maxHp may have grown (Spirit/Muscle) — refresh every client's bar.
            this.broadcastAll({
              type: 'player_hp',
              id: playerId,
              hp: entry.hp,
              maxHp: entry.maxHp,
              dmg: 0,
            });
          } else {
            // Wildcard: bank a point for the owner to spend on the pentagon.
            const grant = Math.max(1, def.skillPoint | 0);
            prog.unspentPoints = (prog.unspentPoints || 0) + grant;
            const spHandle = this.saves.get(playerId);
            if (spHandle) spHandle.unspentPoints = prog.unspentPoints;
          }
          this._sendPoints(playerId); // refresh banked points + alloc (pentagon UI)
          entry.inventory.splice(slot, 1);
          entry._ws.send(
            JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
          );
          this.broadcastExcept(
            {
              type: 'item_use',
              id: playerId,
              item: itemId,
              x: Math.round(entry.x),
              y: Math.round(entry.y),
            },
            playerId
          );
          // '90s recipe nod: Rock candy used while a Sugar packet sits in your
          // Goods → a glitter burst EVERYONE sees. Cosmetic only — the sugar is
          // NOT consumed and nothing is duped (the canon dupe glitch can't exist
          // here; use_item always consumes server-side).
          if (def.skillPoint && entry.inventory.includes('119')) {
            this.broadcastAll({
              type: 'glitter',
              id: playerId,
              x: Math.round(entry.x),
              y: Math.round(entry.y),
            });
          }
          this._saveCharacter(playerId);
          break;
        }
        // What this item can actually DO for the player right now. A consumable
        // whose every effect is a no-op (bars full, nothing to cure) would just be
        // wasted, so we refuse + say so (EarthBound does the same) rather than
        // silently eat a hotbar press.
        const now = Date.now();
        const canHp = def.heal && entry.hp < entry.maxHp;
        const canPp = def.healPp && entry.pp < entry.ppMax;
        // EarthBound seasoning: auto-apply the best condiment the player carries
        // onto this food (preferred match or universal delisauce → the big `good`
        // bonus; mismatches are never auto-spent — see _pickCondiment). Only when
        // the matching bar can actually take it, so a condiment is never wasted.
        const season = this._pickCondiment(entry.inventory, itemId);
        const seasonHp = season && season.effect === 'hp' && canHp ? season.amount : 0;
        const seasonPp = season && season.effect === 'pp' && canPp ? season.amount : 0;
        const condimentUsed = seasonHp || seasonPp ? season.condId : null;
        // Statuses this item lists that the player currently has (the cure targets).
        const curable = Array.isArray(def.cure)
          ? def.cure.filter((t) => status.defOf(t) && status.hasStatus(entry, t, now))
          : [];
        // Valid timed stat buffs this item grants (buffs always "do something").
        const buffList = Array.isArray(def.buffs)
          ? def.buffs.filter(
              (b) => b && buffs.BUFF_STATS.has(b.stat) && b.durationMs > 0 && Math.round(b.amount)
            )
          : [];
        const hasEffect =
          def.heal || def.healPp || (Array.isArray(def.cure) && def.cure.length) || buffList.length;
        const useful = canHp || canPp || curable.length || buffList.length;
        if (hasEffect && !useful) {
          // Tailor the message to the dud: full bars vs nothing to cure.
          let text = 'It would have no effect right now.';
          if ((def.heal || def.healPp) && !buffList.length && !(def.cure && def.cure.length)) {
            const full = def.heal && def.healPp ? 'HP and PP are' : def.healPp ? 'PP is' : 'HP is';
            text = `Your ${full} already full.`;
          } else if (def.cure && def.cure.length && !def.heal && !def.healPp && !buffList.length) {
            text = "You don't have anything to cure.";
          }
          entry._ws.send(JSON.stringify({ type: 'notice', text }));
          break;
        }

        // Cookie (and any future `heal` good) restores HP up to the cap;
        // broadcast so every client redraws the bar, tagging `heal` so the
        // owner's client pops a green number.
        if (canHp) {
          const healed = Math.min(entry.maxHp, entry.hp + def.heal + seasonHp) - entry.hp;
          entry.hp += healed;
          this.broadcastAll({
            type: 'player_hp',
            id: playerId,
            hp: entry.hp,
            maxHp: entry.maxHp,
            dmg: 0,
            heal: healed,
          });
        }
        // PP-restoring consumables (e.g. PSI-recovery foods) refill the PP bar up
        // to the cap; player_stats pushes the new pp so the caster's bar redraws.
        if (canPp) {
          entry.pp = Math.min(entry.ppMax, entry.pp + def.healPp + seasonPp);
        }
        // Status-cure foods clear the listed conditions the player currently has;
        // re-broadcast the active set so the client drops the icons + input lock.
        if (curable.length) {
          for (const t of curable) status.clearStatus(entry, t);
          this._broadcastPlayerStatus(entry);
        }
        // Timed stat buffs (Skip/Luck sandwich, etc.). applyBuff records each onto
        // entry.buffs; the per-tick upkeep expires them (see _tickPlayerStatuses).
        for (const b of buffList) buffs.applyBuff(entry, b.stat, b.amount, b.durationMs, now);
        // PP refill and/or a new buff changed the effective stats — push once so the
        // status screen + PSI bar redraw.
        if (canPp || buffList.length) {
          this.broadcastAll({
            type: 'player_stats',
            id: playerId,
            stats: statsPayload(entry),
            leveled: false,
            gained: 0,
          });
        }
        // Refresh the owner's buff HUD with the new active set + timers.
        if (buffList.length) this._sendPlayerBuffs(entry);

        entry.inventory.splice(slot, 1);
        // Seasoning consumed a condiment too — remove ONE (by value, after the food
        // splice so the index is current) and tell the player what it did.
        if (condimentUsed) {
          const ci = entry.inventory.indexOf(condimentUsed);
          if (ci >= 0) entry.inventory.splice(ci, 1);
          const cName =
            (this.GOODS[condimentUsed] && this.GOODS[condimentUsed].name) || 'condiment';
          const unit = season.effect === 'pp' ? 'PP' : 'HP';
          entry._ws.send(
            JSON.stringify({
              type: 'notice',
              text: `${cName} made it tastier! +${season.amount} ${unit}`,
            })
          );
        }
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        // The item was actually consumed — let OTHER clients play its "use"
        // animation on this player (the user already spawned their own locally,
        // same model as psi_cast). Visual only.
        this.broadcastExcept(
          {
            type: 'item_use',
            id: playerId,
            item: itemId,
            x: Math.round(entry.x),
            y: Math.round(entry.y),
          },
          playerId
        );
        this._saveCharacter(playerId);
        break;
      }

      case 'buy': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const store = msg.store | 0;
        const itemId = String(msg.item);
        const def = GOODS[itemId];
        // Real item, stocked by that store, affordable, room in the bag. Price is
        // the catalog's, never the client's, and validated as a real non-negative
        // number so a malformed catalog entry can't NaN/inflate the wallet. Reject
        // with a notice (not a silent drop) so the client shows WHY a buy failed.
        const cost = def ? Math.floor(Number(def.cost)) : NaN;
        if (!def || !this.storeHas(store, itemId) || !Number.isFinite(cost) || cost < 0) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: "That's not for sale here." }));
          break;
        }
        // Must actually be standing at that store's clerk — no buying from afar.
        if (!this._nearShop(entry, store)) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: "You're not at the shop." }));
          break;
        }
        if (entry.inventory.length >= MAX_SLOTS) {
          entry._ws.send(
            JSON.stringify({ type: 'notice', code: 'bag_full', text: 'Your bag is full!' })
          );
          break;
        }
        if (entry.money < cost) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: 'Not enough money.' }));
          break;
        }
        entry.money -= cost;
        entry.spentSinceCall = (entry.spentSinceCall | 0) + cost; // for Dad's report
        entry.inventory.push(itemId);
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        this._saveCharacter(playerId);
        break;
      }

      case 'sell': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const itemId = String(msg.item);
        const def = GOODS[itemId];
        const slot = entry.inventory.indexOf(itemId);
        const cost = def ? Math.floor(Number(def.cost)) : NaN;
        // Must own a slot of a known item with a valid catalog price (guards a
        // malformed cost from NaN-ing the wallet — see 'buy').
        if (!def || slot === -1 || !Number.isFinite(cost) || cost < 0) break;
        // Must be at a shop clerk to sell (any store buys back).
        if (!this._nearShop(entry, null)) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: "You're not at the shop." }));
          break;
        }
        entry.inventory.splice(slot, 1);
        entry.money += Math.floor(cost / 2); // EB buys back at half price
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        this._saveCharacter(playerId);
        break;
      }

      case 'drop_item': {
        // Throw a bag item onto the ground for anyone to pick up. Fully
        // server-authoritative & dupe-proof: the item must really be in THIS
        // socket's bag (identity bound to playerId, never client-supplied), it's
        // removed BEFORE the drop spawns (no clone), only ONE per message, and it
        // lands at the player's SERVER position (not a client-chosen spot, so you
        // can't fling loot across the map). Equipped gear lives outside the bag,
        // so it can never leak out here. No inventory fiddling while down/dying.
        const entry = this.players.get(playerId);
        if (!entry || entry.hp <= 0 || entry.downed || entry.dying) break;
        const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
        const def = itemId ? GOODS[itemId] : null;
        if (!def) break; // unknown id — ignore
        const slot = entry.inventory.indexOf(itemId);
        if (slot === -1) break; // don't own it — ignore (client pre-checks ownership)
        // Aimed toss target (world px). Default to the player's own spot if the
        // client omits/forges it; spawnPlayerDrop clamps it to range + off walls.
        const tx = Number.isFinite(msg.x) ? msg.x : entry.x;
        const ty = Number.isFinite(msg.y) ? msg.y : entry.y;
        entry.inventory.splice(slot, 1);
        this.npcSim.spawnPlayerDrop(entry.x, entry.y, tx, ty, itemId, def.name || '');
        entry._ws.send(
          JSON.stringify({ type: 'inventory', items: this.inventoryView(entry.inventory) })
        );
        this._saveCharacter(playerId);
        break;
      }

      // ATM: move money between the bank balance and on-hand cash. The server is
      // the sole authority — it clamps the amount to what actually exists, so a
      // forged/negative/oversized request can never mint money or overdraw. (The
      // client only opens the ATM menu when standing on an ATM sprite; proximity
      // isn't re-checked here because you can only ever move your OWN money.)
      case 'atm_withdraw': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        if (!this._nearAtm(entry)) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: "You're not at an ATM." }));
          break;
        }
        const want = Math.floor(Number(msg.amount));
        if (!Number.isFinite(want) || want <= 0) break;
        // NOTE: Math.floor, NOT `| 0` — bitwise OR truncates to int32 and would
        // wrap (corrupt the clamp) once a balance passes ~2.1B.
        const amount = Math.min(want, Math.max(0, Math.floor(entry.bank || 0)));
        if (amount <= 0) break;
        entry.bank -= amount;
        entry.money += amount;
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        entry._ws.send(JSON.stringify({ type: 'bank', bank: entry.bank }));
        this._saveCharacter(playerId);
        break;
      }

      case 'atm_deposit': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        if (!this._nearAtm(entry)) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: "You're not at an ATM." }));
          break;
        }
        const want = Math.floor(Number(msg.amount));
        if (!Number.isFinite(want) || want <= 0) break;
        // Math.floor, NOT `| 0` (int32 wrap at ~2.1B) — see atm_withdraw.
        const amount = Math.min(want, Math.max(0, Math.floor(entry.money || 0)));
        if (amount <= 0) break;
        entry.money -= amount;
        entry.bank += amount;
        entry._ws.send(JSON.stringify({ type: 'money', money: entry.money }));
        entry._ws.send(JSON.stringify({ type: 'bank', bank: entry.bank }));
        this._saveCharacter(playerId);
        break;
      }

      // Calling Dad: report the money banked from kills and cash spent at shops
      // since the LAST call (EarthBound flavor — "I put $X in your account…"),
      // then reset the tallies so the next call starts fresh. The money already
      // lives in the bank (kills credit it directly); these counters are just the
      // accounting Dad narrates. Server-authoritative — the client only displays.
      case 'dad_call': {
        const entry = this.players.get(playerId);
        if (!entry) break;
        const earned = entry.earnedSinceCall | 0;
        const spent = entry.spentSinceCall | 0;
        entry.earnedSinceCall = 0;
        entry.spentSinceCall = 0;
        entry._ws.send(JSON.stringify({ type: 'dad_report', earned, spent, bank: entry.bank | 0 }));
        this._saveCharacter(playerId);
        break;
      }

      case 'use_psi': {
        const entry = this.players.get(playerId);
        if (!entry || entry.hp <= 0) break;
        const psiId = typeof msg.psiId === 'string' ? msg.psiId : null;
        const def = psiId ? this.PSI[psiId] : null;
        if (!def) break; // unknown ability
        // Unlock gate: the move must be LEARNED (Mental >= its unlockMental).
        // Dev/admin accounts bypass entirely (test every move). Server-authoritative.
        if (!psiUnlocked(entry, def)) {
          if (entry._ws)
            entry._ws.send(
              JSON.stringify({ type: 'notice', text: "You haven't learned that PSI yet." })
            );
          break;
        }
        if (entry.pp < def.pp) break; // not enough PP
        // "Can't concentrate" (noPsi) blocks ALL PSI, even a cure — it must wear
        // off. The client also gates this; the server is the authority.
        const now = Date.now();
        if (status.isPsiBlocked(entry, now)) break;

        // Support PSI (heal / cure / revive) is PARTY-target: it acts on SELF by
        // default or on an ALLY the client picked (targetId). Validate the chosen
        // ally BEFORE spending PP so a bad/out-of-range pick never wastes the cast.
        const support = !!(def.heal || def.cures || def.reviveFrac);
        let target = entry;
        const tid = typeof msg.targetId === 'string' ? msg.targetId : null;
        if (support && tid && tid !== playerId) {
          const t = this.players.get(tid);
          if (!t) break; // stale target id — ignore (no PP spent)
          const dx = t.x - entry.x;
          const dy = t.y - entry.y;
          if (dx * dx + dy * dy > PSI_HEAL_RANGE * PSI_HEAL_RANGE) {
            entry._ws.send(JSON.stringify({ type: 'notice', text: 'Target is too far away.' }));
            break;
          }
          target = t;
        }
        // Revive PSI needs a DOWNED target; ordinary heal/cure can't be used on a
        // downed ally (they need reviving first). Refuse without spending PP.
        if (def.reviveFrac && !target.downed) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: 'No downed ally targeted.' }));
          break;
        }
        if (!def.reviveFrac && support && target.downed) {
          entry._ws.send(JSON.stringify({ type: 'notice', text: 'They need reviving first.' }));
          break;
        }

        entry.pp -= def.pp;
        entry._combatAt = Date.now(); // throttle PP regen briefly after a cast

        // Effect target for the projectile animation: the support target's spot
        // (self or ally) for heal/cure/revive; the struck enemy for offense PSI.
        let tx = Math.round((support ? target : entry).x);
        let ty = Math.round((support ? target : entry).y);
        // Multi-spot offense (Thunder bolts): every struck enemy's {x,y}, so the
        // client drops a strike FX on each (single-projectile casts leave it null).
        let hits = null;
        // Fan of projectile endpoints (Fire cone): one {tx,ty} per pellet, so the
        // client sprays a shotgun of FX from the caster (null = single projectile).
        let beams = null;
        // Set when the cast's visual is carried by server PROJECTILES (the Fire cone
        // now), so we skip the psi_cast flipbook broadcast — the projectiles ARE the
        // visual (and they're what stops at walls + syncs damage to the visual).
        let projVisual = false;
        if (def.reviveFrac) {
          // Revive the downed ally to a fraction of their max HP (γ half, Ω full).
          this._reviveDowned(target, Math.ceil(target.maxHp * def.reviveFrac));
        } else if (def.heal) {
          // healPlayer broadcasts player_hp and, if the target is mid mortal-roll,
          // can SAVE them (lift true HP above 0 → cancel the roll, stay standing).
          this.healPlayer(target, def.heal);
        }
        if (def.cures && !def.reviveFrac) {
          // Healing PSI clears the target's status conditions (self or ally).
          status.clearAll(target);
          this._broadcastPlayerStatus(target);
        }
        if (def.damage || def.inflict) {
          // Server picks the target(s) — it owns enemy positions. Damage +
          // knockback + the PSI's status inflict (each element-scaled by the
          // enemy's resist) resolve in the sim. ALL the visually-traveling shapes
          // (line/bolts) fire SERVER projectiles that damage ON CONTACT, so the
          // number lands as the bolt reaches the enemy (never before). Targeting
          // depends on def.shape:
          //   'line'  (Fire/Ice)— a forward CONE of piercing projectiles that fans
          //                      out per `spread` (spread 0 → ONE straight bolt = Ice).
          //   'screen'(Rockin'/ — every enemy in the caster's VIEW takes the hit at
          //   Starstorm/Flash)   once; `hits` carries each struck spot so the client
          //                      bursts the FX ON each (instant, visual = damage).
          //   'bolts' (Thunder)— `bolts` RANDOM enemies in range, each struck by a
          //                      lightning projectile that FALLS from above onto it.
          //   else (radius)    — nearest enemy in range, or every one if `multi`
          //                      (assist status moves: Hypnosis/Paralysis/Brainshock).
          // Direction: a directional cast (line) carries the player's mouse-aim
          // vector — normalize it and fire along it, exactly like a melee/ranged
          // swing. Also adopt the snapped facing so the cast points (and reads to
          // other clients) toward the cursor. Falls back to the 8-way facing for
          // keyboard/no-aim casts. screen/bolts/radius ignore direction.
          let v = PSI_DIR[entry.direction] || [0, 1];
          if (Number.isFinite(msg.aimx) && Number.isFinite(msg.aimy)) {
            const m = Math.hypot(msg.aimx, msg.aimy);
            if (m > 1e-3) v = [msg.aimx / m, msg.aimy / m];
            const adir = msg.dir | 0;
            if (adir >= 0 && adir < 8) entry.direction = adir;
          }
          if (def.shape === 'line') {
            // Traveling cone: a fan of piercing projectiles (sharing one hit-set so
            // each enemy takes the cast's damage once) that fly out at the cast speed
            // and damage on contact — damage now lands AS the fire reaches each enemy,
            // and a pellet that meets a wall dissolves there while the rest fly on.
            // The projectiles broadcast themselves to clients (which draw the PSI
            // flipbook via the 'psi:<anim>' sprite), so we skip the psi_cast fan.
            this.npcSim.psiStrikeCone(
              entry.x,
              entry.y,
              v[0],
              v[1],
              def.length || def.range || 240,
              def.spread || 0,
              def.damage || 0,
              playerId,
              def.inflict,
              entry.pk,
              entry.level || 1,
              def.projSpeed || 0,
              `psi:${def.anim || psiId}`
            );
            projVisual = true;
          } else if (def.shape === 'screen') {
            // Screen-wide burst (Rockin'/Starstorm/Flash): hit every enemy in view
            // now; `hits` carries each struck spot so the client bursts the cast FX
            // ON each enemy (delivery 'target' = no travel, so visual == damage).
            const struck = this.npcSim.psiStrikeScreen(
              entry.x,
              entry.y,
              PSI_SCREEN_HALF_W,
              PSI_SCREEN_HALF_H,
              def.damage || 0,
              playerId,
              def.inflict
            );
            if (struck.length) {
              hits = struck;
              tx = struck[0].x;
              ty = struck[0].y;
            } else {
              tx = Math.round(entry.x);
              ty = Math.round(entry.y);
            }
          } else if (def.shape === 'bolts') {
            // Thunder: lightning that FALLS from above onto `bolts` random enemies,
            // each a downward projectile that damages on contact (the strike). The
            // projectiles broadcast themselves, so we skip the psi_cast fan.
            this.npcSim.psiStrikeBoltsFalling(
              entry.x,
              entry.y,
              def.range || 520,
              def.bolts || 1,
              def.damage || 0,
              playerId,
              def.inflict,
              entry.pk,
              entry.level || 1,
              def.projSpeed || 0,
              `psi:${def.anim || psiId}`
            );
            projVisual = true;
          } else {
            const strike = def.multi ? this.npcSim.psiStrikeAll : this.npcSim.psiStrike;
            const hit = strike.call(
              this.npcSim,
              entry.x,
              entry.y,
              def.range || 240,
              def.damage || 0,
              playerId,
              def.inflict
            );
            if (hit) {
              tx = hit.x;
              ty = hit.y;
            } else {
              tx = Math.round(entry.x + v[0] * 96);
              ty = Math.round(entry.y + v[1] * 96);
            }
          }
        }
        // PP changed — push updated stats so the caster's PSI bar redraws.
        this.broadcastAll({
          type: 'player_stats',
          id: playerId,
          stats: statsPayload(entry),
          leveled: false,
          gained: 0,
        });
        // Cast animation to EVERYONE (incl. caster): `id` is the PsiAnim catalog
        // id; (x,y)=caster, (tx,ty)=target so a projectile flies caster→target.
        // Skipped when the cast's visual rides server projectiles (the Fire cone) —
        // those broadcast themselves and the client draws the flipbook on each.
        if (!projVisual) {
          this.broadcastAll({
            type: 'psi_cast',
            id: def.anim || psiId,
            caster: playerId,
            x: Math.round(entry.x),
            y: Math.round(entry.y),
            tx,
            ty,
            ...(hits ? { hits } : {}),
            ...(beams ? { beams } : {}),
          });
        }
        break;
      }

      case 'chat': {
        if (!this.players.has(playerId)) break;
        const text = String(msg.text || '')
          .slice(0, 100)
          .trim();
        if (!text) break;
        // Broadcast to everyone else; the sender shows its own bubble locally.
        this._publishPlayerEvent({ type: 'chat', id: playerId, text }, false);
        break;
      }

      case 'give_up': {
        // "Give up the ghost" during the downed window → resolve to true death now
        // (the client gates this behind a 2s hold so it's deliberate).
        const p = this.players.get(playerId);
        if (p && p.downed) this._trueDeath(playerId);
        break;
      }

      case 'set_pk': {
        // Server-authoritative PK with a 5-minute enable-LOCK measured in IN-GAME
        // time (pkLockMs counts down only while online, persisted), so it can't be
        // waited out or escaped by logging off. Enabling (re)arms the lock;
        // disabling is refused until it expires. Broadcast so every client renders
        // the PK marker; npcSim reads pk live through the getPlayers snapshot for
        // PvP + NPC aggro gating.
        const entry = this.players.get(playerId);
        if (!entry) break;
        if (msg.on) {
          entry.pk = true;
          entry.pkLockMs = PK_LOCK_MS; // committed for 5 min of in-game time
          entry.pkTickAt = Date.now();
        } else {
          this._tickPkLock(entry); // bring the remaining lock up to date
          if (entry.pkLockMs > 0) {
            // Still locked — refuse, and re-assert the truth so the client snaps back.
            this.sendTo(playerId, {
              type: 'player_pk',
              id: playerId,
              pk: true,
              lockMs: entry.pkLockMs,
            });
            break;
          }
          entry.pk = false;
          entry.pkLockMs = 0;
        }
        this.broadcastAll({
          type: 'player_pk',
          id: playerId,
          pk: entry.pk,
          lockMs: entry.pkLockMs,
        });
        this._saveCharacter(playerId);
        break;
      }

      case 'set_flag':
      case 'clear_flag': {
        // Persist a per-player quest flag change. Flags are PRIVATE (not
        // broadcast) and the server owns the stored copy in the character save.
        // NOTE: trigger validation (proving the player earned the flag) is a
        // later anti-cheat step — today the request is trusted and just stored.
        const set = this.flags.get(playerId);
        if (!set || !Number.isInteger(msg.id)) break;
        const changed = msg.type === 'set_flag' ? !set.has(msg.id) : set.has(msg.id);
        if (!changed) break;
        if (msg.type === 'set_flag') set.add(msg.id);
        else set.delete(msg.id);
        this._saveCharacter(playerId); // signed-in only; anon stays ephemeral
        break;
      }

      case 'clear_all_flags': {
        // Dev Flag Editor "reset progress": wipe this character's flags.
        const set = this.flags.get(playerId);
        if (!set || set.size === 0) break;
        set.clear();
        this._saveCharacter(playerId);
        break;
      }

      case 'mom_food': {
        // Talk to Ness's mom (client gates this to sprite 145): she cooks the
        // player's favorite food, healing MOM_FOOD_HEAL once per cooldown. SERVER-
        // AUTHORITATIVE: we own the heal, the cooldown clock, and the food name.
        // The client renders the dialogue from the facts we return.
        const p = this.players.get(playerId);
        if (!p || p.hp <= 0) break;
        const now = Date.now();
        const food = p.favoriteFood && p.favoriteFood.trim() ? p.favoriteFood.trim() : '';
        const readyAt = p.momFoodReadyAt || 0;
        if (now < readyAt) {
          // Still cooling down — tell them how long until the next meal.
          this.sendTo(playerId, { type: 'mom_food', healed: 0, readyInMs: readyAt - now, food });
          break;
        }
        const healed = Math.min(p.maxHp, p.hp + MOM_FOOD_HEAL) - p.hp;
        if (healed <= 0) {
          // Already full — no meal served, no cooldown spent.
          this.sendTo(playerId, { type: 'mom_food', healed: 0, readyInMs: 0, food });
          break;
        }
        p.hp += healed;
        p.momFoodReadyAt = now + MOM_FOOD_COOLDOWN_MS;
        this.broadcastAll({
          type: 'player_hp',
          id: playerId,
          hp: p.hp,
          maxHp: p.maxHp,
          dmg: 0,
          heal: healed,
        });
        this._saveCharacter(playerId); // persist the cooldown (relog-proof)
        this.sendTo(playerId, { type: 'mom_food', healed, readyInMs: MOM_FOOD_COOLDOWN_MS, food });
        break;
      }

      case 'open_gift': {
        // Open a present box ONCE per player. SERVER-AUTHORITATIVE: we own the
        // per-player flag (already-opened guard), the bag-room check, and the
        // item grant — the client only asks by placement key.
        const p = this.players.get(playerId);
        const set = this.flags.get(playerId);
        const gift = typeof msg.k === 'string' ? this.GIFTS.get(msg.k) : null;
        if (!p || !set || !gift || !Number.isInteger(gift.romFlag)) break;
        const flagId = GIFT_FLAG_BASE + gift.romFlag;
        if (set.has(flagId)) break; // already emptied — the open frame shows it

        const itemId = gift.item != null ? String(gift.item) : null;
        const givable = itemId != null && this.GOODS[itemId];

        // An empty / "special" container (no resolvable item) has nothing to
        // grant: show the canon flavor line so checking it isn't silent, and
        // DON'T consume the flag — an empty container stays closed + checkable.
        if (!givable) {
          p._ws.send(JSON.stringify({ type: 'notice', text: emptyContainerText(gift.sprite) }));
          break;
        }

        // A real item needs bag room; a full bag leaves the gift unopened so
        // they can return for it once they've made space.
        if (p.inventory.length >= MAX_SLOTS) {
          const now = Date.now();
          if (now - (p._bagFullAt || 0) >= BAG_FULL_NOTICE_MS) {
            p._bagFullAt = now;
            p._ws.send(
              JSON.stringify({ type: 'notice', code: 'bag_full', text: 'Your bag is full!' })
            );
          }
          break;
        }

        set.add(flagId); // mark opened (persists below)
        p.inventory.push(itemId);
        p._ws.send(JSON.stringify({ type: 'inventory', items: this.inventoryView(p.inventory) }));
        p._ws.send(
          JSON.stringify({ type: 'loot', item: itemId, name: this.GOODS[itemId].name || '' })
        );
        p._ws.send(JSON.stringify({ type: 'gift_opened', k: msg.k }));
        this._saveCharacter(playerId);
        break;
      }

      case 'spend_points': {
        // Spend banked skill points on the 5 creation stats. SERVER-AUTHORITATIVE:
        // the client only REQUESTS deltas; the server owns the point counter, the
        // alloc, and the derived stats. A request that asks for more than is banked,
        // for an unknown stat, for a negative/fractional amount, or that would blow
        // the cap is rejected wholesale — the client can't grant itself anything.
        const prog = this.points.get(playerId);
        const entry = this.players.get(playerId);
        if (!prog || !entry) break;
        const add = msg.add && typeof msg.add === 'object' ? msg.add : null;
        if (!add) break;
        if (Object.keys(add).some((k) => !STAT_KEYS.includes(k))) break; // unknown stat
        let total = 0;
        let ok = true;
        for (const k of STAT_KEYS) {
          const v = add[k] ?? 0;
          if (!Number.isInteger(v) || v < 0) {
            ok = false;
            break;
          }
          if ((prog.alloc[k] || 0) + v > STAT_SPEND_MAX) {
            ok = false;
            break;
          }
          total += v;
        }
        if (!ok || total <= 0 || total > (prog.unspentPoints || 0)) break;

        // Apply on the server side, then re-derive + persist. `prog` (this.points)
        // is the live source of truth; mirror the spent count onto the save handle
        // so its in-memory view stays consistent (alloc is already the SAME object,
        // shared at join).
        for (const k of STAT_KEYS) prog.alloc[k] = (prog.alloc[k] || 0) + (add[k] || 0);
        prog.unspentPoints -= total;
        const spHandle = this.saves.get(playerId);
        if (spHandle) spHandle.unspentPoints = prog.unspentPoints;
        this.reapplyAlloc(entry, prog.alloc);
        this.broadcastAll({
          type: 'player_stats',
          id: playerId,
          stats: statsPayload(entry),
          leveled: false,
          gained: 0,
        });
        // maxHp may have grown — refresh every client's bar for this player.
        this.broadcastAll({
          type: 'player_hp',
          id: playerId,
          hp: entry.hp,
          maxHp: entry.maxHp,
          dmg: 0,
        });
        this._sendPoints(playerId); // echo the authoritative remaining points + alloc
        this._saveCharacter(playerId);
        break;
      }
    }
  }
}

module.exports = { GameHost };
