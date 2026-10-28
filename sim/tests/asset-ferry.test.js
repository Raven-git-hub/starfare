'use strict';

// asset-ferry.test.js — LOSING GROUND, engine PR 2: THE SALVAGE RUN, which is the cross-system asset ferry exposed
// salvage-only (design.md §4 "Cross-system use requires a redeploy", built; §19 #67, SETTLED 19-10-26;
// docs/territory-model.md §5; sim/ferry.js). A guild abandons a Prefecture and its machines there are stranded; a
// heavy berthed in the fallow system loads one (`loadAsset`), flies home on an ordinary dispatch, and unloads it into a
// system the guild holds (`unloadAsset`), where it is an ordinary idle machine again.
//
// The tripwires:
//   1. THE ROUND TRIP, field by field: strand → load (flag cleared, hold locked, the machine in transit) → fly (the
//      heavy's own burn, the same laden or empty) → unload (systemId moved, the heavy empty) → deploy it at home.
//   2. THE GATES: every refusal of loadAsset and unloadAsset, in the order a failure is felt.
//   3. THE LOCKED HOLD: no transfer, no kit load, no Outpost reclaim, no route action, no repeating lane while laden.
//   4. THE SEAMS: a machine in transit cannot be deployed off the craft, and an eviction does not strand it; the
//      operator remove levers keep the state consistent.
//   5. THE INVARIANTS BITE: each corrupt carry, forced by hand, turns its own rule red — and the harness halts on it.
//   6. systemId MOVES ONLY THROUGH THE FERRY: a scan of the engine finds exactly one write.
//   7. BYTE-IDENTITY: a galaxy that never salvages hashes exactly as it did on `main` (pinned goldens).
//   8. PERSISTENCE + DETERMINISM: a journalled ferry replays to the same bytes; two loads racing in one batch.
//   9. THE OPERATOR CLI against a real server process: salvage-load / salvage-unload exit 0, and 1 on a refusal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { hashState } = require('../serialize.js');
const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { checkInvariants } = require('../invariants.js');
const { guildHolds } = require('../claims.js');
const { getSystem, getSystemLayout } = require('../seed.js');
const { hexDistance, legFuelBurn } = require('../transport.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT } = require('../vehicles.js');
const { ASSET_CARGO_VOLUME } = require('../fuel.js');
const { strandedAssetsIn } = require('../eviction.js');
const { idleAssets } = require('../assets.js');
const { placeCraft } = require('./kit-fixtures.js');
const {
  intake, createLoadAssetAction, createUnloadAssetAction, createGrantAssetAction, createGrantKitAction,
  createEstablishVentureAction, createAbandonPrefectureAction, createDispatchVehicleAction,
  createDispatchRouteWithActionsAction, createSpawnVehicleAction, createTransferCargoAction, createLoadKitAction,
  createSpawnOutpostAction, createReclaimOutpostAction, createRemoveVehicleAction, createRemoveAssetAction,
  createAdjustGoodsAction, createEstablishDeuteriumRefineryAction, createEstablishDockyardAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');

const { accept, refuse, ticks, tickUntil, g1Of, heavyOf, HEAVY, HOME, AT_HOME, TARGET, AT_TARGET, RIVAL, PLANET_A, SLOT_A1, SLOT_A2, ATTACHED_HEX } = P;

const load = (vehicleId, assetId) => createLoadAssetAction({ guildId: 'g1', vehicleId, assetId });
const unload = (vehicleId) => createUnloadAssetAction({ guildId: 'g1', vehicleId });
const assetOf = (s, id) => (g1Of(s).assets || []).find((a) => a.id === id);
const craftOf = (s, id) => g1Of(s).vehicles.find((v) => v.id === id);
const ownRow = (s) => buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1');
// A mineable, non-deuterium node in each system (deuterium mines take their own licence path) — from the seed.
const nodeIn = (systemId) => getSystemLayout(systemId).planets.flatMap((p) => p.resourceNodes).find((n) => n.resourceType !== 'deuterium');

// strandedGalaxy() -> g1 held TARGET (a Prefecture ferried and planted there by its heavy, which is still berthed at
// TARGET, empty), ran a factory venture there beside an idle miner, and then ABANDONED it: both machines are stranded
// in the fallow system, and the heavy sits beside them. The golden below pins exactly this prefix.
function strandedGalaxy() {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'miner', systemId: TARGET }));
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'factory', systemId: TARGET }));
  const miner = g1Of(s).assets.filter((a) => a.kind === 'miner').slice(-1)[0].id;
  const factory = g1Of(s).assets.filter((a) => a.kind === 'factory').slice(-1)[0].id;
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f1', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' }));
  s = ticks(s, 10);
  s = accept(s, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: 'prefecture_g1_01' }));
  return { s, miner, factory };
}

// laden() -> strandedGalaxy() with the miner loaded onto the heavy, still berthed at TARGET.
function laden() {
  const g = strandedGalaxy();
  return { ...g, before: g.s, s: accept(g.s, load(HEAVY, g.miner)) };
}

