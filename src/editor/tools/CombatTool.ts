import { EditorTool, EditorShellApi } from '../types';
import { registerSaveHandler } from '../registry';
import { saveOverride } from '../saveOverride';
import {
  CombatJuice,
  getCombatJuice,
  setCombatJuice,
  resetCombatJuice,
} from '../../engine/CombatJuice';
import {
  spawnDamageNumber,
  spawnOwnDamageNumber,
  spawnHealNumber,
  spawnCritText,
  spawnMissText,
} from '../../engine/Emitter';

// Combat tool — live dials for the FEEL of floating combat numbers (size, arc,
// lifetime, crit burst, colors). Every change pushes through setCombatJuice so
// the running game reflects it instantly; the Test buttons fire sample popups at
// the editor camera so you can tune without fighting. Persists to
// overrides/combat_juice.json (numbers/colors only — no ROM content, no combat
// MATH; damage/crit rolls/knockback stay server-authoritative in npcSim).

// One numeric slider. `key` indexes the CombatJuice number fields.
interface NumDial {
  key: keyof CombatJuice;
  label: string;
  min: number;
  max: number;
  step: number;
  group: string;
}

const NUM_DIALS: NumDial[] = [
  // Number size (magnitude scaling): min at 1 dmg → max at the cap value
  { key: 'numScaleMin', label: 'min size', min: 0.3, max: 2, step: 0.05, group: 'Number size' },
  { key: 'numScaleMax', label: 'max size', min: 1, max: 4, step: 0.05, group: 'Number size' },
  { key: 'numScaleCap', label: 'max at dmg', min: 50, max: 9999, step: 1, group: 'Number size' },
  // Motion (arc launch + fall + fade)
  { key: 'launchVy', label: 'pop-up speed', min: 0, max: 300, step: 5, group: 'Motion' },
  { key: 'gravity', label: 'gravity', min: 0, max: 1200, step: 20, group: 'Motion' },
  { key: 'launchVx', label: 'h. spread', min: 0, max: 120, step: 5, group: 'Motion' },
  { key: 'spawnJitter', label: 'spawn jitter', min: 0, max: 20, step: 1, group: 'Motion' },
  { key: 'lifetime', label: 'lifetime ms', min: 300, max: 2000, step: 50, group: 'Motion' },
  { key: 'fade', label: 'fade ms', min: 50, max: 1000, step: 25, group: 'Motion' },
  // Crit burst (SMAAAASH!)
  { key: 'critScaleFrom', label: 'start size', min: 0.2, max: 2, step: 0.05, group: 'Crit burst' },
  { key: 'critScaleTo', label: 'climax size', min: 1, max: 4, step: 0.05, group: 'Crit burst' },
  { key: 'critLife', label: 'life ms', min: 400, max: 2500, step: 50, group: 'Crit burst' },
  // Heal float (rise + sine sway + fade)
  { key: 'healRise', label: 'rise speed', min: 0, max: 80, step: 2, group: 'Heal float' },
  { key: 'healWobbleAmp', label: 'sway px', min: 0, max: 24, step: 1, group: 'Heal float' },
  { key: 'healWobbleHz', label: 'sway speed', min: 0, max: 5, step: 0.1, group: 'Heal float' },
  { key: 'healLife', label: 'life ms', min: 400, max: 2500, step: 50, group: 'Heal float' },
  // Big-hit color ramp
  {
    key: 'bigHitThreshold',
    label: 'big-hit at dmg',
    min: 1,
    max: 99,
    step: 1,
    group: 'Big-hit ramp',
  },
];

const COLOR_DIALS: { key: keyof CombatJuice; label: string }[] = [
  { key: 'colDamage', label: 'damage' },
  { key: 'colOwnDamage', label: 'your hurt' },
  { key: 'colHeal', label: 'heal' },
  { key: 'colCrit', label: 'crit text' },
  { key: 'colMiss', label: 'miss' },
  { key: 'colBigHit', label: 'big-hit ramp' },
];

// Group display order (matches the NUM_DIALS groups; colors render last).
const GROUP_ORDER = ['Number size', 'Motion', 'Crit burst', 'Heal float', 'Big-hit ramp'];

class CombatTool implements EditorTool {
  id = 'combat';
  name = 'Combat';
  description = 'Tune the feel of floating damage/heal/crit numbers — size, arc, color.';
  status = 'ready' as const;

