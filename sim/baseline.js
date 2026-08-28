'use strict';

// baseline.js — the FIXED DROIDLESS BASELINE OUTPUT per venture type
// (docs/licence-and-price-system.md Part 2 "Fixed output per venture TYPE").
//
// WHY it exists NOW, ahead of the licence slice: the price engine's capacity
// normaliser (sim/prices.js) needs a good's MAX POSSIBLE production — "Σ of the
// fixed droidless baseline outputs of every venture making the good" — not the
// current `productionRate`, which is a free per-venture dial a player can throttle
// to zero. If capacity read `productionRate`, throttling every mine to 0 would
// divide the level by zero and make a hoard infinitely valuable: the denominator
// has to be what the venture COULD make, which is a property of its TYPE.
//
// WHAT THIS FILE DELIBERATELY IS NOT (deferred, licence slice): the
// `productionRate` → throttle-below / droids-above refactor. `productionRate`
// stays exactly what it is today — the free per-venture rate the resolver runs at —
// and NOTHING in production.js reads this table. It has exactly one consumer, the
// pricing capacity calc. When the licence slice makes commitment a % of the known
// max, it reads this same table, and the refactor rides with it (that slice is
// where commitment/fee actually need it).
//
// *(**Still true after the factory-commitment slice, 28-08-26** — with one clarifying
// line. `sim/production.js` now imports `producedGoodFor` from this file, the
// venture → good IDENTITY below; it still reads neither baseline TABLE. The resolver
// runs off `productionRate` exactly as before; the fee and the committed quantity are
// the only things priced off the baselines, and they are computed in `sim/actions.js`
// at signing, not in the resolver.)*
//
// [FIRST-CUT] EVERY number below is provisional and recorded in
// docs/phase-1-tuning.md. The value chosen is a UNIFORM 5 — the one extraction
// rate the repo has actually ruled (Titanium 5/tick, 01-08-26) and the client's
// uniform establish rate (`ESTABLISH_RATE` = 5). Per-resource differentiation IS
// designed ("a common Tier-1 raw yields decently, a scarcer one less — a gold mine
// might yield ~1", phase-1-tuning.md) but NO per-resource number has ever been
// ruled, so none is invented here: the table is written out entry by entry so
// tuning is a one-file edit, and the differentiation sits on the decision
// checklist instead of being guessed. A refinery's baseline is in BATCHES/tick;
// its output units are batches × the recipe's output qty.

const { RAW_RESOURCES, PROCESSED_GOODS } = require('./resources.js');
const { getRecipe } = require('./recipes.js');

// [FIRST-CUT] the uniform baseline every entry below is currently set to.
const FIRST_CUT_BASELINE = 5;

// Mining ventures: baseline units/tick, keyed by the RAW resource mined.
const MINE_BASELINE = Object.freeze({
  ammonia: 5,
  carbon_products: 5,
  copper: 5,
  deuterium: 5,
  gold: 5,
  helium: 5,
  lead: 5,
  lithium: 5,
  neodymium: 5,
  nitrogen: 5,
  palladium: 5,
  polymers: 5,
  silica: 5,
  silver: 5,
  titanium: 5, // the one RULED extraction rate (01-08-26); every other entry echoes it
  tungsten: 5,
  xenon: 5,
});

// Refining ventures: baseline BATCHES/tick, keyed by recipeId.
const REFINERY_BASELINE = Object.freeze({
  battery_cells: 5,
  carbon_fiber_weave: 5,
  composite_resin: 5,
  conductive_material: 5,
  heat_resistant_alloy: 5,
  magnetic_assemblies: 5,
  nanotube_cable: 5,
  radiation_shielding: 5,
  refrigerant_fluid: 5,
  silicon_wafer: 5,
  titanium_alloy: 5,
});

// producedGoodFor(venture) -> the good this venture's output lands as, or null when it
// produces nothing identifiable. A mine is identified by `resourceType`, a refinery by
// its recipe's OUTPUT good — a venture sets one XOR the other (§15.4).
//
// ONE DEFINITION of "what does this venture make", and that is the whole reason it is a
// named export rather than five inline reads. Five callers need it — the §5 commitment
// target (`sim/production.js`), the sale's equity split (`ownerFraction`,
// `sim/licence.js`), the licence intake (`sim/actions.js`) and the boundary fee charge
// (`sim/tick.js`), plus the profile REVIEW that flags a stale `pursue` entry — and they
// MUST agree: a factory whose commitment accrues under one key but is paid out, judged or
// reviewed under another is a licence that silently cannot be met.
// While commitment was mines-only every one of those sites could write `v.resourceType`
// and be right by accident; extending it to factory output is exactly the moment that
// stops being true, so the identity gets a home before it gets a second copy.
//
// Returns null for a dangling `recipeId` (which the occupancy invariant already halts
// on) or a future venture type that produces neither — the caller simply skips it.
function producedGoodFor(venture) {
  if (!venture) return null;
  if (venture.resourceType) return venture.resourceType;
  if (venture.recipeId) {
    const recipe = getRecipe(venture.recipeId);
    return recipe ? recipe.output.good : null;
  }
  return null;
}

// baselineOutputFor(venture) -> { good, units } | null
//   `good`  — the good this venture produces (`producedGoodFor`, above)
//   `units` — its fixed droidless baseline output of that good, in units/tick
// Returns null for a venture that produces nothing priceable (an unknown resource, a
// dangling recipeId — which the occupancy invariant is already halting on — or a future
// venture type with no entry), so the caller simply doesn't count it. The `good` half is
// DELEGATED, so this table and the identity above can never drift apart.
function baselineOutputFor(venture) {
  const good = producedGoodFor(venture);
  if (!good) return null;
  if (venture.resourceType) {
    const units = MINE_BASELINE[venture.resourceType];
    return units === undefined ? null : { good, units };
  }
  const batches = REFINERY_BASELINE[venture.recipeId];
  const recipe = getRecipe(venture.recipeId);
  if (batches === undefined || !recipe) return null;
  return { good, units: batches * recipe.output.qty };
}

// The drift guard's material: every raw resource and every recipe must have an
// entry, so adding a good/recipe without a baseline is a loud test failure rather
// than a good that silently prices off a zero capacity.
const BASELINE_KEYS = Object.freeze({
  mines: Object.freeze([...RAW_RESOURCES]),
  recipes: Object.freeze([...PROCESSED_GOODS]), // recipeId === its output good, one per processed good
});

module.exports = {
  FIRST_CUT_BASELINE, MINE_BASELINE, REFINERY_BASELINE, BASELINE_KEYS,
  producedGoodFor, baselineOutputFor,
};
