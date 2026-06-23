# Network Remodel — One Persistent World, 100k+ Concurrent

**Status:** Proposal / target architecture. Nothing here is built yet. This is the
**official** network-scaling design doc (it consolidates two earlier drafts; the
appendix records why each call was made). Pair with
[ARCHITECTURE.md](ARCHITECTURE.md) (current system) and [CLAUDE.md](CLAUDE.md)
(ROM/asset policy — servers stay code-only).

**Goal:** A single shared, seamless, persistent world holding **100,000+
simultaneous players** with action-game feel (sub-150 ms reaction latency where
it matters), built so it still maps cleanly onto the long-term SNES/ESP32 port.

> Tags flagged ⟪v3⟫ mark design additions beyond the original drafts: a
> **degrade-don't-drop tick budget** (§7.5), **subscription hysteresis** (§4.2),
> **gateway delta-baseline accounting** (§5), **handoff crash/recovery** (§7.4),
> **reconnect/session resume** (§8.5), **event-relevance routing** (§4.4), the
> **encoding-by-channel matrix** (§5), and the **runtime & transport stack
> decision** (§5.5).

---

## Build progress (living checklist — update each work session)

> A 10-min `/loop` is driving this incrementally. **Resume here.** Each step must
> stay shippable: default behavior unchanged until a feature flag flips it on.

- [x] **Phase 0 — instrumentation.** `_recordSend`/`netStats` in `gameHost.js`;
      `NET_DEBUG=1` logs per-type sends/s + egress + AOI occupancy every 5s.
