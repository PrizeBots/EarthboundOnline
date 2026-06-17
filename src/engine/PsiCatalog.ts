/**
 * PsiCatalog — the ROM-derived PSI reference data (public/assets/map/psi.json,
 * built by tools/extract_psi.py from the EarthBound PSI tables). Read-only:
 *   - the Sprite Editor's PSI mode lists these to author an animation per ability,
 *   - the (future) cast system reads PP / target / type.
 *
 * Canon fields only (names / tiers / learn-levels / PP / target). The actual
 * effect math lives on our side — EarthBound keeps it in ASM (see extract_psi.py).
 */

export interface PsiAbility {
  id: string; // e.g. "lifeup_alpha"
  name: string; // family, e.g. "Lifeup"
  displayName: string; // with Greek tier, e.g. "Lifeup α"
  strength: string; // none|alpha|beta|gamma|omega
  type: string[]; // offense|recover|assist
  pp: number;
  target: string; // one|row|all|… (ROM battle-action target)
  direction: string; // party|enemy
  learn: { ness: number; paula: number; poo: number };
  usableOutside: string;
  actionId: number;
}

let abilities: PsiAbility[] = [];
let byId: Record<string, PsiAbility> = {};

export async function loadPsiCatalog(): Promise<void> {
  try {
    const res = await fetch('/assets/map/psi.json', { cache: 'no-store' });
    const doc = res.ok ? await res.json() : null;
    abilities = Array.isArray(doc?.abilities) ? (doc.abilities as PsiAbility[]) : [];
  } catch {
    abilities = []; // not extracted yet — editor shows an empty list
  }
  byId = Object.fromEntries(abilities.map((a) => [a.id, a]));
}

/** Every PSI ability (catalog order: by family, then tier). */
export function listPsi(): PsiAbility[] {
  return abilities;
}

export function getPsi(id: string): PsiAbility | null {
  return byId[id] ?? null;
}

/** Human label for a PSI id (display name, falls back to the id). */
export function psiLabel(id: string): string {
  return byId[id]?.displayName ?? id;
}
