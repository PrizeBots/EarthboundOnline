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
import { createDerivedAttrs } from './charcreate/DerivedStatsPanel';

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
  // Map each derived stat to the Status-screen field it displays as (identity,
  // except maxHp shows as hpMax). The preview shows the current displayed value
  // plus the derivation delta, so per-level server growth cancels out.
  const currentStats: PlayerStats = { ...getStatus() };
  const baseDerived = deriveCombatStats(initial);
  const SFIELD: Record<keyof DerivedStats, keyof PlayerStats> = {
    maxHp: 'hpMax',
    ppMax: 'ppMax',
    offense: 'offense',
    defense: 'defense',
    speed: 'speed',
    guts: 'guts',
    vitality: 'vitality',
    iq: 'iq',
    luck: 'luck',
  };
  const attrs = createDerivedAttrs((dkey, d) => {
    const cur = (currentStats[SFIELD[dkey]] as number) ?? 0;
    const shown = cur + (d[dkey] - baseDerived[dkey]);
    return { shown, delta: shown - cur };
  });

  const radar = createStatRadar(
    (a, l) => {
      setLeft(l);
      attrs.render(a);
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
  panel.appendChild(attrs.el);
  attrs.render(initial); // seed the rows at the current build (no deltas yet)

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
  `;
  const style = document.createElement('style');
  style.id = 'eb-lu-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// Re-export for the caller's typing convenience.
export type { StatKey };
