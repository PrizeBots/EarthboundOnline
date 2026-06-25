/**
 * NPCManager — loads the ROM NPC placements (tools/extract_npcs.py ->
 * /assets/map/npcs.json) and serves the ones near the player. NPCs are
 * bucketed into the same 256x256 area grid the ROM uses; sprite sheets are
 * lazy-loaded as their owners first come near (drawSprite skips entities
 * whose sheet hasn't arrived yet, so loading never blocks a frame).
 */

import { loadJSON } from './AssetLoader';
import { loadSpriteGroup, getSpriteGroupMeta } from './SpriteManager';
import { NPC, NPCKind } from './NPC';
import { spawnDamageNumber } from './Emitter';
import { noteHealthDamage } from './HealthRoll';
import { FLASH_MS } from './Juice';
import { playEventSfxAt } from './SfxEvents';
import { spawnDeathBody } from './DeathFx';
import { Direction, POSES } from '../types';
import type { NpcUpdate } from './Network';
import {
  createInterpolator,
  adaptiveDelay,
  registerNpcInterp,
  applyPredOffset,
  injectPredOffset,
} from './RemoteInterp';
import { checkPlayerCollision } from './Collision';
import { loadShops, shopStoreForNpc } from './Shop';
import { DEFAULT_ENTITY_STATS, DEFAULT_BEHAVIOR_RANGES } from './EntityStats';
import type { EntityCol, EntityProps, EntityPropsOverride, EntityDefs } from './EntityStats';
import { hasFlag } from './PlayerFlags';
import { loadGifts, tagGift, giftAdditions, giftForKey, GIFT_SPRITE_CLOSED } from './Gifts';

/** ROM NPC config id from a placement key "areaIdx:npcId:occ", or -1. */
function npcIdFromKey(k: string | undefined): number {
  if (!k) return -1;
  const parts = k.split(':');
  return parts.length >= 2 ? parseInt(parts[1], 10) : -1;
}

// Smooth NPC/enemy motion the same way remote players glide. NPCs broadcast at
// ~30Hz (BROADCAST_HZ, ~33ms — 60Hz overloaded the prod box). The delay is adaptive
// (tracks jitter): floor ~80ms gives ~2.4 packets bracketing the render cursor so
// enemies stay smooth on a real WAN link; ceil 150ms is the safety ceiling.
// registerNpcInterp exposes this delay so Network's ping can report it for melee
// lag-comp. Separate instance so numeric NPC ids can't collide with player ids.
const npcInterp = createInterpolator({ delay: adaptiveDelay(33, 80, 150) });
registerNpcInterp(npcInterp);

export interface RawNPC {
  /** Stable placement identity (extract_npcs.py) — the overrides key. */
  k?: string;
  x: number;
  y: number;
  sprite: number;
  dir: number;
  kind: NPCKind;
  /** NPC config id keying npc_text.json (present only when it has dialogue). */
  t?: number;
  /** Sparse PER-INSTANCE property override (Placement tool). Folded in by
   *  resolveProps over the sprite-group/kind defaults. Absent fields inherit.
   *  KEEP IN SYNC with server/npcSim.js (reads `r.props`). */
  props?: EntityPropsOverride;
  /** Set by mergeNpcOverrides on editor edits/additions: their explicit `kind` is
   *  authoritative (not force-upgraded to enemy by the enemy-sprite heuristic). */
  _authored?: boolean;
}

/**
 * Editor-authored placement overrides (public/overrides/npcs.json — OUR data,
 * never ROM-derived). `edits` maps a base entry's `k` to a full replacement,
 * or null to delete; `additions` are net-new placements appended after the
 * base list. KEEP IN SYNC with server/npcSim.js mergeNpcOverrides — both
 * sides must produce identical arrays (array index = wire id).
 */
export interface NpcOverrides {
  version: number;
  edits?: Record<string, Omit<RawNPC, 'k'> | null>;
  additions?: Omit<RawNPC, 'k'>[];
}

export function mergeNpcOverrides(base: RawNPC[], ov: NpcOverrides | null): (RawNPC | null)[] {
  const merged: (RawNPC | null)[] = base.map((e) => {
    const o = e.k !== undefined ? ov?.edits?.[e.k] : undefined;
    if (o === null) return null; // deleted — slot kept so wire ids align
    if (o) return { ...o, k: e.k, _authored: true };
    return e;
  });
  for (const a of ov?.additions ?? []) merged.push({ ...a, _authored: true });
  return merged;
}

const AREA_PX = 256;
const AREA_COLS = 32;
// How many areas around the player's area to consider "near" (2 covers the
// whole screen plus generous margin at 256px per area).
const NEAR_RANGE = 2;

// NPC foot box, matching the player's box and the server's npcSim COL_* values.
// Position is sprite center-x / feet-y, the same anchor the player uses.
const NPC_COL_W = 14;
const NPC_COL_H = 8;
const NPC_COL_OY = -8;

const npcsByArea = new Map<number, NPC[]>();
// Live static NPC instances keyed by placement key (RawNPC.k for base, "+i" for
// the i-th editor addition) — lets editor tools hit-test the LIVE sprite (which
// may have wandered from its spawn/home spot) and map it back to its placement.
const npcByKey = new Map<string, NPC>();
// JSON array index = wire id used by the server's npc_update / npc_hp messages.
// Null slots are override-deleted placements (kept so indexes stay aligned).
let npcsById: (NPC | null)[] = [];
const requestedSheets = new Set<number>();
// Decoded ROM dialogue, keyed by NPC config id (see tools/extract_npcs.py).
let npcText: Record<string, string[]> = {};
// Enemy classification + default HP, captured at load so a live reload (after
// the editor saves npcs.json) can rebuild the static placements identically.
let enemySpriteSet = new Set<number>();
let enemyDefaultHp = 24;

// Spawner-pool enemies (our own enemy_spawns.json). They wander town-wide, so
// they're tracked in a flat list rather than the home-keyed area buckets, and
// start hidden (hp 0) until the server activates them. ROM-placed enemies
// (sharks in npcs.json) live in the normal buckets like townsfolk.
const roamers: NPC[] = [];

// Traffic cars (our own car_traffic.json). Like roamers they drive town-wide,
// so they're a flat list rather than home-keyed buckets. Each enabled vehicle
// with a real route (>=2 waypoints) is ONE appended slot; the server moves it
// along the route and broadcasts position like any other actor.
const cars: NPC[] = [];

