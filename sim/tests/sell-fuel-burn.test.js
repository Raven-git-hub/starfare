'use strict';

// sell-fuel-burn.test.js — the SELL fuel burn (docs/transport-model.md §8.0, RULED
// 03-09-26): `sellToSyndicate` burns route fuel too, mirroring `buyFromSyndicate`.
//
// The SELL is now the held single-origin order (docs/syndicate-orders.md §5): many goods leave
// ONE origin on ONE space-tiered leg to that origin's nearest waystation, so the burn is a single
// `routeFuelCost(origin, totalSpace).fuelBurn`, not a sum over per-system rows. The retired
// multi-system `allocations` intake (each row its own leg, the burn compounding across rows) went
// away with the client slice (§8), and with it the per-row SUM this file used to prove; what
// remains — SELL burns fuel, at the total-space tier, reject-whole on the aggregate, the fuel gate
// last, the batch race, and the between-tick seam — is migrated to the single-origin leg.
//
// Fuel leaves the galaxy with no counterparty, so invariant 1 balances only because the hoard down
// is matched by `totalConsumed` up, and the deduction moves `galacticSupply.fuel.guildHeld`, which
// `POST /action` asserts on with no tick in between. So every accepting test asserts the FULL
// nine-invariant sweep, not invariant 1 alone.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock } = require('../stock.js');
const { routeFuelCost, routeFuelBurnByTier, volumeOf, GUILD_STARTING_FUEL } = require('../fuel.js');
const { farthestSystem, starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createAddOrderLineAction, createSellToSyndicateAction, validateAction, applyAction, intake,
} = require('../actions.js');

// Two real seed systems at DIFFERENT distances, so a sale from one is visibly a different route
// than a sale from the other — DERIVED from the seed, not pinned.
const NEAR_HOME = starterHomeAtDistance(6);
const A = NEAR_HOME.id;                 // the guild's home, the near route
const B = farthestSystem().id;          // the far route — a bigger, distinct burn
const GOOD = 'titanium';                // T1, volume 1

// Small quantities of titanium (volume 1) fit a LIGHT hold in space (§5.1), so these are the light
// per-hex burns for each origin. A bigger order crosses into the medium tier (light hold = 10,000
// space), a distinct, larger burn — the "steps by cargo SPACE between tiers" ruling (REVISED 14-09-26).
const BURN_A = routeFuelBurnByTier(A).light;
const BURN_A_MED = routeFuelBurnByTier(A).medium;
const BURN_B = routeFuelBurnByTier(B).light;
// A and B must cost different amounts for "a far origin flies its own route" to mean anything, and
// the light and medium tiers must differ for the tier-step test — assert the premises up front.
assert.notEqual(BURN_A, BURN_B, 'the two fixture origins must differ for the route choice to matter');
assert.notEqual(BURN_A, BURN_A_MED, 'the light and medium tiers must differ for the tier step to matter');

// A guild holding `good` in both systems, ledger-funded so invariant 2 starts balanced and
// reserve-stocked so invariant 1 has something to conserve.
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

// The SELL is the held single-origin finalise (§5): build a one-good order, then finalise from an
// origin. (The multi-system `allocations` intake was RETIRED with the client slice, §8.)
const addSell = (qty) => createAddOrderLineAction({ guildId: 'g1', side: 'sell', good: GOOD, qty });
const sellFrom = (origin) => createSellToSyndicateAction({ guildId: 'g1', originSystemId: origin });
const acceptSell = (state, qty, origin) => accept(accept(state, addSell(qty)), sellFrom(origin));
const refuseSell = (state, qty, origin) => refuse(accept(state, addSell(qty)), sellFrom(origin));

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

// --- the single-origin leg burn --------------------------------------------

