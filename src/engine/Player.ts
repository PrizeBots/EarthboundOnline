import { Direction, PlayerState } from '../types';
import { getDirection } from './Input';
import { checkCollision } from './Collision';

const SPEED = 2; // pixels per frame
const ANIM_INTERVAL = 8; // frames between animation toggle

// Player collision box (relative to position, which is center-bottom of sprite)
const COL_WIDTH = 14;
const COL_HEIGHT = 8;
const COL_OFFSET_Y = -8; // collision box is near feet

export class Player {
  state: PlayerState = {
    x: 1296,  // Onett area - walkable path
    y: 1168,
    direction: Direction.S,
    frame: 0,
    moving: false,
  };

  spriteGroupId = 1; // Ness
  private animTimer = 0;

  update() {
    const { dx, dy } = getDirection();
    const moving = dx !== 0 || dy !== 0;

    if (moving) {
      // Update direction
      this.state.direction = this.getDirection(dx, dy);
      this.state.moving = true;

      // Normalize diagonal movement so speed is consistent
      const diagonal = dx !== 0 && dy !== 0;
      const moveSpeed = diagonal ? SPEED * Math.SQRT1_2 : SPEED;

      // Compute desired position
      let newX = this.state.x + dx * moveSpeed;
      let newY = this.state.y + dy * moveSpeed;

      // Collision check — try full move, then axis-separated
      const colX = newX - COL_WIDTH / 2;
      const colY = newY + COL_OFFSET_Y;

      if (!checkCollision(colX, colY, COL_WIDTH, COL_HEIGHT)) {
        this.state.x = newX;
        this.state.y = newY;
      } else {
        // Try horizontal only
        const hx = this.state.x + dx * moveSpeed;
        const hColX = hx - COL_WIDTH / 2;
        const hColY = this.state.y + COL_OFFSET_Y;
        if (!checkCollision(hColX, hColY, COL_WIDTH, COL_HEIGHT)) {
          this.state.x = hx;
        }

        // Try vertical only
        const vy = this.state.y + dy * moveSpeed;
        const vColX = this.state.x - COL_WIDTH / 2;
        const vColY = vy + COL_OFFSET_Y;
        if (!checkCollision(vColX, vColY, COL_WIDTH, COL_HEIGHT)) {
          this.state.y = vy;
        }
      }

      // Animate
      this.animTimer++;
      if (this.animTimer >= ANIM_INTERVAL) {
        this.animTimer = 0;
        this.state.frame = this.state.frame === 0 ? 1 : 0;
      }
    } else {
      this.state.moving = false;
      this.state.frame = 0;
      this.animTimer = 0;
    }
  }

  private getDirection(dx: number, dy: number): Direction {
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