// spawnAt(s, vehicleClass, location) -> { s, id }: one more g1 craft, minted by the operator lever, and its id.
function spawnAt(s, vehicleClass, location) {
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location }));
  return { s, id: g1Of(s).vehicles.slice(-1)[0].id };
}

// --- 1. the round trip ---------------------------------------------------------------------------------------------

test('THE ROUND TRIP — load: the stranded flag clears, the heavy\'s hold locks, the machine reads in transit; nothing priced moves', () => {
  const { before, s, miner, factory } = laden();
  assert.ok(assetOf(before, miner).stranded, 'stranded before');
  const m = assetOf(s, miner);
  assert.deepEqual(m, { id: miner, kind: 'miner', systemId: TARGET, maintenanceCondition: 1, updatedAtTick: s.tick },
    'the same machine, the same id and location, its flag gone, stamped with the load tick');
  assert.equal(heavyOf(s).carryingAssetId, miner, 'the heavy names the machine');
  assert.equal(heavyOf(s).updatedAtTick, s.tick);
  assert.equal('cargo' in heavyOf(s), false, 'no goods beside it');
  // In hand, no longer awaiting salvage: only the factory is left stranded in TARGET.
  assert.deepEqual(strandedAssetsIn(s, TARGET), [{ guildId: 'g1', assetId: factory }]);
  // The snapshot: the third state on the asset row, the manifest on the vehicle row, the hold full.
  const row = ownRow(s);
  assert.deepEqual(row.assets.find((a) => a.id === miner), {
    id: miner, kind: 'miner', systemId: TARGET, maintenanceCondition: 1, deployedToVentureId: null, inTransitOnVehicleId: HEAVY,
  });
  const v = row.vehicles.find((x) => x.id === HEAVY);
  assert.equal(v.carryingAssetId, miner);
  assert.equal(v.used, ASSET_CARGO_VOLUME, 'a machine fills the hold whole');
  assert.equal(v.used, v.capacity, 'locked: no room left');
  // Instant, and free: no credits, fuel, goods or supply moved.
  assert.equal(s.tick, before.tick);
  assert.equal(g1Of(s).credits, g1Of(before).credits);
  assert.equal(g1Of(s).fuelHoard, g1Of(before).fuelHoard);
  assert.deepEqual(g1Of(s).stockpiles, g1Of(before).stockpiles);
  assert.deepEqual(s.galacticSupply, before.galacticSupply);
});

test('THE ROUND TRIP — fly: an ordinary dispatch; the laden heavy burns its own fuelCostToRun per hex, exactly what an empty heavy burns on the same leg', () => {
  let { s, miner } = laden();
  let twin;
  ({ s, id: twin } = spawnAt(s, HEAVY_TRANSPORT, AT_TARGET)); // an EMPTY heavy beside it, for comparison
  const leg = legFuelBurn(hexDistance(getSystem(TARGET).coords, getSystem(HOME.id).coords), heavyOf(s).fuelCostToRun, false);
  const f0 = g1Of(s).fuelHoard;
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [AT_HOME] }));
  assert.equal(f0 - g1Of(s).fuelHoard, leg, 'the laden leg');
  const f1 = g1Of(s).fuelHoard;
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: twin, waypoints: [AT_HOME] }));
  assert.equal(f1 - g1Of(s).fuelHoard, leg, 'the empty leg — the same: the machine adds no number');
  // In flight the machine is still in transit, still keyed to the system it was loaded from.
  s = ticks(s, 5);
  assert.equal(heavyOf(s).status, 'inTransit');
  assert.equal(ownRow(s).assets.find((a) => a.id === miner).inTransitOnVehicleId, HEAVY);
  assert.equal(assetOf(s, miner).systemId, TARGET);
  // tickUntil runs every invariant on every tick of the flight.
  s = tickUntil(s, (x) => heavyOf(x).status === 'idle');
  assert.deepEqual(heavyOf(s).location, AT_HOME);
  assert.equal(heavyOf(s).carryingAssetId, miner, 'it lands with the machine still aboard');
});

test('THE ROUND TRIP — unload at a held system: the machine\'s systemId moves there, it is an ordinary idle machine, the heavy is empty — and it deploys at home', () => {
  let { s, miner } = laden();
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [AT_HOME] }));
  s = tickUntil(s, (x) => heavyOf(x).status === 'idle');
  const before = s;
  s = accept(s, unload(HEAVY));
  assert.deepEqual(assetOf(s, miner), { id: miner, kind: 'miner', systemId: HOME.id, maintenanceCondition: 1, updatedAtTick: s.tick },
    'moved to HOME — the one sanctioned move of a systemId — and stamped');
  assert.equal('carryingAssetId' in heavyOf(s), false, 'the hold is free');
  assert.equal(heavyOf(s).updatedAtTick, s.tick);
  const row = ownRow(s);
  assert.deepEqual(row.assets.find((a) => a.id === miner), {
    id: miner, kind: 'miner', systemId: HOME.id, maintenanceCondition: 1, deployedToVentureId: null,
  }, 'idle: neither deployed nor in transit');
  const v = row.vehicles.find((x) => x.id === HEAVY);
  assert.equal('carryingAssetId' in v, false);
  assert.equal(v.used, 0);
  assert.deepEqual(s.galacticSupply, before.galacticSupply, 'nothing priced moved');
  // An ordinary idle machine of HOME: the usual same-system establish takes it.
  const node = nodeIn(HOME.id);
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm-home', type: 'mining', siteId: node.id, assetId: miner, resourceType: node.resourceType }));
  assert.equal(ownRow(s).assets.find((a) => a.id === miner).deployedToVentureId, 'm-home');
  s = ticks(s, 10);
});

