'use strict';

// price-history.test.js — the posted-price history store (sim/price-history.js),
// the data the TRADE tab's price graph draws.
//
// The tripwires, one per ruling:
//   - three rings per good at coarsening cadences: fine every 15 ticks capped at 288,
//     medium every 120 capped at 168, coarse every 1,440 capped at 90 — and the cap
//     drops the OLDEST, which is the whole point of a bounded store;
//   - a sample is the CLOSING PRICE: the posted value at the bucket-close tick, not an
//     average of the bucket;
//   - sampling is CLOCK-FREE and tick-driven, so it ignores `dayAnchorTick` (this is
//     display telemetry, not the economy's cycle) and reproduces byte for byte;
//   - a fresh galaxy carries NO `priceHistory` at all until tick 15 — the omit-when-
//     empty no-op that keeps a short run's golden hash byte-identical;
//   - the snapshot echoes the rings verbatim, and publishes the per-good base;
//   - the invariant catches an over-long ring, a non-finite sample and a bogus row.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { BASE_PRICE, PRICED_GOODS, postedPrice } = require('../prices.js');
const { FUEL_GOOD } = require('../resources.js');
const {
  TIERS, TIER_KEYS, getPriceHistory, pushPriceSample, tiersClosingAt,
  recordPriceSamples, clonePriceHistory,
} = require('../price-history.js');

const SYS = 'sysA';
const GOOD = 'titanium';

const tierBy = (key) => TIERS.find((t) => t.key === key);
const FINE = tierBy('fine');
const MEDIUM = tierBy('medium');
const COARSE = tierBy('coarse');

const mine = (id, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate,
});

function priceState({ ventures = [], stockpiles = {}, dayAnchorTick } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures, stockpiles: { [SYS]: stockpiles } }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    ...(dayAnchorTick === undefined ? {} : { dayAnchorTick }),
  });
}

// Run `n` ticks. Ticking a quiet galaxy is cheap; the coarse tier needs 1,440 of them.
function run(state, n) {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
}

// --- 1. the shape and the cadences --------------------------------------------

test('the three tiers are the declared cadences and depths, and they are the published key names', () => {
  // The keys are a CONTRACT — the TRADE tab already reads priceHistory[good][tier].
  assert.deepEqual([...TIER_KEYS], ['fine', 'medium', 'coarse']);
  assert.deepEqual({ every: FINE.every, length: FINE.length }, { every: 15, length: 288 });
  assert.deepEqual({ every: MEDIUM.every, length: MEDIUM.length }, { every: 120, length: 168 });
  assert.deepEqual({ every: COARSE.every, length: COARSE.length }, { every: 1440, length: 90 });
  // …and each ring's span is the scale it serves (1 tick = 1 minute):
  assert.equal(FINE.every * FINE.length / 1440, 3, 'fine covers 3 days — the 3D scale');
  assert.equal(MEDIUM.every * MEDIUM.length / 1440, 14, 'medium covers 14 days — the 2W scale');
  assert.equal(COARSE.every * COARSE.length / 1440, 90, 'coarse covers 90 days — the 1M and 3M scales');
});

test('a fresh galaxy carries NO priceHistory until the first fine bucket closes at tick 15', () => {
  const fresh = priceState();
  assert.equal('priceHistory' in fresh, false, 'the key is absent, not empty — the omit-when-empty no-op');

  // Fourteen ticks and still nothing: this is what keeps every short run's golden
  // hash byte-identical through this slice.
  const before = run(fresh, 14);
  assert.equal(before.tick, 14);
  assert.equal(before.priceHistory, undefined, 'no key at tick 14');
  assert.equal(hashState(before), hashState(run(priceState(), 14)), 'and a 14-tick run is byte-identical run to run');

  const at15 = tick(before, []);
  assert.equal(at15.tick, 15);
  assert.ok(at15.priceHistory, 'the store is minted at tick 15, not before');
  assert.equal(getPriceHistory(at15, GOOD).fine.length, 1);
  assert.equal(getPriceHistory(at15, GOOD).medium.length, 0, 'the medium bucket has not closed');
  assert.equal(getPriceHistory(at15, GOOD).coarse.length, 0, 'nor the coarse one');
});

