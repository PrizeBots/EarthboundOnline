import manifest from '../data/sfxManifest.json';
import { playSfx, playSfxAt } from './MusicManager';

// SFX event wiring — maps game moments (attack, hurt, level-up, menu, purchase…)
// to a sound from the EarthBound SFX library. The catalogue below is the set of
// moments the engine fires; the assignment is admin-authored in the Sound
// Manager's SFX tab and persisted to overrides/sfx_events.json (OUR data,
// shippable — it only references sfx ids). playEventSfx() is called at each
// trigger site; reassigning a sound never touches code.
//
// Doors are deliberately NOT here: a door's sound is per-instance (Placement
// editor door tab), not one global sound for all doors.

export interface SfxEventDef {
  id: string;
  label: string;
  defaultSfx: string; // an id from sfxManifest
}

// Each entry must be wired with a playEventSfx('<id>') call at its real moment
// (see Game.ts / MenuManager.ts). Add a row here + a call site to wire a new one.
export const SFX_EVENTS: SfxEventDef[] = [
  { id: 'cursor-confirm', label: 'Cursor confirm', defaultSfx: 'cursor-confirm' },
  { id: 'cursor-horizontal', label: 'Cursor move (left/right)', defaultSfx: 'cursor-horizontal' },
  { id: 'cursor-vertical', label: 'Cursor move (up/down)', defaultSfx: 'cursor-vertical' },
  { id: 'player-attack', label: 'Player attack', defaultSfx: 'player-attack' },
  { id: 'player-hurt', label: 'Player hurt', defaultSfx: 'player-hurt' },
  { id: 'player-die', label: 'Player die', defaultSfx: 'player-die' },
  { id: 'enemy-die', label: 'Enemy die', defaultSfx: 'enemy-die' },
  // Crit/dodge system (server resolves; see npcSim resolveMelee). 'crit' fires
  // when YOUR swing lands a SMAAAASH; 'attack-miss' when YOUR swing whiffs;
  // 'player-dodge' when YOU evade an incoming attack.
  { id: 'crit', label: 'Critical hit (SMAAAASH)', defaultSfx: 'smaaaash' },
  { id: 'attack-miss', label: 'Attack missed', defaultSfx: 'just-missed-fell-over' },
  { id: 'player-dodge', label: 'Player dodged', defaultSfx: 'dodge' },
  { id: 'level-up', label: 'Level up', defaultSfx: 'maxed-out' },
  { id: 'menu-open', label: 'Menu open', defaultSfx: 'menu-open-and-close' },
  // EB reuses one "Menu open & close" sound; kept separate here so it can be
  // reassigned (e.g. a distinct close sound).
  { id: 'menu-close', label: 'Menu close', defaultSfx: 'menu-open-and-close' },
  { id: 'shop-purchase', label: 'Shop purchase', defaultSfx: 'purchase-item' },
  { id: 'shop-sell', label: 'Shop sell', defaultSfx: 'cash-register' },
  { id: 'equip', label: 'Equip item', defaultSfx: 'equip' },
];

const DEFAULTS: Record<string, string> = Object.fromEntries(
  SFX_EVENTS.map((e) => [e.id, e.defaultSfx])
);

const SFX_LABELS: Map<string, string> = new Map(
  (manifest as { id: string; label: string }[]).map((s) => [s.id, s.label])
);

// Admin overrides (overrides/sfx_events.json `{events:{eventId: sfxId}}`).
let overrides: Record<string, string> = {};

export interface SfxEventsFile {
  version?: number;
  events?: Record<string, string>;
}

/** Load the authored event→sfx map (falls back to defaults for unset events). */
export async function loadSfxEvents(): Promise<void> {
  try {
    const res = await fetch('/overrides/sfx_events.json', { cache: 'no-store' });
    overrides = res.ok ? (((await res.json()) as SfxEventsFile)?.events ?? {}) : {};
  } catch {
    overrides = {}; // none authored yet — pure defaults
  }
}

/** Live-replace the map (editor pushes its working set without a refetch). */
export function setSfxEventMap(map: Record<string, string>): void {
  overrides = { ...map };
}

/** The sfx id currently bound to an event (override wins, else the default). */
export function getSfxForEvent(eventId: string): string {
  return overrides[eventId] ?? DEFAULTS[eventId] ?? 'none';
}

/** Merged view (defaults + overrides) for the editor to render the current map. */
export function getSfxEventMap(): Record<string, string> {
  return { ...DEFAULTS, ...overrides };
}

/** Play the sound bound to a game event. No-op if it resolves to 'none'/missing. */
export function playEventSfx(eventId: string): void {
  playSfx(getSfxForEvent(eventId));
}

/**
 * Like playEventSfx but positional — gated + attenuated by distance from the
 * listener (player). Use for events that happen out in the world (enemy deaths,
 * remote players) so far-off sounds aren't heard.
 */
export function playEventSfxAt(eventId: string, x: number, y: number): void {
  playSfxAt(getSfxForEvent(eventId), x, y);
}

// --- SFX library helpers (shared by the Sound Manager SFX tab) ---------------

/** Every sound in the imported EB library, as {id, label}. */
export function listSfx(): { id: string; label: string }[] {
  return (manifest as { id: string; label: string }[]).map((s) => ({ id: s.id, label: s.label }));
}

/** Human label for a sfx id (falls back to the raw id). */
export function sfxLabel(id: string): string {
  return SFX_LABELS.get(id) ?? id;
}
