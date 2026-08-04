'use strict';

// tick.js — the pure economy step: the fixed eight-step order from
// design.md §15.6, as eight named functions. Being filled in one pillar at a
// time (working practice #3) rather than all at once, so each pillar is a
// real, individually-tested fact rather than a batch of invented behavior.
//
// Landed so far: step 1, production (the simplest possible cut -- see its
// own comment below for exactly what it does and doesn't do yet). Steps
// 2-8 are still `identity` — explicit NAMED no-ops — because their real
// logic needs modules that don't exist yet (economy.js, territory.js,
// bots.js — see sim/README.md's planned layout). Their seam already sits in
// the right place, in the right order, instead of being invented ad hoc
// whenever that module lands.
//
// What IS real about this file, even where a step is still a stub:
//   - the ORDER is fixed and correct per §15.6, so invariant 9 (deterministic
//     tick order) has something true to hold onto as soon as steps start
//     doing something
//   - tick() is pure: it never mutates its `state` argument, always returns
//     a new state object
//   - no DOM access anywhere (the hard rule in sim/README.md)

const { computeGalacticSupply } = require('./supply.js');
const { getRecipe } = require('./recipes.js');

// Deep-clones state so tick() can never accidentally mutate its input.
// structuredClone is a plain JS global (Node 17+), not a DOM API.
function cloneState(state) {
  return structuredClone(state);
}

// Step 1 — production. A MINING venture extracts `productionRate` units of its
// `resourceType` each tick into the OWNER guild's typed `stockpiles`. A REFINING
// venture (03-08-26; multi-input 04-08-26) runs up to `productionRate` batches of
// its recipes.js recipe, consuming EACH of the recipe's input goods from and
// producing the output good into the owner's stockpiles — throttled by the
// scarcest input so nothing goes negative. One home for produced goods, so
// nothing is double-counted (supply.js derives its totals from exactly these
// stockpiles). `Venture.updatedAtTick` records when a venture moved goods
// (§15.2's "every mutation records its tick").
//
// Deliberately NOT yet implemented, left for economy.js:
//   - per-venture `inputStockpiles` buffers: refining here draws its input
//     straight from the owner guild's stockpile (the simplest honest model),
//     not from a venture-local input buffer. When logistics needs that buffer
//     (staging inputs at the venture before a run), it returns with its own
//     tripwire; today it would be unused machinery.
//   - crediting guild.lifetimeProduced (§13's monotonic produced counter). The
//     good is now known, so this is a one-liner away, but it is a separate
//     concern with its own future tripwire (monotonicity) — wired when a
//     consumer needs it, not speculatively here.
//   - NOTE: ventures draw no fuel/energy at all (renewable-powered, §3 /
//     open question #54). Fuel is burned by spacecraft, not ventures, so
//     there is deliberately nothing here for step 2 to do on a venture's
//     behalf.
function stepProduction(state, _actions) {
  for (const guild of state.guilds) {
    for (const venture of guild.ventures || []) {
      if (!venture.productionRate) continue; // zero rate: nothing to do
      if (!guild.stockpiles) guild.stockpiles = {};

      // MINING: extract `productionRate` units of `resourceType` into the owner.
      if (venture.resourceType) {
        guild.stockpiles[venture.resourceType] =
          (guild.stockpiles[venture.resourceType] || 0) + venture.productionRate;
        venture.updatedAtTick = state.tick;
        continue;
      }

      // REFINING: run up to `productionRate` batches of the venture's recipe,
      // THROTTLED by the scarcest input the owner actually holds — consume EACH
      // input good, produce the output good, all in the owner's stockpiles.
      // Flooring affordable batches to the least-affordable input means no
      // stockpile can be driven negative (so invariant 3 holds without a special
      // case), and an under-supplied refinery simply runs at reduced throughput.
      if (venture.recipeId) {
        const recipe = getRecipe(venture.recipeId);
        if (!recipe) continue; // dangling recipeId: the occupancy invariant halts on it
        // batches = min(rate, floor(have / qty) for every input) — the scarcest input caps it.
        let batches = venture.productionRate;
        for (const inp of recipe.inputs) {
          const have = guild.stockpiles[inp.good] || 0;
          batches = Math.min(batches, Math.floor(have / inp.qty));
        }
        if (batches <= 0) continue; // some input is short this tick: no goods move
        for (const inp of recipe.inputs) {
          guild.stockpiles[inp.good] = (guild.stockpiles[inp.good] || 0) - batches * inp.qty;
        }
        guild.stockpiles[recipe.output.good] =
          (guild.stockpiles[recipe.output.good] || 0) + batches * recipe.output.qty;
        venture.updatedAtTick = state.tick;
      }
    }
  }
  return state;
}

