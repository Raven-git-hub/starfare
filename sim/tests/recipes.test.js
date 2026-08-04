'use strict';

// Guards the recipe catalog (sim/recipes.js). Like the resource drift guard, the
// load-bearing check is integrity: every recipe's input and output must be a
// real stockpile good (resources.js), so a recipe can never reference a good
// that doesn't exist — the same class of seam design.md §18 warns about.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RECIPES, getRecipe, listRecipes } = require('../recipes.js');
const { isStockpileGood, isProcessedGood, isRawResource } = require('../resources.js');

test('getRecipe resolves a known recipe and null otherwise', () => {
  const r = getRecipe('titanium_alloy');
  assert.ok(r);
  assert.equal(r.id, 'titanium_alloy');
  assert.deepEqual(r.inputs, [                       // [PLACEHOLDER] ratios
    { good: 'titanium', qty: 3 },
    { good: 'carbon_products', qty: 1 },
  ]);
  assert.deepEqual(r.output, { good: 'titanium_alloy', qty: 1 });
  assert.equal(getRecipe('nope'), null);
});

test('listRecipes returns the catalog', () => {
  const ids = listRecipes().map((r) => r.id).sort();
  assert.deepEqual(ids, Object.keys(RECIPES).sort());
});

// A deliberate tripwire: the full Phase-2 catalog, pinned. Adding or removing a
// recipe MUST update this list — so a catalog change is always a conscious,
// reviewed edit, never an accident. (Ratios are [PLACEHOLDER]; the id SET is the
// settled part.)
test('the recipe catalog is exactly the Phase-2 raw->processed set', () => {
  const ids = listRecipes().map((r) => r.id).sort();
  assert.deepEqual(ids, [
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
});

test('every recipe references real stockpile goods (integrity guard)', () => {
  for (const r of listRecipes()) {
    assert.ok(Array.isArray(r.inputs) && r.inputs.length > 0, `${r.id} must have at least one input`);
    for (const inp of r.inputs) {
      assert.ok(isStockpileGood(inp.good), `${r.id} input ${inp.good} must be a stockpile good`);
      assert.ok(Number.isInteger(inp.qty) && inp.qty > 0, `${r.id} input qty must be a positive integer`);
    }
    assert.ok(isStockpileGood(r.output.good), `${r.id} output ${r.output.good} must be a stockpile good`);
    assert.ok(Number.isInteger(r.output.qty) && r.output.qty > 0, `${r.id} output qty must be a positive integer`);
  }
});

test('the titanium_alloy recipe refines raw goods into a processed good', () => {
  const r = getRecipe('titanium_alloy');
  for (const inp of r.inputs) assert.equal(isRawResource(inp.good), true);  // titanium + carbon are mined
  assert.equal(isProcessedGood(r.output.good), true);                       // titanium_alloy is refined
});