// --- 2. the gates ----------------------------------------------------------------------------------------------------

test('loadAsset REFUSES — who and which machine: no guild, a craft or a machine it does not own, a kit, a machine already aboard, a machine that is not stranded (salvage-only)', () => {
  let { s, miner } = strandedGalaxy();
  assert.equal(refuse(s, createLoadAssetAction({ guildId: 'nope', vehicleId: HEAVY, assetId: miner })), 'no guild with id "nope"');
  assert.equal(refuse(s, load('vehicle_g1_heavyTransport_99', miner)), 'guild "g1" owns no vehicle "vehicle_g1_heavyTransport_99"');
  assert.equal(refuse(s, load(HEAVY, 'asset_g2_miner_01')), 'guild "g1" owns no asset "asset_g2_miner_01"', 'a rival\'s machine is not in this inventory');
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const kit = g1Of(s).assets.find((a) => a.kind === 'outpost').id;
  assert.match(refuse(s, load(HEAVY, kit)), /is a kit \(outpost\), not a machine — a kit rides in the hold as a good, loaded by loadKit/);
  // Salvage-only: a healthy idle machine in a held system is refused — general redeploy stays bottled.
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'factory', systemId: HOME.id }));
  const healthy = g1Of(s).assets.filter((a) => a.kind === 'factory').slice(-1)[0].id;
  assert.match(refuse(s, load(HEAVY, healthy)), /is not stranded — only a machine an eviction left behind can be salvaged/);
  // Already aboard: a second heavy cannot take the machine the first one holds.
  let second;
  ({ s, id: second } = spawnAt(s, HEAVY_TRANSPORT, AT_TARGET));
  s = accept(s, load(HEAVY, miner));
  assert.equal(refuse(s, load(second, miner)), `asset "${miner}" is already aboard vehicle "${HEAVY}"`);
});

test('loadAsset REFUSES — which craft and where: not a heavy, not idle, on a lane, cargo aboard, a machine already aboard, berthed in another system', () => {
  let { s, miner, factory } = strandedGalaxy();
  let light;
  ({ s, id: light } = spawnAt(s, LIGHT_TRANSPORT, AT_TARGET));
  assert.match(refuse(s, load(light, miner)), /is a lightTransport — a machine fills a whole heavy hold, so only a heavy transport carries one/);
  // Not idle: a heavy in flight.
  let flying;
  ({ s, id: flying } = spawnAt(s, HEAVY_TRANSPORT, AT_TARGET));
  const inFlight = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: flying, waypoints: [AT_HOME] }));
  assert.match(refuse(inFlight, load(flying, miner)), /is not idle \(status "inTransit"\)/);
  // On a lane (an idle craft waiting at a lane's stop), set by hand as the lane tests do.
  const onLane = structuredClone(s);
  heavyOf(onLane).route = { waypoints: [{ anchor: AT_TARGET }, { anchor: AT_HOME }], cursor: 0, mode: 'continuous' };
  assert.match(refuse(onLane, load(HEAVY, miner)), /is running a lane/);
  // Cargo aboard: a heavy at HOME with goods (the cargo gate is felt before the where gate).
  let homeHeavy;
  ({ s, id: homeHeavy } = spawnAt(s, HEAVY_TRANSPORT, AT_HOME));
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: HOME.id, good: 'titanium', delta: 5 }));
  const withGoods = accept(s, createTransferCargoAction({ guildId: 'g1', vehicleId: homeHeavy, manifest: [{ dir: 'load', good: 'titanium', qty: 5 }] }));
  assert.match(refuse(withGoods, load(homeHeavy, miner)), /has cargo aboard \({"titanium":5}\) — a machine loads into an EMPTY heavy hold/);
  // Berthed in another system: the empty HOME heavy cannot reach a machine in TARGET.
  assert.match(refuse(s, load(homeHeavy, miner)), new RegExp(`asset "${miner}" sits in system "${TARGET}" but vehicle "${homeHeavy}" is at .*a machine loads only onto a heavy berthed in its own system`));
  // A machine already aboard locks the hold: no second one.
  s = accept(s, load(HEAVY, miner));
  assert.equal(refuse(s, load(HEAVY, factory)), `vehicle "${HEAVY}" is carrying asset "${miner}" — a machine fills a whole heavy hold, so the hold is locked until it is unloaded (unloadAsset)`);
});

