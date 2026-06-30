// Shared DOM primitives for editor tool panels (EDITOR_TOOLS.md).
//
// Every tool used to hand-roll its own identical button / row / input / select
// factories with copy-pasted `cssText` strings (≈480 of them across the editor).
// This module is the one place that look lives, so panels stay consistent and a
// new tool is cheap to build. These are PURE DOM builders — no tool state, no
// save logic, no undo. A tool wires the returned elements into its own field
// maps / command stack.
//
// Styling note: the colors here reproduce the existing per-tool styles exactly,
// so migrating a tool to the kit is a visual no-op. The editor chrome is
// deliberately UNLIKE the in-game EB windows (dev UI must never be mistaken for
// game UI) — keep it that way.

/** Shared field input style (text/number/select share the dark inset look). */
const FIELD =
  'font:11px monospace;background:#0c1014;color:#cde;border:1px solid #3a4a5a;border-radius:3px;';
const FIELD_PAD = 'padding:2px 5px;';

export type BtnVariant = 'default' | 'gold' | 'red' | 'green';

const BTN_VARIANTS: Record<BtnVariant, string> = {
  default: 'background:#1d2530;color:#cde;border:1px solid #3a4a5a;',
  gold: 'background:#3d2f14;color:#e8a33d;border:1px solid #e8a33d;',
  red: 'background:#3d1414;color:#e85050;border:1px solid #e85050;',
  green: 'background:#1f3a26;color:#9f9;border:1px solid #4a6;',
};

export interface ButtonOpts {
  /** Append the button to this element if given. */
  parent?: HTMLElement;
  /** Color scheme — `default` grey, or an accent (gold = primary, red = destructive, green = go). */
  variant?: BtnVariant;
  tip?: string;
  /** Override the default `2px 7px` padding (e.g. `4px 8px` for dock tabs). */
  pad?: string;
}

/** A small editor button. Matches the per-tool `mkBtn` look across the editor. */
export function mkButton(
  label: string,
  onClick: () => void,
  opts: ButtonOpts = {}
): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    `font:11px monospace;padding:${opts.pad ?? '2px 7px'};cursor:pointer;border-radius:3px;` +
    BTN_VARIANTS[opts.variant ?? 'default'];
  if (opts.tip) b.title = opts.tip;
  b.onclick = onClick;
  opts.parent?.appendChild(b);
  return b;
}

export interface RowOpts {
  tip?: string;
  /** Label column width in px (compact tools use 46, stat managers use 56). */
  labelWidth?: number;
}

/**
 * A horizontal label+content row, appended to `parent`. Returns the row so the
 * caller appends the field (input/select/etc.). Pass an empty `label` for a
 * bare flex row with no label cell.
 */
export function mkRow(parent: HTMLElement, label: string, opts: RowOpts = {}): HTMLDivElement {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;align-items:center;gap:6px;';
  if (label) {
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText =
      `width:${opts.labelWidth ?? 46}px;color:#9fb8cc;` +
      (opts.tip ? 'cursor:help;border-bottom:1px dotted #4a5a6a;' : '');
    if (opts.tip) l.title = opts.tip;
    r.appendChild(l);
  }
  parent.appendChild(r);
  return r;
}

export interface TextInputOpts {
  value?: string;
  placeholder?: string;
  /** Fixed px width (ignored when `flex` is set). Default 64. */
  width?: number;
  /** Grow to fill the row (`flex:1;min-width:0`) instead of a fixed width. */
  flex?: boolean;
  maxLength?: number;
  tip?: string;
  onChange?: (v: string, el: HTMLInputElement) => void;
}

/** A text input matching the editor field look. */
export function mkTextInput(opts: TextInputOpts = {}): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  if (opts.value != null) i.value = opts.value;
  if (opts.placeholder != null) i.placeholder = opts.placeholder;
  if (opts.maxLength != null) i.maxLength = opts.maxLength;
  if (opts.tip) i.title = opts.tip;
  i.style.cssText =
    (opts.flex ? 'flex:1;min-width:0;' : `width:${opts.width ?? 64}px;`) + FIELD + FIELD_PAD;
  if (opts.onChange) i.onchange = () => opts.onChange!(i.value, i);
  return i;
}

