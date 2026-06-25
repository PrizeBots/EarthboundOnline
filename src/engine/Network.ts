import { RemotePlayer, Direction, Pose, CharacterAppearance } from '../types';
import { GoodsItem } from './Inventory';
import { GroundDrop } from './DropManager';
import {
  frameTag,
  decodeNpcUpdate,
  decodeNpcDelta,
  decodePlayerMove,
  decodePlayerDelta,
  TAG,
  type NpcBase,
} from './wire';
import {
  getInterpDelayMs,
  getNpcInterpDelayMs,
  getCoastEvents,
  setJitterSource,
} from './RemoteInterp';

// Client-side delta baselines, mirrors of the server's per-socket _npcBase /
// _pmBase. Reset on each (re)connect so a fresh session starts from keyframes.
const npcDeltaBase: NpcBase = new Map();
const playerDeltaBase: NpcBase = new Map();

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
    pose: Pose,
    /** Client-clock time of this snapshot (server send-time mapped via the clock
     *  offset), for server-time-axis interpolation. Omitted pre-sync → use now. */
    t?: number
  ) => void;
  onPlayerLeave: (id: string) => void;
  onChat: (id: string, text: string) => void;
  /** A player equipped (or unequipped) a held item (the weapon, for the sprite). */
  onEquip: (id: string, itemId: string | null) => void;
  /** A remote player started a melee swing — replay the attack pose locally.
   *  `attackSpeed` scales the swing duration (1 = baseline). */
  onPlayerAttack?: (id: string, attackSpeed: number) => void;
  /** The LOCAL player's full equipped set (server-authoritative, per slot).
   *  attackSpeed is the equipped weapon's swing-rate multiplier (1 = baseline). */
  onEquipped: (slots: Record<string, string | null>, attackSpeed?: number) => void;
  /** Authoritative NPC positions (welcome snapshot + periodic deltas). `t` is the
   *  client-clock time of the snapshot (server send-time mapped via the clock
   *  offset) for server-time-axis interpolation; omitted pre-sync → use now. */
  onNpcUpdate: (npcs: NpcUpdate[], t?: number) => void;
  /** Authoritative enemy HP (welcome snapshot + on-damage deltas). */
  onNpcHp: (hps: NpcHp[]) => void;
  /** An actor's active status set changed: [npcId, [statusId,…]] rows. */
  onNpcStatus?: (rows: [number, string[]][]) => void;
  /** An actor's held weapon changed: [npcId, itemId|null] rows (welcome + deltas). */
  onNpcEquip?: (rows: [number, string | null][]) => void;
  /** AOI crowd overflow (§4.6): how many nearby PLAYERS are beyond the per-client
   *  visible cap and thus NOT individually rendered. 0 = everyone nearby is shown.
   *  Drives the "+N nearby" aggregate. Only ever sent when server AOI is on. */
  onCrowd?: (players: number) => void;
  /** A combatant died: play its rotate-and-bounce death throw. (dx,dy) is the
   *  unit heading the body is flung (away from the attacker); force = final dmg. */
  onNpcDeath?: (id: number, dx: number, dy: number, force: number) => void;
  /**
   * A player's HP changed (enemy hit / respawn refill / item use). dmg>0 = took
   * a hit; heal>0 = restored HP (e.g. ate a Cookie).
   */
  onPlayerHp: (
    id: string,
    hp: number,
    maxHp: number,
    dmg: number,
    heal: number,
    /** Attacker NPC wire id (enemy hits only) — to lunge it into range for the hit. */
    byNpc?: number
  ) => void;
  /**
   * A crit or a miss happened at world (x, y). `byPlayer` is the attacking
   * player's id (null for enemy/NPC swings); `targetPlayer` is the defending
   * player's id (null for enemy/NPC targets). Drives floating text + the
   * SMAAAASH! / just-missed / dodge SFX. Plain hits don't fire this — their
   * damage arrives via onNpcHp / onPlayerHp.
   */
  onCombat: (
    evt: 'crit' | 'miss' | 'hit',
    x: number,
    y: number,
    byPlayer: string | null,
    targetPlayer: string | null,
    dmg: number
  ) => void;
  /** The local player's Goods list (welcome snapshot + post-use deltas). */
  onInventory: (items: GoodsItem[]) => void;
  /** The local player's on-hand cash (welcome snapshot + deltas). */
  onMoney: (amount: number) => void;
  /** Restore the saved quick-select hotbar (welcome only): per slot a weapon /
   *  usable item id, a 'psi:<id>' tag, or null. */
  onHotbar?: (hotbar: (string | null)[]) => void;
  /** The local player's "favorite thing" (welcome only) — names the PSI ????
   *  special "PSI <favorite thing>" (blank → "Rockin'"). Display-only flavor. */
  onFavoriteThing?: (thing: string) => void;
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
  /** Server-authoritative position for OUR player (reconcile prediction): the
   *  server-simulated spot + the last input `seq` it reflects. */
  onPos?: (x: number, y: number, direction: Direction, frame: number, seq: number) => void;
  /** Server-authoritative door warp for OUR player: jump to (x,y). */
  onWarp?: (x: number, y: number) => void;
  /** A player's active status-condition set changed (paralysis, poison, …). */
  onPlayerStatus?: (id: string, statuses: string[]) => void;
  /** A PSI was cast — play its effect. (x,y)=caster, (tx,ty)=target (projectile
   *  flies between them). Sent to everyone incl. the caster. Visual only. */
  onPsiCast?: (
    id: string,
    casterId: string,
    x: number,
    y: number,
    tx: number,
    ty: number,
    hits?: { x: number; y: number }[],
    beams?: { tx: number; ty: number }[]
  ) => void;
  /** Another player used a consumable — play its "use" animation at (x,y).
   *  `item` is the item id; the caster already plays its own. Visual only. */
  onItemUse?: (id: string, item: string, x: number, y: number) => void;
  /** A ranged weapon fired — spawn the flying shot. (x,y)=muzzle, (vx,vy)=unit
   *  direction, `speed` px/tick, `dist` max travel, `sprite` look. Visual only;
   *  the server owns travel/damage and follows up with `proj_end`. */
  onProjectile?: (
    id: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    speed: number,
    dist: number,
    sprite: string | null
  ) => void;
  /** A shot ended at (x,y) — snap it there + pop an impact spark. `hit` = it
   *  connected with a target (vs hitting a wall / flying out its range). */
  onProjEnd?: (id: number, x: number, y: number, hit: boolean) => void;
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
  /** A lethal hit started the EB rolling-HP "Mortal Damage" death. The bar rolls
   *  from `fromHp` → 0 over `ms` while the player stays up and can heal to survive;
   *  `banner` flags windows long enough to announce MORTAL DAMAGE!; `dmg` is the
   *  hit that triggered it (for the damage number + flinch). */
  onPlayerMortal?: (
    id: string,
    fromHp: number,
    maxHp: number,
    ms: number,
    banner: boolean,
    dmg: number
  ) => void;
  /** A player was KO'd (downed). `ms` = the revive window length; the client lays
   *  them out, counts down, and (for the owner) draws the closing vignette.
   *  (dx,dy) is the killing blow's heading + `force` its damage, driving the
   *  rotate-and-fling KO throw (KoThrow). */
  onPlayerDowned?: (id: string, ms: number, dx: number, dy: number, force: number) => void;
  /** A downed player was revived (by an ally) — stand them back up. */
  onPlayerRevived?: (id: string) => void;
  /** Public state of arming/in-progress events (trigger circle + countdown/timer),
   *  broadcast ~10Hz. Drives the world-space circle + the "event in progress" timer. */
  onEventState?: (events: EventStateWire[]) => void;
  /** The LOCAL player was warped by an event — into the room (`eventId` set) or back
   *  out (`eventId` null). Does a door-style fade to (x,y) facing `dir`. */
  onEventWarp?: (x: number, y: number, dir: Direction, eventId: string | null) => void;
};