interface EnemyConfig {
  enemySpriteGroups?: number[];
  // per-entity stats (Entity Manager). The full shared shape is stored; the
  // client only READS hp (health bar) + col (collision), but carries the rest
  // so the cascade stays faithful and future use is one field away.
  entities?: Record<string, EntityPropsOverride>;
  // Spawners carry the shared shape inline (their instance-override layer) plus
  // spawn-rate/placement extras.
  spawners?: (EntityPropsOverride & {
    sprite: number;
    x: number;
    y: number;
    poolSize?: number;
    enabled?: boolean;
  })[];
}

// ROM-derived enemy catalog (tools/extract_enemies.py -> assets/map/enemies.json):
// the DEFAULTS layer of per-entity stats. Merged UNDER the authored entities.
// KEEP merge order IN SYNC with server/npcSim.js: DEFAULT < catalog < authored.
interface EnemyCatalog {
  bySprite?: Record<string, EntityPropsOverride>;
}
// Effective per-entity stats, sprite -> props: catalog overlaid by authored
// entities. Built in loadNPCs; the client reads hp (health bars) and col.
const entityDefs = new Map<number, EntityPropsOverride>();

// Resolve the SHARED entity props through the cascade — kind default ->
// sprite-group entity table -> instance override (a placement's `props` OR a
// spawner). This is the CLIENT SUBSET: the client only consumes hp (health-bar
// denominator) and col (collision), so it resolves just those two. The instance
// layer wins. KEEP order + defaults IN SYNC with server/npcSim.js resolveProps.
// Default enemy level when neither the placement nor the catalog sets one.
// KEEP IN SYNC with server/npcSim.js DEFAULT_ENEMY_LEVEL.
const DEFAULT_ENEMY_LEVEL = 4;

function resolveProps(
  kind: NPCKind,
  sprite: number,
  over?: EntityPropsOverride
): { hp: number; col?: EntityCol; level: number } {
  const o = over ?? {};
  const ent = entityDefs.get(sprite);
  // UNIVERSAL cascade (mirrors server/npcSim.js resolveProps): the entity table
  // feeds EVERY kind; the kind value below is just the floor default. Client only
  // consumes hp (bar denominator), col, and level. (instance > entity > kind.)
  const hpFloor =
    kind === 'car'
      ? VEHICLE_DEFAULT_HP
      : kind === 'enemy'
        ? enemyDefaultHp
        : kind === 'person'
          ? NPC_DEFAULT_HP
          : 0; // props are inert
  const hp = o.hp ?? ent?.hp ?? hpFloor;
  const level = o.level ?? ent?.level ?? (kind === 'enemy' ? DEFAULT_ENEMY_LEVEL : 1);
  const col = o.col ?? ent?.col;
  return { hp, col, level };
}

/** Resolved sprite-group + kind baseline for a sprite, WITHOUT the per-instance
 *  layer — the inherited values an editor shows as placeholders. Reuses the
 *  already-merged entityDefs (ROM catalog + authored), so no extra loading. */
export function entityBaseline(kind: NPCKind, sprite: number): EntityProps {
  const ent = entityDefs.get(sprite) ?? {};
  // Mirror resolveProps' floors so the placeholder matches the resolved value:
  // the entity table wins, falling back to the per-kind floor.
  const hpFloor =
    kind === 'car'
      ? VEHICLE_DEFAULT_HP
      : kind === 'enemy'
        ? enemyDefaultHp
        : kind === 'person'
          ? NPC_DEFAULT_HP
          : 0;
  const hp = ent.hp ?? hpFloor;
  const level = ent.level ?? (kind === 'enemy' ? DEFAULT_ENEMY_LEVEL : 1);
  return { ...DEFAULT_ENTITY_STATS, ...DEFAULT_BEHAVIOR_RANGES, ...ent, hp, level };
}

// Exact per-direction collision boxes for vehicles (tools/extract_vehicle_colboxes.py
// -> sprites/colboxes.json): spriteId -> dir (0-7) -> box. A car collides by the
// real shape of the frame it's currently facing, not the padded sprite cell.
// KEEP IN SYNC with server/npcSim.js (same file, same lookup).
let carColBoxes: Record<string, Record<string, EntityCol>> = {};
// Manual per-sprite-group box overrides authored in the Entity Manager
// (enemy_spawns.json entities[*].col) — top priority when present.
const entityCols = new Map<number, EntityCol>();

// A vehicle shares the common EntityProps base (hp/damage/speed/col/… resolve
// through the same cascade — see resolveProps) and ADDS its vehicle-only extras
// below. So `hp`/`damage`/`speed` are inherited from EntityPropsOverride: hp →
// VEHICLE_HP, damage → VEHICLE_DAMAGE, speed → 1 (a route ×multiplier, NOT px/tick
// — see EntityProps.speed). The extras are the route + collision box.
export interface Vehicle extends EntityPropsOverride {
  id: string;
  name: string;
  sprite: number;
  /** Collision box (px), derived from the sprite size when authored. */
  w?: number;
  h?: number;
  loop: boolean;
  enabled: boolean;
  /** Facing (0-7) for a PARKED car (1 waypoint). Driving cars derive it from the
   *  route, so it's only authored/used when there's no route. Omitted → South. */
  dir?: number;
  waypoints: [number, number][];
  /** textId keying npc_text.json — a vehicle can be talkable like any NPC. */
  t?: number | null;
}
export interface CarTraffic {
  version: number;
  vehicles?: Vehicle[];
}

/** Default max HP for a traffic car with no authored hp — mirrors npcSim VEHICLE_HP. */
const VEHICLE_DEFAULT_HP = 80;

/** Default max HP for a townsperson with no authored hp — mirrors npcSim NPC_HP. */
const NPC_DEFAULT_HP = 30;

/** Vehicles that produce a live car slot — KEEP IN SYNC with npcSim.js.
 *  >=1 waypoint: a single point is a PARKED car; 2+ drive the route. */
function activeVehicles(cfg: CarTraffic | null): Vehicle[] {
  return (cfg?.vehicles ?? []).filter(
    (v) => v.enabled !== false && Array.isArray(v.waypoints) && v.waypoints.length >= 1
  );
}

/**
 * A flag-conditional dialogue entry: the engine picks `ifSet` or `ifClear` at
 * talk time by checking the player's flag (PlayerFlags). This is how an NPC
 * (e.g. Ness's mom) says one thing for a new player and another after an event.
 * Authored by the Flag/Dialogue editors; resolved in getNpcDialogue.
 */
export interface DialogueBranch {
  flag: number;
  ifSet: string[];
  ifClear: string[];
}

function isBranch(v: string[] | DialogueBranch | null): v is DialogueBranch {
  return v != null && !Array.isArray(v) && typeof (v as DialogueBranch).flag === 'number';
}

