'use strict';

// asset-recipes.js — the Tier-4 ASSET BILL catalog + the build-yard constants
// (docs/asset-recipes.md "Tier-4 asset bills (3→4 recipes) — FINAL"; docs/build-yard.md §1).
// A Tier-4 recipe is NOT a `recipes.js` row: its output is an ASSET, not a stockpile good, so
// it never runs through the 2→3 resolver. This file is the machine-readable form of the doc's
// nine FINAL bills — `assetKind -> { module: qty }` — in three catalogs:
//
//   - ASSET_BILLS        — miner, factory (the two ground assets).
//   - VEHICLE_BILLS      — the four guild transports.
//   - INSTALLATION_BILLS — outpost, deep scan array, toll gate. The outpost and the deep scan
//                          array are buildable and sellable, and finish as a KIT; the toll gate is
//                          still data only (see INSTALLATION_BILLS below for why).
//
// The Droid row of the doc has no bill yet (design-ahead, no entity), so it is not here.
//
// The buildable bills (ALL_BILLS) are read by the Dockyard's reserve-and-wait build step
// (sim/tick.js), the commission intake (sim/actions.js) and the Syndicate purchase price.

const { MINER, FACTORY } = require('./assets.js');
const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT, BUILDABLE_VEHICLE_KINDS,
} = require('./vehicles.js');
const { isTier3Good, kitGoodFor } = require('./resources.js');
const { quotedPrice } = require('./price-ring.js');

// The two ground-asset bills — quantities lifted VERBATIM from docs/asset-recipes.md's FINAL
// table (RULED 27-09-26, all `[FIRST-CUT]`), in the doc's own order. Each entry is
// `module -> integer count` (§15.2: integer goods). Frozen so no reader can mutate the
// catalog at runtime. A test checks every bill in this file against the doc's table.
const MINER_BILL = Object.freeze({
  extraction_head: 1,
  chassis: 2,
  control_module: 1,
  cargo_handling_system: 1,
  defence_system: 1,
  photovoltaic_array: 2,
  cargo_module: 6,
  power_cells: 6,
});

const FACTORY_BILL = Object.freeze({
  fabrication_line: 1,
  chassis: 2,
  control_module: 1,
  sensor_suite: 1,
  cargo_handling_system: 1,
  photovoltaic_array: 3,
  power_cells: 8,
});

// assetKind -> bill. Keyed by the SAME `MINER`/`FACTORY` constants sim/assets.js pins, so a
// bill and the asset entity it builds can never spell the kind two different ways.
const ASSET_BILLS = Object.freeze({
  [MINER]: MINER_BILL,
  [FACTORY]: FACTORY_BILL,
});

// The kinds a Dockyard can build as a GROUND asset — exactly the two with buildable entities.
// Kept exactly [miner, factory] (the combined build vocabulary is BUILDABLE_KINDS below).
const BUILDABLE_ASSET_KINDS = Object.freeze([MINER, FACTORY]);

// ── THE FOUR GUILD-TRANSPORT BILLS (2.2-foundation) ─────────────────────────────────────────
// A PARALLEL catalog to ASSET_BILLS, keyed by the vehicle class constants (sim/vehicles.js).
// Kept beside the ground-asset bills so the same `assertBillModulesAreTier3` tripwire covers
// them (run over the merged view below), and so a bought/built vehicle is priced and consumed
// through the SAME kind-general machinery a ground asset is. Ground-asset bills stay in
// ASSET_BILLS untouched; `GET /asset-recipes` serves the merged ALL_BILLS + BUILDABLE_KINDS.
//
// Quantities lifted VERBATIM from docs/asset-recipes.md's FINAL table, the four ship rows
// (RULED 27-09-26, all `[FIRST-CUT]`), in the doc's own order.
const LIGHT_TRANSPORT_BILL = Object.freeze({
  chassis: 1,
  control_module: 1,
  life_support_module: 1,
  small_reactor_engine: 1,
  fuel_tank: 2,
  power_cells: 2,
});

const MEDIUM_TRANSPORT_BILL = Object.freeze({
  medium_reactor_engine: 2,
  chassis: 2,
  control_module: 1,
  life_support_module: 1,
  sensor_suite: 1,
  reactor_housing: 2,
  fuel_tank: 6,
  power_cells: 6,
});

