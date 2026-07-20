'use strict';

// tick.js — the pure economy step. This is Stage 2's SCAFFOLD cut: the fixed
// eight-step order from design.md §15.6, as eight named functions, with NO
// game logic yet beyond the tick counter. Production, consumption, pricing,
// etc. are real modules that don't exist yet (economy.js, territory.js,
// bots.js — see sim/README.md's planned layout); wiring them in is later
// work, one module at a time (working practice #3), not invented here.
//
// What IS real about this file, even before those modules land:
//   - the ORDER is fixed and correct per §15.6, so invariant 9 (deterministic
//     tick order) has something true to hold onto as soon as steps start
//     doing something
//   - tick() is pure: it never mutates its `state` argument, always returns
//     a new state object
//   - no DOM access anywhere (the hard rule in sim/README.md)
//
// Each step function takes (state, actions) and returns a state. Every step
// below is `identity` — an explicit NAMED no-op — so the seam for each
// future module already sits in the right place, in the right order,
// instead of being invented ad hoc whenever that module lands.

// Deep-clones state so tick() can never accidentally mutate its input.
// structuredClone is a plain JS global (Node 17+), not a DOM API.
function cloneState(state) {
  return structuredClone(state);
}

// Step 1 — production. Ventures turn inputs into outputStockpile.
// SEAM: needs economy.js's production rules. No-op for now.
function stepProduction(state, _actions) {
  return state;
}

// Step 2 — consumption / energy draw. Ventures draw from the fuel pool.
// SEAM: needs economy.js + the fuel allocation model (docs/fuel-allocation-model.md).
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
  return next;
}

module.exports = { tick, STEPS };
