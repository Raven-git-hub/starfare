'use strict';

// installation-kit-acquire.test.js — roadmap 2.5, the Deep Scan Array acquire half: a guild can BUILD (dockyard)
// or BUY (Syndicate) a `deep_scan_array` or an `outpost`, and what lands is one idle KIT asset that the existing
// load → ferry → deploy loop carries (docs/asset-purchase.md §"Installation kits", RULED 15-10-26). The long
// end-to-end runs — build or buy, load, fly, deploy, scan — are in installation-kit-round-trip.test.js. The
// tripwires here:
//
//   1. THE BRIDGE: one frozen bill-kind → kit-kind map, and its load-time tripwire bites on each bad shape.
//   2. THE BASELINES: 100M / 150M, `[FIRST-CUT]`, read by assetPurchaseBaseline, and the doc still says them.
//   3. WRONG PATH REFUSED: the toll gate by commission AND buy; spycraft by buy; the KIT kind by both.
//      Both new kinds accepted by both.
//   4. IDS: a built or bought kit takes the next kit serial — never a granted, starter or unloaded kit's id,
//      and never the id of a kit that was loaded away.
//   5. RESERVE-AND-WAIT: an outpost head one part short waits, consumes nothing and holds the queue; a whole
//      bill consumes atomically and counts down 12,960 (outpost) / 10,080 (array).
//   6. CANCEL: refunds exactly the new baseline; with out-of-band prices the premium is kept.
//   7. SCALE CHECK: parts × 0.8 at base and at band-ceiling prices, from code.
//   8. DESTINATION: a bought kit lands where it was sent, held or not — the rule every kind already has.
//   9. CONSERVATION: build — exactly the bill leaves the pool and Galactic Supply; buy — credits to the
//      ledger, the heavy-rate asset fuel burned.
//  10. SNAPSHOT / HTTP: the quote grows by exactly the two rows, each the engine's own price.
//  11. DETERMINISM (invariant 9): two runs identical; a mid-build save restores byte-identically.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { routeFuelCost, ASSET_CARGO_VOLUME } = require('../fuel.js');
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const { bandFor } = require('../prices.js');
const { nextAssetNumber } = require('../assets.js');
const { DEPLOYABLE_KITS } = require('../resources.js');
const { SPYCRAFT } = require('../vehicles.js');
const {
  DEEP_SCAN_ARRAY, OUTPOST, TOLL_GATE, INSTALLATION_BILLS, ALL_BILLS, BUILDABLE_KINDS, SYNDICATE_SELLABLE_KINDS,
  KIT_KIND_FOR_BILL, INSTALLATION_KIT_BUY_BASELINE, VEHICLE_BUY_BASELINE, ASSET_PURCHASE_FLOOR,
  ASSET_PURCHASE_REDUCTION, BUILD_TICKS, assertKitBridge, kitKindForBill, assetPurchaseBaseline,
  priceAssetForPurchase,
} = require('../asset-recipes.js');
const {
  validateAction, applyAction,
  createCommissionBuildAction, createBuyAssetFromSyndicateAction, createCancelSyndicateCommissionAction,
  createGrantKitAction, createLoadKitAction, createUnloadKitAction, createAdjustGoodsAction,
  createSpawnVehicleAction, createFoundGuildAction, createEstablishDockyardAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_SLOT } = require('./home-anchor.js');
const { withoutInstallationQuotes } = require('./installation-quote-strip.js');
const {
  HOME, RIVAL, YARD, HEAVY, kitGalaxy, accept, refuse, ticks, tickUntil, g1Of, yardOf, kitsOf,
} = require('./installation-kit-fixtures.js');
const seed = require('../../data/seed.json');

// A real system g1 does NOT hold (nor g2) — derived from the seed, so a regen carries the tests.
const ELSEWHERE = seed.systems.map((sys) => sys.id).filter((id) => id !== HOME.id && id !== RIVAL).sort()[0];
const ARRAY_BILL = INSTALLATION_BILLS[DEEP_SCAN_ARRAY];
const OUTPOST_BILL = INSTALLATION_BILLS[OUTPOST];
const RICH = 1_000_000_000; // enough credits for any one buy below at base prices

