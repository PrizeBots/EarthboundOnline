/**
 * status.js — EarthBound status conditions, adapted to real-time action combat.
 *
 * ONE source of truth for the status catalog + the timer/immunity math, shared
 * by npcSim (in-sim actors: enemies, townsfolk) and gameHost (players). Pure and
 * injectable-rng so it's deterministically testable (see status.test.js).
 *
 * EarthBound is turn-based and has NO real-time "stun" (verified from the ROM:
 * eb_project/text_misc.yml ailment list + ccscript/data_57.ccs battle messages).
 * Its "can't act" conditions are Paralyzed (numb), Diamondized (solidified) and
 * Asleep; plus control-scramble (feeling strange / possessed), soft debuffs
 * (can't-concentrate, crying) and damage-over-time (poison, nausea, sunstroke,
 * cold). We model each as a TIMED effect — duration + a post-effect immunity
 * window so nothing chains into a perma-lock (the same capped/diminishing rule
 * the original ad-hoc "stun" used). KEEP the battle text in sync with data_57.
 *
 * A "holder" is any combatant object; this module stores state on `holder.statuses`
 * as `{ [type]: { until, immuneUntil, nextDotAt } }`. It never reads anything else
 * off the holder, so actors and players share the exact same code.
 */

// Status ids (wire-stable strings — the client maps these to icons + text).
const STATUS = {
  PARALYSIS: 'paralysis', // can't act (EB "numb"); the old ad-hoc stun became this
  DIAMOND: 'diamond', // can't act, longer/rarer (EB "solidified")
  SLEEP: 'sleep', // can't act; broken by taking a hit
  STRANGE: 'strange', // scrambled controls (feeling strange / mushroomized)
  POSSESSED: 'possessed', // periodic random action (mini-ghost)
  NO_PSI: 'noPsi', // PSI disabled (can't concentrate)
  CRYING: 'crying', // accuracy down
  POISON: 'poison', // HP damage-over-time
  BURN: 'burn', // fire DoT (not canon EB — our addition; see STATUS_EFFECTS.md)
  NAUSEOUS: 'nauseous', // DoT + chance to fumble an action
  SUNSTROKE: 'sunstroke', // heat DoT
  COLD: 'cold', // cold DoT (sniffling)
  HOMESICK: 'homesick', // periodic forced pause (flavor)
};

// Per-status behavior + real-time tuning. durationMs = how long it holds;
// immuneMs = post-effect window the holder can't re-catch it (caps perma-lock).
// Flags drive the consumers: blocksAction (freeze AI/input), breaksOnHit (clear
// when struck), scramble (wrong inputs), blocksPsi, accuracyDown, fumble; DoT via
// dotMs (tick period) + dotPct (fraction of MAX HP per tick). `text` is the EB
// battle line (ccscript/data_57.ccs) for the floating popup. Tunable in ONE place.
// `element` maps a status to the ROM vulnerability axis that resists it (see the
// enemy catalog `vuln` block): paralysis/fire/freeze/flash/hypnosis. A proc is
// scaled by the target's vuln% for that element. Statuses with no canon element
// (poison, crying, …) carry none → no resist scaling (100%).
const DEFS = {
  [STATUS.PARALYSIS]: {
    blocksAction: true,
    element: 'paralysis',
    durationMs: 550,
    immuneMs: 1500,
    text: 'Stunned!',
  },
  [STATUS.DIAMOND]: {
    blocksAction: true,
    blocksHealing: true, // can't be healed while solid — must be cured first (canon)
    permanent: true, // NO auto-timeout: holds until an ally cures it (Healing Ω-tier)
    element: 'flash',
    durationMs: 4000, // unused while permanent; kept for reference/fallback
    immuneMs: 0,
    text: 'solidified!',
  },
  [STATUS.SLEEP]: {
    blocksAction: true,
    breaksOnHit: true,
    element: 'hypnosis',
    durationMs: 4000,
    immuneMs: 3000,
    text: 'fell asleep!',
  },
  [STATUS.STRANGE]: {
    scramble: true,
    element: 'hypnosis',
    durationMs: 6000,
    immuneMs: 4000,
    text: 'feels strange!',
  },
  [STATUS.POSSESSED]: {
    scramble: true,
    durationMs: 6000,
    immuneMs: 4000,
    text: 'is possessed!',
  },
  [STATUS.NO_PSI]: { blocksPsi: true, durationMs: 6000, immuneMs: 0, text: "can't concentrate!" },
  [STATUS.CRYING]: { accuracyDown: true, durationMs: 8000, immuneMs: 0, text: 'is crying!' },
  [STATUS.POISON]: {
    dotMs: 1000,
    dotPct: 0.03,
    durationMs: 8000,
    immuneMs: 0,
    text: 'got poisoned!',
  },
  [STATUS.BURN]: {
    element: 'fire',
    dotMs: 800,
    dotPct: 0.04,
    durationMs: 6000,
    immuneMs: 0,
    text: 'is burning!',
  },
  [STATUS.NAUSEOUS]: {
    dotMs: 1500,
    dotPct: 0.02,
    fumble: true,
    durationMs: 8000,
    immuneMs: 0,
    text: 'feels nauseous...',
  },
  [STATUS.SUNSTROKE]: {
    dotMs: 1200,
    dotPct: 0.03,
    durationMs: 8000,
    immuneMs: 0,
    text: 'has sunstroke!',
  },
  [STATUS.COLD]: {
    dotMs: 1500,
    dotPct: 0.02,
    durationMs: 8000,
    immuneMs: 0,
    text: 'caught a cold!',
  },
  [STATUS.HOMESICK]: { durationMs: 12000, immuneMs: 0, text: 'is homesick...' },
};

