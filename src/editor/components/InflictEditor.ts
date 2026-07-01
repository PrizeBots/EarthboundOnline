// Shared status-inflict list editor — rows of {status, chance%} with add/remove.
//
// The Item Manager (per-weapon inflicts) and PSI Manager (per-move inflicts) had
// this ~95-line builder copy-pasted line-for-line, plus their own duplicate copy
// of STATUS_OPTIONS. This is the single source for both. Pure DOM builder on top
// of the editor UI kit (src/editor/ui.ts) — the caller persists via `onCommit`.

import { mkButton, mkSelect, mkNumberInput } from '../ui';

/** One status proc carried by a weapon / PSI move. For damage-over-time statuses
 *  (poison/burn/…) the optional per-source overrides tune this source's bite:
 *  `dotDmg` = flat HP per tick, `dotMs` = tick period. Omitted → catalog default. */
export interface InflictEntry {
  type: string;
  chance: number;
  dotDmg?: number;
  dotMs?: number;
  dotPct?: number;
}

/** Statuses that deal damage-over-time — only these expose the dmg/rate fields.
 *  KEEP IN SYNC with the DoT statuses in server/status.js DEFS. */
const DOT_TYPES = new Set(['poison', 'burn', 'nauseous', 'sunstroke', 'cold']);

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
  { value: 'burn', label: 'Burning' },
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
          if (!DOT_TYPES.has(v)) {
            // Non-DoT status: drop any stale DoT overrides.
            delete entry.dotDmg;
            delete entry.dotMs;
            delete entry.dotPct;
          }
          commit();
          renderRows(); // show/hide the DoT dmg+rate fields for the new type
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

      // Per-source DoT tuning — only for damage-over-time statuses. Blank = use
      // the status catalog default (server/status.js). `dmg` = HP per tick,
      // `every` = tick period in ms.
      if (DOT_TYPES.has(entry.type)) {
        const dmg = mkNumberInput({
          value: entry.dotDmg ?? undefined,
          width: 44,
          min: 1,
          max: 9999,
          placeholder: 'dmg',
          tip: 'Flat HP drained per tick. Blank = status default (or % of max HP).',
          onChange: (v) => {
            if (v && v > 0) entry.dotDmg = v;
            else delete entry.dotDmg;
            commit();
          },
        });
        r.appendChild(dmg);

        const per = mkNumberInput({
          value: entry.dotMs ?? undefined,
          width: 56,
          min: 100,
          max: 60000,
          placeholder: 'every ms',
          tip: 'Tick period in ms — how often the DoT bites. Blank = status default.',
          onChange: (v) => {
            if (v && v > 0) entry.dotMs = v;
            else delete entry.dotMs;
            commit();
          },
        });
        r.appendChild(per);

        const perLbl = document.createElement('span');
        perLbl.textContent = 'ms';
        perLbl.style.cssText = 'color:#9fb8cc;';
        r.appendChild(perLbl);
      }

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