const commission = (assetKind) => createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind });
const buy = (s, assetKind, destinationSystemId = HOME.id) =>
  createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind, destinationSystemId, issueTick: s.tick });
const cancel = (commissionId) => createCancelSyndicateCommissionAction({ guildId: 'g1', commissionId });
const creditTotal = (s) => s.guilds.reduce((sum, g) => sum + g.credits, 0) + s.syndicate.ledger;

// --- 1. the bridge ---------------------------------------------------------------------------------------------

test('the bridge: one frozen map, deep_scan_array → deepScan and outpost → outpost — and nothing else finishes as a kit', () => {
  assert.deepEqual({ ...KIT_KIND_FOR_BILL }, { [DEEP_SCAN_ARRAY]: 'deepScan', [OUTPOST]: 'outpost' });
  assert.ok(Object.isFrozen(KIT_KIND_FOR_BILL));
  for (const kitKind of Object.values(KIT_KIND_FOR_BILL)) assert.ok(kitKind in DEPLOYABLE_KITS, `${kitKind} is a real kit kind`);
  assert.equal(kitKindForBill(DEEP_SCAN_ARRAY), 'deepScan');
  assert.equal(kitKindForBill(OUTPOST), 'outpost');
  // Not a row: the toll gate (no kit yet), the KIT spelling itself, every other buildable kind, and junk.
  for (const kind of [TOLL_GATE, 'deepScan', 'miner', 'heavyTransport', SPYCRAFT, 'toString', 'nonsense']) {
    assert.equal(kitKindForBill(kind), null, kind);
  }
});

test('the bridge tripwire BITES: a value that is not a kit, a key that is not buildable, a buildable installation with no row', () => {
  assert.doesNotThrow(() => assertKitBridge(KIT_KIND_FOR_BILL, BUILDABLE_KINDS), 'the real map passes (it also ran at load)');
  assert.throws(() => assertKitBridge({ ...KIT_KIND_FOR_BILL, [DEEP_SCAN_ARRAY]: DEEP_SCAN_ARRAY }, BUILDABLE_KINDS),
    /maps "deep_scan_array" to "deep_scan_array", which is not a kit kind/);
  assert.throws(() => assertKitBridge({ ...KIT_KIND_FOR_BILL, [TOLL_GATE]: 'deepScan' }, BUILDABLE_KINDS),
    /row for "toll_gate", which is not a buildable kind/);
  assert.throws(() => assertKitBridge({ [OUTPOST]: 'outpost' }, BUILDABLE_KINDS),
    /"deep_scan_array" is a buildable installation with no KIT_KIND_FOR_BILL row/);
  // Making the toll gate buildable before it has a kit is exactly the third shape.
  assert.throws(() => assertKitBridge(KIT_KIND_FOR_BILL, [...BUILDABLE_KINDS, TOLL_GATE]),
    /"toll_gate" is a buildable installation with no KIT_KIND_FOR_BILL row/);
});

test('the vocabularies: both kinds join ALL_BILLS, BUILDABLE_KINDS and SYNDICATE_SELLABLE_KINDS; spycraft is still the ONLY build-only kind', () => {
  for (const kind of [DEEP_SCAN_ARRAY, OUTPOST]) {
    assert.equal(ALL_BILLS[kind], INSTALLATION_BILLS[kind], kind);
    assert.ok(BUILDABLE_KINDS.includes(kind), kind);
    assert.ok(SYNDICATE_SELLABLE_KINDS.includes(kind), kind);
  }
  assert.ok(SYNDICATE_SELLABLE_KINDS.every((k) => BUILDABLE_KINDS.includes(k)), 'sellable ⊂ buildable');
  assert.deepEqual(BUILDABLE_KINDS.filter((k) => !SYNDICATE_SELLABLE_KINDS.includes(k)), [SPYCRAFT]);
  assert.equal(TOLL_GATE in ALL_BILLS, false, 'the toll gate has no buildable bill');
  assert.equal(BUILDABLE_KINDS.includes(TOLL_GATE), false, 'the toll gate is not buildable');
  assert.equal(SYNDICATE_SELLABLE_KINDS.includes(TOLL_GATE), false, 'the toll gate is not sold');
});