function defOf(type) {
  return DEFS[type] || null;
}

// Every known status id, for validating authored inflict specs.
const STATUS_TYPES = new Set(Object.values(STATUS));

/**
 * Sanitize an authored inflict spec into a clean `[{type, chance, ...dot}]` list:
 * drop entries with an unknown status or a non-positive chance, clamp chance to
 * 100. The shared gate every damage source (weapon, enemy, PSI) runs its authored
 * data through, so malformed `equip_stats.json` / entity data can't crash combat
 * or inject a bogus status. `element` is intrinsic to the status (see elementOf),
 * not part of the spec.
 *
 * PER-ENTITY DoT tuning: a DoT status (poison/burn/cold/…) may carry optional
 * overrides so each source sets its own bite — `dotDmg` (flat HP per tick),
 * `dotPct` (fraction of the victim's max HP per tick), and `dotMs` (tick period).
 * Any omitted field falls back to the status catalog default in DEFS. Clamped so
 * authored data can't melt a target instantly or stall the tick. Returns [] for
 * anything malformed.
 */
function normalizeInflict(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    if (!STATUS_TYPES.has(e.type)) continue;
    const chance = Number(e.chance);
    if (!(chance > 0)) continue;
    const entry = { type: e.type, chance: Math.min(100, chance) };
    const dotMs = Number(e.dotMs);
    if (dotMs > 0) entry.dotMs = Math.min(60000, Math.max(100, dotMs));
    const dotDmg = Number(e.dotDmg);
    if (dotDmg > 0) entry.dotDmg = Math.min(9999, Math.floor(dotDmg));
    const dotPct = Number(e.dotPct);
    if (dotPct > 0) entry.dotPct = Math.min(1, dotPct);
    out.push(entry);
  }
  return out;
}

/** The ROM vulnerability element that resists `type` (e.g. 'hypnosis'), or null
 *  if the status has no canon resist axis (poison/crying/etc → never scaled). */
function elementOf(type) {
  const d = DEFS[type];
  return (d && d.element) || null;
}

/** Is `type` currently active on the holder (within its duration)? */
function hasStatus(holder, type, now) {
  const s = holder.statuses && holder.statuses[type];
  return !!(s && now < s.until);
}

/** Any active status that freezes the holder (paralysis / diamond / sleep)? */
function isActionBlocked(holder, now) {
  const m = holder.statuses;
  if (!m) return false;
  for (const type in m) {
    if (now < m[type].until && defOf(type) && defOf(type).blocksAction) return true;
  }
  return false;
}

/** Any active status that scrambles inputs (feeling strange / possessed)? */
function isScrambled(holder, now) {
  const m = holder.statuses;
  if (!m) return false;
  for (const type in m) {
    if (now < m[type].until && defOf(type) && defOf(type).scramble) return true;
  }
  return false;
}

/** True if any active flag matches `flagKey` (e.g. 'blocksPsi','accuracyDown','fumble'). */
function hasFlag(holder, now, flagKey) {
  const m = holder.statuses;
  if (!m) return false;
  for (const type in m) {
    if (now < m[type].until && defOf(type) && defOf(type)[flagKey]) return true;
  }
  return false;
}

/** PSI is disabled (the "can't concentrate" debuff). */
function isPsiBlocked(holder, now) {
  return hasFlag(holder, now, 'blocksPsi');
}

/** Healing is refused (diamondized) — the holder must be cured before HP restores. */
function blocksHealing(holder, now) {
  return hasFlag(holder, now, 'blocksHealing');
}

/** The attacker's accuracy is impaired (crying). */
function isCrying(holder, now) {
  return hasFlag(holder, now, 'accuracyDown');
}

/** The active status ids on the holder right now (for the wire / UI). */
function activeStatuses(holder, now) {
  const m = holder.statuses;
  if (!m) return [];
  const out = [];
  for (const type in m) if (now < m[type].until) out.push(type);
  return out;
}

