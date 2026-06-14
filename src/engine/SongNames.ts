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

/** Every song we have a title for, ascending by number — feeds the dropdown. */
export function listSongs(): { song: number; name: string }[] {
  const seen = new Set<number>();
  for (const k of Object.keys(TABLE)) seen.add(Number(k));
  for (const k of Object.keys(overrides)) seen.add(Number(k));
  return [...seen]
    .sort((a, b) => a - b)
    .map((song) => ({ song, name: getSongName(song) ?? String(song) }));
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
