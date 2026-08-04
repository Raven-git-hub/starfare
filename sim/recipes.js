'use strict';

// recipes.js — the canonical recipe catalog: the fixed set of raw->processed
// conversions a refining venture may run. Where resources.js is the one source
// of truth for "what goods exist," this is the one source for "what conversions
// exist." A refinery names a `recipeId` and the engine looks it up here — a
// caller can NOT invent an arbitrary conversion (no turning 3 titanium into
// 1000 gold), exactly as a mining venture can't mine a good a node doesn't hold.
//
// A recipe is a BATCH: it consumes `qty` of EACH good in `inputs` and produces
// `output.qty` of `output.good`. A refining venture runs up to its
// `productionRate` batches per tick, throttled by the SCARCEST input — the
// fewest batches any single input can afford (tick.js's production step). Every
// input good and the output must be a legal stockpile good (resources.js) — a
// drift-style test asserts that, so a recipe can't reference a good that
// doesn't exist. `inputs` is an ARRAY, so a recipe may require several goods.
//
// [PLACEHOLDER] ratios: EVERY quantity below is provisional and unbalanced —
// they exist so each recipe FUNCTIONS and can be tested, NOT because they're
// tuned. Real numbers get set through the live recipe editor (next slice) and
// then baked back into this file. The catalog SHAPE — a fixed, id-addressed set
// of multi-input batches, one per processed good — is the settled part; the
// numbers are the open part. New recipes seed at all-1s; titanium_alloy keeps
// its earlier 3:1 titanium cut. The input SETS come from the design list
// (04-08-26), which deliberately keeps process gases (helium/xenon/nitrogen) as
// manufacturing consumables, not just structural inputs.

// recipe(id, inputs, outputGood, outputQty) -> a frozen recipe.
// `inputs` is a list of [good, qty] pairs, kept as a compact table below so the
// whole catalog can be read at a glance. Everything is frozen so a recipe can
// never be mutated at runtime (determinism, invariant 9).
function recipe(id, inputs, outputGood, outputQty) {
  return Object.freeze({
    id,
    inputs: Object.freeze(inputs.map(([good, qty]) => Object.freeze({ good, qty }))),
    output: Object.freeze({ good: outputGood, qty: outputQty }),
  });
}

const RECIPES = Object.freeze({
  //        id                     inputs: [[good, qty], ...]                                          -> output good           qty
  battery_cells:        recipe('battery_cells',        [['lithium', 1], ['polymers', 1], ['nitrogen', 1]],               'battery_cells', 1),
  carbon_fiber_weave:   recipe('carbon_fiber_weave',   [['carbon_products', 1], ['polymers', 1]],                        'carbon_fiber_weave', 1),
  composite_resin:      recipe('composite_resin',      [['polymers', 1], ['nitrogen', 1]],                               'composite_resin', 1),
  conductive_material:  recipe('conductive_material',  [['copper', 1], ['silica', 1]],                                   'conductive_material', 1),
  heat_resistant_alloy: recipe('heat_resistant_alloy', [['tungsten', 1], ['helium', 1], ['carbon_products', 1]],         'heat_resistant_alloy', 1),
  magnetic_assemblies:  recipe('magnetic_assemblies',  [['neodymium', 1], ['xenon', 1], ['gold', 1], ['lithium', 1]],    'magnetic_assemblies', 1),
  nanotube_cable:       recipe('nanotube_cable',       [['carbon_products', 1], ['nitrogen', 1], ['silica', 1]],         'nanotube_cable', 1),
  radiation_shielding:  recipe('radiation_shielding',  [['lead', 1], ['titanium', 1], ['xenon', 1]],                     'radiation_shielding', 1),
  refrigerant_fluid:    recipe('refrigerant_fluid',    [['ammonia', 1], ['nitrogen', 1]],                                'refrigerant_fluid', 1),
  silicon_wafer:        recipe('silicon_wafer',        [['silica', 1], ['silver', 1], ['palladium', 1]],                 'silicon_wafer', 1),
  titanium_alloy:       recipe('titanium_alloy',       [['titanium', 3], ['carbon_products', 1]],                        'titanium_alloy', 1),
});

// getRecipe(id) -> the recipe, or null if no such recipe exists. The
// referential-integrity check a dangling recipeId fails (the occupancy invariant
// uses this the way it uses getSite for a siteId).
function getRecipe(id) {
  return Object.prototype.hasOwnProperty.call(RECIPES, id) ? RECIPES[id] : null;
}

// listRecipes() -> every recipe, for a UI recipe-picker or a scenario.
function listRecipes() {
  return Object.values(RECIPES);
}

module.exports = { RECIPES, getRecipe, listRecipes };
