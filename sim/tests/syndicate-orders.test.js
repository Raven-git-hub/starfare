'use strict';

// syndicate-orders.test.js — the ENGINE half of the Syndicate order model
// (docs/syndicate-orders.md, RULED 16-09-26). A guild builds a held buy/sell ORDER line by
// line, then finalises it; the engine owns the order state (§2), the three build actions (§3),
// the finalise that reads the held order and clears it (§5), the snapshot's derived cargo
// space/tier (§4), and the checkOrders tripwire.
//
// The tripwires (mirroring the build prompt's "Prove it"):
//   - build actions: append, top-up, keep-sorted, create-then-omit, reject bad good/qty, buy⊥sell;
//   - persist round-trip: a guild with both orders restores byte-identical; an order-less guild
//     serializes exactly as today (the omit-when-empty proof);
//   - checkOrders trips on a duplicate good, an unsorted line list, a non-priced good, a bad qty;
//   - finalise from the held order: BUY → one shipment with all goods, Σ cost, space-tiered burn,
//     buyOrder cleared; SELL → Σ proceeds, stock removed, sellOrder cleared; empty refused; each
//     reject-whole leaves the order untouched;
//   - backward-compat: the legacy inline BUY and multi-system SELL behave exactly as before;
//   - snapshot: buyOrder/sellOrder publish lines[].space, totalSpace, haulerTier, overCap; absent
//     for a guild with no order.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState, createGuild } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { nearestWaystation } = require('../transport.js');
const { buildSnapshot } = require('../snapshot.js');
const {
  GUILD_STARTING_FUEL, routeFuelCost, volumeOf, haulerTierForSpace, HEAVY_HOLD,
} = require('../fuel.js');
const {
  createAddOrderLineAction, createRemoveOrderLineAction, createClearOrderAction,
  createBuyFromSyndicateAction, createSellToSyndicateAction,
  validateAction, applyAction,
} = require('../actions.js');
const { goodState } = require('./fixtures.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const HOME = starterHomeAtDistance(6);
const SYS = HOME.id;
const SYS_PLANET = HOME.homePlanet;

// One good of each tier that rides a cart, and their sorted order by good id.
const RAW = 'titanium';                 // T1, volume 1
const PROCESSED = 'battery_cells';       // T2, volume 100
const MODULE = 'cargo_handling_system';  // T3, volume 60,000

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// A guild seated on SYS, holding it, with flat posted prices — enough for build + finalise.
function orderState({ credits = 100_000_000, fuelHoard = GUILD_STARTING_FUEL, stock = {} } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits, fuelHoard, homeSystemId: SYS, homePlanetId: SYS_PLANET,
      stockpiles: { [SYS]: { ...stock } },
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: -credits },
    claims: [homeClaim('g1', SYS)],
  });
  for (const good of [RAW, PROCESSED, MODULE]) s.prices[good].posted = 10;
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

const add = (guildId, side, good, qty) => createAddOrderLineAction({ guildId, side, good, qty });

// --- build actions ---------------------------------------------------------

test('addOrderLine appends a line, creating the order on the first add', () => {
  const s = orderState();
  assert.equal(s.guilds[0].buyOrder, undefined, 'no order until the first add (omit-when-empty)');
  const next = accept(s, add('g1', 'buy', RAW, 5));
  assert.deepEqual(next.guilds[0].buyOrder, { lines: [{ good: RAW, qty: 5 }] });
  assert.deepEqual(checkInvariants(next, next.tick), [], 'a built order passes checkOrders');
});

test('addOrderLine tops up a repeated good — one line, summed qty', () => {
  let s = orderState();
  s = accept(s, add('g1', 'buy', RAW, 5));
  s = accept(s, add('g1', 'buy', RAW, 7));
  assert.deepEqual(s.guilds[0].buyOrder, { lines: [{ good: RAW, qty: 12 }] }, 'one line, 5 + 7');
});