/**
 * Dialogue Editor override (public/overrides/dialogue.json — OUR authored text).
 * `edits` maps a textId to replacement pages, a flag-conditional branch, or
 * null to revert that entry to the decoded base. Merged over npc_text.json so
 * re-running eb_dialogue.py never clobbers authoring.
 */
export interface DialogueOverrides {
  version: number;
  edits?: Record<string, string[] | DialogueBranch | null>;
}

// Conditional entries, split out of the flat npcText at merge time and resolved
// against PlayerFlags in getNpcDialogue. Keyed by textId (string).
let npcBranches = new Map<string, DialogueBranch>();

/**
 * Merge authored overrides onto the decoded base. Flat pages go into the
 * returned record (back-compat); conditional branches are pulled into
 * `npcBranches` and win over any flat entry for that id. Rebuilds `npcBranches`
 * each call, so it must run on every (re)load of dialogue.
 */
function mergeDialogue(
  base: Record<string, string[]>,
  ov: DialogueOverrides | null
): Record<string, string[]> {
  npcBranches = new Map();
  const merged = { ...base };
  for (const [id, val] of Object.entries(ov?.edits ?? {})) {
    if (val === null) {
      delete merged[id];
    } else if (isBranch(val)) {
      npcBranches.set(id, val);
      delete merged[id]; // the branch resolver supplies this id's pages
    } else {
      merged[id] = val;
    }
  }
  return merged;
}

/** Re-merge npc_text + dialogue override (Dialogue Editor live refresh). */
export async function reloadNpcText(): Promise<void> {
  const [base, ov] = await Promise.all([
    loadJSON<Record<string, string[]>>('/assets/map/npc_text.json'),
    loadJSON<DialogueOverrides>('/overrides/dialogue.json').catch(() => null),
  ]);
  npcText = mergeDialogue(base, ov);
}

export async function loadNPCs(): Promise<void> {
  await loadShops(); // clerk->store map must be ready before we tag NPCs below
  const [
    raw,
    overrides,
    text,
    dialogueOv,
    entitiesOv,
    enemyOv,
    enemyBase,
    enemyCatalog,
    carOv,
    carBase,
    colBoxes,
  ] = await Promise.all([
    loadJSON<RawNPC[]>('/assets/map/npcs.json'),
    // Editor-authored placement overrides — absent until something is authored.
    loadJSON<NpcOverrides>('/overrides/npcs.json').catch(() => null),
    loadJSON<Record<string, string[]>>('/assets/map/npc_text.json'),
    // Dialogue Editor override — authored pages win over the decoded text.
    loadJSON<DialogueOverrides>('/overrides/dialogue.json').catch(() => null),
    // UNIVERSAL entity master table (Entity Manager → overrides/entities.json).
    // Stats for EVERY kind. KEEP IN SYNC with server/npcSim.js loadEntities.
    loadJSON<{ entities?: EntityDefs }>('/overrides/entities.json').catch(() => null),
    // Enemy spawners: editor-authored override (Enemy Spawner tool) wins over
    // the committed default. KEEP IN SYNC with server/npcSim.js — both build
    // the same pool (disabled spawners skipped) so wire ids stay aligned.
    loadJSON<EnemyConfig>('/overrides/enemy_spawns.json').catch(() => null),
    loadJSON<EnemyConfig>('/assets/map/enemy_spawns.json').catch(() => ({}) as EnemyConfig),
    // ROM-derived enemy catalog (stat defaults). Absent until extracted.
    loadJSON<EnemyCatalog>('/assets/map/enemies.json').catch(() => null),
    // Traffic (Traffic Editor) — override wins over the committed default. KEEP
    // IN SYNC with server/npcSim.js (same active-vehicle filter so ids align).
    loadJSON<CarTraffic>('/overrides/car_traffic.json').catch(() => null),
    loadJSON<CarTraffic>('/assets/map/car_traffic.json').catch(
      () => ({ version: 1 }) as CarTraffic
    ),
    // Precomputed per-direction vehicle collision boxes (build artifact).
    loadJSON<Record<string, Record<string, EntityCol>>>('/assets/sprites/colboxes.json').catch(
      () => ({})
    ),
  ]);
  const enemyCfg = enemyOv ?? enemyBase;
  carColBoxes = colBoxes ?? {};

  // Effective per-entity stats = ROM catalog (defaults) overlaid by the authored
  // entity table. The table now lives in overrides/entities.json (Entity Manager);
  // fall back to the legacy enemy_spawns.json `entities` for pre-split saves.
  // KEEP merge order IN SYNC with server/npcSim.js buildEntityDefs.
  entityDefs.clear();
  const cat = enemyCatalog?.bySprite ?? {};
  const authored = entitiesOv?.entities ?? enemyCfg.entities ?? {};
  for (const sprite of new Set([...Object.keys(cat), ...Object.keys(authored)])) {
    entityDefs.set(Number(sprite), { ...cat[sprite], ...authored[sprite] });
  }
  // Per-sprite collision box overrides (Entity Manager) — col wins over kind default.
  entityCols.clear();
  for (const [sprite, def] of entityDefs) {
    if (def.col) entityCols.set(sprite, def.col);
  }
  npcText = mergeDialogue(text, dialogueOv);
  roamers.length = 0;
  cars.length = 0;

  enemySpriteSet = new Set(enemyCfg.enemySpriteGroups ?? []);
  enemyDefaultHp = enemyCfg.spawners?.[0]?.hp ?? 24;

  // Gift catalog (present contents + flags) — loaded before building so
  // buildStaticNpcs can tag present-box props as gifts.
  await loadGifts();

  // ROM placements + authored overrides (sprite groups marked hostile in
  // enemy_spawns.json become kind 'enemy').
  npcsById = buildStaticNpcs(raw, overrides);

  // Spawner pool appended AFTER the ROM placements so wire ids match the
  // server, which builds the same pool from the same file. Each starts dead
  // (hp 0 = hidden) until activated via npc_hp.
  let id = npcsById.length;
  for (const sp of enemyCfg.spawners ?? []) {
    if (sp.enabled === false) continue; // disabled spawner: no pool (server skips it too)
    // maxHp drives the health bar — resolved through the cascade (the spawner is
    // the instance-override layer for the enemies it prints).
    const sprops = resolveProps('enemy', sp.sprite, sp);
    const maxHp = sprops.hp;
    for (let i = 0; i < (sp.poolSize ?? 0); i++) {
      const npc = new NPC(sp.x, sp.y, sp.sprite, Direction.N, 'enemy', null);
      npc.applyHp(0, maxHp);
      npc.level = sprops.level; // weight-class push (blockedByNPC)
      npcsById[id++] = npc;
      roamers.push(npc);
    }
  }

  // Traffic cars appended AFTER the enemy pool, one slot per active vehicle, in
  // file order — the server builds the same pool so wire ids line up. Each car
  // starts at its first waypoint; the server drives it from there.
  for (const v of activeVehicles(carOv ?? carBase)) {
    const [sx, sy] = v.waypoints[0];
    // A vehicle is a car NPC: parked (1 waypoint) or driving (2+). It may also be
    // talkable (carries a textId), e.g. EB's parked cars with a line of dialogue.
    // A car is a combatant: it carries HP (so its bar has a denominator; the
    // server is authoritative and sends npc_hp deltas) and is attackable under PK
    // rules. Initial facing = authored v.dir (essential for a PARKED car, which
    // the server never re-faces); a driving car is re-faced by npc_update deltas.
    const face = (v.dir ?? Direction.S) as Direction;
    const car = new NPC(sx, sy, v.sprite, face, 'car', v.t ?? null);
    const maxHp = resolveProps('car', v.sprite, v).hp;
    car.applyHp(maxHp, maxHp);
    npcsById[id++] = car;
    cars.push(car);
  }

  console.log(
    `Loaded ${npcsById.length} NPCs (${roamers.length} enemy slots, ${cars.length} cars)`
  );
}

