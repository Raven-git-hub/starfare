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

// The raw mined good the fuel cycle runs on (§1.4 "The Deuterium Cycle"). Its own
// named id, beside FUEL_GOOD, so the deuterium-lever code (the licence predicate in
// sim/baseline.js, the per-tick auto-sale in sim/tick.js) names the special good in
// one place rather than sprinkling the literal. It IS a member of RAW_RESOURCES below
// — this is a label for that one entry, not a second good.
const DEUTERIUM = 'deuterium';

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
// This is the Phase-2 (raw -> processed) layer of the manufacturing tree; each
// has a recipe in recipes.js. Processed goods are NOT minable and NOT in any
// archetype pool, so the drift guard (which guards raw goods only) is unaffected.
// The id strings are `[FIRST-CUT]` (from the design list, 04-08-26); the
// raw-vs-processed distinction itself is settled. Kept sorted for a stable order.
const PROCESSED_GOODS = Object.freeze([
  'battery_cells',
  'carbon_fiber_weave',
  'composite_resin',
  'conductive_material',
  'heat_resistant_alloy',
  'luminite_glass', // 2.1a: transparent carbon-silica armour-glass — optics/viewports (docs/asset-recipes.md)
  'magnetic_assemblies',
  'nanotube_cable',
  'radiation_shielding',
  'refrigerant_fluid',
  'silicon_wafer',
  'titanium_alloy',
]);

const PROCESSED_GOOD_SET = new Set(PROCESSED_GOODS);

// Tier 3 (Manufactured Parts / MODULES, design.md §15.2) — the 25 module goods
// (docs/asset-recipes.md, the 2.1a catalog slice, 11-09-26). Each is a tradeable
// stockpile good MANUFACTURED in one 2->3 step from Tier-2 processed goods (and
// `tungsten`, raw, where the spec lists it) — its recipe lives in recipes.js and
// its droidless baseline in baseline.js, exactly like a processed good's.
//
// THEY ARE FULL ECONOMY MEMBERS NOW — the opposite of the pre-2.1a placeholders.
// TIER3_GOODS JOINS STOCKPILE_GOODS below, so a module is a legal stockpile key,
// gains a price row (prices.js), a galactic-supply row (supply.js), a quote-lock
// ring entry (price-ring.js) and a Tier-3 /goods listing (server.js) with no
// further wiring. What is still fenced off is Tier 4: no 3->4 construct recipe
// exists yet (2.1b), so a module is where the manufacturing tree currently tops
// out. The three former `*_reactor_engine` display-only placeholders are RETIRED,
// replaced by the real sized `small_/medium_/heavy_reactor_engine` module recipes.
//
// Kept sorted for a stable, deterministic order (invariant 9), like the lists above.
const TIER3_GOODS = Object.freeze([
  'cargo_handling_system',
  'cargo_module',
  'chassis',
  'claim_beacon',
  'comms_array',
  'control_module',
  'deep_scan_mast',
  'defence_system',
  'drive_module',
  'droid_components',
  'extraction_head',
  'fabrication_line',
  'fuel_tank',
  'habitation_module',
  'heavy_reactor_engine',
  'hull_plating',
  'interdiction_projector',
  'life_support_module',
  'medium_reactor_engine',
  'photovoltaic_array',
  'power_cells',
  'reactor_housing',
  'sensor_suite',
  'small_reactor_engine',
  'stealth_module',
]);

// ── THE TIER-3 CLASSES (RULED 27-09-26, docs/phase-1-tuning.md "Tier-3 sub-tiers & specialist
// parts") ─────────────────────────────────────────────────────────────────────────────────
//
// Every Tier-3 module -> its class: one of the three sub-tiers ('3-1' bulk parts, '3-2'
// standard gear, '3-3' complex systems), SPECIALIST (a part priced to the one asset it
// defines), or UNCLASSIFIED (no asset bill uses it yet). `tierOf` only knows "tier 3"; this is
// the finer answer.
//
// TWO READERS, and that is why it lives here in the vocabulary rather than in one of them:
//   - the PRICE BAND (sim/prices.js `bandFor`) — a sub-tier's band, or a specialist's own row;
//   - the PRODUCTION TIMER (sim/baseline.js `ticksPerUnitFor`, the Tier-3 timed-production
//     slice) — a sub-tier's ticks-per-unit, or a specialist's own.
// The ruling couples the two on purpose (design.md §5: "Base price ↔ production timer are ONE
// coupled system" — dearer is slower), so one class drives both. It was born in prices.js
// (Slice 1, when only the price read it) and moved here VERBATIM when the timer became its
// second reader: baseline.js cannot import prices.js (prices.js imports baseline.js), so the
// shared answer had to sit below both. prices.js re-exports it, so every existing import of it
// still works. The name keeps its Slice-1 spelling for the same reason.

// The two classes that are not a sub-tier. Spelled once, here.
const SPECIALIST = 'specialist';
const UNCLASSIFIED = 'unclassified';