/** Per-event UI state the server broadcasts (server/eventRuntime.js). */
export interface EventStateWire {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  phase: 'arming' | 'active';
  countdownMs?: number; // arming: ms left before the warp-in
  timerMs?: number; // active: ms left on the event timer
}

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

// --- Heartbeat / latency (app-level ping↔pong) ---
// The browser WebSocket API can't send protocol ping frames, so we run our own
// JSON ping↔pong. It does two jobs:
//   1. Measures RTT + jitter (read via getNetStats / the ?netdebug overlay) so
//      the interpolation buffer can be tuned against REAL prod numbers.
//   2. Detects a SILENTLY dead socket — half-open TCP (the client's network
//      dropped without a close frame) can otherwise keep us glued to a dead
//      connection for a long time, which shows up as the other player freezing
//      then teleporting once the browser finally fires onclose. If no pong
//      arrives within PONG_TIMEOUT_MS we force-close to reconnect fast.
const PING_INTERVAL_MS = 2000;
const PONG_TIMEOUT_MS = 8000;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = 0;
let rttMs = 0;
let jitterMs = 0;
let serverHz = 0; // effective server sim rate from the pong (nominal ~30; low = CPU-bound)
const rttSamples: number[] = [];

// --- Server clock sync (jitter-immune interpolation) ---
// Each firehose frame carries the server's send time on the SERVER clock. We
// estimate the client↔server offset from ping/pong (NTP-style) so a frame's
// server time maps onto OUR performance.now() axis; RemoteInterp then buffers on
// that axis and arrival jitter stops warping remote playback. Until the first
// pong lands we have no offset — callers fall back to performance.now().
let clockOffset = 0; // ≈ serverClock - clientClock
let clockReady = false;
let bestRtt = Infinity; // lowest RTT seen — its offset sample is the most trustworthy

