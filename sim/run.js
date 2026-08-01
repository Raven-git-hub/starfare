'use strict';

// run.js -- the driver: advance(state, actions), one full turn of the galaxy.
//
// tick(), intake() and assertInvariants() each do one job and are each tested
// on their own -- but NOTHING composed them into a single "advance the world
// one turn" step. tick() even took an `actions` argument and ignored it. This
// is that missing spine. One turn = three phases in a fixed order:
//
//   1. intake  -- apply the moves submitted for this window, each validated
//                 against state-as-it-stands (first-valid-wins, design.md
//                 §15.6). Moves execute against the price the PREVIOUS tick
//                 posted (§8 semantic #1), which is why intake runs BEFORE the
//                 economy re-posts inside the tick.
//   2. tick    -- advance the eight §15.6 economy steps; stamp the new tick.
//   3. assert  -- run the invariant tripwires on the result and HALT LOUDLY on
//                 any violation (invariants 1/2/3). This is what makes
//                 "invariants asserted every tick" a property of the RUNNING
//                 loop, not only of the test suite.
//
// Sandbox note (design.md §15.7): the real server drains actions CONTINUOUSLY
// as requests arrive, not once per tick. Draining the whole window in one pass
// here is a deliberate single-process Phase-1 simplification -- the
// validate-in-order, first-valid-wins DISCIPLINE is identical; only the timing
// of the drain differs. It is NOT the rejected "batch private copies, merge at
// the tick boundary" model: there is one shared state and each move is validated
// against it as it stands.
//
// advance() is pure: intake and tick both return new state, so `state` is never
// mutated.

const { intake } = require('./actions.js');
const { tick } = require('./tick.js');
const { assertInvariants } = require('./invariants.js');

// advance(state, actions) -> { state, results }
//   state:   the galaxy after this turn (a new object; input untouched)
//   results: intake's per-action verdicts, in order (what was accepted/rejected)
function advance(state, actions = []) {
  if (!state) throw new Error('advance: state is required');
  if (!Array.isArray(actions)) throw new Error('advance: actions must be an array');

  // 1. this window's moves, applied against state-as-it-stands.
  const { state: afterActions, results } = intake(state, actions);

  // 2. advance the economy one tick (increments the tick counter).
  const next = tick(afterActions);

  // 3. trip the wire -- throws loudly with the tick number on any violation.
  assertInvariants(next, next.tick);

  return { state: next, results };
}

module.exports = { advance };
