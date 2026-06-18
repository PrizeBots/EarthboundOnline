import { Direction, Pose } from '../types';
import { Entity } from './Entity';
import { getDirection } from './Input';
import { checkPlayerCollision } from './Collision';
import { blockedByNPC } from './NPCManager';
import { nextHeldItem } from './Items';
import spawn from '../spawn.json';

// Walk speed scales with the Speed STAT (server-authoritative; grows on
// level-up — see GROWTH in server/gameHost.js). A fresh level-1 character
// (Speed ~8) starts deliberately slow and quickens as Speed climbs, so leveling
// is felt in the legs. Clamped so a low allocation never crawls and a maxed one
// never blurs past the colliders. Replaces the old flat SPEED=2, which made
// level 1 feel sprint-fast. `moveSpeedFor` is the single source of truth.
const SPEED_BASE = 0.5; // px/frame floor contribution
const SPEED_PER_STAT = 0.07; // px/frame added per point of the Speed stat
const SPEED_MIN = 0.9; // never slower than this (a crawl isn't fun)
const SPEED_MAX = 2.6; // never faster than this (camera/collision stay sane)
const DEFAULT_SPEED_STAT = 8; // server BASE_STATS.speed — used until stats arrive
function moveSpeedFor(speedStat: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, SPEED_BASE + speedStat * SPEED_PER_STAT));
}

// Player collision box (relative to position, which is center-bottom of sprite)
const COL_WIDTH = 14;
const COL_HEIGHT = 8;
const COL_OFFSET_Y = -8; // collision box is near feet

// Pose timing, in game frames (60/s): attack = wind-up then swing; hurt =
// recoil then settle. Movement is locked during an ATTACK (you committed to the
// swing) but NOT during a HURT flinch — locking the flinch let a mob of enemies
// chain-reset it and freeze the player solid (stunlock). The flinch is now
// cosmetic: you can walk out of a crowd while it plays.
// Attack plays 3 weapon frames: wind-up (f0) → swing (f1) → follow-through (f2),
// so a held weapon animates across all three (the body sprite has 2 attack
// frames and clamps f2 to its swing). Thresholds split ATTACK_TOTAL into thirds.
const ATTACK_WINDUP = 6; // f0 ends here
const ATTACK_SWING = 11; // f1 ends here, f2 (follow-through) runs to ATTACK_TOTAL
const ATTACK_TOTAL = 16;
const HURT_TOTAL = 20;

// Knockback slide: a hit shoves the player to a server-clamped landing spot. We
// ease toward it over a few frames instead of teleporting, so the camera (which
// snaps to the player every frame) glides rather than jolting. ~8 frames of
// ease-out covers the distance in ~130ms — reads as a shove, not a warp.
const KB_SLIDE_FRAMES = 8;
const KB_SLIDE_EASE = 0.4; // fraction of the remaining gap closed per frame

// Statuses that reverse the player's controls (mirror of the `scramble` flag in
// server/status.js): feeling strange / mushroomized / possessed.
const SCRAMBLE_STATUSES = new Set(['strange', 'possessed']);

export class Player extends Entity {
  pose: Pose = 'walk';
  heldItemId: string | null = null;
  /** Equipped-weapon swing-rate multiplier (server-authoritative; 1 = baseline).
   *  Scales the attack-pose duration so a fast weapon both animates and (via the
   *  server cooldown) resolves quicker. Set from the 'equipped' message. */
  attackSpeed = 1;
  /** PK (player-kill) flag — server-authoritative; red nameplate when on. */
  pk = false;
  /** The Speed STAT (server-authoritative; grows on level-up). Drives walk
   *  speed via moveSpeedFor. Defaults to the level-1 base until stats arrive. */
  speed = DEFAULT_SPEED_STAT;
  /** Epoch-ms the PK enable-lock expires (can't disable PK before this). */
  pkUntil = 0;
  private poseTimer = 0;
  // Active knockback slide toward (kbX, kbY); kbFrames counts down to 0.
  private kbX = 0;
  private kbY = 0;
  private kbFrames = 0;
  // Status input-lock deadline (ms epoch). While Date.now() < frozenUntil the
  // player can't move (paralysis / sleep / diamondized); set by the server.
  private frozenUntil = 0;
  // Active status-condition ids (server-synced) — drives the HP-bar pips.
  statuses: string[] = [];
  // Active timed stat buffs (owner-only, server-synced) — drives the buff HUD.
  // `expiresAt` is a LOCAL epoch-ms deadline so the HUD counts down every frame
  // without per-second server traffic (server resends only on change).
  buffs: { stat: string; amount: number; expiresAt: number }[] = [];
  // KO/downed state (server-synced). While downed the player lays rotated 90°,
  // can't act, sees a countdown + closing vignette, and can "give up the ghost"
  // by holding (giveUpProgress 0..1). downedTotalMs drives the vignette ramp.
  downed = false;
  downedUntil = 0;
  downedTotalMs = 0;
  giveUpProgress = 0;

