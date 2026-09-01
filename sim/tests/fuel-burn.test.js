'use strict';

// fuel-burn.test.js — fuel Slice 3: fuel BITES on a Syndicate BUY
// (docs/fuel-supply-and-allocation.md §8, Slice 3).
//
// Slices 1 and 2 made fuel real and computable; nothing spent it. This slice
// makes it a cost: `buyFromSyndicate` refuses a guild that cannot pay the route
// burn, and deducts it from one that can. "No fuel, no Syndicate BUY."
//
// The burn is the first thing in the engine that DESTROYS fuel, and that is what
// these tripwires are really guarding. Fuel leaves the galaxy here — burned, not
// transferred, with no counterparty to credit — so invariant 1
// (Sum hoards + reserve + inTransit === totalProduced - totalConsumed) balances
// only because the hoard going down is matched by `totalConsumed` going up. Miss
// that second line and every BUY silently unbalances the fuel ledger. So every
// test below asserts the FULL nine-invariant sweep, not invariant 1 alone: the
// deduction also moves `galacticSupply.fuel.guildHeld`, and `POST /action`
// asserts with no tick in between, so a stale cache is a 500 on a legal trade.
//
// SCOPE, asserted at the foot: BUY ONLY. `sellToSyndicate` is multi-allocation
// and its per-route fuel question (sum per row? max? once?) needs its own ruling,
// so SELL burns nothing here and a test pins that it stays that way.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock } = require('../stock.js');
const { routeFuelCost, GUILD_STARTING_FUEL } = require('../fuel.js');
const {
  createBuyFromSyndicateAction, createSellToSyndicateAction,
  validateAction, applyAction, intake,
} = require('../actions.js');

// Two real seed systems at different distances, so a test can pick a burn.
const NEAR = 'sys_0719';  // 6 hexes out -> burn 3
const FAR = 'sys_0002';   // 100 hexes out -> burn 50
const NEAR_HOME_PLANET = 'pl_02524';
const GOOD = 'titanium';

const BURN_NEAR = routeFuelCost(NEAR).fuelBurn;
const BURN_FAR = routeFuelCost(FAR).fuelBurn;

const claim = (guildId, systemId, i) => ({
  claimId: i === 0 ? `claim_home_${guildId}` : `claim_${guildId}_${systemId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// A guild homed on NEAR, holding NEAR and FAR, ledger-funded so invariant 2 starts
// balanced and reserve-stocked so invariant 1 has something to conserve.
function burnState({ credits = 100000, fuelHoard = GUILD_STARTING_FUEL, stockpiles = {} } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits, fuelHoard, stockpiles,
      homeSystemId: NEAR, homePlanetId: NEAR_HOME_PLANET,
    }],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -credits },
    claims: [claim('g1', NEAR, 0), claim('g1', FAR, 1)],
  });
  s.prices[GOOD].posted = 10;
  return s;
}

const buy = (qty, destinationSystemId) => createBuyFromSyndicateAction({ guildId: 'g1', good: GOOD, qty, destinationSystemId });
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected a refusal');
  return reason;
};

// Invariant 1 restated by hand, so a failure names the term rather than the rule.
function assertFuelBalances(state, where) {
  const hoards = state.guilds.reduce((sum, g) => sum + g.fuelHoard, 0);
  const inTransit = (state.shipments || []).reduce((sum, sh) => sum + ((sh.cargo && sh.cargo.fuel) || 0), 0);
  const lhs = hoards + state.reserve.reserveLevel + inTransit;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  assert.equal(lhs, rhs,
    `${where}: hoards ${hoards} + reserve ${state.reserve.reserveLevel} + inTransit ${inTransit} = ${lhs}, `
    + `but produced ${state.audit.totalProduced} - consumed ${state.audit.totalConsumed} = ${rhs}`);
}

test('the pinned burns are what the engine actually quotes', () => {
  assert.equal(BURN_NEAR, 3, `${NEAR}'s route burn`);
  assert.equal(BURN_FAR, 50, `${FAR}'s route burn`);
});

// --- the deduction ---------------------------------------------------------