// Step 2 — consumption. SEAM for spacecraft fuel burn against the shared
// allocation pool (docs/fuel-allocation-model.md) once Shipments/Vehicles
// exist. Ventures are NOT consumers here: production is renewable-powered
// and draws no Deuterium (§3 / open question #54).
function stepConsumption(state, _actions) {
  return state;
}

// Step 3 — price recompute. Publishes the posted price governing the NEXT
// action window (§8, decided #42). SEAM: no market/price fields exist on
// state yet — state.js only carries reserve.reserveLevel so far.
function stepPriceRecompute(state, _actions) {
  return state;
}

// Step 4 — scheduled events. Anything with a due-tick (contest-window
// closures now; the change calculator's interceptions later, §15.6).
// SEAM: no scheduled events exist yet — no territory/contests built.
function stepScheduledEvents(state, _actions) {
  return state;
}

// Step 5 — arrivals. Shipments that reach their destination this tick.
// SEAM: state.shipments is always empty until routes exist (Phase 1 Stage 3+).
function stepArrivals(state, _actions) {
  return state;
}

// Step 6 — baseline allocation. The flat per-guild income (guild.incomeRate).
// SEAM: needs a ruling on where the credits come from (minted vs. paid from
// the Syndicate ledger — see invariants.js's comment on expectedCreditTotal).
function stepBaselineAllocation(state, _actions) {
  return state;
}

// Step 7 — storyteller. Reads signals, may fire an event (design.md §9).
// SEAM: no storyteller exists yet (Phase 6).
function stepStoryteller(state, _actions) {
  return state;
}

// Step 8 — vote closures. Council votes whose window has closed resolve.
// SEAM: no Council exists yet (Phase 5).
function stepVoteClosures(state, _actions) {
  return state;
}

// The fixed order itself — the one piece of this file design.md actually
// requires to be correct FROM THE START, even while every step above is
// still a stub. Changing this array's order is changing the tick contract
// (§15.6); it is exported below so a test can pin the order down directly.
const STEPS = [
  stepProduction,
  stepConsumption,
  stepPriceRecompute,
  stepScheduledEvents,
  stepArrivals,
  stepBaselineAllocation,
  stepStoryteller,
  stepVoteClosures,
];

// tick(state, actions) — pure. Returns a NEW state; never mutates `state`.
// `actions` isn't consumed by anything yet (every step ignores it) — the
// parameter is here because the eventual step functions need it, and
// actions.js (validate-as-they-arrive intake) is Stage 2's next piece.
function tick(state, actions = []) {
  if (!state) throw new Error('tick: state is required');
  if (!Array.isArray(actions)) throw new Error('tick: actions must be an array');

  let next = cloneState(state);
  for (const step of STEPS) {
    next = step(next, actions);
  }
  next.tick = state.tick + 1;

  // Derive pass, NOT a §15.6 step: refresh the galactic-supply cache from the
  // state the eight steps just produced. Kept out of the STEPS array on purpose
  // — it computes nothing new about the game, it only re-totals what already
  // happened, and invariants.js asserts it matches. (The eight-step order is a
  // contract; this derivation is bookkeeping that runs after it.)
  next.galacticSupply = computeGalacticSupply(next);

  return next;
}

module.exports = { tick, STEPS };