- [~] **Phase 1 — AOI in the monolith.** Foundation laid:
  - [x] `server/aoi.js` `SpatialGrid` (cell hash, `update`/`remove`/`around`); unit-checked.
  - [x] Grid maintained on join/move/leave; `publishToArea()` added; `player_move`
        routed through it (falls back to `broadcastExcept` while `AOI_ENABLED` off).
  - [x] Player spawn/despawn (enter/leave) protocol: `_refreshAoi` emits targeted
        `player_join`/`player_leave` both ways on cell crossings + join; `_clearAoi`
        on disconnect. Reuses existing client msgs (no client change). Tested both
        directions. Gated by `AOI_ENABLED` — out-of-AOI remotes now despawn, not freeze.
  - [x] `npc_update` per-client AOI filtering: `publishNpcUpdate` buckets the
        moved-NPC rows by cell once, each player gathers its 3×3 block. The real
        firehose is now O(local density), not O(world NPCs). Tested; falls back to
        global broadcast while `AOI_ENABLED` off. (npc_hp/status/equip stay global.)
  - [x] Subscription hysteresis (§4.2): players carry a hysteretic _anchor cell_
        (re-anchors only after moving ¼-cell past the boundary); `_refreshAoi` +
        NPC filtering key off the anchor (`aroundId`/`anchorOf`), not exact pos.
        Boundary-walking no longer storms spawn/despawn. Tested: 0 flips in-band.
  - [x] Crowd cap — NPC firehose (§4.6): `publishNpcUpdate` caps each client to
        `AOI_MAX_NPCS` (def 120) nearest rows/tick, remainder rides as an `over`
        count for a future aggregate render. Sorts only when over cap (free under
        it). Churn-free (npc_update is stateless). Tested nearest-M + over count.
  - [x] Crowd cap — player firehose (§4.6): per-client nearest-`AOI_MAX_PLAYERS`
        visible set with RANK hysteresis (no M/M+1 flap); spawn/despawn is now
        per-client/asymmetric; `_seenBy` reverse index routes `player_move` only to
        viewers who spawned the mover (O(movers×viewers), not O(crowd²)); a 4Hz
        relevance pass keeps a stationary player's view fresh as a crowd shifts;
        `_crowdOver` stashed for the aggregate render. Tested: cap, routing, hyst, off-path.
  - [x] Welcome snapshot trimmed: players already []; NPC/drop join burst now
        AOI-scoped via `npcSim.aoiSnapshot(inRange)` + `_aoiJoinSnapshot` (joiner's
        3×3 block). Join cost O(local NPCs), not O(world). Mirrors legacy semantics
        (divergent positions, enemy HP incl. dead, armed equips, in-range drops). Tested.
  - [x] `loadtest.js` rebuilt for AOI measurement: bots now walk the SERVER-AUTH
        `input` path (old 'move' was editor-only → rejected, so prior runs never
        moved anyone); fan-out dispersal across cells + `--hotspot` crowd mode;
        ramped connects for thousands; reports PER-CLIENT downlink (avg/p50/p95/max) + spatial spread. Smoke-tested live (3 bots, clean). The before/after metric.
  - [x] Crowd aggregate render: server emits `crowd` (player overflow) on change
        from `_refreshAoi` (AOI-only); client `onCrowd` → "+N nearby" HUD badge
        during gameplay (`Game.ts`). Throttled, clears at 0. tsc clean; tested.
  - [x] `AOI_ENABLED` flipped ON by default (prod). Gameplay-parity defects this
        exposed (all latency/AOI-only, hence "fine locally, broken in prod") FIXED:
    - [x] **Teleports left AOI stale → empty buildings.** `use_door` / `ride_warp` /
          `warpEventPlayer` set x/y directly, never through `_simPlayers`' `aoi.update`,
          so the anchor stayed in the OLD cell: the NPC firehose kept filtering for
          where the player WAS, and since `npc_update` is moved-only, the destination's
          STATIONARY actors (and every enemy's one-shot activation `npc_hp`) never
          arrived — you warped into a building and it was empty. New `_warpResnapshot`
          re-anchors + resends the destination block's NPC positions + HP + equips
          (same payload `welcome` uses) + drops the per-socket delta baseline. Proven:
          warping onto an enemy now resends its activation HP; without it the player
          got 0 npc rows for the area.
    - [x] **`_refreshAoi` was one-directional → newcomers invisible to peers.** It
          spawned peers TO the (re)appearing player but never the player to them (that
          waited on the 4Hz pass). New `_refreshAoiReciprocal` re-evaluates every peer
          in the block so join/warp spawns both ways at once. Used on join + teleport.
  - [ ] **Still TODO:** the broader gameplay-parity sweep + `NET_DEBUG` bandwidth
        measure (recipe in loadtest.js header: N bots AOI off vs on, compare downlink).
- [~] **Phase 2 — binary + delta wire format** (§5 matrix).
  - [x] Binary codec for the `npc_update` firehose: `server/wire.js` + mirrored
        `src/engine/wire.ts` (hand-packed LE, half-pixel uint16 coords, uint32 id).
        3.1× smaller than JSON; golden-vector locked; **cross-runtime lockstep proven**
        (client-compiled decode of server bytes, both directions). NOT yet wired.
  - [x] Wired behind `BINARY_WIRE`: server `publishNpcUpdate` sends binary on both
        the AOI per-client and AOI-off broadcast paths (`_sendNpcUpdate`); client sets
        `binaryType='arraybuffer'`, detects non-string frames → `decodeNpcUpdate`.
        JSON fallback when off. All 4 flag combos verified end-to-end (server bytes
        decoded by the compiled client codec). Independent of `AOI_ENABLED`.
  - [x] `player_move` binary codec (tag 0x02, 12B vs ~90B JSON = 7.5×): `wire.js` +`wire.ts` (uint32 numeric-string id, half-pixel coords, POSES pose byte);
        wired in `_publishMove` (AOI viewers + AOI-off broadcast) + client tag dispatch.
        All 6 poses + edge values round-trip both ways; unknown pose → walk. Tested.
  - [x] Delta-coding for `npc_update` (tag 0x03): server keeps a per-socket baseline
        (`_npcBase`), client mirrors it (`npcDeltaBase`); rows send Δ-coords (int8) vs
        absolute, and OMIT unchanged dir/frame/pose via a flags byte. `encodeNpcDelta`
        /`decodeNpcDelta` are exact inverses over the shared baseline → no drift on
        reliable WS. KEY on first-sight/>127 jump; baseline bounded + reset on reconnect.
        Minimal moving row ~8B. **Cross-runtime + baseline-sync proven** over key/delta/
        jump/absent/return sequences. Runs on the AOI per-client path (BINARY_WIRE).
  - [x] Event-relevance routing (§4.4): hot per-hit combat events `player_hp` +
        `player_push` now route via `_publishPlayerEvent` to the affected player +
        its `_seenBy` viewers (not global `broadcastAll`) — removes an O(N) broadcast
        per hit/knockback. AOI off → unchanged global. Tested both ways.
  - [ ] **BLOCKED (needs user):** Schema'd binary (FlatBuffers) for structured events
        (§5) requires installing the `flatc` toolchain + a codegen build step + repo
        policy for generated code — an infra decision, not auto-doable. Low bandwidth
        value vs the firehose (events are low-rate). Defer until the toolchain is chosen.
  - [x] Extended §4.4 routing to `equip` / `player_attack` / `chat` via the same
        `_publishPlayerEvent` (now with `includeSelf` to cover both broadcastAll- and
        broadcastExcept-style events). All player-centric events are viewer-scoped when
        AOI is on. NOTE: chat becomes proximity-scoped (matches floating-bubble model;
        revisit if a global chat channel is wanted). Tested both flag states.
  - [x] **Regression check** (after 9 runs of flag-gated edits): `npm run test:server`
        with flags OFF — combat 23/0, loot*carry 8/0, charStats 9/0 all pass; gameHost
        51/10 — but the 10 failures are **PRE-EXISTING** (HEAD's gameHost.js gives the
        identical 51/10). My changes are exactly regression-neutral. ⚠ The 10 pre-existing
        gameHost failures (equip/unequip/use_item/buy/sell/revive \_preconditions* — e.g.
        "wrong money after buy 0 !== -18") predate this work; likely a test-harness/shop
        setup issue, NOT netcode. Worth a look but out of this overhaul's scope.
  - [x] `player_move` delta-coding (tag 0x04): per-VIEWER baseline (`_pmBase` server /
        `playerDeltaBase` client) since each viewer spawned the mover at a different
        time → first send is a keyframe, then ~9B deltas (vs 87B JSON, ~9.7×). Same
        flag scheme as npc_delta; end-to-end correct across despawn/respawn. Encodes
        per-viewer (binary+AOI only); binary+AOI-off keeps full 0x02. Cross-runtime +
        2-viewer test PASS; flag-combo dispatch verified; combat 23/0 (no regression).
  - [x] **Flag-ON integration smoke** (`npm run smoke:net`, `server/smoke_aoi.js`) — the
        prod gate. Real `ws` server + real `ws` clients vs a real `GameHost` with AOI +
        BINARY on (assets loaded, `start()`ed sim loop). Validates LIVE over a real
        socket: join → AOI spawn → input-driven movement → **BOTH binary firehoses
        decoded over the wire** (`player_delta` 0x04 + `npc_delta` 0x03, ~29 NPC
        frames/162 rows) → position tracking → AOI despawn. **7/7 PASS.** Closes the
        "flags never touched a real client" gap. Only the visual browser render
        remains as a manual eyeball before prod.
  - [x] **Bandwidth measured** (`npm run measure:net`, `server/measure_net.js`) —
        in-process, no live-server flip. 20 clustered players, baseline vs AOI+binary:
        per-client downlink **33.8 → 3.6 KB/s (~9.4×)**; player*move ~11×, npc_update ~8.4×.
        sends/s ≈ unchanged (clustered → no spatial cull), so this ~10× is almost all
        binary+delta; the AOI cull adds MORE once players disperse (cuts send \_count*).
        9.4× is the conservative floor. Empirical confirmation the design works.
  - [ ] (later) keyframe-recovery for unreliable transport (§5, belongs with WebTransport);
        FlatBuffers events once the toolchain is chosen (above). Both need a decision.
  - [ ] Schema'd binary (FlatBuffers) for structured reliable events (§5 matrix).
- [~] **Combat feel / latency** (prod report: 130ms RTT, hits don't connect, remotes
  lag seconds behind — crisp locally, awful in prod). Two root causes, both fixed:
  - [x] **Lag compensation for melee** (`npcSim.handleAttack`). Each live enemy keeps
        a flat `[t,x,y,...]` history (`recordHist`, 500ms window); a swing rewinds the
        enemy to what the ATTACKER SAW — NPC interp delay (100ms) + that player's RTT —
        and tests the hitbox there (`histPosAt`), while damage/knockback still hit the
        live enemy. Client reports RTT in `ping`; server clamps it (0–400) into `_rtt`
        and passes `rewindMs` per swing. Gated by `LAG_COMP` (default ON). Projectiles
        unaffected (they return before the melee loop). Unit-tested (combat.test.js,
        29/0): rewind interp, clamp-to-oldest, future→live, eviction, fled-enemy scenario.
  - [x] **Time-based step budget** (`gameHost._simPlayers`). The hard 2-steps-per-tick
        cap ignored elapsed time: `setInterval(33)` slips under GC / busy prod CPU, so
        the server drained slower than an honest 60Hz input stream and the per-player
        queue grew to its 240 cap (~4s) — remote viewers fell seconds behind, draining
        slowly ("way behind AND slow"). Now each tick earns steps from REAL elapsed time
        (fractional accumulator, carry remainder, clamp a single tick's catch-up to
        `MAX_STEPS_BURST`=6, drop surplus on clamp) — mirrors the client's own
        accumulator. Anti-speedhack invariant holds (steps bounded by the wall clock).
        Regression-neutral+1 (gameHost 47/14 vs HEAD 46/15); smoke:net 7/7.
  - [x] **Trimmed player interp 150→100ms** (`RemoteInterp.ts PLAYER_DELAY_MS`). Reported
        jitter is only ~5ms, so 100ms (~3 packets at 30Hz) is ample headroom and the
        coast (`MAX_EXTRAP_MS`) absorbs stalled packets — shaves 50ms off the visible
        lag of other players. NPC interp LEFT at 100ms: NPCs broadcast at 10Hz (100ms
        packets), so it already brackets only ~1 packet; lowering would force constant
        coasting, and it must stay in sync with server `NPC_INTERP_MS` (lag-comp rewind).
  - [ ] (later) Raise NPC broadcast rate (currently 10Hz) for smoother enemies +
        tighter lag-comp; only worth it after the binary/delta headroom is confirmed
        in prod. Keep client NPC interp and server `NPC_INTERP_MS` in lockstep.
- [ ] **Phase 3+** — gateway split, WebTransport, sharding (§5.5, §7).

---

## 0. TL;DR

Today's netcode is a **single Node process** that **broadcasts every event to
every connected player** over **JSON-over-TCP-WebSocket**. It is correct, well
commented, and fine for tens of players. It cannot reach hundreds, let alone
100k — not because of bad code, but because of three structural ceilings:

1. **No interest management on the broadcast path.** `broadcastAll` /
   `broadcastExcept` (`gameHost.js:849/857`) loop over _all_ players for _every_
   message. Cost scales O(N) per event, O(N²) aggregate. At 100k it's physically
   impossible (≈10¹¹ position msgs/s alone).
2. **Single thread, single process.** One event loop sims every player + ticks
   NPCs + projectiles. A few thousand actors saturate one core.
3. **One DB, one host.** No horizontal scale path for sockets, sim, or storage.

The remodel keeps the **game rules exactly as they are** (server-authoritative
movement, the input/ack/reconcile spine, snapshot interpolation, rolling-HP,
weight-class push) and changes only **how state is partitioned, filtered, and
transported**. Four pillars + one rule:

- **Interest management (AOI):** every client receives only entities near it.
- **Spatial sim sharding:** the one world is cut into cells; many sim workers
  each own a patch, with seamless hand-off at borders.
- **Gateway / edge tier:** dumb socket terminators, separate from sim, doing
  per-client AOI filtering and binary encoding.
- **Binary delta protocol over WebTransport/UDP** for the high-rate position
  stream; reliable channel for events.
- **The rule that orders everything: ship the cheap, high-payoff thing first and
  measure before building the next.** Pillar 1 (AOI) is ~90% of the win and lands
  inside the current monolith with no new infrastructure.

### Reality check (kept from v1 — it's the right framing)

100k in ONE seamless world is **AAA-MMO territory, not .io territory.** Most
".io" games fake big numbers by sharding into ~few-hundred instances. EVE runs
one shard but buys headroom with **time dilation** (it slows the sim under load)
— v3 adopts a bounded version of that idea as a safety valve (§7.5). The saving
grace is that **no player ever sees 100k others** — a client sees ~50–300 nearby
entities. Per-client cost is bounded by **local crowd density**, not world
population. That single fact is why AOI + density caps are non-negotiable and
everything else is in service of them.

---

## 1. What we have today (the honest baseline)

Files: `server/index.js` (transport), `server/gameHost.js` (3k LOC, player
authority), `server/npcSim.js` (4k LOC, NPC/enemy/projectile/loot sim),
`server/store/*` (SQLite / Supabase), `src/engine/Network.ts` (client),
`src/engine/RemoteInterp.ts` (interpolation + predict/reconcile).

### Transport

- One `ws` `WebSocketServer` sharing a process with Express static + the auth
  API. **JSON text** messages, `JSON.stringify` per send.
- Server-driven protocol ping/pong + app-level ping/pong in `Network.ts`. Good
  instinct — keep it, re-encode it.

### Simulation loops (all `setInterval`, all one thread)

| Loop                     | Rate                            | Code                            |
| ------------------------ | ------------------------------- | ------------------------------- |
| Player movement sim      | **30 Hz** (`SIM_TICK_MS=33`)    | `gameHost.js:51`, `_simPlayers` |
| NPC/enemy broadcast      | **10 Hz** (`BROADCAST_HZ=10`)   | `npcSim.js`, sender             |
| Player status DoT/expiry | **4 Hz** (`STATUS_TICK_MS=250`) | `gameHost.js`                   |
| Event runtime            | **10 Hz**                       | `gameHost.js`                   |

Anti-speedhack is solid and stays: fixed-timestep, `MAX_STEPS_PER_TICK=2`
(`gameHost.js:59`), `MAX_INPUT_QUEUE=240` (`gameHost.js:52`). This is the
_fairness_ layer; it's **per-actor**, so it travels with the player to whichever
worker owns them. Survives the remodel unchanged.

### The ceiling: broadcast fan-out

```js
// gameHost.js:849
broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [, entry] of this.players) {          // <-- ALL players, every event
    if (entry._ws.readyState === 1) entry._ws.send(msg);
  }
}
```

Every `player_move`, `player_hp`, `player_push`, drop, chat, and status goes to
**everyone**. There is **no zone, no AOI, no spatial filter anywhere** in the
broadcast path.

**Important nuance (the trap v1 missed):** NPC _simulation_ IS already culled —
`npcSim` only ticks actors within `ACTIVE_RADIUS` (512 px) of some player. But
the NPC _broadcast_ is still global: `npc_update` ships **every moving NPC in the
world to every client** at 10 Hz. So the bottleneck is the **broadcast/output
path, not the sim cull.** AOI must be added to _output_, not just to ticking.

A joining client also gets a **full world snapshot** (all players + all divergent
NPCs) — an O(N) burst per join.

### Client (already good — retained wholesale)

- Local player: client-authoritative + predicted; server reconciles via `pos` +
  `seq` ack.
- Remotes/NPCs: snapshot interpolation, render **150 ms** in the past, **coast on
  underrun** (`RemoteInterp.ts`), `predOff` predict-then-reconcile.

### Capacity reality check

- Movement fan-out at N players, 30 Hz, everyone-sees-everyone: `N × 30 × N`
  sends/s = **9×10¹¹/s at N=100k.**
- Honest current ceiling: **~150–400 concurrent** in one shared view before the
  single core and the fan-out fall over. (`server/loadtest.js` defaults to 12.)

---

## 2. Design targets

| Metric                                     | Target                                             |
| ------------------------------------------ | -------------------------------------------------- |
| Concurrent players, one world              | 100,000+ (design for 250k headroom)                |
| Players rendered in one dense hotspot      | 150–300; rest culled/aggregated                    |
| Reaction latency (input→authoritative ack) | < 80 ms median, same region                        |
| Position rate per visible entity           | 10–20 Hz, delta-coded                              |
| Downlink per client                        | < 30 KB/s typical, < 100 KB/s in a crowd           |
| Sim tick                                   | 30 Hz authoritative (degradable under load — §7.5) |
| Cell hand-off (cross border)               | invisible, < 1 tick stall                          |
| Hot region spin-up (autoscale)             | < 30 s                                             |
| ⟪v3⟫ Reconnect → playable again            | < 2 s, same character, no double-spawn             |

**Hard rule (CLAUDE.md):** the network tier ships **state**, never assets.
Assets stay client-side (ROM pipeline). Servers remain code-only. Unchanged.

---

## 3. Target architecture

```
                         ┌──────────────────────────────────────┐
   100k browsers         │            EDGE / GATEWAY TIER        │
   (WebTransport/QUIC)   │  stateless socket terminators (M of)  │
        │  ───────────►  │  - auth handshake + rate-limit        │
        │                │  - per-client AOI filter + relevance  │
        │  ◄───────────  │  - binary delta encode + batch        │
        │                │  - holds per-client delta baselines   │
                         │  - subscribes to its players' cells   │
                         └───────────────┬──────────────────────┘
                                         │  direct interest-filtered push
                                         │  (+ control-plane on a bus)
                         ┌───────────────┴──────────────────────┐
                         │           SIM TIER (K workers)        │
                         │  each OWNS a set of grid cells        │
                         │  - 30Hz authoritative sim (the SAME   │
                         │    gameHost + npcSim logic, by cell)  │
                         │  - publishes entity deltas per cell   │
                         │  - hands players off at cell borders  │
                         │  - ghosts edge actors to neighbours   │
                         └───────────────┬──────────────────────┘
                                         │
                         ┌───────────────┴──────────────────────┐
                         │            STATE / PERSIST TIER       │
                         │  Redis (hot: positions, presence,     │
                         │   inventory cache, locks)             │
                         │  Postgres/Citus or Supabase (durable: │
                         │   accounts, saves, world docs)        │
                         │  write-behind from sim, never inline  │
                         └──────────────────────────────────────┘
```

Three independently scalable tiers (**edge**, **sim**, **state**) plus a
backbone. Edge scales on socket count, sim on world area × density, state on data
volume. The world map is unchanged (door-stitched EB sectors); we overlay a
**uniform cell grid** on world-pixel coords and use it for both interest and
partitioning.

---

## 4. Pillar 1 — Interest management (AOI). _Do this first; it's 90% of the win._

Highest payoff, and it lands **inside the current monolith** before any sharding
work. Converts O(N²) → O(N·k).

### 4.1 Grid + subscription model

- Overlay the world with a fixed **cell grid** (e.g. 256×256 px, ~2 screens).
  Every actor knows its `(cx, cy)`. (The client already buckets NPCs on a 256px
  grid for rendering — reuse that coordinate math.)
- A client is **subscribed** to its cell + the ring of neighbours (3×3, or 5×5
  for fast movers). It receives entity updates only for those cells.
- Maintain `cellMembers: Map<cellKey, Set<playerId>>` and each actor's current
  cell. On any move that changes cell, update both and emit enter/leave.

### 4.2 ⟪v3⟫ Subscription hysteresis (stop the edge from thrashing)

A player walking exactly along a cell boundary would otherwise flip cells every
few frames, firing a spawn/despawn storm for every entity in the gained/lost
ring. **Add a hysteresis band:** you subscribe to a neighbour cell when you cross
to within _H_ px of it (H ≈ ¼ cell), and only _unsubscribe_ once you're _H_ px
back past the boundary on the far side. Same idea protects the §7.3 handoff;
applying it to subscription too keeps the spawn/despawn channel quiet for
border-walkers. (Cheap, and it's the single most common AOI-churn bug.)

### 4.3 Replace the broadcast primitives

New core primitive `publishToArea(x, y, msg)` → fan-out only to subscribers of
the 3×3 cells around `(x,y)`. `broadcastAll` survives **only** for genuinely
global events (server notices, world-boss announcements). Everything positional
routes through cells:

```js
// illustrative
publishToArea(x, y, msg) {
  for (const pid of this.subscribersAround(x, y)) {   // 3x3 cells, not all N
    const e = this.players.get(pid);
    if (e && e._ws.readyState === 1) e._ws.send(this.encode(msg, pid));
  }
}
```

Crucially, route `npc_update` through this too — that's the global firehose
today. The `broadcastAll` / `broadcastExcept` call sites enumerated in §1 are the
exact migration checklist: each one is either "positional → `publishToArea`" or
"genuinely global → stays `broadcastAll`."

### 4.4 ⟪v3⟫ Event-relevance routing (not just positions)

Position is the firehose, but most `broadcastAll` sites today are _events_
(`player_hp`, `player_push`, `equip`, drops, chat). Classify each into a
relevance tier instead of treating "events" as one bucket:

- **Local (AOI-scoped):** combat hits, pushes, drops, _local_ chat, emotes →
  `publishToArea`.
- **Subscriber-scoped:** equip/appearance change → only clients who currently
  have that player spawned (reuse the AOI subscriber set; it's exactly "who's
  rendering me").
- **Global (rare):** server notices, world-boss, shutdown → `broadcastAll`.
- **Party/whisper:** routed by membership list, not space.

This means the AOI subscriber set is the **one** routing table for nearly
everything, and "global" shrinks to a genuinely tiny set.

### 4.5 Enter/leave protocol

- A enters B's AOI → send B a **spawn** for A (full state, once).
- A leaves → **despawn**. Between, only deltas.
- Replaces "full snapshot on join" with "spawn the ~k entities near my spawn
  point." Join cost becomes O(k), not O(N).

### 4.6 Crowd control (the hotspot problem)

100k can't share one screen. When a cell exceeds a render budget (say 200 visible
actors):

- **Priority culling:** always send the nearest M; the rest become a cheap
  aggregate ("+340 players here") — a crowd shimmer, not sprites.
- **Relevance scoring:** nearer + recently-acted + in-combat-with-me rank higher;
  distant idle players drop to low-rate or aggregate.
- This caps per-client downlink regardless of how many pile into Onett.

**Outcome of Pillar 1 alone:** the existing single process jumps from hundreds to
a few **thousand** concurrent (now sim-core bound, not fan-out bound), and the
spawn/despawn semantics sharding needs are already in place.

---

## 5. Pillar 2 — Wire protocol & transport

### Transport: WebTransport (HTTP/3 / QUIC) primary, WebSocket fallback

- **Position/movement = unreliable, unordered datagrams.** A dropped position
  packet must never delay the next — TCP head-of-line blocking is exactly what
  causes the "freeze then teleport" the code fights with coast + heartbeat.
  WebTransport gives **UDP-like datagrams in the browser** plus reliable streams
  on the same connection.
- **Events = reliable ordered stream.** Two channels, one connection.
- **WebSocket/TCP fallback** for networks blocking QUIC — same encoder,
  reliable-only. Keep coast-on-underrun so the fallback stays playable.

### Encoding: binary, quantized, delta-coded

- Replace JSON with a compact binary schema (hand-rolled `DataView` for the
  position firehose; FlatBuffers/protobuf for structured reliable msgs).
  Positions quantize cleanly — the sim already rounds to half-pixels.
- **Per-client snapshot deltas:** per cell, per tick, send only what changed since
  the client's last acked snapshot (baseline + delta, Quake3/Valve style). The
  `dirty`-flag batching in `npcSim` is the right instinct — formalize it into
  per-client baselines.
- Bit-pack rows: `id | Δx | Δy | dir(3b) | frame(2b) | pose(3b) | flags`. A moving
  entity row drops from ~40 JSON bytes to ~6–8.
- 150-actor view @ 15 Hz: ~150 × 8 B × 15 ≈ **18 KB/s** — within target.

### ⟪v3⟫ Encoding-by-channel matrix (the single source of truth)

One logical schema, **three serializations** chosen per channel by frequency and
correctness needs. In memory everything stays plain JS objects — encoding happens
only at the gateway boundary on the way out, decoding at the client edge on the
way in. The sim (`gameHost`/`npcSim`) never sees bytes.

| Channel                    | Examples                                                                  | Transport                                 | Encoding                                                           | Why                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Position firehose**      | entity move rows (`id\|Δx\|Δy\|dir\|frame\|pose`)                         | Unreliable datagram (QUIC) / WS fallback  | **Hand-packed binary, delta-coded** (`DataView`, bit fields)       | Highest volume × rate. Every byte ×15Hz×visibleN×100k. Schema-lib overhead (tags/framing) is unaffordable here. Not even self-describing — diffs vs last-acked baseline. |
| **Structured game events** | hit/damage, equip, inventory, level-up, loot, status, join/leave, handoff | Reliable ordered stream                   | **Schema'd binary** (FlatBuffers _or_ protobuf — pick one, §below) | Lower rate, many fields, correctness > raw bytes. Schema buys client/server lockstep + versioning.                                                                       |
| **Chat / text**            | local + global chat, emotes                                               | Reliable ordered                          | Schema'd binary (same as events)                                   | Low rate; relevance-routed (§4.4), not a byte problem.                                                                                                                   |
| **Control plane**          | presence, cell-ownership, handoff signalling, worker↔worker               | Backbone bus / mTLS (never client-facing) | Schema'd binary or msgpack                                         | Internal; not on the per-client hot path.                                                                                                                                |
| **Config / world data**    | editor overrides, `world_docs`, item/psi/flag tables                      | HTTP / DB                                 | **JSON (unchanged)**                                               | Human-authored, low-volume, read-mostly. No reason to pack.                                                                                                              |
| **Compatibility fallback** | _any_ of the above when WebTransport is unavailable                       | WebSocket/TCP                             | Same binary encoders, reliable-only                                | Same logical messages; only the transport reliability differs, not the schema.                                                                                           |

Rules this table encodes:

1. **Binary on the wire for all live gameplay; JSON only for config/authoring.**
   JSON leaves the hot path entirely.
2. **Hand-packed only for the firehose; schema'd binary for everything else with
   fields.** Don't hand-roll inventory structs — the maintenance cost isn't worth
   the few bytes at that rate.
3. **One schema definition, shared client+server** (mirrors today's
   "GameHost is the single source of truth" discipline) — generated types so a
   field rename can't silently desync.
4. **Pick FlatBuffers vs protobuf once, in Phase 2.** FlatBuffers = zero-copy
   reads (decode-free access, good for the per-tick event stream); protobuf =
   smaller wire size + better tooling. Lean **FlatBuffers** here because the
   client decodes events every frame and zero-copy avoids GC churn — but it's a
   measure-in-Phase-2 call, not a religion.

### ⟪v3⟫ Where delta baselines live, and what they cost

Delta coding needs a **per-client baseline** (the last snapshot each client
acked). Put it on the **gateway**, not the sim worker — the gateway already does
per-client encode, and keeping baselines off the sim keeps workers
client-agnostic (essential for sharding). Budget it: ~150 visible entities ×
~16 B of baseline state ≈ **~2.4 KB/client**; ×7k clients/gateway ≈ **~17 MB** —
trivial. The real cost is **churn**, not size: re-baselining a client (cell change,
packet-loss gap) must be cheap. Use **per-cell baselines** so a client crossing
cells re-baselines only the gained cell, not its whole view, and so multiple
clients viewing the same cell can share encode work.

### ⟪v3⟫ Lost-datagram recovery (unreliable channel needs a floor)

On UDP datagrams there's no retransmit, so a client can miss a delta and drift.
Floor it: every entity row carries a small **generation/seq**; if a client's
gap exceeds a threshold (or it nacks), the gateway sends a **fresh keyframe**
(full state) for the affected cell instead of a delta — same baseline machinery,
just "delta-from-nothing." Cheap because it's per-cell and rare.

### Keep

- The input→`seq`→`pos`-ack reconcile loop (already prediction-correct).
- 150 ms interpolation + coast (`RemoteInterp.ts`) — unchanged over the new
  transport; tune the buffer against real RTT/jitter (measured via `getNetStats`).

---

## 5.5 ⟪v3⟫ Runtime & transport stack (decided)

**Today:** `ws` (`v8`) `WebSocketServer` + Express 5, single Node process
(`server/index.js`). **No socket.io.** Game logic is ~7k LOC of
server-authoritative JS (`gameHost.js` + `npcSim.js`) sharing one `GameHost`
across dev (Vite) and deploy.

**Decision: stay Node; introduce native (Rust/Go) per-tier, only where it earns
its place. No server rewrite.** The first ceiling is fan-out, not CPU — AOI
(Pillar 1) removes it with zero language change.

### Locked choices

| Concern      | Choice                                                                                                                                                                                                                                             | Not                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS library   | keep **`ws`**; upgrade to **`uWebSockets.js`** (C++ core, ~5–8× faster, near drop-in) when socket throughput in Node becomes the wall (~Phase 3)                                                                                                   | **socket.io** — its rooms/reconnect/fallback duplicate what we build AOI-aware (resume tokens §8.5, WT fallback §5) and it taxes every message with its own framing |
| Sim tier     | **Node/TS** through Phase 4 min. Rust **only** for the inner 30 Hz loop at Phase 5+, _if a profiler proves_ one core can't hold ~3–5k actors — port the loop, keep the logic shape                                                                 | a from-scratch Rust rewrite of `gameHost`/`npcSim` (throws away parity + every fixed bug)                                                                           |
| Gateway tier | **earliest justified native seam — Rust (or Go)** at Phase 3. Shares **zero** game logic; pure decode/AOI-filter/encode/fan-out; and mature browser-**WebTransport/QUIC** servers are native (Rust [`wtransport`]) while Node's WT is experimental | forcing QUIC into Node just to stay monolingual                                                                                                                     |

### Why the gateway is the language seam

The gateway↔sim contract is **only the binary protocol (§5)**. So the gateway can
become Rust **without touching a line of `gameHost`**. Game logic stays one
Node/TS codebase as long as possible; native creeps in at the stateless edge
first, the hot sim loop last (maybe never).

### The three-wall decision rule

Run Phase 0 instrumentation; let a profiler name each wall before paying for it.

1. **Egress / fan-out wall** → solved by **AOI in Node** (Pillar 1). No new language.
2. **QUIC/WebTransport maturity wall** → solved by a **Rust gateway** at Phase 3–4.
3. **Sim-CPU wall** → solved by a **Rust hot-loop** at Phase 5, behind unchanged rules.

Three separate, deferrable decisions — never one big "rewrite in Rust." Stay
monolingual (Node) until a measurement forces a specific seam.

---

## 6. Pillar 3 — Edge / gateway tier

Split "terminate the socket" from "simulate the game."

- **Gateways** are stateless w.r.t. game rules. They: terminate
  WebTransport/WebSocket; run auth + per-connection rate-limit; keep the keepalive
  (port the ping/pong); track which **cells** each player subscribes to; receive
  per-cell entity deltas; run the **per-client AOI filter + relevance scoring +
  binary encode + batching + delta baselines** (§5); push to sockets. They route
  client **inputs** to the worker owning the player's cell.
- Sim workers never touch sockets — they publish cell deltas; gateways localize
  per client. This **decouples #sockets (scale gateways) from #actors (scale
  sim)**.
- ~5–10k sockets per gateway → **~15–20 gateways** for 100k, behind a sticky load
  balancer.
- **Routing fabric:** direct worker→gateway pushes driven by an interest table for
  the position firehose (a shared bus can't take ~tens of GB/s). A bus (NATS /
  Redis Streams) is fine for the **control plane** (presence, chat, events,
  handoff signalling) — not the firehose.

> Note: gateways are "stateless w.r.t. game rules" but **do** hold soft state
> (subscriptions, delta baselines). On gateway death the client reconnects to
> another and re-baselines from scratch (§8.5) — cheap because it's O(k visible),
> not O(world). "Stateless" here means _no authority_, not _no memory_.

---

## 7. Pillar 4 — Spatial sim sharding (the path past one core)

One core sims maybe 2–5k actors at 30 Hz. 100k players + their NPCs need many.
Keep **one logical world**; partition the **simulation**.

### 7.1 Cell ownership

- Group cells into **regions**; each **sim worker** owns a contiguous block. A
  coordinator (or consistent-hash ring) maps `cellKey → ownerId`.
- A worker runs the _exact_ `gameHost`/`npcSim` tick, but only over actors in its
  cells. Logic unchanged; the _actor set_ is partitioned.

### 7.2 Cheapest first cut: door-bounded zone sharding (do this before seamless)

The world is **door-stitched** today, and doors already fade. So shard sim on
**door-bounded zones** first:

- Borders = doors = an existing transition → **no ghosting, no handoff-race work**
  at launch; the fade hides any stall.
- Each zone = one worker. State tier makes workers stateless/restartable.
- Con: a single huge _outdoor_ zone (Onett) can still exceed one core. So:
  **zone-shard first; only cell-split the zones that outgrow a core.**

This is v2's best idea and the single biggest reason it beats v1: it gets you to
multi-worker scale while _deferring_ the hardest distributed-systems problem
(seamless handoff) until a specific zone forces it.

### 7.3 Seamless cell hand-off (only where a zone is too dense)

When a player crosses from worker W1's cell into W2's:

1. W1 keeps authority until the player passes a **hysteresis band** past the
   border (prevents thrash when walking the line — same mechanism as §4.2).
2. W1 serializes the player's authoritative state, hands it to W2 (`handoff`).
3. W2 assumes authority; the gateway re-subscribes to W2's cells.
4. **Ghosting:** within the border band each worker publishes its edge actors so
   neighbours render + collide against them (read-only) before authority moves.

### 7.4 ⟪v3⟫ Handoff failure & recovery (the gap both prior docs left open)

Handoff is a two-phase transfer; a worker can die mid-transfer. Make it
**recoverable, not just fast:**

- **Authority is a lease, not a fact.** `cellKey → ownerId` lives in the
  coordinator/Redis with a short TTL. A worker must renew; if it dies, the lease
  expires and the coordinator reassigns the cell.
- **Handoff is idempotent + checkpointed.** W1 writes the player's authoritative
  state to the state tier _before_ releasing authority; W2 reads it on assume. If
  W1 dies after checkpoint but before ack, W2 (or a replacement) still has the
  last good state — worst case the player rewinds < 1 tick, which the client's
  reconcile already absorbs.
- **Double-authority guard.** A player carries an authority epoch; inputs stamped
  with a stale epoch are rejected, so a network partition can't get two workers
  both simulating the same player.
- **On uncovered cell:** the coordinator reassigns; affected players' gateways
  resubscribe; their characters reload from the last checkpoint. Lost work is
  bounded by the write-behind interval (§8), seconds at most. This is the same
  "degrade to a smaller blast radius" ethos the current single-process code has
  for disconnects.

### 7.5 ⟪v3⟫ Degrade, don't drop — a bounded tick budget (EVE's idea, made safe)

A worker that momentarily can't finish its 30 Hz tick has two bad options today:
fall behind (unbounded lag, then a snap) or drop actors. Give it a third, EVE-
style: **a per-worker tick budget that trades rate for correctness, locally and
visibly.**

- Each tick has a wall-clock budget. If sim work exceeds it, the worker lowers its
  authoritative tick rate (30 → 20 → 15 Hz) **for that worker's cells only**, and
  stamps outgoing snapshots with the current rate so clients widen their interp
  buffer instead of stuttering.
- It's **bounded** (never below a floor, say 12 Hz) and **local** (one packed
  zone slows; the rest of the world stays 30 Hz).
