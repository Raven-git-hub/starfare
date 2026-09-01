'use strict';

const { computeGalacticSupply } = require('../supply.js');
const { REFERENCE_FUEL_PRICE } = require('../fuel.js');

// A minimal, balanced synthetic state used only by the harness's own tests.
// It is NOT the game's real starting scenario (that arrives with the walking
// skeleton, built against the decided tuning numbers). Its only job is to be a
// state that PASSES every invariant, so each test can break exactly one thing
// and prove the tripwire fires.
//
// Balance chosen so the two conservation laws hold:
//   Fuel : hoards (10 + 0) + reserve 30 + in-transit 0 = 40
//          produced 40 − consumed 0                     = 40   ✓
//   Credit: guild credits (1000 + 500) + ledger (−1500) = 0
//           expectedCreditTotal                          = 0   ✓
//   (The Syndicate ledger sits at −1500 because it funded the guilds' 1500 of
//    starting credits — the closed-system reading of invariant 2.)
function goodState() {
  const state = {
    guilds: [
      { id: 'g1', credits: 1000, fuelHoard: 10, influence: 5, stockpiles: {} },
      { id: 'g2', credits: 500, fuelHoard: 0, influence: 5, stockpiles: {} },
    ],
    // The fuel price is REAL state (slice 5b-i), and this fixture is built by hand
    // rather than through `createReserve`, so it carries the price explicitly — at the
    // reference, which is where a galaxy opens. Named, never the literal 10: if the
    // reference ever retunes, the fixture follows it instead of quietly going stale.
    reserve: { reserveLevel: 30, fuelPrice: REFERENCE_FUEL_PRICE },
    syndicate: { ledger: -1500 },
    shipments: [],
    audit: { totalProduced: 40, totalConsumed: 0, expectedCreditTotal: 0 },
  };
  // A valid state carries the derived totals cache; compute it so the fixture
  // passes the galactic-supply-consistency invariant (a test that breaks one
  // thing can then break exactly that, not this).
  state.galacticSupply = computeGalacticSupply(state);
  return state;
}

// Deep clone so a test can mutate freely without touching the next test.
function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

module.exports = { goodState, clone };