test('a BUY burns exactly the quoted fuel, and records it as consumed', () => {
  const s = burnState({ fuelHoard: 500 });
  const next = accept(s, buy(5, FAR));

  assert.equal(next.guilds[0].fuelHoard, 450, '500 - 50');
  assert.equal(next.audit.totalConsumed, BURN_FAR, 'the burn is recorded, not lost');
  assert.equal(next.audit.totalProduced, s.audit.totalProduced, 'and nothing was produced to offset it');

  // All nine, at the between-tick instant `POST /action` asserts at.
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after one BUY');

  // The cache the deduction moves — the reason the apply refreshes it at all.
  assert.equal(next.galacticSupply.fuel.guildHeld, 450);
  assert.deepEqual(next.galacticSupply, computeGalacticSupply(next), 'galactic-supply-consistency, live');

  // The burn is exactly what the client was quoted. One function, one number.
  assert.equal(s.guilds[0].fuelHoard - next.guilds[0].fuelHoard, routeFuelCost(FAR).fuelBurn);
});

test('the burn is cargo-independent — 1 unit and 1000 cost the same fuel', () => {
  // The ruling made observable at the point it is charged, not just where it is
  // quoted: quantity changes the CREDITS and not one drop of the fuel.
  const one = accept(burnState(), buy(1, FAR));
  const many = accept(burnState(), buy(1000, FAR));
  assert.equal(one.guilds[0].fuelHoard, many.guilds[0].fuelHoard, 'same burn');
  assert.equal(one.audit.totalConsumed, many.audit.totalConsumed);
  assert.notEqual(one.guilds[0].credits, many.guilds[0].credits, 'but the credits really did differ');
});

test('a hoard exactly equal to the burn is enough — and lands at zero', () => {
  // The boundary the gate is written on: `<` refuses, so equality must pass. An
  // off-by-one here would make the last affordable trade in a guild's life illegal.
  const s = burnState({ fuelHoard: BURN_FAR });
  const next = accept(s, buy(5, FAR));

  assert.equal(next.guilds[0].fuelHoard, 0, 'spent to the last drop');
  assert.equal(next.audit.totalConsumed, BURN_FAR);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after spending the hoard exactly');
});

