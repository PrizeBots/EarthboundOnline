import { loadJSON } from './AssetLoader';
import { getSector } from './MapManager';
import { SECTOR_TILES_X, SECTOR_TILES_Y, TILE_SIZE } from '../types';

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
  x: number;
  y: number;
  w: number;
  h: number; // world pixels
  song: number; // SPC song number (what plays)
}
let musicAreas: MusicArea[] = [];

// The area whose song is currently playing (index into musicAreas, or -1). We
// stick to it until the player has clearly LEFT it (see EDGE_MARGIN) so that
// standing near — or brushing across — a border never hands the music to a
// neighbouring room.
let currentAreaIndex = -1;

// Hysteresis at area borders, in world px. The current area keeps the music
// until the player is this far OUTSIDE it; a neighbour only takes over once the
// player is solidly inside it. One tile (32px) — enough that you can hug a wall
// or step on a seam without the song flipping, but the change still lands as you
// walk into the next room.
const EDGE_MARGIN = TILE_SIZE;

function inArea(a: MusicArea, x: number, y: number, m = 0): boolean {
  return x >= a.x - m && x < a.x + a.w + m && y >= a.y - m && y < a.y + a.h + m;
}

export async function loadMusicAreas(): Promise<void> {
  try {
    const res = await fetch('/overrides/music.json', { cache: 'no-store' });
    musicAreas = res.ok ? ((await res.json())?.areas ?? []) : [];
    currentAreaIndex = -1;
    console.log(`Music areas loaded: ${musicAreas.length}`);
  } catch {
    musicAreas = []; // none authored yet — pure sector fallback
  }
}

/** Live-replace the areas (editor pushes its working set without a refetch). */
export function setMusicAreas(areas: MusicArea[]): void {
  musicAreas = areas.slice();
  currentAreaIndex = -1; // area refs changed — re-resolve from scratch
  lastLoggedSong = -2; // force the next updateMusic to re-evaluate + log
}

/**
 * Index of the area that owns the music at a world point, or -1 if none.
 * Sticky: if the player is still inside the current area (plus EDGE_MARGIN) it
 * wins — so being close to an edge can't trigger a neighbouring room's sound.
 * Otherwise the topmost (last-authored) area containing the point takes over.
 */
