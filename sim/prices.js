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
//     drain the hoard, the ratio falls, the price crashes. Capacity is per TICK for a
//     continuous good and per DAY for a timed Tier-3 good (capacityOutputFor, below).
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
//   - BASE, FLOOR and CEILING are PER GOOD'S OWN BAND, so a processed good is not
//     priced as though it were raw ore. Tier-1 and Tier-2 goods take their tier's row
//     (PRICE_BANDS below); a Tier-3 module takes its SUB-TIER's row or, for a
//     specialist part, its own row (TIER3_PRICE_CLASS below). Raw deuterium is out of
//     the tier system and keeps its own band (DEUTERIUM_BAND below). Every other
//     constant is shared by all goods.
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

const {
  STOCKPILE_GOODS, TIER3_GOODS, DEUTERIUM, isFuel,
  TIER3_PRICE_CLASS, SPECIALIST, UNCLASSIFIED,
} = require('./resources.js');
const { computeGalacticSupply } = require('./supply.js');
const { baselineOutputFor, ticksPerUnitFor } = require('./baseline.js');
const { getRecipe } = require('./recipes.js');
const { tierOf } = require('./points.js');

// [FIRST-CUT] the price BAND of Tier 1 and Tier 2 (RULED 26-09-26, design.md §5
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
// volumes use.
//
// There is NO tier-3 row any more (RULED 27-09-26): Tier 3 is too wide for one band — a
// fuel tank and a heavy reactor engine are both "a module" — so a Tier-3 good is priced
// by its sub-tier or specialist band instead (TIER3_PRICE_CLASS below). There is no
// tier-4 row either: Tier-4 assets are never priced by this engine (they are built on
// demand at component cost).
//
// The floor is a float (0.2). That is fine here: a price is a RATE, not a balance
// (see "FLOATS ARE CORRECT HERE" above).
const PRICE_BANDS = Object.freeze({
  1: Object.freeze({ base: 1, floor: 0.2, ceiling: 1000 }),     // raw
  2: Object.freeze({ base: 10, floor: 2, ceiling: 10000 }),     // processed
});

// ── TIER-3 PRICES (RULED 27-09-26, design.md §5 "TIER-3 SUB-TIERS, SPECIALIST PARTS & FINAL
// TIER-4 BILLS"; the numbers live in docs/phase-1-tuning.md "Tier-3 sub-tiers & specialist
// parts") ──────────────────────────────────────────────────────────────────────────────────
//
// Every Tier-3 band has the SAME SHAPE as the tiers above, with one deliberate difference:
//   floor   — 0.2 × base (the ruled floor ratio, unchanged).
//   ceiling — 100 × base, NOT 1000 × base: a deliberately tighter module band, ruled for a
//             better module market (it overrides the 1000× the uniform Tier-3 row had).
//
// These bases are MARKET FLOORS AT REST — the value a fresh galaxy seeds. A live price is
// expected to run above them as hoards build (the level term), specialists hardest.

// [FIRST-CUT] the three Tier-3 SUB-TIERS, by complexity. Each is a uniform band: every
// module in a sub-tier shares it.
const TIER3_SUBTIER_BANDS = Object.freeze({
  '3-1': Object.freeze({ base: 100, floor: 20, ceiling: 10_000 }),           // bulk / dumb parts
  '3-2': Object.freeze({ base: 1_000, floor: 200, ceiling: 100_000 }),       // standard gear
  '3-3': Object.freeze({ base: 10_000, floor: 2_000, ceiling: 1_000_000 }),  // complex systems
});

// [FIRST-CUT] the SPECIALIST parts: each has its OWN band, keyed by the good, because each
// is priced to the one asset it defines (docs/phase-1-tuning.md: `base = (½ × asset base −
// ordinary-part filler) ÷ desired quantity`). Above 3-3, and not a uniform tier.
const SPECIALIST_BANDS = Object.freeze({
  extraction_head: Object.freeze({ base: 1_000_000, floor: 200_000, ceiling: 100_000_000 }),               // miner
  fabrication_line: Object.freeze({ base: 1_000_000, floor: 200_000, ceiling: 100_000_000 }),              // factory
  medium_reactor_engine: Object.freeze({ base: 2_000_000, floor: 400_000, ceiling: 200_000_000 }),         // medium transport
  stealth_module: Object.freeze({ base: 8_000_000, floor: 1_600_000, ceiling: 800_000_000 }),              // spycraft
  heavy_reactor_engine: Object.freeze({ base: 20_000_000, floor: 4_000_000, ceiling: 2_000_000_000 }),     // heavy transport
  deep_scan_mast: Object.freeze({ base: 20_000_000, floor: 4_000_000, ceiling: 2_000_000_000 }),           // deep scan array
  interdiction_projector: Object.freeze({ base: 20_000_000, floor: 4_000_000, ceiling: 2_000_000_000 }),   // toll gate
});

