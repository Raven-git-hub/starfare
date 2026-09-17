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
const { quotedPrice } = require('./price-ring.js');

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
// 1,440 ticks/day (docs/cycle-and-calendar.md), a miner is 12 hours and a factory 16 hours. Frozen
// and keyed by the same MINER/FACTORY constants as the bills.
const BUILD_TICKS = Object.freeze({
  [MINER]: 720,    // 12 hours × 60 ticks/hour
  [FACTORY]: 960,  // 16 hours × 60 ticks/hour
});

// ── BUYING A TIER-4 ASSET FROM THE SYNDICATE (2.1d) ─────────────────────────────────────────
// `[FIRST-CUT]`, RULED 14-09-26 (docs/asset-purchase.md; docs/phase-1-tuning.md "buying a
// Tier-4 asset from the Syndicate"). AS-BUILT (engine slice 1): the two constants + the price
// function live here ONCE beside the dockyard build-core numbers and are imported, never
// inlined (working practice #5). A Syndicate purchase is the mirror of a dockyard build — pay
// CREDITS (+ fuel) instead of parts — priced off the SAME posted prices the economy already
// uses (the quote-lock ring), then built over the SAME BUILD_TICKS a dockyard counts down.

// ASSET_PURCHASE_FLOOR — the minimum a bought asset costs. At today's economy scale a
// miner/factory's parts are worth only ~100–2,800 credits, far below this, so the floor binds
// and a purchase is effectively a flat 12M (docs/asset-purchase.md "Price"). Retune in play.
const ASSET_PURCHASE_FLOOR = 12_000_000;

// ASSET_PURCHASE_REDUCTION — the multiplier on live parts cost (a 20% Syndicate discount) that
// governs the price ONCE `partsCost × 0.8` exceeds the floor. Inert while the floor dominates;
// kept LIVE in the formula (not dead code) so the model is tuned by editing this number, never
// the code (docs/asset-purchase.md "Price").
const ASSET_PURCHASE_REDUCTION = 0.8;

// priceAssetForPurchase(state, assetKind, issueTick) -> the integer credit price of buying
// `assetKind` from the Syndicate, or null when it cannot be priced.
//
//   partsCost = Σ over the kind's bill of ( module qty × that module's quoted price )
//   price     = max( ASSET_PURCHASE_FLOOR , round( partsCost × ASSET_PURCHASE_REDUCTION ) )
//
// Rounded ONCE on the whole order (#43), exactly as a goods buy rounds `qty × price`. The
// module price is the SAME `quotedPrice` the goods buy uses (§8.1 quote-lock): today's posted
// value when `issueTick` is the current tick, a past tick's from the ring otherwise — so the
// price cannot shift between opening the confirm and confirming.
//
// RETURNS null (the caller then refuses) in two cases, each a deliberate refusal rather than a
// guessed price: an assetKind with no bill (not buildable), or ANY module with no quoted price
// at `issueTick` (the ring guard — the quote is too old/future to price that part). Mirrors the
// goods-buy guard exactly: never price off a missing ring.
function priceAssetForPurchase(state, assetKind, issueTick) {
  const bill = assetBill(assetKind);
  if (!bill) return null;
  let partsCost = 0;
  for (const [module, qty] of Object.entries(bill)) {
    const price = quotedPrice(state, module, issueTick);
    if (price == null) return null; // ring guard — refuse rather than price off a missing part
    partsCost += qty * price;
  }
  return Math.max(ASSET_PURCHASE_FLOOR, Math.round(partsCost * ASSET_PURCHASE_REDUCTION));
}

module.exports = {
  ASSET_BILLS,
  BUILDABLE_ASSET_KINDS,
  assetBill,
  assertBillModulesAreTier3,
  MAX_QUEUE,
  BUILD_TICKS,
  ASSET_PURCHASE_FLOOR,
  ASSET_PURCHASE_REDUCTION,
  priceAssetForPurchase,
};
