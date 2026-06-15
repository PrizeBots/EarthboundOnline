/**
 * EventBus — the single spine the flag/quest system rides on.
 *
 * Every meaningful player action emits a typed GameEvent here: finishing a
 * conversation, picking up an item, defeating an enemy, entering an area. The
 * FlagTriggers module is the main subscriber — it matches events against the
 * authored trigger table and sets/clears PlayerFlags. Dialogue branching then
 * reads those flags. One bus, not four bespoke hooks.
 *
 * Why route everything through one event type instead of calling setFlag()
 * directly at each source: it keeps the *authoring* (which event sets which
 * flag) as data the admin tool edits, not code; and it is the exact seam where
 * server authority slots in later — today the client applies triggers locally,
 * later it forwards the event to the server, which validates it and owns the
 * flag write (anti-cheat). Nothing that emits events changes when that happens.
 *
 * Ports clean to SNES: the ROM does the same thing — script hooks fire on these
 * same moments and set event flags.
 */

export type GameEvent =
  // A dialogue window closed. `text` = the textId that was shown (stable, the
  // natural match key); `npc` = the speaking NPC's textId too for now (kept
  // separate so a future per-placement id can replace it without a reshape).
  | { type: 'dialogue:done'; text: number; npc: number }
  // An item entered the player's possession. `item` = item id.
  | { type: 'item:acquired'; item: number }
  // An enemy died. `enemy` = the enemy's sprite-group id (its type).
  | { type: 'enemy:defeated'; enemy: number }
  // The player crossed into a new sector. `sector` = sector id.
  | { type: 'area:entered'; sector: number };

export type GameEventType = GameEvent['type'];

type Handler = (e: GameEvent) => void;

const handlers = new Set<Handler>();

/** Subscribe to every game event. Returns an unsubscribe fn. */
export function onGameEvent(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

/** Fire an event to all subscribers. Snapshot the set so a handler may unsub. */
export function emitGameEvent(e: GameEvent): void {
  for (const h of [...handlers]) {
    try {
      h(e);
    } catch (err) {
      console.error('[EventBus] handler threw for', e.type, err);
    }
  }
}