test('the fine ring gains one sample every 15 ticks, for every priced good and no other', () => {
  let s = run(priceState(), 90);
  assert.equal(getPriceHistory(s, GOOD).fine.length, 6, '90 / 15');
  // Every priced good gets a row; fuel never does (it carries no posted value at all).
  assert.deepEqual(Object.keys(s.priceHistory).sort(), [...PRICED_GOODS].sort());
  assert.equal(s.priceHistory[FUEL_GOOD], undefined, 'fuel is never priced, so it is never recorded (§8)');

  // A tick that is not a bucket close adds nothing.
  const lengthAt90 = getPriceHistory(s, GOOD).fine.length;
  s = run(s, 14);
  assert.equal(getPriceHistory(s, GOOD).fine.length, lengthAt90, 'ticks 91..104 close no bucket');
  s = tick(s, []);
  assert.equal(s.tick, 105);
  assert.equal(getPriceHistory(s, GOOD).fine.length, lengthAt90 + 1, 'tick 105 does');
});

test('the medium ring gains one sample every 120 ticks, and the coarse one every 1,440', () => {
  const s = run(priceState(), 1440);
  const row = getPriceHistory(s, GOOD);
  assert.equal(row.fine.length, 96, '1440 / 15');
  assert.equal(row.medium.length, 12, '1440 / 120');
  assert.equal(row.coarse.length, 1, '1440 / 1440 — one day, one coarse sample');
  // A tick that closes several buckets closes ALL of them: tick 1440 is a multiple of
  // 15, 120 and 1,440, so it lands in all three rings.
  assert.deepEqual(tiersClosingAt(1440).map((t) => t.key), ['fine', 'medium', 'coarse']);
  assert.deepEqual(tiersClosingAt(120).map((t) => t.key), ['fine', 'medium']);
  assert.deepEqual(tiersClosingAt(15).map((t) => t.key), ['fine']);
  assert.deepEqual(tiersClosingAt(14).map((t) => t.key), []);
  assert.deepEqual(tiersClosingAt(0).map((t) => t.key), [], 'tick 0 is the pre-game state, not a closed bucket');
});

// --- 2. the sample VALUE is the closing price ---------------------------------

test('a sample is the POSTED price at the bucket-close tick — the closing price, not an average', () => {
  // A real hoard so the value actually moves tick over tick: an average of the bucket
  // and its closing value would then differ, and only one of them can be recorded.
  const ventures = [mine('m1', GOOD, 5)];
  let s = priceState({ ventures, stockpiles: { [GOOD]: 4000 } });

  // Walk to tick 14 and note what tick 15 will publish, then take the step.
  s = run(s, 14);
  const at15 = tick(s, []);
  assert.equal(at15.tick, 15);
  assert.equal(
    getPriceHistory(at15, GOOD).fine[0], postedPrice(at15, GOOD),
    'the recorded sample IS the posted value of the tick the bucket closed on',
  );

  // …and the next sample is tick 30's posted value, not anything from between.
  const at30 = run(at15, 15);
  assert.equal(at30.tick, 30);
  assert.equal(getPriceHistory(at30, GOOD).fine[1], postedPrice(at30, GOOD));
  assert.notEqual(
    getPriceHistory(at30, GOOD).fine[0], getPriceHistory(at30, GOOD).fine[1],
    'the two samples really are different values — the fixture moves the price',
  );
  // Oldest → newest: the newest sample is last.
  assert.equal(getPriceHistory(at30, GOOD).fine[1], postedPrice(at30, GOOD));
});

// --- 3. the ring caps ----------------------------------------------------------
//
// Ticking 288 × 15 = 4,320 ticks to fill the fine ring honestly is affordable; the
// medium and coarse caps would need 20,160 and 129,600, which is not. So the cap
// itself is exercised directly through the one function that enforces it — the same
// code path the tick uses, just fed faster.

