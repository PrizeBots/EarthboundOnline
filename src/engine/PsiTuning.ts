/**
 * PsiTuning — the client-side PSI move table (base) + the authored tuning layer.
 *
 * This is the single client base for every PSI move: the gameplay menu
 * (menu/layout.ts re-exports the moves as PSI_ABILITIES) and the PSI Manager tool
 * both read it, so there's no duplicate list to drift. Tuning (PP/power/range/
 * status/etc.) is layered on top from `public/overrides/psi.json` — OUR authored
 * data, the SAME file the server merges over its own base (server/gameHost.js
 * PSI_BASE). Editing one file reconfigures a move on both sides.
 *
 * The full canon roster (52 abilities, all families + tiers) is built from a
 * COMPACT family spec (PSI_FAMILY_SPECS) so there's one short source to keep in
 * sync with the server, not 52 literals. Every move's id matches the ROM PSI
 * catalog id (PsiCatalog) AND its authored animation key in psi_anim.json, so the
 * cast FX resolve exactly (no aliasing). KEEP PSI_FAMILY_SPECS IN SYNC with the
 * matching spec in server/gameHost.js (same ids/pp/effect fields).
 */

export type PsiCategory = 'offense' | 'recover' | 'assist' | 'other';
export type PsiTarget = 'ally' | 'enemy' | 'self';
export type PsiTier = 'alpha' | 'beta' | 'gamma' | 'omega' | 'sigma';

/** One status proc a PSI move inflicts (server-applied, element-scaled by resist). */
export interface PsiInflict {
  type: string;
  chance: number;
}

/** A PSI move's full definition. Effect fields are optional (assist moves are
 *  anim-only for now). Mirrors the fields server/gameHost.js use_psi consumes. */
export interface PsiMove {
  id: string;
  name: string; // display name w/ tier, e.g. "Lifeup α"
  family: string; // grouping label, e.g. "Lifeup"
  tier: PsiTier;
  category: PsiCategory;
  pp: number;
  target: PsiTarget;
  anim: string; // PsiAnim catalog id whose authored frames play on cast
  heal?: number; // HP restored to the target (recover)
  damage?: number; // HP struck off the enemy (offense)
  range?: number; // px reach for offense/ailment (radius / bolts candidate pool)
  multi?: boolean; // ROM row/all — hit EVERY enemy in range (radius shape)
  // Offense targeting SHAPE (default 'radius' = circle around the caster):
  //   'line'   — aimed traveling projectile(s): Fire's cone, or Ice's single
  //              straight bolt (spread 0). Damage lands ON CONTACT.
  //   'screen' — every enemy in the caster's VIEW at once (Rockin'/Starstorm/Flash).
  //   'bolts'  — `bolts` RANDOM enemies within `range`, each hit by a lightning
  //              bolt that falls from above (Thunder).
  shape?: 'radius' | 'line' | 'screen' | 'bolts';
  length?: number; // line shape: forward reach px
  width?: number; // line shape: half-width px AT THE MUZZLE (narrow start)
  spread?: number; // line shape: half-width GAINED per px forward — the cone fans
  //                   out shotgun-style, wider per tier (0 = a straight beam)
  bolts?: number; // bolts shape: how many random in-range enemies are struck
  reviveFrac?: number; // revive a downed ally to this fraction of max HP
  cures?: boolean; // clear the target's status conditions
  inflict?: PsiInflict[]; // status procs on the enemy
  unlockMental?: number; // Mental level at which this move is LEARNED (see below)
}

/** Fields the override layer may change (everything but identity/grouping). */
export type PsiOverride = Partial<Omit<PsiMove, 'id' | 'family' | 'tier' | 'category'>>;

export interface PsiOverrideDoc {
  version: number;
  moves?: Record<string, PsiOverride>;
}

// --- compact family spec → expanded move table ------------------------------
// One entry per tier, parallel to `tiers`. id is `${stem}_${tier}` (matches the
// ROM catalog + the psi_anim.json key). anim === id.
type TierEffect = Omit<
  PsiMove,
  'id' | 'name' | 'family' | 'tier' | 'category' | 'target' | 'anim' | 'pp'
>;
interface PsiFamilySpec {
  stem: string; // id/anim stem: 'lifeup', 'psi_fire', 'psi' (Rockin), …
  family: string; // display family name
  category: PsiCategory;
  target: PsiTarget;
  tiers: PsiTier[]; // tiers this family has, in menu order
  pp: number[]; // PP per tier (parallel to tiers)
  effect?: (tier: PsiTier, i: number) => TierEffect; // per-tier effect fields
}

