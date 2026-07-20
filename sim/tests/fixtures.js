'use strict';

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
  return {
    guilds: [
      { id: 'g1', credits: 1000, fuelHoard: 10, influence: 5 },
      { id: 'g2', credits: 500, fuelHoard: 0, influence: 5 },
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -1500 },
    shipments: [],
    audit: { totalProduced: 40, totalConsumed: 0, expectedCreditTotal: 0 },
  };
}

// Deep clone so a test can mutate freely without touching the next test.
function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

module.exports = { goodState, clone };