// The band of the four UNCLASSIFIED modules — drive_module, droid_components, claim_beacon,
// habitation_module. No asset bill uses them yet, and the ruling says they "default to a
// sub-tier when first placed in a bill" WITHOUT saying which one. Picking a sub-tier here
// would be inventing their price, and leaving them with no band would crash every galaxy
// (they are priced goods, so a fresh galaxy seeds them). So they keep their STATUS QUO: the
// uniform Tier-3 band every module had before this ruling. These are not new numbers — the
// same move DEUTERIUM_BAND makes. Choosing their sub-tier is on the roadmap's decision
// checklist.
const UNCLASSIFIED_TIER3_BAND = Object.freeze({ base: 100, floor: 20, ceiling: 100_000 });

// THE TIER-3 CLASSIFIER — `TIER3_PRICE_CLASS` (every Tier-3 module -> '3-1', '3-2', '3-3',
// SPECIALIST or UNCLASSIFIED) and the two class names — now lives in sim/resources.js and is
// imported above. It moved there, unchanged, in the Tier-3 timed-production slice, because the
// production timer (sim/baseline.js) became its second reader and baseline.js cannot import this
// file. It is re-exported below, so `require('./prices.js').TIER3_PRICE_CLASS` still works.

// Own-key lookup: a plain `table[key]` would also find inherited names like "toString",
// and a classifier typo must read as "no band", never as a function.
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

// tier3BandOf(good, classOf) -> the Tier-3 good's band under the classifier `classOf`, or
// undefined when that classifier gives it no band (missing, an unknown class, or a
// SPECIALIST with no row in SPECIALIST_BANDS).
function tier3BandOf(good, classOf) {
  const priceClass = own(classOf, good);
  if (priceClass === SPECIALIST) return own(SPECIALIST_BANDS, good);
  if (priceClass === UNCLASSIFIED) return UNCLASSIFIED_TIER3_BAND;
  return own(TIER3_SUBTIER_BANDS, priceClass);
}

// assertTier3Classified(goods, classOf) — THROWS, naming the good, if any of `goods` gets no
// band under `classOf`. Guessing a band would quietly misprice a module forever (§18, §15.5).
//
// THE LOAD-TIME TRIPWIRE, the same pattern as assertBillModulesAreTier3 (sim/asset-recipes.js):
// it runs below over the real Tier-3 vocabulary the instant this file is required, so a new
// module added to resources.js without a price class fails the whole suite loudly. bandFor
// also calls it for each Tier-3 good it prices. It is exported so a test can hand it a
// deliberately broken classifier and prove the guard bites.
function assertTier3Classified(goods, classOf) {
  for (const good of goods) {
    if (!tier3BandOf(good, classOf)) {
      throw new Error(`prices: Tier-3 good "${good}" has price class ${JSON.stringify(own(classOf, good))}, which resolves to no band — classify it in TIER3_PRICE_CLASS (and SPECIALIST_BANDS for a specialist) rather than guess its base, floor and ceiling`);
    }
  }
}