  constructor() {
    // Spawn position/facing come from src/spawn.json (Onett default), so the
    // admin spawn-point tool can relocate it without a code change. Sprite
    // group 1 (Ness) is the default character appearance, set elsewhere.
    // 60 max HP mirrors the server's PLAYER_MAX_HP (server-authoritative combat).
    super(spawn.x, spawn.y, 1, 60);
    this.direction = spawn.dir as Direction;
  }

  /** Begin a swing. Returns true if one actually started (for the net send). */
  attack(): boolean {
    if (this.pose === 'attack') return false; // can't cancel your own swing mid-animation
    // A HURT flinch does NOT block attacking — same decision already made for
    // movement (see header note). Otherwise a mob re-stamping hurt() every few
    // frames perma-locks you out of swinging (stunlock).
    this.pose = 'attack';
    this.poseTimer = 0;
    this.frame = 0;
    return true;
  }

  hurt(): void {
    this.pose = 'hurt';
    this.poseTimer = 0;
    this.frame = 0;
  }

  /** Start a smooth knockback slide to a server-clamped landing spot (the host
   *  already collision-checked it). Replaces the old instant teleport so the
   *  camera glides. A fresh hit just re-targets the slide — it can't freeze. */
  knockTo(x: number, y: number): void {
    this.kbX = x;
    this.kbY = y;
    this.kbFrames = KB_SLIDE_FRAMES;
  }

  /** Lock movement input until `until` (ms epoch); 0 clears it. Set from the
   *  server's status broadcasts (paralysis / sleep / diamondized). */
  freezeUntil(until: number): void {
    this.frozenUntil = until;
  }

  /** True while a status input-lock is in effect (drives the lock indicator). */
  get frozen(): boolean {
    return Date.now() < this.frozenUntil;
  }

  cycleHeldItem(): void {
    this.heldItemId = nextHeldItem(this.heldItemId);
  }