// --- 2. the baselines ------------------------------------------------------------------------------------------

test('the baselines: array 100,000,000 and outpost 150,000,000, read by assetPurchaseBaseline, and the tuning doc says them', () => {
  assert.deepEqual({ ...INSTALLATION_KIT_BUY_BASELINE }, { [DEEP_SCAN_ARRAY]: 100_000_000, [OUTPOST]: 150_000_000 });
  assert.ok(Object.isFrozen(INSTALLATION_KIT_BUY_BASELINE));
  assert.equal(assetPurchaseBaseline(DEEP_SCAN_ARRAY), 100_000_000);
  assert.equal(assetPurchaseBaseline(OUTPOST), 150_000_000);
  // The lookup order is unchanged for every other kind: a vehicle's own baseline, else the 12M floor.
  assert.equal(assetPurchaseBaseline('heavyTransport'), VEHICLE_BUY_BASELINE.heavyTransport);
  assert.equal(assetPurchaseBaseline('miner'), ASSET_PURCHASE_FLOOR);
  // The doc the numbers came from still says them — a retune that moves one and not the other fails here.
  const tuning = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'phase-1-tuning.md'), 'utf8');
  assert.match(tuning, /\*\*`deep_scan_array` 100,000,000\*\*, \*\*`outpost` 150,000,000\*\*/);
});

// --- 3. wrong path refused, right path accepted -----------------------------------------------------------------

test('commission: the array and the outpost are accepted; the toll gate and the KIT kind are refused, naming the kind', () => {
  const s = kitGalaxy();
  for (const kind of [DEEP_SCAN_ARRAY, OUTPOST]) accept(s, commission(kind));
  assert.match(refuse(s, commission(TOLL_GATE)), /assetKind "toll_gate" is not buildable/);
  assert.match(refuse(s, commission('deepScan')), /assetKind "deepScan" is not buildable/);
});

test('buy: the array and the outpost are accepted; the toll gate, spycraft and the KIT kind are refused, each loudly', () => {
  const s = kitGalaxy({ credits: RICH, fuelHoard: 10_000 });
  for (const kind of [DEEP_SCAN_ARRAY, OUTPOST]) accept(s, buy(s, kind));
  assert.match(refuse(s, buy(s, TOLL_GATE)), /"toll_gate" is not a Syndicate-sellable kind/);
  assert.match(refuse(s, buy(s, SPYCRAFT)), /the Syndicate does not sell spycraft, it is guild-build-only/);
  assert.match(refuse(s, buy(s, 'deepScan')), /"deepScan" is not a Syndicate-sellable kind/);
});

// --- 4. ids ------------------------------------------------------------------------------------------------------

