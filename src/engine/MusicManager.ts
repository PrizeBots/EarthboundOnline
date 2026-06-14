import { loadJSON } from './AssetLoader';
import { getSector } from './MapManager';
import {
  SECTOR_TILES_X,
  SECTOR_TILES_Y,
  TILE_SIZE,
} from '../types';

// asm.js SPC engine globals (loaded via <script> tag)
declare function _my_init(spcPtr: number, length: number): void;
declare function _my_decode(bufPtr: number, samples: number): void;
declare function allocate(data: number[] | Uint8Array, type: string, alloc: number): number;
declare function _malloc(size: number): number;
declare const HEAP16: Int16Array;
declare const HEAPU8: Uint8Array;
declare const ALLOC_STACK: number;
declare const ALLOC_NORMAL: number;

// musicId -> default song number
let musicMap: Record<string, number> = {};

// Authored music regions (overrides/music.json) — OUR data layer, applied over
// the ROM's per-sector musicId. EarthBound assigns music per sector, but the
// door-stitched open world leaves many sectors with the wrong (intro-state or
// neighbouring) musicId, so the wrong song plays. A rectangular area here wins
// over the sector lookup for any point inside it. Ships like other overrides;
// on SNES these bake back down to per-sector musicId.
export interface MusicArea {
  name: string;
  x: number; y: number; w: number; h: number; // world pixels
  song: number;                                // SPC song number (what plays)
}
let musicAreas: MusicArea[] = [];

export async function loadMusicAreas(): Promise<void> {
  try {
    const res = await fetch('/overrides/music.json', { cache: 'no-store' });
    musicAreas = res.ok ? ((await res.json())?.areas ?? []) : [];
    console.log(`Music areas loaded: ${musicAreas.length}`);
  } catch {
    musicAreas = []; // none authored yet — pure sector fallback
  }
}

/** Live-replace the areas (editor pushes its working set without a refetch). */
export function setMusicAreas(areas: MusicArea[]): void {
  musicAreas = areas.slice();
  lastLoggedSong = -2; // force the next updateMusic to re-evaluate + log
}

/** Song number for a world point from the authored areas, or -1 if none. */
function songForPoint(x: number, y: number): number {
  // Last matching area wins — later entries are drawn on top / authored later.
  for (let i = musicAreas.length - 1; i >= 0; i--) {
    const a = musicAreas[i];
    if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a.song;
  }
  return -1;
}

// Cached SPC file data
const spcCache = new Map<number, Uint8Array>();
const spcLoading = new Set<number>();

// Custom audio tracks (MP3/OGG for ESP32-side music on hardware)
const customAudioCache = new Map<string, HTMLAudioElement>();

let currentSongNumber = -1;
let currentCustomTrack: HTMLAudioElement | null = null;
let initialized = false;
let audioContext: AudioContext | null = null;
let audioNode: ScriptProcessorNode | null = null;
let gainNode: GainNode | null = null;
let volume = 0.5;
let muted = false;

// SPC decode state
let bufPtr = 0;
let frameSize = 16384;
let ratio = 1;
let lastSample = 0;

export async function loadMusicMap(): Promise<void> {
  musicMap = await loadJSON<Record<string, number>>('/assets/music/music_map.json');
  console.log(`Music map loaded: ${Object.keys(musicMap).length} entries`);
}

/**
 * Initialize the SPC audio engine. Must be called from a user gesture.
 */
export function initMusic(): void {
  if (initialized) return;

  // Check if asm.js engine is loaded
  if (typeof _my_init !== 'function') {
    console.warn('SPC engine not loaded');
    return;
  }

  try {
    audioContext = new AudioContext();
    // Chrome may start AudioContext in suspended state even from a user gesture
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    gainNode = audioContext.createGain();
    gainNode.gain.value = muted ? 0 : volume;
    gainNode.connect(audioContext.destination);

    // Set up resampling params (SPC outputs at 32kHz)
    const inRate = 32000;
    const outRate = audioContext.sampleRate;
    ratio = inRate / outRate;
    lastSample = 1 + Math.floor(frameSize * ratio);
    const bufSize = 4 * (lastSample - 1);
    bufPtr = _malloc(bufSize + 4);

    initialized = true;
    console.log(`SPC music engine initialized (${outRate}Hz output)`);
  } catch (e) {
    console.warn('Failed to init SPC engine:', e);
  }
}

function startAudioNode(): void {
  if (!audioContext || !gainNode) return;

  // Keep ONE persistent node: it decodes whatever song the SPC engine currently
  // holds, so switching tracks is just a `_my_init` — no node teardown. Tearing
  // down + rebuilding on every change can drop audio when switching while a song
  // is already playing (the editor's Test against live game music hit this).
  if (audioNode) return;

  audioNode = audioContext.createScriptProcessor(frameSize, 0, 2);
  audioNode.onaudioprocess = (e) => {
    _my_decode(bufPtr, lastSample * 2);
    const outputBuffer = e.outputBuffer;
    for (let chan = 0; chan < outputBuffer.numberOfChannels; chan++) {
      const outData = outputBuffer.getChannelData(chan);
      const chanOffset = chan;
      for (let k = 0; k < outData.length; k++) {
        const offset = ratio * k;
        const bufferOffset = Math.floor(offset);
        const high = offset - bufferOffset;
        const low = 1 - high;
        const lowVal = HEAP16[chanOffset + bufPtr / 2 + bufferOffset * 2] * low;
        const highVal = HEAP16[chanOffset + bufPtr / 2 + (bufferOffset + 1) * 2] * high;
        outData[k] = (lowVal + highVal) / 32000;
      }
    }
  };
  audioNode.connect(gainNode);
}

