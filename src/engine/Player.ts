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
// recoil then settle. Movement is locked while either plays.
const ATTACK_WINDUP = 8;
const ATTACK_TOTAL = 16;
const HURT_RECOIL = 8;
const HURT_TOTAL = 20;

export class Player extends Entity {
  pose: Pose = 'walk';
  heldItemId: string | null = null;
  private poseTimer = 0;

  constructor() {
    // Spawn position/facing come from src/spawn.json (Onett default), so the
    // admin spawn-point tool can relocate it without a code change. Sprite
    // group 1 (Ness) is the default character appearance, set elsewhere.
    super(spawn.x, spawn.y, 1);
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
      this.frame = this.poseTimer < ATTACK_WINDUP ? 0 : 1;
      if (this.poseTimer >= ATTACK_TOTAL) {
        this.pose = 'walk';
        this.resetAnimation();
      }
      this.moving = false;
      return;
    }
    if (this.pose === 'hurt') {
      this.poseTimer++;
      this.frame = this.poseTimer < HURT_RECOIL ? 0 : 1; // recoil then settle
      if (this.poseTimer >= HURT_TOTAL) {
        this.pose = 'walk';
        this.resetAnimation();
      }
      this.moving = false;
      return;
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
