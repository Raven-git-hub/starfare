'use strict';

// sell-fuel-burn.test.js — the SELL slice (docs/transport-model.md §8.0, RULED
// 03-09-26): `sellToSyndicate` burns route fuel too, mirroring `buyFromSyndicate`.
//
// The one thing SELL does that BUY does not: its burn is a SUM over the basket.
// A sale is `allocations: [{ systemId, qty }]` for one good, each row shipping to
// ITS OWN nearest waystation, so the bill COMPOUNDS — `Σ routeFuelCost(row).fuelBurn`.
// The whole order is refused if the hoard cannot cover that sum (reject-whole on
// the aggregate), and on apply the hoard falls by the sum in ONE deduction sunk
// into `audit.totalConsumed`.
//
// Everything these tripwires guard is the same fuel-destruction that fuel-burn.test.js
// guards for BUY: fuel leaves the galaxy with no counterparty, so invariant 1
// balances only because the hoard down is matched by `totalConsumed` up, and the
// deduction moves `galacticSupply.fuel.guildHeld`, which `POST /action` asserts on
// with no tick in between. So every accepting test asserts the FULL nine-invariant
// sweep, not invariant 1 alone.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock } = require('../stock.js');
const { routeFuelCost, GUILD_STARTING_FUEL } = require('../fuel.js');
const { farthestSystem, starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createSellToSyndicateAction, validateAction, applyAction, intake,
} = require('../actions.js');

// Two real seed systems at DIFFERENT distances, so their burns differ and a SUM is
// visibly not "one route" or "the max route" — DERIVED from the seed, not pinned.
const NEAR_HOME = starterHomeAtDistance(6);
const A = NEAR_HOME.id;                 // the guild's home, the near route
const B = farthestSystem().id;          // the far route — a bigger, distinct burn
const GOOD = 'titanium';

const BURN_A = routeFuelCost(A).fuelBurn;
const BURN_B = routeFuelCost(B).fuelBurn;
// The whole point of the slice: A and B cost different amounts, so BURN_A + BURN_B
// is a genuine sum, not a doubled single route. If a regen ever collapsed them the
// basket tests would stop proving anything — so assert the premise up front.
assert.notEqual(BURN_A, BURN_B, 'the two fixture routes must differ for the sum to mean anything');

// A guild holding `good` in both systems, ledger-funded so invariant 2 starts
// balanced and reserve-stocked so invariant 1 has something to conserve.
function sellState({ credits = 100000, fuelHoard = GUILD_STARTING_FUEL, stock = { [A]: 40, [B]: 40 } } = {}) {
  const stockpiles = {};
  for (const [systemId, qty] of Object.entries(stock)) stockpiles[systemId] = { [GOOD]: qty };
  const s = createState({
    guilds: [{ id: 'g1', credits, fuelHoard, stockpiles }],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -credits },
  });
  s.prices[GOOD].posted = 10;
  return s;
}

const sell = (allocations) => createSellToSyndicateAction({ guildId: 'g1', good: GOOD, allocations });
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

// --- the sum across allocations --------------------------------------------

test('a two-system basket burns the SUM of both routes, and still credits the full proceeds', () => {
  const s = sellState({ fuelHoard: 500 });
  const nA = 25;
  const nB = 10;
  const next = accept(s, sell([{ systemId: A, qty: nA }, { systemId: B, qty: nB }]));

  // The burn is BURN_A + BURN_B — not one route, not the larger route, the SUM.
  assert.equal(next.guilds[0].fuelHoard, 500 - (BURN_A + BURN_B), `500 - (${BURN_A} + ${BURN_B})`);
  assert.equal(next.audit.totalConsumed, BURN_A + BURN_B, 'the summed burn is recorded, not lost');
  assert.equal(next.audit.totalProduced, s.audit.totalProduced, 'and nothing was produced to offset it');

  // The sale is otherwise untouched: full proceeds credited, both stocks removed.
  assert.equal(next.guilds[0].credits, s.guilds[0].credits + (nA + nB) * 10, 'round((nA+nB) × price) credited in full');
  assert.equal(getStock(next.guilds[0], A, GOOD), 40 - nA, 'system A drained by its allocation');
  assert.equal(getStock(next.guilds[0], B, GOOD), 40 - nB, 'system B drained by its allocation');

  // All nine, at the between-tick instant `POST /action` asserts at.
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a two-system sale');

  // The cache the deduction moves — the reason apply refreshes it AFTER the burn.
  assert.equal(next.galacticSupply.fuel.guildHeld, 500 - (BURN_A + BURN_B));
  assert.deepEqual(next.galacticSupply, computeGalacticSupply(next), 'galactic-supply-consistency, live');
});

