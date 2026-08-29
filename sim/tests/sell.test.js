'use strict';

// sell.test.js — the `sellToSyndicate` action (design.md §5, "SELL GOES LIVE",
// 29-08-26): a guild sells stockpile goods to the Syndicate at the posted price,
// choosing how much comes out of EACH system that holds them.
//
// The tripwires, one per ruling:
//   - the sale is PLAYER-ALLOCATED: exactly the named systems drain, by exactly the
//     quantities named, and a system not named is untouched (no auto-spill, no
//     largest-pile-first — that idea is explicitly rejected in §5);
//   - the credits are `round(totalQty × price)`, ROUNDED ONCE on the total (#43) —
//     the same arithmetic `commitmentSale` uses, and provably not per-system;
//   - the ledger funds it, so invariant 2 holds exactly;
//   - THE SEAM: this is the first action to mutate a stockpile between ticks, so it
//     must refresh the galactic-supply cache or the consistency invariant trips the
//     moment `POST /action` asserts — asserted explicitly, before any tick;
//   - no reserve guard: a whole pile, or every pile, may be sold;
//   - fuel is never sold, and neither is anything the Syndicate posts no price for;
//   - market impact falls out of level-based pricing: the drained hoard prices lower;
//   - determinism (invariant 9), and the no-op proof that the action introduces no
//     serialized field — which is why every committed golden hash is untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants, assertInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock, guildTotals } = require('../stock.js');
const { postedPrice, leadingValue, PUBLISH_LAG, PRICED_GOODS } = require('../prices.js');
const { FUEL_GOOD } = require('../resources.js');
const { baselineOutputFor } = require('../baseline.js');
const {
  createSellToSyndicateAction, validateAction, applyAction, intake,
} = require('../actions.js');

const A = 'sysA';
const B = 'sysB';
const C = 'sysC';
const GOOD = 'titanium';

// Seatless synthetic ventures, exactly as the other engine tests build them, so the
// occupancy invariant has no siteId to resolve against the seed.
const mine = (id, systemId, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: good, productionRate: rate,
});

// A guild holding `good` in three systems, with the ledger funding its credits so
// invariant 2 starts balanced (expectedCreditTotal is derived by createState).
function sellState({ stock = { [A]: 900, [B]: 500, [C]: 40 }, credits = 1000, ventures = [] } = {}) {
  const stockpiles = {};
  for (const [systemId, qty] of Object.entries(stock)) stockpiles[systemId] = { [GOOD]: qty };
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 0, ventures, stockpiles }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
  });
}

// Set a good's POSTED value directly. The publish pipeline is prices.js's business;
// a sale only ever reads `posted`, so a test that needs a fractional rate sets that
// one field rather than ticking a curve into the shape it wants.
function setPosted(state, good, value) {
  state.prices[good].posted = value;
  return state;
}

const sell = (guildId, good, allocations) => createSellToSyndicateAction({ guildId, good, allocations });
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

// --- 1. the player-allocated drain, the credits, and the seam -----------------