test('a sell order burns its origin\'s one route at the total-space tier, and still credits the full proceeds', () => {
  const s = sellState({ fuelHoard: 500 });
  const n = 25;
  const next = acceptSell(s, n, A);

  // The burn is BURN_A — the one leg from A, at the light tier for this small load.
  assert.equal(next.guilds[0].fuelHoard, 500 - BURN_A, `500 - ${BURN_A}`);
  assert.equal(next.audit.totalConsumed, BURN_A, 'the burn is recorded, not lost');
  assert.equal(next.audit.totalProduced, s.audit.totalProduced, 'and nothing was produced to offset it');

  // The sale is otherwise untouched: full proceeds credited, the origin's stock removed.
  assert.equal(next.guilds[0].credits, s.guilds[0].credits + n * 10, 'round(n × price) credited in full');
  assert.equal(getStock(next.guilds[0], A, GOOD), 40 - n, 'the origin drained by the ordered qty');
  assert.equal(getStock(next.guilds[0], B, GOOD), 40, 'a system not the origin is untouched — no burn for a route not flown');

  // All nine, at the between-tick instant `POST /action` asserts at.
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a single-origin sale');

  // The cache the deduction moves — the reason apply refreshes it AFTER the burn.
  assert.equal(next.galacticSupply.fuel.guildHeld, 500 - BURN_A);
  assert.deepEqual(next.galacticSupply, computeGalacticSupply(next), 'galactic-supply-consistency, live');
});

test('a sale from a farther origin flies that origin\'s own, larger route', () => {
  const s = sellState({ fuelHoard: 500 });
  const next = acceptSell(s, 12, B);
  assert.equal(next.guilds[0].fuelHoard, 500 - BURN_B, `500 - ${BURN_B}`);
  assert.equal(next.audit.totalConsumed, BURN_B);
  assert.equal(getStock(next.guilds[0], A, GOOD), 40, 'the near system is untouched — the order flew from B');
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a far-origin sale');
});

test('the burn is flat WITHIN a tier and STEPS between tiers by total cargo space (§5.1)', () => {
  // Flat within LIGHT: 1 and 30 units of titanium (volume 1) keep the load inside the light hold,
  // so quantity changes the CREDITS and not one drop of the fuel.
  const small = acceptSell(sellState({ stock: { [A]: 40 } }), 1, A);
  const large = acceptSell(sellState({ stock: { [A]: 40 } }), 30, A);
  assert.equal(small.guilds[0].fuelHoard, large.guilds[0].fuelHoard, 'same light-tier burn within the tier');
  assert.equal(small.audit.totalConsumed, large.audit.totalConsumed);
  assert.notEqual(small.guilds[0].credits, large.guilds[0].credits, 'but the credits really did differ');

  // STEPS between tiers: 20,000 units = 20,000 space, over the 10,000 light hold, so it flies the
  // MEDIUM tier and burns the (larger) medium rate — proving the burn tracks total space, not qty.
  const medium = acceptSell(sellState({ fuelHoard: 500, stock: { [A]: 20000 } }), 20000, A);
  assert.equal(500 - medium.guilds[0].fuelHoard, BURN_A_MED, 'a medium-space load burns the medium rate');
  assert.notEqual(BURN_A_MED, BURN_A, 'and the medium rate is not the light one');
});

// --- the boundary and reject-whole -----------------------------------------

test('a hoard exactly equal to the burn is enough — and lands at zero', () => {
  // `<` refuses, so equality must pass: the last affordable sale in a guild's life.
  const s = sellState({ fuelHoard: BURN_A });
  const next = acceptSell(s, 5, A);
  assert.equal(next.guilds[0].fuelHoard, 0, 'spent to the last drop');
  assert.equal(next.audit.totalConsumed, BURN_A);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after spending the hoard exactly');
});

test('one drop short of the burn is refused WHOLE — no credits, no stock removed, no fuel spent', () => {
  // Reject-whole on the aggregate: a hoard one short of the leg's burn refuses the entire order.
  const s = sellState({ fuelHoard: BURN_A - 1 });
  const built = accept(s, addSell(5));
  const before = hashState(built);
  const reason = refuse(built, sellFrom(A));

  // Both numbers in the message, so the player sees the gap without arithmetic.
  assert.match(reason, new RegExp(`insufficient fuel: need ${BURN_A}, have ${BURN_A - 1}`));
  assert.match(reason, /fuel-supply-and-allocation\.md §8/);

  // REJECT-WHOLE: the whole finalise is a no-op — validation is pure, so byte-identical (draft and all).
  assert.equal(hashState(built), before, 'a refused sale leaves the state byte-identical');
  assert.equal(built.guilds[0].credits, 100000, 'no credits gained');
  assert.equal(getStock(built.guilds[0], A, GOOD), 40, 'no stock removed');
  assert.equal(built.guilds[0].fuelHoard, BURN_A - 1, 'no fuel spent');
  assert.deepEqual(checkInvariants(built, built.tick), []);
});

