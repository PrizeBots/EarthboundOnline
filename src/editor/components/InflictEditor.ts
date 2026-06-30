// Shared status-inflict list editor — rows of {status, chance%} with add/remove.
//
// The Item Manager (per-weapon inflicts) and PSI Manager (per-move inflicts) had
// this ~95-line builder copy-pasted line-for-line, plus their own duplicate copy
// of STATUS_OPTIONS. This is the single source for both. Pure DOM builder on top
// of the editor UI kit (src/editor/ui.ts) — the caller persists via `onCommit`.

import { mkButton, mkSelect, mkNumberInput } from '../ui';

/** One status proc carried by a weapon / PSI move. */
export interface InflictEntry {
  type: string;
  chance: number;
}

/** Status ids selectable in the inflict editor — KEEP IN SYNC with
 *  server/status.js STATUS (the wire-stable strings the inflict model uses). */
export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'paralysis', label: 'Paralysis (numb)' },
  { value: 'diamond', label: 'Diamondized' },
  { value: 'sleep', label: 'Asleep' },
  { value: 'strange', label: 'Feeling strange' },
  { value: 'possessed', label: 'Possessed' },
  { value: 'noPsi', label: "Can't concentrate" },
  { value: 'crying', label: 'Crying' },
  { value: 'poison', label: 'Poisoned' },
  { value: 'nauseous', label: 'Nauseous' },
  { value: 'sunstroke', label: 'Sunstroke' },
  { value: 'cold', label: 'Cold' },
  { value: 'homesick', label: 'Homesick' },
];

export interface InflictEditorOpts {
  /** Current entries to seed the editor (a private copy is made — not mutated). */
  entries: InflictEntry[];
  /** Persist the edited list (fires on every add/remove/edit). */
  onCommit: (list: InflictEntry[]) => void;
  /** Text for the empty state, e.g. `none → baseline paralysis (12%)`. */
  emptyText: string;
  /** Default chance % when adding a new row. */
  addChance: number;
  /** Noun for the tooltips ("weapon" / "move"). Default "attack". */
  noun?: string;
}

/**
 * Build the status-inflict list editor and return its wrapper element; the
 * caller appends it wherever it wants in its panel.
 */
export function buildInflictEditor(opts: InflictEditorOpts): HTMLDivElement {
  const list = opts.entries.map((e) => ({ ...e }));
  const noun = opts.noun ?? 'attack';

  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;gap:4px;border-top:1px solid #2a3540;padding-top:6px;';
  const head = document.createElement('div');
  head.textContent = 'STATUS INFLICTS (on hit)';
  head.style.cssText = 'color:#9fb8cc;font-size:11px;';
  wrap.appendChild(head);

  const rowsEl = document.createElement('div');
  rowsEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  wrap.appendChild(rowsEl);

  const commit = () => opts.onCommit(list);

  const renderRows = () => {
    rowsEl.innerHTML = '';
    list.forEach((entry, idx) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;gap:4px;';

      const sel = mkSelect(STATUS_OPTIONS, {
        value: entry.type,
        flex: true,
        tip: `Status ailment this ${noun} may inflict on hit.`,
        onChange: (v) => {
          entry.type = v;
          commit();
        },
      });
      r.appendChild(sel);

      // The chance field always carries a value in [1,100] — clear/NaN snaps to 1.
      const pct = mkNumberInput({
        value: entry.chance,
        width: 48,
        min: 1,
        max: 100,
        tip: 'Proc chance % (1–100), scaled by the target’s resistance.',
        onChange: (v, el) => {
          const n = v ?? 1;
          entry.chance = n;
          el.value = String(n);
          commit();
        },
      });
      r.appendChild(pct);

      const pctLbl = document.createElement('span');
      pctLbl.textContent = '%';
      pctLbl.style.cssText = 'color:#9fb8cc;';
      r.appendChild(pctLbl);

      mkButton(
        '🗑',
        () => {
          list.splice(idx, 1);
          commit();
          renderRows();
        },
        { parent: r, pad: '1px 6px', tip: 'Remove this status inflict.' }
      );

      rowsEl.appendChild(r);
    });
    if (!list.length) {
      const none = document.createElement('div');
      none.textContent = opts.emptyText;
      none.style.cssText = 'color:#667;font-size:10px;';
      rowsEl.appendChild(none);
    }
  };
  renderRows();

  mkButton(
    '+ Add status',
    () => {
      list.push({ type: 'paralysis', chance: opts.addChance });
      commit();
      renderRows();
    },
    { parent: wrap, tip: `Add another status the ${noun} can inflict on hit.` }
  );

  const hint = document.createElement('div');
  hint.textContent = 'Chance is scaled by the target’s resistance to that status.';
  hint.style.cssText = 'color:#667;font-size:10px;line-height:1.4;';
  wrap.appendChild(hint);

  return wrap;
}