// THE TIER-3 CLASSIFIER. Membership is lifted from docs/phase-1-tuning.md's two tables. A test
// pins that it names every Tier-3 good exactly once, and nothing else.
const TIER3_PRICE_CLASS = Object.freeze({
  // 3-1 — bulk / dumb parts
  cargo_module: '3-1',
  fuel_tank: '3-1',
  hull_plating: '3-1',
  power_cells: '3-1',
  // 3-2 — standard gear
  comms_array: '3-2',
  photovoltaic_array: '3-2',
  reactor_housing: '3-2',
  small_reactor_engine: '3-2',
  // 3-3 — complex systems
  cargo_handling_system: '3-3',
  chassis: '3-3',
  control_module: '3-3',
  defence_system: '3-3',
  life_support_module: '3-3',
  sensor_suite: '3-3',
  // specialists — each one's band (prices.js) and timer (baseline.js) is its own row
  deep_scan_mast: SPECIALIST,
  extraction_head: SPECIALIST,
  fabrication_line: SPECIALIST,
  heavy_reactor_engine: SPECIALIST,
  interdiction_projector: SPECIALIST,
  medium_reactor_engine: SPECIALIST,
  stealth_module: SPECIALIST,
  // unclassified — no asset uses them yet (see UNCLASSIFIED_TIER3_BAND in prices.js)
  claim_beacon: UNCLASSIFIED,
  drive_module: UNCLASSIFIED,
  droid_components: UNCLASSIFIED,
  habitation_module: UNCLASSIFIED,
});

// The goods that may key a guild stockpile and appear as a galactic-supply row:
// raw resources + processed goods + Tier-3 modules (NOT fuel). ONE source of truth
// for "what is a legal stockpile key," used by stockpile validation (invariants.js)
// and the supply totals (supply.js). Sorted for a stable, deterministic display
// order. As of 2.1a the Tier-3 modules are members: they are manufactured, held and
// priced like any other good (see TIER3_GOODS above).
const STOCKPILE_GOODS = Object.freeze([...RAW_RESOURCES, ...PROCESSED_GOODS, ...TIER3_GOODS].sort());

const STOCKPILE_GOOD_SET = new Set(STOCKPILE_GOODS);
const TIER3_GOOD_SET = new Set(TIER3_GOODS);

// ── DEPLOYABLE GOODS (roadmap 2.2 — the deploy pipeline, docs/territory-model.md §5) ──────────────
//
// A deployable good is an undeployed Tier-4 KIT: a structure packed as cargo. A transport hauls it
// to a target, and the deploy that places the structure consumes it. It is the FIRST good the game
// MOVES but never TRADES, so it is a sibling category of the stockpile goods and deliberately NOT a
// member of STOCKPILE_GOODS (the same way fuel sits outside it). That one exclusion is what keeps it
// off the market with no further wiring:
//   - prices.js prices only STOCKPILE_GOODS, so a kit has no price row;
//   - supply.js sums only STOCKPILE_GOODS, so a kit never enters Galactic Supply;
//   - invariants.js accepts only stockpile goods in a system pool or an Outpost stockpile, so a kit
//     can never be stored there. The one place it IS legal is a craft's HOLD.
// In a hold it takes a whole heavy hold (fuel.js `volumeOf` -> ASSET_CARGO_VOLUME), so only a heavy
// transport can carry one, and only one at a time — no separate class rule is needed.
//
// Keyed by the KIND of structure the kit deploys as. Adding a kind later (toll gate, deep-scan array,
// the Prefecture) is one new row here — a data change, not a refactor. Only the outpost kit exists.
const OUTPOST_KIT = 'outpost_kit';
const DEPLOYABLE_KITS = Object.freeze({ outpost: OUTPOST_KIT });

// Every deployable good, sorted for a stable order (invariant 9), like the lists above.
const DEPLOYABLE_GOODS = Object.freeze(Object.values(DEPLOYABLE_KITS).sort());
const DEPLOYABLE_GOOD_SET = new Set(DEPLOYABLE_GOODS);

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

// Is `id` a Tier-3 module (manufactured 2->3, held in stockpiles like a processed good)?
// The Tier-3 sibling of `isProcessedGood`, so `tierOf` (sim/points.js) and any other
// reader can ask "which tier" through the vocabulary's OWN predicate rather than
// re-reading the array.
function isTier3Good(id) {
  return TIER3_GOOD_SET.has(id);
}

// Is `id` a legal stockpile key / galactic-supply row (raw OR processed OR Tier-3 module,
// not fuel)?
function isStockpileGood(id) {
  return STOCKPILE_GOOD_SET.has(id);
}

// Is `id` a deployable good (an undeployed kit — haulable, never traded)? Never true for a
// stockpile good, and never true for fuel: the three categories do not overlap.
function isDeployableGood(id) {
  return DEPLOYABLE_GOOD_SET.has(id);
}

// kitGoodFor(kind) -> the deployable good that packs a structure of `kind` ('outpost' ->
// 'outpost_kit'), or null for a kind that has no kit. null (not a throw) so a caller can ASK and
// refuse loudly itself, the same shape `vehicleSpec` / `getRecipe` have.
function kitGoodFor(kind) {
  return Object.prototype.hasOwnProperty.call(DEPLOYABLE_KITS, kind) ? DEPLOYABLE_KITS[kind] : null;
}

module.exports = {
  RAW_RESOURCES, PROCESSED_GOODS, STOCKPILE_GOODS, TIER3_GOODS, FUEL_GOOD, DEUTERIUM,
  TIER3_PRICE_CLASS, SPECIALIST, UNCLASSIFIED,
  OUTPOST_KIT, DEPLOYABLE_KITS, DEPLOYABLE_GOODS,
  isRawResource, isFuel, isProcessedGood, isTier3Good, isStockpileGood, isDeployableGood, kitGoodFor,
};