test('addOrderLine keeps lines sorted by good id', () => {
  let s = orderState();
  // Add out of sorted order: titanium, then battery_cells, then cargo_handling_system.
  s = accept(s, add('g1', 'buy', RAW, 1));
  s = accept(s, add('g1', 'buy', PROCESSED, 2));
  s = accept(s, add('g1', 'buy', MODULE, 3));
  const goods = s.guilds[0].buyOrder.lines.map((l) => l.good);
  assert.deepEqual(goods, [...goods].sort(), 'lines are sorted ascending by good id');
  assert.deepEqual(goods, [PROCESSED, MODULE, RAW]);
});

test('add then remove-last omits the order entirely (create-then-omit)', () => {
  let s = orderState();
  s = accept(s, add('g1', 'buy', RAW, 5));
  s = accept(s, createRemoveOrderLineAction({ guildId: 'g1', side: 'buy', good: RAW }));
  assert.equal(s.guilds[0].buyOrder, undefined, 'the emptied order is omitted, not left as { lines: [] }');
  assert.equal('buyOrder' in s.guilds[0], false, 'no key at all');
});

test('removeOrderLine on a good the order lacks is refused (fail loud)', () => {
  let s = orderState();
  s = accept(s, add('g1', 'buy', RAW, 5));
  reject(s, createRemoveOrderLineAction({ guildId: 'g1', side: 'buy', good: PROCESSED }),
    /has no line for/);
});

test('clearOrder empties the order and is idempotent', () => {
  let s = orderState();
  s = accept(s, add('g1', 'buy', RAW, 5));
  s = accept(s, add('g1', 'buy', PROCESSED, 2));
  s = accept(s, createClearOrderAction({ guildId: 'g1', side: 'buy' }));
  assert.equal(s.guilds[0].buyOrder, undefined, 'cleared to omitted');
  // Clearing an already-empty order is a valid no-op.
  s = accept(s, createClearOrderAction({ guildId: 'g1', side: 'buy' }));
  assert.equal(s.guilds[0].buyOrder, undefined);
});

test('addOrderLine rejects a non-priced good, fuel, and a non-positive/non-integer qty', () => {
  const s = orderState();
  reject(s, add('g1', 'buy', 'deuterium_fuel', 1), /fuel is never listed/);
  reject(s, add('g1', 'buy', 'not_a_good', 1), /not a good the Syndicate posts a price for/);
  reject(s, add('g1', 'buy', RAW, 0), /positive integer/);
  reject(s, add('g1', 'buy', RAW, -3), /positive integer/);
  reject(s, add('g1', 'buy', RAW, 2.5), /positive integer/);
  reject(s, createAddOrderLineAction({ guildId: 'g1', side: 'sideways', good: RAW, qty: 1 }), /must be "buy" or "sell"/);
});

test('buy and sell orders are independent', () => {
  let s = orderState();
  s = accept(s, add('g1', 'buy', RAW, 5));
  s = accept(s, add('g1', 'sell', PROCESSED, 3));
  assert.deepEqual(s.guilds[0].buyOrder, { lines: [{ good: RAW, qty: 5 }] });
  assert.deepEqual(s.guilds[0].sellOrder, { lines: [{ good: PROCESSED, qty: 3 }] });
  // Clearing one leaves the other untouched.
  s = accept(s, createClearOrderAction({ guildId: 'g1', side: 'buy' }));
  assert.equal(s.guilds[0].buyOrder, undefined);
  assert.deepEqual(s.guilds[0].sellOrder, { lines: [{ good: PROCESSED, qty: 3 }] });
});

// --- persist / omit-when-empty round-trip ----------------------------------