/** Map a server-clock timestamp (ms) onto the local performance.now() axis. */
export function serverToClient(srv: number): number {
  return srv - clockOffset;
}

/** Client-clock timestamp for an incoming frame: its synced server time when we
 *  have a clock, else now (pre-sync, or a JSON frame with no `ts`). */
export function frameClientTime(ts?: number): number {
  return clockReady && typeof ts === 'number' ? serverToClient(ts) : performance.now();
}

/** Live connection-quality readout for the ?netdebug overlay (and any HUD). */
export interface NetStats {
  connected: boolean;
  rtt: number; // last round-trip latency, ms
  jitter: number; // mean abs deviation of recent RTTs, ms
  reconnects: number; // reconnect attempts since the last clean open
  clockOffset: number; // estimated serverClock - clientClock, ms (0 until synced)
  clockSynced: boolean; // a clock offset has been established from a pong
  serverHz: number; // effective server sim rate (nominal ~30; low = CPU-bound box)
}

export function getNetStats(): NetStats {
  return {
    connected: !!ws && ws.readyState === WebSocket.OPEN,
    rtt: Math.round(rttMs),
    jitter: Math.round(jitterMs),
    reconnects: reconnectAttempt,
    clockOffset: Math.round(clockOffset),
    clockSynced: clockReady,
    serverHz,
  };
}

/** Live measured jitter (ms) — RemoteInterp reads this to size its buffer. */
export function getJitterMs(): number {
  return jitterMs;
}

// Feed the live jitter readout into the interpolators' adaptive delay (one-way:
// RemoteInterp never imports Network, so no cycle).
setJitterSource(getJitterMs);

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = performance.now();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // No pong for too long ⇒ the socket is silently dead. Force-close so onclose
    // fires and the backoff reconnects us fast (instead of waiting on TCP).
    if (performance.now() - lastPongAt > PONG_TIMEOUT_MS) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      return;
    }
    // Report our measured RTT AND how far back we render enemies (the adaptive NPC
    // interp delay) so the server rewinds its melee hitbox to exactly what we saw —
    // otherwise swings test the wrong moment and miss moving targets. Server clamps.
    ws.send(
      JSON.stringify({
        type: 'ping',
        t: performance.now(),
        rtt: Math.round(rttMs),
        interp: Math.round(getNpcInterpDelayMs()),
      })
    );
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

