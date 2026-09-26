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
//
// ⤳ 26-09-26 (PER-TIER PRICE BANDS, design.md §5): base, floor and ceiling are now per
// manufacturing tier (T1 1 / 0.2 / 1000, T2 10 / 2 / 10,000, T3 100 / 20 / 100,000). The
// cases that used the old flat 10 and 2 / 200 now read the good's own band (via
// `bandFor` / `basePriceFor`), and a block of tripwires at the end pins the per-tier
// numbers themselves.

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
const { RAW_RESOURCES, PROCESSED_GOODS, TIER3_GOODS, FUEL_GOOD, DEUTERIUM } = require('../resources.js');
const { RECIPES } = require('../recipes.js');
const {
  PRICE_BANDS, EMA_ALPHA, MAX_SLEW_PCT, PUBLISH_LAG,
  PRICED_GOODS, LEVEL_SENSITIVITY,
  seedPrices, leadingValue, postedPrice, bandFor, basePriceFor, productionCapacity, priceTarget,
  advanceLeading, recomputePrices,
} = require('../prices.js');
const { MINE_BASELINE, REFINERY_BASELINE, baselineOutputFor } = require('../baseline.js');
const { tierOf } = require('../points.js');

const SYS = 'sysA';

// Titanium is the workhorse good of most cases below: a Tier-1 raw. Its band is read
// from the engine, never typed here, so these cases hold at any tuning of the bands.
const TI = bandFor('titanium');

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
  // rises. Capacity is the mine's fixed droidless baseline and the mine runs AT it, so
  // level = ticks held. ⤳ 24-09-26 (yield tiers): the rate was a literal 5, the old
  // uniform baseline; it is read from the table so the premise holds at any tuning.
  let s = sysState([mine('m', 'titanium', MINE_BASELINE.titanium)]);
  const series = [];
  for (let i = 0; i < 20; i += 1) { s = tick(s); series.push(posted(s, 'titanium')); }

  assert.equal(series[0], TI.base, 'nothing is published until the lag has run');
  const climbing = series.slice(PUBLISH_LAG); // the ticks whose published value is real
  for (let i = 1; i < climbing.length; i += 1) {
    assert.ok(climbing[i] > climbing[i - 1], `tick ${i}: ${climbing[i]} must exceed ${climbing[i - 1]}`);
  }
  assert.ok(series[series.length - 1] > TI.base * 1.5, 'a 20-tick hoard has visibly moved the value');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('draining the hoard crashes the value back down', () => {
  // The mine runs at its baseline, as above (⤳ 24-09-26: was a literal 5).
  let s = sysState([mine('m', 'titanium', MINE_BASELINE.titanium)]);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  const peak = posted(s, 'titanium');
  assert.ok(peak > TI.base * 2, 'the hoard really did build first');

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
  assert.ok(priceTarget(TI, 100, 5, 0) > priceTarget(TI, 100, 50, 0));

  // And end to end. Both goods hold 100 units; neodymium has ONE mine, copper has TEN.
  // Every mine is throttled to 0 so the piles stay put, and the only difference between
  // the two goods is their CAPACITY — which is exactly the rarity term.
  // ⤳ 24-09-26 (yield tiers): capacity used to differ by producer count alone (5 vs 50,
  // one uniform baseline). Now a copper mine's baseline is also a Common yield and
  // neodymium's a Rare one (design.md §2), so copper's capacity is ten Common mines
  // against one Rare: both halves of that are the rarity term, read from the table.
  const copperMines = Array.from({ length: 10 }, (_, i) => mine(`c${i}`, 'copper', 0));
  let s = sysState([mine('n', 'neodymium', 0), ...copperMines], { neodymium: 100, copper: 100 });
  assert.equal(productionCapacity(s).neodymium, MINE_BASELINE.neodymium);
  assert.equal(productionCapacity(s).copper, 10 * MINE_BASELINE.copper);

  for (let i = 0; i < 30; i += 1) s = tick(s);
  // Compare the GAIN over base — the whole of what the hoard bought each good. More
  // capacity dilutes the same pile, and the price says so.
  // Both are Tier-1 raws, so they share a base and the gains compare like for like.
  assert.equal(basePriceFor('neodymium'), basePriceFor('copper'));
  const rareGain = posted(s, 'neodymium') - basePriceFor('neodymium');
  const commonGain = posted(s, 'copper') - basePriceFor('copper');
  assert.ok(commonGain > 0, 'the common good still moved — gentle, not dead');
  assert.ok(rareGain > commonGain * 5,
    `rare gain ${rareGain} must far outrun common gain ${commonGain}`);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. idleness: working inventory prices below a hoard ----------------------

test('the formula discounts consumed stock against identical static stock', () => {
  assert.ok(priceTarget(TI, 100, 5, 40) < priceTarget(TI, 100, 5, 0));
  assert.equal(priceTarget(TI, 100, 5, 0), TI.base * (1 + LEVEL_SENSITIVITY * 20), 'static stock takes the full level');
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
  const expected = advanceLeading(TI, TI.base, priceTarget(TI, stockAfter, capacity, drawn));
  const asIfIdle = advanceLeading(TI, TI.base, priceTarget(TI, stockAfter, capacity, 0));
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
  assert.ok(leading(s, 'titanium') < TI.ceiling, 'nowhere near the ceiling');

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
  const target = TI.base * 1.05;
  assert.equal(advanceLeading(TI, TI.base, target), TI.base + (EMA_ALPHA * (target - TI.base)));
});

test('the value is clamped into its own tier\'s floor/ceiling band', () => {
  // Every tier, each against ITS band (⤳ 26-09-26: was the one flat 2 / 200).
  for (const [tier, band] of Object.entries(PRICE_BANDS)) {
    assert.equal(advanceLeading(band, band.ceiling, band.ceiling * 10), band.ceiling, `T${tier}: the ceiling holds`);
    assert.equal(advanceLeading(band, band.floor, 0), band.floor, `T${tier}: the floor holds`);
    // The clamp lands LAST, so a wild target can never wind the EMA memory past the band.
    let v = band.base;
    for (let i = 0; i < 500; i += 1) v = advanceLeading(band, v, 1e9);
    assert.equal(v, band.ceiling, `T${tier}: a runaway target winds up to the ceiling and stops`);
  }
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
  assert.equal(published[1], TI.base, 'the first ticks publish the seeded base — nothing computed yet');
  assert.equal(published[2], TI.base);
  assert.ok(published[3] > TI.base, 'the pipeline starts delivering on tick 3');
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

test('every other stockpile good — raw, processed and Tier-3 module — is priced', () => {
  // 2.1a: PRICED_GOODS = STOCKPILE_GOODS − fuel, and the Tier-3 modules joined
  // STOCKPILE_GOODS, so every module now carries a price row for free (capacity 0 rests
  // it at base until a venture makes it — the "new vocabulary at rest").
  const s = sysState();
  for (const good of [...RAW_RESOURCES, ...PROCESSED_GOODS, ...TIER3_GOODS]) {
    assert.equal(typeof s.prices[good].posted, 'number', `${good} must carry a price`);
  }
  assert.equal(Object.keys(s.prices).length, RAW_RESOURCES.length + PROCESSED_GOODS.length + TIER3_GOODS.length);
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
    assert.equal(a.prices[good].posted, basePriceFor(good), `${good} sits at its own tier's base`);
    assert.equal(leadingValue(a.prices[good]), basePriceFor(good));
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
  // ⤳ 26-09-26: each missing row is seeded at its OWN tier's base, not one shared value.
  for (const good of PRICED_GOODS) {
    assert.equal(next.prices[good].posted, basePriceFor(good), `${good}'s missing row seeds at its tier base`);
  }
  assert.equal(next.prices.titanium.posted, 1, 'a T1 raw seeds at 1');
  assert.equal(next.prices.titanium_alloy.posted, 10, 'a T2 processed good seeds at 10');
  assert.equal(next.prices.chassis.posted, 100, 'a T3 module seeds at 100');
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

test('a good nobody produces rests at ITS TIER\'s base and never divides by zero', () => {
  // Stock with no producers at all: capacity 0. The value must rest, not explode.
  // ⤳ 26-09-26: one good per tier, because "rests at base" now means the good's own
  // tier base (1 / 10 / 100), not a shared 10.
  const idle = { gold: 5000, battery_cells: 5000, chassis: 5000 }; // T1, T2, T3
  let s = sysState([], idle);
  for (const good of Object.keys(idle)) {
    assert.equal(productionCapacity(s)[good], 0, `${good} has no producer`);
    assert.equal(priceTarget(bandFor(good), 5000, 0, 0), basePriceFor(good), `${good}'s target is its tier base`);
  }
  for (let i = 0; i < 10; i += 1) s = tick(s);
  assert.equal(posted(s, 'gold'), 1, 'T1 rests at 1');
  assert.equal(posted(s, 'battery_cells'), 10, 'T2 rests at 10');
  assert.equal(posted(s, 'chassis'), 100, 'T3 rests at 100 — not at the old flat 10');
  for (const good of Object.keys(idle)) assert.ok(Number.isFinite(leading(s, good)));
  assert.deepEqual(checkInvariants(s, s.tick), []);
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
  outOfBand.prices.titanium.pending[1] = TI.ceiling * 2;
  assert.equal(checkInvariants(outOfBand, 0).length, 1, 'a value outside the clamp band is caught');

  const shortPipeline = JSON.parse(JSON.stringify(s));
  shortPipeline.prices.titanium.pending = [TI.base];
  assert.equal(checkInvariants(shortPipeline, 0).length, 1, 'a wrong-depth publish pipeline is caught');

  const priced = JSON.parse(JSON.stringify(s));
  priced.prices[FUEL_GOOD] = { posted: TI.base, pending: [TI.base, TI.base] };
  assert.equal(checkInvariants(priced, 0).length, 1, 'pricing fuel is caught (§8: never listed)');

  const missing = JSON.parse(JSON.stringify(s));
  delete missing.prices.titanium;
  assert.equal(checkInvariants(missing, 0).length, 1, 'a good that lost its price row is caught');
});

test('the tripwire checks each good against ITS OWN tier band, not one flat band', () => {
  // Each case is one the old flat 2 / 200 band would have judged WRONGLY.
  const s = sysState([mine('m', 'titanium', 5)]);

  // A T1 raw at 0.5: inside T1's band (floor 0.2). The old flat floor of 2 would flag it.
  const cheapRaw = JSON.parse(JSON.stringify(s));
  cheapRaw.prices.titanium.posted = 0.5;
  assert.deepEqual(checkInvariants(cheapRaw, 0), [], 'a T1 good at 0.5 is legal');

  // A T3 module at 5: inside the old flat band, but below T3's floor of 20. Must trip.
  const crashedModule = JSON.parse(JSON.stringify(s));
  crashedModule.prices.chassis.posted = 5;
  const tripped = checkInvariants(crashedModule, 0);
  assert.equal(tripped.length, 1, 'a T3 module below 20 is caught');
  assert.equal(tripped[0].where, 'prices.chassis.posted');
  assert.deepEqual(tripped[0].detail, { value: 5, floor: 20, ceiling: 100000 }, 'and it reports the module\'s own band');

  // A T3 module at 50,000: far above the old flat ceiling of 200, but legal for T3.
  const dearModule = JSON.parse(JSON.stringify(s));
  dearModule.prices.chassis.pending[0] = 50000;
  assert.deepEqual(checkInvariants(dearModule, 0), [], 'a T3 module at 50,000 is legal');

  // A T1 raw at 1,500: above T1's ceiling of 1,000. Must trip.
  const runawayRaw = JSON.parse(JSON.stringify(s));
  runawayRaw.prices.titanium.posted = 1500;
  assert.equal(checkInvariants(runawayRaw, 0).length, 1, 'a T1 good above 1,000 is caught');
});

// --- per-tier bands (26-09-26, design.md §5; numbers in docs/phase-1-tuning.md) --------

test('PRICE_BANDS carries the ruled per-tier numbers exactly', () => {
  // The numbers are typed here ON PURPOSE: this is the tripwire that pins the ruling.
  // Retune them in docs/phase-1-tuning.md and here together, never in one place alone.
  assert.deepEqual(PRICE_BANDS, {
    1: { base: 1, floor: 0.2, ceiling: 1000 },
    2: { base: 10, floor: 2, ceiling: 10000 },
    3: { base: 100, floor: 20, ceiling: 100000 },
  });
  // The ruled SHAPE, per tier: floor 0.2 × base, ceiling 1000 × base.
  for (const band of Object.values(PRICE_BANDS)) {
    assert.ok(Math.abs(band.floor - (0.2 * band.base)) < 1e-12, 'floor is 0.2 × base');
    assert.equal(band.ceiling, 1000 * band.base, 'ceiling is 1000 × base');
    assert.ok(band.floor < band.base && band.base < band.ceiling, 'the base sits inside its own band');
  }
});

test('every priced good resolves to a tier that has a band', () => {
  // FAIL LOUD: a priced good with no tier would have no base, floor or ceiling, and
  // bandFor would throw on it. This catches it at test time instead of on a live tick.
  for (const good of PRICED_GOODS) {
    const tier = tierOf(good);
    assert.ok(tier === 1 || tier === 2 || tier === 3, `${good} has tier ${tier}`);
    assert.equal(bandFor(good), PRICE_BANDS[tier], `${good} uses its tier's band`);
    assert.equal(basePriceFor(good), PRICE_BANDS[tier].base);
  }
});

test('a good that is not priced has no band and no base — null, as before', () => {
  // The null is a contract: readers (the snapshot's priceBase, the licence charge) use
  // it to tell "not priced" apart from a number.
  assert.equal(bandFor(FUEL_GOOD), null);
  assert.equal(basePriceFor(FUEL_GOOD), null, 'fuel is never priced');
  assert.equal(bandFor('no_such_good'), null);
  assert.equal(basePriceFor('no_such_good'), null);
});

test('a fresh galaxy seeds each good at its own tier base: T1 1, T2 10, T3 100', () => {
  const s = sysState();
  const cases = { titanium: 1, silica: 1, titanium_alloy: 10, silicon_wafer: 10, chassis: 100, drive_module: 100 };
  for (const [good, base] of Object.entries(cases)) {
    assert.equal(s.prices[good].posted, base, `${good} posts ${base}`);
    assert.deepEqual(s.prices[good].pending, new Array(PUBLISH_LAG).fill(base), `${good}'s pipeline is seeded at ${base}`);
  }
  // …and the quote-lock ring seeds off the same block, so it agrees.
  assert.equal(s.priceRing.chassis[0], 100);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('raw deuterium IS priced, and takes the Tier-1 band (only deuterium_fuel is unpriced)', () => {
  // As built: `deuterium` is a stockpile good, so it is in PRICED_GOODS, and the licensed
  // deuterium mine's per-tick auto-sale pays its posted price (sim/tick.js). Its band is
  // therefore LIVE. The 26-09-26 ruling assumed it was unpriced; that question is on
  // the roadmap's decision checklist. If it is ruled otherwise, this test changes.
  assert.equal(PRICED_GOODS.includes(DEUTERIUM), true);
  assert.equal(tierOf(DEUTERIUM), 1);
  assert.equal(bandFor(DEUTERIUM), PRICE_BANDS[1]);
  assert.equal(sysState().prices[DEUTERIUM].posted, 1);
});

test('a runaway hoard clamps at its own tier ceiling: T1 1,000, T2 10,000, T3 100,000', () => {
  // A billion units of each, held still by a rate-0 producer (so capacity is non-zero
  // and the level is enormous). The target is far past every ceiling, so the value
  // climbs at the slew cap until the clamp stops it. From base to 1000 × base at 10%
  // a tick takes ~73 ticks, plus the 2-tick publish lag.
  const HOARD = 1e9;
  let s = sysState(
    [mine('m', 'titanium', 0), refinery('r2', 'titanium_alloy', 0), refinery('r3', 'chassis', 0)],
    { titanium: HOARD, titanium_alloy: HOARD, chassis: HOARD },
  );
  for (let i = 0; i < 90; i += 1) s = tick(s);
  assert.equal(posted(s, 'titanium'), 1000, 'T1 stops at 1,000');
  assert.equal(posted(s, 'titanium_alloy'), 10000, 'T2 stops at 10,000');
  assert.equal(posted(s, 'chassis'), 100000, 'T3 stops at 100,000');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a price driven down with no support stops at its own tier floor: 0.2, 2, 20', () => {
  // The clamp alone, tier by tier: feed a target of 0 every tick (as far down as a
  // target could ever go). The value falls at the slew cap and stops on the floor.
  //
  // This is tested on advanceLeading directly because the tick's own formula cannot
  // push a price this low: with the level at 0 the target is base × idleness, and
  // idleness never goes below 0.5, so the lowest reachable target is half the base.
  // The floor is a backstop under that, exactly as the ceiling is above.
  for (const good of ['titanium', 'titanium_alloy', 'chassis']) {
    const band = bandFor(good);
    let v = band.base;
    for (let i = 0; i < 100; i += 1) v = advanceLeading(band, v, 0);
    assert.equal(v, band.floor, `${good} stops at ${band.floor}`);
  }
  assert.deepEqual([bandFor('titanium').floor, bandFor('titanium_alloy').floor, bandFor('chassis').floor], [0.2, 2, 20]);
});