test('a guild with a buyOrder + sellOrder saves and restores byte-identical', () => {
  const g = createGuild({
    id: 'g1', credits: 10, fuelHoard: 5,
    buyOrder: { lines: [{ good: PROCESSED, qty: 2 }, { good: RAW, qty: 9 }] },
    sellOrder: { lines: [{ good: MODULE, qty: 1 }] },
  });
  // The canonical serialization round-trips through JSON.parse (persist's restore path) and back
  // through createGuild (state's restore path) byte-identically.
  const restoredRaw = JSON.parse(canonicalStringify(g));
  assert.equal(canonicalStringify(restoredRaw), canonicalStringify(g), 'raw parse round-trips');
  const restoredThroughCreate = createGuild(restoredRaw);
  assert.equal(canonicalStringify(restoredThroughCreate), canonicalStringify(g),
    'createGuild preserves both orders, deep-copied, byte-identical');
  // The clone does not alias: mutating the input's lines does not touch the built guild.
  assert.deepEqual(g.buyOrder.lines[0], { good: PROCESSED, qty: 2 });
});

test('an order-less guild serializes exactly as today (the omit-when-empty proof)', () => {
  const plain = createGuild({ id: 'g1', credits: 10, fuelHoard: 5 });
  assert.equal('buyOrder' in plain, false, 'no buyOrder key');
  assert.equal('sellOrder' in plain, false, 'no sellOrder key');
  // An empty order handed in is still omitted (normalised to absent, like assets/deuterium).
  const emptyIn = createGuild({ id: 'g1', credits: 10, fuelHoard: 5, buyOrder: { lines: [] }, sellOrder: null });
  assert.equal(canonicalStringify(emptyIn), canonicalStringify(plain),
    'an empty/null order in ⇒ byte-identical to a guild that never had one');
});

// --- checkOrders tripwire --------------------------------------------------

// A malformed order injected onto the fixture guild trips exactly checkOrders (the fixture passes
// every other invariant), and the returned rule names the order problem.
function tripFor(order) {
  const s = goodState();
  s.guilds[0].buyOrder = order;
  return checkInvariants(s, 0);
}
const hasRule = (violations, re) => violations.some((v) => re.test(v.rule));

test('checkOrders trips on a duplicate good', () => {
  const v = tripFor({ lines: [{ good: RAW, qty: 1 }, { good: RAW, qty: 2 }] });
  assert.ok(hasRule(v, /order-line-good-unique/), JSON.stringify(v));
});

test('checkOrders trips on an unsorted line list', () => {
  // titanium before battery_cells is out of ascending order.
  const v = tripFor({ lines: [{ good: RAW, qty: 1 }, { good: PROCESSED, qty: 1 }] });
  assert.ok(hasRule(v, /order-lines-sorted-by-good/), JSON.stringify(v));
});

test('checkOrders trips on a non-priced good', () => {
  const v = tripFor({ lines: [{ good: 'deuterium_fuel', qty: 1 }] });
  assert.ok(hasRule(v, /order-line-good-priced-not-fuel/), JSON.stringify(v));
});

test('checkOrders trips on a bad qty', () => {
  assert.ok(hasRule(tripFor({ lines: [{ good: RAW, qty: 0 }] }), /order-line-qty-positive-int/));
  assert.ok(hasRule(tripFor({ lines: [{ good: RAW, qty: 2.5 }] }), /order-line-qty-positive-int/));
});

test('checkOrders trips on a present-but-empty order (should have been omitted)', () => {
  assert.ok(hasRule(tripFor({ lines: [] }), /order-omitted-when-empty/));
});

// --- finalise the held BUY order -------------------------------------------

