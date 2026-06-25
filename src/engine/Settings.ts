/**
 * Settings.ts — player-tunable client options, persisted to localStorage.
 *
 * Pure UI/QoL prefs that live only in the browser (the multiplayer server never
 * sees them): audio volumes and HUD toggles. The Settings screen in the player
 * menu reads/writes these; MenuManager + Game read them to drive audio + the
 * always-on money window. Code-only, so it ports cleanly and never touches ROM
 * data. Keep the row table here so layout/render/input share one source.
 */
import { setMusicVolume, getMusicVolume, setSfxVolume, getSfxVolume } from './MusicManager';

const STORAGE_KEY = 'eb_settings';
export const SLIDER_STEP = 0.1; // ±/click granularity for the volume sliders

export type SettingKey =
  | 'bgm'
  | 'sfx'
  | 'showMoney'
  | 'crosshairColor'
  | 'crosshairType'
  | 'cursorSize';

// Crosshair cursor choices (see Aim.drawReticle). `option` rows cycle through
// these labels; the index is what's stored. COLOR_CSS maps a color label to its
// CSS value (kept here so Settings owns the whole option table).
export const CROSSHAIR_COLORS = ['White', 'Black', 'Red', 'Green'] as const;
export const CROSSHAIR_TYPES = ['Cross', 'Dot', 'Scope'] as const;
// Pointer-glove size (see Aim.gloveCursor). Each label maps to an upscale factor
// on the 13×16 art; final px = factor × 16 tall, all within the 128px cursor cap.
// Mouse-only — touch devices never show a cursor, so this is desktop QoL.
export const CURSOR_SIZES = ['Small', 'Medium', 'Large'] as const;
const CURSOR_SCALES = [2, 3, 4]; // px-per-art-pixel for Small/Medium/Large
const COLOR_CSS: Record<string, string> = {
  White: '#ffffff',
  Black: '#000000',
  Red: '#ff4040',
  Green: '#40e060',
};

/** One row of the Settings screen, shared by layout/render/input so they never
 *  drift. `slider` rows are 0..1 floats; `toggle` rows are booleans; `option` rows
 *  cycle a labeled list (←/→ or click), storing the selected index. */
export interface SettingRow {
  key: SettingKey;
  label: string;
  kind: 'slider' | 'toggle' | 'option';
}
export const SETTINGS_ROWS: SettingRow[] = [
  { key: 'bgm', label: 'BGM Volume', kind: 'slider' },
  { key: 'sfx', label: 'Sound FX', kind: 'slider' },
  { key: 'showMoney', label: 'Show $ in corner', kind: 'toggle' },
  { key: 'crosshairColor', label: 'Crosshair Color', kind: 'option' },
  { key: 'crosshairType', label: 'Crosshair Style', kind: 'option' },
  { key: 'cursorSize', label: 'Cursor Size', kind: 'option' },
];

// The choice list backing each `option` row.
const OPTION_LISTS: Partial<Record<SettingKey, readonly string[]>> = {
  crosshairColor: CROSSHAIR_COLORS,
  crosshairType: CROSSHAIR_TYPES,
  cursorSize: CURSOR_SIZES,
};

interface SettingsState {
  bgm: number; // 0..1
  sfx: number; // 0..1
  showMoney: boolean;
  crosshairColor: number; // index into CROSSHAIR_COLORS
  crosshairType: number; // index into CROSSHAIR_TYPES
  cursorSize: number; // index into CURSOR_SIZES
}

const DEFAULTS: SettingsState = {
  bgm: 0.5,
  sfx: 0.7,
  showMoney: false,
  crosshairColor: 0,
  crosshairType: 0,
  cursorSize: 1, // Medium
};

const wrapIdx = (i: number, n: number): number => ((i % n) + n) % n;
const clampIdx = (v: unknown, n: number): number =>
  typeof v === 'number' && v >= 0 && v < n ? Math.floor(v) : 0;

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<SettingsState>;
    return {
      bgm: clamp01(typeof p.bgm === 'number' ? p.bgm : DEFAULTS.bgm),
      sfx: clamp01(typeof p.sfx === 'number' ? p.sfx : DEFAULTS.sfx),
      showMoney: p.showMoney === true,
      crosshairColor: clampIdx(p.crosshairColor, CROSSHAIR_COLORS.length),
      crosshairType: clampIdx(p.crosshairType, CROSSHAIR_TYPES.length),
      cursorSize: clampIdx(p.cursorSize, CURSOR_SIZES.length),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const state: SettingsState = load();

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — settings just won't persist this session */
  }
}

/** Push the saved volumes into the audio engine. Safe to call before the audio
 *  context exists (the setters stash the value and apply it once it's up). Call
 *  once at startup. */
export function initSettings(): void {
  setMusicVolume(state.bgm);
  setSfxVolume(state.sfx);
}

/** True when the player wants the $ window pinned to the corner during play. */
export function showMoneyAlways(): boolean {
  return state.showMoney;
}

/** A slider row's current value (0..1). bgm/sfx read live from the audio engine
 *  so the bar matches what's actually playing even if something else nudged it. */
export function getSlider(key: SettingKey): number {
  if (key === 'bgm') return getMusicVolume();
  if (key === 'sfx') return getSfxVolume();
  return 0;
}

/** A toggle row's current value. */
export function getToggle(key: SettingKey): boolean {
  if (key === 'showMoney') return state.showMoney;
  return false;
}

/** Nudge a slider by `dir` steps (±1) and apply + persist. */
export function adjustSlider(key: SettingKey, dir: number): void {
  const next = clamp01(getSlider(key) + dir * SLIDER_STEP);
  if (key === 'bgm') {
    state.bgm = next;
    setMusicVolume(next);
  } else if (key === 'sfx') {
    state.sfx = next;
    setSfxVolume(next);
  }
  persist();
}

/** Flip a toggle row and persist. */
export function flipToggle(key: SettingKey): void {
  if (key === 'showMoney') state.showMoney = !state.showMoney;
  persist();
}

// Current stored index for an `option` row (0 if it's not an option key).
function optionIndex(key: SettingKey): number {
  switch (key) {
    case 'crosshairColor':
      return state.crosshairColor;
    case 'crosshairType':
      return state.crosshairType;
    case 'cursorSize':
      return state.cursorSize;
    default:
      return 0;
  }
}

/** An option row's current choice label (shown right-aligned on the row). */
export function getOptionLabel(key: SettingKey): string {
  const list = OPTION_LISTS[key];
  if (!list) return '';
  return list[optionIndex(key)] ?? list[0];
}

/** Cycle an option row by `dir` (±1, wrapping) and persist. */
export function cycleOption(key: SettingKey, dir: number): void {
  const list = OPTION_LISTS[key];
  if (!list) return;
  const next = wrapIdx(optionIndex(key) + dir, list.length);
  if (key === 'crosshairColor') state.crosshairColor = next;
  else if (key === 'crosshairType') state.crosshairType = next;
  else if (key === 'cursorSize') state.cursorSize = next;
  persist();
}

/** The crosshair's CSS color (from the chosen color option). */
export function getCrosshairColor(): string {
  return COLOR_CSS[CROSSHAIR_COLORS[state.crosshairColor]] ?? '#ffffff';
}

/** The crosshair style index (0 = Cross, 1 = Dot, 2 = Scope). */
export function getCrosshairType(): number {
  return state.crosshairType;
}

/** Upscale factor for the pointer glove (from the chosen Cursor Size). */
export function getCursorScale(): number {
  return CURSOR_SCALES[state.cursorSize] ?? CURSOR_SCALES[1];
}