// --- gate ordering ----------------------------------------------------------

test('the fuel gate runs LAST — a sale that overshoots stock blames stock, not fuel', () => {
  // Short on fuel AND asking for more stock than the origin holds: the stock refusal is the one
  // returned, so the player is sent to the real problem.
  const reason = refuseSell(sellState({ fuelHoard: 0 }), 999, A);
  assert.match(reason, /does not hold enough stock/, 'the stock refusal is the one returned');
  assert.doesNotMatch(reason, /insufficient fuel/, 'and fuel is not blamed for it');

  // The same order, legal on stock, THEN reports the fuel problem — proving the fuel gate is
  // genuinely there and merely later, not skipped.
  assert.match(refuseSell(sellState({ fuelHoard: 0 }), 5, A), /insufficient fuel/);
});

// --- the batch race ---------------------------------------------------------

test('two sales in one batch: the second is refused on the first\'s burn', () => {
  // The §15.6 discipline applied to SELL fuel — each action validated against state-as-it-stands
  // INCLUDING everything accepted earlier in the same batch. Each finalise clears the order, so the
  // batch rebuilds it; there is fuel for exactly one far route, and the second must not fly on fuel
  // already spent.
  const s = sellState({ fuelHoard: BURN_B, stock: { [B]: 40 } });
  const { state: next, results } = intake(s, [
    addSell(5), sellFrom(B),
    addSell(5), sellFrom(B),
  ]);

  assert.equal(results[0].accepted, true, 'first add');
  assert.equal(results[1].accepted, true, 'the first sale flies');
  assert.equal(results[2].accepted, true, 'second add');
  assert.equal(results[3].accepted, false, 'the second sale cannot');
  assert.match(results[3].reason, new RegExp(`insufficient fuel: need ${BURN_B}, have 0`));

  assert.equal(next.guilds[0].fuelHoard, 0);
  assert.equal(next.audit.totalConsumed, BURN_B, 'EXACTLY ONE deduction, not two and not none');
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a half-accepted batch');
});

// --- conservation, the fuel-destruction tripwire ----------------------------

test('several sales in a row keep every invariant green — the cache is refreshed each time', () => {
  // The galacticSupply refresh exercised repeatedly: a refresh that only happened on the first sale
  // would pass a single-sale test and fail here.
  let s = sellState({ fuelHoard: 500, stock: { [A]: 100, [B]: 100 } });
  let spent = 0;
  for (let i = 0; i < 4; i += 1) {
    const origin = i % 2 === 0 ? A : B;
    const qty = i % 2 === 0 ? 3 : 2;
    s = acceptSell(s, qty, origin);
    spent += routeFuelCost(origin, qty * volumeOf(GOOD)).fuelBurn;

    assert.equal(s.guilds[0].fuelHoard, 500 - spent, `hoard after sale ${i + 1}`);
    assert.equal(s.audit.totalConsumed, spent, `consumed after sale ${i + 1}`);
    assert.deepEqual(checkInvariants(s, s.tick), [], `invariants after sale ${i + 1}`);
    assert.deepEqual(s.galacticSupply, computeGalacticSupply(s), `cache after sale ${i + 1}`);
    assertFuelBalances(s, `after sale ${i + 1}`);
  }
});

// --- determinism (invariant 9) ----------------------------------------------

test('a burning sale is byte-identical run twice', () => {
  const before = sellState({ fuelHoard: 500 });
  const once = acceptSell(before, 7, A);
  const twice = acceptSell(before, 7, A);
  assert.equal(hashState(once), hashState(twice), 'twice-run, byte-identical');
});

// --- credit conservation is untouched ---------------------------------------

test('the sale\'s credit path is unchanged — invariant 2 holds, the ledger funds it', () => {
  const s = sellState({ fuelHoard: 500 });
  const before = s.guilds[0].credits + s.syndicate.ledger;
  const next = acceptSell(s, 7, A);
  assert.equal(
    next.guilds[0].credits + next.syndicate.ledger, before,
    'the sale moves credits between guild and ledger — the fuel burn touches neither',
  );
  assert.deepEqual(checkInvariants(next, next.tick), []);
});
