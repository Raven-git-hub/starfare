'use strict';

// droid-batch-noop-script.js — a run whose hashes were RECORDED AT c613414 (the branch base, before the Syndicate
// droid batch-buy slice existed) and are pinned in droid-batch-buy.test.js. The slice adds one action, one
// shipment shape (`assetKind: 'droid'` + `droidCount`) and one public snapshot block (`droidBatchQuote`). A galaxy
// that never buys a droid batch must still serialize byte for byte as it did before the slice, and its snapshot
// must differ ONLY by that new block.
//
// It walks the paths the slice touched, WITHOUT buying a droid batch:
//   - a dockyard builds a GUILD droid (mintFinishedKind's droid branch, next to which the slice edited a comment);
//   - the Syndicate sells a MINER, built and delivered (stepArrivals' asset branch, which the droid-batch branch now
//     sits in front of);
//   - the operator `grantDroid` lever mints Syndicate droids directly (it must be unaffected);
// with every invariant (the new droid-shipment checks included) asserted on every tick by advance().
//
// Uses only engine API that existed at c613414, so the same file ran there to record the hashes.

const { createCommissionBuildAction, createBuyAssetFromSyndicateAction, createGrantDroidAction } = require('../actions.js');
const { ALL_BILLS } = require('../asset-recipes.js');
const { HOME, YARD, kitGalaxy, accept, ticks } = require('./installation-kit-fixtures.js');

function noBatchScript() {
  const stock = {};
  for (const [good, qty] of Object.entries(ALL_BILLS.droid)) stock[good] = qty;
  let s = kitGalaxy({ credits: 100_000_000, fuelHoard: 10_000, stock });
  s = accept(s, createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind: 'droid' }));
  s = accept(s, createBuyAssetFromSyndicateAction({
    guildId: 'g1', assetKind: 'miner', destinationSystemId: HOME.id, issueTick: s.tick,
  }));
  s = accept(s, createGrantDroidAction({ systemId: HOME.id, source: 'syndicate', count: 3 }));
  return ticks(s, 2500); // the guild droid (360) and the miner (720 + its flight) both land
}

module.exports = { noBatchScript };