/**
 * Build the static (ROM + override) placements into npcsById/npcsByArea and
 * return them. Shared by loadNPCs and reloadNpcsLive so both classify enemies
 * and bucket identically. Clears the area buckets (static only; roamers are
 * tracked separately).
 */
function buildStaticNpcs(raw: RawNPC[], overrides: NpcOverrides | null): (NPC | null)[] {
  npcsByArea.clear();
  npcByKey.clear();
  // Additions (no base `k`) are keyed "+i" in merge order, matching the editor's
  // own addition numbering (PlacementTool.loadAll) so a live add maps back.
  let addIdx = 0;
  const arr = mergeNpcOverrides(raw, overrides).map((r) => {
    if (!r) return null; // override-deleted slot
    // A placement with a gift-catalog entry (present/trash can/jar/…) is an
    // item-container — kind 'gift' (behaves like a prop, but labelled). Else:
    // enemy if explicitly placed as one (PlacementTool) OR a legacy enemy
    // sprite. KEEP IN SYNC with server/npcSim.js isEnemyPlacement.
    const kind: NPCKind = giftForKey(r.k ?? null)
      ? 'gift'
      : r.kind === 'enemy'
        ? 'enemy'
        : r._authored
          ? r.kind // editor edit/addition: explicit kind wins over the heuristic
          : enemySpriteSet.has(r.sprite)
            ? 'enemy'
            : r.kind;
    const npc = new NPC(r.x, r.y, r.sprite, r.dir as Direction, kind, r.t ?? null);
    const props = resolveProps(kind, r.sprite, r.props);
    npc.level = props.level; // weight-class push (blockedByNPC)
    if (kind === 'enemy') npc.applyHp(props.hp, props.hp);
    // Shop clerks (by ROM config id) carry the store they sell — Game.tryTalk
    // opens the shop instead of dialogue. Custom/override NPCs have no ROM id.
    if (kind === 'person') npc.shopStore = shopStoreForNpc(npcIdFromKey(r.k));
    npc.placementKey = r.k !== undefined ? r.k : `+${addIdx++}`;
    npcByKey.set(npc.placementKey, npc);
    tagGift(npc); // present boxes (sprite 195) with a catalog entry become gifts
    return npc;
  });
  for (const npc of arr) {
    if (!npc) continue;
    const area = Math.floor(npc.y / AREA_PX) * AREA_COLS + Math.floor(npc.x / AREA_PX);
    let bucket = npcsByArea.get(area);
    if (!bucket) {
      bucket = [];
      npcsByArea.set(area, bucket);
    }
    bucket.push(npc);
  }
  // Admin-placed gift boxes (Gift Manager additions) aren't ROM placements, so
  // spawn a present-box prop for each. Added to the area buckets + npcByKey (so
  // they render, open, and resolve via liveNpcForKey) but deliberately NOT to
  // `arr`/npcsById — that array is wire-indexed and must stay aligned with the
  // server's enemy/car pool, which knows nothing about authored gifts.
  for (const g of giftAdditions()) {
    if (npcByKey.has(g.k)) continue; // never shadow a real placement
    const npc = new NPC(g.x, g.y, g.sprite ?? GIFT_SPRITE_CLOSED, Direction.S, 'gift', null);
    npc.placementKey = g.k;
    npcByKey.set(g.k, npc);
    tagGift(npc);
    const area = Math.floor(g.y / AREA_PX) * AREA_COLS + Math.floor(g.x / AREA_PX);
    let bucket = npcsByArea.get(area);
    if (!bucket) {
      bucket = [];
      npcsByArea.set(area, bucket);
    }
    bucket.push(npc);
  }
  return arr;
}

/**
 * Re-apply NPC placements live after the editor saves overrides/npcs.json —
 * the NPC counterpart to saveDoors()→loadDoors(). Rebuilds the static (ROM +
 * override) placements so adds/edits/deletes show immediately on toggling out
 * of the editor, then re-appends the EXISTING enemy pool instances (preserving
 * their live HP/positions) after the static list so active sharks aren't reset.
 * Wire ids realign with the server once its own ~2s file-watch reload runs.
 */
export async function reloadNpcsLive(): Promise<void> {
  const [raw, overrides] = await Promise.all([
    loadJSON<RawNPC[]>('/assets/map/npcs.json'),
    // saveOverride() primed this cache entry with the just-saved data.
    loadJSON<NpcOverrides>('/overrides/npcs.json').catch(() => null),
  ]);
  await loadGifts(); // re-pull authored gift contents so re-tagging is current
  npcsById = buildStaticNpcs(raw, overrides);
  let id = npcsById.length;
  for (const npc of roamers) npcsById[id++] = npc;
  // Cars sit after the enemy pool — re-append the existing instances so wire
  // ids stay aligned and live cars keep their positions across the reload.
  for (const car of cars) npcsById[id++] = car;
}