/**
 * Apply `type` to the holder for its catalog duration. No-op (returns false) if
 * the holder is still inside that status' post-effect immunity window — this is
 * the diminishing rule that caps perma-lock. `opts.durationMs` overrides the
 * default (e.g. a stronger source); `opts.dotMs`/`opts.dotDmg`/`opts.dotPct` are
 * the per-source DoT overrides (see normalizeInflict) stored on the instance so
 * this holder's poison bites at the inflicting source's rate. Returns true if it
 * actually landed.
 */
function applyStatus(holder, type, now, opts) {
  const def = defOf(type);
  if (!def) return false;
  if (!holder.statuses) holder.statuses = {};
  const prev = holder.statuses[type];
  if (prev && now < (prev.immuneUntil || 0) && now >= prev.until) return false; // in immunity window
  const durationMs = (opts && opts.durationMs) || def.durationMs;
  const dotMs = (opts && opts.dotMs > 0 ? opts.dotMs : def.dotMs) || 0;
  // Permanent statuses (diamond) never auto-expire — they hold until a cure
  // clears them (clearStatus/clearAll). No failsafe by design (see STATUS_EFFECTS.md).
  const until = def.permanent ? Infinity : now + durationMs;
  const inst = {
    until,
    immuneUntil: def.permanent ? Infinity : until + (def.immuneMs || 0),
    nextDotAt: dotMs ? now + dotMs : 0,
  };
  // Persist per-source DoT overrides so tickStatuses bites at this source's rate.
  if (opts && opts.dotMs > 0) inst.dotMs = opts.dotMs;
  if (opts && opts.dotDmg > 0) inst.dotDmg = opts.dotDmg;
  if (opts && opts.dotPct > 0) inst.dotPct = opts.dotPct;
  holder.statuses[type] = inst;
  return true;
}

/**
 * Roll a `chance`% proc of `type` and apply it (immunity-gated). The proc is the
 * inflict odds (later: attack chance × the target's per-element vulnerability);
 * kept here so the roll + immunity check live together. `opts` carries the
 * source's per-entity overrides (durationMs / DoT rate) through to applyStatus.
 * Returns true if applied.
 */
function tryInflict(holder, type, chance, now, rng, opts) {
  if (!(chance > 0)) return false;
  if (rng() * 100 >= chance) return false;
  return applyStatus(holder, type, now, opts || null);
}

/** Clear one status outright (a cure). */
function clearStatus(holder, type) {
  if (holder.statuses) delete holder.statuses[type];
}

/** Clear every status (death / respawn / full cure). */
function clearAll(holder) {
  holder.statuses = {};
}

/** Break any "breaks when hit" status (e.g. Sleep) — call when the holder is struck. */
function breakOnHit(holder, now) {
  const m = holder.statuses;
  if (!m) return;
  for (const type in m) {
    if (now < m[type].until && defOf(type) && defOf(type).breaksOnHit) m[type].until = now;
  }
}

/**
 * Advance the holder's statuses by one tick. Returns:
 *   { dot: [{type, pct, dmg}], expired: [type], changed: bool }
 * `dot` = statuses that owe a damage tick this instant (caller applies HP, since
 * HP lives on the actor vs the host differently). Each carries `dmg` (flat HP,
 * from a per-source override) OR `pct` (fraction of max HP) — caller uses `dmg`
 * when > 0, else `pct`. `expired` = statuses whose duration just ended (for a
 * "wore off" cue). `changed` = the active set changed (a tick expired one) so the
 * caller can re-broadcast. Fully drops an entry once its immunity window has also
 * passed, so the map can't grow without bound.
 */
function tickStatuses(holder, now) {
  const m = holder.statuses;
  const res = { dot: [], expired: [], changed: false };
  if (!m) return res;
  for (const type in m) {
    const s = m[type];
    const def = defOf(type);
    const active = now < s.until;
    const dotMs = s.dotMs || (def && def.dotMs) || 0;
    if (active && dotMs && now >= s.nextDotAt) {
      const pct = s.dotPct != null ? s.dotPct : (def && def.dotPct) || 0;
      res.dot.push({ type, pct, dmg: s.dotDmg || 0 });
      s.nextDotAt = now + dotMs;
    }
    if (!active && !s.expiredFired) {
      s.expiredFired = true;
      res.expired.push(type);
      res.changed = true;
    }
    if (now >= (s.immuneUntil || s.until)) delete m[type]; // fully gone — reclaim the slot
  }
  return res;
}

module.exports = {
  STATUS,
  DEFS,
  defOf,
  elementOf,
  normalizeInflict,
  hasStatus,
  isActionBlocked,
  isScrambled,
  isPsiBlocked,
  blocksHealing,
  isCrying,
  hasFlag,
  activeStatuses,
  applyStatus,
  tryInflict,
  clearStatus,
  clearAll,
  breakOnHit,
  tickStatuses,
};
