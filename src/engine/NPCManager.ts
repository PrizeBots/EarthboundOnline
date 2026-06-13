/**
 * NPCManager — loads the ROM NPC placements (tools/extract_npcs.py ->
 * /assets/map/npcs.json) and serves the ones near the player. NPCs are
 * bucketed into the same 256x256 area grid the ROM uses; sprite sheets are
 * lazy-loaded as their owners first come near (drawSprite skips entities
 * whose sheet hasn't arrived yet, so loading never blocks a frame).
 */

import { loadJSON } from './AssetLoader';
import { loadSpriteGroup } from './SpriteManager';
import { NPC, NPCKind } from './NPC';
import { Direction } from '../types';

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
// JSON array index = wire id used by the server's npc_update / npc_hp messages.
// Null slots are override-deleted placements (kept so indexes stay aligned).
let npcsById: (NPC | null)[] = [];
const requestedSheets = new Set<number>();
// Decoded ROM dialogue, keyed by NPC config id (see tools/extract_npcs.py).
let npcText: Record<string, string[]> = {};

// Spawner-pool enemies (our own enemy_spawns.json). They wander town-wide, so
// they're tracked in a flat list rather than the home-keyed area buckets, and
// start hidden (hp 0) until the server activates them. ROM-placed enemies
// (sharks in npcs.json) live in the normal buckets like townsfolk.
const roamers: NPC[] = [];

interface EnemyConfig {
  enemySpriteGroups?: number[];
  spawners?: { sprite: number; x: number; y: number; poolSize?: number; hp?: number }[];
}

export async function loadNPCs(): Promise<void> {
  const [raw, overrides, text, enemyCfg] = await Promise.all([
    loadJSON<RawNPC[]>('/assets/map/npcs.json'),
    // Editor-authored placement overrides — absent until something is authored.
    loadJSON<NpcOverrides>('/overrides/npcs.json').catch(() => null),
    loadJSON<Record<string, string[]>>('/assets/map/npc_text.json'),
    loadJSON<EnemyConfig>('/assets/map/enemy_spawns.json').catch(() => ({}) as EnemyConfig),
  ]);
  npcText = text;
  npcsByArea.clear();
  roamers.length = 0;

  const enemySprites = new Set(enemyCfg.enemySpriteGroups ?? []);
  const defaultHp = enemyCfg.spawners?.[0]?.hp ?? 24;

  // ROM placements + authored overrides; sprite groups marked hostile in
  // enemy_spawns.json become kind 'enemy' (alive until the server's hp
  // snapshot says otherwise).
  npcsById = mergeNpcOverrides(raw, overrides).map((r) => {
    if (!r) return null; // override-deleted slot
    const kind: NPCKind = enemySprites.has(r.sprite) ? 'enemy' : r.kind;
    const npc = new NPC(r.x, r.y, r.sprite, r.dir as Direction, kind, r.t ?? null);
    if (kind === 'enemy') npc.applyHp(defaultHp, defaultHp);
    return npc;
  });
  for (const npc of npcsById) {
    if (!npc) continue;
    const area =
      Math.floor(npc.y / AREA_PX) * AREA_COLS + Math.floor(npc.x / AREA_PX);
    let bucket = npcsByArea.get(area);
    if (!bucket) {
      bucket = [];
      npcsByArea.set(area, bucket);
    }
    bucket.push(npc);
  }

  // Spawner pool appended AFTER the ROM placements so wire ids match the
  // server, which builds the same pool from the same file. Each starts dead
  // (hp 0 = hidden) until activated via npc_hp.
  let id = npcsById.length;
  for (const sp of enemyCfg.spawners ?? []) {
    for (let i = 0; i < (sp.poolSize ?? 0); i++) {
      const npc = new NPC(sp.x, sp.y, sp.sprite, Direction.N, 'enemy', null);
      npc.applyHp(0, sp.hp ?? defaultHp);
      npcsById[id++] = npc;
      roamers.push(npc);
    }
  }

  console.log(`Loaded ${npcsById.length} NPCs (${roamers.length} enemy pool slots)`);
}

/** Apply authoritative enemy HP (welcome snapshot + on-damage deltas). */
export function applyNpcHp(rows: [number, number, number][]): void {
  for (const [id, hp, maxHp] of rows) {
    npcsById[id]?.applyHp(hp, maxHp);
  }
}

/** Dialogue pages for an NPC, or null if it has nothing to say. */
export function getNpcDialogue(npc: NPC): string[] | null {
  if (npc.textId == null) return null;
  return npcText[npc.textId] ?? null;
}

/**
 * Apply authoritative positions from the server. Buckets are keyed by the
 * HOME position on purpose: wanderers are leashed within 32px of home, so
 * re-bucketing on movement is unnecessary.
 */
export function applyNpcUpdates(rows: [number, number, number, number, number][]): void {
  for (const [id, x, y, dir, frame] of rows) {
    npcsById[id]?.applyServerState(x, y, dir as Direction, frame);
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
  curY?: number,
): boolean {
  const haveCur = curX !== undefined && curY !== undefined;
  // Solid for the player: live people AND live enemies (sharks). Props and dead
  // enemies don't block. A body the player ALREADY overlaps doesn't block, so an
  // embedded player can always walk back out.
  const hits = (npc: NPC): boolean => {
    if (npc.dead) return false;
    if (npc.kind !== 'person' && npc.kind !== 'enemy') return false;
    const nx = npc.x - NPC_COL_W / 2;
    const ny = npc.y + NPC_COL_OY;
    if (!(x < nx + NPC_COL_W && x + w > nx && y < ny + NPC_COL_H && y + h > ny)) {
      return false;
    }
    if (
      haveCur &&
      curX! < nx + NPC_COL_W && curX! + w > nx &&
      curY! < ny + NPC_COL_H && curY! + h > ny
    ) {
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
  // Roamers aren't bucketed (they wander town-wide) — scan the small pool.
  for (const npc of roamers) if (hits(npc)) return true;
  return false;
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

  // Roamers aren't bucketed; include the live ones within the near window.
  const reach = NEAR_RANGE * AREA_PX;
  for (const npc of roamers) {
    if (npc.dead) continue;
    if (Math.abs(npc.x - px) > reach || Math.abs(npc.y - py) > reach) continue;
    ensureSheet(npc);
    result.push(npc);
  }
  return result;
}