/** Apply authoritative enemy HP (welcome snapshot + on-damage deltas). */
export function applyNpcHp(rows: [number, number, number][]): void {
  for (const [id, hp, maxHp] of rows) {
    const npc = npcsById[id];
    if (!npc) continue;
    const prev = npc.hp;
    npc.applyHp(hp, maxHp);
    // Pop a damage number on a real hit. Guard prev > 0 so the join snapshot
    // (0 -> full HP on inactive pool slots) and respawns don't spawn numbers.
    if (prev > 0 && hp < prev) {
      const dmg = prev - hp;
      const now = Date.now();
      noteHealthDamage(npc, prev, performance.now()); // roll the bar: hold, flash, drain
      spawnDamageNumber(npc.x, npc.y, dmg);
      // Flash the struck sprite white — always; it's harmless cosmetic feedback for
      // every hit, ours or not. The freeze + shake juice is NOT fired here: it rides
      // a server-confirmed 'hit' combat event (Game.onCombat) so only YOUR landed
      // swings rattle your screen — never an off-screen brawl during your air-swing.
      npc.flashUntil = now + FLASH_MS;
    }
    // Died/hidden: clear its interp buffer so a later respawn (which teleports
    // it back to its spawn point) starts fresh instead of gliding across town.
    // Positional death sfx, but only on a real kill (prev > 0 skips the join
    // snapshot / inactive-slot 0 -> 0 noise).
    if (hp <= 0) {
      if (prev > 0) playEventSfxAt('enemy-die', npc.x, npc.y);
      npcInterp.drop(String(id));
    }
  }
}

/**
 * A combatant died (server `npc_death`): play the rotate-and-bounce death throw
 * from its current on-screen visual, flung along (dx,dy) by `force` (see DeathFx).
 * Captured BEFORE the batched npc_hp delta hides the live slot — but even if that
 * arrives first the NPC object still holds its sprite/position, so this is robust
 * to message ordering. Gated by the entity's class-level `rotateOnDeath` flag.
 */
export function applyNpcDeath(id: number, dx: number, dy: number, force: number): void {
  const npc = npcsById[id];
  if (!npc || !npc.rotateOnDeath) return;
  spawnDeathBody({
    x: npc.x,
    y: npc.y,
    groupId: npc.spriteGroupId,
    direction: npc.direction,
    frame: npc.frame,
    pose: npc.pose,
    itemId: npc.itemId,
    dx,
    dy,
    force,
  });
}

/** Apply server status-set deltas to actors: [id, [statusId,…]] → npc.statuses. */
export function applyNpcStatus(rows: [number, string[]][]): void {
  for (const [id, statuses] of rows) {
    const npc = npcsById[id];
    if (npc) npc.statuses = statuses;
  }
}

/** Apply server held-item deltas: [id, itemId|null] → npc.itemId (weapon sprite). */
export function applyNpcEquip(rows: [number, string | null][]): void {
  for (const [id, itemId] of rows) {
    const npc = npcsById[id];
    if (npc) npc.itemId = itemId;
  }
}

/** Dialogue pages for an NPC, or null if it has nothing to say. */
export function getNpcDialogue(npc: NPC): string[] | null {
  if (npc.textId == null) return null;
  const id = String(npc.textId);
  const branch = npcBranches.get(id);
  if (branch) return hasFlag(branch.flag) ? branch.ifSet : branch.ifClear;
  return npcText[id] ?? null;
}

/**
 * Inject/replace a flag-conditional branch at runtime (null clears it). Used by
 * the Flag Editor for live preview and by the dev flag console hook — bypasses
 * the override file so an admin can watch dialogue flip without a save/reload.
 */
export function setDialogueBranchLive(textId: string, branch: DialogueBranch | null): void {
  if (branch) npcBranches.set(textId, branch);
  else npcBranches.delete(textId);
}

/**
 * Apply authoritative positions from the server. Buckets are keyed by the
 * HOME position on purpose: wanderers are leashed within 32px of home, so
 * re-bucketing on movement is unnecessary.
 */
/** Live NPC by its wire id (the server's enemy/car-pool index), or null. */
export function npcById(id: number): NPC | null {
  return npcsById[id] ?? null;
}

/** Drop every buffered NPC interpolation snapshot. Call on (re)connect so a stale
 *  ghost position can't linger: the welcome snapshot then re-seeds each near NPC,
 *  and an empty buffer means that first row snaps directly (treated as "fresh")
 *  instead of gliding from the old chase spot. */
export function resetNpcInterp(): void {
  for (const id of [...npcInterp.ids()]) npcInterp.drop(id);
}

/** Server told us these NPCs left our view (npc_leave / AOI despawn) — hide them
 *  immediately instead of waiting on the staleness timeout. Mark stale + drop the
 *  interp buffer; an incoming update (re-entry) clears it via applyNpcUpdates. */
export function markNpcsGone(ids: number[]): void {
  for (const id of ids) {
    const npc = npcsById[id];
    if (npc) npc.stale = true;
    npcInterp.drop(String(id));
  }
}

export function applyNpcUpdates(rows: NpcUpdate[], t?: number): void {
  for (const [id, x, y, dir, frame, poseCode] of rows) {
    const npc = npcsById[id];
    if (!npc) continue;
    // Reconcile a missed activation: the server only broadcasts movement for
    // LIVE actors (npcSim send loop guards `!n.dead`), so a movement row for an
    // enemy we still think is dead means we dropped its one-shot `npc_hp`
    // activation (e.g. it fired during our async NPC-pool load, before this
    // instance existed). Left dead, the enemy is skipped by both getNearbyNPCs
    // (invisible) and interpolateNpcs (position frozen at spawn) while the
    // server happily chases/door-warps it onto us and lands real hits — the
    // "invisible attacker after a door" bug. Revive it provisionally; the next
    // `npc_hp` delta corrects the bar.
    if ((npc.kind === 'enemy' || npc.kind === 'car') && npc.dead) npc.applyHp(npc.maxHp, npc.maxHp);
    const pose = POSES[poseCode ?? 0] ?? 'walk';
    const key = String(id);
    // Buffer the snapshot for smooth interpolation (see interpolateNpcs). The
    // FIRST snapshot after appearing/respawning snaps the position directly so
    // the NPC doesn't glide in from a stale spot; later ones interpolate.
    const fresh = !npcInterp.has(key);
    npcInterp.push(key, x, y, dir as Direction, frame, pose, t);
    if (fresh) npc.applyServerState(x, y, dir as Direction, frame, pose);
    // Got an authoritative position → this NPC is genuinely in view; clear any
    // ghost-staleness so it renders again (see interpolateNpcs / NPC.stale).
    npc.lastUpdateAt = performance.now();
    npc.stale = false;
  }
}

/**
 * Advance every buffered NPC/enemy to its interpolated position for this frame.
 * Call once per frame (alongside the remote-player interpolation), so server
 * NPCs glide between 10Hz snapshots instead of stepping once per packet.
 */