test('ids: grant, load, a built outpost, a bought array, an unload — each takes the next kit serial; none is ever reissued', () => {
  // The yard's head is seeded already started, 3 ticks from done (the started-head pattern, vehicles.test.js):
  // the full 12,960-tick countdown is run in installation-kit-round-trip.test.js; here only the id matters.
  let s = kitGalaxy({ credits: RICH, fuelHoard: 10_000, queue: [{ commissionId: 0, assetKind: OUTPOST, remainingTicks: 3 }] });
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'outpost' }));
  assert.deepEqual(kitsOf(s), ['asset_g1_outpost_01'], 'the granted kit');
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: 'asset_g1_outpost_01' }));
  assert.deepEqual(kitsOf(s), [], 'loaded away — the inventory is empty');
  // THE BITE: the per-kind asset numbering would hand the next outpost the loaded kit's id again.
  assert.equal(nextAssetNumber(g1Of(s), 'outpost'), 1, 'nextAssetNumber would reissue 01');

  s = accept(s, buy(s, DEEP_SCAN_ARRAY));
  s.syndicateBuilds[0].remainingTicks = 2; // hand-set underway (the round-trip file runs the full countdown)
  s = ticks(s, 3);
  assert.deepEqual(kitsOf(s), ['asset_g1_outpost_02'], 'the built outpost takes serial 2, not the loaded 01');
  assert.equal(s.shipments.length, 1, 'the bought array is in flight');
  assert.equal(buildSnapshot(s).shipments[0].assetKind, DEEP_SCAN_ARRAY, 'its transit row names the BILL kind');
  s = tickUntil(s, (x) => !x.shipments || x.shipments.length === 0);
  assert.deepEqual(kitsOf(s), ['asset_g1_outpost_02', 'asset_g1_deepScan_03'], 'the bought array takes serial 3');
  s = accept(s, createUnloadKitAction({ guildId: 'g1', vehicleId: HEAVY }));
  assert.deepEqual(kitsOf(s), ['asset_g1_outpost_02', 'asset_g1_deepScan_03', 'asset_g1_outpost_04'],
    'the unloaded kit takes serial 4 — the loaded 01 never comes back');
  assert.equal(g1Of(s).kitAssetSerial, 4);
  assert.deepEqual(g1Of(s).assets.map((a) => a.kind), ['outpost', 'deepScan', 'outpost'], 'each is a KIT kind, never a bill kind');
});

test('ids: a founded human guild\'s starter kit is 01, so its first BUILT kit is 02', () => {
  let s = advance(createZeroState(), [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
  const kits = (x) => (x.guilds[0].assets || []).filter((a) => a.kind in DEPLOYABLE_KITS).map((a) => a.id);
  assert.deepEqual(kits(s), ['asset_player-guild_outpost_01'], 'the starter package\'s kit');
  s = accept(s, createEstablishDockyardAction({ guildId: 'player-guild', ventureId: 'yard', siteId: HOME_SLOT, assetId: 'asset_player-guild_factory_01' }));
  for (const [good, qty] of Object.entries(ARRAY_BILL)) {
    s = accept(s, createAdjustGoodsAction({ guildId: 'player-guild', systemId: HOME_SYSTEM, good, delta: qty }));
  }
  s = accept(s, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard', assetKind: DEEP_SCAN_ARRAY }));
  s = ticks(s, 1);
  const head = s.guilds[0].ventures.find((v) => v.id === 'yard').buildQueue[0];
  assert.equal(head.remainingTicks, BUILD_TICKS[DEEP_SCAN_ARRAY], 'the bill was consumed and the 10,080 countdown began');
  head.remainingTicks = 1; // hand-set: the full countdown runs in installation-kit-round-trip.test.js
  s = ticks(s, 1);
  assert.deepEqual(kits(s), ['asset_player-guild_outpost_01', 'asset_player-guild_deepScan_02']);
});

// --- 5. reserve-and-wait -----------------------------------------------------------------------------------------

test('reserve-and-wait: an outpost head ONE part short does not start, consumes nothing, and holds a ready miner behind it', () => {
  // The whole outpost bill less one hull plate, plus a whole miner bill on top. The miner uses no hull plating,
  // so the plate the outpost lacks is not one the miner could have taken.
  const stock = { ...OUTPOST_BILL, hull_plating: OUTPOST_BILL.hull_plating - 1 };
  for (const [good, qty] of Object.entries(ALL_BILLS.miner)) stock[good] = (stock[good] || 0) + qty;
  assert.equal(ALL_BILLS.miner.hull_plating, undefined);
  let s = kitGalaxy({ stock });
  s = accept(s, commission(OUTPOST));
  s = accept(s, commission('miner'));
  const poolBefore = structuredClone(g1Of(s).stockpiles[HOME.id]);
  s = ticks(s, 5);
  assert.deepEqual(yardOf(s).buildQueue.map((e) => [e.assetKind, e.remainingTicks]), [[OUTPOST, null], ['miner', null]],
    'the starved outpost waits, and the ready miner waits behind it (strict FIFO, no skip-ahead)');
  assert.deepEqual(g1Of(s).stockpiles[HOME.id], poolBefore, 'nothing was consumed while waiting');

  // The missing plate arrives: the next tick consumes the WHOLE outpost bill at once and starts its 12,960.
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: HOME.id, good: 'hull_plating', delta: 1 }));
  const full = structuredClone(g1Of(s).stockpiles[HOME.id]);
  s = ticks(s, 1);
  for (const [good, qty] of Object.entries(full)) {
    assert.equal(g1Of(s).stockpiles[HOME.id][good], qty - (OUTPOST_BILL[good] || 0), `${good}: exactly the outpost's bill left`);
  }
  assert.deepEqual(yardOf(s).buildQueue.map((e) => [e.assetKind, e.remainingTicks]), [[OUTPOST, 12_960], ['miner', null]]);
  s = ticks(s, 1);
  assert.equal(yardOf(s).buildQueue[0].remainingTicks, 12_959, 'and it counts down');
});