- It's the safety valve that buys time for autoscale/re-partition (§7.6) to kick
  in, instead of a hard failure. Crucially it preserves **fairness**: the
  per-actor speed caps are tick-relative, so slowing the tick slows everyone in
  that zone equally — no speedhack window opens.

### 7.6 Cross-border interactions

- Movement/collision near a seam: handled by ghosting + the target-owner rule.
- A melee/projectile hit whose target is owned by another worker is forwarded as a
  `damageRequest` to that owner, which is authoritative for HP. **This keeps the
  rolling-HP death model intact — server-held, just on the _target's_ worker.**

### 7.7 Hotspot overflow (5k in one square)

In preference order: (1) finer cells / dynamic re-partition the hot region across
more workers; (2) soft caps + crowd aggregation (§4.6) so density never exceeds
what a worker + client can take; (3) **bounded tick degrade** (§7.5) as the
in-the-moment cushion while (1) spins up; (4) last resort: instance/channel the
hot region (breaks "one world" locally — avoid unless 1–3 exhausted; **needs a
product decision**).

> This tier is the genuinely hard distributed-systems work (seam consistency,
> handoff races, rebalancing). Build it **last**, only once a single sim process
> is measured to be the bottleneck. Premature sharding kills projects.

---

## 8. Pillar 5 — State & persistence tier

