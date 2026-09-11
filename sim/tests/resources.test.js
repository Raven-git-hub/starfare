'use strict';

// Guards the canonical resource vocabulary (sim/resources.js). The load-bearing
// one is the DRIFT test: the hand-maintained RAW_RESOURCES list must stay equal
// to what the seed generator actually places, or the two halves of the codebase
// disagree about what goods exist — exactly the seam design.md §18 warns about.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RAW_RESOURCES, PROCESSED_GOODS, STOCKPILE_GOODS, TIER3_GOODS, FUEL_GOOD, isRawResource, isFuel, isProcessedGood, isStockpileGood } = require('../resources.js');
const { ARCHETYPES } = require('../../tools/generate_seed.js');
const { RECIPES } = require('../recipes.js');
const { MINE_BASELINE, REFINERY_BASELINE } = require('../baseline.js');
const { PRICED_GOODS, seedPrices } = require('../prices.js');

// The union of every archetype pool in the generator — the ground truth for
// "what is minable."
function generatorResourceUnion() {
  const s = new Set();
  for (const def of Object.values(ARCHETYPES)) {
    for (const r of def.pool || []) s.add(r);
    for (const r of def.guaranteedList || []) s.add(r);
    for (const r of Object.keys(def.guaranteed || {})) s.add(r);
  }
  return [...s].sort();
}

test('RAW_RESOURCES matches the generator archetype pools exactly (drift guard)', () => {
  assert.deepEqual([...RAW_RESOURCES].sort(), generatorResourceUnion());
});

test('RAW_RESOURCES is sorted and unique', () => {
  const sorted = [...RAW_RESOURCES].sort();
  assert.deepEqual([...RAW_RESOURCES], sorted, 'stored in sorted order');
  assert.equal(new Set(RAW_RESOURCES).size, RAW_RESOURCES.length, 'no duplicates');
});

test('the #22 ruling: deuterium is raw and minable, deuterium_fuel is fuel and is not', () => {
  assert.equal(isRawResource('deuterium'), true);
  assert.equal(isRawResource(FUEL_GOOD), false, 'the refined fuel is never a raw resource');
  assert.equal(RAW_RESOURCES.includes(FUEL_GOOD), false);
  assert.equal(isFuel(FUEL_GOOD), true);
  assert.equal(isFuel('deuterium'), false, 'raw deuterium is not the fuel');
});

test('isRawResource rejects unknown goods', () => {
  assert.equal(isRawResource('unobtanium'), false);
  assert.equal(isRawResource(undefined), false);
});

test('titanium_alloy is a processed, stockpile good — not raw, not fuel', () => {
  assert.equal(isProcessedGood('titanium_alloy'), true);
  assert.equal(isStockpileGood('titanium_alloy'), true);
  assert.equal(isRawResource('titanium_alloy'), false, 'processed goods are not minable');
  assert.equal(isFuel('titanium_alloy'), false);
  assert.equal(RAW_RESOURCES.includes('titanium_alloy'), false, 'never in the raw list / archetype pools');
});

// A deliberate tripwire: the full processed-goods vocabulary, pinned. This is the
// Phase-2 (raw -> processed) layer; every entry has a recipe (recipes.js). Adding
// or removing a processed good MUST update this list, so vocabulary changes are
// always conscious. Each must be a processed stockpile good and never raw/fuel.
test('the processed-goods vocabulary is exactly the Phase-2 set (+ luminite_glass, 2.1a)', () => {
  assert.deepEqual([...PROCESSED_GOODS], [
    'battery_cells',
    'carbon_fiber_weave',
    'composite_resin',
    'conductive_material',
    'heat_resistant_alloy',
    'luminite_glass', // 2.1a: the new Tier-2 good the module catalog needs (optics/viewports)
    'magnetic_assemblies',
    'nanotube_cable',
    'radiation_shielding',
    'refrigerant_fluid',
    'silicon_wafer',
    'titanium_alloy',
  ]);
  for (const g of PROCESSED_GOODS) {
    assert.equal(isProcessedGood(g), true, `${g} is a processed good`);
    assert.equal(isStockpileGood(g), true, `${g} is a stockpile good`);
    assert.equal(isRawResource(g), false, `${g} is not raw`);
    assert.equal(isFuel(g), false, `${g} is not fuel`);
  }
});

