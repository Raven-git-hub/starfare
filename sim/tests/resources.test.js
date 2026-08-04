'use strict';

// Guards the canonical resource vocabulary (sim/resources.js). The load-bearing
// one is the DRIFT test: the hand-maintained RAW_RESOURCES list must stay equal
// to what the seed generator actually places, or the two halves of the codebase
// disagree about what goods exist — exactly the seam design.md §18 warns about.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RAW_RESOURCES, PROCESSED_GOODS, STOCKPILE_GOODS, FUEL_GOOD, isRawResource, isFuel, isProcessedGood, isStockpileGood } = require('../resources.js');
const { ARCHETYPES } = require('../../tools/generate_seed.js');

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