test('one drop short is refused, whole, and changes nothing', () => {
  const s = burnState({ fuelHoard: BURN_FAR - 1 });
  const before = hashState(s);
  const reason = refuse(s, buy(5, FAR));

  // Both numbers in the message, so the player can see the gap without arithmetic.
  assert.match(reason, /insufficient fuel: need 50, have 49/);
  assert.match(reason, /fuel-supply-and-allocation\.md §8/);

  // REJECT-WHOLE: no partial trade, no shorter flight, no credits taken.
  assert.equal(hashState(s), before, 'validation is pure — a refusal leaves the state byte-identical');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('an empty hoard refuses too, with the same message shape', () => {
  const s = burnState({ fuelHoard: 0 });
  assert.match(refuse(s, buy(5, NEAR)), /insufficient fuel: need 3, have 0/);
  // ...and the guild is not otherwise broke: it is fuel, and only fuel, stopping it.
  assert.equal(s.guilds[0].credits, 100000);
});

// --- gate ordering ---------------------------------------------------------

test('the fuel gate runs LAST — a trade short on credits blames credits, not fuel', () => {
  // A guild short on BOTH. If the fuel gate ran earlier the player would be sent
  // to fix the wrong problem: they would top up fuel and still be refused.
  const s = burnState({ credits: 1, fuelHoard: 0 });
  const reason = refuse(s, buy(5, FAR));

  assert.match(reason, /cannot pay/, 'the credits refusal is the one returned');
  assert.doesNotMatch(reason, /insufficient fuel/, 'and fuel is not blamed for it');

  // The same trade, with credits fixed, THEN reports the fuel problem — proving the
  // fuel gate is genuinely there and merely later, not skipped.
  assert.match(refuse(burnState({ credits: 100000, fuelHoard: 0 }), buy(5, FAR)), /insufficient fuel/);
});

test('a system the guild does not hold is refused on territory, never on fuel', () => {
  // The other gate a fuel-first ordering would mask. `sys_0256` is real and unheld.
  const reason = refuse(burnState({ fuelHoard: 0 }), buy(5, 'sys_0256'));
  assert.match(reason, /does not hold system/);
  assert.doesNotMatch(reason, /insufficient fuel/);
});

// --- the batch race --------------------------------------------------------

test('two BUYs in one batch: the second is refused on the first\'s burn', () => {
  // The §15.6 discipline applied to fuel — each action validated against
  // state-as-it-stands INCLUDING everything accepted earlier in the same batch.
  // Fuel for exactly one far trip; the second must not fly on fuel already spent.
  const s = burnState({ fuelHoard: BURN_FAR });
  const { state: next, results } = intake(s, [buy(5, FAR), buy(5, FAR)]);

  assert.equal(results[0].accepted, true, 'the first trade flies');
  assert.equal(results[1].accepted, false, 'the second cannot');
  assert.match(results[1].reason, /insufficient fuel: need 50, have 0/);

  assert.equal(next.guilds[0].fuelHoard, 0);
  assert.equal(next.audit.totalConsumed, BURN_FAR, 'EXACTLY ONE deduction, not two and not none');
  assert.equal(next.shipments.length, 1, 'and exactly one delivery was scheduled');
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a half-accepted batch');
});

test('several BUYs in a row keep every invariant green — the cache is refreshed each time', () => {
  // The galacticSupply refresh, exercised repeatedly rather than once: a refresh
  // that only happened on the first trade would pass a single-buy test and fail here.
  let s = burnState({ fuelHoard: 500 });
  let spent = 0;
  for (let i = 0; i < 5; i += 1) {
    const dest = i % 2 === 0 ? NEAR : FAR;
    s = accept(s, buy(2, dest));
    spent += routeFuelCost(dest).fuelBurn;

    assert.equal(s.guilds[0].fuelHoard, 500 - spent, `hoard after buy ${i + 1}`);
    assert.equal(s.audit.totalConsumed, spent, `consumed after buy ${i + 1}`);
    assert.deepEqual(checkInvariants(s, s.tick), [], `invariants after buy ${i + 1}`);
    assert.deepEqual(s.galacticSupply, computeGalacticSupply(s), `cache after buy ${i + 1}`);
    assertFuelBalances(s, `after buy ${i + 1}`);
  }
  assert.equal(s.shipments.length, 5);
});

// --- SELL is untouched, deliberately ---------------------------------------

test('SELL burns NO fuel — a guild with an empty hoard can still sell', () => {
  // The Slice-3 scope ruling, pinned so it cannot drift in by accident. SELL is
  // multi-allocation and its per-route fuel question is unruled, so it is deferred
  // to the next slice. Until then a sale costs nothing to fly.
  const s = burnState({ fuelHoard: 0, stockpiles: { [NEAR]: { [GOOD]: 40 } } });
  const action = createSellToSyndicateAction({ guildId: 'g1', good: GOOD, allocations: [{ systemId: NEAR, qty: 40 }] });

  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `a sale from an empty hoard must still be legal, got: ${reason}`);

  const next = applyAction(s, action);
  assert.equal(next.guilds[0].fuelHoard, 0, 'no fuel to take, and none taken');
  assert.equal(next.audit.totalConsumed, 0, 'SELL records no burn in this slice');
  assert.ok(next.guilds[0].credits > s.guilds[0].credits, 'and the sale really did happen');
  assert.equal(getStock(next.guilds[0], NEAR, GOOD), 0);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('a SELL with fuel in the hoard leaves it exactly where it was', () => {
  // The other half: not merely "0 stays 0", but that a real hoard is not touched.
  const s = burnState({ fuelHoard: 500, stockpiles: { [NEAR]: { [GOOD]: 10 } } });
  const next = applyAction(s, createSellToSyndicateAction({
    guildId: 'g1', good: GOOD, allocations: [{ systemId: NEAR, qty: 10 }],
  }));
  assert.equal(next.guilds[0].fuelHoard, 500);
  assert.equal(next.audit.totalConsumed, 0);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// --- the no-route passthrough ----------------------------------------------

test('no waystation: the waystation gate refuses first, so the burn is never reached', () => {
  // `routeFuelCost` answers `{ fuelBurn: 0 }` for an unreachable system, and the
  // fuel gate would therefore pass it — correctly, since there is no cost without
  // a route. But the trade never gets that far: the waystation gate above already
  // refuses it on its own terms. This pins BOTH halves, so a future change that
  // removes the waystation gate cannot quietly let a free flight through.
  assert.deepEqual(routeFuelCost('sys_nope'), { fuelBurn: 0 });

  const s = burnState({ fuelHoard: 0 });
  const reason = refuse(s, buy(5, 'sys_nope'));
  assert.match(reason, /does not hold system|no Syndicate waystation/);
  assert.doesNotMatch(reason, /insufficient fuel/, 'a zero burn is never reported as unaffordable');

  assert.equal(s.guilds[0].fuelHoard, 0, 'and nothing moved');
  assert.equal(s.audit.totalConsumed, 0);
});