async function loadSPC(songNumber: number): Promise<Uint8Array | null> {
  if (spcCache.has(songNumber)) return spcCache.get(songNumber)!;
  if (spcLoading.has(songNumber)) return null;

  spcLoading.add(songNumber);
  try {
    const filename = `eb-${String(songNumber).padStart(3, '0')}.spc`;
    const resp = await fetch(`/assets/music/spc/${filename}`);
    if (!resp.ok) return null;
    const buffer = new Uint8Array(await resp.arrayBuffer());
    // SPC files start with "SNES-SPC700"
    const header = String.fromCharCode(...buffer.slice(0, 15));
    if (!header.startsWith('SNES-SPC')) {
      console.error(`SPC ${filename}: invalid header "${header}", got ${buffer.length} bytes`);
      return null;
    }
    spcCache.set(songNumber, buffer);
    return buffer;
  } catch {
    return null;
  } finally {
    spcLoading.delete(songNumber);
  }
}

async function playSPCSong(songNumber: number): Promise<void> {
  if (!initialized || songNumber <= 0) {
    console.warn(`playSPCSong(${songNumber}) skipped: initialized=${initialized}`);
    return;
  }
  if (songNumber === currentSongNumber) return;

  // Stop custom audio
  if (currentCustomTrack) {
    currentCustomTrack.pause();
    currentCustomTrack = null;
  }

  const spc = await loadSPC(songNumber);
  if (!spc) {
    console.warn(`playSPCSong(${songNumber}): SPC failed to load`);
    return;
  }

  try {
    // Load SPC data into asm.js engine (use heap, not stack — SPC files are 66KB)
    const spcPtr = _malloc(spc.length);
    HEAPU8.set(spc, spcPtr);
    _my_init(spcPtr, spc.length);
    startAudioNode();
    currentSongNumber = songNumber;
    console.log(`Playing song ${songNumber}`);
  } catch (e) {
    console.warn(`Failed to play SPC ${songNumber}:`, e);
  }
}

// EarthBound's name-entry music ("Your Name, Please", eb-002.spc) — the song
// that plays while you name your party in the ROM. Played on the character
// select screen, our analogue of that naming flow.
const CHAR_SELECT_SONG = 2;

/**
 * Start the character-select (naming) music. Inits the SPC engine and resumes a
 * suspended AudioContext — so it MUST be called from a user gesture (first key
 * press / click on the select screen). Idempotent: playSPCSong no-ops if song 2
 * is already current, so calling it on every interaction is fine.
 */
export function playCharSelectMusic(): void {
  if (!initialized) initMusic();
  if (audioContext && audioContext.state === 'suspended') void audioContext.resume();
  void playSPCSong(CHAR_SELECT_SONG);
}

/**
 * Play a custom audio track (MP3/OGG — for ESP32-side music on hardware).
 */
export function playCustomTrack(url: string, loop = true): void {
  stopMusic();

  let audio = customAudioCache.get(url);
  if (!audio) {
    audio = new Audio(url);
    customAudioCache.set(url, audio);
  }
  audio.loop = loop;
  audio.volume = muted ? 0 : volume;
  audio.currentTime = 0;
  audio.play().catch(() => {});
  currentCustomTrack = audio;
}

export function stopMusic(): void {
  if (audioNode) {
    audioNode.disconnect();
    audioNode = null;
  }
  currentSongNumber = -1;

  if (currentCustomTrack) {
    currentCustomTrack.pause();
    currentCustomTrack = null;
  }
}

export function setMusicVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  applyVolume();
}

function applyVolume(): void {
  const v = muted ? 0 : volume;
  if (gainNode) gainNode.gain.value = v;
  if (currentCustomTrack) currentCustomTrack.volume = v;
}

export function isMusicMuted(): boolean {
  return muted;
}

export function setMusicMuted(m: boolean): void {
  muted = m;
  applyVolume();
}

/** Flip mute state and return the new value. */
export function toggleMusicMuted(): boolean {
  muted = !muted;
  applyVolume();
  return muted;
}

let lastLoggedSong = -1;

export function updateMusic(playerX: number, playerY: number): void {
  if (!initialized) return;

  // An authored area wins; otherwise fall back to the sector's ROM musicId.
  let songNumber = songForPoint(playerX, playerY);
  let source = 'area';
  if (songNumber < 0) {
    const sectorX = Math.floor(playerX / (SECTOR_TILES_X * TILE_SIZE));
    const sectorY = Math.floor(playerY / (SECTOR_TILES_Y * TILE_SIZE));
    const sector = getSector(sectorX, sectorY);
    if (!sector) return;
    songNumber = musicMap[String(sector.musicId)] ?? 0;
    source = `sector musicId=${sector.musicId}`;
  }

  if (songNumber !== lastLoggedSong) {
    console.log(`Music: song ${songNumber} (${source})`);
    lastLoggedSong = songNumber;
  }
  if (songNumber > 0 && songNumber !== currentSongNumber) {
    playSPCSong(songNumber);
  }
}

// --- Editor preview (dev tools) ----------------------------------------------

/**
 * Audition a song from the Sound Manager. Inits the engine if needed and, since
 * the button click is a user gesture, resumes a suspended AudioContext so sound
 * is actually enabled. Forces a restart even if this song is already current
 * (so re-pressing Test re-auditions it).
 */
export function previewSong(songNumber: number): void {
  if (!initialized) initMusic();
  // The button click is a user gesture, so a suspended context can resume here.
  if (audioContext && audioContext.state === 'suspended') void audioContext.resume();
  currentSongNumber = -1;
  void playSPCSong(songNumber);
}

/** The song currently playing (so the editor can show/stop it). */
export function getCurrentSong(): number {
  return currentSongNumber;
}
