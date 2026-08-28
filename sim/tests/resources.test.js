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
test('the processed-goods vocabulary is exactly the Phase-2 set', () => {
  assert.deepEqual([...PROCESSED_GOODS], [
    'battery_cells',
    'carbon_fiber_weave',
    'composite_resin',
    'conductive_material',
    'heat_resistant_alloy',
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

test('STOCKPILE_GOODS is raw + processed, sorted and unique', () => {
  const expected = [...RAW_RESOURCES, ...PROCESSED_GOODS].sort();
  assert.deepEqual([...STOCKPILE_GOODS], expected);
  assert.equal(new Set(STOCKPILE_GOODS).size, STOCKPILE_GOODS.length, 'no duplicates');
  // fuel is a stockpile good under no interpretation
  assert.equal(isStockpileGood(FUEL_GOOD), false);
});

// --- Tier 3: the display-only placeholders, fenced off the economy ------------
// The console needs a Tier-3 vocabulary to head a group with; these three names
// are it. The tripwire below is the whole reason they can be added safely: it
// asserts they reach NOTHING the economy reads. If someone later gives one of
// them a recipe or a price without also promoting it properly, this goes red.

test('TIER3_GOODS is the pinned placeholder vocabulary', () => {
  assert.deepEqual([...TIER3_GOODS], [
    'small_reactor_engine',
    'medium_reactor_engine',
    'heavy_reactor_engine',
  ]);
  assert.equal(new Set(TIER3_GOODS).size, TIER3_GOODS.length, 'no duplicates');
  assert.ok(Object.isFrozen(TIER3_GOODS), 'the vocabulary is frozen like the others');
});

test('TRIPWIRE: the Tier-3 placeholders carry no baseline, no price, no recipe, no stockpile', () => {
  const prices = seedPrices();
  for (const g of TIER3_GOODS) {
    // Not in any set the economy iterates.
    assert.equal(STOCKPILE_GOODS.includes(g), false, `${g} must never be a stockpile key`);
    assert.equal(RAW_RESOURCES.includes(g), false, `${g} is not raw`);
    assert.equal(PROCESSED_GOODS.includes(g), false, `${g} is not processed`);
    // Every predicate says no — so stockpile validation (invariants.js) and the
    // supply totals cannot admit it.
    assert.equal(isStockpileGood(g), false);
    assert.equal(isRawResource(g), false);
    assert.equal(isProcessedGood(g), false);
    assert.equal(isFuel(g), false);
    // No production number: no mine baseline, no refinery baseline, no recipe.
    assert.equal(Object.prototype.hasOwnProperty.call(MINE_BASELINE, g), false, `${g} has no mine baseline`);
    assert.equal(Object.prototype.hasOwnProperty.call(REFINERY_BASELINE, g), false, `${g} has no refinery baseline`);
    assert.equal(Object.prototype.hasOwnProperty.call(RECIPES, g), false, `${g} has no recipe`);
    for (const r of Object.values(RECIPES)) {
      assert.notEqual(r.output.good, g, `${g} is the output of no recipe`);
      assert.equal((r.inputs || []).some((i) => i.good === g), false, `${g} is the input of no recipe`);
    }
    // No price: not priced, and no row in a freshly seeded price table.
    assert.equal(PRICED_GOODS.includes(g), false, `${g} is not priced`);
    assert.equal(Object.prototype.hasOwnProperty.call(prices, g), false, `${g} has no price row`);
  }
});
