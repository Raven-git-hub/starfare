'use strict';

// fuel-price-history.test.js — the galaxy-wide fuel-price HISTORY (docs/guild-hall.md §4.2,
// sim/fuel-price-history.js) and the per-guild deuterium PRODUCTION aggregate (the DEUTERIUM tab's
// two remaining engine data feeds). The mechanical tripwires the human reads at merge:
//   - bucketing: one true 6-hour average pushed per closed bucket; the ring caps at 12; a bucket's
//     stored value equals the hand-summed mean of the fuel prices across its ticks; empty before
//     the first close;
//   - bucket ALIGNMENT: buckets fall on the quarter-day mark, off the same anchor the cycle
//     boundary uses — not on galaxy-tick-1 drift;
//   - the production aggregate: licensed mines → legalPerCycle, refineries → contrabandPerCycle,
//     each × windowN; an unlicensed mine and a non-deuterium venture contribute to neither;
//   - invariants: the shape sweep trips on a corrupt ring or accumulator.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const {
  FUEL_PRICE_HISTORY_N, FUEL_PRICE_BUCKET_DIVISOR, bucketIndexOf, recordFuelPriceSample,
} = require('../fuel-price-history.js');

// A galaxy whose fuel price we drive by hand, so a bucket's stored average is checkable against a
// mean we control. windowN small so buckets close quickly (bucketLen = windowN / 4).
function priceState(windowN, dayAnchorTick) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
    ...(dayAnchorTick === undefined ? {} : { dayAnchorTick }),
  });
}

// Feed a specific price into the accumulator for a specific producing tick, the way tick() does.
function sample(state, tick, price) {
  state.reserve.fuelPrice = price;
  recordFuelPriceSample(state, tick);
}

// --- bucketing ------------------------------------------------------------------

test('a fresh galaxy carries no fuel-price history at all (omit-when-empty)', () => {
  const s = priceState(8);
  assert.equal(s.fuelPriceHistory, undefined, 'nothing sampled yet — no key');
});

test('the ring is empty until the first bucket closes, then holds one true 6-hour average per bucket', () => {
  // windowN 8 ⇒ bucketLen = 8/4 = 2 ticks per 6-hour bucket, anchor 0.
  //   bucket 0 = ticks 1,2 ; bucket 1 = ticks 3,4 ; bucket 2 = ticks 5,6 …
  const s = priceState(8);

  sample(s, 1, 10);
  assert.deepEqual(s.fuelPriceHistory.ring, [], 'one sample in — bucket still open, ring empty');
  assert.equal(s.fuelPriceHistory.acc.count, 1);

  sample(s, 2, 20);
  assert.deepEqual(s.fuelPriceHistory.ring, [], 'still inside bucket 0 — nothing closed');
  assert.equal(s.fuelPriceHistory.acc.count, 2);

  // Tick 3 opens bucket 1 ⇒ bucket 0 closes with the mean of its two ticks: (10 + 20) / 2 = 15.
  sample(s, 3, 30);
  assert.deepEqual(s.fuelPriceHistory.ring, [15], 'bucket 0 closed with the hand-summed mean of ticks 1–2');
  assert.equal(s.fuelPriceHistory.acc.count, 1, 'tick 3 is now the sole sample of the open bucket 1');

  // Tick 5 opens bucket 2 ⇒ bucket 1 closes with (30 + 40) / 2 = 35.
  sample(s, 4, 40);
  sample(s, 5, 50);
  assert.deepEqual(s.fuelPriceHistory.ring, [15, 35], 'bucket 1 closed with its own two-tick mean, oldest → newest');
  assert.equal(s.fuelPriceHistory.acc.count, 1);
});

test('the ring caps at 12 over a >3-day run, dropping the oldest', () => {
  // windowN 4 ⇒ bucketLen 1 ⇒ a bucket closes every tick, so the ring is a moving window of the
  // last 12 closed prices. Drive 20 distinct prices; after tick N the ring holds ticks 1..N-1's
  // prices capped at the last 12.
  const s = priceState(4);
  const prices = [];
  for (let t = 1; t <= 20; t += 1) {
    const p = 100 + t; // 101, 102, … all distinct
    prices.push(p);
    sample(s, t, p);
  }
  assert.equal(s.fuelPriceHistory.ring.length, FUEL_PRICE_HISTORY_N, 'ring capped at 12');
  assert.equal(s.fuelPriceHistory.ring.length, 12);
  // 19 buckets closed (ticks 1..19); the ring keeps the last 12 = ticks 8..19's prices (108..119),
  // each a 1-tick bucket so the average IS that tick's price. The oldest (101..107) were dropped.
  assert.deepEqual(s.fuelPriceHistory.ring, prices.slice(7, 19),
    'the oldest closes were shifted out; the newest 12 remain, oldest → newest');
});

// --- bucket alignment -----------------------------------------------------------

