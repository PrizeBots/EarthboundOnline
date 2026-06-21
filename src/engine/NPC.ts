/**
 * NPC — a world character or prop placed from the ROM's sprite tables.
 *
 * kind "prop": inert scenery (signs, furniture, hotspots) — never moves,
 * never gets a health bar.
 *
 * kind "gift": an item-container you check/open (presents, trash cans, jars,
 * crates, boxes, baskets). Behaves exactly like a `prop` for collision and
 * rendering, but is distinguished so the editor labels it and the open/grant
 * flow (see Gifts.ts) is obvious. Contents + identity come from the gift
 * catalog (gifts.json), keyed by placementKey — not from this kind.
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

export type NPCKind = 'person' | 'prop' | 'enemy' | 'car' | 'gift';

// EarthBound's telephones — talking to one calls Dad to save instead of
// showing check text. Sprite groups: 215/216 (overworld phones), 412/427
// (special/late-game phones). Mirrors how shopStore marks a clerk.
const PHONE_SPRITE_GROUPS = new Set([215, 216, 412, 427]);

// EarthBound's ATMs (cash machines) — talking to one opens the bank menu to move
// money between your account and on-hand cash. Sprite groups 259 / 447.
const ATM_SPRITE_GROUPS = new Set([259, 447]);

// Ness's mom (sprite group 145) — talking to her cooks the player's favorite
// food (server-authoritative heal + cooldown). Mirrors how shopStore/phones tag
// a special interaction by sprite.
const MOM_SPRITE_GROUP = 145;

export class NPC extends Entity {
  readonly kind: NPCKind;
  /** NPC config id keying npc_text.json, or null if this NPC has no dialogue. */
  readonly textId: number | null;
  /** Server-driven animation pose (walk/attack/hurt), same as players. */
  pose: Pose = 'walk';
  /** Held weapon sprite id (server-synced via npc_equip) — a townsperson that
   *  equipped a looted weapon. null = empty-handed. Rendered like a player's
   *  heldItemId via the shared drawEntityPart path. */
  itemId: string | null = null;
  /** Active status-condition ids (server-synced) — drives the HP-bar pips. */
  statuses: string[] = [];
  /** Store id if this NPC is a shop clerk (set by NPCManager), else null. */
  shopStore: number | null = null;
  /** Resolved level (set by NPCManager via resolveProps; mirrors the server's
   *  actor level). Drives the weight-class walk-push: a higher-level player walks
   *  THROUGH (and the server shoves aside) any person/enemy below their level —
   *  see blockedByNPC. Defaults to 1 (the non-enemy baseline). */
  level = 1;
  /** Client-side PREDICTION offset (px) layered on top of the interpolated
   *  authoritative position. When the local player plows this NPC, the client
   *  nudges it instantly (no round-trip wait) by growing this offset; it DECAYS
   *  each frame so the authoritative server stream reconciles it back to zero.
   *  This is the reusable predict-then-reconcile primitive — see interpolateNpcs
   *  / predictPlayerPush in NPCManager. */
  predOffX = 0;
  predOffY = 0;
  /**
   * Placement identity (RawNPC.k for ROM/base placements, "+i" for the i-th
   * editor addition). Set by NPCManager.buildStaticNpcs so editor tools can map
   * this LIVE, possibly-wandered instance back to the placement it came from.
   * null for spawner-pool roamers and traffic cars (not editable placements).
   */
  placementKey: string | null = null;

  /**
   * Gift (item-container) state — set by NPCManager via Gifts.tagGift when this
   * placement has a catalog entry (any container: present, trash can, jar, …).
   * `giftItem` is the item inside (null = unresolved special), `giftRomFlag` the
   * ROM Event Flag (its identity, → per-player flag). `giftOpenedAt` is the
   * epoch-ms the container was opened (0 = unopened); set by Gifts.beginGiftOpen
   * on the server's confirmation, which also flips it to its open North frame.
   */
  giftItem: number | null | undefined = undefined;
  giftRomFlag: number | undefined = undefined;
  giftOpenedAt = 0;

  /** True if this placement is an openable present box. */
  get isGift(): boolean {
    return this.giftRomFlag != null;
  }

  /** True if this placement is a telephone — talking to it triggers a save. */
  get isPhone(): boolean {
    return PHONE_SPRITE_GROUPS.has(this.spriteGroupId);
  }

  /** True if this placement is an ATM — talking to it opens the bank menu. */
  get isAtm(): boolean {
    return ATM_SPRITE_GROUPS.has(this.spriteGroupId);
  }

  /** True if this is Ness's mom — talking cooks the player's favorite food. */
  get isMom(): boolean {
    return this.spriteGroupId === MOM_SPRITE_GROUP;
  }

  constructor(
    x: number,
    y: number,
    spriteGroupId: number,
    direction: Direction,
    kind: NPCKind,
    textId: number | null = null
  ) {
    super(x, y, spriteGroupId);
    this.direction = direction;
    this.kind = kind;
    this.textId = textId;
  }

  /**
   * No HP left — hidden + non-solid. Enemies: killed or an inactive spawner
   * slot. People: a townsperson an enemy downed (revives at home server-side).
   * Cars: a destroyed vehicle (revives at its route start server-side). Props
   * carry no HP and never report dead.
   */
  get dead(): boolean {
    return (this.kind === 'enemy' || this.kind === 'person' || this.kind === 'car') && this.hp <= 0;
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
    pose: Pose = 'walk'
  ): void {
    this.x = x;
    this.y = y;
    this.direction = direction;
    this.frame = frame;
    this.pose = pose;
  }
}
