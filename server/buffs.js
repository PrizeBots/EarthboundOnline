/**
 * buffs.js — temporary, timed STAT modifiers for combatants (players for now),
 * the consumable counterpart to status.js. EarthBound's Skip/Luck sandwiches and
 * the offense-up/defense PSI line are flat, timed boosts; we model each as an
 * entry `{ stat, amount, until }` stored on `holder.buffs` (an array, so multiple
 * buffs of the same stat stack and expire independently).
 *
 * Pure + side-effect-free except for writing `holder.buffs`, so the same code
 * serves any combatant and stays easy to reason about. Consumers READ the total
 * with buffBonus() at each stat's use-site (attack offense, incoming-damage
 * defense, dodge-from-speed) and PRUNE expired entries each tick via tickBuffs().
 *
 * SNES-portable: a flat additive bonus with an expiry frame is exactly what a
 * native build would keep in a small per-actor table.
 */

// Stats a buff may modify. Combat currently reads offense/defense/speed; the
// rest are accepted (and shown on the status screen) so authored data is honored
// the moment a future system consumes them. KEEP names matching statsPayload.
const BUFF_STATS = new Set(['offense', 'defense', 'speed', 'guts', 'vitality', 'iq', 'luck']);

/** Grant `amount` to `stat` for `durationMs`. No-op (false) for an unknown stat,
 *  a non-positive duration, or a zero amount. Returns true if it landed. */
function applyBuff(holder, stat, amount, durationMs, now) {
  if (!BUFF_STATS.has(stat)) return false;
  if (!(durationMs > 0)) return false;
  const amt = Math.round(amount);
  if (!amt) return false;
  if (!holder.buffs) holder.buffs = [];
  holder.buffs.push({ stat, amount: amt, until: now + durationMs });
  return true;
}

/** Total active bonus for `stat` right now (0 if none). */
function buffBonus(holder, stat, now) {
  const b = holder.buffs;
  if (!b || !b.length) return 0;
  let sum = 0;
  for (const e of b) if (e.stat === stat && now < e.until) sum += e.amount;
  return sum;
}

/** The active buff entries right now (for the wire / status UI). */
function activeBuffs(holder, now) {
  const b = holder.buffs;
  if (!b || !b.length) return [];
  return b.filter((e) => now < e.until);
}

/** Drop expired entries. Returns { changed } so the caller can re-push stats when
 *  a buff just wore off (effective offense/defense/speed dropped back down). */
function tickBuffs(holder, now) {
  const b = holder.buffs;
  if (!b || !b.length) return { changed: false };
  const kept = b.filter((e) => now < e.until);
  if (kept.length === b.length) return { changed: false };
  holder.buffs = kept;
  return { changed: true };
}

/** Wipe all buffs (death / respawn). */
function clearBuffs(holder) {
  holder.buffs = [];
}

module.exports = { BUFF_STATS, applyBuff, buffBonus, activeBuffs, tickBuffs, clearBuffs };
