'use strict';

// prices.test.js — the resource price engine (sim/prices.js + tick.js step 3),
// against docs/licence-and-price-system.md Part 1.
//
// The mechanical tripwires, one per settled ruling: the value RISES on a hoard and
// CRASHES on a drain (the direction is the whole point), a rare good moves sharper
// than a common one for the same hoard (rarity-aware for free), consumed stock
// prices below static stock (the idleness term), one huge jump moves it by at most
// the slew cap (smoothing), the published value is the one computed two ticks ago
// (the lag), fuel is never priced, and the whole thing is deterministic — including
// the no-op proof that an empty galaxy's prices sit at base and add nothing spurious.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { previewProduction } = require('../production.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { RAW_RESOURCES, PROCESSED_GOODS, FUEL_GOOD } = require('../resources.js');
const { RECIPES } = require('../recipes.js');
const {
  BASE_PRICE, EMA_ALPHA, MAX_SLEW_PCT, PRICE_FLOOR, PRICE_CEILING, PUBLISH_LAG,
  PRICED_GOODS, LEVEL_SENSITIVITY,
  seedPrices, leadingValue, postedPrice, productionCapacity, priceTarget,
  advanceLeading, recomputePrices,
} = require('../prices.js');
const { MINE_BASELINE, REFINERY_BASELINE, baselineOutputFor } = require('../baseline.js');

const SYS = 'sysA';

// Synthetic ventures, seatless (no siteId) exactly as the other engine tests build
// them, so the occupancy invariant has nothing to resolve.
const mine = (id, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate,
});
const refinery = (id, recipeId, rate) => ({
  id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate,
});

function sysState(ventures = [], stockpiles = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures, stockpiles: { [SYS]: stockpiles } }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

const posted = (s, good) => s.prices[good].posted;
const leading = (s, good) => leadingValue(s.prices[good]);
const setStock = (s, good, qty) => { s.guilds[0].stockpiles[SYS][good] = qty; };

// --- 1. the direction: rises on a hoard, crashes on a drain -------------------

