'use strict';

// prices.js — the Syndicate value per good: the "one true number" the whole
// economy will be denominated in (docs/licence-and-price-system.md Part 1, the
// settled price rulings; design.md §8 as superseded by the §5 pointer, 26-08-26).
//
// THE DIRECTION, which is the point: the value RISES as a good sits in guild
// stockpiles and FALLS as those hoards drain. The Syndicate cannot produce, so a
// hoard IS its scarcity — it bids up whatever is being hoarded to pull it loose.
// This deliberately overrides §8's old "abundance commands worse prices".
//
// THE FORMULA, per non-fuel good, every tick (step 3 of §15.6):
//
//     target  = base × (1 + SENSITIVITY × level) × idleness
//     level   = Σ guild stockpile ÷ production capacity
//     idleness= 1 − IDLENESS_WEIGHT × (consumedThisTick ÷ (stock + consumedThisTick))
//     leading = clamp( slew( leading + ALPHA × (target − leading) ) )
//     posted  = the `leading` computed PUBLISH_LAG ticks ago
//
//   - LEVEL is the main driver and is rarity-aware for free: capacity is the sum
//     of the fixed droidless baselines (sim/baseline.js) of every venture making
//     the good, so a good with few producers turns any hoard into a big disparity
//     (sharp price) while a well-supplied one moves gently. It is self-correcting:
//     drain the hoard, the ratio falls, the price crashes.
//   - IDLENESS is the behavioural term: stock being consumed downstream this tick
//     is WORKING INVENTORY and is discounted; static stock is a HOARD and is bid
//     up. Measured as TURNOVER — this tick's downstream draw as a fraction of the
//     pile it came out of (what was drawn plus what was left) — so it is
//     dimensionless, lands in [0, 1] by construction, and needs no clamp: a pile
//     wholly consumed in one tick takes the full discount, a static one takes none.
//   - The EMA makes the value GLIDE rather than strobe, and folds in the
//     momentum/trend term for free — a building hoard climbs tick over tick.
//   - The SLEW CAP bounds one tick's move, so a single dump can't teleport it.
//   - The CLAMP is the soft floor/ceiling (the technical stop; the storyteller and
//     the destabiliser bots are the real circuit-breakers, Phase 6 / Slice 7).
//   - BASE, FLOOR and CEILING are PER MANUFACTURING TIER (PRICE_BANDS below), so a
//     processed good is not priced as though it were raw ore. Raw deuterium is the
//     one exception: it is out of the tier system and keeps its own band
//     (DEUTERIUM_BAND below). Every other constant is shared by all goods.
//   - The PUBLISH LAG breaks the price↔action circular dependency, restores §8/#42's
//     knowable posted price, and creates the front-running game: the real stock is
//     visible NOW, the price catches up later, so watching the stock is a skill edge.
//
// FUEL IS NEVER PRICED (design.md §8, §3): `deuterium_fuel` is Syndicate-regulated
// and is not a stockpile good at all, so it is excluded here by construction AND by
// an explicit guard — a permanent exclusion, not a deferral.
//
// NOTHING CONSUMES THE PRICE YET. This slice only PRODUCES the number: no sale, no
// fee, no dividend, no ledger effect (that is the licence slice). So no credits move
// and invariant 2 is untouched by anything in this file.
//
// FLOATS ARE CORRECT HERE. §15.2's "integer credits, integer goods" governs
// BALANCES; a price is a RATE, like the resolver's `rate` and the `batchCarry` /
// `sendCarry` fractions — the sanctioned non-integers, fenced off the goods ledger.
// The credits a price eventually MOVES get rounded at that point (#43,
// `round(qty × price)`), in the slice that moves them. Price state IS serialized
// state and joins the determinism hash (invariant 9): the arithmetic below is a
// fixed sequence of IEEE-754 ops over goods walked in SORTED order, so the same
// state in always yields the same prices out.
//
// [FIRST-CUT] EVERY constant below is tuning, not design — each is recorded in
// docs/phase-1-tuning.md with its rationale. The SHAPE (level × idleness, EMA,
// slew, clamp, lag) is the settled design; the values are expected to move.