test('unloadAsset REFUSES — no guild, a craft it does not own, carrying nothing, not idle, on a bare hex, a system the guild does not hold (fallow or a rival\'s)', () => {
  const { s: empty } = strandedGalaxy();
  assert.equal(refuse(empty, createUnloadAssetAction({ guildId: 'nope', vehicleId: HEAVY })), 'no guild with id "nope"');
  assert.equal(refuse(empty, unload('vehicle_g1_heavyTransport_99')), 'guild "g1" owns no vehicle "vehicle_g1_heavyTransport_99"');
  assert.equal(refuse(empty, unload(HEAVY)), `vehicle "${HEAVY}" is carrying no asset — there is nothing to unload`);
  const { s } = laden();
  // Still at the fallow system it was loaded in — nobody holds it, so nothing can be unloaded there.
  assert.equal(refuse(s, unload(HEAVY)), `guild "g1" does not hold system "${TARGET}" — a machine unloads only into a system its guild holds`);
  const flying = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [AT_HOME] }));
  assert.match(refuse(flying, unload(HEAVY)), /is not idle \(status "inTransit"\) — a machine unloads from a craft that has arrived/);
  const onHex = placeCraft(structuredClone(s), 'g1', HEAVY, ATTACHED_HEX);
  assert.match(refuse(onHex, unload(HEAVY)), /is not berthed at a system .* — a machine unloads into a held system's inventory, not on a bare hex or at an Outpost/);
  const atRival = placeCraft(structuredClone(s), 'g1', HEAVY, { landmarkKind: 'system', landmarkId: RIVAL });
  assert.equal(refuse(atRival, unload(HEAVY)), `guild "g1" does not hold system "${RIVAL}" — a machine unloads only into a system its guild holds`);
});

// --- 3. the locked hold ---------------------------------------------------------------------------------------------

test('THE LOCKED HOLD — a laden heavy takes no cargo transfer, no kit, no packed Outpost', () => {
  let { s } = laden();
  const locked = `vehicle "${HEAVY}" is carrying asset "${heavyOf(s).carryingAssetId}" — a machine fills a whole heavy hold, so the hold is locked until it is unloaded (unloadAsset)`;
  assert.equal(refuse(s, createTransferCargoAction({ guildId: 'g1', vehicleId: HEAVY, manifest: [{ dir: 'load', good: 'titanium', max: true }] })), locked);
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const kit = g1Of(s).assets.find((a) => a.kind === 'outpost').id;
  assert.equal(refuse(s, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: kit })), locked);
  // An Outpost with the laden heavy the one craft parked on its hex: the reclaim would pack it into a full hold.
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: ATTACHED_HEX }));
  const parked = placeCraft(structuredClone(s), 'g1', HEAVY, ATTACHED_HEX);
  assert.equal(refuse(parked, createReclaimOutpostAction({ guildId: 'g1', outpostId: s.outposts[0].id })), locked);
});

test('THE LOCKED HOLD — a laden heavy flies a one-shot route of turning points only: any route action, or a repeating lane, is refused', () => {
  const { s, miner } = laden();
  const route = (waypoints, repeat) => createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: HEAVY, waypoints, ...(repeat ? { repeat } : {}) });
  assert.match(refuse(s, route([{ anchor: AT_HOME, action: { type: 'dock', manifest: [{ dir: 'unload', good: 'titanium', max: true }] } }])),
    new RegExp(`waypoint 0 carries an action, but vehicle "${HEAVY}" is carrying asset "${miner}" .* a laden heavy's route is turning points only`));
  assert.match(refuse(s, route([{ anchor: AT_HOME, action: { type: 'unload' } }])), /waypoint 0 carries an action/);
  assert.match(refuse(s, route([{ anchor: AT_HOME }, { anchor: AT_TARGET }], { mode: 'continuous' })),
    /is carrying asset .* — a machine never rides a repeating lane/);
  // The plain one-shot route is an ordinary dispatch.
  const flying = accept(s, route([{ anchor: AT_HOME }]));
  assert.equal(heavyOf(flying).status, 'inTransit');
});

// --- 4. the seams -----------------------------------------------------------------------------------------------------

test('SEAM — a machine in transit is not idle: re-held, its origin system still refuses to deploy it straight off the craft; and an eviction there does not strand it', () => {
  let { s, miner, factory } = laden();
  // g1 re-claims TARGET while the miner is aboard. Its own re-plant recovers the stranded factory (engine PR 1).
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  assert.equal(guildHolds(s, 'g1', TARGET), true);
  assert.equal('stranded' in assetOf(s, factory), false, 'the factory recovered by the re-plant');
  // The miner still reads TARGET (the system it was loaded from), TARGET is held — and yet it is in the hold.
  const node = nodeIn(TARGET);
  const establish = createEstablishVentureAction({ guildId: 'g1', ventureId: 'm2', type: 'mining', siteId: node.id, assetId: miner, resourceType: node.resourceType });
  assert.equal(refuse(s, establish), `asset "${miner}" is aboard vehicle "${HEAVY}", in transit — unload it into a held system before deploying it`);
  // Abandon again: the factory, in the system, is stranded once more; the miner, in the hold, is not.
  s = accept(s, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: 'prefecture_g1_02' }));
  assert.ok(assetOf(s, factory).stranded);
  assert.equal('stranded' in assetOf(s, miner), false);
  assert.deepEqual(g1Of(s).events.filter((e) => e.type === 'system_lost').slice(-1)[0].payload.strandedAssetIds, [factory]);
  assert.equal(heavyOf(s).carryingAssetId, miner, 'still aboard');
});

