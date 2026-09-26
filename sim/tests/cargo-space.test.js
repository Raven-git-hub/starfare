'use strict';

// cargo-space.test.js — the multi-good order cart and the space-cap reject-whole
// (docs/transport-model.md §5.1 / §8.0, REVISED 14-09-26). The engine half of the
// shipment rebuild: a BUY carries several goods to ONE destination on ONE hauler, sized
// by the cart's total cargo SPACE; a load over the heavy hold is reject-wholed; and SELL
// space-tiers and caps the whole single-origin order. The cart is now the guild's HELD
// buy/sell order (docs/syndicate-orders.md §5) — the inline `cart`/`good` and multi-system
// `allocations` intake was RETIRED with the client slice (§8).
//
// The tripwires:
//   - a two-good order to one held destination → ONE shipment carrying both → stepArrivals
//     deposits both; cost = Σ per-good; burn = the TOTAL-space tier (so a cart that crosses
//     into medium burns the medium rate);
//   - an empty order is refused;
//   - a one-line light-hold order burns the light rate;
//   - space cap: a BUY order over 6,000,000 space is refused whole (state untouched); a SELL
//     order over it is refused; a single T3 module needs a heavy; 100 T3 fit a heavy, 101 do not;
//   - invariant 1 still closes after a tiered burn.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { getStock } = require('../stock.js');
const { postedPrice, basePriceFor } = require('../prices.js');
const { nearestWaystation } = require('../transport.js');
const {
  GUILD_STARTING_FUEL, routeFuelCost, volumeOf, haulerTierForSpace, HEAVY_HOLD,
} = require('../fuel.js');
const {
  createAddOrderLineAction, createBuyFromSyndicateAction, createSellToSyndicateAction,
  validateAction, applyAction,
} = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const DEST_HOME = starterHomeAtDistance(6);
const DEST = DEST_HOME.id;
const DEST_HOME_PLANET = DEST_HOME.homePlanet;
const DEST_DISTANCE = DEST_HOME.distance;

// One good of each tier that rides a cart.
const RAW = 'titanium';               // T1, volume 1
const PROCESSED = 'battery_cells';     // T2, volume 100
const MODULE = 'cargo_handling_system'; // T3, volume 60,000

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

function buyState({ credits = 100_000_000, fuelHoard = GUILD_STARTING_FUEL } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits, fuelHoard, homeSystemId: DEST, homePlanetId: DEST_HOME_PLANET,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims: [homeClaim('g1', DEST)],
  });
  // Posted prices pinned at each good's tier base (T1 1, T2 10, T3 100). ⤳ 26-09-26: was a
  // flat 10 for all three, which is now below a T3 module's floor of 20 (per-tier bands).
  for (const good of [RAW, PROCESSED, MODULE]) s.prices[good].posted = basePriceFor(good);
  return s;
}

function sellState({ fuelHoard = GUILD_STARTING_FUEL, stock = {} } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 100_000, fuelHoard, homeSystemId: DEST, homePlanetId: DEST_HOME_PLANET,
      stockpiles: { [DEST]: { ...stock } },
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: -100_000 },
    claims: [homeClaim('g1', DEST)],
  });
  // Pinned at each good's tier base, as buyState does (⤳ 26-09-26: was a flat 10).
  for (const good of [RAW, PROCESSED, MODULE]) s.prices[good].posted = basePriceFor(good);
  return s;
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const reject = (state, action, match) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected a rejection');
  assert.match(reason, match);
  return reason;
};
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// Build a held order from a list of { good, qty } lines, then hand back the state ready to finalise.
const buildOrder = (state, side, lines) => {
  let s = state;
  for (const { good, qty } of lines) {
    s = accept(s, createAddOrderLineAction({ guildId: 'g1', side, good, qty }));
  }
  return s;
};

// --- the multi-good cart ---------------------------------------------------

test('a two-good buy order flies as ONE shipment carrying both goods, cost is the per-good sum', () => {
  let s = buyState();
  // 5000 titanium (5,000 space) + 60 battery_cells (6,000 space) = 11,000 space — a MEDIUM
  // leg (over the 10,000 light hold), so the burn is the medium rate, not the light one.
  s = buildOrder(s, 'buy', [{ good: RAW, qty: 5000 }, { good: PROCESSED, qty: 60 }]);
  const totalSpace = 5000 * volumeOf(RAW) + 60 * volumeOf(PROCESSED);
  assert.equal(totalSpace, 11000);
  assert.equal(haulerTierForSpace(totalSpace), 'medium', 'the cart crosses into the medium hold');

  const before = s.guilds[0];
  const creditsBefore = before.credits;
  const fuelBefore = before.fuelHoard;
  const next = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: DEST }));

  // ONE shipment, carrying BOTH goods.
  assert.equal(next.shipments.length, 1, 'one cart, one hauler, one shipment');
  assert.deepEqual(next.shipments[0].cargo, { [RAW]: 5000, [PROCESSED]: 60 });

  // Cost = Σ round(qty × posted) per good; at the tier bases (1 and 10) that is 5,000 + 600.
  const expectedCost = Math.round(5000 * basePriceFor(RAW)) + Math.round(60 * basePriceFor(PROCESSED));
  assert.equal(expectedCost, 5600);
  assert.equal(creditsBefore - next.guilds[0].credits, expectedCost);

  // Burn = the TOTAL-space tier, the medium rate on the DEST route.
  const expectedBurn = routeFuelCost(DEST, totalSpace).fuelBurn;
  assert.equal(fuelBefore - next.guilds[0].fuelHoard, expectedBurn, 'burns the total-space (medium) tier');
  assert.equal(next.audit.totalConsumed, expectedBurn);
  assert.equal(next.guilds[0].buyOrder, undefined, 'the held order is cleared on success');
  assert.deepEqual(checkInvariants(next, next.tick), [], 'invariant 1 closes after a tiered burn');
});

