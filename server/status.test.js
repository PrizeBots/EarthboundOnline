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