test('SEAM — every establish path refuses a factory in transit (a venture, a deuterium refinery, a dockyard), and the idle list leaves it out', () => {
  let { s, factory } = strandedGalaxy();
  s = accept(s, load(HEAVY, factory));
  assert.equal(idleAssets(g1Of(s), 'factory').some((a) => a.id === factory), false, 'in transit is not idle');
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  const inTransit = `asset "${factory}" is aboard vehicle "${HEAVY}", in transit — unload it into a held system before deploying it`;
  assert.equal(refuse(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f2', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' })), inTransit);
  assert.equal(refuse(s, createEstablishDeuteriumRefineryAction({ guildId: 'g1', ventureId: 'r2', siteId: SLOT_A2, assetId: factory, productionRate: 1 })), inTransit);
  assert.equal(refuse(s, createEstablishDockyardAction({ guildId: 'g1', ventureId: 'y2', siteId: SLOT_A2, assetId: factory })), inTransit);
  s = accept(s, unload(HEAVY));
  assert.equal(idleAssets(g1Of(s), 'factory').some((a) => a.id === factory), true, 'idle once unloaded');
  s = accept(s, createEstablishDockyardAction({ guildId: 'g1', ventureId: 'y2', siteId: SLOT_A2, assetId: factory }));
});

test('SEAM — unloading into the ORIGIN system once it is held again is legal (a no-move unload), and the machine then deploys there', () => {
  let { s, miner } = laden();
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  s = accept(s, unload(HEAVY));
  assert.equal(assetOf(s, miner).systemId, TARGET);
  const node = nodeIn(TARGET);
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm2', type: 'mining', siteId: node.id, assetId: miner, resourceType: node.resourceType }));
  s = ticks(s, 5);
});

test('SEAM — the salvage race: a rival\'s claim sweeps only what is still stranded; the machine in hand stays the salvager\'s, and cannot be unloaded in the rival\'s system', () => {
  let { s, miner, factory } = laden();
  // The miner is aboard the heavy; the factory is still stranded. g2 claims the fallow system — legal since the sweep
  // (engine PR 4) — and its plant takes the factory, but cannot reach the miner in the hold.
  let rivalKit;
  ({ s, kitId: rivalKit } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_A);
  s = accept(s, P.plant('g2', rivalKit, SLOT_A1));
  assert.equal(guildHolds(s, 'g2', TARGET), true);
  assert.equal(assetOf(s, factory), undefined, 'the stranded factory changed hands');
  assert.deepEqual(s.guilds.find((g) => g.id === 'g2').assets.map((a) => a.kind), ['factory'], 're-minted as g2\'s own');
  assert.equal(heavyOf(s).carryingAssetId, miner, 'the miner in hand is still the salvager\'s, aboard');
  // It still reads TARGET — a rival's system now — and that is legal in transit; it unloads only at home.
  assert.equal(assetOf(s, miner).systemId, TARGET);
  assert.equal(refuse(s, unload(HEAVY)), `guild "g1" does not hold system "${TARGET}" — a machine unloads only into a system its guild holds`);
  s = ticks(s, 5);
});

test('SEAM — the operator remove levers stay consistent: removing a laden heavy destroys its machine (its number never reissued); removing the machine frees the hold', () => {
  const { s: start, miner, factory } = laden();
  let s = accept(start, createRemoveVehicleAction({ guildId: 'g1', vehicleId: HEAVY }));
  assert.equal(assetOf(s, miner), undefined, 'the machine went with the craft');
  assert.deepEqual(g1Of(s).removedAssetHighWater, { miner: 1 });
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'miner', systemId: HOME.id }));
  assert.equal(g1Of(s).assets.filter((a) => a.kind === 'miner').slice(-1)[0].id, 'asset_g1_miner_02', 'never reissued');
  // The other way round: remove the machine, and the heavy names nothing — free to salvage the factory.
  s = accept(start, createRemoveAssetAction({ guildId: 'g1', assetId: miner }));
  assert.equal('carryingAssetId' in heavyOf(s), false);
  s = accept(s, load(HEAVY, factory));
  assert.equal(heavyOf(s).carryingAssetId, factory);
});

test('SEAM — fog: a rival sees neither the machine in transit nor the manifest (a rival guild row carries no assets or vehicles)', () => {
  const { s } = laden();
  const g1InRivalView = buildSnapshot(s, 'g2').guilds.find((g) => g.id === 'g1');
  assert.equal('assets' in g1InRivalView, false);
  assert.equal('vehicles' in g1InRivalView, false);
});

// --- 5. the invariants bite -------------------------------------------------------------------------------------------

