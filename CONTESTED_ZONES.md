# Contested Zones (Town Territory Control)

> **Status:** DESIGN (not built). Riffed 2026-06-30. This is the plan; nothing here
> is implemented yet. Tracked in TODO.md under "Backlog / Ideas".

## The pitch

Add action-driven depth to towns: certain spots in the city are **held by enemies**.
Players fight to **clear and capture** them. When players own a zone, town features
turn on (doors unlock, shops reopen, rewards flow, story advances). If players walk
away, the zone **decays back** to enemy control — the map is a living thing you defend,
not one-time content you consume.

- **World-shared** (true MMO): all players see the same owner state. You clear the
  plaza, I walk in and it's cleared too.
- **PvE for now.** No player-vs-player ownership yet (guild/faction turf is a later
  layer — see "Future").

## Core principle: the zone only owns a FLAG

The zone system must NOT know about doors, shops, or story. Its single job is to own a
piece of world state — an **owner flag** — and everything else in the game _reacts_ to
that flag through systems we already have (EventBus → FlagTriggers → PlayerFlags,
flag-conditional dialogue/doors). Loose coupling = we can add new reward types forever
without touching zone code.

> A contested zone publishes `zone_<id>.owner = ENEMY | CONTESTED | PLAYERS`.
> Doors, vendors, NPCs, spawners, rewards all _listen_. That's the whole architecture.

## States + transitions (the state machine)

Reuses the Event Manager state-machine shape (trigger → countdown → end-condition),
but **persistent and world-shared** instead of per-instance.

```
ENEMY  ──(kill the garrison + captain)──▶  CONTESTED  ──(survive defend timer)──▶  PLAYERS
  ▲                                                                                    │
  └──────────────────────(decay timer elapses, unattended)─────────────────────────────┘
```

- **ENEMY** (default for held spots): spawners active, tougher packs + a **captain**
  enemy that must die to flip the zone. Townsfolk flee; shops closed; enemy spawners
  live.
- **CONTESTED** (just cleared): a short **defend window** — a wave or two tries to
  retake it (Event Manager countdown + end-conditions). Hold it to capture.
- **PLAYERS** (captured): control flags flip on (see below). Enemy spawners in the zone
  go dormant; becomes a safe/heal/respawn point.
- **DECAY**: while `PLAYERS` and unattended (no players present / timer), the zone
  slowly slides back toward `ENEMY`. Volatile rewards switch off; enemies return.

**Decay is what makes it depth, not a checklist quest.** Without it, capture is
consume-once content. With it, towns have rhythm, patrol reasons, and "the plaza fell
again — get over there" chat moments.

## Two flag tiers (sticky vs volatile)

The retake question — "does losing a zone revert everything?" — is answered by splitting
each zone's flags into two tiers:

- **Milestone flags** — one-way, PERMANENT. Story beats, first-clear rewards. Once you
  beat the captain the first time, the story stays unlocked even if the zone falls.
- **Control flags** — track LIVE ownership, flip both ways. Doors, vendors, spawns,
  buffs, income. On while held, off when retaken.

## How ownership connects to features (all thin listeners on the flag)

| Feature                 | Wiring                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Doors**               | Door has an `unlockFlag`; zone-owned control flag flips it. (First real consumer of flag-conditional doors.)                     |
| **Money / items**       | A FlagTrigger on `owner=PLAYERS` drops a chest / opens a vendor / starts an income trickle into the bank. Reuses loot + banking. |
| **Story / progression** | The milestone flag IS a quest flag. Dialogue already reads flags → NPCs change lines, new quests open. Zero new code.            |
| **NPC behavior**        | Townsfolk flee when `ENEMY`, return when `PLAYERS`. npcSim reads the flag.                                                       |
| **Spawns / safety**     | Owned zone becomes a heal/respawn point; enemy spawners go dormant.                                                              |

In the authoring tool this is a per-zone checklist: _on capture → [unlock door X]
[open vendor Y] [set story flag Z] [drop reward W]_.

## The authoring tool (Contested Zone Editor)

Dev-only, in the editor layer (mirrors existing tools; `overrides/zones.json`).
Authors THREE things:

1. **Area** — which sectors/room the zone covers. Reuse the Room Manager sector picker.
2. **Garrison** — which spawners/enemies defend it + which is the **captain** (its death
   flips the zone). Enemy spawners already exist at real ROM locations.
3. **States + rewards** — the transition timers (defend window, decay rate) and the
   on-capture reward checklist (which doors/flags/vendors/loot the two flag tiers drive).

## Architecture fit / persistence

- **Single source of truth** for each owner flag, broadcast on change. Rooms already
  persist to `world_docs` (Supabase/SQLite); zone owner-state fits the same doc pattern.
- **Room = shard** (existing topology): a contested zone living inside one room's shard
  means the shard that simulates the fight also owns the flag. Lines up with the netcode
  scaling plan (NETWORK_REMODEL.md) instead of fighting it.
- Server-authoritative: clients never assert ownership; they render the broadcast state.

## Open decisions (before building)

- **Decay model** — pure timer, or presence-gated (only decays when no players nearby)?
  Presence-gated feels fairer but can let a zone be trivially held by one AFK player.
- **Captain respawn** — on retake, does the same captain return, or escalate?
- **Reward economy balance** — passive income trickle rate vs. the loot/banking economy
  (don't let a held zone print money).
- **How many zones per town**, and whether any are "always enemy" endgame anchors.

## Future (out of scope now)

- **Faction / guild ownership** → team-vs-team turf, the first real PvP-territory layer.
- **Sieges** — scheduled world events where enemies mass-assault multiple owned zones.
- Ties into the existing "World events / boss encounters" and "PvP zones" backlog items.

## Prerequisites (existing systems this leans on)

- Flag system (EventBus → FlagTriggers → PlayerFlags) — built.
- Flag-conditional **doors** — on the Room System roadmap (Phase 6 scripting).
- Event Manager state machine — Phase 1 (authoring) done, runtime TODO.
- Enemy spawners + catalog — built. Loot + banking — built. Room/sector shards — built.