test('a built buyOrder finalises to one destination: one shipment, Σ cost, tiered burn, cleared', () => {
  let s = orderState();
  // 5000 titanium (5,000 space) + 60 battery_cells (6,000 space) = 11,000 → a MEDIUM leg.
  s = accept(s, add('g1', 'buy', RAW, 5000));
  s = accept(s, add('g1', 'buy', PROCESSED, 60));
  const totalSpace = 5000 * volumeOf(RAW) + 60 * volumeOf(PROCESSED);
  assert.equal(haulerTierForSpace(totalSpace), 'medium');

  const creditsBefore = s.guilds[0].credits;
  const fuelBefore = s.guilds[0].fuelHoard;
  // The held-order finalise carries NO cart and NO good — just the destination.
  const next = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: SYS }));

  assert.equal(next.shipments.length, 1, 'one order, one hauler, one shipment');
  assert.deepEqual(next.shipments[0].cargo, { [RAW]: 5000, [PROCESSED]: 60 }, 'all goods, one shipment');

  const expectedCost = Math.round(5000 * 10) + Math.round(60 * 10);
  assert.equal(creditsBefore - next.guilds[0].credits, expectedCost, 'Σ per-good cost debited');

  const expectedBurn = routeFuelCost(SYS, totalSpace).fuelBurn;
  assert.equal(fuelBefore - next.guilds[0].fuelHoard, expectedBurn, 'the total-space (medium) tier burns');
  assert.equal(next.guilds[0].buyOrder, undefined, 'the held order is cleared on success');
  assert.deepEqual(checkInvariants(next, next.tick), [], 'invariant 1 closes after a tiered burn');
});

test('finalising an empty buy order is refused', () => {
  const s = orderState();
  reject(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: SYS }),
    /has no buy order to finalise/);
});

test('a BUY finalise that reject-wholes leaves the held order untouched', () => {
  // Short credits: build an affordable-looking order but starve the treasury.
  let s = orderState({ credits: 1 });
  s = accept(s, add('g1', 'buy', RAW, 100));
  const before = hashState(s);
  reject(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: SYS }),
    /cannot pay/);
  assert.equal(hashState(s), before, 'the draft (and everything else) is byte-identical after a refusal');

  // Unheld destination: the territory gate reject-wholes, order untouched.
  const other = starterHomeAtDistance(8).id;
  reject(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: other }),
    /does not hold system/);
  assert.equal(hashState(s), before);
});

test('a BUY held order over the heavy hold is reject-wholed (split-the-order)', () => {
  let s = orderState();
  // 101 modules = 6,060,000 space, over the 6,000,000 heavy hold.
  s = accept(s, add('g1', 'buy', MODULE, 101));
  reject(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: SYS }),
    /exceeds the Syndicate heavy hold/);
  // The snapshot flags it over-cap while it is built.
  const snap = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  assert.equal(snap.buyOrder.overCap, true);
  assert.equal(snap.buyOrder.haulerTier, null, 'no tier fits an over-cap order');
});

// --- finalise the held SELL order (single origin, many goods) ---------------