const HEAVY_TRANSPORT_BILL = Object.freeze({
  heavy_reactor_engine: 5,
  chassis: 14,
  life_support_module: 2,
  control_module: 2,
  defence_system: 2,
  hull_plating: 10,
  cargo_module: 10,
  fuel_tank: 10,
});

// Build-only: the Syndicate never sells a spycraft (SYNDICATE_SELLABLE_KINDS below).
const SPYCRAFT_BILL = Object.freeze({
  stealth_module: 1,
  control_module: 1,
  sensor_suite: 3,
  chassis: 2,
  life_support_module: 1,
  small_reactor_engine: 2,
  power_cells: 6,
});

// vehicleClass -> bill. Keyed by the SAME class constants sim/vehicles.js pins.
const VEHICLE_BILLS = Object.freeze({
  [LIGHT_TRANSPORT]: LIGHT_TRANSPORT_BILL,
  [MEDIUM_TRANSPORT]: MEDIUM_TRANSPORT_BILL,
  [HEAVY_TRANSPORT]: HEAVY_TRANSPORT_BILL,
  [SPYCRAFT]: SPYCRAFT_BILL,
});

// ── THE THREE INSTALLATION BILLS (RULED 27-09-26; two made buildable 15-10-26) ────────────────
// The doc's FINAL table rules a bill and an assembly time for the outpost, the deep scan array and
// the toll gate. All three are recorded here so the code carries all nine bills the doc does, and so
// the Tier-3 tripwire below covers them. Two of them now have a build path and one does not
// (docs/asset-purchase.md §"Installation kits", RULED 15-10-26):
//   - outpost, deep scan array — BUILDABLE (dockyard) and SELLABLE (Syndicate). What a finished
//                       build or delivery produces is not an entity of the bill kind but one idle
//                       KIT in the guild's inventory, which the existing load → ferry → deploy loop
//                       carries (KIT_KIND_FOR_BILL below is the translation);
//   - toll gate       — still DATA ONLY: it has no entity and no kit row in DEPLOYABLE_KITS
//                       (sim/resources.js), so making it buildable would invent its kit. `assetBill`
//                       returns null for it, the dockyard refuses it and the Syndicate cannot price it.
//
// The bill kind names are spelled ONCE, here. A queue entry or a Syndicate commission carries the
// BILL kind (`deep_scan_array`); the kit it finishes as carries the KIT kind (`deepScan`, the
// deploy-lane spelling in sim/resources.js). The two spellings were RULED a deliberate seam on 06-10-26
// (docs/exploration-model.md §5) rather than renamed, and they meet in exactly one place:
// KIT_KIND_FOR_BILL below.
const OUTPOST = 'outpost';
const DEEP_SCAN_ARRAY = 'deep_scan_array';
const TOLL_GATE = 'toll_gate';

const DEEP_SCAN_ARRAY_BILL = Object.freeze({
  deep_scan_mast: 2,
  sensor_suite: 4,
  control_module: 2,
  chassis: 2,
  comms_array: 3,
  power_cells: 6,
});

const TOLL_GATE_BILL = Object.freeze({
  interdiction_projector: 4,
  deep_scan_mast: 1,
  defence_system: 2,
  chassis: 2,
  comms_array: 4,
  power_cells: 8,
  hull_plating: 8,
});

// The Outpost is a depot (design.md §4): a big, plain station, so its large counts of ordinary
// parts are correct, not a typo (docs/asset-recipes.md).
const OUTPOST_BILL = Object.freeze({
  chassis: 20,
  cargo_handling_system: 20,
  control_module: 6,
  defence_system: 4,
  photovoltaic_array: 16,
  cargo_module: 200,
  hull_plating: 200,
  power_cells: 200,
});

// installationKind -> bill. Only the BUILDABLE installations are merged into ALL_BILLS (below).
const INSTALLATION_BILLS = Object.freeze({
  [DEEP_SCAN_ARRAY]: DEEP_SCAN_ARRAY_BILL,
  [TOLL_GATE]: TOLL_GATE_BILL,
  [OUTPOST]: OUTPOST_BILL,
});

// The installations a dockyard can build (and the Syndicate sell) — the deep scan array and the
// outpost, in the doc's table order. The toll gate is deliberately absent (see above).
const BUILDABLE_INSTALLATION_KINDS = Object.freeze([DEEP_SCAN_ARRAY, OUTPOST]);

