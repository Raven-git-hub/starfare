'use strict';

// §5 "The Syndicate commitment is a per-good windowed accrual" (Slice B-i, supersedes
// the 10-08-26 "instant per-tick full delivery" engine cut). The Gate-1 Syndicate fork
// no longer delivers its full commitment every tick. Instead a good's commitment is an
// AGGREGATE TARGET `Q` (Σ Venture.syndicateCommitment over the mines producing it)
// delivered over a WINDOW of `N` ticks at a PACED per-tick send, drawing FRESH ONLY
// (never the stockpile), self-terminating at Q, and resolving met/breach at the window
// boundary (a status flag, no fee). The committed units sink into the Syndicate's
// infinite backend (invariants.js's galactic-supply check already models selling as a
// sink). Commitment is a fed-in placeholder (createVenture's syndicateCommitment param).
//
// This file rewrites the old per-tick-full-delivery pins to the windowed truth; the
// window/accrual mechanics (carry, boundary roll, fresh-only, impossible-pace,
// self-terminate, the fraction guard) live in window-accrual.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { getWindow } = require('../windows.js');
const { computeGalacticSupply } = require('../supply.js');

const SYS = 'sysA';
// A mine with an optional syndicateCommitment (the fed-in placeholder).
const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate, syndicateCommitment: commitment,
});
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);
const win = (s, good) => getWindow(s.guilds[0], SYS, good);

function sysState(ventures, windowN) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

// --- a committed mine feeding a refinery: paced delivery, fresh − delivered − consumed

test('committed mine feeding a refinery: the Syndicate draws its PACED send from fresh; galactic drops by exactly the delivered amount', () => {
  // titanium mine rate 10, commitment 8 over an N=4 window ⇒ paced 8/4 = 2/tick. A
  // carbon mine rate 10 and a titanium_alloy line rate 2 (recipe 3 ti + 1 carbon) —
  // consumer titanium demand 6. The Syndicate fork (routed first) takes its 2 from
  // FRESH, leaving 8; the consumer draws 6; the remaining 2 stockpiles. Per tick:
  //   titanium pool += 10 fresh − 2 delivered − 6 consumed = +2
  //   carbon  pool += 10 fresh − 2 consumed = +8 ; titanium_alloy += 2
  let s = sysState([mine('t', 'titanium', 10, 8), mine('c', 'carbon_products', 10), refinery('r', 'titanium_alloy', 2)], 4);
  const before = computeGalacticSupply(s).resources.titanium;
  s = tick(s);
  assert.equal(win(s, 'titanium').delivered, 2, 'paced send 8/4 = 2 this tick');
  assert.equal(held(s, 'titanium'), 2, '10 fresh − 2 delivered − 6 consumed');
  assert.equal(held(s, 'carbon_products'), 8);
  assert.equal(held(s, 'titanium_alloy'), 2, 'the refinery still runs at full rate 2 (fresh covers the send + demand)');
  assert.equal(before + 10 - computeGalacticSupply(s).resources.titanium, 2 + 6, 'galactic titanium: +10 mined − 2 delivered − 6 consumed');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // Run the whole 4-tick window: delivered accrues 2→4→6→8 = Q, status MET at boundary.
  for (let i = 0; i < 3; i += 1) s = tick(s);
  assert.equal(win(s, 'titanium').delivered, 8, 'the full commitment Q=8 delivered across the window');
  assert.equal(held(s, 'titanium'), 8, '+2/tick over 4 ticks');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- mine-to-sell: a committed good with NO consumer still delivers (paced) ----------

test('mine-to-sell (no consumer): a committed mine delivers its PACED send each tick, not the whole commitment', () => {
  // A committed titanium mine (rate 10, commitment 8) with NO titanium consumer, N=4.
  // The routing must NOT skip a no-consumer good: it delivers the paced 2/tick, so the
  // pool grows by 10 − 2 = 8/tick (NOT the whole 8 at once, and NOT the raw fresh 10).
  let s = sysState([mine('t', 'titanium', 10, 8)], 4);
  s = tick(s);
  assert.equal(win(s, 'titanium').delivered, 2, 'paced 2, not the whole commitment 8');
  assert.equal(held(s, 'titanium'), 8, 'fresh 10 − delivered 2 = 8 (the no-consumer case is not skipped)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  for (let i = 0; i < 3; i += 1) s = tick(s);
  assert.equal(win(s, 'titanium').delivered, 8, 'Q=8 delivered by the window boundary');
  assert.equal(held(s, 'titanium'), 32, '+8/tick over the 4-tick window');
});

// --- no-op for the unlicensed: byte-identical to pre-Slice-B (the key no-op proof) ---

test('no-op for the unlicensed: a commitment-0 chain creates NO window state and needs no windowN', () => {
  // With every syndicateCommitment 0 no good is ever committed, so no window state is
  // created and the scenario never even needs a windowN — the serialized state is
  // byte-identical to pre-Slice-B (the determinism-hash no-op proof). Over 50 ticks
  // titanium +4/tick (10 fresh − 6 consumed), carbon +8/tick, alloy +2/tick.
  let s = sysState([mine('t', 'titanium', 10, 0), mine('c', 'carbon_products', 10, 0), refinery('r', 'titanium_alloy', 2)]);
  assert.equal(s.windowN, undefined, 'an uncommitted scenario carries no windowN field');
  for (let i = 0; i < 50; i += 1) s = tick(s);
  for (const g of s.guilds) {
    assert.equal(g.syndicateWindows, undefined, 'no committed good ⇒ no syndicateWindows key (byte-identical shape)');
  }
  const r = computeGalacticSupply(s).resources;
  assert.equal(r.titanium, 200, '10 fresh − 6 consumed = 4/tick * 50 (nothing delivered)');
  assert.equal(r.carbon_products, 400, '10 fresh − 2 consumed = 8/tick * 50');
  assert.equal(r.titanium_alloy, 100, '2/tick * 50');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- determinism (invariant 9) with windowed delivery active ------------------------

test('determinism: a committed chain (with a fractional send carry) run twice to tick 50 is byte-identical', () => {
  // Q=7 over N=4 gives a fractional pace (1.75/tick), so the send carry is exercised —
  // and the same-process byte-identical guarantee must still hold (invariant 9).
  const build = () => {
    let s = sysState([mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 10, 5), refinery('r', 'titanium_alloy', 2)], 4);
    for (let i = 0; i < 50; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
