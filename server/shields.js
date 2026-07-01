/**
 * shields.js — block/reflect-N-hits shields (EB's Power Shield / PSI Shield),
 * the canon counterpart to buffs.js (flat stat boosts) and status.js (ailments).
 *
 * A shield GUARDS one damage KIND — 'physical' (Power Shield) or 'psi' (PSI
 * Shield). Each matching incoming hit is FULLY absorbed and decrements the
 * shield's hit counter; a 'reflect' shield also bounces the blow back at the
 * attacker (EB's β/Σ reflect the damage; α/Ω-block just null it). The shield
 * breaks (is removed) once its counter hits 0. State lives on `holder.shields`
 * (an array, one entry per active kind), so players and actors share the code.
 *
 * Pure + side-effect-free except for writing `holder.shields`. SNES-portable: a
 * small per-actor counter table is exactly what a native build would keep.
 */

// The damage kinds a shield can guard. A hit with no kind (e.g. DoT poison) is
// NEVER shielded — shields stop ATTACKS, not the bleed they leave behind.
const KINDS = new Set(['physical', 'psi']);

/** Raise a shield of `kind` in `mode` ('block'|'reflect') that soaks `hits`
 *  matching blows. A fresh cast REPLACES any existing shield of the same kind
 *  (recasting refreshes, never stacks). No-op (false) on bad args. */
function applyShield(holder, kind, mode, hits) {
  if (!KINDS.has(kind)) return false;
  if (mode !== 'block' && mode !== 'reflect') return false;
  const n = Math.floor(hits);
  if (!(n > 0)) return false;
  if (!holder.shields) holder.shields = [];
  holder.shields = holder.shields.filter((s) => s.kind !== kind);
  holder.shields.push({ kind, mode, hits: n });
  return true;
}

/**
 * Consume one incoming hit of `kind`. Returns `{ absorbed, reflect }`:
 *   absorbed — a shield ate the blow; the caller nullifies the damage.
 *   reflect  — the shield bounces the damage back (caller re-applies to attacker).
 * Decrements the shield and removes it when it breaks. `{false,false}` if no
 * shield of that kind is up (the hit lands normally).
 */
function absorbHit(holder, kind) {
  const arr = holder.shields;
  if (!arr || !arr.length) return { absorbed: false, reflect: false };
  const idx = arr.findIndex((s) => s.kind === kind && s.hits > 0);
  if (idx < 0) return { absorbed: false, reflect: false };
  const s = arr[idx];
  const reflect = s.mode === 'reflect';
  s.hits -= 1;
  if (s.hits <= 0) arr.splice(idx, 1);
  return { absorbed: true, reflect };
}

/** The active shields right now (for the wire / HUD). */
function activeShields(holder) {
  return (holder.shields || []).filter((s) => s.hits > 0);
}

/** Wipe all shields (death / respawn). */
function clearShields(holder) {
  holder.shields = [];
}

module.exports = { applyShield, absorbHit, activeShields, clearShields };
