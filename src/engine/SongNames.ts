import names from '../data/songNames.json';
import { loadJSON } from './AssetLoader';

// Display names for SPC song numbers (src/data/songNames.json — OUR authored
// metadata, shippable). EarthBound addresses music by song NUMBER; the baked
// table pairs each number with the real track title (extracted from the SPC
// ID666 tags by tools/extract_song_names.py). Admin renames live in
// public/overrides/song_names.json (authored in the Sound Manager) and win over
// the baked table — both ship. Mirrors SpriteNames.ts.

const TABLE = names as Record<string, string>;
let overrides: Record<string, string> = {};

export interface SongNameOverrides {
  version: number;
  names?: Record<string, string>;
}

/** Load admin renames; call once at startup (404 -> none). */
export async function loadSongNameOverrides(): Promise<void> {
  try {
    const ov = await loadJSON<SongNameOverrides>('/overrides/song_names.json');
    overrides = ov.names ?? {};
  } catch {
    overrides = {};
  }
}

/** Title for a song number, or null if we have none baked/overridden. */
export function getSongName(song: number): string | null {
  return overrides[String(song)] ?? TABLE[String(song)] ?? null;
}

/** Friendly label for menus: "29 · Onett Night 1" (or just the number). */
export function songLabel(song: number): string {
  const name = getSongName(song);
  return name ? `${song} · ${name}` : `${song}`;
}

/**
 * Songs for the Sound Manager dropdown, ascending by number, DEDUPED BY TITLE.
 * EarthBound has many song slots that share one tune (different music packs
 * reference the same track), so the raw table lists e.g. "Pokey's House" 3x and
 * "Sound Stone ~ Giant Step" 8x. We collapse each title to its lowest-numbered
 * slot so the picker isn't bloated with ~60 duplicate rows. An already-assigned
 * non-canonical slot still DISPLAYS fine (songLabel resolves any id); it just
 * isn't offered as a fresh choice. Untitled slots fall back to their number and
 * stay distinct. Admin renames make a slot unique, so renamed dupes reappear.
 */
export function listSongs(): { song: number; name: string }[] {
  const seen = new Set<number>();
  for (const k of Object.keys(TABLE)) seen.add(Number(k));
  for (const k of Object.keys(overrides)) seen.add(Number(k));
  const takenTitles = new Set<string>();
  const out: { song: number; name: string }[] = [];
  for (const song of [...seen].sort((a, b) => a - b)) {
    const name = getSongName(song) ?? String(song);
    const key = name.toLowerCase();
    if (takenTitles.has(key)) continue; // duplicate tune — keep the lowest slot
    takenTitles.add(key);
    out.push({ song, name });
  }
  return out;
}

/** Editor rename: empty/identical-to-base names clear the override. */
export function setSongNameOverride(song: number, name: string | null): void {
  const key = String(song);
  if (!name || name === TABLE[key]) delete overrides[key];
  else overrides[key] = name;
}

export function getSongNameOverrides(): SongNameOverrides {
  return { version: 1, names: overrides };
}