assertTier3Classified(TIER3_GOODS, TIER3_PRICE_CLASS);

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
// For a TIMED Tier-3 good the level is DAYS of production held, not ticks (its capacity is
// per period — see capacityOutputFor), so the same 0.05 gives it a gradient too: one day's
// output held nudges the value up 5%.
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
// priced (fuel, or an unknown name). Three routes:
//   - raw deuterium        -> DEUTERIUM_BAND (it is out of the tier system);
//   - a Tier-3 module      -> its sub-tier or specialist band (tier3BandFor);
//   - a Tier-1/2 good      -> its tier's row of PRICE_BANDS.
//
// FAIL LOUD: a PRICED good with no band is a broken vocabulary, not a good to price at
// some default. Guessing a band would quietly misprice it forever, so this throws and
// names the good instead (§18, §15.5). Today every priced good has a band (tests pin
// that), so the throw can only fire if a new good is added to the priced list — a new
// module above all — without being classified.
function bandFor(good) {
  if (!PRICED_GOODS.includes(good)) return null;
  if (good === DEUTERIUM) return DEUTERIUM_BAND;
  const tier = tierOf(good);
  if (tier === 3) {
    assertTier3Classified([good], TIER3_PRICE_CLASS); // throws, naming the good, if it has no band
    return tier3BandOf(good, TIER3_PRICE_CLASS);
  }
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
// tier's, its Tier-3 sub-tier's or specialist's, or deuterium's own).
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
// The base comes from the good's band (bandFor: its tier's row, its Tier-3 sub-tier's
// or specialist's, or deuterium's own). The
// accessor exists so that "what is this good's base?" has ONE answer in ONE file: the
// snapshot publishes it per good for the chart's reference line. The null for a
// non-priced good is part of the contract — readers use it to tell "not priced" apart
// from a number — so it must stay null.
function basePriceFor(good) {
  const band = bandFor(good);
  return band ? band.base : null;
}

// [FIRST-CUT] the reference PERIOD a TIMED good's capacity is measured over: one day, 1,440
// ticks at the ruled 1 tick = 1 minute (docs/tier3-timed-production.md "The price fix";
// docs/phase-1-tuning.md "Tier-3 production timers"). Read ONLY by capacityOutputFor below.
const CAPACITY_PERIOD_TICKS = 1440;

// capacityOutputFor(venture) -> { good, units } | null — what ONE venture adds to its good's
// capacity, the denominator of `level = stock ÷ capacity`. The capacity path's OWN reader.
//
// THE PER-PERIOD FIX (the load-bearing half of the timed-production slice). A continuous good
// (every Tier-1 mine, every Tier-2 refinery) is measured PER TICK, exactly as before — this
// just hands back `baselineOutputFor`. A TIMED good (Tier 3) makes less than one unit a tick —
// the fastest, a 3-1 part, makes one per 15 — so a per-tick capacity would be a fraction
// (1/15 … 1/5,040) and `stock ÷ fraction` explodes: ONE finished heavy engine would read as a
// level of 2,520 and peg the price at its ceiling. So a timed good is measured per PERIOD
// instead: units per day = 1,440 ÷ ticks-per-unit × the recipe's output (a 3-1 factory 96/day,
// a heavy-engine factory 4/7 of one a day). The level then reads "days of production hoarded",
// and the unchanged 0.05 sensitivity gives a gentle gradient. The basis is per GOOD (ticksPerUnitFor),
// so one good's capacity can never mix the two timescales.
//
// WHY A SEPARATE READER, not a change to `baselineOutputFor`: that function is ALSO the licence
// fee's basis ("baseline output over one window", sim/actions.js) and the snapshot's fee quote.
// Changing it would silently re-price every Tier-3 licence — a Slice-3 decision. So the fee
// keeps reading `baselineOutputFor` exactly as before, and only the capacity sum reads this.
//
// A timed good's figure can be FRACTIONAL (an 84 h part makes 2/7 of one a day; only its WEEKLY
// output is ruled whole, sim/windows.js). That is fine: capacity is a rate, not a balance, like
// the price itself ("FLOATS ARE CORRECT HERE" above).
function capacityOutputFor(venture) {
  const out = baselineOutputFor(venture);
  if (!out) return null;
  const ticksPerUnit = ticksPerUnitFor(out.good);
  if (ticksPerUnit === null) return out; // continuous: units per TICK, unchanged
  const recipe = getRecipe(venture.recipeId);
  if (!recipe) return null; // not a factory (a timed good is only ever made by one)
  return { good: out.good, units: (CAPACITY_PERIOD_TICKS / ticksPerUnit) * recipe.output.qty };
}

// productionCapacity(state) -> { good: capacity } — Σ of every venture's FIXED capacity
// (capacityOutputFor above) across every guild: units per TICK for a continuous good, units per
// PERIOD (one day) for a timed Tier-3 good. Deliberately NOT `productionRate`: capacity is what
// the galaxy COULD make, so throttling doesn't inflate the level (see baseline.js's header).
// Continuous goods sum integers; a timed good's per-venture figure may be fractional, but the
// ventures are always walked in the same guild/venture array order, so the sum is deterministic.
function productionCapacity(state) {
  const capacity = {};
  for (const good of PRICED_GOODS) capacity[good] = 0;
  for (const guild of state.guilds || []) {
    for (const venture of guild.ventures || []) {
      const out = capacityOutputFor(venture);
      if (!out) continue;
      if (Object.prototype.hasOwnProperty.call(capacity, out.good)) capacity[out.good] += out.units;
    }
  }
  return capacity;
}

// priceTarget(band, stock, capacity, consumed) -> the value the good is heading toward
// this tick, BEFORE smoothing/slew/clamp. `band` is the good's own band (bandFor), so
// the curve multiplies the good's own base. Pure arithmetic, exported so the tests
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
// the target, cap the per-tick move, then clamp into the good's own band (its own
// floor and ceiling, from bandFor). The order is the design's (smooth, then slew, then clamp) —
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
  PRICE_BANDS, DEUTERIUM_BAND,
  TIER3_SUBTIER_BANDS, SPECIALIST_BANDS, UNCLASSIFIED_TIER3_BAND, TIER3_PRICE_CLASS,
  SPECIALIST, UNCLASSIFIED, assertTier3Classified,
  LEVEL_SENSITIVITY, IDLENESS_WEIGHT, EMA_ALPHA, MAX_SLEW_PCT,
  PUBLISH_LAG, PRICED_GOODS,
  CAPACITY_PERIOD_TICKS,
  seedPrices, leadingValue, postedPrice, bandFor, basePriceFor, capacityOutputFor, productionCapacity,
  priceTarget, advanceLeading, recomputePrices,
};
