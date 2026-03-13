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
    gainNode.gain.value = volume;
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

  // Stop existing node
  if (audioNode) {
    audioNode.disconnect();
    audioNode = null;
  }

  audioNode = audioContext.createScriptProcessor(frameSize, 0, 2);
  let audioDbgCount = 0;
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
    // Log first few callbacks to diagnose
    if (audioDbgCount < 3) {
      const L = outputBuffer.getChannelData(0);
      let max = 0;
      for (let i = 0; i < L.length; i++) { if (Math.abs(L[i]) > max) max = Math.abs(L[i]); }
      console.log(`Audio callback #${audioDbgCount}: maxSample=${max.toFixed(6)}, ctxState=${audioContext?.state}, bufPtr=${bufPtr}`);
      audioDbgCount++;
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
  if (!initialized || songNumber <= 0) return;
  if (songNumber === currentSongNumber) return;

  // Stop custom audio
  if (currentCustomTrack) {
    currentCustomTrack.pause();
    currentCustomTrack = null;
  }

  const spc = await loadSPC(songNumber);
  if (!spc) return;

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
  audio.volume = volume;
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
  if (gainNode) gainNode.gain.value = volume;
  if (currentCustomTrack) currentCustomTrack.volume = volume;
}

let lastLoggedMusicId = -1;

export function updateMusic(playerX: number, playerY: number): void {
  if (!initialized) return;

  const sectorX = Math.floor(playerX / (SECTOR_TILES_X * TILE_SIZE));
  const sectorY = Math.floor(playerY / (SECTOR_TILES_Y * TILE_SIZE));
  const sector = getSector(sectorX, sectorY);
  if (!sector) return;

  const songNumber = musicMap[String(sector.musicId)] ?? 0;
  if (sector.musicId !== lastLoggedMusicId) {
    console.log(`Sector (${sectorX},${sectorY}) musicId=${sector.musicId} -> song ${songNumber}`);
    lastLoggedMusicId = sector.musicId;
  }
  if (songNumber > 0 && songNumber !== currentSongNumber) {
    playSPCSong(songNumber);
  }
}
