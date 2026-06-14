/**
 * Wallet — the local player's money ($), mirrored from the server.
 *
 * The server is authoritative: it grants the $1000 starting balance and is the
 * sole authority on the balance (welcome snapshot + future `money` deltas once
 * shops/drops exist). This module just holds the latest copy so the command
 * window can show it. On SNES this maps to the money RAM the menu reads —
 * EarthBound actually keeps cash "in the bank", but a single counter is enough
 * until an ATM/bank system exists.
 */

let money = 0;

/** Replace the balance (called on welcome and every `money` delta). */
export function setMoney(amount: number): void {
  money = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
}

export function getMoney(): number {
  return money;
}
