/**
 * Unit tests for server/status.js — the status-effect engine (catalog + timer/
 * immunity/DoT math). Pure and time-injected (every call takes an explicit `now`),
 * so these are fully deterministic. Run via `node --test server/`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('./status');

test('applyStatus activates for the catalog duration, then expires', () => {
  const h = {};
  assert.strictEqual(S.applyStatus(h, S.STATUS.PARALYSIS, 1000), true);
  assert.strictEqual(S.hasStatus(h, S.STATUS.PARALYSIS, 1000), true);
  assert.strictEqual(S.hasStatus(h, S.STATUS.PARALYSIS, 1000 + 549), true);
  assert.strictEqual(S.hasStatus(h, S.STATUS.PARALYSIS, 1000 + 550), false); // duration 550
});

test('isActionBlocked reflects any active blocking status', () => {
  const h = {};
  assert.strictEqual(S.isActionBlocked(h, 0), false);
  S.applyStatus(h, S.STATUS.PARALYSIS, 0);
  assert.strictEqual(S.isActionBlocked(h, 100), true);
  assert.strictEqual(S.isActionBlocked(h, 600), false); // wore off
});

test('a DoT status (poison) does NOT block action', () => {
  const h = {};
  S.applyStatus(h, S.STATUS.POISON, 0);
  assert.strictEqual(S.isActionBlocked(h, 100), false);
});

test('immunity window blocks re-applying until it passes', () => {
  const h = {};
  S.applyStatus(h, S.STATUS.PARALYSIS, 0); // until 550, immune until 550+1500=2050
  // While the status is still ACTIVE, re-apply is allowed (refresh).
  assert.strictEqual(S.applyStatus(h, S.STATUS.PARALYSIS, 400), true);
  // After it wears off but inside the immunity window: refused.
  const h2 = {};
  S.applyStatus(h2, S.STATUS.PARALYSIS, 0);
  assert.strictEqual(S.applyStatus(h2, S.STATUS.PARALYSIS, 1000), false); // 550 < 1000 < 2050
  // Past the immunity window: allowed again.
  assert.strictEqual(S.applyStatus(h2, S.STATUS.PARALYSIS, 2100), true);
});

test('tryInflict respects chance and immunity', () => {
  const h = {};
  assert.strictEqual(
    S.tryInflict(h, S.STATUS.PARALYSIS, 0, 0, () => 0),
    false
  ); // 0% never
  assert.strictEqual(
    S.tryInflict(h, S.STATUS.PARALYSIS, 100, 0, () => 0.99),
    true
  ); // 99 < 100
  const h2 = {};
  assert.strictEqual(
    S.tryInflict(h2, S.STATUS.PARALYSIS, 50, 0, () => 0.6),
    false
  ); // 60 >= 50, miss
});

test('tickStatuses fires DoT at the catalog cadence and reports expiry once', () => {
  const h = {};
  S.applyStatus(h, S.STATUS.POISON, 0); // dotMs 1000, duration 8000
  assert.strictEqual(S.tickStatuses(h, 500).dot.length, 0); // before first tick
  assert.strictEqual(S.tickStatuses(h, 1000).dot.length, 1); // first tick due
  assert.strictEqual(S.tickStatuses(h, 1500).dot.length, 0); // not yet
  assert.strictEqual(S.tickStatuses(h, 2000).dot.length, 1); // second tick
  // Expiry reported exactly once (poison has immuneMs 0 so the slot is reclaimed).
  const exp = S.tickStatuses(h, 8000);
  assert.deepStrictEqual(exp.expired, [S.STATUS.POISON]);
  assert.deepStrictEqual(S.tickStatuses(h, 8100).expired, []);
});

test('per-source DoT overrides bite at the authored dmg + rate', () => {
  const h = {};
  // Author a poison that ticks a FLAT 7 HP every 500ms (vs the 3%/1000ms default).
  S.applyStatus(h, S.STATUS.POISON, 0, { dotMs: 500, dotDmg: 7 });
  assert.strictEqual(S.tickStatuses(h, 400).dot.length, 0); // before the faster tick
  const t = S.tickStatuses(h, 500).dot;
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].dmg, 7); // flat per-source damage, not a % of max HP
  assert.strictEqual(S.tickStatuses(h, 900).dot.length, 0); // 500ms cadence, not 1000
  assert.strictEqual(S.tickStatuses(h, 1000).dot.length, 1);
});

test('normalizeInflict keeps + clamps authored DoT overrides', () => {
  const clean = S.normalizeInflict([
    { type: 'burn', chance: 40, dotDmg: 5, dotMs: 800 },
    { type: 'poison', chance: 150, dotMs: 10 }, // chance clamps to 100; dotMs floors to 100
    { type: 'bogus', chance: 50 }, // dropped: unknown status
  ]);
  assert.strictEqual(clean.length, 2);
  assert.deepStrictEqual(clean[0], { type: 'burn', chance: 40, dotDmg: 5, dotMs: 800 });
  assert.strictEqual(clean[1].chance, 100);
  assert.strictEqual(clean[1].dotMs, 100);
});

test('breakOnHit clears Sleep but not Paralysis', () => {
  const h = {};
  S.applyStatus(h, S.STATUS.SLEEP, 0);
  S.applyStatus(h, S.STATUS.PARALYSIS, 0);
  S.breakOnHit(h, 100);
  assert.strictEqual(S.hasStatus(h, S.STATUS.SLEEP, 101), false);
  assert.strictEqual(S.hasStatus(h, S.STATUS.PARALYSIS, 101), true);
});

test('activeStatuses lists only currently-active ids; clearAll empties', () => {
  const h = {};
  S.applyStatus(h, S.STATUS.POISON, 0);
  S.applyStatus(h, S.STATUS.CRYING, 0);
  assert.deepStrictEqual(S.activeStatuses(h, 100).sort(), ['crying', 'poison']);
  S.clearAll(h);
  assert.deepStrictEqual(S.activeStatuses(h, 100), []);
});
