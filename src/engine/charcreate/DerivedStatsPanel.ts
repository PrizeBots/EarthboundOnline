/**
 * Derived-stats preview shared by the level-up spend pentagon (LevelUpModal) and
 * character creation (CreateFlow): a two-column grid of EB-font `label : value`
 * rows recomputed from a 5-stat allocation, so both screens show "what the
 * pentagon does to your stats" with identical markup/look.
 *
 * Callers differ only in what number a row should SHOW and which change to
 * highlight, so that decision is injected as `valueFor`:
 *   - level-up: current displayed value + the derivation delta (so it matches the
 *     Status screen, with a gold "+N" for the spend),
 *   - creation: the raw derived value, with "+N" measured against the base build.
 */
import { ebText } from '../EbText';
import { Alloc } from './StatRadar';
import { deriveCombatStats, DerivedStats } from './deriveCombatStats';

const ATTRS: { label: string; dkey: keyof DerivedStats }[] = [
  { label: 'HP', dkey: 'maxHp' },
  { label: 'PP', dkey: 'ppMax' },
  { label: 'Offense', dkey: 'offense' },
  { label: 'Defense', dkey: 'defense' },
  { label: 'Speed', dkey: 'speed' },
  { label: 'Guts', dkey: 'guts' },
  { label: 'Vitality', dkey: 'vitality' },
  { label: 'IQ', dkey: 'iq' },
  { label: 'Luck', dkey: 'luck' },
];

export interface DerivedAttrsView {
  el: HTMLElement;
  /** Recompute + repaint the rows for a stat allocation. */
  render: (alloc: Alloc) => void;
}

/**
 * Build the derived-stats grid. `valueFor(dkey, derived)` returns the number to
 * display and the change to flag (delta > 0 renders the value green with a gold
 * "+N"). The ATTRS list, DOM, and styles live here so the two callers stay in sync.
 */
export function createDerivedAttrs(
  valueFor: (dkey: keyof DerivedStats, derived: DerivedStats) => { shown: number; delta: number }
): DerivedAttrsView {
  injectStyles();
  const box = document.createElement('div');
  box.className = 'eb-da-attrs';
  const render = (alloc: Alloc): void => {
    box.innerHTML = '';
    const d = deriveCombatStats(alloc);
    for (const a of ATTRS) {
      const { shown, delta } = valueFor(a.dkey, d);
      const row = document.createElement('div');
      row.className = 'eb-da-attr';
      row.appendChild(ebText(a.label, 2, '#9fb0d0'));
      const right = document.createElement('div');
      right.className = 'eb-da-attrval';
      right.appendChild(ebText(String(shown), 2, delta > 0 ? '#6fdc8c' : '#ffffff'));
      if (delta > 0) right.appendChild(ebText(`+${delta}`, 1, '#ffd23f'));
      row.appendChild(right);
      box.appendChild(row);
    }
  };
  return { el: box, render };
}

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const css = `
  /* Derived-attribute preview: two columns of label:value rows mirroring the
     Status screen. Boosted values render green with a gold "+N". */
  .eb-da-attrs {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px;
    border-top: 1px solid #2a2a3e; margin-top: 2px; padding: 10px 4px 2px;
  }
  .eb-da-attr { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .eb-da-attr canvas { image-rendering: pixelated; }
  .eb-da-attrval { display: flex; align-items: baseline; gap: 6px; }
  `;
  const style = document.createElement('style');
  style.id = 'eb-da-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