// forced(s, mutate) -> a deep copy of `s` with `mutate` applied by hand (a state no action can reach), the supply cache
// refreshed so only the carry rules can speak. rulesOf -> the rule names checkInvariants reports for it.
function forced(s, mutate) {
  const x = structuredClone(s);
  mutate(x);
  x.galacticSupply = computeGalacticSupply(x);
  return x;
}
const rulesOf = (x) => checkInvariants(x, x.tick).map((v) => v.rule);

test('THE INVARIANTS BITE — one heavy carrying TWO machines, a hold both laden and holding goods, a machine named by two craft, a DEPLOYED machine flagged carried', () => {
  const { s, miner, factory } = laden();
  assert.deepEqual(rulesOf(s), [], 'the honest laden state is clean');
  assert.deepEqual(rulesOf(forced(s, (x) => { heavyOf(x).carryingAssetId = [miner, factory]; })),
    ['carried-asset-is-one-id (sim/ferry.js)']);
  assert.deepEqual(rulesOf(forced(s, (x) => { heavyOf(x).cargo = { titanium: 1 }; })),
    ['carried-asset-locks-the-hold (sim/ferry.js)']);
  const { s: two, id: second } = spawnAt(s, HEAVY_TRANSPORT, AT_TARGET);
  assert.deepEqual(rulesOf(forced(two, (x) => { craftOf(x, second).carryingAssetId = miner; })),
    ['carried-asset-named-by-one-vehicle (sim/ferry.js)']);
  // A deployed machine: the miner unloaded at home and running a mine, then named by the heavy again.
  let home = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [AT_HOME] }));
  home = tickUntil(home, (x) => heavyOf(x).status === 'idle');
  home = accept(home, unload(HEAVY));
  const node = nodeIn(HOME.id);
  home = accept(home, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm-home', type: 'mining', siteId: node.id, assetId: miner, resourceType: node.resourceType }));
  assert.deepEqual(rulesOf(forced(home, (x) => { heavyOf(x).carryingAssetId = miner; })),
    ['carried-asset-not-deployed (sim/ferry.js)']);
});

test('THE INVARIANTS BITE — the rest: carried by a non-heavy, still stranded, a missing machine, a kit by name, a stamp from the future', () => {
  const { s, miner, factory } = laden();
  const { s: withLight, id: light } = spawnAt(s, LIGHT_TRANSPORT, AT_TARGET);
  assert.deepEqual(rulesOf(forced(withLight, (x) => { craftOf(x, light).carryingAssetId = factory; })),
    ['carried-asset-on-a-heavy (sim/ferry.js)', 'carried-asset-not-stranded (sim/ferry.js)'], 'a light, naming a machine still stranded');
  assert.deepEqual(rulesOf(forced(s, (x) => { assetOf(x, miner).stranded = { tick: x.tick }; })),
    ['carried-asset-not-stranded (sim/ferry.js)']);
  assert.deepEqual(rulesOf(forced(s, (x) => { heavyOf(x).carryingAssetId = 'asset_g1_miner_99'; })),
    ['carried-asset-owned-by-same-guild (sim/ferry.js)']);
  const withKit = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const kit = g1Of(withKit).assets.find((a) => a.kind === 'outpost').id;
  assert.deepEqual(rulesOf(forced(withKit, (x) => { heavyOf(x).carryingAssetId = kit; })),
    ['carried-asset-is-a-machine (sim/ferry.js)']);
  assert.deepEqual(rulesOf(forced(s, (x) => { assetOf(x, miner).updatedAtTick = x.tick + 1; })),
    ['asset-updated-tick-is-a-past-tick (§15.2)']);
});

test('THE HARNESS HALTS — the tick loop throws on a corrupt carry, naming the tick and the rule, rather than carrying on', () => {
  const { s, miner, factory } = laden();
  const bad = forced(s, (x) => { heavyOf(x).carryingAssetId = [miner, factory]; });
  assert.throws(() => advance(bad, []), new RegExp(`Invariant violation at tick ${s.tick + 1}:[\\s\\S]*carried-asset-is-one-id`));
});

// --- 6. systemId moves only through the ferry ------------------------------------------------------------------------

