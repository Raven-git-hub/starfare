'use strict';

// droid-assign-noop-script.js — a run whose end-state hash was RECORDED AT b226b3a (main, before droid engine
// slice 3 existed) and is pinned in droid-assignment.test.js. Slice 3's new droid fields
// (`assignedToVentureId`, `deployedAtTick`) are omit-when-absent, so a galaxy that buys no Syndicate droid and
// assigns none must still serialize byte for byte as it did before the slice. If this hash moves, something
// other than a droid buy or an assignment changed the state's shape.
//
// It walks every path slice 3 touched, WITHOUT buying or assigning a droid:
//   - a dockyard builds a GUILD droid (minted idle, never assigned — the row must stay slice 2's four fields);
//   - the Syndicate sells a MINER (the buyAssetFromSyndicate apply the droid branch now sits in front of),
//     built and delivered;
//   - the dockyard venture is then CLOSED through the operator lever — the shared applyVentureClosure that now
//     releases a closed venture's droids (here, none are assigned, so it must change nothing);
// with every invariant (checkDroids' new assignment rules included) checked on every tick by advance().
//
// Uses only engine API that existed at b226b3a, so the same file ran there to record the hash.

const { createCommissionBuildAction, createBuyAssetFromSyndicateAction, createRemoveVentureAction } = require('../actions.js');
const { ALL_BILLS } = require('../asset-recipes.js');
const { YARD, kitGalaxy, accept, ticks } = require('./installation-kit-fixtures.js');

function noBuyNoAssignScript() {
  const stock = {};
  for (const [good, qty] of Object.entries(ALL_BILLS.droid)) stock[good] = qty;
  let s = kitGalaxy({ credits: 100_000_000, fuelHoard: 10_000, stock });
  s = accept(s, createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind: 'droid' }));
  s = accept(s, createBuyAssetFromSyndicateAction({
    guildId: 'g1', assetKind: 'miner', destinationSystemId: s.guilds[0].homeSystemId, issueTick: s.tick,
  }));
  s = ticks(s, 2500); // the droid (360) and the miner (720 + its flight) both land
  s = accept(s, createRemoveVentureAction({ guildId: 'g1', ventureId: YARD }));
  return ticks(s, 20);
}

module.exports = { noBuyNoAssignScript };
