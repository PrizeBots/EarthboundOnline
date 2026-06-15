/**
 * FlagTriggers — the rule table that turns game events into flag changes
 * (public/overrides/triggers.json).
 *
 * Each trigger says: when THIS event happens (optionally matching a target),
 * and IF these prerequisite flags hold, THEN set/clear these player flags.
 * Prerequisites are what make this a real quest state machine rather than a
 * pile of one-shots — "set quest_done only if quest_started is set", "the boss
 * only counts after you've met Mom", etc.
 *
 * It subscribes to the EventBus once (initFlagTriggers) and applies matches to
 * PlayerFlags. Triggers set PLAYER flags only: one player's kill must not flip
 * global world state in v1 (world flags are admin/baked). When the server owns
 * flags, this same matching runs server-side off forwarded events.
 */

import { onGameEvent, GameEvent, GameEventType } from './EventBus';
import { hasFlag, setFlag, clearFlag } from './PlayerFlags';

export interface Trigger {
  /** Stable authored id (the Flag Editor keys rules by this). */
  id: string;
  on: {
    event: GameEventType;
    // Optional target match — only the field relevant to the event is read.
    text?: number; // dialogue:done — the textId shown
    npc?: number; // dialogue:done — the speaking NPC
    item?: number; // item:acquired
    enemy?: number; // enemy:defeated — sprite-group id
    sector?: number; // area:entered
  };
  /** All of these player flags must be SET for the trigger to fire. */
  require?: number[];
  /** All of these player flags must be CLEAR for the trigger to fire. */
  requireClear?: number[];
  /** Player flags to set when it fires. */
  set?: number[];
  /** Player flags to clear when it fires. */
  clear?: number[];
}

interface TriggersFile {
  version: number;
  triggers?: Trigger[];
}

let triggers: Trigger[] = [];
let unsubscribe: (() => void) | null = null;

/** Does this event satisfy the trigger's `on` target match? */
function matchesTarget(t: Trigger, e: GameEvent): boolean {
  if (t.on.event !== e.type) return false;
  switch (e.type) {
    case 'dialogue:done':
      if (t.on.text != null && t.on.text !== e.text) return false;
      if (t.on.npc != null && t.on.npc !== e.npc) return false;
      return true;
    case 'item:acquired':
      return t.on.item == null || t.on.item === e.item;
    case 'enemy:defeated':
      return t.on.enemy == null || t.on.enemy === e.enemy;
    case 'area:entered':
      return t.on.sector == null || t.on.sector === e.sector;
  }
}

/** Prerequisite flags all hold? */
function prereqsMet(t: Trigger): boolean {
  if (t.require && !t.require.every((f) => hasFlag(f))) return false;
  if (t.requireClear && !t.requireClear.every((f) => !hasFlag(f))) return false;
  return true;
}

function applyTrigger(t: Trigger): void {
  let changed = false;
  for (const f of t.set ?? []) changed = setFlag(f) || changed;
  for (const f of t.clear ?? []) changed = clearFlag(f) || changed;
  if (changed) {
    console.log(`[FlagTriggers] ${t.id} fired → set[${t.set ?? []}] clear[${t.clear ?? []}]`);
  }
}

function handle(e: GameEvent): void {
  for (const t of triggers) {
    if (matchesTarget(t, e) && prereqsMet(t)) applyTrigger(t);
  }
}

/** Load triggers.json and subscribe to the bus (idempotent). */
export async function initFlagTriggers(): Promise<void> {
  const file = await fetch('/overrides/triggers.json')
    .then((r) => (r.ok ? (r.json() as Promise<TriggersFile>) : null))
    .catch(() => null);
  triggers = file?.triggers ?? [];
  if (!unsubscribe) unsubscribe = onGameEvent(handle);
}

/** Replace the live rule set (the Flag Editor calls this after an edit). */
export function setTriggers(next: Trigger[]): void {
  triggers = next.slice();
}

export function getTriggers(): Trigger[] {
  return triggers;
}
