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
 *
 * kind "car": server-authoritative traffic. Follows an authored waypoint route
 * (overrides/car_traffic.json), facing its travel direction; no HP. MAY be
 * talkable — a vehicle is an NPC that drives, so it can carry a textId and
 * speak like any other (EB's parked cars). Solid to every entity — a car stops
 * when one is in its path and blocks the player from walking through it.
 */

import { Entity } from './Entity';
import { Direction, Pose } from '../types';

export type NPCKind = 'person' | 'prop' | 'enemy' | 'car';

// EarthBound's telephones — talking to one calls Dad to save instead of
// showing check text. Sprite groups: 215/216 (overworld phones), 412/427
// (special/late-game phones). Mirrors how shopStore marks a clerk.
const PHONE_SPRITE_GROUPS = new Set([215, 216, 412, 427]);

export class NPC extends Entity {
  readonly kind: NPCKind;
  /** NPC config id keying npc_text.json, or null if this NPC has no dialogue. */
  readonly textId: number | null;
  /** Server-driven animation pose (walk/attack/hurt), same as players. */
  pose: Pose = 'walk';
  /** Store id if this NPC is a shop clerk (set by NPCManager), else null. */
  shopStore: number | null = null;

  /** True if this placement is a telephone — talking to it triggers a save. */
  get isPhone(): boolean {
    return PHONE_SPRITE_GROUPS.has(this.spriteGroupId);
  }

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

  /**
   * No HP left — hidden + non-solid. Enemies: killed or an inactive spawner
   * slot. People: a townsperson an enemy downed (revives at home server-side).
   * Props/cars have no HP and never report dead.
   */
  get dead(): boolean {
    return (this.kind === 'enemy' || this.kind === 'person') && this.hp <= 0;
  }

  update(): void {
    // Simulation lives on the server; positions arrive over the network.
  }

  applyHp(hp: number, maxHp: number): void {
    this.hp = hp;
    this.maxHp = maxHp;
  }

  applyServerState(
    x: number,
    y: number,
    direction: Direction,
    frame: number,
    pose: Pose = 'walk',
  ): void {
    this.x = x;
    this.y = y;
    this.direction = direction;
    this.frame = frame;
    this.pose = pose;
  }
}
