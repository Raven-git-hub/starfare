'use strict';

// fuel-price-history.js — the GALAXY-WIDE fuel-price HISTORY store: engine-owned,
// serialized, so the DEUTERIUM tab's price graph has a smoothed trend to draw and every
// viewer sees the same curve.
//
// WHY this exists, and why it is GLOBAL. A snapshot is a single instant; the tab's price
// graph is the fuel price OVER TIME. `state.reserve.fuelPrice` carries only the value RIGHT
// NOW (the price controller posts it at each cycle boundary, sim/tick.js §4.2), so until this
// slice there was no fuel-price history at all. The fuel price is GALAXY-WIDE — one value for
// the whole galaxy (§15.5 invariant 5, "one fuel price"), not a guild's figure — so its
// history lives ONCE, TOP-LEVEL beside `state.priceHistory`, never hung off a guild:
//     state.fuelPriceHistory: { ring: [ <avg>, … ], acc: { sum, count, bucket } }
//
// AVERAGED, unlike price-history's point-sampled close. The tab wants a smoothed 3-day trend,
// so a point is the TRUE 6-HOUR AVERAGE of the fuel price across the ticks of a bucket, not a
// single close. That needs an accumulator carried in serialized state between bucket closes
// (the deliberate cost price-history's tiers avoided by point-sampling — but the fuel graph
// wants the smoothing). Two parts:
//   - `ring`: the last 12 COMPLETED 6-hour averages, oldest → newest — the 12 points = 3 days.
//   - `acc`:  the current bucket in progress — `{ sum, count }` of this bucket's fuel prices,
//             plus `bucket`, the quarter-day index it is accumulating (so a bucket closes when
//             the index rolls, not on a stopwatch).
//
// FLOATS, by design. The fuel price is a float (e.g. 10.46…), so an average of it is a float —
// stored as such, exactly as sim/price-history.js stores its float samples and the modifier
// ring stores its sanctioned floats. NOT the integer goods/credits sweep (§15.2): this SCALES
// a quantity, it does not count one. `checkFuelPriceHistory` (sim/invariants.js) tolerates the
// float exactly as `checkModifierHistory` does its modifier.
//
// CLOCK-FREE AND DETERMINISTIC (invariant 9). The bucketing is pure arithmetic on the tick,
// the window length and the day anchor — no `Date.now`. Buckets align to the CALENDAR DAY the
// same way cycle boundaries do (`sim/calendar.js` `dayOf`/`minuteOf`, the same `(tick-1)` phase
// and anchor `isWindowBoundary` uses), so a day boundary is always a bucket boundary and there
// is no galaxy-tick-1 drift. This IS serialized state and DOES enter the determinism hash —
// intended, and unlike the sparse burn/price-history slices the accumulator moves EVERY tick
// (every ticking galaxy has a fuel price), so every ticking determinism golden legitimately
// moves; the golden regen is done with the strip-and-prove method for exactly that reason.
//
// OMIT-WHEN-EMPTY. A galaxy that has never taken a sample (tick 0 / a fresh `createState`)
// carries NO `fuelPriceHistory` key at all — the cleanest of the two options, mirroring
// `priceHistory` (createState omits it; this module mints it lazily on the first sample). From
// the first ticking sample the field is present with an empty ring, and its first ring point
// lands 6 game-hours in — like the burn history, "not yet" is empty, not a failure.

const { dayOf, minuteOf } = require('./calendar.js');
const { DEFAULT_WINDOW_N } = require('./windows.js');

// FUEL_PRICE_HISTORY_N — how many completed 6-hour averages the ring keeps.
//
// `[FIRST-CUT]` 12. A DISPLAY-DEPTH constant — how far back the graph looks — not an economy
// number: it feeds no rate, price, fee, grant or commitment, and changing it changes only how
// many points the line can draw. 12 × 6 game-hours = 3 days, the trend the tab shows. Recorded
// in docs/phase-1-tuning.md; single-sourced here so the client plots what it is sent.
const FUEL_PRICE_HISTORY_N = 12;

// FUEL_PRICE_BUCKET_DIVISOR — how many buckets a day is split into: 4, one per 6 game-hours (a
// quarter-day). Also DISPLAY-DEPTH (how coarse each point is), not an economy number. The bucket
// LENGTH in ticks is DERIVED from the galaxy's own cycle — `windowN / 4` (360 on the standard
// 1,440-tick day) — never hardcoded, so a galaxy on a non-standard day still buckets to
// quarter-days. Recorded in docs/phase-1-tuning.md.
const FUEL_PRICE_BUCKET_DIVISOR = 4;

