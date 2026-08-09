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
const { addStock } = require('./stock.js');
const { resolveProduction } = require('./production.js');

// Deep-clones state so tick() can never accidentally mutate its input.
// structuredClone is a plain JS global (Node 17+), not a DOM API.
function cloneState(state) {
  return structuredClone(state);
}

// Step 1 — production, routed through §5's THREE GATES from the System Production
// Profile, now in the RATE-BASED model (§5 "Engine rewrite", 10-08-26). The gate
// ARITHMETIC lives in ONE pure function, `resolveProduction(guild, systemId)`
// (sim/production.js) — see §5 "the resolved numbers come from the engine, never
// the browser". This step is the APPLY half: it asks the resolver what production
// does this tick, then MOVES the goods to match. The read-only `previewProduction`
// selector (also sim/production.js, surfaced through the snapshot) asks the SAME
// resolver, so the displayed numbers and the moved numbers can never drift.
//
// Per guild, per system (deterministic order), the resolver's report says:
//   - `mines`: each producing mine's fresh deposit (good + amount).
//   - `lines`: per consuming line per input, the balancer split `consumed`/`spill`
//     of its Gate-3 allocation (consumed + spill = alloc). Only `consumed` leaves
//     the pool; the spill was never removed, so it needs no return trip.
//   - `refineries`: each line's continuous `rate`, its whole-unit `minted` output,
//     and its NEW `accumulator` (the fractional carry to write back on the venture).
// Applying it is pure bookkeeping: deposit each mine's fresh, subtract each line's
// `consumed`, add each refinery's `minted`, and advance `Venture.outputAccumulator`.
// Non-negativity (invariant 3) holds BY CONSTRUCTION: the resolver bounds each
// good's total allocation by `supplied + drawable` where `supplied ≤ fresh` and
// `drawable = balance − reserveFloor`, so the pool ends at ≥ the reserve floor
// (≥ 0) — the stockpile drawdown can reach the floor and no further.
//
// `Venture.updatedAtTick` records when a venture moved goods (§15.2). Every
// deposit/draw lands in the venture's OWN system pool (ruling B1, §15.2):
// `systemId` is the denormalised site→system copy stamped at establish.
//
// Deliberately NOT yet implemented, left for later slices (all inert in the
// resolver too): the Syndicate fork delivers nothing (`syndicateCommitment` is 0
// for every venture — slice 3); per-venture `inputStockpiles` buffers and
// crediting guild.lifetimeProduced (§13); ventures draw no fuel (§3 / #54).
//
// DETERMINISM (invariant 9): the iteration order is fixed here — guilds in array
// order, systems by sorted systemId (the resolver fixes goods/consumer order
// internally). No plain-object key order feeds any number.
function stepProduction(state, _actions) {
  for (const guild of state.guilds) {
    const ventures = guild.ventures || [];
    // Systems this guild produces in, in a deterministic order. A synthetic test
    // venture with no seat keeps its `systemId` (null) as its pool key — exactly as
    // before, when a null systemId deposited into a null-keyed pool — so we do NOT
    // drop it. Sorted by String coercion so null/undefined order deterministically
    // ("null"/"undefined") without relying on sort's undefined-to-end quirk.
    const systemIds = [...new Set(ventures.map((v) => v.systemId))]
      .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    for (const sys of systemIds) {
      applyProduction(state, guild, sys);
    }
  }
  return state;
}

// One (guild, system): resolve production, then MOVE the goods to match the
// report. This is the ONLY place addStock is called for production. Mutates the
// guild's system pool (and each refinery's outputAccumulator) in place — tick()
// already cloned state, so this never touches the caller's input. The resolver
// reads the pool balance + accumulators (start-of-step) and mutates nothing.
function applyProduction(state, guild, systemId) {
  const report = resolveProduction(guild, systemId);
  const byId = new Map((guild.ventures || []).map((v) => [v.id, v]));

  // Deposit each mine's fresh output into the pool; stamp the mine's tick.
  for (const m of report.mines) {
    addStock(guild, systemId, m.good, m.amount);
    byId.get(m.ventureId).updatedAtTick = state.tick;
  }

  // Subtract each consuming line's `consumed` from the pool. The balancer's spill
  // (alloc − consumed) was never removed, so it stays put — nothing to return.
  for (const line of report.lines) {
    if (line.consumed > 0) addStock(guild, systemId, line.good, -line.consumed);
  }

  // Mint each refinery's whole-unit output and advance its fractional carry. A
  // starved line (rate 0) moves nothing and keeps its carry — NOT stamped, matching
  // the old `if (batches <= 0) continue`.
  for (const r of report.refineries) {
    if (r.rate <= 0) continue;
    const v = byId.get(r.ventureId);
    v.outputAccumulator = r.accumulator;
    if (r.minted > 0) {
      const recipe = getRecipe(v.recipeId);
      addStock(guild, systemId, recipe.output.good, r.minted);
    }
    v.updatedAtTick = state.tick;
  }
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
