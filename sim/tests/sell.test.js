'use strict';

// sell.test.js — the `sellToSyndicate` finalise (design.md §5, "SELL GOES LIVE";
// docs/syndicate-orders.md §5): a guild builds a held SELL order line by line, then finalises it
// from ONE origin. The Syndicate settles it at the posted price, immediately, with no shipment.
//
// The retired multi-system `allocations` intake (one good spread across many systems) went away
// with the client slice (§8); a sale is now the held single-origin order. What that changed for
// this file: proceeds round PER LINE (§5, round(qty × price) per good), the origin holds every
// line's stock, and there is no per-allocation composition to order or duplicate. The
// multi-system-only coverage (per-system rounding, cross-system split-invariance, malformed /
// duplicate allocations) is dropped as a retired mechanic; everything else is migrated.
//
// The tripwires, one per ruling:
//   - the order drains exactly its lines from the origin, and nothing else;
//   - proceeds are `round(qty × price)` PER LINE (§5), funded by the ledger, so invariant 2 holds;
//   - THE SEAM: this is the first action to mutate a stockpile between ticks, so it must refresh
//     the galactic-supply cache or the consistency invariant trips the moment `POST /action`
//     asserts — asserted explicitly, before any tick;
//   - no reserve guard: a whole pile may be sold;
//   - fuel is never sold, and neither is anything the Syndicate posts no price for;
//   - market impact falls out of level-based pricing: the drained hoard prices lower;
//   - single-origin determinism (invariant 9), and the no-op proof that the finalise introduces no
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
  createAddOrderLineAction, createSellToSyndicateAction, validateAction, applyAction, intake,
} = require('../actions.js');

// One origin, many goods — the held single-origin order (§5). The synthetic systems carry no seed
// coordinates, so `routeFuelCost` reads 0 burn from them (as the pre-retirement sell tests relied
// on), which keeps the fuel invariant balanced with an empty hoard; the fuel burn itself is proved
// against real waystation geometry in sell-fuel-burn.test.js.
const ORIGIN = 'sysA';
const GOOD = 'titanium';        // T1, volume 1
const GOOD2 = 'battery_cells';  // T2, volume 100

// Seatless synthetic ventures, exactly as the other engine tests build them, so the
// occupancy invariant has no siteId to resolve against the seed.
const mine = (id, systemId, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: good, productionRate: rate,
});

// A guild holding the given goods at ORIGIN, with the ledger funding its credits so invariant 2
// starts balanced (expectedCreditTotal is derived by createState).
function sellState({ stock = { [GOOD]: 900, [GOOD2]: 500 }, credits = 1000, ventures = [] } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 0, ventures, stockpiles: { [ORIGIN]: { ...stock } } }],
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

const add = (side, good, qty) => createAddOrderLineAction({ guildId: 'g1', side, good, qty });
// Build a held sell order from a list of { good, qty } lines.
const buildSell = (state, lines) => {
  let s = state;
  for (const { good, qty } of lines) s = accept(s, add('sell', good, qty));
  return s;
};
const sellFrom = (guildId, originSystemId) => createSellToSyndicateAction({ guildId, originSystemId });

// --- 1. the drain, the per-line proceeds, and the seam ------------------------

test('a multi-good order drains exactly its lines from the origin, pays Σ round(qty × price) per line, and leaves every invariant green BEFORE any tick', () => {
  let before = setPosted(setPosted(sellState(), GOOD, 12), GOOD2, 12);
  const price = 12;
  const nGood = 300;
  const nGood2 = 125;
  before = buildSell(before, [{ good: GOOD, qty: nGood }, { good: GOOD2, qty: nGood2 }]);

  const after = accept(before, sellFrom('g1', ORIGIN));
  const g = after.guilds[0];

  // The drain: exactly the ordered lines, by exactly the ordered quantities.
  assert.equal(getStock(g, ORIGIN, GOOD), 900 - nGood, 'the raw line dropped by exactly its qty');
  assert.equal(getStock(g, ORIGIN, GOOD2), 500 - nGood2, 'the processed line dropped by exactly its qty');
  assert.equal(g.sellOrder, undefined, 'the held order is cleared on success');

  // The proceeds: rounded PER LINE (§5), funded by the ledger.
  const credited = Math.round(nGood * price) + Math.round(nGood2 * price);
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
    before.galacticSupply.resources[GOOD] - nGood,
    'and the refreshed cache shows the sold goods gone from the galaxy',
  );
});