  private shell: EditorShellApi | null = null;
  private panel: HTMLDivElement | null = null;
  // Working copy of the juice values; pushed live to CombatJuice on every edit.
  private juice: CombatJuice = { ...getCombatJuice() };
  // Live readouts to refresh when Reset rewrites every value at once.
  private readouts = new Map<keyof CombatJuice, HTMLSpanElement>();
  private controls = new Map<keyof CombatJuice, HTMLInputElement>();

  activate(shell: EditorShellApi): void {
    this.shell = shell;
    this.juice = { ...getCombatJuice() }; // start from the currently-active values
    registerSaveHandler('combat_juice', () => this.save());
    this.buildPanel();
  }

  deactivate(): void {
    this.panel?.remove();
    this.panel = null;
    this.readouts.clear();
    this.controls.clear();
  }

  // --- live apply / persist --------------------------------------------------

  /** Push the working copy into the running game and flag a save. */
  private apply(): void {
    setCombatJuice(this.juice);
    this.shell?.markDirty('combat_juice');
  }

  private async save(): Promise<void> {
    await saveOverride('combat_juice.json', { version: 1, juice: this.juice });
    setCombatJuice(this.juice);
    this.shell?.clearDirty('combat_juice');
    this.shell?.toast('Saved combat feel — live here; other clients refresh to resync');
  }

  // --- test popups -----------------------------------------------------------

  /** World point at the center of the editor's current view (where tests appear). */
  private testPoint(): { x: number; y: number } {
    const c = this.shell!.context.camera;
    return { x: c.x + c.viewW / 2, y: c.y + c.viewH / 2 };
  }

  private testVolley(): void {
    const { x, y } = this.testPoint();
    // A spread across orders of magnitude (incl. the 9999 cap) at offset x's so
    // you can see min→max sizing at a glance and they don't stack into one blob.
    spawnDamageNumber(x - 64, y, 5);
    spawnDamageNumber(x - 34, y, 75);
    spawnDamageNumber(x, y, 999);
    spawnDamageNumber(x + 44, y, 9999);
    spawnHealNumber(x + 88, y, 50);
  }

  private testCrit(): void {
    const { x, y } = this.testPoint();
    spawnCritText(x, y);
    spawnDamageNumber(x, y, 52); // the big number a crit lands alongside the burst
  }

  // --- panel -----------------------------------------------------------------

  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'width:100%;box-sizing:border-box;background:#101418f2;' +
      'color:#cde;font:12px monospace;border:1px solid #e8794a;border-radius:5px;' +
      'padding:10px;display:flex;flex-direction:column;gap:7px;user-select:none;';
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.textContent = 'COMBAT FEEL';
    title.style.cssText = 'color:#e8794a;font-weight:bold;letter-spacing:1px;flex:1;';
    header.appendChild(title);
    this.mkBtn('Reset', () => this.resetAll(), header, true);
    this.panel.appendChild(header);

    const sub = document.createElement('div');
    sub.textContent = 'Tune floating damage/heal/crit numbers. Changes apply live + auto-save.';
    sub.style.cssText = 'color:#9fb8cc;font-size:10px;';
    this.panel.appendChild(sub);

    // Test buttons — fire sample popups at the camera center.
    const tests = document.createElement('div');
    tests.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';
    this.mkBtn('▶ Hits', () => this.testVolley(), tests);
    this.mkBtn('▶ Crit', () => this.testCrit(), tests);
    this.mkBtn(
      '▶ Heal',
      () => {
        const p = this.testPoint();
        spawnHealNumber(p.x, p.y, 30);
      },
      tests
    );
    this.mkBtn(
      '▶ Your hurt',
      () => {
        const p = this.testPoint();
        spawnOwnDamageNumber(p.x, p.y, 18);
      },
      tests
    );
    this.mkBtn(
      '▶ Miss',
      () => {
        const p = this.testPoint();
        spawnMissText(p.x, p.y);
      },
      tests
    );
    this.panel.appendChild(tests);

    // Numeric dials, grouped.
    for (const group of GROUP_ORDER) {
      this.panel.appendChild(this.mkGroupHeader(group));
      if (group === 'Big-hit ramp') this.panel.appendChild(this.mkBigHitToggle());
      for (const d of NUM_DIALS.filter((x) => x.group === group)) this.mkSlider(d);
    }