// No server position update in this long → the actor left our view on the server
// (its real position is elsewhere, so the near-player resync heartbeat doesn't
// refresh our copy). Hide the frozen ghost instead of leaving it until a death/
// despawn lands. ~3.5 heartbeats (200ms) of margin so a live nearby NPC never trips.
const STALE_HIDE_MS = 700;

export function interpolateNpcs(): void {
  const now = performance.now();
  for (const key of npcInterp.ids()) {
    const npc = npcsById[Number(key)];
    if (!npc || npc.dead) continue;
    // Ghost guard: flag NPCs we've stopped hearing about so the render/collision
    // filters skip them (see NPC.stale). Only ones that HAD updates can go stale.
    npc.stale = npc.lastUpdateAt > 0 && now - npc.lastUpdateAt > STALE_HIDE_MS;
    npcInterp.interpolate(key, npc); // authoritative (delayed) position → npc.x/y
    // Layer the client-predicted push/knockback lead on top, then bleed it off so
    // the authoritative stream reconciles it away (see RemoteInterp.applyPredOffset).
    applyPredOffset(npc);
  }
}

// --- Client-side walk-push prediction ---------------------------------------
// The server is authoritative for the shove, but its result only reaches us a
// broadcast + interp-delay later (~150ms) — long enough that plowing a crowd
// feels "loose" (you clip into bodies before they react). So we PREDICT it: the
// instant the local player overlaps a lighter person/enemy, nudge it aside
// locally via NPC.predOff (reconciled by interpolateNpcs). Mirrors the server's
// pushFromPlayers (mass gate, wall clamp, moving-only) so the prediction lands
// where the authoritative stream will — minimal correction when it arrives.
const PRED_PUSH_STEP = 1.4; // px/frame local nudge (≈ server PLOW_STEP at 60fps vs 20Hz tick)
const PRED_PUSH_MAX_LEAD = 12; // px — cap how far a push prediction runs ahead of the server

// Melee swing hitbox + enemy hurtbox — MIRROR of server/npcSim.js handleAttack so
// the client predicts knockback on exactly the enemies the server will hit. KEEP
// these values IN SYNC with that file (DIR_VEC/ATTACK_REACH/ATTACK_HALF/HURT_*).
const DIAG = Math.SQRT1_2;
const DIR_VEC: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
  [-DIAG, -DIAG],
  [-DIAG, DIAG],
  [DIAG, DIAG],
  [DIAG, -DIAG],
];
const ATTACK_REACH = 14;
const ATTACK_HALF = 8;
const HURT_W = 14;
const HURT_H = 18;
const HURT_OY = -18;
const PRED_HIT_KB = 10; // px base predicted recoil for a connecting swing (server reconciles exact)
const PRED_HIT_MAX_LEAD = 26; // px — knockback leads further than a push, but still capped
// Weight-class recoil scale (mirrors server massKnockScale): a heavier attacker
// flings a lighter victim further, a much lighter one barely rocks it.
function massScale(attLevel: number, vicLevel: number): number {
  const a = 1 + Math.max(0, attLevel);
  const v = 1 + Math.max(0, vicLevel);
  return Math.max(0.15, Math.min(2, (2 * a) / (a + v)));
}

/** NPC foot box (manual Entity Manager override or the default), mirroring
 *  blockedByNPC / the server actorBox. */
function footBox(npc: NPC): [number, number, number, number] {
  const m = entityCols.get(npc.spriteGroupId);
  return m
    ? [npc.x + m.offX - m.w / 2, npc.y + m.offY - m.h, m.w, m.h]
    : [npc.x - NPC_COL_W / 2, npc.y + NPC_COL_OY, NPC_COL_W, NPC_COL_H];
}

/** Run `fn` over every live person/enemy NPC near (px,py) — the ±1 area sweep
 *  plus the town-wide roamer pool (same coverage as blockedByNPC). */
function forNearbyActors(px: number, py: number, fn: (npc: NPC) => void): void {
  const ax = Math.floor(px / AREA_PX);
  const ay = Math.floor(py / AREA_PX);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = npcsByArea.get((ay + dy) * AREA_COLS + (ax + dx));
      if (bucket) for (const npc of bucket) fn(npc);
    }
  }
  for (const npc of roamers) fn(npc);
}

/**
 * Predict the local player's walk-push on nearby NPCs. Call once per frame AFTER
 * the player has moved, with the player's foot-box center (x,y), level, and
 * whether they actually moved this frame. Injects a decaying predicted offset on
 * any person/enemy the player outweighs and overlaps — instant, server-reconciled.
 */
export function predictPlayerPush(
  px: number,
  py: number,
  pusherLevel: number,
  moving: boolean
): void {
  if (!moving) return; // a standing player isn't a repulsion aura (matches server)
  const fx = px - NPC_COL_W / 2;
  const fy = py + NPC_COL_OY;
  forNearbyActors(px, py, (npc) => {
    if (npc.dead || (npc.kind !== 'person' && npc.kind !== 'enemy')) return;
    if (pusherLevel <= npc.level) return; // only plow strictly-lighter bodies
    const [nx, ny, nw, nh] = footBox(npc);
    if (!(fx < nx + nw && fx + NPC_COL_W > nx && fy < ny + nh && fy + NPC_COL_H > ny)) return;
    let dx = npc.x - px;
    let dy = npc.y - py;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) {
      // Exactly co-located — scatter on a stable per-id angle (mirrors server).
      const ang = ((Number(npc.placementKey ?? 0) % 16) / 16) * Math.PI * 2;
      dx = Math.cos(ang);
      dy = Math.sin(ang);
    } else {
      dx /= d;
      dy /= d;
    }
    // Wall-clamp: never predict a body into a wall the server wouldn't (that would
    // snap back on reconcile).
    const tx = nx + (npc.predOffX ?? 0) + dx * PRED_PUSH_STEP;
    const ty = ny + (npc.predOffY ?? 0) + dy * PRED_PUSH_STEP;
    if (!checkPlayerCollision(tx, ty, nw, nh)) {
      injectPredOffset(npc, dx, dy, PRED_PUSH_STEP, PRED_PUSH_MAX_LEAD);
    }
  });
}

/**
 * Predict the recoil of the local player's melee swing on enemies, so a struck
 * enemy lurches THIS frame instead of a network round-trip later. Mirrors the
 * server's handleAttack hitbox; the server still authoritatively resolves the hit
 * (dodge/crit/exact knockback) and the stream reconciles. Call on swing.
 */