// Record one round-trip sample (from a 'pong') into the RTT + jitter readout, and
// fold the server timestamp `srv` into the client↔server clock-offset estimate.
function recordPong(sentAt: number, srv?: number, srvHz?: number) {
  const recvAt = performance.now();
  lastPongAt = recvAt;
  if (typeof srvHz === 'number') serverHz = srvHz;
  if (typeof sentAt !== 'number') return;
  rttMs = recvAt - sentAt;
  rttSamples.push(rttMs);
  if (rttSamples.length > 20) rttSamples.shift();
  // Jitter = mean absolute difference between consecutive RTTs (RFC 3550-style).
  let acc = 0;
  for (let i = 1; i < rttSamples.length; i++) acc += Math.abs(rttSamples[i] - rttSamples[i - 1]);
  jitterMs = rttSamples.length > 1 ? acc / (rttSamples.length - 1) : 0;

  // Clock offset (NTP-style): the pong's `srv` ≈ the server clock at the request's
  // midpoint, whose client time is (sentAt + recvAt)/2. Low-RTT samples carry the
  // least asymmetry error, so weight them hardest; `bestRtt` slowly re-baselines so
  // a genuine latency shift can re-tune the offset.
  if (typeof srv === 'number') {
    const sample = srv - (sentAt + recvAt) / 2; // ≈ serverClock - clientClock
    if (!clockReady) {
      clockOffset = sample;
      clockReady = true;
      bestRtt = rttMs;
    } else {
      const a = rttMs <= bestRtt ? 0.5 : 0.05;
      clockOffset += a * (sample - clockOffset);
    }
    bestRtt = Math.min(rttMs, bestRtt * 1.02 + 1);
  }
}

// Decode one binary firehose frame and fan it to the callbacks. Transport-agnostic
// — fed by both ws.onmessage and the WebRTC DataChannel (Stage D). The delta
// decoders mutate the shared baselines, so frames MUST stay ordered per transport;
// we run a single channel at a time (WS until the DataChannel opens), never both.
function handleBinaryFrame(buf: ArrayBuffer): void {
  const tag = frameTag(buf);
  if (tag === TAG.NPC_UPDATE) {
    const u = decodeNpcUpdate(buf);
    callbacks?.onNpcUpdate(u.npcs, frameClientTime(u.ts));
  } else if (tag === TAG.NPC_DELTA) {
    const u = decodeNpcDelta(buf, npcDeltaBase);
    callbacks?.onNpcUpdate(u.npcs, frameClientTime(u.ts));
  } else if (tag === TAG.PLAYER_MOVE) {
    const m = decodePlayerMove(buf);
    callbacks?.onPlayerMove(m.id, m.x, m.y, m.direction, m.frame, m.pose, frameClientTime(m.ts));
  } else if (tag === TAG.PLAYER_DELTA) {
    const m = decodePlayerDelta(buf, playerDeltaBase);
    callbacks?.onPlayerMove(m.id, m.x, m.y, m.direction, m.frame, m.pose, frameClientTime(m.ts));
  }
}

// --- WebRTC DataChannel transport (Stage D) ----------------------------------
// Opt-in with `?rtc` (the server must also run with RTC_ENABLED=1). We offer an
// unreliable/unordered channel for the firehose; a lost packet becomes one skipped
// snapshot instead of a TCP head-of-line stall. Signaling rides the existing WS.
// If anything fails (no answer, blocked UDP), the firehose just stays on the WS.
const RTC_ENABLED = typeof location !== 'undefined' && /[?&]rtc\b/i.test(location.search);
const RTC_ICE = 'stun:stun.l.google.com:19302';
let rtcPc: RTCPeerConnection | null = null;
let rtcDc: RTCDataChannel | null = null;
let rtcRemoteSet = false;
const rtcPendingIce: RTCIceCandidateInit[] = []; // candidates that arrived before the answer