test('a two-system sale drains exactly the systems named, pays round(total × price) once, and leaves every invariant green BEFORE any tick', () => {
  const before = setPosted(sellState(), GOOD, 12);
  const price = postedPrice(before, GOOD);
  const nA = 300;
  const nB = 125;

  const after = accept(before, sell('g1', GOOD, [{ systemId: A, qty: nA }, { systemId: B, qty: nB }]));
  const g = after.guilds[0];

  // The drain: exactly the named systems, by exactly the named quantities.
  assert.equal(getStock(g, A, GOOD), 900 - nA, 'system A dropped by exactly its allocation');
  assert.equal(getStock(g, B, GOOD), 500 - nB, 'system B dropped by exactly its allocation');
  assert.equal(getStock(g, C, GOOD), 40, 'the third system is UNTOUCHED — nothing spills');

  // The credits: rounded ONCE on the total (#43), funded by the ledger.
  const credited = Math.round((nA + nB) * price);
  assert.equal(g.credits, before.guilds[0].credits + credited);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger - credited);
  assert.equal(
    g.credits + after.syndicate.ledger,
    before.guilds[0].credits + before.syndicate.ledger,
    'invariant 2 exactly: the sale moves credits, it does not mint or destroy them',
  );

  // THE SEAM. `POST /action` asserts every invariant immediately after apply, with
  // no tick in between, and this is the first action to move goods. If the sale did
  // not refresh `state.galacticSupply`, the cache would still describe the goods it
  // just absorbed and the consistency invariant would fire here.
  assert.deepEqual(checkInvariants(after, after.tick), [], 'no violation immediately after the sale');
  assert.doesNotThrow(() => assertInvariants(after, after.tick));
  assert.deepEqual(
    after.galacticSupply, computeGalacticSupply(after),
    'the supply cache was refreshed by the action itself, not left for the next tick',
  );
  assert.equal(
    after.galacticSupply.resources[GOOD],
    before.galacticSupply.resources[GOOD] - (nA + nB),
    'and the refreshed cache shows the sold goods gone from the galaxy',
  );
});

test('the supply cache is what would trip — the same state without the refresh fails the consistency invariant', () => {
  // Proves the seam is load-bearing rather than incidental: take the sold state and
  // put the pre-sale cache back, and the invariant the sale would otherwise have
  // tripped fires by name.
  const before = setPosted(sellState(), GOOD, 12);
  const after = accept(before, sell('g1', GOOD, [{ systemId: A, qty: 300 }]));
  const stale = structuredClone(after);
  stale.galacticSupply = structuredClone(before.galacticSupply);

  const violations = checkInvariants(stale, stale.tick);
  assert.ok(violations.length > 0, 'a stale cache is a violation');
  assert.ok(
    violations.some((v) => v.rule === 'galactic-supply-consistency'),
    `expected galactic-supply-consistency, got ${JSON.stringify(violations.map((v) => v.rule))}`,
  );
});

test('the credits are rounded ONCE on the total, not per system', () => {
  // At ¢10.50 a unit, two one-unit allocations round to 11 each if rounded per
  // system (22) but to 21 rounded once on the total. #43 says once.
  const before = setPosted(sellState(), GOOD, 10.5);
  const after = accept(before, sell('g1', GOOD, [{ systemId: A, qty: 1 }, { systemId: B, qty: 1 }]));
  const credited = after.guilds[0].credits - before.guilds[0].credits;
  assert.equal(credited, 21, 'round(2 × 10.5) — one rounding on the total');
  assert.notEqual(credited, 22, 'NOT round(1 × 10.5) + round(1 × 10.5)');
});

test('the same total pays the same credits however the player splits it across systems', () => {
  const before = setPosted(sellState(), GOOD, 10.5);
  const oneWay = accept(before, sell('g1', GOOD, [{ systemId: A, qty: 7 }]));
  const another = accept(before, sell('g1', GOOD, [{ systemId: A, qty: 4 }, { systemId: B, qty: 3 }]));
  assert.equal(
    oneWay.guilds[0].credits, another.guilds[0].credits,
    'the split is a supply-chain choice, never a price choice',
  );
});

// --- 2. no reserve guard ------------------------------------------------------

test('a system\'s WHOLE pile may be sold, and so may every system\'s (§5: no reserve guard)', () => {
  const before = setPosted(sellState(), GOOD, 12);

  const whole = accept(before, sell('g1', GOOD, [{ systemId: C, qty: 40 }]));
  assert.equal(getStock(whole.guilds[0], C, GOOD), 0, 'the pile may be emptied');
  assert.deepEqual(checkInvariants(whole, whole.tick), []);

  const everything = accept(before, sell('g1', GOOD, [
    { systemId: A, qty: 900 }, { systemId: B, qty: 500 }, { systemId: C, qty: 40 },
  ]));
  assert.equal(guildTotals(everything.guilds[0])[GOOD], 0, 'every pile may be emptied');
  assert.equal(
    everything.guilds[0].credits - before.guilds[0].credits,
    Math.round(1440 * 12),
  );
  assert.deepEqual(checkInvariants(everything, everything.tick), []);
});

