'use strict';

// recipes.js — the canonical recipe catalog: the fixed set of raw->processed
// conversions a refining venture may run. Where resources.js is the one source
// of truth for "what goods exist," this is the one source for "what conversions
// exist." A refinery names a `recipeId` and the engine looks it up here — a
// caller can NOT invent an arbitrary conversion (no turning 3 titanium into
// 1000 gold), exactly as a mining venture can't mine a good a node doesn't hold.
//
// A recipe is a BATCH: `input.qty` of `input.good` -> `output.qty` of
// `output.good`. A refining venture runs up to its `productionRate` batches per
// tick, throttled by how much input its owner actually holds (tick.js's
// production step). Both goods must be legal stockpile goods (resources.js) — a
// drift-style test asserts that, so a recipe can't reference a good that doesn't
// exist.
//
// [FIRST-CUT] numbers (ruled 03-08-26; recorded in phase-1-tuning.md):
//   titanium_to_alloy = 3 titanium -> 1 alloy_ingot per batch.
// The ratio is open to a veto; the catalog SHAPE (a fixed, id-addressed set) is
// the settled part.

const RECIPES = Object.freeze({
  titanium_to_alloy: Object.freeze({
    id: 'titanium_to_alloy',
    input: Object.freeze({ good: 'titanium', qty: 3 }),
    output: Object.freeze({ good: 'alloy_ingots', qty: 1 }),
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