test('a single-allocation sale burns exactly that one route', () => {
  const s = sellState({ fuelHoard: 500 });
  const next = accept(s, sell([{ systemId: B, qty: 12 }]));
  assert.equal(next.guilds[0].fuelHoard, 500 - BURN_B, `500 - ${BURN_B}`);
  assert.equal(next.audit.totalConsumed, BURN_B);
  assert.equal(getStock(next.guilds[0], A, GOOD), 40, 'the unnamed system is untouched — no burn for a route not flown');
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a single-allocation sale');
});

test('the burn is cargo-independent — 1 unit and 30 across the same basket cost the same fuel', () => {
  // Quantity changes the CREDITS and not one drop of the fuel: the burn is geometry.
  const small = accept(sellState(), sell([{ systemId: A, qty: 1 }, { systemId: B, qty: 1 }]));
  const large = accept(sellState(), sell([{ systemId: A, qty: 30 }, { systemId: B, qty: 30 }]));
  assert.equal(small.guilds[0].fuelHoard, large.guilds[0].fuelHoard, 'same summed burn');
  assert.equal(small.audit.totalConsumed, large.audit.totalConsumed);
  assert.notEqual(small.guilds[0].credits, large.guilds[0].credits, 'but the credits really did differ');
});

// --- the boundary and reject-whole -----------------------------------------

test('a hoard exactly equal to the summed burn is enough — and lands at zero', () => {
  // `<` refuses, so equality must pass: the last affordable basket in a guild's life.
  const s = sellState({ fuelHoard: BURN_A + BURN_B });
  const next = accept(s, sell([{ systemId: A, qty: 5 }, { systemId: B, qty: 5 }]));
  assert.equal(next.guilds[0].fuelHoard, 0, 'spent to the last drop');
  assert.equal(next.audit.totalConsumed, BURN_A + BURN_B);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after spending the hoard exactly');
});

test('one drop short of the SUM is refused WHOLE — no credits, no stock removed, no fuel spent', () => {
  // The heart of reject-whole-on-the-aggregate: a hoard that covers BURN_A alone,
  // even both routes minus one, still refuses the entire basket. Nothing partial.
  const s = sellState({ fuelHoard: BURN_A + BURN_B - 1 });
  const before = hashState(s);
  const reason = refuse(s, sell([{ systemId: A, qty: 5 }, { systemId: B, qty: 5 }]));

  // Both numbers in the message, so the player sees the gap without arithmetic.
  assert.match(reason, new RegExp(`insufficient fuel: need ${BURN_A + BURN_B}, have ${BURN_A + BURN_B - 1}`));
  assert.match(reason, /fuel-supply-and-allocation\.md §8/);

  // REJECT-WHOLE: the whole action is a no-op — validation is pure, so byte-identical.
  assert.equal(hashState(s), before, 'a refused sale leaves the state byte-identical');
  assert.equal(s.guilds[0].credits, 100000, 'no credits gained');
  assert.equal(getStock(s.guilds[0], A, GOOD), 40, 'no stock removed from A');
  assert.equal(getStock(s.guilds[0], B, GOOD), 40, 'no stock removed from B');
  assert.equal(s.guilds[0].fuelHoard, BURN_A + BURN_B - 1, 'no fuel spent');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a basket affordable one row at a time is STILL refused whole if the SUM overruns', () => {
  // The clearest statement of "aggregate, not per-row": a hoard that could pay
  // EITHER route on its own cannot pay both, and the order is refused intact rather
  // than shortened to the row that fits.
  const s = sellState({ fuelHoard: Math.max(BURN_A, BURN_B) });
  const reason = refuse(s, sell([{ systemId: A, qty: 5 }, { systemId: B, qty: 5 }]));
  assert.match(reason, new RegExp(`need ${BURN_A + BURN_B}, have ${Math.max(BURN_A, BURN_B)}`));
});

// --- gate ordering ----------------------------------------------------------