function areaForPoint(x: number, y: number): number {
  if (
    currentAreaIndex >= 0 &&
    currentAreaIndex < musicAreas.length &&
    inArea(musicAreas[currentAreaIndex], x, y, EDGE_MARGIN)
  ) {
    return currentAreaIndex;
  }
  for (let i = musicAreas.length - 1; i >= 0; i--) {
    if (inArea(musicAreas[i], x, y)) return i;
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
const frameSize = 16384;
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

// --- one-shot sound effects -------------------------------------------------
// Door/stairs/rope SFX play through their own gain node so they layer over the
// SPC music without interrupting it (SNES-honest: a SFX ID fired alongside the
// song). Buffers are decoded once and cached. Missing files no-op silently so
// the door pipeline works before the audio is extracted into /assets/sfx/.

const sfxBuffers = new Map<string, AudioBuffer | null>(); // null = known-missing
const sfxLoading = new Set<string>();
let sfxGain: GainNode | null = null;
// Live one-shot sources, tracked so stopAllSfx() can cut them mid-play. Each
// source removes itself on 'ended' so the set doesn't leak.
const activeSfxSources = new Set<AudioBufferSourceNode>();
// SFX have their own mute, separate from music: the editor force-mutes MUSIC
// while authoring, but a door's SFX still needs to audition when you pick it.
let sfxMuted = false;

export function setSfxMuted(m: boolean): void {
  sfxMuted = m;
}

export function isSfxMuted(): boolean {
  return sfxMuted;
}

async function loadSfx(id: string): Promise<AudioBuffer | null> {
  if (sfxBuffers.has(id)) return sfxBuffers.get(id)!;
  if (!audioContext || sfxLoading.has(id)) return null;
  sfxLoading.add(id);
  try {
    const resp = await fetch(`/assets/sfx/${id}.wav`);
    if (!resp.ok) {
      sfxBuffers.set(id, null); // remember the gap; don't refetch every door
      return null;
    }
    const buf = await audioContext.decodeAudioData(await resp.arrayBuffer());
    sfxBuffers.set(id, buf);
    return buf;
  } catch {
    sfxBuffers.set(id, null);
    return null;
  } finally {
    sfxLoading.delete(id);
  }
}

/**
 * Play a one-shot sound effect by id (see DoorSfx.ts). No-ops when muted, when
 * the audio engine isn't up yet, for the 'none' id, or when the file is absent.
 * Async load on first use; subsequent plays are instant from cache.
 */
export function playSfx(id: string | undefined | null, vol = 1): void {
  if (!id || id === 'none' || sfxMuted || !initialized || !audioContext) return;
  const ctx = audioContext;
  if (!sfxGain) {
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 1;
    sfxGain.connect(ctx.destination);
  }
  const v = Math.max(0, Math.min(1, vol));
  if (v <= 0) return; // silenced
  void loadSfx(id).then((buf) => {
    if (!buf || sfxMuted) return; // re-check mute: load is async
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // A per-shot gain applies this sound's authored volume; skip the extra node
    // at full volume (the common case) so most SFX wire straight to the bus.
    if (v >= 1) {
      src.connect(sfxGain!);
    } else {
      const g = ctx.createGain();
      g.gain.value = v;
      src.connect(g);
      g.connect(sfxGain!);
    }
    trackSfxSource(src);
    src.start();
  });
}

/** Register a one-shot source so stopAllSfx() can cut it; self-cleans on end. */
function trackSfxSource(src: AudioBufferSourceNode): void {
  activeSfxSources.add(src);
  src.addEventListener('ended', () => activeSfxSources.delete(src));
}

/** Hard-stop every currently-playing one-shot SFX (does not touch music). */
export function stopAllSfx(): void {
  for (const src of activeSfxSources) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  activeSfxSources.clear();
}

/** Panic button: cut music AND all one-shot SFX immediately. */
export function stopAllSounds(): void {
  stopMusic();
  stopAllSfx();
}

/**
 * Mute/unmute the WHOLE game — music AND sfx in lockstep. This is what the
 * top-right mute button drives (the editor keeps the two separate so it can
 * audition sfx while music is force-muted). Muting also cuts any one-shot sfx
 * already in flight so nothing keeps ringing after the toggle.
 */
export function setAllMuted(m: boolean): void {
  setMusicMuted(m);
  setSfxMuted(m);
  if (m) stopAllSfx();
}

/** Flip the whole-game mute and return the new value (for the mute button). */
export function toggleAllMuted(): boolean {
  const next = !isMusicMuted();
  setAllMuted(next);
  return next;
}

// Listener (player) position for positional SFX, refreshed every frame by
// updateMusic. World-pixel space, same as entity coords.
let listenerX = 0;
let listenerY = 0;
const SFX_FULL_DIST = 160; // within this radius: full volume
const SFX_MAX_DIST = 384; // beyond this radius: inaudible

/**
 * Positional one-shot SFX — like playSfx but attenuated by distance from the
 * listener (the local player, tracked by updateMusic) so far-off world events
 * (enemy deaths, remote swings) fade out instead of blasting at full volume.
 */
export function playSfxAt(id: string | undefined | null, x: number, y: number, vol = 1): void {
  if (!id || id === 'none' || sfxMuted || !initialized || !audioContext) return;
  const dist = Math.hypot(x - listenerX, y - listenerY);
  if (dist >= SFX_MAX_DIST) return; // too far to hear
  const atten =
    dist <= SFX_FULL_DIST ? 1 : 1 - (dist - SFX_FULL_DIST) / (SFX_MAX_DIST - SFX_FULL_DIST);
  // Final gain = distance attenuation × this sound's authored volume.
  const gain = atten * Math.max(0, Math.min(1, vol));
  if (gain <= 0) return;
  const ctx = audioContext;
  if (!sfxGain) {
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 1;
    sfxGain.connect(ctx.destination);
  }
  void loadSfx(id).then((buf) => {
    if (!buf || sfxMuted) return; // re-check mute: load is async
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(sfxGain!);
    trackSfxSource(src);
    src.start();
  });
}

let lastLoggedSong = -1;

export function updateMusic(playerX: number, playerY: number): void {
  if (!initialized) return;
  listenerX = playerX;
  listenerY = playerY;

  // An authored area wins (sticky — see areaForPoint); otherwise fall back to
  // the sector's ROM musicId.
  const ai = areaForPoint(playerX, playerY);
  let songNumber: number;
  let source: string;
  if (ai >= 0) {
    currentAreaIndex = ai;
    songNumber = musicAreas[ai].song;
    source = `area "${musicAreas[ai].name}"`;
  } else {
    currentAreaIndex = -1;
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