const { STOCKPILE_GOODS, DEUTERIUM, isFuel } = require('./resources.js');
const { computeGalacticSupply } = require('./supply.js');
const { baselineOutputFor } = require('./baseline.js');
const { tierOf } = require('./points.js');

// [FIRST-CUT] the price BAND of each manufacturing tier (RULED 26-09-26, design.md §5
// "PER-TIER PRICE BANDS"; the numbers live in docs/phase-1-tuning.md "Resource prices").
//
//   base    — the seed value a good starts at, and the anchor the curve multiplies.
//   floor   — the lowest the value may go: 0.2 × base.
//   ceiling — the highest the value may go: 1000 × base. At LEVEL_SENSITIVITY 0.05 the
//             ceiling needs a level of ~19,980, so it is a technical backstop, not
//             a target a hoard can realistically reach.
//
// Keyed by TIER, not by good: two goods of the same tier share a band. A good's tier
// comes from `tierOf` (sim/points.js), the same answer the GP weights and the cargo
// volumes use. There is no tier-4 row on purpose: Tier-4 assets are never priced by
// this engine (they are built on demand at component cost).
//
// The floor is a float (0.2). That is fine here: a price is a RATE, not a balance
// (see "FLOATS ARE CORRECT HERE" above).
const PRICE_BANDS = Object.freeze({
  1: Object.freeze({ base: 1, floor: 0.2, ceiling: 1000 }),     // raw
  2: Object.freeze({ base: 10, floor: 2, ceiling: 10000 }),     // processed
  3: Object.freeze({ base: 100, floor: 20, ceiling: 100000 }),  // Tier-3 module
});

// Raw `deuterium`'s own band — it is NOT on the tier table above (RULED 26-09-26).
//
// Deuterium is OUT OF THE TIER SYSTEM (design.md §8, "The Deuterium Cycle"): it is the
// fuel economy's raw good, on its own production and pricing track. `tierOf` does call
// it tier 1, but that is only how the Points (GP) code sees it, not a manufacturing
// fact, so the tier bands must not re-price it.
//
// It STAYS a priced good (in PRICED_GOODS), because the licensed deuterium mine's
// per-tick auto-sale is paid at its posted price (sim/tick.js). These three numbers
// are deuterium's STATUS QUO — the flat band every good shared before the per-tier
// bands — not new ones. A truly separate, fuel-facing deuterium price is a FUTURE
// fuel-economy decision (docs/fuel-supply-and-allocation.md §1.4, "Priced, but not
// hidden"); it is not built here.
const DEUTERIUM_BAND = Object.freeze({ base: 10, floor: 2, ceiling: 200 });

// [FIRST-CUT] how hard the level drives the value. The level is measured in TICKS
// OF GALAXY-WIDE PRODUCTION HELD (stock ÷ units-per-tick), so this value sets the
// timescale on which hoarding pays: at 0.05, a level of 20 (twenty ticks of the
// galaxy's whole output sitting in stockpiles) DOUBLES the value. Chosen against a
// live run: the first cut tried (0.6) pinned every hoarded good at the old ceiling
// (20× base) inside forty ticks, which is a saturated flat line, not a market. See
// docs/phase-1-tuning.md.
const LEVEL_SENSITIVITY = 0.05;

// [FIRST-CUT] how much a fully-consumed pile is discounted against a static one.
// 0 would disable the behavioural term; 1 would make working inventory worthless.
const IDLENESS_WEIGHT = 0.5;

// [FIRST-CUT] the EMA smoothing factor: the fraction of the gap to the target the
// value closes each tick.
const EMA_ALPHA = 0.2;

// [FIRST-CUT] the slew cap: the most the value may move in one tick, as a fraction
// of its own current value (relative, so it scales with the good's price level).
const MAX_SLEW_PCT = 0.10;

// [FIRST-CUT] publish the value computed this many ticks ago.
const PUBLISH_LAG = 2;