function wsSendJson(obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/** Tear down any live peer (called before a (re)connect and on close). */
function closeRtc(): void {
  rtcRemoteSet = false;
  rtcPendingIce.length = 0;
  try {
    rtcDc?.close();
    rtcPc?.close();
  } catch {
    /* already gone */
  }
  rtcDc = null;
  rtcPc = null;
}

/** Kick off the offer/answer handshake over the open WS. */
async function setupRtc(): Promise<void> {
  if (!RTC_ENABLED || typeof RTCPeerConnection === 'undefined') return;
  closeRtc();
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: RTC_ICE }] });
    rtcPc = pc;
    const dc = pc.createDataChannel('firehose', { ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => handleBinaryFrame(e.data as ArrayBuffer);
    dc.onopen = () => console.log('[rtc] DataChannel open — firehose on WebRTC');
    dc.onclose = () => console.log('[rtc] DataChannel closed — firehose back on WS');
    rtcDc = dc;
    pc.onicecandidate = (e) => {
      if (e.candidate)
        wsSendJson({ type: 'rtc_ice', cand: e.candidate.candidate, mid: e.candidate.sdpMid });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSendJson({ type: 'rtc_offer', sdp: offer.sdp });
  } catch (e) {
    console.warn('[rtc] setup failed — staying on WS:', e);
    closeRtc();
  }
}

/** Handle the server's signaling replies relayed over the WS. */
async function onRtcSignal(msg: {
  type: string;
  sdp?: string;
  cand?: string;
  mid?: string;
}): Promise<void> {
  if (!rtcPc) return;
  try {
    if (msg.type === 'rtc_answer' && msg.sdp) {
      await rtcPc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      rtcRemoteSet = true;
      for (const c of rtcPendingIce.splice(0)) await rtcPc.addIceCandidate(c);
    } else if (msg.type === 'rtc_ice' && msg.cand) {
      const cand: RTCIceCandidateInit = { candidate: msg.cand, sdpMid: msg.mid };
      // addIceCandidate before the remote description is set throws — buffer it.
      if (rtcRemoteSet) await rtcPc.addIceCandidate(cand);
      else rtcPendingIce.push(cand);
    }
  } catch (e) {
    console.warn('[rtc] signaling error — staying on WS:', e);
  }
}

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
  // Binary frames (the BINARY_WIRE position firehose) arrive as ArrayBuffer, not
  // Blob — so we can decode synchronously in onmessage. JSON control messages
  // still arrive as strings, so the two are trivially distinguishable.
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectAttempt = 0; // a clean connection resets the backoff
    npcDeltaBase.clear(); // fresh session → server re-keyframes; drop stale baseline
    playerDeltaBase.clear();
    // Drop the clock-offset estimate: a reconnect may hit a restarted server whose
    // monotonic clock reset, so re-baseline from the next pong instead of carrying
    // a now-wrong offset (which would misplace every interpolated frame).
    clockReady = false;
    bestRtt = Infinity;
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
    startHeartbeat(); // begin app-level ping↔pong (RTT + dead-socket watchdog)
    if (RTC_ENABLED) void setupRtc(); // opt-in WebRTC firehose; no-op if the server declines
  };

  ws.onmessage = (ev) => {
    // Binary frame = the position firehose (BINARY_WIRE). The same frames arrive on
    // either transport (WS or the Stage-D WebRTC DataChannel) and decode identically.
    if (typeof ev.data !== 'string') {
      handleBinaryFrame(ev.data as ArrayBuffer);
      return;
    }
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'pong':
        recordPong(msg.t, msg.srv, msg.srvHz);
        break;
      case 'rtc_answer':
      case 'rtc_ice':
        void onRtcSignal(msg);
        break;
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
        // EB naming flavor — names the "PSI ????" special (anonymous joins omit it).
        if (typeof msg.favoriteThing === 'string') callbacks?.onFavoriteThing?.(msg.favoriteThing);
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
        callbacks?.onNpcUpdate(msg.npcs, frameClientTime(msg.ts));
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
      case 'npc_death':
        callbacks?.onNpcDeath?.(msg.id, msg.dx ?? 0, msg.dy ?? 0, msg.force ?? 0);
        break;
      case 'player_join':
        callbacks?.onPlayerJoin(msg.player);
        break;
      case 'player_move':
        callbacks?.onPlayerMove(
          msg.id,
          msg.x,
          msg.y,
          msg.direction,
          msg.frame,
          msg.pose ?? 'walk',
          frameClientTime(msg.ts)
        );
        break;
      case 'player_leave':
        callbacks?.onPlayerLeave(msg.id);
        break;
      case 'chat':
        callbacks?.onChat(msg.id, msg.text);
        break;
      case 'crowd':
        callbacks?.onCrowd?.(msg.players ?? 0);
        break;
      case 'equip':
        callbacks?.onEquip(msg.id, msg.itemId ?? null);
        break;
      case 'player_attack':
        callbacks?.onPlayerAttack?.(msg.id, msg.attackSpeed ?? 1);
        break;
      case 'equipped':
        callbacks?.onEquipped(msg.slots ?? {}, msg.attackSpeed);
        break;
      case 'player_hp':
        callbacks?.onPlayerHp(msg.id, msg.hp, msg.maxHp, msg.dmg ?? 0, msg.heal ?? 0, msg.byNpc);
        break;
      case 'player_mortal':
        callbacks?.onPlayerMortal?.(
          msg.id,
          msg.fromHp,
          msg.maxHp,
          typeof msg.ms === 'number' ? msg.ms : 0,
          !!msg.banner,
          msg.dmg ?? 0
        );
        break;
      case 'combat':
        callbacks?.onCombat(
          msg.evt,
          msg.x,
          msg.y,
          msg.byPlayer ?? null,
          msg.targetPlayer ?? null,
          msg.dmg ?? 0
        );
        break;
      case 'player_push':
        callbacks?.onPlayerPush?.(msg.id, msg.x, msg.y);
        break;
      case 'pos':
        callbacks?.onPos?.(msg.x, msg.y, msg.direction, msg.frame, msg.seq ?? 0);
        break;
      case 'warp':
        callbacks?.onWarp?.(msg.x, msg.y);
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
          typeof msg.ty === 'number' ? msg.ty : msg.y,
          Array.isArray(msg.hits) ? msg.hits : undefined,
          Array.isArray(msg.beams) ? msg.beams : undefined
        );
        break;
      case 'item_use':
        callbacks?.onItemUse?.(msg.id, msg.item, msg.x, msg.y);
        break;
      case 'projectile':
        callbacks?.onProjectile?.(
          msg.id,
          msg.x,
          msg.y,
          msg.vx,
          msg.vy,
          msg.speed,
          msg.dist,
          typeof msg.sprite === 'string' ? msg.sprite : null
        );
        break;
      case 'proj_end':
        callbacks?.onProjEnd?.(msg.id, msg.x, msg.y, !!msg.hit);
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
      case 'event_state':
        callbacks?.onEventState?.(Array.isArray(msg.events) ? msg.events : []);
        break;
      case 'event_warp':
        callbacks?.onEventWarp?.(msg.x, msg.y, (msg.dir ?? 0) as Direction, msg.eventId ?? null);
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
        callbacks?.onPlayerDowned?.(
          msg.id,
          typeof msg.ms === 'number' ? msg.ms : 0,
          msg.dx ?? 0,
          msg.dy ?? 0,
          msg.force ?? 0
        );
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
    stopHeartbeat(); // no live socket to ping; onopen restarts it after reconnect
    closeRtc(); // drop the WebRTC peer; setupRtc re-runs on the next open
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