// --- 3. the rejections (normal outcomes, not errors) --------------------------

test('an allocation over that system\'s stock is refused, and the refusal names the system', () => {
  const state = sellState();
  reject(state, sell('g1', GOOD, [{ systemId: C, qty: 41 }]), /holds 40 titanium in system "sysC", cannot sell 41/);
  // ...and it is judged PER SYSTEM: a quantity the guild has galaxy-wide but not in
  // the system it named is still a refusal — there is no pooling across systems.
  reject(state, sell('g1', GOOD, [{ systemId: C, qty: 100 }]), /cannot sell 100/);
});

test('a system the guild holds none of the good in is refused by name', () => {
  const state = sellState();
  reject(state, sell('g1', GOOD, [{ systemId: 'sys_nobody', qty: 1 }]), /holds no titanium in system "sys_nobody"/);
  // A system the guild DOES operate in, but which holds none of this good.
  const other = sellState();
  other.guilds[0].stockpiles[A] = { copper: 10 };
  reject(other, sell('g1', GOOD, [{ systemId: A, qty: 1 }]), /holds no titanium in system "sysA"/);
});

test('fuel is never sold on the Exchange, and the refusal says why', () => {
  const state = sellState();
  state.guilds[0].stockpiles[A][FUEL_GOOD] = 100;   // not a stockpile good; force the shape anyway
  reject(state, sell('g1', FUEL_GOOD, [{ systemId: A, qty: 10 }]), /Syndicate-regulated/);
});

test('a good the Syndicate posts no price for is refused', () => {
  const state = sellState();
  reject(state, sell('g1', 'not_a_good', [{ systemId: A, qty: 1 }]), /is not a good the Syndicate posts a price for/);
  // A Tier-3 catalog placeholder is display-only vocabulary: no price, no sale.
  assert.ok(!PRICED_GOODS.includes('small_reactor_engine'), 'the Tier-3 names are catalog-only');
  reject(state, sell('g1', 'small_reactor_engine', [{ systemId: A, qty: 1 }]), /posts a price for/);
  // ...and a priced good whose price row was removed by hand is refused rather
  // than sold for nothing.
  const priceless = sellState();
  delete priceless.prices[GOOD];
  reject(priceless, sell('g1', GOOD, [{ systemId: A, qty: 1 }]), /has no posted price to sell at/);
});

test('a non-positive or non-integer qty is refused (§15.2: integer goods)', () => {
  const state = sellState();
  for (const qty of [0, -5, 1.5, '10', NaN]) {
    reject(state, sell('g1', GOOD, [{ systemId: A, qty }]), /must be a positive integer/);
  }
});

test('empty, malformed and duplicate allocations are refused', () => {
  const state = sellState();
  reject(state, sell('g1', GOOD, []), /must be a non-empty array/);
  reject(state, { type: 'sellToSyndicate', guildId: 'g1', good: GOOD, allocations: 'all' }, /must be a non-empty array/);
  reject(state, sell('g1', GOOD, [null]), /must be an object/);
  reject(state, sell('g1', GOOD, [{ systemId: '', qty: 1 }]), /non-empty systemId/);
  // A duplicate is refused, never silently summed — two rows for one system is an
  // ambiguous order, and adding them up would be the engine guessing.
  reject(
    state,
    sell('g1', GOOD, [{ systemId: A, qty: 10 }, { systemId: A, qty: 20 }]),
    /name system "sysA" twice/,
  );
});

test('an unknown guild is refused', () => {
  reject(sellState(), sell('ghost', GOOD, [{ systemId: A, qty: 1 }]), /no guild with id "ghost"/);
});

