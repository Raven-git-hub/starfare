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
  const r = getRecipe('titanium_to_alloy');
  assert.ok(r);
  assert.equal(r.id, 'titanium_to_alloy');
  assert.deepEqual(r.input, { good: 'titanium', qty: 3 });   // [FIRST-CUT] 3:1
  assert.deepEqual(r.output, { good: 'alloy_ingots', qty: 1 });
  assert.equal(getRecipe('nope'), null);
});

test('listRecipes returns the catalog', () => {
  const ids = listRecipes().map((r) => r.id).sort();
  assert.deepEqual(ids, Object.keys(RECIPES).sort());
});

test('every recipe references real stockpile goods (integrity guard)', () => {
  for (const r of listRecipes()) {
    assert.ok(isStockpileGood(r.input.good), `${r.id} input ${r.input.good} must be a stockpile good`);
    assert.ok(isStockpileGood(r.output.good), `${r.id} output ${r.output.good} must be a stockpile good`);
    assert.ok(Number.isInteger(r.input.qty) && r.input.qty > 0, `${r.id} input qty must be a positive integer`);
    assert.ok(Number.isInteger(r.output.qty) && r.output.qty > 0, `${r.id} output qty must be a positive integer`);
  }
});

test('the titanium_to_alloy recipe refines a raw good into a processed good', () => {
  const r = getRecipe('titanium_to_alloy');
  assert.equal(isRawResource(r.input.good), true);       // titanium is mined
  assert.equal(isProcessedGood(r.output.good), true);    // alloy_ingots is refined
});