test('reserve-and-wait: a whole array bill is consumed atomically and the countdown starts at 10,080', () => {
  let s = kitGalaxy({ stock: ARRAY_BILL });
  s = accept(s, commission(DEEP_SCAN_ARRAY));
  s = ticks(s, 1);
  assert.equal(yardOf(s).buildQueue[0].remainingTicks, 10_080);
  for (const good of Object.keys(ARRAY_BILL)) assert.equal(g1Of(s).stockpiles[HOME.id][good], 0, `${good}: all consumed`);
});

// --- 6. cancel ----------------------------------------------------------------------------------------------------

test('cancel: a queued array refunds exactly 100,000,000 and a queued outpost exactly 150,000,000; the fuel stays burned', () => {
  let s = kitGalaxy({ credits: RICH, fuelHoard: 10_000 });
  s = accept(s, buy(s, DEEP_SCAN_ARRAY)); // commission 1
  s = accept(s, buy(s, OUTPOST));         // commission 2
  const total = creditTotal(s);
  const before = { credits: g1Of(s).credits, ledger: s.syndicate.ledger, fuel: g1Of(s).fuelHoard, burned: s.audit.totalConsumed };
  s = accept(s, cancel(2));
  assert.equal(g1Of(s).credits, before.credits + 150_000_000);
  assert.equal(s.syndicate.ledger, before.ledger - 150_000_000);
  s = accept(s, cancel(1));
  assert.equal(g1Of(s).credits, before.credits + 250_000_000);
  assert.equal(s.syndicate.ledger, before.ledger - 250_000_000);
  assert.equal(g1Of(s).fuelHoard, before.fuel, 'the delivery fuel is forfeit');
  assert.equal(s.audit.totalConsumed, before.burned);
  assert.equal(creditTotal(s), total, 'no credit created or destroyed');
  assert.equal(s.syndicateBuilds, undefined, 'the emptied queue key is gone');
});

test('cancel: once the array head starts building it cannot be cancelled', () => {
  let s = kitGalaxy({ credits: RICH, fuelHoard: 10_000 });
  s = accept(s, buy(s, DEEP_SCAN_ARRAY));
  s = ticks(s, 1);
  assert.equal(s.syndicateBuilds[0].remainingTicks, 10_080);
  assert.match(refuse(s, cancel(1)), /\(a deep_scan_array\) is underway/);
});