// bucketIndexOf(tick, N, anchor) -> the GLOBAL, monotonic quarter-day index the tick falls in:
// which of the four 6-hour buckets, of which day. Built from the calendar helpers so it is
// aligned to the day EXACTLY as `isWindowBoundary` aligns cycle boundaries — `dayOf` gives the
// day (same `(tick-1)` phase and anchor), `minuteOf` the minute within it in [0, N), and
// `floor(minute / bucketLen)` the quarter in {0,1,2,3}. `dayOf × 4` makes the index monotonic
// across days, so a day roll is a bucket roll too and there is no drift. Pure arithmetic on the
// tick — the whole clock-free story in one line.
function bucketIndexOf(tick, N, anchor = 0) {
  const bucketLen = N / FUEL_PRICE_BUCKET_DIVISOR;
  return (dayOf(tick, N, anchor) * FUEL_PRICE_BUCKET_DIVISOR)
    + Math.floor(minuteOf(tick, N, anchor) / bucketLen);
}

// getFuelPriceRing(state) -> the ring of COMPLETED averages as stored, or null before the field
// exists. Returns the LIVE array (no copy): read-only for callers, exactly as price-history's
// getPriceHistory is. The accumulator is deliberately NOT exposed — it is the partial bucket in
// progress, and the snapshot tips the line with the live `galacticSupply.fuel.fuelPrice` instead.
function getFuelPriceRing(state) {
  return (state.fuelPriceHistory && state.fuelPriceHistory.ring) || null;
}

// recordFuelPriceSample(state, tick) — the tick's one call, made every tick with the tick's
// FINAL fuel price (sim/tick.js, after step 6 has posted next cycle's price at a boundary and
// left it unchanged otherwise). If this tick begins a NEW 6-hour bucket and the accumulator
// holds samples, push the closing bucket's true average (sum / count) onto the ring — dropping
// the oldest past 12 — and reset the accumulator to the new bucket; then add this tick's price.
// This yields exactly one true 6-hour average per closed bucket.
//
// `tick` is the PRODUCING tick — the tick number of the state being built (sim/tick.js sets
// `next.tick` before calling this), matching recordPriceSamples' convention so a reader comparing
// a point against `snapshot.tick` has no off-by-one. The ONLY place a `fuelPriceHistory` key is
// minted, which is what keeps a never-ticked galaxy byte-identical (omit-when-empty).
//
// A non-finite price is SKIPPED, not written — the accumulator simply does not advance this
// tick. That keeps a NaN out of serialized state (where it would poison the determinism hash),
// WITHOUT throwing here: a genuine NaN fuel price is caught loudly at its source by the
// invariant sweep (`checkField(reserve.fuelPrice)`, sim/invariants.js), and refusing to throw
// lets a hand-built PARTIAL state (a fixture whose reserve carries no `fuelPrice`, exactly as
// the snapshot's own reserve-less fallback tolerates) tick through to whatever invariant it
// actually breaks, rather than this observation-only step preempting the real halt.
function recordFuelPriceSample(state, tick) {
  const price = state.reserve ? state.reserve.fuelPrice : undefined;
  if (typeof price !== 'number' || !Number.isFinite(price)) return state;
  const N = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
  const anchor = state.dayAnchorTick == null ? 0 : state.dayAnchorTick;

  const bucket = bucketIndexOf(tick, N, anchor);
  let fph = state.fuelPriceHistory;
  if (!fph) {
    // First sample this galaxy has ever taken — mint the field (omit-when-empty until here),
    // its accumulator adopting this tick's bucket so the first close is measured against it.
    fph = state.fuelPriceHistory = { ring: [], acc: { sum: 0, count: 0, bucket } };
  }

  if (fph.acc.count > 0 && bucket !== fph.acc.bucket) {
    // The bucket the accumulator was filling has closed — push its 6-hour average and reset.
    fph.ring.push(fph.acc.sum / fph.acc.count);
    if (fph.ring.length > FUEL_PRICE_HISTORY_N) fph.ring.shift();
    fph.acc = { sum: 0, count: 0, bucket };
  } else if (fph.acc.count === 0) {
    // A never-yet-filled accumulator (freshly minted, or a restored save carrying an empty one)
    // adopts this tick's bucket, so the first sample sets which bucket it is averaging.
    fph.acc.bucket = bucket;
  }

  fph.acc.sum += price;
  fph.acc.count += 1;
  return state;
}

// cloneFuelPriceHistory(fph) -> a deep-enough copy so a caller's object can never alias into
// engine state (createState uses it, parallel to clonePriceHistory). The ring is copied (it is
// the mutable part) and the accumulator spread into a fresh object.
function cloneFuelPriceHistory(fph) {
  return {
    ring: [...(fph && Array.isArray(fph.ring) ? fph.ring : [])],
    acc: {
      sum: (fph && fph.acc && fph.acc.sum) || 0,
      count: (fph && fph.acc && fph.acc.count) || 0,
      bucket: (fph && fph.acc && fph.acc.bucket) || 0,
    },
  };
}

module.exports = {
  FUEL_PRICE_HISTORY_N,
  FUEL_PRICE_BUCKET_DIVISOR,
  bucketIndexOf,
  getFuelPriceRing,
  recordFuelPriceSample,
  cloneFuelPriceHistory,
};