| Data                                      | Store                                | Pattern                                |
| ----------------------------------------- | ------------------------------------ | -------------------------------------- |
| Accounts, sessions, durable saves         | Postgres (Citus/sharded) or Supabase | source of truth; write-behind          |
| Live positions, presence, cell membership | Redis (cluster)                      | hot, ephemeral, TTL'd                  |
| Inventory/equip/wallet (live)             | Redis write-through → Postgres       | authoritative on owning worker, cached |
| World docs / editor overrides             | Postgres (`world_docs`, exists)      | read-mostly, cached at workers         |
| Cross-worker locks (trade, handoff)       | Redis (Redlock) / coordinator        | short-lived                            |
| ⟪v3⟫ Cell authority leases                | Redis (TTL keys)                     | short-lived, renewed by owner (§7.4)   |
| ⟪v3⟫ Session resume tokens                | Redis (TTL)                          | reconnect without re-auth (§8.5)       |

- **No DB write on the hot path.** Saves are write-behind: sim mutates Redis + a
  dirty set; a flusher persists to Postgres every N seconds and on
  handoff/disconnect (extend today's flush-on-close).
- **Sharded DB** so 100k accounts' writes spread across nodes (Citus, or app-level
  shard by `accountId`). Read replicas for login spikes.
- **Economy is a separate, transactional service.** Bank/ATM/trades need real DB
  transactions across workers — route them to a dedicated **economy service**, off
  the per-cell latency tier. Idempotent, queued economy ops so a worker/gateway
  failover can't double-grant or drop an item. Keep economy _out_ of the
  cell-sharded hot path from day one (dupe-bug containment).

