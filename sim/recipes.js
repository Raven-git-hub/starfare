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
// doesn't exist.
//
// Multi-input (04-08-26): `inputs` is an ARRAY, so a recipe can require several
// goods at once (real manufacturing rarely takes a single feedstock). A
// single-input recipe is just an array of length 1.
//
// [PLACEHOLDER] numbers: the ratios below are provisional and unbalanced — they
// exist so the recipe FUNCTIONS and can be tested, not because they're tuned.
// Real ratios are set through the live recipe editor and then baked back here
// (recorded in phase-1-tuning.md). The catalog SHAPE (a fixed, id-addressed set
// of multi-input batches) is the settled part.
//   titanium_alloy = 3 titanium + 1 carbon_products -> 1 titanium_alloy.

const RECIPES = Object.freeze({
  titanium_alloy: Object.freeze({
    id: 'titanium_alloy',
    inputs: Object.freeze([
      Object.freeze({ good: 'titanium', qty: 3 }),
      Object.freeze({ good: 'carbon_products', qty: 1 }),
    ]),
    output: Object.freeze({ good: 'titanium_alloy', qty: 1 }),
  }),
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