test('systemId MOVES ONLY THROUGH THE FERRY — the engine writes `.systemId =` in exactly one place: sim/ferry.js assetIntoSystem', () => {
  // The invariants cannot see history, so this is the tripwire for "set at creation, moved only by unloadAsset": a
  // scan of every engine file for an assignment to a `systemId` property. A second write — anywhere — fails here and
  // must be ruled before it lands. (It sees direct assignment; a write by spread or Object.assign would need review.)
  const simDir = path.join(__dirname, '..');
  const writes = [];
  for (const file of fs.readdirSync(simDir).filter((f) => f.endsWith('.js')).sort()) {
    fs.readFileSync(path.join(simDir, file), 'utf8').split('\n').forEach((line, i) => {
      if (/\.systemId\s*=(?!=)/.test(line) && !/^\s*\/\//.test(line)) writes.push({ file, line: line.trim() });
    });
  }
  assert.deepEqual(writes, [{ file: 'ferry.js', line: 'asset.systemId = systemId;' }]);
});

// --- 7. byte-identity -------------------------------------------------------------------------------------------------

// Pinned from `main` at 10f5910 (before this slice), running the very scenario below: a galaxy that strands machines
// (the eviction) and flies its heavy home past them, but never salvages. The state hash and all three views must not
// move by a byte — the carry field, the asset stamp and the snapshot's in-transit surfacing are all omit-when-absent,
// and no un-ferried asset's systemId is touched.
const GOLDEN_NO_SALVAGE = {
  tick: 930,
  state: 'ffa1f9559d2a4b0814f17e27ab81e77903dda5bcfc98be0a17607965f791f166',
  god: 'cb85db9bbbbefeb5e2cd2eb980a07855d4336044a0aa7163dfb293dfeda14c95',
  own: '3b01bf2d3dad823ad84ed0d968fbf2807350bea8ceea80fce8517e43f6b46072',
  rival: '729582374e4d9dc30c8479b03168438f9b4f8b5af3963ace977063c14da0bd5e',
};

test('BYTE-IDENTICAL: a galaxy that strands machines but never salvages serializes exactly as it did before this slice (state and every view)', () => {
  let { s } = strandedGalaxy();
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [{ anchor: AT_HOME }] }));
  s = tickUntil(s, (x) => heavyOf(x).status === 'idle');
  s = ticks(s, 20);
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.deepEqual({
    tick: s.tick, state: hashState(s), god: sha(buildSnapshot(s)), own: sha(buildSnapshot(s, 'g1')), rival: sha(buildSnapshot(s, 'g2')),
  }, GOLDEN_NO_SALVAGE);
});

// --- 8. persistence and determinism ------------------------------------------------------------------------------------

test('PERSISTENCE: a journalled load and unload replay to the same bytes; a createState hand-in keeps the manifest and the stamp', () => {
  let { s: start, miner } = laden();
  start = accept(start, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [AT_HOME] }));
  start = tickUntil(start, (x) => heavyOf(x).status === 'idle');
  const direct = accept(start, unload(HEAVY));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-ferry-'));
  try {
    saveState(start, dir);
    appendJournal(start.tick, unload(HEAVY), dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct));
    assert.equal(hashState(ticks(replayed, 10)), hashState(ticks(direct, 10)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // createState: a laden save keeps the carry; a ferried save keeps the stamp.
  const ladenState = laden().s;
  assert.equal(heavyOf(createState(structuredClone(ladenState))).carryingAssetId, miner);
  assert.equal(assetOf(createState(structuredClone(direct)), miner).updatedAtTick, direct.tick);
});

test('DETERMINISM: the same galaxy and the same ferry give the same bytes; two heavies loading one machine in one batch resolve first-valid-wins', () => {
  assert.equal(hashState(laden().s), hashState(laden().s));
  let { s, miner } = strandedGalaxy();
  let second;
  ({ s, id: second } = spawnAt(s, HEAVY_TRANSPORT, AT_TARGET));
  const out = intake(s, [load(second, miner), load(HEAVY, miner)]);
  assert.deepEqual(out.results.map((r) => r.accepted), [true, false]);
  assert.equal(out.results[1].reason, `asset "${miner}" is already aboard vehicle "${second}"`);
  assert.equal(craftOf(out.state, second).carryingAssetId, miner);
  assert.deepEqual(checkInvariants(out.state, out.state.tick), []);
});