### 8.5 ⟪v3⟫ Reconnect / session resume (a 100k-scale necessity, unaddressed before)

At 100k, transient disconnects (gateway recycle, mobile handoff, QUIC migration
failure) are constant. A full re-auth + reload per blip is both a bad UX and a
thundering-herd risk on login.

- On connect, the client gets a short-lived **resume token** (Redis, TTL ~60 s).
- A reconnect within the window presents the token → the new gateway re-attaches
  to the _same_ live character on its owning worker, re-subscribes to its cells,
  and sends fresh keyframes (§5). No DB load, no re-auth, no double-spawn.
- The owning worker keeps a disconnected player **parked** (not despawned) for the
  token window before flushing — mirrors today's flush-on-close, just deferred.
- This also makes QUIC connection migration (changing networks mid-walk) a
  non-event rather than a respawn.

---

## 9. Anti-cheat / authority (same philosophy, new surface)

Preserve every current invariant:

- Speed cap (`MAX_STEPS_PER_TICK`), input-flood cap (`MAX_INPUT_QUEUE`),
  move-distance validation — per-actor, so they move _with_ the player to its
  owning worker. Sharding doesn't weaken them. (And §7.5 tick-degrade keeps them
  fair under load — caps are tick-relative.)
- HP/damage/loot stay server-held on the **target's owning worker**.
- New surface: **handoff**, **cross-border `damageRequest`**, and **authority
  epochs** (§7.4) must be worker-to-worker authenticated (mTLS on the backbone,
  not client-reachable). Clients only ever address gateways, never workers.
