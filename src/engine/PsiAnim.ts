/**
 * PsiAnim — authored PSI effect animations (public/overrides/psi_anim.json).
 *
 * OUR art, shippable (no ROM-derived pixels). Per PSI id (from PsiCatalog):
 *   - `delivery`: where the effect plays —
 *       'caster'     : on the caster (e.g. a charge aura),
 *       'target'     : on the affected entity (Lifeup α heals → sparkles on them),
 *       'projectile' : travels caster→target (the "kamehameha" beam/bolt).
 *   - `frames`: a flipbook of PSI_W×PSI_H frames, each a PNG data URL.
 *
 * Mirror of Items.ts: the Sprite Editor's PSI mode writes these; the cast runtime
 * (later) reads them and composites per delivery mode. The pixel-art lives as data
 * URLs so a frame round-trips through a canvas with no palette coupling.
 */

export const PSI_W = 48;
export const PSI_H = 48;

export type PsiDelivery = 'caster' | 'target' | 'projectile';
export const PSI_DELIVERIES: PsiDelivery[] = ['caster', 'target', 'projectile'];

export interface PsiAnimEntry {
  delivery: PsiDelivery;
  frames: string[]; // PSI_W×PSI_H PNG data URLs, in playback order
}

export interface PsiAnimDoc {
  version?: number;
  anims?: Record<string, PsiAnimEntry>;
}

// id -> authored animation. Empty until something is authored.
let anims: Record<string, PsiAnimEntry> = {};

export async function loadPsiAnims(): Promise<void> {
  try {
    const res = await fetch('/overrides/psi_anim.json', { cache: 'no-store' });
    const doc = (res.ok ? await res.json() : null) as PsiAnimDoc | null;
    anims = doc?.anims ?? {};
  } catch {
    anims = {}; // none authored yet
  }
}

/** The authored animation for a PSI id, or null. */
export function getPsiAnim(id: string): PsiAnimEntry | null {
  return anims[id] ?? null;
}

/** All authored PSI anim ids (sorted) — for editor pickers (e.g. enemy abilities). */
export function psiAnimIds(): string[] {
  return Object.keys(anims).sort();
}

/** True if `id` has any authored frames (for the editor's "has art" markers). */
export function hasPsiAnim(id: string): boolean {
  return (anims[id]?.frames.length ?? 0) > 0;
}

/** Set (or replace) the authored animation for a PSI id, in memory. The editor
 *  persists the whole doc via the save channel after calling this. */
export function setPsiAnim(id: string, entry: PsiAnimEntry): void {
  anims[id] = entry;
}

/** The whole authored map, for writing overrides/psi_anim.json. */
export function psiAnimDoc(): PsiAnimDoc {
  return { version: 1, anims };
}