test('premium: with out-of-band prices the parts branch binds, the price exceeds the baseline, and the refund is still the baseline', () => {
  for (const kind of [DEEP_SCAN_ARRAY, OUTPOST]) {
    // Hand-set every module of the bill to 10M (the syndicate-queue-cancel premium technique). Over its band a
    // price trips the price-sanity invariant, so the buy is applied without the invariant assert and the real
    // prices are put back before the cancel, which `accept` then checks in full.
    const s0 = kitGalaxy({ credits: 10_000_000_000, fuelHoard: 10_000 });
    const real = {};
    for (const module of Object.keys(INSTALLATION_BILLS[kind])) {
      real[module] = s0.prices[module].posted;
      s0.prices[module].posted = 10_000_000;
    }
    const price = priceAssetForPurchase(s0, kind, s0.tick);
    const baseline = assetPurchaseBaseline(kind);
    const units = Object.values(INSTALLATION_BILLS[kind]).reduce((a, b) => a + b, 0);
    assert.equal(price, Math.round(units * 10_000_000 * ASSET_PURCHASE_REDUCTION), `${kind}: the parts branch prices it`);
    assert.ok(price > baseline, `${kind}: ${price} > ${baseline}`);
    assert.equal(validateAction(s0, buy(s0, kind)).valid, true);
    const s1 = applyAction(s0, buy(s0, kind));
    assert.equal(g1Of(s1).credits, g1Of(s0).credits - price, `${kind}: the buy charged the full premium price`);
    for (const [module, posted] of Object.entries(real)) s1.prices[module].posted = posted;
    const s2 = accept(s1, cancel(1));
    assert.equal(g1Of(s2).credits, g1Of(s0).credits - (price - baseline), `${kind}: the guild is out exactly the premium`);
    assert.equal(s2.syndicate.ledger, s0.syndicate.ledger + (price - baseline), `${kind}: which the ledger keeps`);
    assert.equal(creditTotal(s2), creditTotal(s0));
  }
});

// --- 7. the scale check -------------------------------------------------------------------------------------------

// partsCost × 0.8 with every module at its band's base, or at its band's ceiling — from the code's own bands.
function partsTimesReduction(kind, edge) {
  let parts = 0;
  for (const [module, qty] of Object.entries(ALL_BILLS[kind])) parts += qty * bandFor(module)[edge];
  return Math.round(parts * ASSET_PURCHASE_REDUCTION);
}

test('scale check: the baseline binds at BASE prices for every sellable kind; at band CEILING it binds only for the light transport and the outpost', () => {
  // The two new kinds, exactly (an observation from the code's bands, pinned so a retune is noticed).
  assert.equal(partsTimesReduction(DEEP_SCAN_ARRAY, 'base'), 32_066_880);
  assert.equal(partsTimesReduction(DEEP_SCAN_ARRAY, 'ceiling'), 3_206_688_000);
  assert.equal(partsTimesReduction(OUTPOST, 'base'), 460_800);
  assert.equal(partsTimesReduction(OUTPOST, 'ceiling'), 46_080_000);
  for (const kind of SYNDICATE_SELLABLE_KINDS) {
    assert.ok(partsTimesReduction(kind, 'base') < assetPurchaseBaseline(kind), `${kind}: the baseline binds at base`);
  }
  // At the ceiling the parts branch DOES bind for five of the seven sellable kinds. (docs/asset-purchase.md's
  // 26-09-26 "Observation" said it could bind for none; under today's bands that is untrue, and it is corrected there.)
  const bindsAtCeiling = SYNDICATE_SELLABLE_KINDS.filter((k) => partsTimesReduction(k, 'ceiling') > assetPurchaseBaseline(k));
  assert.deepEqual(bindsAtCeiling, ['miner', 'factory', 'mediumTransport', 'heavyTransport', DEEP_SCAN_ARRAY]);
  // And the engine's own price agrees: every array module posted at its band ceiling (in band, so no
  // invariant trips) prices the array at 3,206,688,000, not its 100M baseline.
  const s = kitGalaxy();
  for (const module of Object.keys(ARRAY_BILL)) s.prices[module].posted = bandFor(module).ceiling;
  assert.equal(priceAssetForPurchase(s, DEEP_SCAN_ARRAY, s.tick), 3_206_688_000);
});

// --- 8. destination ------------------------------------------------------------------------------------------------