test('the fuel gate runs LAST — a sale that overshoots stock blames stock, not fuel', () => {
  // Short on fuel AND asking for more stock than exists: the stock refusal is the
  // one returned, so the player is sent to the real problem.
  const s = sellState({ fuelHoard: 0 });
  const reason = refuse(s, sell([{ systemId: A, qty: 999 }]));
  assert.match(reason, /cannot sell 999/, 'the stock refusal is the one returned');
  assert.doesNotMatch(reason, /insufficient fuel/, 'and fuel is not blamed for it');

  // The same basket, legal on stock, THEN reports the fuel problem — proving the
  // fuel gate is genuinely there and merely later, not skipped.
  assert.match(refuse(sellState({ fuelHoard: 0 }), sell([{ systemId: A, qty: 5 }])), /insufficient fuel/);
});

// --- the batch race ---------------------------------------------------------

test('two sales in one batch: the second is refused on the first\'s burn', () => {
  // The §15.6 discipline applied to SELL fuel — each action validated against
  // state-as-it-stands INCLUDING everything accepted earlier in the same batch.
  // Fuel for exactly one far route; the second must not fly on fuel already spent.
  const s = sellState({ fuelHoard: BURN_B, stock: { [B]: 40 } });
  const { state: next, results } = intake(s, [sell([{ systemId: B, qty: 5 }]), sell([{ systemId: B, qty: 5 }])]);

  assert.equal(results[0].accepted, true, 'the first sale flies');
  assert.equal(results[1].accepted, false, 'the second cannot');
  assert.match(results[1].reason, new RegExp(`insufficient fuel: need ${BURN_B}, have 0`));

  assert.equal(next.guilds[0].fuelHoard, 0);
  assert.equal(next.audit.totalConsumed, BURN_B, 'EXACTLY ONE deduction, not two and not none');
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a half-accepted batch');
});

// --- conservation, the fuel-destruction tripwire ----------------------------

test('several sales in a row keep every invariant green — the cache is refreshed each time', () => {
  // The galacticSupply refresh exercised repeatedly: a refresh that only happened
  // on the first sale would pass a single-sale test and fail here.
  let s = sellState({ fuelHoard: 500, stock: { [A]: 100, [B]: 100 } });
  let spent = 0;
  for (let i = 0; i < 4; i += 1) {
    const rows = i % 2 === 0
      ? [{ systemId: A, qty: 3 }, { systemId: B, qty: 3 }]
      : [{ systemId: A, qty: 2 }];
    s = accept(s, sell(rows));
    spent += rows.reduce((sum, r) => sum + routeFuelCost(r.systemId).fuelBurn, 0);

    assert.equal(s.guilds[0].fuelHoard, 500 - spent, `hoard after sale ${i + 1}`);
    assert.equal(s.audit.totalConsumed, spent, `consumed after sale ${i + 1}`);
    assert.deepEqual(checkInvariants(s, s.tick), [], `invariants after sale ${i + 1}`);
    assert.deepEqual(s.galacticSupply, computeGalacticSupply(s), `cache after sale ${i + 1}`);
    assertFuelBalances(s, `after sale ${i + 1}`);
  }
});

// --- determinism (invariant 9) ----------------------------------------------

test('a burning sale is byte-identical run twice, and independent of the caller\'s row order', () => {
  const before = sellState({ fuelHoard: 500 });
  const forwards = [{ systemId: A, qty: 7 }, { systemId: B, qty: 3 }];
  const backwards = [{ systemId: B, qty: 3 }, { systemId: A, qty: 7 }];

  const once = accept(before, sell(forwards));
  const twice = accept(before, sell(forwards));
  assert.equal(hashState(once), hashState(twice), 'twice-run, byte-identical');
  assert.equal(
    hashState(once), hashState(accept(before, sell(backwards))),
    'the summed burn is order-independent, exactly as the drain is',
  );
});

// --- credit conservation is untouched ---------------------------------------

test('the sale\'s credit path is unchanged — invariant 2 holds, the ledger funds it', () => {
  const s = sellState({ fuelHoard: 500 });
  const before = s.guilds[0].credits + s.syndicate.ledger;
  const next = accept(s, sell([{ systemId: A, qty: 7 }, { systemId: B, qty: 3 }]));
  assert.equal(
    next.guilds[0].credits + next.syndicate.ledger, before,
    'the sale moves credits between guild and ledger — the fuel burn touches neither',
  );
  assert.deepEqual(checkInvariants(next, next.tick), []);
});
