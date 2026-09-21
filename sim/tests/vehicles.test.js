'use strict';

// vehicles.test.js — the guild-transport tier, roadmap 2.2-foundation engine slice (a)
// (design.md §15.4 "Vehicle", §6; docs/phase-1-tuning.md §"Guild transports"). A guild can
// BUILD (dockyard) or BUY (Syndicate) one of the four transport classes, and it is minted IDLE
// into `guild.vehicles`. Nothing moves it yet — dispatch/cargo/client are slice b+.
//
// The tripwires, one per ruling:
//   - VOCABULARY: the four classes, their per-class stats read VERBATIM from phase-1-tuning
//     (no invented number), the deterministic `vehicle_<guild>_<class>_NN` id scheme, and
//     spycraft's capacity of exactly 0 surviving the constructor's non-falsy guard;
//   - the CATALOG: the four ship bills sit beside the ground-asset bills so the SAME
//     assertBillModulesAreTier3 tripwire covers them; BUILD_TICKS + the per-class buy baselines;
//   - the PRICE: `max(baseline[class], round(partsCost × 0.8))` — the baseline binds at today's
//     parts scale, so a bought transport costs exactly its per-class baseline;
//   - the BUY path: it flies ITSELF in — the up-front burn is the craft's OWN fuelCostToRun ×
//     hexDistance (NOT the heavy-hauler rate a ground asset pays), and the arrival is
//     completionTick + ceil(hexDistance × speed[class]) (NOT the flat CRAFT_SPEED), where the head
//     completes after its BUILD_TICKS countdown in the per-guild single-slot queue;
//   - the BUILD path: a dockyard consumes the ship bill from its own system and mints an idle
//     transport at that system after BUILD_TICKS;
//   - the MINT: a transport lands in guild.vehicles (never guild.assets), idle, with the class
//     spec + systemId stamped and a fresh stable id; a spycraft mints with capacity 0;
//   - checkVehicleIntegrity catches a bad class / unresolvable system / out-of-range condition /
//     illegal status, and passes a well-formed idle craft;
//   - determinism (invariant 9): a buy-and-build transport run twice is byte-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { getStock } = require('../stock.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL, routeFuelCost, ASSET_CARGO_VOLUME } = require('../fuel.js');
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const {
  assetBill, assertBillModulesAreTier3, BUILD_TICKS, BUILDABLE_KINDS, VEHICLE_BUY_BASELINE,
  priceAssetForPurchase, ASSET_PURCHASE_FLOOR,
} = require('../asset-recipes.js');
const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT,
  VEHICLE_CLASSES, BUILDABLE_VEHICLE_KINDS, VEHICLE_SPECS, VEHICLE_STATUSES,
  isVehicleClass, vehicleSpec, vehicleId, nextVehicleSerial, resolveVehicleLocation, vehicleCoords,
} = require('../vehicles.js');
const { MINER } = require('../assets.js');
const { getSystem, getOutpost } = require('../seed.js');
const {
  validateAction, applyAction, createBuyAssetFromSyndicateAction, createCommissionBuildAction,
  createSpawnVehicleAction, createRemoveVehicleAction,
} = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const HOME = starterHomeAtDistance(6);
const DEST = HOME.id;
const DIST = HOME.distance; // 6 hexes, DEST's nearest waystation -> DEST

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`, ownerGuildId: guildId, landmarkId: systemId,
  landmarkKind: 'system', claimedAtTick: 0, contested: false,
});

// A guild homed on DEST, ledger-funded so invariant 2 starts balanced. Credits/fuel are ample
// by default (enough for any class's baseline + its own delivery burn) and overridable.
function buyState({ credits = 500_000_000, fuelHoard = 5_000 } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard, homeSystemId: DEST, homePlanetId: HOME.homePlanet }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims: [homeClaim('g1', DEST)],
  });
}

const buy = (assetKind, destinationSystemId = DEST, issueTick) =>
  createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind, destinationSystemId, issueTick });
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. vocabulary + per-class stats (the numbers, verbatim from phase-1-tuning) --------------

test('VEHICLE_SPECS carries the four classes with the phase-1-tuning §"Guild transports" numbers', () => {
  assert.deepEqual(VEHICLE_CLASSES, [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT]);
  assert.deepEqual(BUILDABLE_VEHICLE_KINDS, [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT]);
  assert.deepEqual(VEHICLE_SPECS[LIGHT_TRANSPORT], { speed: 105, capacity: 10000, fuelCostToRun: 0.5, defenseRating: 10 });
  assert.deepEqual(VEHICLE_SPECS[MEDIUM_TRANSPORT], { speed: 150, capacity: 50000, fuelCostToRun: 1.0, defenseRating: 20 });
  assert.deepEqual(VEHICLE_SPECS[HEAVY_TRANSPORT], { speed: 225, capacity: 6000000, fuelCostToRun: 100.0, defenseRating: 40 });
  assert.deepEqual(VEHICLE_SPECS[SPYCRAFT], { speed: 26.25, capacity: 0, fuelCostToRun: 20.0, defenseRating: 5 });
  // spycraft carries NO cargo — the value is exactly 0, not a placeholder.
  assert.equal(VEHICLE_SPECS[SPYCRAFT].capacity, 0);
});

test('isVehicleClass / vehicleSpec answer for the four classes and refuse anything else', () => {
  for (const c of VEHICLE_CLASSES) {
    assert.equal(isVehicleClass(c), true);
    assert.ok(vehicleSpec(c));
  }
  assert.equal(isVehicleClass(MINER), false, 'a ground-asset kind is not a vehicle class');
  assert.equal(isVehicleClass('galleon'), false);
  assert.equal(vehicleSpec('galleon'), null);
});

test('the id scheme mirrors assets: vehicle_<guild>_<class>_NN, NN from the per-guild mint serial', () => {
  assert.equal(vehicleId('g1', LIGHT_TRANSPORT, 1), 'vehicle_g1_lightTransport_01');
  assert.equal(vehicleId('g1', SPYCRAFT, 12), 'vehicle_g1_spycraft_12');
  // nextVehicleSerial reads the guild's STORED counter (design.md §15.4 "Ids never repeat"), NOT
  // the highest live suffix — so a removed craft's number is never re-derived and reissued.
  assert.equal(nextVehicleSerial({}), 1, 'no counter yet -> 1');
  assert.equal(nextVehicleSerial({ vehicleSerial: 0 }), 1);
  assert.equal(nextVehicleSerial({ vehicleSerial: 5 }), 6, 'one above the stored counter, spanning classes');
});

// --- 2. the catalog: ship bills beside the ground bills, under the same tripwire --------------

test('assetBill returns each ship bill, and the Tier-3 tripwire still passes with them added', () => {
  for (const c of BUILDABLE_VEHICLE_KINDS) {
    const bill = assetBill(c);
    assert.ok(bill && Object.keys(bill).length >= 4, `${c} has a real module bill`);
  }
  // Every ship-bill module is a real Tier-3 good — the load-time self-check already ran when the
  // module was required; re-run it over the four bills to pin it, and prove the guard still bites.
  assert.doesNotThrow(() => assertBillModulesAreTier3({
    [LIGHT_TRANSPORT]: assetBill(LIGHT_TRANSPORT),
    [HEAVY_TRANSPORT]: assetBill(HEAVY_TRANSPORT),
  }));
  assert.throws(
    () => assertBillModulesAreTier3({ [SPYCRAFT]: { ...assetBill(SPYCRAFT), warp_coil: 1 } }),
    /not a Tier-3 module good/,
  );
});

test('BUILD_TICKS and VEHICLE_BUY_BASELINE carry the four transports (phase-1-tuning)', () => {
  assert.equal(BUILD_TICKS[LIGHT_TRANSPORT], 360);
  assert.equal(BUILD_TICKS[MEDIUM_TRANSPORT], 960);
  assert.equal(BUILD_TICKS[HEAVY_TRANSPORT], 10080);
  assert.equal(BUILD_TICKS[SPYCRAFT], 10080);
  assert.equal(VEHICLE_BUY_BASELINE[LIGHT_TRANSPORT], 5_000_000);
  assert.equal(VEHICLE_BUY_BASELINE[MEDIUM_TRANSPORT], 15_000_000);
  assert.equal(VEHICLE_BUY_BASELINE[HEAVY_TRANSPORT], 200_000_000);
  assert.equal(VEHICLE_BUY_BASELINE[SPYCRAFT], 100_000_000);
});

test('price: the per-class baseline binds at today\'s parts scale (parts are near-nothing)', () => {
  const s = buyState();
  for (const c of BUILDABLE_VEHICLE_KINDS) {
    assert.equal(priceAssetForPurchase(s, c, s.tick), VEHICLE_BUY_BASELINE[c], `${c} priced at its baseline`);
  }
  // A ground asset still uses the flat 12M floor, not a vehicle baseline.
  assert.equal(priceAssetForPurchase(s, MINER, s.tick), ASSET_PURCHASE_FLOOR);
});

// --- 3. the BUY path: own fuel, own clock, minted into vehicles --------------------------------

test('buy: a bought transport burns its OWN fuelCostToRun × distance, not the heavy-hauler rate', () => {
  const s0 = buyState();
  const craftBurn = Math.ceil(DIST * VEHICLE_SPECS[LIGHT_TRANSPORT].fuelCostToRun); // ceil(6 × 0.5) = 3
  const heavyBurn = routeFuelCost(DEST, ASSET_CARGO_VOLUME).fuelBurn;               // ceil(6 × 0.7) = 5
  assert.notEqual(craftBurn, heavyBurn, 'the two rates differ, so the branch is observable');

  const creditsBefore = s0.guilds[0].credits;
  const fuelBefore = s0.guilds[0].fuelHoard;
  const s = accept(s0, buy(LIGHT_TRANSPORT));
  assert.equal(s.guilds[0].credits, creditsBefore - VEHICLE_BUY_BASELINE[LIGHT_TRANSPORT], 'debited the class baseline');
  assert.equal(s.guilds[0].fuelHoard, fuelBefore - craftBurn, 'burned the CRAFT\'s own rate, not the heavy rate');
  // A build order recorded, no vehicle yet, no shipment yet. Queued (remainingTicks null), not
  // yet started — the per-guild single-slot clock starts when it reaches the head.
  assert.equal(s.syndicateBuilds.length, 1);
  assert.equal(s.syndicateBuilds[0].assetKind, LIGHT_TRANSPORT);
  assert.equal(s.syndicateBuilds[0].remainingTicks, null, 'queued at buy, not yet started');
  assert.equal((s.guilds[0].vehicles || []).length, 0, 'no craft until it lands');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('buy: the delivery flies at the craft\'s OWN speed — arrival = completionTick + ceil(dist × speed)', () => {
  // Seed a head 5 ticks from completion (bypass the 360-tick construction) to exercise the arrival
  // clock. `remainingTicks` is the RELATIVE countdown, so it completes at tick 5.
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: DEST, homePlanetId: HOME.homePlanet }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, claims: [homeClaim('g1', DEST)],
    syndicateBuilds: [{ ownerGuildId: 'g1', assetKind: LIGHT_TRANSPORT, destinationSystemId: DEST, remainingTicks: 5, boughtTick: 0 }],
  });
  s = ticks(s, 5); // remainingTicks 5 → 0 at tick 5 — promoted
  assert.equal(s.shipments.length, 1);
  const ship = s.shipments[0];
  assert.equal(ship.assetKind, LIGHT_TRANSPORT);
  assert.equal(ship.cargo, undefined, 'a vehicle delivery carries no goods cargo');
  const craftArrival = 5 + Math.ceil(DIST * VEHICLE_SPECS[LIGHT_TRANSPORT].speed); // 5 + 630
  assert.equal(ship.arrivalTick, craftArrival, 'flies at the craft speed');
  assert.notEqual(ship.arrivalTick, arrivalTickFor(5, DIST), 'NOT the flat Syndicate CRAFT_SPEED');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('buy end-to-end: found → buy → build → deliver → an idle transport minted at the destination', () => {
  let s = accept(buyState(), buy(MEDIUM_TRANSPORT));
  assert.equal(s.syndicateBuilds[0].remainingTicks, null, 'queued at buy, not yet started');
  // The head starts the tick after buy, then counts down BUILD_TICKS — completing at buyTick + 1 + BUILD_TICKS.
  const completionTick = s.tick + 1 + BUILD_TICKS[MEDIUM_TRANSPORT];

  // Tick past construction — an asset-marked transit shipment appears.
  s = ticks(s, completionTick - s.tick);
  assert.equal(s.syndicateBuilds, undefined, 'construction finished (omit-when-empty)');
  assert.equal(s.shipments.length, 1);
  const arrivalTick = s.shipments[0].arrivalTick;
  assert.equal(arrivalTick, completionTick + Math.ceil(DIST * VEHICLE_SPECS[MEDIUM_TRANSPORT].speed));

  // The snapshot labels the transit manifest with the class marker (client slice reads it).
  assert.equal(buildSnapshot(s).shipments[0].assetKind, MEDIUM_TRANSPORT);

  // Tick to arrival — one NEW idle transport in guild.vehicles, at the destination, and NO asset.
  s = ticks(s, arrivalTick - s.tick);
  assert.equal((s.shipments || []).length, 0);
  const vehicles = s.guilds[0].vehicles;
  assert.equal(vehicles.length, 1, 'exactly one transport minted');
  const v = vehicles[0];
  assert.equal(v.class, MEDIUM_TRANSPORT);
  assert.equal(v.id, 'vehicle_g1_mediumTransport_01', 'a fresh stable id from the per-guild mint serial');
  assert.deepEqual(v.location, { landmarkKind: 'system', landmarkId: DEST }, 'minted at the destination system landmark');
  assert.equal(v.status, 'idle', 'minted idle — nothing moves it this slice');
  assert.equal(v.maintenanceCondition, 1, 'new = full (inert)');
  assert.equal(v.speed, VEHICLE_SPECS[MEDIUM_TRANSPORT].speed);
  assert.equal(v.capacity, VEHICLE_SPECS[MEDIUM_TRANSPORT].capacity);
  assert.equal(v.fuelCostToRun, VEHICLE_SPECS[MEDIUM_TRANSPORT].fuelCostToRun);
  assert.equal(v.defenseRating, VEHICLE_SPECS[MEDIUM_TRANSPORT].defenseRating);
  assert.equal((s.guilds[0].assets || []).length, 0, 'a transport is a vehicle, never a ground asset');
  // The snapshot's per-guild vehicles row mirrors the asset rows.
  const snapVehicles = buildSnapshot(s).guilds[0].vehicles;
  assert.deepEqual(snapVehicles, [{
    id: 'vehicle_g1_mediumTransport_01', class: MEDIUM_TRANSPORT,
    location: { landmarkKind: 'system', landmarkId: DEST },
    maintenanceCondition: 1, status: 'idle',
    cargo: {}, // 2.2 cargo slice 1: the row surfaces the hold as a stable {} (empty here — a minted craft carries none)
  }]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('buy: a spycraft mints with capacity EXACTLY 0 (no !capacity guard rejects it)', () => {
  let s = accept(buyState(), buy(SPYCRAFT));
  const completionTick = s.tick + 1 + BUILD_TICKS[SPYCRAFT];
  s = ticks(s, completionTick - s.tick);
  const arrivalTick = s.shipments[0].arrivalTick;
  s = ticks(s, arrivalTick - s.tick);
  const v = s.guilds[0].vehicles[0];
  assert.equal(v.class, SPYCRAFT);
  assert.equal(v.capacity, 0, 'spycraft carries no cargo');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. the BUILD path: a dockyard mints a transport at its own system -------------------------

test('build: a dockyard consumes the ship bill from its own system and mints an idle transport there', () => {
  const YARD_SYS = HOME.id; // a REAL seed system — a dockyard always sits in one (checkVehicleIntegrity)
  const bill = assetBill(LIGHT_TRANSPORT);
  let s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: { [YARD_SYS]: { ...bill } }, // exactly one light-transport bill on hand
      ventures: [{
        id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: YARD_SYS,
        dockyard: true,
        buildQueue: [{ commissionId: 0, assetKind: LIGHT_TRANSPORT, remainingTicks: null }],
        nextCommissionId: 1,
      }],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });

  // Tick 1 consumes the bill and sets the countdown; the modules are gone from the stockpile.
  s = tick(s);
  for (const module of Object.keys(bill)) {
    assert.equal(getStock(s.guilds[0], YARD_SYS, module), 0, `${module} consumed`);
  }
  assert.equal((s.guilds[0].vehicles || []).length, 0, 'nothing minted until the countdown ends');

  // Run out the countdown — emission lands BUILD_TICKS ticks after the consume tick.
  s = ticks(s, BUILD_TICKS[LIGHT_TRANSPORT]);
  const vehicles = s.guilds[0].vehicles;
  assert.equal(vehicles.length, 1, 'one transport minted by the dockyard');
  assert.equal(vehicles[0].class, LIGHT_TRANSPORT);
  assert.deepEqual(vehicles[0].location, { landmarkKind: 'system', landmarkId: YARD_SYS }, 'minted idle at the dockyard\'s own system landmark');
  assert.equal(vehicles[0].status, 'idle');
  assert.equal(vehicles[0].id, 'vehicle_g1_lightTransport_01');
  assert.equal((s.guilds[0].buildQueue || s.guilds[0].ventures[0].buildQueue).length, 0, 'the queue head shifted off');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('validate: commissionBuild and buyAssetFromSyndicate both accept the four transport classes', () => {
  // buy: a well-formed transport purchase validates (BUILDABLE_KINDS includes the four classes).
  const s = buyState();
  for (const c of BUILDABLE_VEHICLE_KINDS) {
    const { valid, reason } = validateAction(s, buy(c));
    assert.equal(valid, true, `buy ${c}: ${reason}`);
  }
  assert.ok(BUILDABLE_KINDS.includes(LIGHT_TRANSPORT), 'the combined buildable vocabulary carries transports');

  // commission: a dockyard can be commissioned to build each transport class.
  const ds = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: HOME.id, dockyard: true, buildQueue: [], nextCommissionId: 0 }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  for (const c of BUILDABLE_VEHICLE_KINDS) {
    const { valid, reason } = validateAction(ds, createCommissionBuildAction({ guildId: 'g1', ventureId: 'd1', assetKind: c }));
    assert.equal(valid, true, `commission ${c}: ${reason}`);
  }
});

// --- 5. the integrity invariant ----------------------------------------------------------------

test('checkVehicleIntegrity catches a bad class, an unresolvable location, a bad condition, an illegal status', () => {
  const mk = (over) => createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, vehicleSerial: 1,
      vehicles: [{
        id: 'vehicle_g1_lightTransport_01', ownerGuildId: 'g1', class: LIGHT_TRANSPORT, speed: 105, capacity: 10000,
        defenseRating: 10, fuelCostToRun: 0.5, location: { landmarkKind: 'system', landmarkId: DEST },
        maintenanceCondition: 1, status: 'idle', ...over,
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });

  assert.deepEqual(checkInvariants(mk({}), 0), [], 'a well-formed idle craft passes');

  const ruleOf = (over) => checkInvariants(mk(over), 0).map((x) => x.rule);
  assert.ok(ruleOf({ class: 'galleon' }).some((r) => r.startsWith('vehicle-class-known')), 'unknown class trips');
  assert.ok(ruleOf({ location: { landmarkKind: 'system', landmarkId: 'sys_not_real' } }).includes('vehicle-location-resolves'), 'unresolvable landmark trips');
  assert.ok(ruleOf({ maintenanceCondition: 1.5 }).includes('vehicle-condition-in-range'), 'out-of-range condition trips');
  assert.ok(ruleOf({ maintenanceCondition: 'x' }).includes('vehicle-condition-in-range'), 'non-number condition trips');
  assert.ok(ruleOf({ status: 'parked' }).includes('vehicle-status-legal'), 'illegal status trips');
  // The legal set is idle / inTransit (the design pair) plus `loading` (a craft in an Outpost dock
  // slot, 2.2 cargo engine slice 2 — design.md §4). `parked` above is still not a real status.
  assert.deepEqual(VEHICLE_STATUSES, ['idle', 'inTransit', 'loading']);
});

// --- 5b. the location model (landmark or bare hex) + its selector ------------------------------

test('resolveVehicleLocation accepts a system, an outpost, and an in-bounds hex; rejects the rest', () => {
  const sys = getSystem(DEST);
  const out = getOutpost('out_01');
  // A system landmark resolves to the system's coords.
  assert.deepEqual(resolveVehicleLocation({ landmarkKind: 'system', landmarkId: DEST }), { form: 'landmark', coords: { q: sys.coords.q, r: sys.coords.r } });
  // An outpost is an EQUAL anchor (not deep space) and resolves to its coords.
  assert.deepEqual(resolveVehicleLocation({ landmarkKind: 'outpost', landmarkId: 'out_01' }), { form: 'landmark', coords: { q: out.coords.q, r: out.coords.r } });
  // A bare in-bounds hex resolves to itself (the Citadel origin is in-bounds).
  assert.deepEqual(resolveVehicleLocation({ q: 0, r: 0 }), { form: 'hex', coords: { q: 0, r: 0 } });

  // Corruption, every shape → null:
  assert.equal(resolveVehicleLocation(null), null, 'no location');
  assert.equal(resolveVehicleLocation({}), null, 'both-null (neither form)');
  assert.equal(resolveVehicleLocation({ landmarkKind: 'system', landmarkId: DEST, q: 0, r: 0 }), null, 'both-set');
  assert.equal(resolveVehicleLocation({ landmarkKind: 'system', landmarkId: 'sys_not_real' }), null, 'unresolvable landmark');
  assert.equal(resolveVehicleLocation({ landmarkKind: 'citadel', landmarkId: 'citadel' }), null, 'citadel is not a transport anchor');
  assert.equal(resolveVehicleLocation({ q: 100000, r: 100000 }), null, 'off-lattice hex');
  assert.equal(resolveVehicleLocation({ q: 1.5, r: 0 }), null, 'a non-integer is not a hex');
});

test('vehicleCoords resolves ANY vehicle location to coords; the invariant rejects both-set, both-null, off-lattice', () => {
  const sys = getSystem(DEST);
  assert.deepEqual(vehicleCoords({ location: { landmarkKind: 'system', landmarkId: DEST } }), { q: sys.coords.q, r: sys.coords.r });
  assert.deepEqual(vehicleCoords({ location: { q: 0, r: 0 } }), { q: 0, r: 0 });
  assert.equal(vehicleCoords({ location: {} }), null);

  // The invariant accepts an outpost berth and a bare hex, and trips on the three corrupt shapes.
  const mk = (location) => createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, vehicleSerial: 1,
      vehicles: [{
        id: 'vehicle_g1_lightTransport_01', ownerGuildId: 'g1', class: LIGHT_TRANSPORT, speed: 105, capacity: 10000,
        defenseRating: 10, fuelCostToRun: 0.5, location, maintenanceCondition: 1, status: 'idle',
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  assert.deepEqual(checkInvariants(mk({ landmarkKind: 'outpost', landmarkId: 'out_01' }), 0), [], 'an outpost berth is legal');
  assert.deepEqual(checkInvariants(mk({ q: 0, r: 0 }), 0), [], 'a bare in-bounds hex is legal');
  const trips = (loc) => checkInvariants(mk(loc), 0).map((x) => x.rule).includes('vehicle-location-resolves');
  assert.ok(trips({ landmarkKind: 'system', landmarkId: DEST, q: 0, r: 0 }), 'both-set trips');
  assert.ok(trips({}), 'both-null trips');
  assert.ok(trips({ q: 999999, r: 999999 }), 'off-lattice hex trips');
});

// --- 5c. the spawn / remove primitive (design.md §15.4, roadmap 2.2 spawn) ---------------------

// A bare guild with no home claim — spawn/remove touch no credits/fuel/points/reputation/claims,
// so nothing needs seating; the ledger is balanced so createState opens invariant-clean.
function spawnState() {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
}
const spawn = (over = {}) => createSpawnVehicleAction({
  guildId: 'g1', class: LIGHT_TRANSPORT, location: { landmarkKind: 'system', landmarkId: DEST }, ...over,
});

test('spawn: at a system, an outpost, and a bare hex each mints an idle craft with the serial id', () => {
  let s = spawnState();
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { landmarkKind: 'system', landmarkId: DEST } }));
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: { landmarkKind: 'outpost', landmarkId: 'out_01' } }));
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: SPYCRAFT, location: { q: 0, r: 0 } }));
  const vs = s.guilds[0].vehicles;
  assert.equal(vs.length, 3);
  // The serial is per-GUILD and spans classes: 01, 02, 03 regardless of class.
  assert.deepEqual(vs.map((v) => v.id), [
    'vehicle_g1_lightTransport_01', 'vehicle_g1_heavyTransport_02', 'vehicle_g1_spycraft_03',
  ]);
  assert.equal(s.guilds[0].vehicleSerial, 3);
  for (const v of vs) { assert.equal(v.status, 'idle', 'minted idle'); assert.equal(v.maintenanceCondition, 1, 'default new'); }
  assert.deepEqual(vs[0].location, { landmarkKind: 'system', landmarkId: DEST });
  assert.deepEqual(vs[1].location, { landmarkKind: 'outpost', landmarkId: 'out_01' });
  assert.deepEqual(vs[2].location, { q: 0, r: 0 });
  assert.equal(vs[2].capacity, 0, 'a spawned spycraft carries no cargo');
  // Spawn moves NOTHING else — no credits/fuel change, no asset minted, invariants clean.
  assert.equal(s.guilds[0].credits, 0);
  assert.equal(s.guilds[0].fuelHoard, 0);
  assert.equal((s.guilds[0].assets || []).length, 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('spawn: condition defaults to new and is settable in [0,1]; bad inputs refuse-whole', () => {
  let s = spawnState();
  s = accept(s, spawn({ condition: 0.5 }));
  assert.equal(s.guilds[0].vehicles[0].maintenanceCondition, 0.5, 'the settable condition lands on the craft');
  const bad = (over) => validateAction(spawnState(), spawn(over)).valid;
  assert.equal(bad({ condition: 1.5 }), false, 'condition above 1 refused');
  assert.equal(bad({ condition: -0.1 }), false, 'condition below 0 refused');
  assert.equal(bad({ class: 'galleon' }), false, 'unknown class refused');
  assert.equal(bad({ location: { landmarkKind: 'system', landmarkId: 'sys_not_real' } }), false, 'unresolvable location refused');
  assert.equal(bad({ location: {} }), false, 'no location form refused');
  assert.equal(bad({ location: { landmarkKind: 'system', landmarkId: DEST, q: 0, r: 0 } }), false, 'both-set location refused');
  assert.equal(validateAction(spawnState(), createSpawnVehicleAction({ guildId: 'ghost', class: LIGHT_TRANSPORT, location: { landmarkKind: 'system', landmarkId: DEST } })).valid, false, 'unknown guild refused');
});

test('remove: drops the craft by id; the serial does NOT decrement, and an unknown id refuses', () => {
  let s = spawnState();
  s = accept(s, spawn());
  const id = s.guilds[0].vehicles[0].id;
  assert.equal(validateAction(s, createRemoveVehicleAction({ guildId: 'g1', vehicleId: 'vehicle_g1_lightTransport_99' })).valid, false, 'unknown id refused');
  s = accept(s, createRemoveVehicleAction({ guildId: 'g1', vehicleId: id }));
  assert.equal(s.guilds[0].vehicles.length, 0, 'the row is dropped — destruction, not recall');
  assert.equal(s.guilds[0].vehicleSerial, 1, 'the serial is untouched by removal');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('spawn→remove→spawn: the removed id is never reissued (serial monotonic, design.md §15.4)', () => {
  let s = spawnState();
  s = accept(s, spawn()); // _01
  const firstId = s.guilds[0].vehicles[0].id;
  s = accept(s, createRemoveVehicleAction({ guildId: 'g1', vehicleId: firstId }));
  s = accept(s, spawn()); // _02, NOT _01 — the max-based derivation would have reissued _01
  const vs = s.guilds[0].vehicles;
  assert.equal(vs.length, 1);
  assert.notEqual(vs[0].id, firstId, 'the removed id is not reissued');
  assert.equal(vs[0].id, 'vehicle_g1_lightTransport_02');
  assert.equal(s.guilds[0].vehicleSerial, 2);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('determinism: a spawn→remove→spawn sequence run twice is byte-identical (invariant 9)', () => {
  const run = () => {
    let s = spawnState();
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: { landmarkKind: 'outpost', landmarkId: 'out_01' } }));
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: SPYCRAFT, location: { q: 0, r: 0 }, condition: 0.25 }));
    s = accept(s, createRemoveVehicleAction({ guildId: 'g1', vehicleId: 'vehicle_g1_heavyTransport_01' }));
    s = accept(s, spawn());
    return s;
  };
  assert.equal(hashState(run()), hashState(run()));
});

// --- 6. determinism ----------------------------------------------------------------------------

test('determinism: a buy-and-build transport scenario run twice is byte-identical (invariant 9)', () => {
  const run = () => {
    let s = accept(buyState(), buy(HEAVY_TRANSPORT));           // a heavy: 200M baseline, own 600-fuel flight
    s = accept(s, buy(SPYCRAFT, DEST, s.tick));                 // a second class, same tick
    return ticks(s, 40);                                        // deep into construction
  };
  assert.equal(hashState(run()), hashState(run()));
});
