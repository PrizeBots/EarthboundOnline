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
import { Direction, POSES } from '../types';
import type { NpcUpdate } from './Network';
import { createInterpolator } from './RemoteInterp';
import { loadShops, shopStoreForNpc } from './Shop';
import type { EntityCol } from './EntityStats';
import { hasFlag } from './PlayerFlags';

/** ROM NPC config id from a placement key "areaIdx:npcId:occ", or -1. */
function npcIdFromKey(k: string | undefined): number {
  if (!k) return -1;
  const parts = k.split(':');
  return parts.length >= 2 ? parseInt(parts[1], 10) : -1;
}

// Smooth NPC/enemy motion the same way remote players glide. NPCs broadcast at
// ~10Hz (slower than players), so a slightly larger render delay keeps two
// snapshots bracketing the render time even under jitter. Separate instance
// from the player interpolator so numeric NPC ids can't collide with player ids.
const npcInterp = createInterpolator(160);

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
    if (o) return { ...o, k: e.k };
    return e;
  });
  for (const a of ov?.additions ?? []) merged.push({ ...a });
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
  // per-entity stats (Entity Manager); client needs hp + the optional collision
  // box override (col), which wins over the kind default for ANY entity.
  entities?: Record<string, { hp?: number; col?: EntityCol }>;
  spawners?: {
    sprite: number;
    x: number;
    y: number;
    poolSize?: number;
    hp?: number;
    enabled?: boolean;
  }[];
}

// ROM-derived enemy catalog (tools/extract_enemies.py -> assets/map/enemies.json):
// the DEFAULTS layer of per-entity stats. Merged UNDER the authored entities.
// KEEP merge order IN SYNC with server/npcSim.js: DEFAULT < catalog < authored.
interface EnemyCatalog {
  bySprite?: Record<string, { hp?: number; col?: EntityCol }>;
}
// Effective per-entity stats, sprite -> {hp,col}: catalog overlaid by authored
// entities. Built in loadNPCs; the client uses hp (health bars) and col.
const entityDefs = new Map<number, { hp?: number; col?: EntityCol }>();

// Exact per-direction collision boxes for vehicles (tools/extract_vehicle_colboxes.py
// -> sprites/colboxes.json): spriteId -> dir (0-7) -> box. A car collides by the
// real shape of the frame it's currently facing, not the padded sprite cell.
// KEEP IN SYNC with server/npcSim.js (same file, same lookup).
let carColBoxes: Record<string, Record<string, EntityCol>> = {};
// Manual per-sprite-group box overrides authored in the Entity Manager
// (enemy_spawns.json entities[*].col) — top priority when present.
const entityCols = new Map<number, EntityCol>();

export interface Vehicle {
  id: string;
  name: string;
  sprite: number;
  /** Collision box (px), derived from the sprite size when authored. */
  w?: number;
  h?: number;
  speed: number;
  loop: boolean;
  enabled: boolean;
  waypoints: [number, number][];
  /** textId keying npc_text.json — a vehicle can be talkable like any NPC. */
  t?: number | null;
}
export interface CarTraffic {
  version: number;
  vehicles?: Vehicle[];
}

