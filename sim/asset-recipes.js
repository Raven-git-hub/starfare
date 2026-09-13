'use strict';

// asset-recipes.js — the Tier-4 ASSET BILL catalog + the build-yard constants
// (docs/asset-recipes.md "Tier-4 asset bills"; docs/build-yard.md §1). A Tier-4 recipe is
// NOT a `recipes.js` row: its output is an ASSET, not a stockpile good, so it never runs
// through the 2→3 resolver. This file is the machine-readable form of the doc's two
// `buildable` bills — `assetKind -> { module: qty }` — read only by the Dockyard's
// reserve-and-wait build step (sim/tick.js) and the commission intake (sim/actions.js).
//
// SCOPE (build-yard.md §7 slice 1): only the two rows with buildable ENTITIES — miner and
// factory. The ship / outpost / scanner / toll-gate / droid bills stay in the doc, unbuilt;
// encoding them here would be inventing a build path for an asset kind that has no entity.

const { MINER, FACTORY } = require('./assets.js');
const { isTier3Good } = require('./resources.js');

// The two buildable bills — quantities lifted VERBATIM from docs/asset-recipes.md's two
// `buildable` rows (all `[FIRST-CUT]`). Each entry is `module -> integer count` (§15.2:
// integer goods). Frozen so no reader can mutate the catalog at runtime.
const MINER_BILL = Object.freeze({
  chassis: 2,
  reactor_housing: 1,
  photovoltaic_array: 1,
  power_cells: 1,
  control_module: 1,
  extraction_head: 1,
  cargo_module: 1,
  cargo_handling_system: 1,
  defence_system: 1,
});

const FACTORY_BILL = Object.freeze({
  chassis: 3,
  reactor_housing: 1,
  photovoltaic_array: 2,
  power_cells: 2,
  control_module: 1,
  fabrication_line: 2,
  sensor_suite: 1,
  cargo_handling_system: 1,
  defence_system: 1,
});

// assetKind -> bill. Keyed by the SAME `MINER`/`FACTORY` constants sim/assets.js pins, so a
// bill and the asset entity it builds can never spell the kind two different ways.
const ASSET_BILLS = Object.freeze({
  [MINER]: MINER_BILL,
  [FACTORY]: FACTORY_BILL,
});

// The kinds a Dockyard can build this slice — exactly the two with buildable entities.
const BUILDABLE_ASSET_KINDS = Object.freeze([MINER, FACTORY]);

// THE LOAD-BEARING MECHANICAL TRIPWIRE (working practice #4). Every module named in every
// bill MUST be a real Tier-3 stockpile good (resources.js). A typo that drifts a bill from
// asset-recipes.md would otherwise build an asset off a module that does not exist, silently
// consuming nothing — so this HALTS THE PROCESS rather than build from a bad bill. It is a
// named, exported function AND self-invoked at module load below: the real catalog is checked
// the instant this file is required (a drift fails the whole suite loudly), and a test can call
// it with a deliberately-bad bill to prove the guard bites.
function assertBillModulesAreTier3(bills) {
  for (const [kind, bill] of Object.entries(bills)) {
    for (const module of Object.keys(bill)) {
      if (!isTier3Good(module)) {
        throw new Error(
          `asset-recipes: bill for ${JSON.stringify(kind)} names ${JSON.stringify(module)}, `
          + 'which is not a Tier-3 module good (resources.js) — a bill has drifted from docs/asset-recipes.md',
        );
      }
    }
  }
}

// Run it now, at require time, over the frozen catalog above.
assertBillModulesAreTier3(ASSET_BILLS);

// assetBill(kind) -> the frozen bill for a buildable kind, or null. null (not a throw) so a
// caller can ASK whether a kind is buildable and refuse loudly itself (sim/actions.js), the
// same shape `getRecipe` has.
function assetBill(kind) {
  return ASSET_BILLS[kind] || null;
}

// ── CONSTANTS — `[FIRST-CUT]`, RULED this design session (13-09-26) ─────────────────────────
// Defined here ONCE and imported; never inlined at a call site (working practice #5). Also
// recorded in docs/phase-1-tuning.md in the SAME commit (doc-and-code move together, rule 2).

// The commission queue cap: a 6th commission on a full queue is refused loudly (build-yard.md §3).
const MAX_QUEUE = 5;

// Ticks a build counts down once its bill is consumed, per asset kind (build-yard.md §3). At
// 1,440 ticks/day (docs/cycle-and-calendar.md), a miner is 3 days and a factory 5 days. Frozen
// and keyed by the same MINER/FACTORY constants as the bills.
const BUILD_TICKS = Object.freeze({
  [MINER]: 4320,   // 3 days × 1,440 ticks/day
  [FACTORY]: 7200, // 5 days × 1,440 ticks/day
});

module.exports = {
  ASSET_BILLS,
  BUILDABLE_ASSET_KINDS,
  assetBill,
  assertBillModulesAreTier3,
  MAX_QUEUE,
  BUILD_TICKS,
};