// The merged view — every buildable/buyable kind's bill: ground assets, vehicles AND the buildable
// installations. `assetBill` reads this, so one lookup answers "the bill for this kind" for every
// family. The toll gate's bill is NOT in it: it has no build path yet.
const ALL_BILLS = Object.freeze({
  ...ASSET_BILLS,
  ...VEHICLE_BILLS,
  ...Object.fromEntries(BUILDABLE_INSTALLATION_KINDS.map((kind) => [kind, INSTALLATION_BILLS[kind]])),
});

// The combined kind vocabulary a dockyard can BUILD — ground assets, then vehicles, then the
// buildable installations. The build gate (commissionBuild, sim/actions.js), the build-queue
// invariant, and `GET /asset-recipes` read THIS, so anything here is buildable everywhere —
// spycraft INCLUDED (a guild builds it at its own dockyard).
const BUILDABLE_KINDS = Object.freeze([
  ...BUILDABLE_ASSET_KINDS, ...BUILDABLE_VEHICLE_KINDS, ...BUILDABLE_INSTALLATION_KINDS,
]);

// SYNDICATE_SELLABLE_KINDS — the kinds the Syndicate SELLS: sellable ⊂ buildable, diverging at
// spycraft (docs/asset-purchase.md §"What the Syndicate sells — sellable ⊂ buildable (RULED
// 22-09-26)"). It is `BUILDABLE_KINDS` MINUS `spycraft` — the two ground assets, the three
// CARGO transports (light / medium / heavy), and the two installation kits (deep scan array,
// outpost; RULED 15-10-26, docs/asset-purchase.md §"Installation kits"): seven kinds. Spycraft
// is still the ONLY guild-build-only kind: a guild makes it in the dark at its own dockyard, the
// Syndicate never sells it. Spelled as an explicit list (not a filter of BUILDABLE_KINDS) so it
// reads as the deliberate sell catalog it is — the buy gate (buyAssetFromSyndicate) and the
// snapshot's purchase quote read THIS, not BUILDABLE_KINDS, so a spycraft buy is refused loudly.
const SYNDICATE_SELLABLE_KINDS = Object.freeze([
  ...BUILDABLE_ASSET_KINDS, LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT,
  DEEP_SCAN_ARRAY, OUTPOST,
]);

// KIT_KIND_FOR_BILL — THE BRIDGE between the two spellings of an installation (docs/asset-purchase.md
// §"Installation kits", RULED 15-10-26; closes the 06-10-26 seam, docs/exploration-model.md §5). A
// dockyard queue entry and a Syndicate commission carry the BILL kind; when one finishes, the mint
// (sim/tick.js mintFinishedKind) looks the bill kind up HERE and mints one idle KIT of the kit kind.
// This is the ONLY place the two spellings meet — nothing else translates one into the other. The
// outpost happens to spell both the same way; it still needs its row, or a finished outpost would be
// minted as a plain asset off the miner/factory numbering instead of the kit serial. The toll gate gets
// its row (`toll_gate` → `tollGate`) in the slice that gives it a kit.
const KIT_KIND_FOR_BILL = Object.freeze({
  [DEEP_SCAN_ARRAY]: 'deepScan',
  [OUTPOST]: 'outpost',
});

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

// Run it now, at require time, over EVERY catalog (ground assets, the four ship bills AND the
// three data-only installation bills), so a drift in ANY bill fails the whole suite loudly the
// instant this file is required.
assertBillModulesAreTier3(ALL_BILLS);
assertBillModulesAreTier3(INSTALLATION_BILLS);