test('destination: a bought kit lands idle at the system it was sent to, even one the guild does not hold — the rule every kind has', () => {
  let s = kitGalaxy({ credits: RICH, fuelHoard: 10_000 });
  assert.equal(s.claims.some((c) => c.landmarkId === ELSEWHERE), false, 'nobody holds ELSEWHERE');
  s = accept(s, buy(s, DEEP_SCAN_ARRAY, ELSEWHERE));
  s.syndicateBuilds[0].remainingTicks = 1; // hand-set underway; the delivery leg below is real
  s = ticks(s, 1);
  assert.equal(s.shipments[0].arrivalTick, arrivalTickFor(s.tick, nearestWaystation(ELSEWHERE).distance),
    'it rides a Syndicate hauler from the nearest waystation, like a miner or factory');
  s = tickUntil(s, (x) => !x.shipments || x.shipments.length === 0);
  assert.deepEqual(g1Of(s).assets, [{ id: 'asset_g1_deepScan_01', kind: 'deepScan', systemId: ELSEWHERE, maintenanceCondition: 1 }]);
  // What happens next is the existing kit rules, unchanged: a heavy berthed there can load it (loadKit asks only
  // "same system")…
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: 'heavyTransport', location: { landmarkKind: 'system', landmarkId: ELSEWHERE } }));
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: 'vehicle_g1_heavyTransport_02', assetId: 'asset_g1_deepScan_01' }));
  // …but it cannot be unloaded back into a system the guild does not hold (unloadKit asks "held").
  assert.match(refuse(s, createUnloadKitAction({ guildId: 'g1', vehicleId: 'vehicle_g1_heavyTransport_02' })), /does not hold system/);
});

// --- 9. conservation ----------------------------------------------------------------------------------------------

test('conservation, build: exactly the bill leaves the yard\'s pool and Galactic Supply; no credit or fuel moves', () => {
  let s = kitGalaxy({ credits: 5, fuelHoard: 7, stock: { ...ARRAY_BILL, chassis: ARRAY_BILL.chassis + 3, titanium: 11 } });
  s = accept(s, commission(DEEP_SCAN_ARRAY));
  const before = structuredClone(s);
  s = ticks(s, 1);
  const pool = (x) => g1Of(x).stockpiles[HOME.id];
  for (const good of Object.keys(pool(before))) {
    const spent = ARRAY_BILL[good] || 0;
    assert.equal(pool(s)[good], pool(before)[good] - spent, `${good}: the pool fell by the bill's ${spent}`);
    assert.equal(s.galacticSupply.resources[good], before.galacticSupply.resources[good] - spent, `${good}: supply fell by ${spent}`);
  }
  assert.equal(g1Of(s).credits, 5);
  assert.equal(g1Of(s).fuelHoard, 7);
});

test('conservation, buy: credits go guild → ledger by the price; the heavy-rate asset fuel burns out of the galaxy', () => {
  for (const kind of [DEEP_SCAN_ARRAY, OUTPOST]) {
    const s0 = kitGalaxy({ credits: RICH, fuelHoard: 10_000 });
    const s1 = accept(s0, buy(s0, kind));
    const price = assetPurchaseBaseline(kind); // the baseline binds at rest (the scale check above)
    const { fuelBurn } = routeFuelCost(HOME.id, ASSET_CARGO_VOLUME);
    assert.ok(fuelBurn > 0);
    assert.equal(g1Of(s1).credits, RICH - price, `${kind}: credits down by the price`);
    assert.equal(s1.syndicate.ledger, s0.syndicate.ledger + price, `${kind}: the ledger up by the same`);
    assert.equal(creditTotal(s1), creditTotal(s0), `${kind}: invariant 2 nets to zero`);
    assert.equal(g1Of(s1).fuelHoard, 10_000 - fuelBurn, `${kind}: the heavy-hold asset burn`);
    assert.equal(s1.audit.totalConsumed, s0.audit.totalConsumed + fuelBurn, `${kind}: burned, not moved`);
  }
});

// --- 10. snapshot / HTTP -------------------------------------------------------------------------------------------

