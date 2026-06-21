/**
 * Wallet — the local player's money, mirrored from the server.
 *
 * The server is authoritative on both balances; this module just holds the latest
 * copy for the menu/ATM to read. EarthBound's model (now implemented): money lives
 * in two places —
 *   - `money` = on-hand CASH, what shops spend.
 *   - `bank`  = ATM balance; kill rewards land here, and you withdraw to spend.
 * Both arrive on welcome and via `money` / `bank` deltas; ATM moves them between.
 */

let money = 0;
let bank = 0;

/** Replace the on-hand cash (welcome + every `money` delta). */
export function setMoney(amount: number): void {
  money = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
}

export function getMoney(): number {
  return money;
}

/** Replace the bank balance (welcome + every `bank` delta). */
export function setBank(amount: number): void {
  bank = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
}

export function getBank(): number {
  return bank;
}

/** Format a money value with thousands separators for legibility (no `$` — the
 *  caller adds it): 1234567 → "1,234,567". Rounds to a whole number. Used by
 *  EVERY money display so balances/prices/loot read consistently. */
export function formatMoney(n: number): string {
  const v = Math.round(n);
  const sign = v < 0 ? '-' : '';
  return (
    sign +
    Math.abs(v)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  );
}