- Gateways rate-limit (msg/s, bytes/s) before input reaches a worker, and enforce
  that a client can only see/act on entities in its legitimate AOI subscription
  (no "see the whole map" exploit). ⟪v3⟫ Resume tokens (§8.5) are bound to the
  account + signed, so a stolen token can't hijack another character.

---

## 10. Capacity model (back-of-envelope; prove with load tests)

100k players, avg ~80 actors in view, 15 Hz, binary deltas:

- **Per-client downlink:** ~80 × 8 B × 15 ≈ **9.6 KB/s** typical; cap ~100 KB/s in
  crowds (relevance-culled). ✅
- **Aggregate egress:** 100k × ~120 kbps ≈ **~12–15 GB/s ≈ ~100–120 Gbps**, over
  ~15–20 gateways = **~6–8 Gbps each** — real but ordinary for tuned edge nodes.
  **Without AOI this is impossible; with it, it's just an infra bill.**
- **Gateways:** 100k / 7k per ≈ **~15–20**.
- **Gateway memory:** delta baselines ~2.4 KB/client × 7k ≈ ~17 MB/gateway —
  negligible (§5). ⟪v3⟫
- **Sim:** ~3k actors/core @ 30 Hz, ~100k players + ~50k NPCs = 150k actors →
  **~50 cores** (~6–12 boxes), density-skewed → autoscale hot regions.
