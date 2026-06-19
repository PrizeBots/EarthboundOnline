'use strict';

const fs = require('fs');
const path = require('path');

// Server-authoritative event runtime (EVENT_MANAGER.md Phase 2). Drives the
// Frank-style timed group encounter:
//   idle -> (talk-to-NPC or proximity) -> arming(countdown)
//        -> snapshot the circle at zero -> warp party to the entrance (active)
//        -> run the event timer + end conditions -> warp survivors to the exit
//        -> cooldown -> idle (re-armed).
//
// ONE live instance PER EVENT DEFINITION (different events can run at once).
// Config is authored by the Event Manager tool -> public/overrides/events.json,
// hot-reloaded here. Boss-spawn + the 'bossDefeated' end condition are Phase 3.

const BROADCAST_THROTTLE_MS = 100; // event_state push cadence (~10Hz)

function createEventRuntime({ root, getPlayers, broadcast, warpPlayer }) {
  const EVENTS_PATH = path.join(root, 'public', 'overrides', 'events.json');

  let defs = []; // authored, enabled event definitions
  const state = new Map(); // id -> { phase, armEndAt, activeEndAt, cooldownEndAt, party:Set }
  let lastBroadcast = 0;
  let lastWasEmpty = true;

  function loadConfig() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    } catch {
      /* none authored yet — defs becomes empty */
    }
    defs = (parsed && Array.isArray(parsed.events) ? parsed.events : []).filter(
      (e) => e && e.enabled !== false && e.trigger
    );
    // Drop runtime state for events that no longer exist.
    for (const id of [...state.keys()]) {
      if (!defs.find((e) => e.id === id)) state.delete(id);
    }
    console.log(`[events] loaded ${defs.length} event(s)`);
  }

  function st(id) {
    let s = state.get(id);
    if (!s) {
      s = { phase: 'idle', armEndAt: 0, activeEndAt: 0, cooldownEndAt: 0, party: new Set() };
      state.set(id, s);
    }
    return s;
  }

  // Live players standing in a trigger circle (alive, not in the editor).
  function playersInCircle(def) {
    const t = def.trigger;
    const out = [];
    for (const p of getPlayers()) {
      if (p.editor || p.downed) continue;
      if (Math.hypot(p.x - t.x, p.y - t.y) <= t.radius) out.push(p);
    }
    return out;
  }

  // Where the event drops players when it ends — the authored exit, or the
  // trigger spot as a fallback so nobody is ever stranded in the room.
  function exitWarp(def) {
    const w = def.exit;
    return w && w.enabled ? w : { x: def.trigger.x, y: def.trigger.y, dir: 0 };
  }

  // Talk-to-NPC start: a player finished dialogue with NPC `npcTextId`. Arm the
  // matching idle dialogue-event if that player is standing in its circle.
  function onTalk(playerId, npcTextId) {
    const now = Date.now();
    for (const def of defs) {
      const t = def.trigger;
      if (t.start !== 'dialogue' || t.npcTextId !== npcTextId) continue;
      const s = st(def.id);
      if (s.phase !== 'idle') continue;
      if (!playersInCircle(def).some((p) => p.id === playerId)) continue;
      s.phase = 'arming';
      s.armEndAt = now + (t.countdownMs || 0);
      console.log(`[events] '${def.id}' arming (talk by ${playerId})`);
    }
  }

  function startEvent(def, party, now) {
    const s = st(def.id);
    s.phase = 'active';
    s.activeEndAt = now + (def.eventTimerMs || 0);
    s.party = new Set(party.map((p) => p.id));
    const w = def.entrance;
    for (const p of party) warpPlayer(p.id, w.x, w.y, w.dir | 0, def.id);
    console.log(`[events] '${def.id}' START with ${party.length} player(s)`);
  }

  function endEvent(def, now, reason) {
    const s = st(def.id);
    const w = exitWarp(def);
    for (const id of s.party) warpPlayer(id, w.x, w.y, w.dir | 0, null);
    s.party = new Set();
    s.phase = 'cooldown';
    s.cooldownEndAt = now + (def.trigger.cooldownMs || 0);
    console.log(`[events] '${def.id}' END (${reason})`);
  }

  function tick(now) {
    for (const def of defs) {
      const s = st(def.id);
      const t = def.trigger;

      if (s.phase === 'idle') {
        // Proximity start arms once enough players stand in the circle.
        if (t.start === 'proximity' && playersInCircle(def).length >= (t.minPlayers || 1)) {
          s.phase = 'arming';
          s.armEndAt = now + (t.countdownMs || 0);
        }
      } else if (s.phase === 'arming') {
        if (now >= s.armEndAt) {
          const party = playersInCircle(def);
          const haveEntrance = def.entrance && def.entrance.enabled;
          if (party.length >= (t.minPlayers || 1) && haveEntrance) startEvent(def, party, now);
          else s.phase = 'idle'; // not enough players, or no entrance authored
        }
      } else if (s.phase === 'active') {
        const live = new Map();
        for (const p of getPlayers()) live.set(p.id, p);
        // Eject dead/downed/disconnected members to the exit immediately.
        for (const id of [...s.party]) {
          const p = live.get(id);
          if (!p || p.downed) {
            s.party.delete(id);
            if (p) {
              const w = exitWarp(def);
              warpPlayer(id, w.x, w.y, w.dir | 0, null);
            }
          }
        }
        const end = Array.isArray(def.end) ? def.end : [];
        const wantsTimer = end.length === 0 || end.includes('timer');
        const wantsWipe = end.length === 0 || end.includes('allPlayersDead');
        if (wantsWipe && s.party.size === 0) endEvent(def, now, 'wipe');
        else if (wantsTimer && now >= s.activeEndAt) endEvent(def, now, 'timer');
        // 'bossDefeated' end condition is Phase 3 (needs the boss spawn).
      } else if (s.phase === 'cooldown') {
        if (now >= s.cooldownEndAt) s.phase = 'idle';
      }
    }
    maybeBroadcast(now);
  }

  // Public per-event UI state (trigger circle + countdown/timer) for clients.
  function publicState(now) {
    const out = [];
    for (const def of defs) {
      const s = st(def.id);
      if (s.phase !== 'arming' && s.phase !== 'active') continue;
      const t = def.trigger;
      const e = {
        id: def.id,
        name: def.name || def.id,
        x: t.x,
        y: t.y,
        radius: t.radius,
        phase: s.phase,
      };
      if (s.phase === 'arming') e.countdownMs = Math.max(0, s.armEndAt - now);
      else e.timerMs = Math.max(0, s.activeEndAt - now);
      out.push(e);
    }
    return out;
  }

  function maybeBroadcast(now) {
    if (now - lastBroadcast < BROADCAST_THROTTLE_MS) return;
    const events = publicState(now);
    if (events.length === 0 && lastWasEmpty) return; // nothing happening — stay quiet
    lastBroadcast = now;
    lastWasEmpty = events.length === 0; // one final empty push clears the client
    broadcast({ type: 'event_state', events });
  }

  loadConfig();
  fs.watchFile(EVENTS_PATH, { interval: 2000 }, () => loadConfig());

  return {
    onTalk,
    tick,
    stop() {
      fs.unwatchFile(EVENTS_PATH);
    },
  };
}

module.exports = { createEventRuntime };
