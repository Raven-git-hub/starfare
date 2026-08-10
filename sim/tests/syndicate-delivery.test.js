'use strict';

// §5 "Syndicate fork delivery — commitment goes live (the engine cut, 10-08-26)".
// The Gate-1 Syndicate fork now DELIVERS: each tick, a good's committed units
// (Σ syndicateCommitment over mines producing it) leave the guild pool and sink
// into the Syndicate's infinite backend (no receiving entity — invariants.js's
// galactic-supply check already treats selling as a sink, not a conservation
// break). Delivery is instant/per-tick and the FULL commitment — no licence, fee,
// breach, buffer, or dial-down (all the licence layer, later). Commitment is a
// fed-in placeholder set directly via createVenture's syndicateCommitment param.
//
// These are production-engine tripwires (not one of the nine invariants), in the
// recipe-ratio.test.js style: controlled single-system scenarios, exact numbers.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { computeGalacticSupply } = require('../supply.js');

const SYS = 'sysA';
// A mine with an optional syndicateCommitment (the fed-in placeholder).
const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate, syndicateCommitment: commitment,
});
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);

function sysState(ventures) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

// --- a committed mine feeding a refinery: fresh − delivered − consumed ----------

test('committed mine feeding a refinery: pool = fresh − delivered − consumed; galactic drops by the commitment', () => {
  // titanium mine rate 10 with commitment 4, carbon mine rate 10, titanium_alloy
  // line rate 2 (recipe = 3 ti + 1 carbon). fresh titanium 10 ≥ commitment 4 +
  // downstream demand 6, so the Syndicate fork (routed FIRST) does NOT starve the
  // refinery — it takes from what would otherwise stockpile. After one tick:
  //   titanium pool = 10 fresh − 4 delivered − 6 consumed = 0
  //   carbon  pool = 10 fresh − 2 consumed = 8;  titanium_alloy = 2
  const committed = tick(sysState([mine('t', 'titanium', 10, 4), mine('c', 'carbon_products', 10), refinery('r', 'titanium_alloy', 2)]));
  assert.equal(held(committed, 'titanium'), 0, 'fresh 10 − delivered 4 − consumed 6');
  assert.equal(held(committed, 'carbon_products'), 8);
  assert.equal(held(committed, 'titanium_alloy'), 2, 'the refinery still runs at full rate 2 (not starved)');
  assert.deepEqual(checkInvariants(committed, committed.tick), []);

  // The counterfactual: the SAME chain unlicensed (commitment 0). Everything is
  // identical except the 4 titanium that were delivered now stockpile instead — so
  // galactic titanium is exactly 4 higher, and the alloy output is unchanged.
  const unlicensed = tick(sysState([mine('t', 'titanium', 10, 0), mine('c', 'carbon_products', 10), refinery('r', 'titanium_alloy', 2)]));
  assert.equal(held(unlicensed, 'titanium'), 4, 'unlicensed: the 4 that were delivered now pile up');
  assert.equal(held(unlicensed, 'titanium_alloy'), 2, 'delivery did not change the refinery output');
  const drop = computeGalacticSupply(unlicensed).resources.titanium - computeGalacticSupply(committed).resources.titanium;
  assert.equal(drop, 4, 'galactic titanium dropped by exactly the delivered commitment (4)');
});

// --- mine-to-sell: a committed good with NO consumer still delivers -------------

test('mine-to-sell (no consumer): a committed mine still delivers its commitment each tick', () => {
  // A committed titanium mine (rate 10, commitment 4) with NO titanium consumer.
  // The old routing loop skipped a no-consumer good before any fork was computed —
  // this proves the fix: the pool grows by fresh − delivered (6), not fresh (10).
  let s = sysState([mine('t', 'titanium', 10, 4)]);
  s = tick(s);
  assert.equal(held(s, 'titanium'), 6, 'fresh 10 − delivered 4 = 6 (not 10 — the mine-to-sell case is not skipped)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = tick(s); s = tick(s);
  assert.equal(held(s, 'titanium'), 18, '+6 per tick over 3 ticks (delivery fires every tick)');
});

// --- over-commitment caps at fresh, never negative -----------------------------

test('over-commitment caps at fresh: delivers all fresh output and never drives the pool negative', () => {
  // commitment 8 exceeds fresh 5: delivery is min(commitment, fresh) = 5, so the
  // whole fresh output leaves and the pool holds at 0 — never negative.
  let s = sysState([mine('t', 'titanium', 5, 8)]);
  for (let i = 0; i < 5; i += 1) {
    s = tick(s);
    assert.equal(held(s, 'titanium'), 0, 'all fresh delivered, pool floored at 0');
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

// --- no-op for the unlicensed: commitment 0 is byte-identical to pre-cut ---------

test('no-op for the unlicensed: a commitment-0 chain delivers nothing — supply is pure fresh − consumed', () => {
  // With every syndicateCommitment 0, no good ever has fork.syndicate > 0, so the
  // delivery step removes nothing and the resolver is byte-identical to before the
  // cut: fresh accumulates fully minus what the refinery consumes. Over 50 ticks,
  // titanium +4/tick (10 fresh − 6 consumed), carbon +8/tick, alloy +2/tick.
  let s = sysState([mine('t', 'titanium', 10, 0), mine('c', 'carbon_products', 10, 0), refinery('r', 'titanium_alloy', 2)]);
  for (let i = 0; i < 50; i += 1) s = tick(s);
  const r = computeGalacticSupply(s).resources;
  assert.equal(r.titanium, 200, '10 fresh − 6 consumed = 4/tick * 50 (nothing delivered)');
  assert.equal(r.carbon_products, 400, '10 fresh − 2 consumed = 8/tick * 50');
  assert.equal(r.titanium_alloy, 100, '2/tick * 50');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- determinism (invariant 9) with delivery active ----------------------------

test('determinism: a committed chain run twice to tick 50 is byte-identical', () => {
  const build = () => {
    let s = sysState([mine('t', 'titanium', 10, 4), mine('c', 'carbon_products', 10, 3), refinery('r', 'titanium_alloy', 2)]);
    for (let i = 0; i < 50; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