test('snapshot: the purchase quote grows by exactly the two rows — each the engine\'s own price and build time — in the lens AND the view', () => {
  const s = kitGalaxy();
  for (const snap of [buildSnapshot(s), buildSnapshot(s, 'g1')]) {
    const quote = snap.assetPurchaseQuote;
    assert.deepEqual(Object.keys(quote), [...SYNDICATE_SELLABLE_KINDS]);
    assert.deepEqual(quote[DEEP_SCAN_ARRAY], { price: priceAssetForPurchase(s, DEEP_SCAN_ARRAY, s.tick), buildTicks: 10_080 });
    assert.deepEqual(quote[OUTPOST], { price: priceAssetForPurchase(s, OUTPOST, s.tick), buildTicks: 12_960 });
    assert.equal(quote[DEEP_SCAN_ARRAY].price, 100_000_000);
    assert.equal(quote[OUTPOST].price, 150_000_000);
    // The strip the goldens use takes away those two rows and nothing else.
    assert.deepEqual(Object.keys(withoutInstallationQuotes(snap).assetPurchaseQuote),
      ['miner', 'factory', 'lightTransport', 'mediumTransport', 'heavyTransport']);
  }
  assert.throws(() => withoutInstallationQuotes({ assetPurchaseQuote: {} }), /nothing to strip/);
});

test('snapshot: a queued array is an on-order row under its BILL kind, counted against its own 10,080', () => {
  let s = kitGalaxy({ credits: RICH, fuelHoard: 10_000 });
  s = accept(s, buy(s, DEEP_SCAN_ARRAY));
  s = accept(s, buy(s, OUTPOST));
  assert.deepEqual(buildSnapshot(s).syndicateBuilds.map((b) => [b.assetKind, b.building, b.ticksRemaining, b.cancellable]), [
    [DEEP_SCAN_ARRAY, true, 10_080, true],
    [OUTPOST, false, 10_080 + 12_960, true],
  ]);
});

// --- 11. determinism ------------------------------------------------------------------------------------------------

// A mixed script: a yard build of each kind, a buy of each, a grant — the countdowns hand-set short so the run
// is quick (the full ones are in the round-trip file). Returns the state partway (`mid`) and at the end.
function mixedScript() {
  let s = kitGalaxy({ credits: RICH, fuelHoard: 10_000, stock: { ...ARRAY_BILL } });
  s = accept(s, commission(DEEP_SCAN_ARRAY));
  s = accept(s, buy(s, OUTPOST));
  s = accept(s, buy(s, DEEP_SCAN_ARRAY));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'deepScan' }));
  s = ticks(s, 2);
  const mid = structuredClone(s);
  yardOf(s).buildQueue[0].remainingTicks = 1;
  s.syndicateBuilds[0].remainingTicks = 1;
  s = ticks(s, 3);
  s.syndicateBuilds[0].remainingTicks = 1;
  s = tickUntil(s, (x) => !x.syndicateBuilds && (!x.shipments || x.shipments.length === 0));
  return { mid, end: s };
}

test('determinism (invariant 9): two runs are byte-identical, ids included', () => {
  const a = mixedScript();
  const b = mixedScript();
  assert.equal(hashState(a.end), hashState(b.end));
  assert.deepEqual(kitsOf(a.end), ['asset_g1_deepScan_01', 'asset_g1_deepScan_02', 'asset_g1_outpost_03', 'asset_g1_deepScan_04']);
});

test('determinism: a mid-build save (a yard array under way, two bill-kind commissions queued) restores byte-identically and runs on identically', () => {
  const { mid } = mixedScript();
  assert.equal(yardOf(mid).buildQueue[0].assetKind, DEEP_SCAN_ARRAY);
  assert.deepEqual(mid.syndicateBuilds.map((b) => b.assetKind), [OUTPOST, DEEP_SCAN_ARRAY]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-installation-kit-'));
  try {
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(mid));
    assert.equal(hashState(ticks(restored, 5)), hashState(ticks(mid, 5)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
