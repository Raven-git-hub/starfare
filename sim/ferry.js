'use strict';

// ferry.js — THE CROSS-SYSTEM ASSET FERRY (design.md §4, "Cross-system use requires a redeploy … a future redeploy
// ferries one on a heavy Vehicle whose manifest carries the asset and locks out its hold"), built by losing ground,
// engine PR 2 — THE SALVAGE RUN (design.md §19 #67, SETTLED 19-10-26; docs/territory-model.md §5).
//
// A ground machine (a miner or a factory) cannot move itself; a heavy can carry one. So the ferry is three steps,
// and only the first and the last are new:
//   1. LOAD (`loadAsset`, sim/actions.js) — a heavy berthed in the machine's own system takes it aboard. The heavy
//      NAMES the machine in `carryingAssetId`; the machine stays in `guild.assets`, keeping its id and its
//      `systemId` (the system it was loaded from). Its state is now the derived third one, IN TRANSIT
//      (sim/assets.js `carriedAssetIds`) — neither idle nor deployed.
//   2. FLY — an ordinary dispatch, untouched. The transport layer flies a laden heavy exactly as an empty one: a
//      craft burns its OWN `fuelCostToRun` per hex whatever it carries (transport-model.md §4 / §5), the same burn a
//      heavy hauling a kit pays. So the ferry adds no number.
//   3. UNLOAD (`unloadAsset`) — the heavy, berthed at a system its guild HOLDS, lets the machine go. Its `systemId`
//      becomes that system — the ONE place the engine writes an asset's `systemId` after creation — and it is an
//      ordinary idle asset there.
//
// SALVAGE-ONLY, for now. The mechanism is general, but `loadAsset` takes only a STRANDED machine (one an eviction
// left behind, sim/eviction.js), so the one ferry a player can run is the salvage run. Redeploying a healthy idle
// machine between held systems is a later slice that drops that one gate.
//
// THE HOLD IS LOCKED while a machine is aboard. A machine fills a whole heavy hold (ASSET_CARGO_VOLUME =
// HEAVY_HOLD, sim/fuel.js — the ruled hold-cost of a Tier-4 asset), so nothing else fits beside it: no goods, no
// kit, no second machine. Every action that would put something in a hold asks `holdLockedReason` first, and
// `checkCarriedAssets` (sim/invariants.js) asserts it every tick.

// holdLockedReason(craft) -> null when the craft carries no machine, else the refusal every hold-filling action
// gives: the hold is locked until the machine is unloaded.
function holdLockedReason(craft) {
  if (craft.carryingAssetId === undefined) return null;
  return `vehicle ${JSON.stringify(craft.id)} is carrying asset ${JSON.stringify(craft.carryingAssetId)} — a machine fills a whole heavy hold, so the hold is locked until it is unloaded (unloadAsset)`;
}

// assetAboard(craft, asset, tick) — THE ONE load apply, for a load validate passed. The heavy names the machine
// (its hold is now locked), and the machine's `stranded` flag clears: it is in hand, no longer awaiting salvage, so a
// later sweep of the fallow system cannot take it. It stays in `guild.assets` with its id and `systemId` untouched.
// Both are stamped (§15.2 — every mutation records its tick). Nothing priced moves: no credits, fuel or goods.
function assetAboard(craft, asset, tick) {
  craft.carryingAssetId = asset.id;
  craft.updatedAtTick = tick;
  delete asset.stranded;
  asset.updatedAtTick = tick;
}

// assetIntoSystem(craft, asset, systemId, tick) — THE ONE unload apply, for an unload validate passed (`systemId`
// is the held system the craft is berthed at). The heavy lets the machine go (its hold is free again) and the
// machine's `systemId` is set to that system. This is the only write of an asset's `systemId` after creation
// (design.md §4 / §15.4; `sim/tests/asset-ferry.test.js` scans the engine to keep it so). The machine is then an
// ordinary idle asset there: nothing names it, and it may be deployed by the usual same-system establish. Both are
// stamped (§15.2). Nothing priced moves.
function assetIntoSystem(craft, asset, systemId, tick) {
  delete craft.carryingAssetId;
  craft.updatedAtTick = tick;
  asset.systemId = systemId;
  asset.updatedAtTick = tick;
}

module.exports = { holdLockedReason, assetAboard, assetIntoSystem };