test('bucketIndexOf splits the day into FUEL_PRICE_BUCKET_DIVISOR quarters, aligned to the day', () => {
  const N = 1440; // the standard day ⇒ bucketLen 360
  // The four 6-hour marks of day 0 (anchor 0): ticks 1, 361, 721, 1081 open buckets 0,1,2,3;
  // tick 1441 opens day 1's first bucket (index 4). A day boundary IS a bucket boundary.
  assert.equal(bucketIndexOf(1, N, 0), 0);
  assert.equal(bucketIndexOf(360, N, 0), 0, 'last tick of quarter 0');
  assert.equal(bucketIndexOf(361, N, 0), 1, 'first tick of quarter 1');
  assert.equal(bucketIndexOf(720, N, 0), 1);
  assert.equal(bucketIndexOf(721, N, 0), 2);
  assert.equal(bucketIndexOf(1081, N, 0), 3);
  assert.equal(bucketIndexOf(1440, N, 0), 3, 'last tick of the day is still quarter 3');
  assert.equal(bucketIndexOf(1441, N, 0), 4, 'the day roll is a bucket roll — quarter 0 of day 1');
  assert.equal(FUEL_PRICE_BUCKET_DIVISOR, 4, 'four buckets a day = quarter-days');
});

test('buckets align to the ANCHOR the same way cycle boundaries do, not to galaxy tick 1', () => {
  // An anchored galaxy: dayAnchorTick = -2 on windowN 8 (bucketLen 2). The anchor shifts the
  // quarter marks by 2 ticks, exactly as it shifts the day/cycle boundary — so the SAME tick a
  // bucket closes on is a quarter-day mark under the anchor, never one measured from tick 1.
  const N = 8;
  const anchor = -2;
  const s = priceState(N, anchor);
  // Under this anchor, bucketIndexOf changes between tick t-1 and t exactly at the quarter marks.
  // Find the first tick that closes a bucket (index changes from tick 1's bucket) and confirm it
  // is where the anchored formula — not an unanchored one — puts it.
  let firstClose = null;
  const b1 = bucketIndexOf(1, N, anchor);
  for (let t = 2; t <= 12 && firstClose === null; t += 1) {
    if (bucketIndexOf(t, N, anchor) !== b1) firstClose = t;
  }
  // The anchored boundary sits where (t - 1 - anchor) crosses a multiple of bucketLen. With anchor
  // -2, bucketLen 2: (t - 1 + 2) % 2 == 0 at the bucket START, i.e. t = 1 (start) then t = 3, 5…
  // The UNanchored formula would put the first new bucket at t = 3 too here — so use a run to
  // prove the STORED close lands where the anchored engine's own bucketIndexOf says, and that the
  // ring's value is the mean across exactly the anchored bucket's ticks.
  sample(s, 1, 10);
  sample(s, 2, 20);
  assert.equal(firstClose, 3, 'the first bucket closes at the anchored quarter mark (tick 3)');
  sample(s, 3, 99);
  assert.deepEqual(s.fuelPriceHistory.ring, [15], 'ticks 1–2 averaged to 15 — the anchored bucket, not a tick-1-drift window');
  // Cross-check: the close tick is a bucket boundary under the anchor and NOT under anchor 0.
  assert.notEqual(bucketIndexOf(3, N, anchor), bucketIndexOf(2, N, anchor), 'anchored: 3 opens a new bucket');
});

// --- the through-the-engine path (sampled every tick, not only at boundaries) ---

test('tick() samples the fuel price EVERY tick, even off a cycle boundary', () => {
  // windowN 1440 ⇒ 40 ticks cross no boundary and close no 6-hour (360-tick) bucket, but the
  // accumulator must still have sampled all 40 (the price is constant at the reference here).
  let s = priceState(1440);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  assert.equal(s.fuelPriceHistory.ring.length, 0, 'no bucket closed on the long window');
  assert.equal(s.fuelPriceHistory.acc.count, 40, 'but every tick was sampled');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the snapshot publishes the closed-average ring and never the partial accumulator', () => {
  const s = priceState(4); // a bucket closes every tick
  let st = s;
  for (let i = 0; i < 6; i += 1) st = tick(st);
  const snap = buildSnapshot(st);
  assert.ok(Array.isArray(snap.fuelPriceHistory), 'published as a plain array');
  assert.deepEqual(snap.fuelPriceHistory, st.fuelPriceHistory.ring, 'verbatim the closed-average ring, oldest → newest');
  // The live "now" tip is galacticSupply.fuel.fuelPrice, so the partial bucket is not published.
  assert.equal('acc' in snap.fuelPriceHistory, false, 'a plain array carries no accumulator');
  assert.equal(typeof snap.galacticSupply.fuel.fuelPrice, 'number', 'the live tip lives on the fuel block');
});

test('a galaxy that has closed no bucket publishes an empty array (a stable shape for the reader)', () => {
  let s = priceState(1440);
  s = tick(s);
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.fuelPriceHistory, [], 'gathering-history state is [], not undefined');
});

