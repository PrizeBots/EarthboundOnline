/**
 * Juice — global "game feel" effects: hitstop (a brief world freeze on impact)
 * and screen shake (decaying camera jitter). Both are module-level singletons,
 * mirroring the Emitter pattern, so any system that detects a hit
 * (NPCManager.applyNpcHp, Game's onPlayerHp / onCombat) can trigger them without
 * threading callbacks through the render tree.
 *
 * Hit FLASH (the white sprite blink) is per-entity instead — see Entity.flashUntil
 * and drawSprite's `flash` arg — because it's keyed to a specific sprite, not the
 * whole screen.
 *
 * SNES-honest: real hardware jitters the BG scroll registers for shake and
 * palette-flashes sprites on hit; this is the canvas equivalent of both.
 */

// --- Hitstop ---------------------------------------------------------------
// Remaining frozen frames. While > 0 the gameplay sim is skipped for the frame
// (render still runs, so the held frame reads as a crisp freeze).
let hitstopFrames = 0;

/** Freeze the world for `frames` (longest pending wins — a new hit never shortens
 *  an in-progress freeze). */
export function triggerHitstop(frames: number): void {
  if (frames > hitstopFrames) hitstopFrames = frames;
}

/** Consume one frozen frame. Returns true while the freeze should still hold. */
export function tickHitstop(): boolean {
  if (hitstopFrames > 0) {
    hitstopFrames--;
    return true;
  }
  return false;
}

// --- Screen shake ----------------------------------------------------------
// "Trauma" in [0,1]; the on-screen offset scales with trauma² (light hits stay
// subtle, big hits kick hard) and trauma decays linearly, so a shake settles in
// well under half a second.
let trauma = 0;
const MAX_OFFSET = 5; // px of camera displacement at full trauma
const TRAUMA_DECAY = 0.05; // trauma shed per rendered frame (~20 frames from 1→0)

/** Add shake. `amount` is trauma added; total is clamped to 1. */
export function addShake(amount: number): void {
  trauma = Math.min(1, trauma + amount);
}

/** This frame's shake offset (world px) and decay trauma. Call once per render. */
export function tickShake(): { x: number; y: number } {
  if (trauma <= 0) return { x: 0, y: 0 };
  const mag = MAX_OFFSET * trauma * trauma;
  const ox = (Math.random() * 2 - 1) * mag;
  const oy = (Math.random() * 2 - 1) * mag;
  trauma = Math.max(0, trauma - TRAUMA_DECAY);
  return { x: ox, y: oy };
}

// --- Hit flash -------------------------------------------------------------
// How long a struck sprite blinks white. Callers stamp entity.flashUntil =
// now + FLASH_MS; drawSprite tints while Date.now() is under it.
export const FLASH_MS = 90; // ~5–6 frames at 60fps