test('a rejected sale changes nothing at all', () => {
  const before = setPosted(sellState(), GOOD, 12);
  const { state: after, results } = intake(before, [sell('g1', GOOD, [{ systemId: C, qty: 999 }])]);
  assert.equal(results[0].accepted, false);
  assert.ok(results[0].reason, 'a rejection carries its reason — a normal outcome, not an error');
  assert.equal(hashState(after), hashState(before), 'state is byte-identical after a refused sale');
});

// --- 4. market impact — it falls out of level-based pricing -------------------

test('selling into your own hoard moves the posted price DOWN — no impact code, just the level', () => {
  // A real producer, so the good has capacity to be scarce against: with none, the
  // level is undefined and the price rests at base (prices.js), and there would be
  // nothing for a sale to move.
  const ventures = [mine('m1', A, GOOD, 5)];
  // The hoard is sized in TICKS OF GALAXY OUTPUT HELD — the unit the level is
  // measured in — off the engine's own droidless baseline, so no number is invented
  // here and the fixture cannot drift from prices.js. Nine ticks' worth is a real
  // hoard that still leaves the per-tick move inside the slew cap, so the two
  // branches separate on the very first recompute instead of both pinning to it.
  const capacity = baselineOutputFor(ventures[0]).units;
  const hoard = capacity * 9;
  const base = sellState({ stock: { [A]: hoard, [B]: 0, [C]: 0 }, ventures });

  const held = tick(base, []);                                   // the hoard sits
  const sold = tick(accept(base, sell('g1', GOOD, [{ systemId: A, qty: capacity * 8 }])), []);

  // The LEADING value is what this tick's recompute produced — the immediate signal.
  assert.ok(
    leadingValue(sold.prices[GOOD]) < leadingValue(held.prices[GOOD]),
    `the drained hoard is bid lower than the hoard that stayed put (${leadingValue(sold.prices[GOOD])} vs ${leadingValue(held.prices[GOOD])})`,
  );

  // ...and it reaches the POSTED value once the publish lag has run through, which
  // is the number the next seller actually trades against.
  let heldOn = held;
  let soldOn = sold;
  for (let i = 0; i < PUBLISH_LAG; i += 1) { heldOn = tick(heldOn, []); soldOn = tick(soldOn, []); }
  assert.ok(
    postedPrice(soldOn, GOOD) < postedPrice(heldOn, GOOD),
    `the posted price moves against the seller (${postedPrice(soldOn, GOOD)} vs ${postedPrice(heldOn, GOOD)})`,
  );
});

// --- 5. determinism (invariant 9) and the no-op proof -------------------------

test('the same sale from the same state is byte-identical, however the allocations are ordered', () => {
  const before = setPosted(sellState(), GOOD, 12);
  const forwards = [{ systemId: A, qty: 300 }, { systemId: B, qty: 125 }];
  const backwards = [{ systemId: B, qty: 125 }, { systemId: A, qty: 300 }];

  const once = accept(before, sell('g1', GOOD, forwards));
  const twice = accept(before, sell('g1', GOOD, forwards));
  assert.equal(hashState(once), hashState(twice), 'twice-run, byte-identical');
  assert.equal(
    hashState(once), hashState(accept(before, sell('g1', GOOD, backwards))),
    'the drain walks systems in sorted order, so the caller\'s row order cannot change the bytes',
  );
});

test('NO-OP PROOF: the sale introduces no serialized field — which is why every committed golden is untouched', () => {
  const before = setPosted(sellState(), GOOD, 12);
  const after = accept(before, sell('g1', GOOD, [{ systemId: A, qty: 300 }]));
  assert.deepEqual(
    Object.keys(after).sort(), Object.keys(before).sort(),
    'no new top-level state key',
  );
  assert.deepEqual(
    Object.keys(after.guilds[0]).sort(), Object.keys(before.guilds[0]).sort(),
    'no new guild key — the sale writes no record of itself',
  );
  // And a galaxy that never sells is entirely unchanged by this slice: the only
  // paths the action touches are its own.
  const untouched = sellState();
  assert.equal(hashState(tick(untouched, [])), hashState(tick(structuredClone(untouched), [])));
});