- **Redis:** presence + positions for 150k actors ≈ a few hundred MB hot; one
  cluster.

None of these are exotic _once the O(N²) fan-out is gone._ **The whole
feasibility hinges on Pillar 1.** Egress, not CPU, is likely the first cost wall;
hotspot density is the real risk.

---

## 11. Phased rollout (each phase ships value; measure between phases)

> Design rule every phase: keep `gameHost`/`npcSim` **rules** identical; change
> only partitioning/filtering/transport. Dev (Vite) and deploy (`index.js`) hosts
> must stay behavior-identical (they share `GameHost` today — preserve it).

| Phase | Change                                                                                                                                                                                                                        | Unlocks                                   | Risk                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| **0** | Instrument: per-msg-type bandwidth, sends/tick, GC, tick-duration under load; scale `loadtest.js` to thousands of **AOI-realistic** bots (clustered, not uniform — hotspots are the test that matters)                        | true current ceiling                      | low                         |
| **1** | **Interest management in the monolith** — cell grid, `cellMembers`, hysteresis (§4.2), spawn/despawn, `publishToArea` replacing positional broadcasts (incl. `npc_update`), event-relevance routing (§4.4), relevance culling | hundreds → **few thousand**, no new infra | medium — biggest single win |
| **2** | **Binary + delta wire format**, per-client/per-cell baselines + keyframe recovery (§5)                                                                                                                                        | 5–10× bandwidth headroom                  | medium                      |
| **3** | **Extract gateway tier** (baselines move here) + control-plane bus + reconnect/resume tokens (§8.5); one sim worker still owns the world                                                                                      | scale sockets independently → **5–10k**   | med-high                    |
| **4** | **WebTransport/QUIC datagrams** for positions (WS fallback retained)                                                                                                                                                          | kills HoL jumping for good                | medium                      |
| **5** | **Zone-shard the sim** on door-bounded zones; stateless workers via state tier; handoff at doors; authority leases + tick-degrade safety valve (§7.4–7.5)                                                                     | **→ 100k** if no single zone too dense    | high                        |
| **6** | **Seamless cell-split** for dense zones (ghosting + hysteresis handoff) + DB sharding + economy service + autoscale                                                                                                           | dense hotspots + durability at scale      | high                        |