// THE BRIDGE'S TRIPWIRE (the same discipline as assertBillModulesAreTier3 above). A bad row would
// otherwise mint something the rest of the engine cannot read, and only when a 9-day build finished.
// Three rules, each one a way the bridge could drift:
//   1. every VALUE is a real kit kind (a row in sim/resources.js DEPLOYABLE_KITS), so the minted kit
//      can be loaded, ferried and deployed like a granted one;
//   2. every KEY is a buildable kind, so the row can actually be reached by a finished build;
//   3. every buildable INSTALLATION has a row, so none can finish as a plain asset of its bill kind
//      (which no asset rule knows). This is the rule that stops the toll gate being made buildable
//      before it has a kit.
// Exported AND run at module load below, so the real map is checked the instant this file is required
// and a test can hand it a deliberately bad map to prove the guard bites.
function assertKitBridge(bridge, buildableKinds) {
  for (const [billKind, kitKind] of Object.entries(bridge)) {
    if (kitGoodFor(kitKind) === null) {
      throw new Error(
        `asset-recipes: KIT_KIND_FOR_BILL maps ${JSON.stringify(billKind)} to ${JSON.stringify(kitKind)}, `
        + 'which is not a kit kind in sim/resources.js DEPLOYABLE_KITS',
      );
    }
    if (!buildableKinds.includes(billKind)) {
      throw new Error(
        `asset-recipes: KIT_KIND_FOR_BILL has a row for ${JSON.stringify(billKind)}, which is not a buildable kind`,
      );
    }
  }
  for (const kind of buildableKinds) {
    if (INSTALLATION_BILLS[kind] && !Object.prototype.hasOwnProperty.call(bridge, kind)) {
      throw new Error(
        `asset-recipes: ${JSON.stringify(kind)} is a buildable installation with no KIT_KIND_FOR_BILL row — `
        + 'a finished build would have no kit to mint',
      );
    }
  }
}

assertKitBridge(KIT_KIND_FOR_BILL, BUILDABLE_KINDS);

// assetBill(kind) -> the frozen bill for a buildable kind (ground asset, vehicle class or buildable
// installation), or null. null (not a throw) so a caller can ASK whether a kind is buildable and
// refuse loudly itself (sim/actions.js), the same shape `getRecipe` has.
function assetBill(kind) {
  return ALL_BILLS[kind] || null;
}

