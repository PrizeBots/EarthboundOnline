/**
 * CombatJuice — the live-tunable feel knobs for combat popups (damage/heal/crit/
 * miss numbers). These used to be compile-time constants in Emitter.ts; they now
 * live here so the dev Combat tool can fine-tune them in real time and persist
 * the result to overrides/combat_juice.json (OUR data — pure numbers/colors, no
 * ROM content). Same overrides pattern as SfxEvents: DEFAULTS, an in-memory
 * working copy, a loader, a live setter the editor pushes through, and a getter
 * the Emitter reads every spawn/frame.
 *
 * Anything purely cosmetic about the floating numbers belongs here. Combat
 * MATH (damage, crit rolls, knockback) is server-authoritative (npcSim.js) and
 * is NOT tunable from this client-side juice layer.
 */

import { loadJSON } from './AssetLoader';

export interface CombatJuice {
  // --- Magnitude scaling: bigger hits/heals pop bigger numbers ---
  // Size ramps from numScaleMin (at 1 damage) to numScaleMax (at numScaleCap
  // damage), mapped LOGARITHMICALLY so the low-to-mid range still varies visibly
  // instead of everything pinning to tiny against a 9999 ceiling.
  /** Render scale for the smallest hits (1 damage). */
  numScaleMin: number;
  /** Render scale reached at numScaleCap damage (the largest a number ever gets). */
  numScaleMax: number;
  /** Damage value that maps to numScaleMax — the assumed max hit (FF-style 9999). */
  numScaleCap: number;

  // --- Arc motion (damage / heal / miss popups launch + fall) ---
  lifetime: number; // ms a popup lives before vanishing
  fade: number; // ms of fade-out at the end of life
  gravity: number; // px/s^2 downward pull on the arc
  launchVy: number; // px/s initial upward speed
  launchVx: number; // px/s max random horizontal drift (±)
  spawnJitter: number; // px random x at spawn so stacked hits don't overlap

  // --- Crit burst ("SMAAAASH!") ---
  critScaleFrom: number; // starts this small...
  critScaleTo: number; // ...and climaxes this large as it fades
  critLife: number; // ms the burst lives

  // --- Heal float (rises while swaying on a sine curve, then fades) ---
  healRise: number; // px/s the heal number drifts straight up
  healWobbleAmp: number; // px of horizontal sway (0 = straight up)
  healWobbleHz: number; // sway cycles per second
  healLife: number; // ms the heal number lives

  // --- Big-hit color ramp (damage dealt to enemies) ---
  /** When on, a damage number's color ramps toward bigHit color as it grows. */
  bigHitRamp: boolean;
  /** Damage at which the ramp begins; it reaches full bigHit color at 2×. */
  bigHitThreshold: number;

  // --- Colors (hex) ---
  colDamage: string; // your hits on enemies / remote players
  colOwnDamage: string; // the LOCAL player getting hit (only you see it)
  colHeal: string; // heal numbers
  colCrit: string; // SMAAAASH! crit text
  colMiss: string; // whiffed / dodged swing
  colBigHit: string; // ramp target for the heaviest hits
}

// Defaults mirror the original Emitter.ts constants exactly — tuning starts here.
export const COMBAT_JUICE_DEFAULTS: CombatJuice = {
  numScaleMin: 0.8,
  numScaleMax: 2.6,
  numScaleCap: 9999,
  lifetime: 850,
  fade: 300,
  gravity: 480,
  launchVy: 130,
  launchVx: 30,
  spawnJitter: 5,
  critScaleFrom: 0.7,
  critScaleTo: 2.0,
  critLife: 1100,
  healRise: 24,
  healWobbleAmp: 7,
  healWobbleHz: 1.6,
  healLife: 1100,
  bigHitRamp: false,
  bigHitThreshold: 20,
  colDamage: '#ffffff',
  colOwnDamage: '#ff3b3b',
  colHeal: '#5cff5c',
  colCrit: '#ff4d4d',
  colMiss: '#b8c0cc',
  colBigHit: '#ff8a1e',
};

let juice: CombatJuice = { ...COMBAT_JUICE_DEFAULTS };

export interface CombatJuiceFile {
  version?: number;
  juice?: Partial<CombatJuice>;
}

/** Load the authored juice values (overrides/combat_juice.json); unset → default.
 *  Only keys present in DEFAULTS are taken — stale keys from an older schema
 *  (e.g. a removed dial) are silently dropped rather than carried forward. */
export async function loadCombatJuice(): Promise<void> {
  try {
    const file = await loadJSON<CombatJuiceFile>('/overrides/combat_juice.json');
    juice = mergeKnown(file?.juice ?? {});
  } catch {
    juice = { ...COMBAT_JUICE_DEFAULTS }; // none authored yet — pure defaults
  }
}

/** Overlay only the keys CombatJuice actually defines, ignoring unknown ones. */
function mergeKnown(partial: Partial<CombatJuice>): CombatJuice {
  const out = { ...COMBAT_JUICE_DEFAULTS };
  for (const k of Object.keys(out) as (keyof CombatJuice)[]) {
    if (partial[k] !== undefined) (out as Record<string, unknown>)[k] = partial[k];
  }
  return out;
}

/** The active juice values (Emitter reads this every spawn/frame). */
export function getCombatJuice(): Readonly<CombatJuice> {
  return juice;
}

/** Live-merge a partial set of values (the editor pushes its working set here). */
export function setCombatJuice(partial: Partial<CombatJuice>): void {
  juice = { ...juice, ...partial };
}

/** Reset every value back to the built-in defaults (editor "Reset" button). */
export function resetCombatJuice(): void {
  juice = { ...COMBAT_JUICE_DEFAULTS };
}