test('the fine ring caps at 288 by ticking, and the OLDEST sample is the one that drops', () => {
  let s = run(priceState(), FINE.every * FINE.length);            // exactly 4,320
  assert.equal(s.tick, 4320);
  const row = getPriceHistory(s, GOOD);
  assert.equal(row.fine.length, FINE.length, 'the ring is exactly full');
  const secondOldest = row.fine[1];
  const wasFull = [...row.fine];

  s = run(s, FINE.every);                                          // one more bucket
  const after = getPriceHistory(s, GOOD);
  assert.equal(after.fine.length, FINE.length, 'still capped — it does not grow');
  assert.equal(after.fine[0], secondOldest, 'the oldest sample dropped off the front');
  assert.deepEqual(after.fine.slice(0, -1), wasFull.slice(1), 'everything else shifted down by one');
  assert.equal(after.fine[after.fine.length - 1], postedPrice(s, GOOD), 'and the newest is this tick\'s close');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a full ring is a legal state');
});

test('every ring caps at its own declared length', () => {
  for (const tier of TIERS) {
    const s = priceState();
    for (let i = 0; i < tier.length + 25; i += 1) pushPriceSample(s, GOOD, tier.key, i);
    const ring = getPriceHistory(s, GOOD)[tier.key];
    assert.equal(ring.length, tier.length, `${tier.key} caps at ${tier.length}`);
    assert.equal(ring[0], 25, 'the first 25 samples were dropped from the front');
    assert.equal(ring[ring.length - 1], tier.length + 24, 'and the newest is last');
  }
});

test('a non-finite sample is refused rather than written into serialized state', () => {
  const s = priceState();
  for (const bad of [NaN, Infinity, -Infinity, '10', null, undefined]) {
    assert.throws(() => pushPriceSample(s, GOOD, 'fine', bad), /non-finite/);
  }
  assert.throws(() => pushPriceSample(s, GOOD, 'hourly', 10), /unknown tier/);
  assert.equal(s.priceHistory, undefined, 'and nothing was minted on the way out');
});

// --- 4. clock-free determinism (invariant 9) ----------------------------------

test('sampling is tick-driven and clock-free — twice-run is byte-identical', () => {
  const build = () => priceState({ ventures: [mine('m1', GOOD, 5)], stockpiles: { [GOOD]: 900 } });
  const once = run(build(), 130);
  const twice = run(build(), 130);
  assert.equal(hashState(once), hashState(twice), 'byte-identical, twice-run');
  assert.ok(getPriceHistory(once, GOOD).fine.length > 0, 'and there was really history in those bytes');
});

test('the cycle anchor does NOT move the sample — this is display telemetry, not the economy cycle', () => {
  // `dayAnchorTick` shifts where the ECONOMY's window boundaries fall
  // (docs/cycle-and-calendar.md). A price sample is a chart tick mark, so it is driven
  // by the raw tick counter alone and must be unmoved by the anchor.
  const plain = run(priceState(), 30);
  const anchored = run(priceState({ dayAnchorTick: 7 }), 30);
  assert.deepEqual(
    getPriceHistory(anchored, GOOD), getPriceHistory(plain, GOOD),
    'the same samples at the same ticks, whatever midnight the galaxy keeps',
  );
});

test('recordPriceSamples is a no-op on a tick that closes no bucket', () => {
  const s = run(priceState(), 15);
  const before = hashState(s);
  recordPriceSamples(s, 16);
  assert.equal(hashState(s), before, 'nothing written, nothing minted');
});

