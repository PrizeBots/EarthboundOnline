/**
 * NPC — a world character or prop placed from the ROM's sprite tables.
 *
 * kind "prop": inert scenery (trash cans, signs, present boxes) — never
 * moves, never gets a health bar.
 *
 * kind "person": SERVER-AUTHORITATIVE. The wander/glance life AI runs in
 * server/npcSim.js so every client sees identical positions and animation;
 * the client just applies `npc_update` rows (see NPCManager).
 *
 * kind "enemy": same server-authoritative channel, plus HP. Attackable; the
 * server resolves damage and broadcasts `npc_hp`. hp <= 0 means dead/hidden
 * (also the initial state of inactive spawner-pool slots).
 */

import { Entity } from './Entity';
import { Direction } from '../types';

export type NPCKind = 'person' | 'prop' | 'enemy';

export class NPC extends Entity {
  readonly kind: NPCKind;
  /** NPC config id keying npc_text.json, or null if this NPC has no dialogue. */
  readonly textId: number | null;

  constructor(
    x: number,
    y: number,
    spriteGroupId: number,
    direction: Direction,
    kind: NPCKind,
    textId: number | null = null,
  ) {
    super(x, y, spriteGroupId);
    this.direction = direction;
    this.kind = kind;
    this.textId = textId;
  }

  /** Enemy with no HP left — dead, or an inactive spawner slot. Hidden + non-solid. */
  get dead(): boolean {
    return this.kind === 'enemy' && this.hp <= 0;
  }

  update(): void {
    // Simulation lives on the server; positions arrive over the network.
  }

  applyHp(hp: number, maxHp: number): void {
    this.hp = hp;
    this.maxHp = maxHp;
  }

  applyServerState(x: number, y: number, direction: Direction, frame: number): void {
    this.x = x;
    this.y = y;
    this.direction = direction;
    this.frame = frame;
  }
}