export interface NumberInputOpts {
  value?: number;
  /** Placeholder shown when empty — typically the inherited/base value. */
  placeholder?: number | string;
  width?: number;
  flex?: boolean;
  min?: number;
  max?: number;
  /** Allow fractional values (parseFloat) instead of integers (parseInt). */
  float?: boolean;
  tip?: string;
  /** Fires with the clamped number, or `undefined` when the field is cleared. */
  onChange?: (v: number | undefined, el: HTMLInputElement) => void;
}

/**
 * A number input that clamps to [min,max] on change and reports `undefined`
 * when cleared (the "blank = inherit the base" idiom the stat managers use).
 */
export function mkNumberInput(opts: NumberInputOpts = {}): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  if (opts.value != null) i.value = String(opts.value);
  if (opts.placeholder != null) i.placeholder = String(opts.placeholder);
  if (opts.tip) i.title = opts.tip;
  i.style.cssText =
    (opts.flex ? 'flex:1;min-width:0;' : `width:${opts.width ?? 72}px;`) + FIELD + FIELD_PAD;
  if (opts.onChange) {
    i.onchange = () => {
      const raw = i.value.trim();
      if (raw === '') {
        opts.onChange!(undefined, i);
        return;
      }
      let n = opts.float ? parseFloat(raw) : parseInt(raw, 10);
      if (Number.isNaN(n)) {
        i.value = '';
        opts.onChange!(undefined, i);
        return;
      }
      if (opts.min != null) n = Math.max(opts.min, n);
      if (opts.max != null) n = Math.min(opts.max, n);
      i.value = String(n);
      opts.onChange!(n, i);
    };
  }
  return i;
}

export interface SelectOpts {
  value?: string;
  flex?: boolean;
  tip?: string;
  onChange?: (v: string, el: HTMLSelectElement) => void;
}

/** A dropdown from `{value,label}` options, with `value` preselected. */
export function mkSelect(
  options: { value: string; label: string }[],
  opts: SelectOpts = {}
): HTMLSelectElement {
  const s = document.createElement('select');
  s.style.cssText = (opts.flex ? 'flex:1;min-width:0;' : '') + FIELD + 'padding:2px 4px;';
  if (opts.tip) s.title = opts.tip;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === opts.value) opt.selected = true;
    s.appendChild(opt);
  }
  if (opts.onChange) s.onchange = () => opts.onChange!(s.value, s);
  return s;
}

/** A checkbox with the editor's pointer cursor. */
export function mkCheckbox(
  checked: boolean,
  onChange: (v: boolean, el: HTMLInputElement) => void,
  tip?: string
): HTMLInputElement {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  if (tip) cb.title = tip;
  cb.style.cursor = 'pointer';
  cb.onchange = () => onChange(cb.checked, cb);
  return cb;
}

// --- composite label+field rows (the list+form managers' bread and butter) ---

/** A labelled text input row. Returns the input. */
export function textRow(
  parent: HTMLElement,
  label: string,
  opts: TextInputOpts & RowOpts = {}
): HTMLInputElement {
  const i = mkTextInput(opts);
  mkRow(parent, label, opts).appendChild(i);
  return i;
}

/** A labelled number input row. Returns the input. */
export function numberRow(
  parent: HTMLElement,
  label: string,
  opts: NumberInputOpts & RowOpts = {}
): HTMLInputElement {
  const i = mkNumberInput(opts);
  mkRow(parent, label, opts).appendChild(i);
  return i;
}

/** A labelled dropdown row. Returns the select. */
export function selectRow(
  parent: HTMLElement,
  label: string,
  options: { value: string; label: string }[],
  opts: SelectOpts & RowOpts = {}
): HTMLSelectElement {
  const s = mkSelect(options, opts);
  mkRow(parent, label, opts).appendChild(s);
  return s;
}

/** A labelled checkbox row. Returns the checkbox. */
export function checkRow(
  parent: HTMLElement,
  label: string,
  checked: boolean,
  onChange: (v: boolean, el: HTMLInputElement) => void,
  opts: RowOpts = {}
): HTMLInputElement {
  const cb = mkCheckbox(checked, onChange, opts.tip);
  mkRow(parent, label, opts).appendChild(cb);
  return cb;
}