// The priced goods: every stockpile good (raw + processed), in the sorted order
// resources.js already keeps them in — the iteration order determinism (invariant
// 9) rests on. Fuel is filtered explicitly even though it is not a stockpile good,
// so the permanent exclusion is visible here rather than implied elsewhere.
const PRICED_GOODS = Object.freeze(STOCKPILE_GOODS.filter((good) => !isFuel(good)));

// bandFor(good) -> the good's { base, floor, ceiling }, or null for a good that is not
// priced (fuel, or an unknown name). Raw deuterium gets DEUTERIUM_BAND (it is out of
// the tier system); every other priced good gets its tier's row of PRICE_BANDS.
//
// FAIL LOUD: a PRICED good whose tier has no band is a broken vocabulary, not a
// good to price at some default. Guessing a band would quietly misprice it forever,
// so this throws and names the good instead (§18, §15.5). Today every other priced
// good is tier 1, 2 or 3 (a test pins that), so the throw can only fire if a new good
// is added to the priced list without a tier.
function bandFor(good) {
  if (!PRICED_GOODS.includes(good)) return null;
  if (good === DEUTERIUM) return DEUTERIUM_BAND;
  const tier = tierOf(good);
  const band = PRICE_BANDS[tier];
  if (!band) {
    throw new Error(`prices: priced good "${good}" has tier ${tier}, which has no price band in PRICE_BANDS — refusing to guess its base, floor and ceiling`);
  }
  return band;
}

// A fresh price row for one good: posted at the good's base, and a PUBLISH_LAG-deep
// pipeline of values already "computed" as that base. The LAST pipeline slot doubles
// as the EMA MEMORY (the value the next smoothing step glides from) — one field,
// both roles, so the leading value is never stored twice (invariant 5).
function seedRow(good) {
  const { base } = bandFor(good);
  return { posted: base, pending: new Array(PUBLISH_LAG).fill(base) };
}

// seedPrices() -> the tick-0 price block: every priced good at its own base (its
// tier's, or deuterium's own).
// state.js calls this once, in createState.
function seedPrices() {
  const prices = {};
  for (const good of PRICED_GOODS) prices[good] = seedRow(good);
  return prices;
}

// leadingValue(row) -> the newest (still unpublished) value in a good's pipeline —
// the EMA memory. Exported so a test can prove the lag without reaching into the
// pipeline's shape by hand.
function leadingValue(row) {
  return row.pending[row.pending.length - 1];
}

// postedPrice(state, good) -> the value readable THIS tick (the one computed
// PUBLISH_LAG ticks ago), or null for a good that is not priced (fuel). The one
// accessor everything downstream should read, so the pipeline's shape stays here.
function postedPrice(state, good) {
  const row = (state.prices || {})[good];
  return row ? row.posted : null;
}

// basePriceFor(good) -> the good's BASE value — the anchor the curve multiplies and
// the value a fresh galaxy posts — or null for a good that is not priced (fuel).
//
// The base comes from the good's band (its tier's row, or deuterium's own). The
// accessor exists so that "what is this good's base?" has ONE answer in ONE file: the
// snapshot publishes it per good for the chart's reference line. The null for a
// non-priced good is part of the contract — readers use it to tell "not priced" apart
// from a number — so it must stay null.
function basePriceFor(good) {
  const band = bandFor(good);
  return band ? band.base : null;
}

// productionCapacity(state) -> { good: units/tick } — Σ of the FIXED DROIDLESS
// BASELINE output (sim/baseline.js) of every venture making the good, across every
// guild. Deliberately NOT `productionRate`: capacity is what the galaxy COULD make,
// so throttling doesn't inflate the level (see baseline.js's header). Integer sums,
// so guild/venture array order can't change the result.
function productionCapacity(state) {
  const capacity = {};
  for (const good of PRICED_GOODS) capacity[good] = 0;
  for (const guild of state.guilds || []) {
    for (const venture of guild.ventures || []) {
      const out = baselineOutputFor(venture);
      if (!out) continue;
      if (Object.prototype.hasOwnProperty.call(capacity, out.good)) capacity[out.good] += out.units;
    }
  }
  return capacity;
}