test('stepArrivals deposits every good in the order on the arrival tick', () => {
  let s = buyState();
  s = buildOrder(s, 'buy', [{ good: RAW, qty: 5000 }, { good: PROCESSED, qty: 60 }]);
  const bought = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: DEST }));
  const arrivalTick = bought.shipments[0].arrivalTick;

  const landed = ticks(bought, arrivalTick - bought.tick);
  assert.equal(landed.tick, arrivalTick);
  assert.equal(getStock(landed.guilds[0], DEST, RAW), 5000, 'the raw good landed');
  assert.equal(getStock(landed.guilds[0], DEST, PROCESSED), 60, 'and the processed good landed, same shipment');
  assert.deepEqual(landed.shipments, [], 'the delivered shipment leaves the list');
  assert.deepEqual(checkInvariants(landed, landed.tick), []);
});

test('an empty buy order is refused', () => {
  const s = buyState();
  reject(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: DEST }),
    /has no buy order to finalise/);
});

test('a one-line light-hold buy order burns the light rate', () => {
  let s = buyState();
  // 12 titanium = 12 space, a light-hold leg.
  s = buildOrder(s, 'buy', [{ good: RAW, qty: 12 }]);
  const bought = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: DEST }));
  assert.deepEqual(bought.shipments[0].cargo, { [RAW]: 12 }, 'the shipment cargo shape');
  const { distance } = nearestWaystation(DEST);
  assert.equal(GUILD_STARTING_FUEL - bought.guilds[0].fuelHoard, Math.ceil(distance * 0.5), 'a light-hold leg burns the light rate');
});

// --- the space cap reject-whole --------------------------------------------

test('a single T3 module needs a heavy; 100 fit a heavy, 101 do not', () => {
  assert.equal(haulerTierForSpace(volumeOf(MODULE)), 'heavy', 'one module (60,000) exceeds the 50,000 medium');
  assert.equal(haulerTierForSpace(100 * volumeOf(MODULE)), 'heavy', '100 modules fill a heavy hold exactly');
  assert.equal(100 * volumeOf(MODULE), HEAVY_HOLD);
  assert.equal(haulerTierForSpace(101 * volumeOf(MODULE)), null, '101 modules are over the heavy hold');
});

test('a BUY order over the heavy hold is reject-whole, and changes nothing', () => {
  // 101 modules = 6,060,000 space, over the 6,000,000 heavy hold.
  let s = buildOrder(buyState(), 'buy', [{ good: MODULE, qty: 101 }]);
  const before = hashState(s);
  const reason = reject(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: DEST }),
    /exceeds the Syndicate heavy hold/);
  assert.match(reason, new RegExp(String(HEAVY_HOLD)));
  assert.equal(hashState(s), before, 'a refused order leaves the state byte-identical (validation is pure), draft untouched');

  // 100 modules (exactly the heavy hold) is accepted and flies heavy.
  let s100 = buildOrder(buyState(), 'buy', [{ good: MODULE, qty: 100 }]);
  const ok = accept(s100, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: DEST }));
  assert.deepEqual(ok.shipments[0].cargo, { [MODULE]: 100 });
  const { distance } = nearestWaystation(DEST);
  assert.equal(GUILD_STARTING_FUEL - ok.guilds[0].fuelHoard, Math.ceil(distance * 0.7), 'a full heavy burns the heavy rate');
});

test('a SELL order over the heavy hold is reject-whole', () => {
  let s = buildOrder(sellState({ stock: { [MODULE]: 101 } }), 'sell', [{ good: MODULE, qty: 101 }]);
  reject(s, createSellToSyndicateAction({ guildId: 'g1', originSystemId: DEST }),
    /exceeds the Syndicate heavy hold/);

  // 100 modules is one heavy order — accepted, and it burns the heavy rate (§5.1).
  let s100 = buildOrder(sellState({ stock: { [MODULE]: 100 } }), 'sell', [{ good: MODULE, qty: 100 }]);
  const before = s100.guilds[0].fuelHoard;
  const next = accept(s100, createSellToSyndicateAction({ guildId: 'g1', originSystemId: DEST }));
  const { distance } = nearestWaystation(DEST);
  assert.equal(before - next.guilds[0].fuelHoard, Math.ceil(distance * 0.7), 'the module order flies heavy');
  assert.equal(getStock(next.guilds[0], DEST, MODULE), 0, 'the whole pile sold');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});