const GREEK: Record<PsiTier, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  omega: 'Ω',
  sigma: 'Σ',
};

/** Human label for a tier (the Greek letter). */
export function tierLabel(t: PsiTier): string {
  return GREEK[t];
}

// Effect values are gameplay tuning (canon PP, our scaled power) — the PSI
// Manager edits them via psi.json. Animations for every id already exist in
// public/overrides/psi_anim.json, so no art is needed per tier.
const PSI_FAMILY_SPECS: PsiFamilySpec[] = [
  // ---- Offense ----------------------------------------------------------------
  // Targeting differs by `shape` (see PsiMove): Rockin'/Starstorm/Flash burst every
  // enemy in the SCREEN at once; Fire shoots a forward cone and Ice a single straight
  // bolt (both aimed, damage on contact); Thunder calls bolts down from above on
  // random enemies (more per tier).
  {
    stem: 'psi',
    family: "PSI Rockin'",
    category: 'offense',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [10, 14, 40, 98],
    effect: (_t, i) => ({ damage: [20, 45, 100, 220][i], shape: 'screen' }),
  },
  {
    stem: 'psi_fire',
    family: 'PSI Fire',
    category: 'offense',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [6, 12, 20, 42],
    // Shotgun cone: narrow muzzle, fanning WIDER with distance + per tier, and
    // reaching further — so α is a short jet and Ω sweeps a whole arc of a room.
    // End half-width = width + spread*length → ~45 / 94 / 183 / 339 px by tier.
    effect: (_t, i) => ({
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
    category: 'offense',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [4, 9, 18, 28],
    // Single aimed bolt — Fire's path with NO spread (one pellet), straight to the
    // cursor, damage on contact (a wall stops it). Longer reach per tier.
    effect: (_t, i) => ({
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
    category: 'offense',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [3, 7, 16, 20],
    // Random strikes: stronger tiers zap MORE enemies (and for more) on screen.
    effect: (_t, i) => ({
      damage: [16, 34, 70, 100][i],
      shape: 'bolts',
      bolts: [2, 3, 5, 8][i],
      range: 520,
    }),
  },
  {
    stem: 'psi_flash',
    family: 'PSI Flash',
    category: 'offense',
    target: 'enemy',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [8, 16, 24, 32],
    // Group move: bursts every enemy in view, each with a chance of the status.
    effect: (_t, i) => ({
      damage: [10, 22, 40, 70][i],
      shape: 'screen',
      inflict: [{ type: 'paralysis', chance: [40, 50, 60, 70][i] }],
    }),
  },
  {
    stem: 'psi_starstorm',
    family: 'PSI Starstorm',
    category: 'offense',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [24, 42],
    // Screen-wide starfall — hits every enemy in view (see shape 'screen').
    effect: (_t, i) => ({ damage: [30, 60][i], shape: 'screen' }),
  },
  // ---- Recover (party-target heal/cure/revive; Magnet drains, not yet wired) ----
  {
    stem: 'lifeup',
    family: 'Lifeup',
    category: 'recover',
    target: 'ally',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [5, 8, 13, 24],
    effect: (_t, i) => ({ heal: [40, 80, 150, 300][i] }),
  },
  {
    stem: 'healing',
    family: 'Healing',
    category: 'recover',
    target: 'ally',
    tiers: ['alpha', 'beta', 'gamma', 'omega'],
    pp: [5, 8, 20, 38],
    effect: (_t, i) => ({ cures: true, reviveFrac: [0, 0, 0.5, 1][i] || undefined }),
  },
  {
    stem: 'psi_magnet',
    family: 'PSI Magnet',
    category: 'recover',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [1, 1],
  },
  // ---- Assist (ailments inflict status; buffs/debuffs are anim-only for now) ----
  {
    stem: 'hypnosis',
    family: 'Hypnosis',
    category: 'assist',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [6, 18],
    effect: (_t, i) => ({ range: 240, multi: i === 1, inflict: [{ type: 'sleep', chance: 90 }] }),
  },
  {
    stem: 'paralysis',
    family: 'Paralysis',
    category: 'assist',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [8, 24],
    effect: (_t, i) => ({
      range: 240,
      multi: i === 1,
      inflict: [{ type: 'paralysis', chance: 90 }],
    }),
  },
  {
    stem: 'brainshock',
    family: 'Brainshock',
    category: 'assist',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [10, 30],
    effect: (_t, i) => ({
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
    category: 'assist',
    target: 'self',
    tiers: ['alpha', 'omega'],
    pp: [10, 30],
  },
  {
    stem: 'defense_down',
    family: 'Defense down',
    category: 'assist',
    target: 'enemy',
    tiers: ['alpha', 'omega'],
    pp: [6, 18],
  },
  {
    stem: 'shield',
    family: 'Shield',
    category: 'assist',
    target: 'self',
    tiers: ['alpha', 'beta', 'omega', 'sigma'],
    pp: [6, 10, 30, 18],
  },
  {
    stem: 'psi_shield',
    family: 'PSI Shield',
    category: 'assist',
    target: 'self',
    tiers: ['alpha', 'beta', 'omega', 'sigma'],
    pp: [8, 14, 42, 24],
  },
  // ---- Other ----
  {
    stem: 'teleport',
    family: 'Teleport',
    category: 'other',
    target: 'self',
    tiers: ['alpha', 'beta'],
    pp: [2, 8],
  },
];

/** A family + its expanded moves (menu grouping). */
export interface PsiFamily {
  stem: string;
  family: string;
  category: PsiCategory;
  moves: PsiMove[];
}

function expandFamily(spec: PsiFamilySpec): PsiFamily {
  const moves = spec.tiers.map((tier, i) => {
    const id = `${spec.stem}_${tier}`;
    const move: PsiMove = {
      id,
      name: `${spec.family} ${GREEK[tier]}`,
      family: spec.family,
      tier,
      category: spec.category,
      pp: spec.pp[i],
      target: spec.target,
      anim: id,
      ...(spec.effect ? spec.effect(tier, i) : {}),
    };
    return move;
  });
  return { stem: spec.stem, family: spec.family, category: spec.category, moves };
}

/** Families in canon menu order, each with its expanded per-tier moves. */
export const PSI_FAMILIES: PsiFamily[] = PSI_FAMILY_SPECS.map(expandFamily);

// The base table: every move, flattened. KEEP IN SYNC with server gameHost.js.
export const PSI_BASE: PsiMove[] = PSI_FAMILIES.flatMap((f) => f.moves);

// Mental level each move is LEARNED at — its rank when costed moves are sorted by
// PP (cheap = early), one move per Mental point (see ABILITIES.md §3.4). Free moves
// (PSI Magnet, pp<=1) learn at Mental 1. `.slice()` so PSI_BASE menu order is kept.
// KEEP IN SYNC with assignUnlockMental() in server/gameHost.js.
{
  const costed = PSI_BASE.filter((m) => m.pp > 1)
    .slice()
    .sort((a, b) => a.pp - b.pp); // stable: ties keep family/tier order
  costed.forEach((m, i) => (m.unlockMental = i + 1));
  PSI_BASE.filter((m) => m.pp <= 1).forEach((m) => (m.unlockMental = 1));
}

const BASE_BY_ID: Record<string, PsiMove> = Object.fromEntries(PSI_BASE.map((m) => [m.id, m]));

/** The menu tab order — the four canon PSI types. */
export const PSI_TABS: PsiCategory[] = ['offense', 'recover', 'assist', 'other'];

/** Families belonging to a tab (category), in table order. */
export function familiesInTab(cat: PsiCategory): PsiFamily[] {
  return PSI_FAMILIES.filter((f) => f.category === cat);
}

/** The base (un-overridden) move for an id. */
export function psiBase(id: string): PsiMove | undefined {
  return BASE_BY_ID[id];
}

/** Every base move id, in table order. */
export function allPsiIds(): string[] {
  return PSI_BASE.map((m) => m.id);
}

/** A move with the authored override layered on (base when no override). */
export function effectivePsi(
  id: string,
  overrides: Record<string, PsiOverride>
): PsiMove | undefined {
  const base = BASE_BY_ID[id];
  if (!base) return undefined;
  const ov = overrides[id];
  return ov ? { ...base, ...ov } : base;
}

/** Pretty label for a category folder / menu tab. */
export const PSI_CATEGORY_LABEL: Record<PsiCategory, string> = {
  offense: 'Offense',
  recover: 'Recover',
  assist: 'Assist',
  other: 'Other',
};
