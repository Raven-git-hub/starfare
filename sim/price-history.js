'use strict';

// price-history.js — the posted-price HISTORY store: engine-owned, serialized,
// sparse stored state, so the TRADE tab's price graph has something to draw and
// every viewer sees the same curve.
//
// WHY this exists, and why it is GLOBAL. A snapshot is a single instant; a price
// chart is change over time. `state.prices` carries only the value posted RIGHT NOW,
// so until this slice there was no history at all (a deliberate earlier decision,
// noted in snapshot.js). This module gives it a home with the same discipline
// `sim/history.js` gives the production sparklines — with ONE structural difference:
// the posted price is GALAXY-WIDE, one value per good (`state.prices`), not a guild's
// figure. So price history is TOP-LEVEL state beside `state.prices`:
//     state.priceHistory: { [good]: { fine: [...], medium: [...], coarse: [...] } }
// It is NOT hung off a guild, and there is deliberately no per-guild variant: two
// guilds looking at the same good are looking at the same number.
//
// WHY THREE RINGS. The chart wants a 3-month view. At 1 tick = 1 minute that is
// ~130,000 ticks; keeping a raw per-tick sample for ~28 priced goods would put
// ~3.6M numbers into the save AND into the determinism hash, every tick. Infeasible.
// So the store keeps three fixed-size rings per good at coarsening cadences, which
// is how a price chart is stored under the hood everywhere: a fine ring for the
// recent days, a medium one for the recent weeks, a coarse one for the quarter.
// ~546 samples per good covers the full span — trivial to serialize.
//
// WHAT A SAMPLE IS — the CLOSING PRICE, point-sampled. When a tier's bucket closes
// (`tick % every === 0`) the good's posted value AT THAT TICK is appended. Nothing is
// averaged: an average would need an accumulator carried in serialized state between
// bucket closes, for no visible difference on a game chart, and the close price is
// what a real daily chart plots. Oldest → newest; the newest sample is last.
//
// CLOCK-FREE AND DETERMINISTIC (invariant 9). The sample is driven purely by the tick
// counter — no `Date.now`, and deliberately NO `dayAnchorTick`: the cycle anchor exists
// so the ECONOMY's window boundaries line up with a wall clock, and this is display
// telemetry, not a cycle. Goods are walked in `PRICED_GOODS`' sorted order, so the
// bytes are stable. This IS serialized state and DOES enter the determinism hash —
// intended, and the reason the golden regen is done with the strip-and-prove method.
//
// SPARSE. `recordPriceSamples` is the ONLY place a key is minted, and it mints none
// until the first fine bucket closes at tick 15. A galaxy younger than that — every
// short test run and the whole persistence golden — serializes byte-identically to
// before this slice, which is what makes the regen provable.

const { PRICED_GOODS, postedPrice } = require('./prices.js');

// The three tiers. Every number here is a [FIRST-CUT] DISPLAY-DEPTH constant — how
// far back the chart can look and how finely — not an economy number: none of it
// feeds a rate, a price, a fee or a commitment, and changing any of it changes only
// the shape of a line on screen. Recorded in docs/phase-1-tuning.md. Single-sourced
// here so a tuning change is a one-line edit and the client never hard-codes a depth.
//
//   every  — sample once every N ticks (1 tick = 1 minute, docs/cycle-and-calendar.md)
//   length — how many samples the ring keeps, i.e. the span it covers
//
//   fine     15 ticks × 288 =   4,320 ticks ≈  3 days     → the 3D scale
//   medium  120 ticks × 168 =  20,160 ticks ≈ 14 days     → the 2W scale
//   coarse 1440 ticks ×  90 = 129,600 ticks ≈ 90 days     → the 1M and 3M scales
//
// THREE RINGS SERVE FOUR SCALE BUTTONS: `coarse` serves both 1M (its most recent ~30
// samples) and 3M (all 90). That mapping is the CLIENT's to apply and is recorded in
// docs/phase-1-tuning.md; the engine emits rings, not scale buttons.
const TIERS = Object.freeze([
  Object.freeze({ key: 'fine', every: 15, length: 288 }),
  Object.freeze({ key: 'medium', every: 120, length: 168 }),
  Object.freeze({ key: 'coarse', every: 1440, length: 90 }),
]);