test('the supply cache is what would trip — the same state without the refresh fails the consistency invariant', () => {
  // Proves the seam is load-bearing rather than incidental: take the sold state and
  // put the pre-sale cache back, and the invariant the sale would otherwise have
  // tripped fires by name.
  const before = buildSell(setPosted(sellState(), GOOD, 12), [{ good: GOOD, qty: 300 }]);
  const after = accept(before, sellFrom('g1', ORIGIN));
  const stale = structuredClone(after);
  stale.galacticSupply = structuredClone(before.galacticSupply);

  const violations = checkInvariants(stale, stale.tick);
  assert.ok(violations.length > 0, 'a stale cache is a violation');
  assert.ok(
    violations.some((v) => v.rule === 'galactic-supply-consistency'),
    `expected galactic-supply-consistency, got ${JSON.stringify(violations.map((v) => v.rule))}`,
  );
});

test('proceeds are round(qty × price) PER LINE (§5), not once on the whole order', () => {
  // At ¢10.50 a unit, two one-unit lines round to 11 each — 22 rounded per line, where
  // the retired one-good/many-systems path rounded once on the total (21). The held order
  // is many goods at (potentially) many prices, so each line settles on its own rounding.
  const before = buildSell(
    setPosted(setPosted(sellState(), GOOD, 10.5), GOOD2, 10.5),
    [{ good: GOOD, qty: 1 }, { good: GOOD2, qty: 1 }],
  );
  const after = accept(before, sellFrom('g1', ORIGIN));
  const credited = after.guilds[0].credits - before.guilds[0].credits;
  assert.equal(credited, 22, 'round(1 × 10.5) + round(1 × 10.5) — one rounding per line');
});

// --- 2. no reserve guard ------------------------------------------------------