test('clonePriceHistory copies the rings, so a caller can never alias into engine state', () => {
  const s = run(priceState(), 15);
  const copy = clonePriceHistory(s.priceHistory);
  copy[GOOD].fine.push(999);
  assert.equal(getPriceHistory(s, GOOD).fine.length, 1, 'the engine\'s ring is untouched');
  // …and createState deep-clones a supplied one for the same reason.
  const seeded = createState({
    guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
    priceHistory: s.priceHistory,
  });
  seeded.priceHistory[GOOD].fine.push(999);
  assert.equal(getPriceHistory(s, GOOD).fine.length, 1, 'the scenario\'s object is not aliased either');
});

// --- 5. the snapshot surface ---------------------------------------------------

test('the snapshot echoes the rings verbatim, and publishes the per-good base', () => {
  const s = run(priceState({ ventures: [mine('m1', GOOD, 5)], stockpiles: { [GOOD]: 900 } }), 30);
  const snap = buildSnapshot(s);

  assert.deepEqual(snap.priceHistory[GOOD], getPriceHistory(s, GOOD), 'verbatim — the chart reshapes nothing');
  assert.deepEqual(Object.keys(snap.priceHistory[GOOD]).sort(), ['coarse', 'fine', 'medium']);
  // A copy, not the live arrays: the snapshot must never hand a reader a handle on state.
  snap.priceHistory[GOOD].fine.push(999);
  assert.equal(getPriceHistory(s, GOOD).fine.length, 2);

  // The base is read through prices.js's accessor, never typed by a reader.
  assert.equal(snap.priceBase[GOOD], BASE_PRICE);
  assert.deepEqual(Object.keys(snap.priceBase).sort(), [...PRICED_GOODS].sort());
  assert.equal(snap.priceBase[FUEL_GOOD], undefined, 'fuel has no base because it has no price (§8)');
});

test('the snapshot always carries a priceHistory block, even before the first sample', () => {
  // The STATE field is omitted until tick 15 (the hash no-op); the SNAPSHOT field is
  // always present, so a reader gets a stable shape rather than a key that appears.
  const fresh = priceState();
  assert.equal(fresh.priceHistory, undefined);
  assert.deepEqual(buildSnapshot(fresh).priceHistory, {}, 'present and empty, not missing');
});

// --- 6. the invariant tripwire -------------------------------------------------

test('the invariant catches an over-long ring, a non-finite sample, and a bogus row', () => {
  const base = run(priceState(), 15);
  const rules = (s) => checkInvariants(s, s.tick).map((v) => v.rule);

  assert.deepEqual(checkInvariants(base, base.tick), [], 'the honest state is clean');

  // An over-long ring — the bounded-storage guarantee is what this whole design buys.
  const long = structuredClone(base);
  long.priceHistory[GOOD].fine = new Array(FINE.length + 1).fill(10);
  assert.ok(rules(long).some((r) => r.startsWith('price-history-ring-capped')), rules(long).join());

  // A non-finite sample would poison the determinism hash.
  const nan = structuredClone(base);
  nan.priceHistory[GOOD].fine[0] = null;
  assert.ok(rules(nan).some((r) => r.startsWith('price-history-sample-finite')), rules(nan).join());

  // A row for a good the Syndicate does not price — fuel above all.
  const bogus = structuredClone(base);
  bogus.priceHistory[FUEL_GOOD] = { fine: [], medium: [], coarse: [] };
  assert.ok(rules(bogus).some((r) => r.startsWith('price-history-priced-good')), rules(bogus).join());

  // A missing tier, and a stranger key that would otherwise ride into the hash unchecked.
  const missing = structuredClone(base);
  delete missing.priceHistory[GOOD].coarse;
  assert.ok(rules(missing).some((r) => r.startsWith('price-history-tiers')), rules(missing).join());
  const stranger = structuredClone(base);
  stranger.priceHistory[GOOD].hourly = [];
  assert.ok(rules(stranger).some((r) => r.startsWith('price-history-tiers')), rules(stranger).join());

  // A ring that is not an array at all.
  const notArray = structuredClone(base);
  notArray.priceHistory[GOOD].fine = { 0: 10 };
  assert.ok(rules(notArray).some((r) => r.startsWith('price-history-ring-shape')), rules(notArray).join());
});
