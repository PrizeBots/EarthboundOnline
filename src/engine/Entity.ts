/**
 * Entity — base class for everything that lives in the world and renders as
 * a sprite: the local Player, NPCs, and (later) Enemies. Remote players are
 * network records rather than locally-simulated entities, but they share the
 * same drawable shape (EntityView) so the renderer treats everyone alike.
 */

import { Direction } from '../types';
import { spawnDamageNumber, spawnHealNumber } from './Emitter';

const ANIM_INTERVAL = 8; // frames between walk-cycle toggles

/** What the renderer needs to draw any entity + its health bar. */
export interface EntityView {
  x: number;
  y: number; // feet (sprite anchor is center-bottom)
  direction: Direction;
  frame: number;
  spriteGroupId: number;
  healthRatio: number;
}

export abstract class Entity implements EntityView {
  x: number;
  y: number;
  direction: Direction = Direction.S;
  frame = 0;
  moving = false;
  spriteGroupId: number;
  maxHp: number;
  hp: number;
  /** EB rolling-bar state (see HealthRoll): displayHp lags `hp` so the bar drains
   *  in increments, dmgPendUntil/rollTs drive the hold-flash + frame-independent
   *  drain. Purely visual — never gates the simulation. */
  displayHp?: number;
  dmgPendUntil?: number;
  rollTs?: number;
  /** Mortal roll (server-timed HP→0 death slide); see HealthRoll. */
  mortalFrom?: number;
  mortalStart?: number;
  mortalMs?: number;
  /** Epoch-ms until which this sprite blinks white from a hit (see Juice.FLASH_MS
   *  / drawSprite). 0 = not flashing. */
  flashUntil = 0;
  /** When this combatant dies, play the rotate-and-bounce death throw (see
   *  DeathFx / NPCManager.applyNpcDeath) instead of just vanishing. Class-level
   *  default ON for every entity; flip to false in code for the kinds that
   *  shouldn't tumble (it's deliberately NOT a per-instance authored field). */
  rotateOnDeath = true;
  protected animTimer = 0;

  constructor(x: number, y: number, spriteGroupId: number, maxHp = 30) {
    this.x = x;
    this.y = y;
    this.spriteGroupId = spriteGroupId;
    this.maxHp = maxHp;
    this.hp = maxHp;
  }

  /** Per-frame simulation. */
  abstract update(): void;

  get healthRatio(): number {
    return this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    if (amount > 0) spawnDamageNumber(this.x, this.y, amount);
  }

  heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    if (amount > 0) spawnHealNumber(this.x, this.y, amount);
  }

  /** Advance the 2-frame walk cycle. Call only while moving. */
  protected stepAnimation(): void {
    this.animTimer++;
    if (this.animTimer >= ANIM_INTERVAL) {
      this.animTimer = 0;
      this.frame = this.frame === 0 ? 1 : 0;
    }
  }

  /** Snap back to the standing frame. */
  protected resetAnimation(): void {
    this.frame = 0;
    this.animTimer = 0;
  }
}