// --- 9. the operator CLI, against a real server process ---------------------------------------------------------------

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const ADMIN_JS = path.join(__dirname, '..', '..', 'tools', 'admin.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('THE OPERATOR CLI: salvage-load and salvage-unload exit 0 and report the ferry; each refusal (not stranded, a fallow berth, nothing aboard, a missing flag) exits 1', async () => {
  const { HOME_SYSTEM } = require('./home-anchor.js');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.STARFARE_TICK_MS;
  delete env.STARFARE_PERSIST_DIR;
  const server = spawn(process.execPath, [SERVER_JS], { env });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => (await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const cli = (...args) => spawnSync(process.execPath, [ADMIN_JS, ...args, '--base', base], { encoding: 'utf8' });
  const G = 'player-guild';
  try {
    for (let i = 0; ; i += 1) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not listening yet */ }
      if (i > 200) throw new Error('the server never answered /health');
      await new Promise((r) => setTimeout(r, 25));
    }
    // A guild at the seed's first starter claims the nearest system with a settlement slot, puts a miner there, and
    // abandons it: the miner is stranded. A heavy is berthed beside it.
    assert.equal((await post('/action', { type: 'foundGuild', guildId: G, credits: 120, influence: 100, homeSystemId: HOME_SYSTEM, isBot: true })).accepted, true);
    const homeHex = getSystem(HOME_SYSTEM).coords;
    const target = require('../../data/seed.json').systems
      .filter((x) => x.id !== HOME_SYSTEM && getSystemLayout(x.id).planets.some((p) => p.settlementSlots.length))
      .sort((a, b) => hexDistance(a.coords, homeHex) - hexDistance(b.coords, homeHex) || a.id.localeCompare(b.id))[0].id;
    const planet = getSystemLayout(target).planets.find((p) => p.settlementSlots.length);
    const grant = await post('/admin/guild/grant-kit', { guildId: G, systemId: target, kind: 'prefecture' });
    const kit = grant.snapshot.guilds[0].assets.find((a) => a.kind === 'prefecture').id;
    await post('/action', { type: 'reveal', guildId: G, planetId: planet.id });
    assert.equal((await post('/admin/guild/plant-prefecture', { guildId: G, assetId: kit, slotId: planet.settlementSlots[0].id })).accepted, true);
    const granted = await post('/action', { type: 'grantAsset', guildId: G, kind: 'miner', systemId: target });
    const miner = granted.snapshot.guilds[0].assets.filter((a) => a.kind === 'miner' && a.systemId === target)[0].id;
    assert.equal((await post('/admin/guild/abandon-prefecture', { guildId: G, prefectureId: `prefecture_${G}_01` })).accepted, true);
    const spawned = await post('/admin/vehicle/spawn', { guildId: G, class: HEAVY_TRANSPORT, location: { landmarkKind: 'system', landmarkId: target } });
    const heavy = spawned.snapshot.guilds[0].vehicles.find((v) => v.class === HEAVY_TRANSPORT && v.location && v.location.landmarkId === target).id;

    // Refusals exit 1, with the engine's own reason on stderr.
    const homeMiner = `asset_${G}_miner_01`; // a founding starter at home: healthy, not stranded
    const notStranded = cli('salvage-load', '--guild', G, '--id', heavy, '--asset', homeMiner);
    assert.equal(notStranded.status, 1);
    assert.match(notStranded.stderr, /salvage-load refused: asset "asset_player-guild_miner_01" is not stranded/);
    const nothing = cli('salvage-unload', '--guild', G, '--id', heavy);
    assert.equal(nothing.status, 1);
    assert.match(nothing.stderr, /salvage-unload refused: vehicle ".*" is carrying no asset/);
    const missing = cli('salvage-load', '--guild', G, '--id', heavy);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /salvage-load: --asset is required/);

    // The load: exit 0, the machine aboard and in transit, the hold locked.
    const loaded = cli('salvage-load', '--guild', G, '--id', heavy, '--asset', miner);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.match(loaded.stdout, /action\s+loadAsset/);
    assert.match(loaded.stdout, new RegExp(`aboard\\s+${miner} \\(miner\\), loaded in ${target} — in transit on ${heavy}`));
    assert.match(loaded.stdout, new RegExp(`hold\\s+locked by ${miner} \\(${ASSET_CARGO_VOLUME} / ${ASSET_CARGO_VOLUME} space\\)`));
    // Still at the fallow berth: the unload is refused there.
    const fallow = cli('salvage-unload', '--guild', G, '--id', heavy);
    assert.equal(fallow.status, 1);
    assert.match(fallow.stderr, new RegExp(`does not hold system "${target}"`));

    // Fly home on an ordinary dispatch, ticking the server until the heavy lands.
    await post('/action', { type: 'adjustFuel', guildId: G, delta: 100_000 });
    assert.equal((await post('/admin/vehicle/dispatch', { guildId: G, vehicleId: heavy, waypoints: [{ landmarkKind: 'system', landmarkId: HOME_SYSTEM }] })).accepted, true);
    let snap;
    for (let i = 0; ; i += 1) {
      snap = await post('/tick', {});
      if (snap.guilds[0].vehicles.find((v) => v.id === heavy).status === 'idle') break;
      if (i > 5_000) throw new Error('the heavy never landed');
    }

    // The unload: exit 0, the machine an ordinary idle machine of the home system.
    const unloaded = cli('salvage-unload', '--guild', G, '--id', heavy);
    assert.equal(unloaded.status, 0, unloaded.stderr);
    assert.match(unloaded.stdout, /action\s+unloadAsset/);
    assert.match(unloaded.stdout, new RegExp(`unloaded\\s+${miner} \\(miner\\) — idle in ${HOME_SYSTEM}`));
    assert.match(unloaded.stdout, /hold\s+empty/);
    const after = await (await fetch(`${base}/snapshot`)).json();
    const row = after.guilds[0].assets.find((a) => a.id === miner);
    assert.equal(row.systemId, HOME_SYSTEM);
    assert.equal('inTransitOnVehicleId' in row, false);

    // The endpoints themselves: a half body is a 400 (the constructor refuses it).
    const bad = await fetch(`${base}/admin/vehicle/load-asset`, { method: 'POST', body: JSON.stringify({ guildId: G, vehicleId: heavy }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /malformed load-asset/);
    const bad2 = await fetch(`${base}/admin/vehicle/unload-asset`, { method: 'POST', body: JSON.stringify({ guildId: G }) });
    assert.equal(bad2.status, 400);
    assert.match((await bad2.json()).error, /malformed unload-asset/);
  } finally {
    server.kill('SIGKILL');
  }
});