// kitKindForBill(billKind) -> the kit kind a finished build of `billKind` mints ('deep_scan_array' ->
// 'deepScan'), or null for a kind that does not finish as a kit (a miner, a transport). null (not a
// throw), the same shape as `kitGoodFor`, so the mint can ASK.
function kitKindForBill(billKind) {
  return Object.prototype.hasOwnProperty.call(KIT_KIND_FOR_BILL, billKind) ? KIT_KIND_FOR_BILL[billKind] : null;
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
  // The four guild transports (docs/phase-1-tuning.md §"Guild transports", 18-09-26). At
  // 1,440 ticks/day: light 6 h, medium 16 h, heavy and spy 1 week each. All `[FIRST-CUT]`.
  [LIGHT_TRANSPORT]: 360,     // 6 hours
  [MEDIUM_TRANSPORT]: 960,    // 16 hours
  [HEAVY_TRANSPORT]: 10080,   // 1 week (7 × 1,440)
  [SPYCRAFT]: 10080,          // 1 week
  // The three installations' assembly times (docs/asset-recipes.md FINAL table; docs/
  // tier3-timed-production.md, RULED 27-09-26). All `[FIRST-CUT]`. The outpost's and the deep
  // scan array's are LIVE (both buildable since 15-10-26); the toll gate's stays INERT, because
  // the toll gate is not buildable (INSTALLATION_BILLS above), so no build counts it down.
  [OUTPOST]: 12960,           // 9 days (9 × 1,440)
  [DEEP_SCAN_ARRAY]: 10080,   // 7 days (7 × 1,440)
  [TOLL_GATE]: 8640,          // 6 days (6 × 1,440) — inert
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

// VEHICLE_BUY_BASELINE — the per-class minimum a bought guild transport costs (2.2-foundation),
// REPLACING the flat 12M floor PER CLASS (docs/phase-1-tuning.md §"Guild transports": a per-class
// baseline, not the flat floor). All `[FIRST-CUT]`. At today's parts scale the baseline binds for
// every class (parts are near-nothing), exactly as the 12M floor binds for miner/factory, so the
// `partsCost × 0.8` branch stays live-but-dormant for later tuning. A ground asset has no entry
// here and falls back to ASSET_PURCHASE_FLOOR.
const VEHICLE_BUY_BASELINE = Object.freeze({
  [LIGHT_TRANSPORT]: 5_000_000,
  [MEDIUM_TRANSPORT]: 15_000_000,
  [HEAVY_TRANSPORT]: 200_000_000,
  [SPYCRAFT]: 100_000_000,
});

// INSTALLATION_KIT_BUY_BASELINE — the per-kind minimum a bought installation KIT costs, in the same
// role VEHICLE_BUY_BASELINE plays for a transport: the `baseline` term of the price, and the cancel
// refund. Both `[FIRST-CUT]`, RULED 15-10-26 — given by the human, not derived from the parts
// (docs/phase-1-tuning.md §"Installation kits — build and buy"; docs/asset-purchase.md §"Installation
// kits"). At base prices both bind (the parts × 0.8 come to well under each).
const INSTALLATION_KIT_BUY_BASELINE = Object.freeze({
  [DEEP_SCAN_ARRAY]: 100_000_000, // [FIRST-CUT] docs/phase-1-tuning.md
  [OUTPOST]: 150_000_000,         // [FIRST-CUT] docs/phase-1-tuning.md
});

// SYNDICATE_QUEUE_MAX — the most Syndicate commissions ONE GUILD may hold on `state.syndicateBuilds`
// at once, counting the WHOLE queue (the one building + those waiting). An 11th buy is refused
// loudly at intake (docs/asset-purchase.md §"The queue cap", RULED 26-09-26; the value is
// `[FIRST-CUT]` in docs/phase-1-tuning.md). Separate from the dockyard's per-yard MAX_QUEUE (5).
const SYNDICATE_QUEUE_MAX = 10;

// assetPurchaseBaseline(kind) -> the kind's BASELINE credit price: its per-class
// VEHICLE_BUY_BASELINE for a transport, else its INSTALLATION_KIT_BUY_BASELINE for an installation
// kit, else the flat ASSET_PURCHASE_FLOOR (miner/factory). The ONE definition of "baseline". Two
// things read it and must never disagree: the purchase price is `max(baseline, …)` of it
// (priceAssetForPurchase below), and a cancelled commission refunds exactly it
// (docs/asset-purchase.md §"Cancelling a queued commission").
function assetPurchaseBaseline(kind) {
  return VEHICLE_BUY_BASELINE[kind] ?? INSTALLATION_KIT_BUY_BASELINE[kind] ?? ASSET_PURCHASE_FLOOR;
}

// nextSyndicateCommissionId(guild) -> the next per-GUILD Syndicate commission id: one above the
// guild's stored `syndicateCommissionSerial` counter (absent/0 -> 1). The commission mirror of
// `nextVehicleSerial`, and for the same reason (design.md §15.4 "Ids never repeat"): a commission
// can be CANCELLED or ship out of the queue, so its id cannot be re-derived from the live entries —
// a `max(existing)+1` would re-hand a spent number. The CALLER bumps
// `guild.syndicateCommissionSerial` to this value at buy (this stays a pure read); it never
// decrements, so a cancel can never make a later commission's id shift or repeat.
function nextSyndicateCommissionId(guild) {
  return (guild.syndicateCommissionSerial || 0) + 1;
}

// priceAssetForPurchase(state, assetKind, issueTick) -> the integer credit price of buying
// `assetKind` from the Syndicate, or null when it cannot be priced.
//
//   partsCost = Σ over the kind's bill of ( module qty × that module's quoted price )
//   price     = max( baseline , round( partsCost × ASSET_PURCHASE_REDUCTION ) )
//
// where `baseline` is assetPurchaseBaseline(kind) — the per-class VEHICLE_BUY_BASELINE for a
// vehicle kind, the INSTALLATION_KIT_BUY_BASELINE for an installation kit, else the flat
// ASSET_PURCHASE_FLOOR (miner/factory keep the 12M floor). Same formula, one baseline per kind.
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
  return Math.max(assetPurchaseBaseline(assetKind), Math.round(partsCost * ASSET_PURCHASE_REDUCTION));
}

module.exports = {
  ASSET_BILLS,
  VEHICLE_BILLS,
  INSTALLATION_BILLS,
  OUTPOST,
  DEEP_SCAN_ARRAY,
  TOLL_GATE,
  ALL_BILLS,
  BUILDABLE_ASSET_KINDS,
  BUILDABLE_INSTALLATION_KINDS,
  BUILDABLE_KINDS,
  SYNDICATE_SELLABLE_KINDS,
  KIT_KIND_FOR_BILL,
  assetBill,
  kitKindForBill,
  assertBillModulesAreTier3,
  assertKitBridge,
  MAX_QUEUE,
  BUILD_TICKS,
  ASSET_PURCHASE_FLOOR,
  ASSET_PURCHASE_REDUCTION,
  VEHICLE_BUY_BASELINE,
  INSTALLATION_KIT_BUY_BASELINE,
  SYNDICATE_QUEUE_MAX,
  assetPurchaseBaseline,
  nextSyndicateCommissionId,
  priceAssetForPurchase,
};