test('STOCKPILE_GOODS is raw + processed + tier3, sorted and unique', () => {
  // 2.1a: the Tier-3 modules JOINED the stockpile vocabulary — they are manufactured,
  // held and priced like any other good, so they are legal stockpile keys now.
  const expected = [...RAW_RESOURCES, ...PROCESSED_GOODS, ...TIER3_GOODS].sort();
  assert.deepEqual([...STOCKPILE_GOODS], expected);
  assert.equal(new Set(STOCKPILE_GOODS).size, STOCKPILE_GOODS.length, 'no duplicates');
  // fuel is a stockpile good under no interpretation
  assert.equal(isStockpileGood(FUEL_GOOD), false);
});

// --- Tier 3: the 25 real module goods (2.1a) ----------------------------------
// Pre-2.1a these were three display-only `*_reactor_engine` placeholders fenced off
// the economy. As of 2.1a they are the 25 real modules: each is a full stockpile good
// with a 2->3 recipe, a baseline and a price. The tripwire below is INVERTED from what
// it once asserted — it now proves the promotion is COMPLETE (every module reaches the
// recipe, baseline and price tables), so a module can never be half-wired.

test('TIER3_GOODS is the pinned module vocabulary (the 25 modules, 2.1a)', () => {
  assert.deepEqual([...TIER3_GOODS], [
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
  assert.equal(TIER3_GOODS.length, 25, 'exactly the 25 modules from docs/asset-recipes.md');
  assert.equal(new Set(TIER3_GOODS).size, TIER3_GOODS.length, 'no duplicates');
  assert.ok(Object.isFrozen(TIER3_GOODS), 'the vocabulary is frozen like the others');
});

test('TRIPWIRE: every Tier-3 module IS a fully-wired stockpile good — recipe, baseline, price', () => {
  const prices = seedPrices();
  for (const g of TIER3_GOODS) {
    // A module is a legal stockpile key now — so stockpile validation (invariants.js)
    // and the supply totals admit it, and it can sit in a guild's stockpiles.
    assert.equal(STOCKPILE_GOODS.includes(g), true, `${g} is a stockpile good now`);
    assert.equal(isStockpileGood(g), true);
    // But it is NEITHER raw NOR processed — Tier 3 is its own vocabulary. It is not
    // minable, and `isProcessedGood` names only the Tier-2 refines.
    assert.equal(RAW_RESOURCES.includes(g), false, `${g} is not raw`);
    assert.equal(PROCESSED_GOODS.includes(g), false, `${g} is not processed`);
    assert.equal(isRawResource(g), false);
    assert.equal(isProcessedGood(g), false);
    assert.equal(isFuel(g), false);
    // It is manufactured, not mined: no mine baseline, but it HAS a refinery baseline
    // and a recipe whose output is the module itself.
    assert.equal(Object.prototype.hasOwnProperty.call(MINE_BASELINE, g), false, `${g} has no mine baseline (it is not mined)`);
    assert.equal(Object.prototype.hasOwnProperty.call(REFINERY_BASELINE, g), true, `${g} has a refinery/manufacture baseline`);
    assert.equal(Object.prototype.hasOwnProperty.call(RECIPES, g), true, `${g} has a recipe`);
    assert.equal(RECIPES[g].output.good, g, `${g}'s recipe outputs the module itself`);
    // And it is priced: a fresh price table carries a row for it, and it is a priced good.
    assert.equal(PRICED_GOODS.includes(g), true, `${g} is priced`);
    assert.equal(Object.prototype.hasOwnProperty.call(prices, g), true, `${g} has a price row`);
  }
});
