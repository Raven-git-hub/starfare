'use strict';

// installation-kit-round-trip.test.js — the END-TO-END tripwires for roadmap 2.5's Deep Scan Array acquire half
// (docs/asset-purchase.md §"Installation kits", RULED 15-10-26). Three whole lives of a kit, every tick through
// advance(), which asserts EVERY invariant on EVERY tick and halts naming the tick on a violation:
//
//   1. BUILT ARRAY:  a dockyard consumes the array bill → counts down the full 10,080 → one idle `deepScan` kit
//                    in the inventory → loaded onto a heavy → flown to a hex attached to home → deployed on
//                    arrival → a row in state.deepScanArrays → queueScan → the L1 reveal lands in the record.
//   2. BOUGHT ARRAY: the same, but the kit comes from the Syndicate — the full 10,080 build, then a delivery
//                    leg on a Syndicate hauler — and lands idle at the destination.
//   3. BUILT OUTPOST: a dockyard consumes the outpost bill → the full 12,960 → an idle `outpost` kit → loaded,
//                    flown, deployed → a live Outpost.
// The kit count along the way: +1 on the mint, 0 on the load, −1 on the deploy. Nothing special is done to the
// kit once it lands: it is loaded, ferried and deployed exactly as a granted kit is.
//
// These runs are long (10–13 thousand ticks each), so they live in their own file and run beside the rest of the
// suite; installation-kit-acquire.test.js holds the quick tripwires.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot } = require('../snapshot.js');
const { arrivalTickFor } = require('../transport.js');
const { getSystemLayout } = require('../seed.js');
const { DEEP_SCAN_ARRAY, OUTPOST, INSTALLATION_BILLS, BUILD_TICKS } = require('../asset-recipes.js');
const { SCAN_L1_TICKS } = require('../deep-scan-arrays.js');
const {
  createCommissionBuildAction, createBuyAssetFromSyndicateAction, createLoadKitAction,
  createDispatchRouteWithActionsAction, createQueueScanAction,
} = require('../actions.js');
const { kitCount } = require('./kit-fixtures.js');
const {
  HOME, RIVAL, YARD, HEAVY, ATTACHED_HEX, kitGalaxy, accept, ticks, tickUntil, bareHexFromHome,
  g1Of, yardOf, heavyOf, kitsOf,
} = require('./installation-kit-fixtures.js');
const seed = require('../../data/seed.json');

// The scan target: the first system (id order) that is neither side's home and has planets — unclaimed, so an
// L1 scan of it is legal (docs/exploration-model.md §5). Derived from the seed, so a regen carries the test.
const TARGET = seed.systems.map((sys) => sys.id)
  .filter((id) => id !== HOME.id && id !== RIVAL && getSystemLayout(id).planets.length > 0).sort()[0];

const commission = (assetKind) => createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind });
const deployTo = (anchor, kind) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: HEAVY, waypoints: [{ anchor, action: { type: 'deploy', kind } }],
});
const idleKit = (id, kind) => ({ id, kind, systemId: HOME.id, maintenanceCondition: 1 });

// buildAtTheYard(s, kind) -> the state the tick the yard's kit is minted, having asserted the build: the bill
// consumed on the first tick, then exactly BUILD_TICKS[kind] ticks to the mint, the queue empty after.
function buildAtTheYard(s, kind) {
  s = accept(s, commission(kind));
  s = ticks(s, 1);
  const consumeTick = s.tick;
  assert.equal(yardOf(s).buildQueue[0].remainingTicks, BUILD_TICKS[kind], `${kind}: the bill consumed and the countdown begun`);
  s = tickUntil(s, (x) => kitsOf(x).length > 0);
  assert.equal(s.tick, consumeTick + BUILD_TICKS[kind], `${kind}: minted exactly BUILD_TICKS after the consume tick`);
  assert.deepEqual(yardOf(s).buildQueue, [], `${kind}: the finished head left the queue`);
  return s;
}

// loadFlyDeploy(s, kitId, kind, anchor) -> the state the heavy is idle again, its kit deployed at `anchor` —
// the existing load → dispatch → deploy-on-arrival path, exactly as for a granted kit. Asserts the kit count.
function loadFlyDeploy(s, kitId, kind, anchor) {
  assert.equal(kitCount(s, 'g1').total, 1, 'one kit, idle in the inventory');
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: kitId }));
  assert.deepEqual(kitCount(s, 'g1'), { idle: 0, aboard: 1, total: 1 }, 'the load moved it, one for one');
  s = accept(s, deployTo(anchor, kind));
  const arrivalTick = heavyOf(s).trip.arrivalTick;
  s = tickUntil(s, (x) => heavyOf(x).status === 'idle');
  assert.equal(s.tick, arrivalTick, 'deployed on the arrival tick');
  assert.equal(kitCount(s, 'g1').total, 0, 'the deploy consumed the kit');
  assert.equal(heavyOf(s).cargo, undefined);
  assert.deepEqual(heavyOf(s).location, anchor);
  return s;
}