Phase 1 alone likely covers the whole private-test / early-launch window. 5–6 are
only justified once you're genuinely pushing five figures.

⟪v3⟫ **Why this ordering:** resume tokens (§8.5) move to Phase 3 because that's
when the socket layer first becomes a separate, recyclable process — disconnect
blips start the moment you split gateways, so resume must land _with_ the split,
not after. Authority leases + tick-degrade land in Phase 5 because that's the
first time more than one worker exists.

---

## 12. Open questions / risks to resolve early

- **Density-cap UX.** What does a 1,000-player pileup _look like_? Decide the
  aggregate-crowd rendering ("crowd shimmer" + "+N") **before** Phase 1 culling,
  or it'll feel broken.
- **"One world" purity vs hotspot channelling.** Is one truly seamless Onett a
  hard requirement, or can extreme hotspots **sub-instance** (channels)?
  Channelling is dramatically cheaper — **product decision** (design goal says one
  persistent world; does that forbid channels?). This bounds §7.7.
- **Cell size.** Reuse the client's 256 px render grid, or pick a sim-optimal
  size? Trade-off is concrete: bigger cells = fewer handoffs/subscriptions but
  coarser culling and bigger per-cell worker load; smaller = finer LOD but more
  border churn. ⟪v3⟫ **Decide by measurement in Phase 0**, with a target of
  ~50–150 actors/cell at typical density and handoff frequency the hysteresis band
  can absorb.
- **WebTransport reach.** Good but not universal; the WS fallback must be
  first-class, not an afterthought — verify across the browsers/handhelds you
  target.
- **Handoff correctness** is the classic seamless-world bug farm. Door-bounded
  sharding (Phase 5) sidesteps most of it; defer seamless (Phase 6) until forced.
  The lease + checkpoint + epoch model (§7.4) is the safety net when you can't.
- **Hosting.** Render is fine through ~Phase 3. Phases 5–6 (many stateful workers,
  custom QUIC, Redis, LB topology) want more control — Fly.io / bare cloud VMs /
  k8s. Decide before Phase 5.
- **Worker runtime.** _Decided — see §5.5._ Stay Node; `ws`→`uWebSockets.js` (not
  socket.io); Rust at the gateway seam (Phase 3–4) and the sim hot-loop (Phase 5)
  only when a profiler names that wall.
- **Cost.** 100k concurrent ≈ ~20–30 boxes + managed Redis/Postgres. Confirm
  against funding before Phase 5+.
- **SNES-port honesty.** The long-backlogged native port can't run this stack.
  Accept that the MMO and the homebrew diverge at the network layer (they already
  do); keep gameplay _rules_ portable, not the netcode.

---

## 13. What explicitly stays (don't rewrite what works)

- Client prediction/reconcile spine (`Network.ts`, input→seq→pos-ack).
- Snapshot interpolation + coast-on-underrun (`RemoteInterp.ts`); the `predOff`
  predict-then-reconcile primitive.
- Server-authoritative everything: movement caps, HP, loot, status, weight push.
- Rolling-HP death model (just lives on the target's owning worker).
- Dev/deploy host parity via shared `GameHost`.
- ROM/asset policy: network ships **state only**, forever — none of this touches
  asset distribution; the sim relays state, never ROM data.

The remodel is **additive partitioning around a sound core**, not a rewrite of the
game logic. The SNES/ESP32 port can't run this stack — accept that the MMO and the
homebrew diverge at the network layer; keep gameplay _rules_ portable, not the
netcode.

---

## Appendix — v1 vs v2 vs v3 (why v3 looks the way it does)

| Dimension             | v1                              | v2                                 | v3                                                |
| --------------------- | ------------------------------- | ---------------------------------- | ------------------------------------------------- |
| Grounding             | conceptual, no code refs        | **verified file:line refs**        | inherits v2's grounding                           |
| Sharding path         | straight to seamless cells      | **door-bounded zones first** ✅    | keeps v2's, adds lease/checkpoint recovery        |
| NPC broadcast nuance  | missed (sim-cull ≠ output-cull) | **caught it**                      | kept + made the migration a checklist             |
| Economy               | folded into persistence         | **separate transactional service** | kept                                              |
| Reality-check framing | **EVE/time-dilation note** ✅   | dropped it                         | kept _and operationalized_ (§7.5 tick-degrade)    |
| Failure handling      | light                           | stateless workers                  | **handoff crash/recovery, leases, epochs (§7.4)** |
| Reconnect at scale    | —                               | —                                  | **resume tokens (§8.5)**                          |
| Delta baseline cost   | —                               | mentions baselines                 | **placed on gateway + memory-budgeted (§5)**      |
| Edge thrash           | —                               | hysteresis for handoff only        | **hysteresis for subscription too (§4.2)**        |
| Event routing         | "positional vs reliable"        | same                               | **4-tier relevance routing (§4.4)**               |

**Verdict:** v2 > v1 (grounded, cheaper migration, catches the broadcast-vs-cull
trap). v3 = v2's spine + v1's one good framing idea + the operational gaps both
left open (failure recovery, reconnect, baseline placement, edge thrash, a
bounded degrade valve).
