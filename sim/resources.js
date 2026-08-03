'use strict';

// resources.js — the canonical resource vocabulary. ONE source of truth for
// "what goods exist," imported by everything that has to agree on the set
// (supply totals, stockpile validation, and — via a drift-guard test — the
// seed generator). Pure data + tiny predicates; it knows nothing about state.
//
// WHY this file exists: before it, the resource names lived only implicitly in
// the generator's archetype pools (tools/generate_seed.js). Any consumer that
// re-typed the list by hand could drift from what the generator actually
// places. This centralises the list; tests/resources.test.js asserts it still
// equals the generator's pools, so a divergence fails loudly instead of rotting.

// --- The #22 ruling (deuterium vs. fuel), decided 02-08-26 -----------------
// `deuterium` is the RAW mined resource (found on Oceanic planets, design.md
// §3). `deuterium_fuel` is REFINED from it and is what "the fuel" means — the
// good held in the Syndicate reserve (state.reserve.reserveLevel) and in guild
// fuel hoards (guild.fuelHoard), and the only Syndicate-regulated commodity.
// They are two distinct goods that happen to share a root name:
//   - `deuterium`      → a normal raw resource, minable, lives in stockpiles.
//   - `deuterium_fuel` → NOT minable, NOT in any archetype pool; it only comes
//                        into being once refining exists (not built yet), and
//                        is tracked specially by the fuel-conservation law
//                        (invariant 1), never as a row in the resource totals.
// The string `deuterium_fuel` is a [FIRST-CUT] id — flagged for a veto — but
// the two-goods distinction itself is the settled ruling.
const FUEL_GOOD = 'deuterium_fuel';

// The raw, minable resources: the union of every archetype pool in
// tools/generate_seed.js, sorted for a stable, deterministic order. Kept as a
// literal (rather than imported from the generator) so sim/ has no runtime
// dependency on tools/; tests/resources.test.js guards it against drift.
// `deuterium` is here (it IS mined); `deuterium_fuel` is deliberately NOT.
const RAW_RESOURCES = Object.freeze([
  'ammonia',
  'carbon_products',
  'copper',
  'deuterium',
  'gold',
  'helium',
  'lead',
  'lithium',
  'neodymium',
  'nitrogen',
  'palladium',
  'polymers',
  'silica',
  'silver',
  'titanium',
  'tungsten',
  'xenon',
]);

const RAW_RESOURCE_SET = new Set(RAW_RESOURCES);

// Processed goods: REFINED from raw goods and held in guild stockpiles like any
// tradeable good — UNLIKE `deuterium_fuel`, which is also refined but lives in
// the reserve/hoards and is governed by the fuel law, never as a stockpile row.
// The first is `alloy_ingots` (refined from titanium; see recipes.js). Processed
// goods are NOT minable and NOT in any archetype pool, so the drift guard (which
// guards raw goods only) is unaffected. The id string is a [FIRST-CUT], like
// `deuterium_fuel`; the raw-vs-processed distinction itself is settled.
const PROCESSED_GOODS = Object.freeze([
  'alloy_ingots',
]);

const PROCESSED_GOOD_SET = new Set(PROCESSED_GOODS);

// The goods that may key a guild stockpile and appear as a galactic-supply row:
// raw resources + processed goods (NOT fuel). ONE source of truth for "what is a
// legal stockpile key," used by stockpile validation (invariants.js) and the
// supply totals (supply.js). Sorted for a stable, deterministic display order.
const STOCKPILE_GOODS = Object.freeze([...RAW_RESOURCES, ...PROCESSED_GOODS].sort());

const STOCKPILE_GOOD_SET = new Set(STOCKPILE_GOODS);

// Is `id` a raw, minable resource — i.e. a legal key for a guild stockpile and
// a row in the galactic resource totals? (Fuel is not: it is held as fuel, not
// as a stockpiled resource.)
function isRawResource(id) {
  return RAW_RESOURCE_SET.has(id);
}

// Is `id` the refined fuel good?
function isFuel(id) {
  return id === FUEL_GOOD;
}

// Is `id` a processed good (refined, but held in stockpiles — not fuel)?
function isProcessedGood(id) {
  return PROCESSED_GOOD_SET.has(id);
}

// Is `id` a legal stockpile key / galactic-supply row (raw OR processed, not fuel)?
function isStockpileGood(id) {
  return STOCKPILE_GOOD_SET.has(id);
}

module.exports = {
  RAW_RESOURCES, PROCESSED_GOODS, STOCKPILE_GOODS, FUEL_GOOD,
  isRawResource, isFuel, isProcessedGood, isStockpileGood,
};