// scanTarget(s, arrayId) -> the state the L1 scan of TARGET has landed, having asserted the reveal.
function scanTarget(s, arrayId) {
  const planets = getSystemLayout(TARGET).planets.map((p) => p.id);
  for (const p of planets) assert.equal(p in (g1Of(s).exploration || {}), false, `${p}: not known before the scan`);
  s = accept(s, createQueueScanAction({ guildId: 'g1', arrayId, level: 'L1', targetSystemId: TARGET }));
  s = ticks(s, SCAN_L1_TICKS);
  for (const p of planets) {
    assert.deepEqual(g1Of(s).exploration[p], { tick: s.tick, nodes: {}, slots: {} }, `${p}: its archetype revealed by the array`);
  }
  assert.equal('scan' in s.deepScanArrays[0], false, 'the job cleared — the array is idle again');
  return s;
}

test('ROUND TRIP, built: dockyard array → idle deepScan kit → loaded → flown → deployed attached → scanned → revealed', () => {
  let s = kitGalaxy({ fuelHoard: 10_000, stock: INSTALLATION_BILLS[DEEP_SCAN_ARRAY] });
  s = buildAtTheYard(s, DEEP_SCAN_ARRAY);
  assert.deepEqual(g1Of(s).assets, [idleKit('asset_g1_deepScan_01', 'deepScan')], 'one idle KIT, of the kit kind');
  assert.equal(g1Of(s).kitAssetSerial, 1);
  assert.deepEqual(buildSnapshot(s).guilds[0].assets,
    [{ ...idleKit('asset_g1_deepScan_01', 'deepScan'), deployedToVentureId: null }], 'an idle asset row the client can read');

  s = loadFlyDeploy(s, 'asset_g1_deepScan_01', 'deepScan', ATTACHED_HEX);
  assert.deepEqual(s.deepScanArrays.map((a) => [a.id, a.ownerGuildId, a.coords, a.anchorSystemId]),
    [['deepScanArray_g1_01', 'g1', ATTACHED_HEX, HOME.id]]);
  scanTarget(s, 'deepScanArray_g1_01');
});

test('ROUND TRIP, bought: Syndicate array → 10,080 build → hauled in → idle deepScan kit → deployed → scanned → revealed', () => {
  let s = kitGalaxy({ credits: 200_000_000, fuelHoard: 10_000 });
  s = accept(s, createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind: DEEP_SCAN_ARRAY, destinationSystemId: HOME.id, issueTick: s.tick }));
  // The head starts the tick after buy and counts the full 10,080 (asset-purchase.md "The two phases").
  const completionTick = s.tick + 1 + BUILD_TICKS[DEEP_SCAN_ARRAY];
  s = tickUntil(s, (x) => !x.syndicateBuilds);
  assert.equal(s.tick, completionTick, 'construction ran the full 10,080');
  assert.deepEqual(s.shipments.map((sh) => [sh.assetKind, sh.destinationSystemId, sh.arrivalTick]),
    [[DEEP_SCAN_ARRAY, HOME.id, arrivalTickFor(completionTick, HOME.distance)]],
    'then ONE delivery under the bill kind, on a Syndicate hauler from the nearest waystation');
  assert.equal(kitsOf(s).length, 0, 'nothing in the inventory while it is in flight');
  const arrivalTick = s.shipments[0].arrivalTick;
  s = tickUntil(s, (x) => kitsOf(x).length > 0);
  assert.equal(s.tick, arrivalTick);
  assert.deepEqual(s.shipments, [], 'the shipment landed and left the list');
  assert.deepEqual(g1Of(s).assets, [idleKit('asset_g1_deepScan_01', 'deepScan')], 'one idle KIT at the destination');

  s = loadFlyDeploy(s, 'asset_g1_deepScan_01', 'deepScan', ATTACHED_HEX);
  assert.deepEqual(s.deepScanArrays.map((a) => [a.id, a.anchorSystemId]), [['deepScanArray_g1_01', HOME.id]]);
  scanTarget(s, 'deepScanArray_g1_01');
});

test('ROUND TRIP, built outpost: dockyard outpost → 12,960 → idle outpost kit → loaded → flown → deployed → a live Outpost', () => {
  let s = kitGalaxy({ fuelHoard: 10_000, stock: INSTALLATION_BILLS[OUTPOST] });
  s = buildAtTheYard(s, OUTPOST);
  assert.deepEqual(g1Of(s).assets, [idleKit('asset_g1_outpost_01', 'outpost')], 'one idle outpost KIT');
  assert.equal(s.outposts, undefined, 'a kit, not an Outpost — nothing is placed until it is deployed');

  const hex = bareHexFromHome(2); // inside the Outpost deploy range of home
  const deployed = loadFlyDeploy(s, 'asset_g1_outpost_01', 'outpost', hex);
  assert.equal(deployed.outposts.length, 1);
  const o = deployed.outposts[0];
  assert.deepEqual([o.id, o.ownerGuildId, o.coords, o.anchorSystemId, o.createdAtTick],
    ['outpost_g1_01', 'g1', hex, HOME.id, deployed.tick], 'a live Outpost, the kit\'s guild its owner');
  assert.equal(buildSnapshot(deployed).outposts[0].id, 'outpost_g1_01');
  ticks(deployed, 3); // and the galaxy runs on with it, every invariant holding
});