test('a built sellOrder finalises from one origin: Σ proceeds, stock removed, cleared', () => {
  let s = orderState({ stock: { [RAW]: 5000, [PROCESSED]: 60 } });
  s = accept(s, add('g1', 'sell', RAW, 5000));
  s = accept(s, add('g1', 'sell', PROCESSED, 60));
  const totalSpace = 5000 * volumeOf(RAW) + 60 * volumeOf(PROCESSED);

  const creditsBefore = s.guilds[0].credits;
  const fuelBefore = s.guilds[0].fuelHoard;
  const next = accept(s, createSellToSyndicateAction({ guildId: 'g1', originSystemId: SYS }));

  // Immediate settlement — no shipment.
  assert.deepEqual(next.shipments, [], 'a SELL settles immediately, no shipment');
  const expectedProceeds = Math.round(5000 * 10) + Math.round(60 * 10);
  assert.equal(next.guilds[0].credits - creditsBefore, expectedProceeds, 'Σ per-good proceeds credited');
  assert.equal(getStock(next.guilds[0], SYS, RAW), 0, 'raw stock removed');
  assert.equal(getStock(next.guilds[0], SYS, PROCESSED), 0, 'processed stock removed');

  const expectedBurn = routeFuelCost(SYS, totalSpace).fuelBurn;
  assert.equal(fuelBefore - next.guilds[0].fuelHoard, expectedBurn, 'one leg at the total-space tier');
  assert.equal(next.guilds[0].sellOrder, undefined, 'the held order is cleared on success');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('finalising an empty sell order is refused', () => {
  const s = orderState();
  reject(s, createSellToSyndicateAction({ guildId: 'g1', originSystemId: SYS }),
    /has no sell order to finalise/);
});

test('a SELL finalise short on stock at the origin reject-wholes, naming the short lines', () => {
  // The order asks more than the origin holds.
  let s = orderState({ stock: { [RAW]: 10 } });
  s = accept(s, add('g1', 'sell', RAW, 5000));
  s = accept(s, add('g1', 'sell', PROCESSED, 3)); // origin holds none of these
  const before = hashState(s);
  const reason = reject(s, createSellToSyndicateAction({ guildId: 'g1', originSystemId: SYS }),
    /does not hold enough stock/);
  assert.match(reason, new RegExp(RAW));
  assert.match(reason, new RegExp(PROCESSED));
  assert.equal(hashState(s), before, 'a refused sell order is left untouched');
});

test('a SELL held order over the heavy hold is reject-wholed', () => {
  let s = orderState({ stock: { [MODULE]: 101 } });
  s = accept(s, add('g1', 'sell', MODULE, 101));
  reject(s, createSellToSyndicateAction({ guildId: 'g1', originSystemId: SYS }),
    /exceeds the Syndicate heavy hold/);
});

// --- backward compatibility ------------------------------------------------

test('the legacy inline single-good BUY behaves exactly as before', () => {
  const s = orderState();
  const before = s.guilds[0];
  const legacy = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', good: RAW, qty: 12, destinationSystemId: SYS }));
  assert.deepEqual(legacy.shipments[0].cargo, { [RAW]: 12 });
  const { distance } = nearestWaystation(SYS);
  assert.equal(before.fuelHoard - legacy.guilds[0].fuelHoard, Math.ceil(distance * 0.5), 'a light-hold leg burns the light rate');
  assert.equal(before.credits - legacy.guilds[0].credits, 120);
  assert.equal('buyOrder' in legacy.guilds[0], false, 'a legacy BUY never touches a held order');
});

test('the legacy multi-system SELL behaves exactly as before', () => {
  const s = orderState({ stock: { [RAW]: 100 } });
  const before = s.guilds[0];
  const legacy = accept(s, createSellToSyndicateAction({
    guildId: 'g1', good: RAW, allocations: [{ systemId: SYS, qty: 40 }],
  }));
  assert.equal(legacy.guilds[0].credits - before.credits, Math.round(40 * 10), 'proceeds at posted price');
  assert.equal(getStock(legacy.guilds[0], SYS, RAW), 60, 'only the allocated qty drained');
  assert.equal('sellOrder' in legacy.guilds[0], false, 'a legacy SELL never touches a held order');
  assert.deepEqual(checkInvariants(legacy, legacy.tick), []);
});

// --- snapshot --------------------------------------------------------------

test('the snapshot publishes an order with per-line space, totals, tier and overCap', () => {
  let s = orderState();
  s = accept(s, add('g1', 'buy', RAW, 5000));
  s = accept(s, add('g1', 'buy', PROCESSED, 60));
  const snap = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  const totalSpace = 5000 * volumeOf(RAW) + 60 * volumeOf(PROCESSED);
  assert.deepEqual(snap.buyOrder.lines, [
    { good: PROCESSED, qty: 60, space: 60 * volumeOf(PROCESSED) },
    { good: RAW, qty: 5000, space: 5000 * volumeOf(RAW) },
  ], 'each line echoes its engine-computed space, in sorted order');
  assert.equal(snap.buyOrder.totalUnits, 5060);
  assert.equal(snap.buyOrder.totalSpace, totalSpace);
  assert.equal(snap.buyOrder.haulerTier, 'medium');
  assert.equal(snap.buyOrder.overCap, false);
});

test('the snapshot omits buyOrder/sellOrder for a guild with no order', () => {
  const snap = buildSnapshot(orderState()).guilds.find((g) => g.id === 'g1');
  assert.equal('buyOrder' in snap, false);
  assert.equal('sellOrder' in snap, false);
});