// The tier names, in ring order. This is a CONTRACT: the TRADE tab (shipped in PR #41)
// already reads `priceHistory[good][tier]`, so these three keys are a published shape,
// not an internal detail — do not rename them to UI scale labels, and do not collapse
// or add a tier without moving the consumer in the same slice.
const TIER_KEYS = Object.freeze(TIERS.map((t) => t.key));

// An empty row: all three rings present and empty. Every good gets its rings at the
// same moment (the first fine bucket), so a row is never half-built.
function emptyRow() {
  const row = {};
  for (const tier of TIERS) row[tier.key] = [];
  return row;
}

// getPriceHistory(state, good) -> the good's { fine, medium, coarse } as stored, or
// null before any sample has landed. Returns the LIVE arrays (no copy): read-only
// for callers, exactly as sim/history.js's getHistory is.
function getPriceHistory(state, good) {
  return ((state.priceHistory || {})[good]) || null;
}

// pushPriceSample(state, good, tierKey, value) — append one sample to one ring,
// creating the nesting as needed and dropping the oldest once the ring is full.
// The ONLY place a `priceHistory` key is minted.
//
// The value is a PRICE, so it is a float by design (§ prices.js: "floats are correct
// here" — a price is a rate, not a balance). It is coerced to a number and a
// non-finite one is refused rather than written, so a corrupt caller can never put a
// NaN into serialized state where it would poison the determinism hash.
function pushPriceSample(state, good, tierKey, value) {
  const tier = TIERS.find((t) => t.key === tierKey);
  if (!tier) throw new Error(`pushPriceSample: unknown tier ${JSON.stringify(tierKey)}`);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`pushPriceSample: refusing to record a non-finite ${good} price (${value}) into ${tierKey}`);
  }
  if (!state.priceHistory) state.priceHistory = {};
  const row = state.priceHistory[good] || (state.priceHistory[good] = emptyRow());
  const ring = row[tierKey];
  ring.push(value);
  if (ring.length > tier.length) ring.shift();
  return ring;
}

// tiersClosingAt(tick) -> the tiers whose bucket closes on this tick, in ring order.
// Pure arithmetic on the tick counter — the whole clock-free story in one line.
// Tick 0 is excluded: it is the pre-game state, not a bucket that has run.
function tiersClosingAt(tick) {
  if (!Number.isInteger(tick) || tick <= 0) return [];
  return TIERS.filter((t) => tick % t.every === 0);
}

// recordPriceSamples(state, tick) — the tick's one call. For every tier whose bucket
// closes on `tick`, append each priced good's CURRENT posted value to that ring.
//
// `tick` is the PRODUCING tick — the tick number of the state this step is building,
// i.e. `state.tick + 1` inside the step — matching the convention recordSale and the
// window boundary already use, so a reader comparing a sample against `snapshot.tick`
// has no off-by-one.
//
// Goods are walked in PRICED_GOODS' sorted order (invariant 9). A good with no posted
// price is skipped rather than recorded as a hole: fuel is not in PRICED_GOODS at all,
// so in practice this only fires for a state whose price row was removed by hand.
function recordPriceSamples(state, tick) {
  const closing = tiersClosingAt(tick);
  if (!closing.length) return state;
  for (const good of PRICED_GOODS) {
    const price = postedPrice(state, good);
    if (price == null) continue;
    for (const tier of closing) pushPriceSample(state, good, tier.key, price);
  }
  return state;
}

// clonePriceHistory(history) -> a deep-enough copy so a caller's object can never
// alias into engine state (createState uses it, parallel to cloneHistory /
// cloneStockpiles). The rings are copied too — they are the mutable part.
function clonePriceHistory(history) {
  const out = {};
  for (const [good, row] of Object.entries(history || {})) {
    const copy = {};
    for (const key of TIER_KEYS) copy[key] = [...((row || {})[key] || [])];
    out[good] = copy;
  }
  return out;
}

module.exports = {
  TIERS, TIER_KEYS,
  emptyRow, getPriceHistory, pushPriceSample, tiersClosingAt,
  recordPriceSamples, clonePriceHistory,
};