    // Colors.
    this.panel.appendChild(this.mkGroupHeader('Colors'));
    for (const c of COLOR_DIALS) this.mkColor(c.key, c.label);

    this.shell!.panelHost.appendChild(this.panel);
  }

  private resetAll(): void {
    resetCombatJuice();
    this.juice = { ...getCombatJuice() };
    // Re-sync every control + readout to the restored defaults.
    for (const d of NUM_DIALS) {
      const v = this.juice[d.key] as number;
      const ctrl = this.controls.get(d.key);
      const ro = this.readouts.get(d.key);
      if (ctrl) ctrl.value = String(v);
      if (ro) ro.textContent = this.fmt(v, d.step);
    }
    for (const c of COLOR_DIALS) {
      const ctrl = this.controls.get(c.key);
      if (ctrl) ctrl.value = this.juice[c.key] as string;
    }
    const ramp = this.controls.get('bigHitRamp');
    if (ramp) ramp.checked = this.juice.bigHitRamp;
    this.shell?.markDirty('combat_juice');
    this.shell?.toast('Reset combat feel to defaults');
  }

  // --- control builders ------------------------------------------------------

  private mkGroupHeader(text: string): HTMLDivElement {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText =
      'color:#e8a07a;font-size:10px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;' +
      'border-top:1px solid #2a3540;padding-top:6px;margin-top:2px;';
    return h;
  }

  private mkSlider(d: NumDial): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const label = document.createElement('span');
    label.textContent = d.label;
    label.style.cssText = 'width:92px;flex:none;color:#9fb8cc;font-size:11px;';
    row.appendChild(label);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(d.min);
    slider.max = String(d.max);
    slider.step = String(d.step);
    slider.value = String(this.juice[d.key] as number);
    slider.style.cssText = 'flex:1;min-width:0;accent-color:#e8794a;cursor:pointer;';

    const readout = document.createElement('span');
    readout.textContent = this.fmt(this.juice[d.key] as number, d.step);
    readout.style.cssText =
      'width:46px;flex:none;text-align:right;color:#cde;font-size:11px;font-variant-numeric:tabular-nums;';

    slider.oninput = () => {
      const n = parseFloat(slider.value);
      (this.juice[d.key] as number) = n;
      readout.textContent = this.fmt(n, d.step);
      this.apply();
    };
    row.append(slider, readout);
    this.panel!.appendChild(row);
    this.controls.set(d.key, slider);
    this.readouts.set(d.key, readout);
  }

  private mkBigHitToggle(): HTMLLabelElement {
    const row = document.createElement('label');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;color:#9fb8cc;font-size:11px;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.juice.bigHitRamp;
    cb.onchange = () => {
      this.juice.bigHitRamp = cb.checked;
      this.apply();
    };
    row.append(cb, document.createTextNode('ramp big hits toward big-hit color'));
    this.controls.set('bigHitRamp', cb);
    return row;
  }

  private mkColor(key: keyof CombatJuice, label: string): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'width:92px;flex:none;color:#9fb8cc;font-size:11px;';
    row.appendChild(lbl);

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = this.juice[key] as string;
    picker.style.cssText =
      'width:34px;height:20px;flex:none;background:#0c1014;border:1px solid #3a4a5a;' +
      'border-radius:3px;padding:0;cursor:pointer;';
    const hex = document.createElement('span');
    hex.textContent = this.juice[key] as string;
    hex.style.cssText = 'color:#8aa;font-size:10px;';
    picker.oninput = () => {
      (this.juice[key] as string) = picker.value;
      hex.textContent = picker.value;
      this.apply();
    };
    row.append(picker, hex);
    this.panel!.appendChild(row);
    this.controls.set(key, picker);
  }

  /** Format a readout: integers for whole steps, else fixed decimals. */
  private fmt(v: number, step: number): string {
    return step >= 1 ? String(Math.round(v)) : v.toFixed(2);
  }

  private mkBtn(
    label: string,
    fn: () => void,
    parent: HTMLElement,
    accent = false
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:11px monospace;padding:2px 8px;cursor:pointer;border-radius:3px;' +
      (accent
        ? 'background:#3a1e12;color:#e8794a;border:1px solid #e8794a;'
        : 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;');
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }
}

export const combatTool = new CombatTool();
