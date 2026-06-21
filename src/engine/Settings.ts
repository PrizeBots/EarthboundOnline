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

export type SettingKey = 'bgm' | 'sfx' | 'showMoney';

/** One row of the Settings screen, shared by layout/render/input so they never
 *  drift. `slider` rows are 0..1 floats; `toggle` rows are booleans. */
export interface SettingRow {
  key: SettingKey;
  label: string;
  kind: 'slider' | 'toggle';
}
export const SETTINGS_ROWS: SettingRow[] = [
  { key: 'bgm', label: 'BGM Volume', kind: 'slider' },
  { key: 'sfx', label: 'Sound FX', kind: 'slider' },
  { key: 'showMoney', label: 'Show $ in corner', kind: 'toggle' },
];

interface SettingsState {
  bgm: number; // 0..1
  sfx: number; // 0..1
  showMoney: boolean;
}

const DEFAULTS: SettingsState = { bgm: 0.5, sfx: 0.7, showMoney: false };

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<SettingsState>;
    return {
      bgm: clamp01(typeof p.bgm === 'number' ? p.bgm : DEFAULTS.bgm),
      sfx: clamp01(typeof p.sfx === 'number' ? p.sfx : DEFAULTS.sfx),
      showMoney: p.showMoney === true,
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
