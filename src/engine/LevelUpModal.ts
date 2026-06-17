/**
 * Level-up spend pentagon. Opened from the corner level-up icon: shows your 5
 * stats on the radar starting at the current (server-authoritative) allocation,
 * and lets you drag dots OUTWARD to spend banked points — you can't drag below
 * what you already have. Confirm sends only the deltas; the SERVER validates and
 * applies them (see gameHost spend_points). Spend partially and bank the rest.
 */
import { ensureEbFont, ebText, ebButton, injectEbChrome } from './EbText';
import { createStatRadar, Alloc, StatKey, STAT_KEYS } from './charcreate/StatRadar';
import { getStatus, PlayerStats } from './StatusModal';
import { deriveCombatStats, DerivedStats } from './charcreate/deriveCombatStats';

let root: HTMLDivElement | null = null;
let openNow = false;

export function isLevelUpOpen(): boolean {
  return openNow;
}

/**
 * Show the spend pentagon. `alloc` + `points` are the server's authoritative
 * values; `onConfirm(add)` is called with the chosen per-stat deltas (caller
 * sends them to the server). No-op if there are no points to spend.
 */
export async function openLevelUp(
  alloc: Record<string, number>,
  points: number,
  onConfirm: (add: Record<string, number>) => void
): Promise<void> {
  if (openNow || points <= 0) return;
  injectEbChrome();
  injectStyles();
  await ensureEbFont();
  openNow = true;

  const initial: Alloc = STAT_KEYS.reduce((o, k) => ((o[k] = alloc[k] ?? 1), o), {} as Alloc);
  const maxVal = Math.max(...Object.values(initial));

  root = document.createElement('div');
  root.className = 'eb-lu-root';
  const panel = document.createElement('div');
  panel.className = 'eb-lu-panel eb-win';
  root.appendChild(panel);

  panel.appendChild(center(ebText('LEVEL UP!', 2, '#f8e85a')));
  panel.appendChild(center(ebText('Spend your points', 1, '#9fb0d0')));

  const left = document.createElement('div');
  left.className = 'eb-lu-left';
  panel.appendChild(left);
  const setLeft = (n: number) => {
    left.innerHTML = '';
    left.appendChild(
      ebText(`${n} POINT${n === 1 ? '' : 'S'} LEFT`, 1, n > 0 ? '#ffb84d' : '#6fdc8c')
    );
  };

  // Live attribute preview (below the pentagon): the SAME derived stats the
  // Status screen shows — Offense/Defense/Speed/Guts/etc — recomputed as the
  // player drags dots, so they see what a build does BEFORE confirming. The
  // server's per-level growth cancels out: we show the current displayed value
  // plus the derivation delta, so it always matches the Status screen.
  const currentStats: PlayerStats = { ...getStatus() };
  const baseDerived = deriveCombatStats(initial);
  const ATTRS: { label: string; dkey: keyof DerivedStats; sfield: keyof PlayerStats }[] = [
    { label: 'HP', dkey: 'maxHp', sfield: 'hpMax' },
    { label: 'PP', dkey: 'ppMax', sfield: 'ppMax' },
    { label: 'Offense', dkey: 'offense', sfield: 'offense' },
    { label: 'Defense', dkey: 'defense', sfield: 'defense' },
    { label: 'Speed', dkey: 'speed', sfield: 'speed' },
    { label: 'Guts', dkey: 'guts', sfield: 'guts' },
    { label: 'Vitality', dkey: 'vitality', sfield: 'vitality' },
    { label: 'IQ', dkey: 'iq', sfield: 'iq' },
    { label: 'Luck', dkey: 'luck', sfield: 'luck' },
  ];
  const attrsBox = document.createElement('div');
  attrsBox.className = 'eb-lu-attrs';
  const renderAttrs = (alloc: Alloc) => {
    attrsBox.innerHTML = '';
    const d = deriveCombatStats(alloc);
    for (const a of ATTRS) {
      const cur = (currentStats[a.sfield] as number) ?? 0;
      const val = cur + (d[a.dkey] - baseDerived[a.dkey]);
      const delta = val - cur;
      const row = document.createElement('div');
      row.className = 'eb-lu-attr';
      row.appendChild(ebText(a.label, 2, '#9fb0d0'));
      const right = document.createElement('div');
      right.className = 'eb-lu-attrval';
      right.appendChild(ebText(String(val), 2, delta > 0 ? '#6fdc8c' : '#ffffff'));
      if (delta > 0) right.appendChild(ebText(`+${delta}`, 1, '#ffd23f'));
      row.appendChild(right);
      attrsBox.appendChild(row);
    }
  };

  const radar = createStatRadar(
    (a, l) => {
      setLeft(l);
      renderAttrs(a);
    },
    {
      initial,
      floor: initial, // can't un-spend what you already earned
      budget: points,
      displayMax: Math.max(10, maxVal + points),
      statMax: 99,
    }
  );
  panel.appendChild(radar.el);
  setLeft(points);

  panel.appendChild(center(ebText('IF YOU CONFIRM', 1, '#9fb0d0')));
  panel.appendChild(attrsBox);
  renderAttrs(initial); // seed the rows at the current build (no deltas yet)

  const confirm = ebButton('Confirm', () => {
    const cur = radar.getAlloc();
    const add: Record<string, number> = {};
    let total = 0;
    for (const k of STAT_KEYS) {
      const d = cur[k] - initial[k];
      if (d > 0) {
        add[k] = d;
        total += d;
      }
    }
    if (total > 0) onConfirm(add);
    close();
  });
  confirm.style.justifyContent = 'center';
  panel.appendChild(confirm);

  const cancel = ebButton('Later', () => close(), 2);
  cancel.style.justifyContent = 'center';
  panel.appendChild(cancel);

  document.body.appendChild(root);
}

function close(): void {
  openNow = false;
  if (root) {
    root.remove();
    root = null;
  }
}

function center(node: HTMLElement): HTMLElement {
  const d = document.createElement('div');
  d.className = 'eb-lu-center';
  d.appendChild(node);
  return d;
}

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const css = `
  .eb-lu-root {
    position: fixed; inset: 0; z-index: 1100;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.55); font-family: 'Courier New', monospace;
  }
  .eb-lu-panel {
    width: 460px; max-width: calc(100vw - 24px);
    display: flex; flex-direction: column; gap: 10px; padding: 20px;
  }
  .eb-lu-center, .eb-lu-left { display: flex; justify-content: center; }
  .eb-lu-center canvas, .eb-lu-left canvas { image-rendering: pixelated; }
  /* Derived-attribute preview: two columns of label : value rows, mirroring the
     Status screen. Boosted values render green with a gold "+N". */
  .eb-lu-attrs {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px;
    border-top: 1px solid #2a2a3e; margin-top: 2px; padding: 10px 4px 2px;
  }
  .eb-lu-attr { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .eb-lu-attr canvas { image-rendering: pixelated; }
  .eb-lu-attrval { display: flex; align-items: baseline; gap: 6px; }
  `;
  const style = document.createElement('style');
  style.id = 'eb-lu-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// Re-export for the caller's typing convenience.
export type { StatKey };