  update() {
    // Knockback slide: ease toward the landing spot. Runs first and regardless of
    // pose (you can be shoved mid-swing), so position is always smoothed; the
    // camera follows the gliding position each frame instead of jumping.
    const sliding = this.kbFrames > 0;
    if (sliding) {
      this.kbFrames--;
      if (this.kbFrames <= 0) {
        this.x = this.kbX; // land exactly on the authoritative spot
        this.y = this.kbY;
      } else {
        this.x += (this.kbX - this.x) * KB_SLIDE_EASE;
        this.y += (this.kbY - this.y) * KB_SLIDE_EASE;
      }
    }

    if (this.pose === 'attack') {
      this.poseTimer++;
      // Scale the swing thresholds by attackSpeed: a faster weapon (>1) finishes
      // its 3-frame swing in fewer frames, so the pose-gate in attack() clears
      // sooner and the player can swing again at the weapon's true cadence.
      const spd = this.attackSpeed > 0 ? this.attackSpeed : 1;
      const windup = ATTACK_WINDUP / spd;
      const swing = ATTACK_SWING / spd;
      const total = ATTACK_TOTAL / spd;
      this.frame = this.poseTimer < windup ? 0 : this.poseTimer < swing ? 1 : 2;
      if (this.poseTimer >= total) {
        this.pose = 'walk';
        this.resetAnimation();
      }
      this.moving = false;
      return;
    }
    if (this.pose === 'hurt') {
      // Advance the flinch, but DON'T lock movement (no return) — being mobbed
      // kept re-triggering hurt() and froze the player. The flinch plays while
      // you keep walking; if you stand still the movement block below shows the
      // recoil/settle frames, and the pose clears itself after HURT_TOTAL.
      this.poseTimer++;
      if (this.poseTimer >= HURT_TOTAL) {
        this.pose = 'walk';
        this.resetAnimation();
      }
      // fall through to normal movement
    }

    // The shove owns position while it plays — don't let input fight the slide.
    if (sliding) {
      this.moving = false;
      return;
    }

    // Status-frozen (paralysis / sleep / diamondized): the server locked our
    // input until `frozenUntil`. Hold still — movement input is ignored.
    if (Date.now() < this.frozenUntil) {
      this.moving = false;
      return;
    }

    let { dx, dy } = getDirection();
    // Scrambled (feeling strange / possessed): your controls are reversed.
    if (this.statuses.some((s) => SCRAMBLE_STATUSES.has(s))) {
      dx = -dx;
      dy = -dy;
    }
    const moving = dx !== 0 || dy !== 0;

    if (moving) {
      this.direction = this.dirFromInput(dx, dy);
      this.moving = true;

      // Foot box at the START of this frame — passed to the NPC check so a
      // player embedded in a person (spawned on a wanderer, or a server
      // teleport pushing one onto them) can walk out instead of being trapped
      // because every candidate move still overlaps.
      const curColX = this.x - COL_WIDTH / 2;
      const curColY = this.y + COL_OFFSET_Y;

      // Normalize diagonal movement so speed is consistent. Base speed scales
      // with the Speed stat (slow at level 1, faster as you level up).
      const diagonal = dx !== 0 && dy !== 0;
      const base = moveSpeedFor(this.speed);
      const moveSpeed = diagonal ? base * Math.SQRT1_2 : base;

      // Compute desired position
      const newX = this.x + dx * moveSpeed;
      const newY = this.y + dy * moveSpeed;

      // Collision check - try full move, then axis-separated
      const colX = newX - COL_WIDTH / 2;
      const colY = newY + COL_OFFSET_Y;

      if (!this.blocked(colX, colY, curColX, curColY)) {
        this.x = newX;
        this.y = newY;
      } else {
        // Try horizontal only
        const hx = this.x + dx * moveSpeed;
        if (!this.blocked(hx - COL_WIDTH / 2, this.y + COL_OFFSET_Y, curColX, curColY)) {
          this.x = hx;
        }

        // Try vertical only
        const vy = this.y + dy * moveSpeed;
        if (!this.blocked(this.x - COL_WIDTH / 2, vy + COL_OFFSET_Y, curColX, curColY)) {
          this.y = vy;
        }
      }

      this.stepAnimation();
    } else {
      this.moving = false;
      this.resetAnimation();
    }
  }

  /**
   * Solid for the player at a foot box: world/room collision plus solid NPCs
   * (people). Combined so the axis-separated slide above treats both alike.
   */
  private blocked(colX: number, colY: number, curColX?: number, curColY?: number): boolean {
    return (
      checkPlayerCollision(colX, colY, COL_WIDTH, COL_HEIGHT) ||
      blockedByNPC(colX, colY, COL_WIDTH, COL_HEIGHT, curColX, curColY)
    );
  }

  /**
   * Auto-walk one frame along an escalator/stairway. Movement is diagonal and
   * bypasses collision entirely — the steps are solid and the engine carries
   * you across them. Returns the distance moved this frame (the ride state
   * machine in Game uses it to detect arrival at the far landing).
   */
  rideStep(dx: number, dy: number): number {
    const moveSpeed = moveSpeedFor(this.speed) * Math.SQRT1_2; // escalators always run diagonally
    this.x += dx * moveSpeed;
    this.y += dy * moveSpeed;
    this.direction = this.dirFromInput(dx, dy);
    this.moving = true;
    this.stepAnimation();
    return moveSpeed;
  }

  private dirFromInput(dx: number, dy: number): Direction {
    if (dx === 0 && dy < 0) return Direction.N;
    if (dx === 0 && dy > 0) return Direction.S;
    if (dx < 0 && dy === 0) return Direction.W;
    if (dx > 0 && dy === 0) return Direction.E;
    if (dx < 0 && dy < 0) return Direction.NW;
    if (dx > 0 && dy < 0) return Direction.NE;
    if (dx < 0 && dy > 0) return Direction.SW;
    return Direction.SE;
  }
}