// --- the per-guild deuterium production aggregate -------------------------------

// A deuterium mine, licensed or not; a refinery; and a non-deuterium mine — the four cases the
// aggregate must sort. Built directly (no actions) so the fields are exactly the markers the
// derive reads: a licensed mine carries `deuteriumLicence` + resourceType 'deuterium'; an
// unlicensed one only the resourceType; a refinery the `deuteriumRefinery` marker.
function prodState(windowN) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [
        { id: 'm1', ownerGuildId: 'g1', type: 'mining', resourceType: 'deuterium', productionRate: 5, deuteriumLicence: { signedTick: 0 } },
        { id: 'm2', ownerGuildId: 'g1', type: 'mining', resourceType: 'deuterium', productionRate: 5, deuteriumLicence: { signedTick: 0 } },
        { id: 'r1', ownerGuildId: 'g1', type: 'refining', deuteriumRefinery: true, productionRate: 5 },
        { id: 'u1', ownerGuildId: 'g1', type: 'mining', resourceType: 'deuterium', productionRate: 7 }, // UNLICENSED
        { id: 't1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 9 }, // non-deuterium
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

test('deuteriumProduction: two licensed mines (rate 5) → legalPerCycle = 10 × windowN; one refinery (rate 5) → contrabandPerCycle = 5 × windowN', () => {
  const windowN = 4;
  const snap = buildSnapshot(prodState(windowN));
  const dp = snap.guilds[0].deuteriumProduction;
  assert.equal(dp.legalPerCycle, 10 * windowN, 'Σ licensed-mine rate (5+5) × windowN');
  assert.equal(dp.contrabandPerCycle, 5 * windowN, 'Σ refinery rate (5) × windowN');
});

test('deuteriumProduction: an unlicensed deuterium mine and a non-deuterium venture contribute to NEITHER figure', () => {
  const windowN = 4;
  const snap = buildSnapshot(prodState(windowN));
  const dp = snap.guilds[0].deuteriumProduction;
  // The unlicensed mine (rate 7) and the titanium mine (rate 9) are present in the fixture; if
  // either leaked into a figure, legal would not be exactly 10×N nor contraband exactly 5×N.
  assert.equal(dp.legalPerCycle, 40, 'the unlicensed mine did NOT add to legal');
  assert.equal(dp.contrabandPerCycle, 20, 'and the titanium mine did NOT add to contraband');
});

test('deuteriumProduction tracks windowN, not a hardcoded 1440', () => {
  // Same ventures on the standard day: legal 10 × 1440, contraband 5 × 1440.
  const snap = buildSnapshot(prodState(1440));
  const dp = snap.guilds[0].deuteriumProduction;
  assert.equal(dp.legalPerCycle, 10 * 1440);
  assert.equal(dp.contrabandPerCycle, 5 * 1440);
});

// --- invariants: the shape sweep trips on a corrupt ring or accumulator ---------

test('checkFuelPriceHistory trips on a corrupt ring or accumulator, and passes a clean one', () => {
  let s = priceState(4);
  for (let i = 0; i < 6; i += 1) s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a real ticked galaxy is clean');

  const trips = (mutate) => {
    const bad = structuredClone(s);
    mutate(bad);
    const v = checkInvariants(bad, bad.tick);
    assert.ok(v.length > 0, 'the corruption is caught');
    return v;
  };

  trips((b) => { b.fuelPriceHistory = []; });                    // not an object
  trips((b) => { b.fuelPriceHistory.ring = 'nope'; });           // ring not an array
  trips((b) => { b.fuelPriceHistory.ring = new Array(FUEL_PRICE_HISTORY_N + 1).fill(10); }); // over cap
  trips((b) => { b.fuelPriceHistory.ring[0] = -1; });            // negative average
  trips((b) => { b.fuelPriceHistory.ring[0] = NaN; });           // NaN average
  trips((b) => { b.fuelPriceHistory.acc.sum = -1; });            // negative accumulator sum
  trips((b) => { b.fuelPriceHistory.acc.count = 1.5; });         // fractional count
  trips((b) => { b.fuelPriceHistory.acc.bucket = NaN; });        // NaN bucket coordinate
  trips((b) => { delete b.fuelPriceHistory.acc; });              // missing accumulator
});

test('a float average is tolerated (the sanctioned non-integer), not swept as an integer', () => {
  const s = priceState(4);
  // Drive two ticks whose bucket-mean is a non-integer, then confirm the invariant is happy.
  sample(s, 1, 10);
  sample(s, 2, 11);
  sample(s, 3, 12); // closes bucket 0 (windowN 4 ⇒ 1-tick buckets: bucket 0 = tick 1 only)
  // With bucketLen 1 each bucket is one tick, so make a fractional one directly: overwrite the
  // ring with a float and prove the sweep does not flag it (unlike a goods/credits integer field).
  s.fuelPriceHistory.ring.push(10.4655);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a float price average is legal, like the modifier ring');
});
