import { Direction, Pose } from '../types';
import { Entity } from './Entity';
import { getDirection } from './Input';
import { checkPlayerCollision } from './Collision';
import { blockedByNPC } from './NPCManager';
import { nextHeldItem } from './Items';
import spawn from '../spawn.json';

const SPEED = 2; // pixels per frame

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

export class Player extends Entity {
  pose: Pose = 'walk';
  heldItemId: string | null = null;
  private poseTimer = 0;

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
    if (this.pose !== 'walk') return false; // no canceling a swing or flinch
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

  cycleHeldItem(): void {
    this.heldItemId = nextHeldItem(this.heldItemId);
  }

  update() {
    if (this.pose === 'attack') {
      this.poseTimer++;
      this.frame = this.poseTimer < ATTACK_WINDUP ? 0 : this.poseTimer < ATTACK_SWING ? 1 : 2;
      if (this.poseTimer >= ATTACK_TOTAL) {
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

    const { dx, dy } = getDirection();
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

      // Normalize diagonal movement so speed is consistent
      const diagonal = dx !== 0 && dy !== 0;
      const moveSpeed = diagonal ? SPEED * Math.SQRT1_2 : SPEED;

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
    const moveSpeed = SPEED * Math.SQRT1_2; // escalators always run diagonally
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