test('every pile at the origin may be sold to zero (§5: no reserve guard)', () => {
  const before = buildSell(
    setPosted(setPosted(sellState(), GOOD, 12), GOOD2, 12),
    [{ good: GOOD, qty: 900 }, { good: GOOD2, qty: 500 }],
  );
  const after = accept(before, sellFrom('g1', ORIGIN));
  assert.equal(guildTotals(after.guilds[0])[GOOD], 0, 'the raw pile may be emptied');
  assert.equal(guildTotals(after.guilds[0])[GOOD2], 0, 'and the processed pile');
  assert.equal(
    after.guilds[0].credits - before.guilds[0].credits,
    Math.round(900 * 12) + Math.round(500 * 12),
  );
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- 3. the rejections (normal outcomes, not errors) --------------------------

test('an order the origin cannot cover reject-wholes, naming the short lines and the shortfall', () => {
  // The origin holds 40 titanium and none of the processed good; the order asks more of each.
  let s = setPosted(setPosted(sellState({ stock: { [GOOD]: 40 } }), GOOD, 12), GOOD2, 12);
  s = buildSell(s, [{ good: GOOD, qty: 41 }, { good: GOOD2, qty: 3 }]);
  const before = hashState(s);
  const reason = reject(s, sellFrom('g1', ORIGIN), /does not hold enough stock/);
  assert.match(reason, /titanium \(need 41, hold 40\)/, 'names the over-ordered line and its shortfall');
  assert.match(reason, /battery_cells \(need 3, hold 0\)/, 'and a line the origin holds none of');
  assert.equal(hashState(s), before, 'a refused sell order is left untouched (draft and all)');
});

test('fuel can never be added to a sell order, and the refusal says why', () => {
  const state = sellState();
  reject(state, add('sell', FUEL_GOOD, 10), /Syndicate-regulated/);
});

test('a good the Syndicate posts no price for is refused', () => {
  const state = sellState();
  // An unknown good is refused at build time — it is not in the Exchange's vocabulary.
  reject(state, add('sell', 'not_a_good', 1), /is not a good the Syndicate posts a price for/);
  // 2.1a: a Tier-3 module is now a real priced good, so it is a legal order line (the old
  // "catalog-only, no sale" case retired when modules joined the economy).
  assert.ok(PRICED_GOODS.includes('small_reactor_engine'), 'a module is priced now');
  // ...and a priced good whose price row was removed by hand is refused at finalise rather
  // than sold for nothing (the order builds while the price exists, then the row is deleted).
  let priceless = buildSell(sellState({ stock: { [GOOD]: 10 } }), [{ good: GOOD, qty: 1 }]);
  delete priceless.prices[GOOD];
  reject(priceless, sellFrom('g1', ORIGIN), /has no posted price to sell at/);
});

test('a non-positive or non-integer qty cannot be ordered (§15.2: integer goods)', () => {
  const state = sellState();
  for (const qty of [0, -5, 1.5, '10', NaN]) {
    reject(state, add('sell', GOOD, qty), /must be a positive integer/);
  }
});

test('finalising an empty (absent) sell order is refused', () => {
  reject(sellState(), sellFrom('g1', ORIGIN), /has no sell order to finalise/);
});

test('an unknown guild is refused', () => {
  reject(sellState(), sellFrom('ghost', ORIGIN), /no guild with id "ghost"/);
});

test('a rejected sale changes nothing at all', () => {
  const before = buildSell(
    setPosted(sellState({ stock: { [GOOD]: 40 } }), GOOD, 12),
    [{ good: GOOD, qty: 999 }],
  );
  const { state: after, results } = intake(before, [sellFrom('g1', ORIGIN)]);
  assert.equal(results[0].accepted, false);
  assert.ok(results[0].reason, 'a rejection carries its reason — a normal outcome, not an error');
  assert.equal(hashState(after), hashState(before), 'state is byte-identical after a refused sale');
});

// --- 4. market impact — it falls out of level-based pricing -------------------

test('selling into your own hoard moves the posted price DOWN — no impact code, just the level', () => {
  // A real producer, so the good has capacity to be scarce against: with none, the
  // level is undefined and the price rests at base (prices.js), and there would be
  // nothing for a sale to move.
  const ventures = [mine('m1', ORIGIN, GOOD, 5)];
  // The hoard is sized in TICKS OF GALAXY OUTPUT HELD — the unit the level is
  // measured in — off the engine's own droidless baseline, so no number is invented
  // here and the fixture cannot drift from prices.js. Nine ticks' worth is a real
  // hoard that still leaves the per-tick move inside the slew cap, so the two
  // branches separate on the very first recompute instead of both pinning to it.
  const capacity = baselineOutputFor(ventures[0]).units;
  const hoard = capacity * 9;
  const base = sellState({ stock: { [GOOD]: hoard }, ventures });

  const held = tick(base, []);                                   // the hoard sits
  const sold = tick(accept(buildSell(base, [{ good: GOOD, qty: capacity * 8 }]), sellFrom('g1', ORIGIN)), []);

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

test('the same order finalises byte-identical, whichever order its lines were added in', () => {
  const priced = () => setPosted(setPosted(sellState(), GOOD, 12), GOOD2, 12);
  const forwards = buildSell(priced(), [{ good: GOOD, qty: 300 }, { good: GOOD2, qty: 125 }]);
  const backwards = buildSell(priced(), [{ good: GOOD2, qty: 125 }, { good: GOOD, qty: 300 }]);

  const once = accept(forwards, sellFrom('g1', ORIGIN));
  const twice = accept(forwards, sellFrom('g1', ORIGIN));
  assert.equal(hashState(once), hashState(twice), 'twice-run, byte-identical');
  assert.equal(
    hashState(once), hashState(accept(backwards, sellFrom('g1', ORIGIN))),
    'addOrderLine keeps lines sorted and the drain walks them sorted, so the add order cannot change the bytes',
  );
});

test('NO-OP PROOF: the finalise introduces no serialized field — which is why every committed golden is untouched', () => {
  const pristine = setPosted(sellState(), GOOD, 12);
  const built = buildSell(structuredClone(pristine), [{ good: GOOD, qty: 300 }]);
  const after = accept(built, sellFrom('g1', ORIGIN));
  assert.equal('sellOrder' in after.guilds[0], false, 'the held order is cleared — omitted again');
  assert.deepEqual(
    Object.keys(after).sort(), Object.keys(pristine).sort(),
    'no new top-level state key',
  );
  assert.deepEqual(
    Object.keys(after.guilds[0]).sort(), Object.keys(pristine.guilds[0]).sort(),
    'no new guild key — the finalise writes no record of itself',
  );
  // And a galaxy that never sells is entirely unchanged by this slice: the only
  // paths the action touches are its own.
  const untouched = sellState();
  assert.equal(hashState(tick(untouched, [])), hashState(tick(structuredClone(untouched), [])));
});
