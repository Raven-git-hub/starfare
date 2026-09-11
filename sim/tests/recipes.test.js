'use strict';

// Guards the recipe catalog (sim/recipes.js). Like the resource drift guard, the
// load-bearing check is integrity: every recipe's input and output must be a
// real stockpile good (resources.js), so a recipe can never reference a good
// that doesn't exist — the same class of seam design.md §18 warns about.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RECIPES, getRecipe, listRecipes } = require('../recipes.js');
const { isStockpileGood, isProcessedGood, isRawResource, TIER3_GOODS } = require('../resources.js');

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

// A deliberate tripwire: the full catalog, pinned. Adding or removing a recipe MUST
// update this list — so a catalog change is always a conscious, reviewed edit, never
// an accident. As of 2.1a this is the 12 Tier-2 refines (Phase-2 set + luminite_glass)
// PLUS the 25 Tier-3 module manufactures = 37 (docs/asset-recipes.md). Quantities are
// [FIRST-CUT]; the id SET is the settled part.
test('the recipe catalog is exactly the Tier-2 refines + Tier-3 module set', () => {
  const ids = listRecipes().map((r) => r.id).sort();
  assert.deepEqual(ids, [
    'battery_cells',
    'carbon_fiber_weave',
    'cargo_handling_system',
    'cargo_module',
    'chassis',
    'claim_beacon',
    'comms_array',
    'composite_resin',
    'conductive_material',
    'control_module',
    'deep_scan_mast',
    'defence_system',
    'drive_module',
    'droid_components',
    'extraction_head',
    'fabrication_line',
    'fuel_tank',
    'habitation_module',
    'heat_resistant_alloy',
    'heavy_reactor_engine',
    'hull_plating',
    'interdiction_projector',
    'life_support_module',
    'luminite_glass',
    'magnetic_assemblies',
    'medium_reactor_engine',
    'nanotube_cable',
    'photovoltaic_array',
    'power_cells',
    'radiation_shielding',
    'reactor_housing',
    'refrigerant_fluid',
    'sensor_suite',
    'silicon_wafer',
    'small_reactor_engine',
    'stealth_module',
    'titanium_alloy',
  ]);
  assert.equal(ids.length, 37, '12 Tier-2 refines + 25 Tier-3 modules');
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

// --- Tier 3: the 25 module manufactures (2.1a) --------------------------------
// The 2->3 step: each module recipe outputs exactly one module (a TIER3 good), and its
// inputs are Tier-2 processed goods and/or `luminite_glass` (a processed good) plus raw
// `tungsten` where the spec lists it — never another module (a module-inside-a-module
// would be a fifth tier). This pins the "modules are made from processed goods, one step"
// grammar of docs/asset-recipes.md.
test('every Tier-3 module has a 2->3 recipe outputting the module at qty 1', () => {
  for (const m of TIER3_GOODS) {
    const r = getRecipe(m);
    assert.ok(r, `${m} has a recipe`);
    assert.deepEqual(r.output, { good: m, qty: 1 }, `${m}'s recipe outputs 1 of itself`);
    for (const inp of r.inputs) {
      // No module ever feeds another module — inputs are Tier-2 (processed) or raw.
      assert.equal(TIER3_GOODS.includes(inp.good), false, `${m} input ${inp.good} must not be another module`);
      assert.ok(isProcessedGood(inp.good) || isRawResource(inp.good), `${m} input ${inp.good} is a Tier-2 or raw good`);
    }
  }
});