/** Server-authoritative movement: send the held-direction INPUT for one frame
 *  (never a position). The server simulates it and ACKs `seq` via a `pos`. */
export function sendInput(seq: number, dx: number, dy: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', seq, dx, dy }));
  }
}

/** Ask the server to use the door we're standing on. The server validates we're
 *  actually on a door and warps us to ITS destination (replies with a `warp`). */
export function sendUseDoor() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'use_door' }));
  }
}

/** Escalator/stairway ride finished: tell the server our landing spot. The
 *  glide across the solid steps is client-driven; the server honors this only
 *  when our authoritative position is actually on a stair trigger (anti-cheat),
 *  then resyncs there + raises the warp shield. */
export function sendRideWarp(x: number, y: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ride_warp', x: Math.round(x), y: Math.round(y) }));
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
 * Report finishing a conversation with an NPC (its dialogue textId), so the
 * server can arm a dialogue-start event (EVENT_MANAGER.md). Sent after every
 * dialogue close; the server ignores it unless an event matches the NPC.
 */
export function sendEventTalk(npcTextId: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'event_talk', npcTextId }));
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

/** Editor click-to-teleport: authoritatively set the player's position (dev-only;
 *  the server honors it only while in editor mode). Persists into gameplay on exit. */
export function sendEditorTeleport(x: number, y: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'editor_teleport', x: Math.round(x), y: Math.round(y) }));
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

