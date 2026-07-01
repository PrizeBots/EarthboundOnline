/**
 * Unit tests for server/shields.js — the block/reflect-N-hits shield engine
 * (Power Shield / PSI Shield). Pure, so fully deterministic. Run via `node --test`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Sh = require('./shields');

test('a block shield soaks matching hits then breaks; wrong kind passes through', () => {
  const h = {};
  assert.strictEqual(Sh.applyShield(h, 'physical', 'block', 2), true);
  // A psi hit is not guarded by a physical shield.
  assert.deepStrictEqual(Sh.absorbHit(h, 'psi'), { absorbed: false, reflect: false });
  // Two physical hits are eaten (block → no reflect), then the shield is gone.
  assert.deepStrictEqual(Sh.absorbHit(h, 'physical'), { absorbed: true, reflect: false });
  assert.strictEqual(Sh.activeShields(h).length, 1);
  assert.deepStrictEqual(Sh.absorbHit(h, 'physical'), { absorbed: true, reflect: false });
  assert.strictEqual(Sh.activeShields(h).length, 0); // broke at 0 charges
  assert.deepStrictEqual(Sh.absorbHit(h, 'physical'), { absorbed: false, reflect: false });
});

test('a reflect shield reports reflect on each absorbed hit', () => {
  const h = {};
  Sh.applyShield(h, 'psi', 'reflect', 1);
  assert.deepStrictEqual(Sh.absorbHit(h, 'psi'), { absorbed: true, reflect: true });
  assert.strictEqual(Sh.activeShields(h).length, 0);
});

test('recasting the same kind refreshes (never stacks); kinds are independent', () => {
  const h = {};
  Sh.applyShield(h, 'physical', 'block', 3);
  Sh.applyShield(h, 'physical', 'reflect', 5); // replaces the block shield
  Sh.applyShield(h, 'psi', 'block', 2);
  const active = Sh.activeShields(h);
  assert.strictEqual(active.length, 2); // one physical (the refreshed one) + one psi
  const phys = active.find((s) => s.kind === 'physical');
  assert.strictEqual(phys.mode, 'reflect');
  assert.strictEqual(phys.hits, 5);
});

test('applyShield rejects bad args; clearShields wipes', () => {
  const h = {};
  assert.strictEqual(Sh.applyShield(h, 'fire', 'block', 3), false); // unknown kind
  assert.strictEqual(Sh.applyShield(h, 'physical', 'nope', 3), false); // bad mode
  assert.strictEqual(Sh.applyShield(h, 'physical', 'block', 0), false); // no hits
  Sh.applyShield(h, 'physical', 'block', 3);
  Sh.clearShields(h);
  assert.strictEqual(Sh.activeShields(h).length, 0);
});