// priceTarget(band, stock, capacity, consumed) -> the value the good is heading toward
// this tick, BEFORE smoothing/slew/clamp. `band` is the good's own band (bandFor), so
// the curve multiplies the good's tier base. Pure arithmetic, exported so the tests
// can assert the formula directly rather than by inference.
//
// The ZERO-CAPACITY case (nobody makes the good) rests it at its BASE: with no
// producers there is no capacity to be scarce against, so the level is undefined —
// not infinite. This is also what keeps an empty galaxy's prices sitting exactly at
// base forever (the no-op path), and it is why nothing here can divide by zero.
function priceTarget(band, stock, capacity, consumed) {
  if (capacity <= 0) return band.base;
  const level = stock / capacity;
  // Turnover: of everything that sat in the pile this tick — what was drawn plus
  // what was left standing — the fraction that went downstream. In [0, 1] by
  // construction (both terms are non-negative), so no clamp is needed; a pile that
  // was empty and drew nothing has no turnover at all.
  const pool = stock + consumed;
  const turnover = pool > 0 ? consumed / pool : 0;
  const idleness = 1 - (IDLENESS_WEIGHT * turnover);
  return band.base * (1 + (LEVEL_SENSITIVITY * level)) * idleness;
}

// advanceLeading(band, previous, target) -> the new leading value: EMA-smooth toward
// the target, cap the per-tick move, then clamp into the good's own band (its tier's
// floor and ceiling). The order is the design's (smooth, then slew, then clamp) —
// clamping LAST means the clamped value is what the next EMA glides from, so a target
// far outside the band can never wind the memory up beyond it.
function advanceLeading(band, previous, target) {
  const smoothed = previous + (EMA_ALPHA * (target - previous));
  const maxMove = MAX_SLEW_PCT * Math.abs(previous);
  const slewed = Math.max(previous - maxMove, Math.min(previous + maxMove, smoothed));
  return Math.max(band.floor, Math.min(band.ceiling, slewed));
}

// recomputePrices(state, consumed) -> a NEW price block for the state as it stands
// (after step 1 has moved this tick's goods). Pure: reads state, mutates nothing.
//
//   `consumed` : { good: units drawn downstream galaxy-wide THIS tick } — handed
//                over by stepProduction through the tick's scratch context, so the
//                idleness term costs no second production resolve. Absent/partial
//                is legal and reads as zero (a direct call in a test, or a tick
//                where nothing consumed anything).
//
// The stockpile numerator is DERIVED HERE from state.guilds via the one supply
// selector — NOT read from `state.galacticSupply`, which is the post-steps cache
// and is not refreshed until after step 8.
function recomputePrices(state, consumed = {}) {
  const previous = state.prices || {};
  const stock = computeGalacticSupply(state).resources;
  const capacity = productionCapacity(state);

  const next = {};
  for (const good of PRICED_GOODS) { // sorted order — invariant 9
    // Looked up ONCE per good, so the target and the clamp below use the same band.
    const band = bandFor(good);
    // A missing row (a save from before prices existed) is seeded at this good's base.
    const row = previous[good] || seedRow(good);
    const target = priceTarget(band, stock[good] || 0, capacity[good] || 0, consumed[good] || 0);
    const leading = advanceLeading(band, leadingValue(row), target);
    next[good] = {
      // Publish the OLDEST value in the pipeline: computed PUBLISH_LAG ticks ago.
      posted: row.pending[0],
      // ...and shift this tick's value in at the back.
      pending: [...row.pending.slice(1), leading],
    };
  }
  return next;
}

module.exports = {
  PRICE_BANDS, LEVEL_SENSITIVITY, IDLENESS_WEIGHT, EMA_ALPHA, MAX_SLEW_PCT,
  PUBLISH_LAG, PRICED_GOODS,
  seedPrices, leadingValue, postedPrice, bandFor, basePriceFor, productionCapacity, priceTarget,
  advanceLeading, recomputePrices,
};