test('a good accumulating in guild stockpiles is bid UP, tick over tick', () => {
  // One titanium mine, nothing consuming: the pile only grows, so the level only
  // rises. Capacity is the mine's fixed droidless baseline (5), so level = ticks held.
  let s = sysState([mine('m', 'titanium', 5)]);
  const series = [];
  for (let i = 0; i < 20; i += 1) { s = tick(s); series.push(posted(s, 'titanium')); }

  assert.equal(series[0], BASE_PRICE, 'nothing is published until the lag has run');
  const climbing = series.slice(PUBLISH_LAG); // the ticks whose published value is real
  for (let i = 1; i < climbing.length; i += 1) {
    assert.ok(climbing[i] > climbing[i - 1], `tick ${i}: ${climbing[i]} must exceed ${climbing[i - 1]}`);
  }
  assert.ok(series[series.length - 1] > BASE_PRICE * 1.5, 'a 20-tick hoard has visibly moved the value');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('draining the hoard crashes the value back down', () => {
  let s = sysState([mine('m', 'titanium', 5)]);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  const peak = posted(s, 'titanium');
  assert.ok(peak > BASE_PRICE * 2, 'the hoard really did build first');

  // Drain it: the pile is sold/shipped away and the mine is throttled off. Capacity
  // is unchanged (it reads the venture TYPE's baseline, never productionRate), so
  // the level falls to 0 and the value has nowhere to go but back toward base.
  s.guilds[0].ventures[0].productionRate = 0;
  setStock(s, 'titanium', 0);
  s.galacticSupply.resources.titanium = 0; // keep the derived cache honest for the invariants

  const series = [];
  for (let i = 0; i < 12; i += 1) { s = tick(s); series.push(posted(s, 'titanium')); }
  const falling = series.slice(PUBLISH_LAG);
  for (let i = 1; i < falling.length; i += 1) {
    assert.ok(falling[i] < falling[i - 1], `tick ${i}: ${falling[i]} must fall below ${falling[i - 1]}`);
  }
  assert.ok(series[series.length - 1] < peak, 'the drain pulled the value down from its peak');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. rarity scaling: gentle common, sharp rare -----------------------------

test('the same hoard moves a low-capacity good far more than a high-capacity one', () => {
  // The formula, first: identical hoards, one producer vs ten.
  assert.ok(priceTarget(100, 5, 0) > priceTarget(100, 50, 0));

  // And end to end. Both goods hold 100 units; neodymium has ONE mine (capacity 5),
  // copper has TEN (capacity 50). Every mine is throttled to 0 so the piles stay put
  // and the ONLY difference between the two goods is how many producers exist —
  // which is exactly the rarity term.
  const copperMines = Array.from({ length: 10 }, (_, i) => mine(`c${i}`, 'copper', 0));
  let s = sysState([mine('n', 'neodymium', 0), ...copperMines], { neodymium: 100, copper: 100 });
  assert.equal(productionCapacity(s).neodymium, 5);
  assert.equal(productionCapacity(s).copper, 50);

  for (let i = 0; i < 30; i += 1) s = tick(s);
  // Compare the GAIN over base — the whole of what the hoard bought each good. Ten
  // producers dilute the same pile tenfold, and the price says so.
  const rareGain = posted(s, 'neodymium') - BASE_PRICE;
  const commonGain = posted(s, 'copper') - BASE_PRICE;
  assert.ok(commonGain > 0, 'the common good still moved — gentle, not dead');
  assert.ok(rareGain > commonGain * 5,
    `rare gain ${rareGain} must far outrun common gain ${commonGain}`);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. idleness: working inventory prices below a hoard ----------------------

test('the formula discounts consumed stock against identical static stock', () => {
  assert.ok(priceTarget(100, 5, 40) < priceTarget(100, 5, 0));
  assert.equal(priceTarget(100, 5, 0), BASE_PRICE * (1 + LEVEL_SENSITIVITY * 20), 'static stock takes the full level');
});

test('the tick feeds step 3 the REAL downstream draw, without re-resolving production', () => {
  // A small titanium pile with a live alloy refinery drawing on it. The draw the price
  // step must see is the resolver's own `fork.downstream` — previewProduction reports
  // what the next tick will do, from the SAME resolver the tick applies, so this
  // asserts the price used engine truth rather than a second, drifting resolve. The
  // pile is kept small deliberately: the two candidate values must sit inside the slew
  // cap, or the cap would bind and hide which number was actually used.
  // The rate-0 mine is there only to give titanium a producer, i.e. a non-zero
  // capacity to be scarce against; it produces nothing.
  let s = sysState([mine('m', 'titanium', 0), refinery('r', 'titanium_alloy', 2)],
    { titanium: 12, carbon_products: 12 });
  const drawn = previewProduction(s)[0].systems[0].goods.titanium.fork.downstream;
  assert.ok(drawn > 0, 'the fixture really does consume titanium');

  const next = tick(s);
  const stockAfter = next.guilds[0].stockpiles[SYS].titanium;
  const capacity = productionCapacity(next).titanium;
  const expected = advanceLeading(BASE_PRICE, priceTarget(stockAfter, capacity, drawn));
  const asIfIdle = advanceLeading(BASE_PRICE, priceTarget(stockAfter, capacity, 0));
  assert.equal(leading(next, 'titanium'), expected, 'the value moved on the resolver\'s own draw');
  assert.notEqual(expected, asIfIdle, 'and that draw demonstrably changed the answer');
  assert.ok(expected < asIfIdle, 'consumed stock priced below the same pile sitting idle');
});

test('a stockpile being consumed downstream prices below an identical static one', () => {
  // Two galaxies, identical titanium capacity (one rate-0 mine each) and an identical
  // pile held flat every tick — so the LEVEL term is pinned equal and the only thing
  // that can separate them is the downstream draw.
  // The pile is modest and the run long enough for both to CONVERGE on their targets:
  // while a value is still climbing it is pinned to the slew cap, which would mask the
  // difference the idleness term makes.
  const HOARD = 20;
  let idle = sysState([mine('m', 'titanium', 0)], { titanium: HOARD });
  let busy = sysState([mine('m', 'titanium', 0), refinery('r', 'titanium_alloy', 2)],
    { titanium: HOARD, carbon_products: 10000 });

  for (let i = 0; i < 40; i += 1) {
    idle = tick(idle);
    busy = tick(busy);
    // Re-pin both piles: the point is to isolate idleness from the level.
    setStock(idle, 'titanium', HOARD);
    setStock(busy, 'titanium', HOARD);
    idle.galacticSupply.resources.titanium = HOARD;
    busy.galacticSupply.resources.titanium = HOARD;
  }
  assert.equal(productionCapacity(idle).titanium, productionCapacity(busy).titanium);
  assert.ok(posted(busy, 'titanium') < posted(idle, 'titanium'),
    `working inventory ${posted(busy, 'titanium')} must price below the hoard ${posted(idle, 'titanium')}`);
  assert.deepEqual(checkInvariants(idle, idle.tick), []);
  assert.deepEqual(checkInvariants(busy, busy.tick), []);
});

// --- 4. smoothing + the slew cap ---------------------------------------------

test('a single huge stock jump moves the value by at most the slew cap', () => {
  // A hoard so large the target pins at the ceiling. One tick may still only move
  // the value by MAX_SLEW_PCT of where it stands.
  let s = sysState([mine('m', 'titanium', 0)], { titanium: 1000000 });
  const before = leading(s, 'titanium');
  s = tick(s);
  assert.equal(leading(s, 'titanium'), before * (1 + MAX_SLEW_PCT), 'exactly the cap, not the target');
  assert.ok(leading(s, 'titanium') < PRICE_CEILING, 'nowhere near the target it is heading for');

  // And it keeps climbing at the cap, never teleporting.
  for (let i = 0; i < 5; i += 1) {
    const prev = leading(s, 'titanium');
    s = tick(s);
    assert.ok(leading(s, 'titanium') <= prev * (1 + MAX_SLEW_PCT) + 1e-9);
  }
});

test('the EMA glides toward the target rather than snapping to it', () => {
  // With the slew cap out of the way (a target close enough that the EMA step is the
  // binding constraint), one tick closes exactly ALPHA of the gap.
  const target = BASE_PRICE * 1.05;
  assert.equal(advanceLeading(BASE_PRICE, target), BASE_PRICE + (EMA_ALPHA * (target - BASE_PRICE)));
});

test('the value is clamped into the soft floor/ceiling band', () => {
  assert.equal(advanceLeading(PRICE_CEILING, PRICE_CEILING * 10), PRICE_CEILING, 'the ceiling holds');
  assert.equal(advanceLeading(PRICE_FLOOR, 0), PRICE_FLOOR, 'the floor holds');
  // The clamp lands LAST, so a wild target can never wind the EMA memory past the band.
  let v = BASE_PRICE;
  for (let i = 0; i < 500; i += 1) v = advanceLeading(v, 1e9);
  assert.equal(v, PRICE_CEILING);
});

// --- 5. the two-tick publish lag ---------------------------------------------

test('the value published at tick N is the one computed at tick N-2', () => {
  let s = sysState([mine('m', 'titanium', 5)]);
  const computed = [null, null]; // computed[k] = the leading value at the end of tick k
  const published = [null, null];
  for (let t = 1; t <= 10; t += 1) {
    s = tick(s);
    computed[t] = leading(s, 'titanium');
    published[t] = posted(s, 'titanium');
  }
  for (let t = 1 + PUBLISH_LAG; t <= 10; t += 1) {
    assert.equal(published[t], computed[t - PUBLISH_LAG], `tick ${t} publishes tick ${t - PUBLISH_LAG}'s value`);
  }
  assert.equal(published[1], BASE_PRICE, 'the first ticks publish the seeded base — nothing computed yet');
  assert.equal(published[2], BASE_PRICE);
  assert.ok(published[3] > BASE_PRICE, 'the pipeline starts delivering on tick 3');
});

test('the lag is visible as a delayed reaction to a stock shock', () => {
  let s = sysState([mine('m', 'titanium', 0)], { titanium: 0 });
  s = tick(s); s = tick(s);
  const quiet = posted(s, 'titanium');

  setStock(s, 'titanium', 5000);           // the shock lands now...
  s.galacticSupply.resources.titanium = 5000;
  s = tick(s);
  assert.equal(posted(s, 'titanium'), quiet, 'tick of the shock: the posted value has not moved');
  s = tick(s);
  assert.equal(posted(s, 'titanium'), quiet, 'one tick later: still not moved');
  s = tick(s);
  assert.ok(posted(s, 'titanium') > quiet, '...and only two ticks later does the price catch up');
});

// --- 6. fuel is never priced --------------------------------------------------

test('deuterium_fuel never gets a price', () => {
  assert.equal(PRICED_GOODS.includes(FUEL_GOOD), false);
  const s = sysState([mine('m', 'titanium', 5)]);
  assert.equal(FUEL_GOOD in s.prices, false, 'no row on state');
  assert.equal(postedPrice(s, FUEL_GOOD), null);
  const ticked = tick(s);
  assert.equal(FUEL_GOOD in ticked.prices, false, 'and the tick never mints one');
  assert.equal(FUEL_GOOD in buildSnapshot(ticked).prices, false, 'nor does the snapshot');
});

test('every other stockpile good — raw and processed — is priced', () => {
  const s = sysState();
  for (const good of [...RAW_RESOURCES, ...PROCESSED_GOODS]) {
    assert.equal(typeof s.prices[good].posted, 'number', `${good} must carry a price`);
  }
  assert.equal(Object.keys(s.prices).length, RAW_RESOURCES.length + PROCESSED_GOODS.length);
});

// --- 7. determinism (invariant 9) + the no-op / back-compat proof -------------

test('same state in, same prices out', () => {
  const build = () => {
    let s = sysState([mine('m', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)]);
    for (let i = 0; i < 30; i += 1) s = tick(s);
    return s;
  };
  const a = build();
  const b = build();
  assert.equal(hashState(a), hashState(b), 'the whole state, price block included, is byte-identical');
  assert.deepEqual(a.prices, b.prices);
});

test('the price block survives a serialize round-trip unchanged', () => {
  let s = sysState([mine('m', 'titanium', 5)]);
  for (let i = 0; i < 5; i += 1) s = tick(s);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(hashState(tick(restored)), hashState(tick(s)), 'a reloaded save keeps posting the same numbers');
});

test('NO-OP PROOF: an empty galaxy is hash-stable and its prices sit exactly at base', () => {
  // The boot path: zero-state (no guilds, no ventures, no stock) advanced through the
  // real driver. With no producers and no stock, every good's target IS base and the
  // EMA has nothing to glide toward — so the price step adds nothing spurious, and
  // two identical runs are byte-identical (invariant 9).
  const run = () => {
    let s = createZeroState();
    for (let i = 0; i < 5; i += 1) s = advance(s, []).state;
    return s;
  };
  const a = run();
  const b = run();
  assert.equal(hashState(a), hashState(b));
  assert.deepEqual(a.prices, seedPrices(), 'every price still at its seeded base, pipeline included');
  for (const good of PRICED_GOODS) {
    assert.equal(a.prices[good].posted, BASE_PRICE);
    assert.equal(leadingValue(a.prices[good]), BASE_PRICE);
  }
  assert.deepEqual(checkInvariants(a, a.tick), []);
});

test('a state built before this slice (no price block) is handled, not crashed on', () => {
  // Back-compat: recomputePrices seeds any missing row rather than reading undefined,
  // so an old save or a hand-built test fixture still ticks.
  const s = sysState([mine('m', 'titanium', 5)]);
  delete s.prices;
  const next = tick(s);
  assert.equal(Object.keys(next.prices).length, PRICED_GOODS.length);
  assert.equal(next.prices.titanium.posted, BASE_PRICE);
});

// --- the capacity normaliser + its constant table -----------------------------

test('capacity reads the venture TYPE baseline, never the throttleable productionRate', () => {
  const throttled = sysState([mine('m', 'titanium', 0)]);
  const flatOut = sysState([mine('m', 'titanium', 999)]);
  assert.equal(productionCapacity(throttled).titanium, MINE_BASELINE.titanium);
  assert.equal(productionCapacity(flatOut).titanium, MINE_BASELINE.titanium, 'droids/throttle do not move the Syndicate normaliser');
});

test('a refinery contributes baseline batches x the recipe output qty', () => {
  const s = sysState([refinery('r', 'titanium_alloy', 3)]);
  const recipe = RECIPES.titanium_alloy;
  assert.equal(productionCapacity(s).titanium_alloy, REFINERY_BASELINE.titanium_alloy * recipe.output.qty);
});

test('a good nobody produces rests at base and never divides by zero', () => {
  // Stock with no producers at all: capacity 0. The value must rest, not explode.
  let s = sysState([], { gold: 5000 });
  assert.equal(productionCapacity(s).gold, 0);
  assert.equal(priceTarget(5000, 0, 0), BASE_PRICE);
  for (let i = 0; i < 10; i += 1) s = tick(s);
  assert.equal(posted(s, 'gold'), BASE_PRICE);
  assert.ok(Number.isFinite(leading(s, 'gold')));
});

test('DRIFT GUARD: every raw resource and every recipe has a baseline entry', () => {
  assert.deepEqual(Object.keys(MINE_BASELINE).sort(), [...RAW_RESOURCES].sort(),
    'a mined resource with no baseline would price off a zero capacity');
  assert.deepEqual(Object.keys(REFINERY_BASELINE).sort(), Object.keys(RECIPES).sort(),
    'a recipe with no baseline would price its output off a zero capacity');
  for (const good of RAW_RESOURCES) assert.ok(baselineOutputFor(mine('x', good, 0)).units > 0);
  for (const id of Object.keys(RECIPES)) assert.ok(baselineOutputFor(refinery('x', id, 0)).units > 0);
});

// --- the snapshot surface -----------------------------------------------------

test('the snapshot carries the posted price for every priced good, and nothing more', () => {
  let s = sysState([mine('m', 'titanium', 5)]);
  for (let i = 0; i < 6; i += 1) s = tick(s);
  const snap = buildSnapshot(s);
  assert.equal(Object.keys(snap.prices).length, PRICED_GOODS.length);
  assert.equal(snap.prices.titanium, posted(s, 'titanium'), 'the lens reports engine truth');
  assert.equal(typeof snap.prices.titanium, 'number');
  // The un-published pipeline stays OFF the lens — the front-running read depends on
  // nobody being handed the future price.
  assert.equal(typeof snap.prices.titanium, 'number', 'a bare number, not the row');
});

// --- the step itself is pure --------------------------------------------------

test('recomputePrices mutates nothing it is given', () => {
  const s = sysState([mine('m', 'titanium', 5)], { titanium: 50 });
  const before = JSON.parse(JSON.stringify(s));
  recomputePrices(s, { titanium: 3 });
  assert.deepEqual(s, before);
});

// --- the price sanity tripwire (sim/invariants.js) ----------------------------

test('a poisoned price trips the tripwire instead of rotting silently', () => {
  const s = sysState([mine('m', 'titanium', 5)]);
  assert.deepEqual(checkInvariants(s, s.tick), []);

  const nan = JSON.parse(JSON.stringify(s));
  nan.prices.titanium.posted = Number.NaN;
  assert.equal(checkInvariants(nan, 0).length, 1, 'a NaN price is caught');

  const outOfBand = JSON.parse(JSON.stringify(s));
  outOfBand.prices.titanium.pending[1] = PRICE_CEILING * 2;
  assert.equal(checkInvariants(outOfBand, 0).length, 1, 'a value outside the clamp band is caught');

  const shortPipeline = JSON.parse(JSON.stringify(s));
  shortPipeline.prices.titanium.pending = [BASE_PRICE];
  assert.equal(checkInvariants(shortPipeline, 0).length, 1, 'a wrong-depth publish pipeline is caught');

  const priced = JSON.parse(JSON.stringify(s));
  priced.prices[FUEL_GOOD] = { posted: BASE_PRICE, pending: [BASE_PRICE, BASE_PRICE] };
  assert.equal(checkInvariants(priced, 0).length, 1, 'pricing fuel is caught (§8: never listed)');

  const missing = JSON.parse(JSON.stringify(s));
  delete missing.prices.titanium;
  assert.equal(checkInvariants(missing, 0).length, 1, 'a good that lost its price row is caught');
});