/** Vehicles that produce a live car slot — KEEP IN SYNC with npcSim.js. */
function activeVehicles(cfg: CarTraffic | null): Vehicle[] {
  return (cfg?.vehicles ?? []).filter(
    (v) => v.enabled !== false && Array.isArray(v.waypoints) && v.waypoints.length >= 2
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

  // Effective per-entity stats = ROM catalog (defaults) overlaid by authored
  // entities. KEEP merge order IN SYNC with server/npcSim.js buildEntityDefs.
  entityDefs.clear();
  const cat = enemyCatalog?.bySprite ?? {};
  const authored = enemyCfg.entities ?? {};
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

  // ROM placements + authored overrides (sprite groups marked hostile in
  // enemy_spawns.json become kind 'enemy').
  npcsById = buildStaticNpcs(raw, overrides);

  // Spawner pool appended AFTER the ROM placements so wire ids match the
  // server, which builds the same pool from the same file. Each starts dead
  // (hp 0 = hidden) until activated via npc_hp.
  let id = npcsById.length;
  for (const sp of enemyCfg.spawners ?? []) {
    if (sp.enabled === false) continue; // disabled spawner: no pool (server skips it too)
    // maxHp drives the health bar; it lives per-entity (ROM catalog + Entity
    // Manager), with a legacy per-spawner hp fallback.
    const maxHp = entityDefs.get(sp.sprite)?.hp ?? sp.hp ?? enemyDefaultHp;
    for (let i = 0; i < (sp.poolSize ?? 0); i++) {
      const npc = new NPC(sp.x, sp.y, sp.sprite, Direction.N, 'enemy', null);
      npc.applyHp(0, maxHp);
      npcsById[id++] = npc;
      roamers.push(npc);
    }
  }

  // Traffic cars appended AFTER the enemy pool, one slot per active vehicle, in
  // file order — the server builds the same pool so wire ids line up. Each car
  // starts at its first waypoint; the server drives it from there.
  for (const v of activeVehicles(carOv ?? carBase)) {
    const [sx, sy] = v.waypoints[0];
    // A vehicle is an NPC that drives — and may also be talkable (carries a
    // textId), e.g. EB's parked cars with a line of dialogue.
    const car = new NPC(sx, sy, v.sprite, Direction.S, 'car', v.t ?? null);
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
    // Enemy if explicitly placed as one (PlacementTool) OR a legacy enemy
    // sprite. KEEP IN SYNC with server/npcSim.js isEnemyPlacement.
    const kind: NPCKind = r.kind === 'enemy' || enemySpriteSet.has(r.sprite) ? 'enemy' : r.kind;
    const npc = new NPC(r.x, r.y, r.sprite, r.dir as Direction, kind, r.t ?? null);
    if (kind === 'enemy') {
      const hp = entityDefs.get(r.sprite)?.hp ?? enemyDefaultHp;
      npc.applyHp(hp, hp);
    }
    // Shop clerks (by ROM config id) carry the store they sell — Game.tryTalk
    // opens the shop instead of dialogue. Custom/override NPCs have no ROM id.
    if (kind === 'person') npc.shopStore = shopStoreForNpc(npcIdFromKey(r.k));
    npc.placementKey = r.k !== undefined ? r.k : `+${addIdx++}`;
    npcByKey.set(npc.placementKey, npc);
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
    if (prev > 0 && hp < prev) spawnDamageNumber(npc.x, npc.y, prev - hp);
    // Died/hidden: clear its interp buffer so a later respawn (which teleports
    // it back to its spawn point) starts fresh instead of gliding across town.
    if (hp <= 0) npcInterp.drop(String(id));
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
export function applyNpcUpdates(rows: NpcUpdate[]): void {
  for (const [id, x, y, dir, frame, poseCode] of rows) {
    const npc = npcsById[id];
    if (!npc) continue;
    const pose = POSES[poseCode ?? 0] ?? 'walk';
    const key = String(id);
    // Buffer the snapshot for smooth interpolation (see interpolateNpcs). The
    // FIRST snapshot after appearing/respawning snaps the position directly so
    // the NPC doesn't glide in from a stale spot; later ones interpolate.
    const fresh = !npcInterp.has(key);
    npcInterp.push(key, x, y, dir as Direction, frame, pose);
    if (fresh) npc.applyServerState(x, y, dir as Direction, frame, pose);
  }
}

/**
 * Advance every buffered NPC/enemy to its interpolated position for this frame.
 * Call once per frame (alongside the remote-player interpolation), so server
 * NPCs glide between 10Hz snapshots instead of stepping once per packet.
 */
export function interpolateNpcs(): void {
  for (const key of npcInterp.ids()) {
    const npc = npcsById[Number(key)];
    if (npc && !npc.dead) npcInterp.interpolate(key, npc);
  }
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
export function blockedByNPC(
  x: number,
  y: number,
  w: number,
  h: number,
  curX?: number,
  curY?: number
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
    if (npc.dead) return false;
    if (npc.kind !== 'person' && npc.kind !== 'enemy' && npc.kind !== 'car') return false;
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

/** NPCs in the player's neighborhood; kicks off sprite loads as needed. */
export function getNearbyNPCs(px: number, py: number): NPC[] {
  const ax = Math.floor(px / AREA_PX);
  const ay = Math.floor(py / AREA_PX);
  const result: NPC[] = [];

  const ensureSheet = (npc: NPC) => {
    if (!requestedSheets.has(npc.spriteGroupId)) {
      requestedSheets.add(npc.spriteGroupId);
      loadSpriteGroup(npc.spriteGroupId).catch(() => {
        // Missing sheet — NPC just stays invisible.
      });
    }
  };

  for (let dy = -NEAR_RANGE; dy <= NEAR_RANGE; dy++) {
    for (let dx = -NEAR_RANGE; dx <= NEAR_RANGE; dx++) {
      const cx = ax + dx;
      const cy = ay + dy;
      if (cx < 0 || cx >= AREA_COLS || cy < 0) continue;
      const bucket = npcsByArea.get(cy * AREA_COLS + cx);
      if (!bucket) continue;
      for (const npc of bucket) {
        if (npc.dead) continue; // dead enemy / inactive slot — hidden
        ensureSheet(npc);
        result.push(npc);
      }
    }
  }

  // Roamers and cars aren't bucketed; include the live ones within the window.
  const reach = NEAR_RANGE * AREA_PX;
  for (const npc of roamers) {
    if (npc.dead) continue;
    if (Math.abs(npc.x - px) > reach || Math.abs(npc.y - py) > reach) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  for (const npc of cars) {
    if (Math.abs(npc.x - px) > reach || Math.abs(npc.y - py) > reach) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  return result;
}