export function predictMeleeKnockback(
  px: number,
  py: number,
  dir: number,
  attackerLevel: number
): void {
  const v = DIR_VEC[dir] ?? DIR_VEC[0];
  const hx = px + v[0] * ATTACK_REACH - ATTACK_HALF;
  const hy = py - 10 + v[1] * ATTACK_REACH - ATTACK_HALF;
  const hw = ATTACK_HALF * 2;
  const hh = ATTACK_HALF * 2;
  forNearbyActors(px, py, (npc) => {
    if (npc.dead || npc.kind !== 'enemy') return;
    const ex = npc.x - HURT_W / 2;
    const ey = npc.y + HURT_OY;
    if (!(hx < ex + HURT_W && hx + hw > ex && hy < ey + HURT_H && hy + hh > ey)) return;
    let dx = npc.x - px;
    let dy = npc.y - py;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) {
      dx = v[0];
      dy = v[1];
    } else {
      dx /= d;
      dy /= d;
    }
    const dist = PRED_HIT_KB * massScale(attackerLevel, npc.level);
    const [nx, ny, nw, nh] = footBox(npc);
    const tx = nx + (npc.predOffX ?? 0) + dx * dist;
    const ty = ny + (npc.predOffY ?? 0) + dy * dist;
    if (!checkPlayerCollision(tx, ty, nw, nh)) {
      injectPredOffset(npc, dx, dy, dist, PRED_HIT_MAX_LEAD);
    }
  });
}

/**
 * True if the AABB [x, y, w, h] overlaps a solid NPC's foot box. Only `person`
 * NPCs are solid (EB blocks the player against people); `prop` placements are
 * skipped — many are invisible interaction hotspots (phones, signs) whose
 * visible body already lives in the map collision (see ARCHITECTURE.md), so
 * treating them as solid would raise invisible walls. The local player calls
 * this alongside checkPlayerCollision so people block movement like in EB.
 *
 * Persons are leashed within 32px of their home, and buckets are keyed by home,
 * so a ±1 area sweep around the box center covers every person that could reach
 * the player's tiny foot box.
 */
// Optional current foot-box origin (curX, curY). A person the player ALREADY
// overlaps there is not treated as blocking, so a player who ends up embedded
// in an NPC — spawning on one, or a wanderer/server-teleport stepping onto them
// — can always walk back out instead of being trapped (every candidate move
// from inside the box would otherwise still overlap and be rejected).
/** World-space collision (foot) box `[x,y,w,h]` for a sprite group at (x,y):
 *  the authored Entity Manager `col` if present, else the default foot box.
 *  Mirrors blockedByNPC's people/enemy math. Used by the debug hitbox overlay
 *  (Renderer.drawDebugBoxes) so what's drawn matches what blocks movement. */
export function colBoxFor(sprite: number, x: number, y: number): [number, number, number, number] {
  const c = entityCols.get(sprite);
  if (c) return [x + c.offX - c.w / 2, y + c.offY - c.h, c.w, c.h];
  return [x - NPC_COL_W / 2, y + NPC_COL_OY, NPC_COL_W, NPC_COL_H];
}

/** True if this sprite group has an authored collision box (Entity Manager /
 *  harvested furniture). A `prop` with one is solid; without one it's walkable.
 *  Used by the debug overlay to decide whether to draw a prop's col box. */
export function hasEntityCol(sprite: number): boolean {
  return entityCols.has(sprite);
}

/** Set a sprite group's collision box live (Furniture Cutter), so a just-created
 *  furniture prop is solid + drawn immediately without a reload. Mirrors what
 *  loadNPCs builds from overrides/entities.json; the caller still persists it. */
export function setEntityCol(sprite: number, col: EntityCol): void {
  entityCols.set(sprite, col);
  entityDefs.set(sprite, { ...(entityDefs.get(sprite) ?? {}), col });
}

/** World-space whole-body box `[x,y,w,h]` for a VEHICLE (kind 'car') facing
 *  `dir` at (x,y), or null if its sprite sheet hasn't loaded. Priority mirrors
 *  blockedByNPC + the server's actorBox: manual Entity Manager `col` override,
 *  then the per-direction box from colboxes.json, then the full sprite cell.
 *  For a car this single box is BOTH its collision box and its hurtbox (the
 *  server's handleAttack tests a swing against actorBox) — the debug overlay
 *  (Renderer.drawDebugBoxes) draws it so you can see what a swing must overlap. */
export function carColBoxFor(
  sprite: number,
  dir: number,
  x: number,
  y: number
): [number, number, number, number] | null {
  const manual = entityCols.get(sprite);
  if (manual)
    return [x + manual.offX - manual.w / 2, y + manual.offY - manual.h, manual.w, manual.h];
  const perDir = carColBoxes[String(sprite)]?.[String(dir)];
  if (perDir)
    return [x + perDir.offX - perDir.w / 2, y + perDir.offY - perDir.h, perDir.w, perDir.h];
  const meta = getSpriteGroupMeta(sprite);
  if (!meta) return null; // sheet not loaded yet
  return [x - meta.width / 2, y - meta.height, meta.width, meta.height];
}