/** Ask the server to cast a PSI ability; it validates PP and resolves the effect.
 *  `targetId` aims a party-target PSI (Lifeup/Healing/revive) at an ally; omit it
 *  to target self (or, for revive, the server uses the nearest downed ally). */
export function sendUsePsi(psiId: string, targetId?: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'use_psi', psiId, ...(targetId ? { targetId } : {}) }));
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

/**
 * Opt-in on-screen network readout (?netdebug) — RTT, jitter, connection state.
 * Mirrors mountGamepadDebug (Gamepad.ts): its own rAF loop + fixed overlay, no
 * console needed. Open prod with ?netdebug to read REAL latency/jitter so the
 * interpolation buffer can be tuned against measured numbers, not guesses.
 */
export function mountNetDebug(): void {
  if (!/[?&]netdebug/i.test(location.search)) return;

  // Container marked [data-ui] so the game's mousedown handler (Input.ts) treats it
  // as UI — clicking it selects/copies instead of swinging the sword. (The old bare
  // <pre> both triggered attacks AND, rewriting textContent every frame, wiped any
  // selection 60x/sec — which is why dragging to copy never worked. The Copy button
  // sidesteps selection entirely via the clipboard API.)
  const box = document.createElement('div');
  box.setAttribute('data-ui', '');
  box.style.cssText =
    'position:fixed;right:4px;top:4px;z-index:99999;padding:6px 8px;' +
    'background:rgba(0,0,0,.82);border-radius:4px;font:11px/1.35 monospace;color:#3cd0ff;' +
    'pointer-events:auto;user-select:text;-webkit-user-select:text;';

  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;white-space:pre;cursor:text;';

  const btn = document.createElement('button');
  btn.textContent = 'Copy';
  btn.style.cssText =
    'margin-top:5px;font:10px monospace;color:#3cd0ff;background:#02202b;' +
    'border:1px solid #3cd0ff;border-radius:3px;padding:2px 8px;cursor:pointer;';
  btn.onclick = () => {
    const text = pre.textContent || '';
    const ok = () => {
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    };
    // clipboard API (needs a secure context — prod is https); fall back to a hidden
    // textarea + execCommand for plain-http dev.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text, ok));
    } else {
      fallbackCopy(text, ok);
    }
  };

  box.appendChild(pre);
  box.appendChild(btn);
  document.body.appendChild(box);

  // 4Hz is plenty for eyeballing — and not rewriting every frame lets a manual
  // drag-select survive between updates too. We diff the coast counter + a wall
  // clock into a per-second underrun rate (the buffer-sizing signal).
  let lastCoast = getCoastEvents();
  let lastAt = performance.now();
  const update = () => {
    const s = getNetStats();
    const nowAt = performance.now();
    const coast = getCoastEvents();
    const coastRate = Math.round(((coast - lastCoast) * 1000) / Math.max(1, nowAt - lastAt));
    lastCoast = coast;
    lastAt = nowAt;
    pre.textContent = [
      'NET DEBUG (?netdebug)',
      `state : ${s.connected ? 'connected' : 'DISCONNECTED'}`,
      `rtt   : ${s.rtt} ms`,
      `jitter: ${s.jitter} ms`,
      `clock : ${s.clockSynced ? `${s.clockOffset >= 0 ? '+' : ''}${s.clockOffset} ms` : 'syncing…'}`,
      `interp: ${Math.round(getInterpDelayMs())} ms (npc ${Math.round(getNpcInterpDelayMs())})`,
      // coast/sec = interp buffer underruns; >0 sustained ⇒ buffer too small for this
      // link. server = effective sim Hz (nominal ~30); low ⇒ CPU-bound box, not network.
      `coast : ${coastRate}/s`,
      `server: ${s.serverHz || '?'} Hz`,
      `recon : ${s.reconnects}`,
    ].join('\n');
  };
  update();
  setInterval(update, 250);
}

/** Copy `text` via a hidden textarea + execCommand — the fallback when the async
 *  clipboard API is unavailable (e.g. plain-http localhost). */
function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    /* clipboard blocked — nothing more we can do */
  }
  ta.remove();
}