export function blockedByNPC(
  x: number,
  y: number,
  w: number,
  h: number,
  curX?: number,
  curY?: number,
  pusherLevel?: number
): boolean {
  const haveCur = curX !== undefined && curY !== undefined;
  // Solid for the player: live people, live enemies (sharks), and cars. Props
  // and dead enemies don't block. A body the player ALREADY overlaps doesn't
  // block, so an embedded player can always walk back out. Cars use their full
  // sprite rect (feet-anchored) as the obstacle; people/enemies use a foot box.
  const fromCol = (npc: NPC, c: EntityCol): [number, number, number, number] => [
    npc.x + c.offX - c.w / 2,
    npc.y + c.offY - c.h,
    c.w,
    c.h,
  ];
  const boxOf = (npc: NPC): [number, number, number, number] | null => {
    // Manual Entity Manager override wins for any entity.
    const manual = entityCols.get(npc.spriteGroupId);
    if (manual) return fromCol(npc, manual);
    if (npc.kind === 'car') {
      // Exact per-direction box (precomputed from the art); falls back to the
      // full sprite cell if this vehicle wasn't in colboxes.json.
      const perDir = carColBoxes[npc.spriteGroupId]?.[npc.direction];
      if (perDir) return fromCol(npc, perDir);
      const meta = getSpriteGroupMeta(npc.spriteGroupId);
      if (!meta) return null; // sheet not loaded yet — not solid this frame
      return [npc.x - meta.width / 2, npc.y - meta.height, meta.width, meta.height];
    }
    return [npc.x - NPC_COL_W / 2, npc.y + NPC_COL_OY, NPC_COL_W, NPC_COL_H];
  };
  const hits = (npc: NPC): boolean => {
    if (npc.dead || npc.stale) return false; // a ghost (stale) isn't solid — don't bump it
    // person/enemy/car are always solid. A `prop` is solid ONLY when it has an
    // authored col box (furniture, harvested into a placeable object): ROM props
    // without a col are invisible hotspots (phones/signs) whose body lives in the
    // map tile collision, so they stay walkable. KEEP IN SYNC with npcSim.
    const propSolid =
      (npc.kind === 'prop' || npc.kind === 'gift') && entityCols.has(npc.spriteGroupId);
    if (npc.kind !== 'person' && npc.kind !== 'enemy' && npc.kind !== 'car' && !propSolid)
      return false;
    // Weight-class walk-push: a heavier (higher-level) mover isn't blocked by a
    // lighter person/enemy — they walk INTO it and the server (pushFromPlayers)
    // shoves it aside. Cars and solid props never yield (furniture is fixed);
    // equal/heavier NPCs still block. KEEP the rule (strict >) IN SYNC with npcSim massOf.
    if (
      pusherLevel !== undefined &&
      npc.kind !== 'car' &&
      npc.kind !== 'prop' &&
      npc.kind !== 'gift' &&
      pusherLevel > npc.level
    ) {
      return false;
    }
    const box = boxOf(npc);
    if (!box) return false;
    const [nx, ny, nw, nh] = box;
    if (!(x < nx + nw && x + w > nx && y < ny + nh && y + h > ny)) {
      return false;
    }
    if (haveCur && curX! < nx + nw && curX! + w > nx && curY! < ny + nh && curY! + h > ny) {
      return false; // already inside at move start — let them leave
    }
    return true;
  };

  const ax = Math.floor((x + w / 2) / AREA_PX);
  const ay = Math.floor((y + h / 2) / AREA_PX);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cx >= AREA_COLS || cy < 0) continue;
      const bucket = npcsByArea.get(cy * AREA_COLS + cx);
      if (!bucket) continue;
      for (const npc of bucket) if (hits(npc)) return true;
    }
  }
  // Roamers and cars aren't bucketed (they range town-wide) — scan the pools.
  for (const npc of roamers) if (hits(npc)) return true;
  for (const npc of cars) if (hits(npc)) return true;
  return false;
}

/**
 * The LIVE static NPC instance for a placement key (RawNPC.k or "+i"), or null
 * if it isn't currently built (e.g. an unsaved editor addition, or a roamer/car
 * which has no placement key). Editor tools use this to select the in-game
 * instance — which may have wandered from its spawn ghost — by the same key.
 */
export function liveNpcForKey(key: string): NPC | null {
  return npcByKey.get(key) ?? null;
}

/**
 * Re-apply per-player gift open-state to every placed container. NPCs are built
 * at boot (buildStaticNpcs → tagGift), but the player's saved flags only arrive
 * later in the network `welcome`, so presents already opened in a prior session
 * would otherwise load showing the CLOSED frame. Call this once flags hydrate to
 * flip those to the open (lidless North) frame. tagGift only ever sets open, so
 * re-running it is safe and won't undo a present opened this session.
 */
export function applyGiftFlagStates(): void {
  for (const npc of npcByKey.values()) {
    if (npc.isGift) tagGift(npc);
  }
}

/** Kick off the lazy sprite-sheet load for an NPC the first time it's needed. */
function ensureSheet(npc: NPC): void {
  if (!requestedSheets.has(npc.spriteGroupId)) {
    requestedSheets.add(npc.spriteGroupId);
    loadSpriteGroup(npc.spriteGroupId).catch(() => {
      // Missing sheet — NPC just stays invisible.
    });
  }
}

/**
 * Every live NPC whose position falls in a world rect (plus a margin so sprites
 * straddling the edge still draw). The editor uses this to render whatever the
 * FREE CAMERA shows — gameplay's getNearbyNPCs is anchored on the (frozen)
 * avatar, so panned/zoomed-out views would otherwise show an empty world.
 */
export function getNpcsInRect(minX: number, minY: number, maxX: number, maxY: number): NPC[] {
  const m = AREA_PX; // margin: a sprite's home area can sit just outside the view
  const x0 = minX - m;
  const y0 = minY - m;
  const x1 = maxX + m;
  const y1 = maxY + m;
  const inRect = (npc: NPC) => npc.x >= x0 && npc.x <= x1 && npc.y >= y0 && npc.y <= y1;
  const result: NPC[] = [];

  const cx0 = Math.max(0, Math.floor(x0 / AREA_PX));
  const cx1 = Math.min(AREA_COLS - 1, Math.floor(x1 / AREA_PX));
  const cy0 = Math.max(0, Math.floor(y0 / AREA_PX));
  const cy1 = Math.floor(y1 / AREA_PX);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const bucket = npcsByArea.get(cy * AREA_COLS + cx);
      if (!bucket) continue;
      for (const npc of bucket) {
        if (npc.dead || npc.stale) continue;
        ensureSheet(npc);
        result.push(npc);
      }
    }
  }
  for (const npc of roamers) {
    if (npc.dead || npc.stale || !inRect(npc)) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  for (const npc of cars) {
    if (npc.dead || npc.stale || !inRect(npc)) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  return result;
}

/** NPCs in the player's neighborhood; kicks off sprite loads as needed. */
export function getNearbyNPCs(px: number, py: number): NPC[] {
  const ax = Math.floor(px / AREA_PX);
  const ay = Math.floor(py / AREA_PX);
  const result: NPC[] = [];

  for (let dy = -NEAR_RANGE; dy <= NEAR_RANGE; dy++) {
    for (let dx = -NEAR_RANGE; dx <= NEAR_RANGE; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cx >= AREA_COLS || cy < 0) continue;
      const bucket = npcsByArea.get(cy * AREA_COLS + cx);
      if (!bucket) continue;
      for (const npc of bucket) {
        if (npc.dead || npc.stale) continue; // dead / inactive / ghost — hidden
        ensureSheet(npc); // opened presents persist (shown open), so nothing to skip
        result.push(npc);
      }
    }
  }

  // Roamers and cars aren't bucketed; include the live ones within the window.
  const reach = NEAR_RANGE * AREA_PX;
  for (const npc of roamers) {
    if (npc.dead || npc.stale) continue;
    if (Math.abs(npc.x - px) > reach || Math.abs(npc.y - py) > reach) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  for (const npc of cars) {
    if (npc.dead || npc.stale) continue; // destroyed/ghost — hidden until it respawns
    if (Math.abs(npc.x - px) > reach || Math.abs(npc.y - py) > reach) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  return result;
}
