'use strict';

// dispatch.test.js — the guild-transport dispatch + arrival tier, roadmap 2.2 (b1)
// (transport-model.md §4 "the polyline model"; design.md §15.4 the Vehicle movement contract). A
// guild sends an IDLE craft along a multi-leg route (an ordered list of location-anchor waypoints):
// the whole route's fuel is burned from the hoard UP FRONT, the schedule is frozen at dispatch, and
// the ONLY tick step is the final arrival, which lands the craft idle at its last anchor.
//
// The tripwires, one per ruling:
//   - the LEG MATH helpers (transport.js): legTicks/legFuelBurn halve ticks/fuel on an isToll leg
//     (the buff path is present and directly tested, though this slice flies every leg open space);
//   - DISPATCH freezes a CONTIGUOUS schedule with the right final arrivalTick and burns Σ the per-leg
//     unit costs from the hoard, whole route, up front (the credit figure floats, the units gate);
//   - the ARRIVAL step lands the craft idle at the FINAL anchor — a landmark (system / outpost) →
//     idle there; a bare hex → idle in deep space — and lands ONLY at trip.arrivalTick, never at an
//     intermediate leg;
//   - a dispatch is REFUSED WHOLE when the hoard can't cover the sum (craft stays idle, hoard flat);
//   - each ruled FAILURE MODE is rejected: zero-length leg, off-lattice waypoint, empty waypoints,
//     non-idle craft (plus unknown guild / craft);
//   - the INVARIANT accepts idle-with-location and inTransit-with-valid-trip, and rejects a craft
//     that is both / neither, a non-contiguous trip, and a trip whose arrivalTick disagrees with its
//     last leg;
//   - DETERMINISM (invariant 9): a dispatch→…→arrival run replays byte-identically, and a restart
//     mid-route still lands on the right absolute tick;
//   - the SNAPSHOT surfaces the in-flight route (resolved leg coords + ticks + credit fuel cost);
//   - the NO-OP: an idle craft that dispatches nothing rides ticks unchanged (the arrival step is
//     inert on it), so a craft-less / idle-only galaxy is byte-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const {
  hexDistance, legTicks, legFuelBurn, TOLL_BUFF,
} = require('../transport.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const { getSystem, getOutpost } = require('../seed.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchVehicleAction,
} = require('../actions.js');

const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT]; // speed 105, fuelCostToRun 0.5
const VID = 'vehicle_g1_lightTransport_01';

// A bare guild with an idle light craft at the origin hex {0,0}, `fuelHoard` overridable. Dispatch
// touches no claims, so nothing needs seating; the ledger is balanced so createState opens clean.
function withIdleCraft({ fuelHoard = 500, deuteriumFuel } = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard };
  if (deuteriumFuel !== undefined) guild.deuteriumFuel = deuteriumFuel;
  let s = createState({
    guilds: [guild], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { q: 0, r: 0 } }));
  return s;
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected refused');
  return reason;
};
const dispatch = (waypoints) => createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints });
const craftOf = (s) => s.guilds[0].vehicles.find((v) => v.id === VID);
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. the leg-math helpers (the one home of the §2.2 formula) --------------------------------

test('legTicks / legFuelBurn: ceil, and an isToll leg halves BOTH ticks and fuel (TOLL_BUFF)', () => {
  assert.equal(TOLL_BUFF, 2, 'the doc-ruled buff, §2.2');
  // ceil throughout (§2.1): a part-tick is a whole tick, a part-unit is a whole unit.
  assert.equal(legTicks(3, 105, false), 315);
  assert.equal(legFuelBurn(3, 0.5, false), 2, 'ceil(1.5) = 2');
  // The buff path — half the ticks and half the fuel, each ceil'd — is present and honoured now,
  // so the later toll slice only supplies the flag.
  assert.equal(legTicks(10, 105, true), Math.ceil((10 * 105) / 2));
  assert.equal(legTicks(10, 105, true) * 2, legTicks(10, 105, false) + 0, 'a toll leg is half an open-space leg (even case)');
  assert.equal(legFuelBurn(10, 0.5, true), 3, 'ceil(2.5) = 3');
  assert.equal(legFuelBurn(10, 0.5, false), 5, 'ceil(5) = 5 — half is 3 after ceil');
});

// --- 2. dispatch freezes a contiguous schedule + burns the whole route up front -----------------

test('a multi-leg dispatch freezes a contiguous schedule with the right final arrivalTick', () => {
  // {0,0} -> {3,0} (len 3) -> {3,4} (len 4), a light craft (speed 105).
  const s = accept(withIdleCraft(), dispatch([{ q: 3, r: 0 }, { q: 3, r: 4 }]));
  const craft = craftOf(s);
  assert.equal(craft.status, 'inTransit');
  assert.equal(craft.location, undefined, 'an in-transit craft carries no bare location (§15.4)');

  const t0 = legTicks(3, LIGHT.speed, false); // 315
  const t1 = legTicks(4, LIGHT.speed, false); // 420
  assert.deepEqual(craft.trip.legs.map((l) => [l.departureTick, l.arrivalTick]), [[0, t0], [t0, t0 + t1]]);
  assert.equal(craft.trip.dispatchTick, 0);
  assert.equal(craft.trip.arrivalTick, t0 + t1, 'trip.arrivalTick == the last leg\'s arrivalTick');
  // Anchors stored AS GIVEN (leg 0 from = the craft's own location; the waypoints thereafter).
  assert.deepEqual(craft.trip.legs[0].from, { q: 0, r: 0 });
  assert.deepEqual(craft.trip.legs[0].to, { q: 3, r: 0 });
  assert.deepEqual(craft.trip.legs[1].to, { q: 3, r: 4 });
  assert.equal(craft.trip.legs.every((l) => l.isToll === false), true, 'every leg flies open space this slice');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the dispatched state is invariant-clean');
});

test('dispatch burns Σ the per-leg unit costs from the hoard, whole route, up front', () => {
  const before = withIdleCraft({ fuelHoard: 500 });
  const s = accept(before, dispatch([{ q: 3, r: 0 }, { q: 3, r: 4 }]));
  const expected = legFuelBurn(3, LIGHT.fuelCostToRun, false) + legFuelBurn(4, LIGHT.fuelCostToRun, false); // 2 + 2
  assert.equal(s.guilds[0].fuelHoard, 500 - expected, 'the whole route left the hoard at dispatch');
  assert.equal(s.audit.totalConsumed, expected, 'the burn is recorded so invariant 1 balances');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'galactic-supply consistency holds across the burn');
});

// --- 3. the arrival step: land idle at the final anchor, only at trip.arrivalTick ----------------

// A directly-built in-transit craft (a valid frozen trip), so the landing anchor can be exercised
// without running a real craft's long schedule. Built idle (createVehicle requires a location) and
// then mutated into flight exactly as the dispatch apply does — drop location, add the trip. This
// synthetic state moves no fuel, so its audit balances at 0 with an empty hoard.
function inTransitTo(toAnchor, { arrivalTick = 1, legs } = {}) {
  const trip = legs
    ? { legs, dispatchTick: 0, arrivalTick: legs[legs.length - 1].arrivalTick }
    : { legs: [{ from: { q: 0, r: 0 }, to: toAnchor, isToll: false, departureTick: 0, arrivalTick }], dispatchTick: 0, arrivalTick };
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, vehicleSerial: 1,
      vehicles: [{
        id: VID, ownerGuildId: 'g1', class: LIGHT_TRANSPORT, speed: LIGHT.speed, capacity: LIGHT.capacity,
        defenseRating: LIGHT.defenseRating, fuelCostToRun: LIGHT.fuelCostToRun,
        location: { q: 0, r: 0 }, maintenanceCondition: 1, status: 'idle',
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  const craft = craftOf(s);
  craft.status = 'inTransit';
  craft.trip = trip;
  delete craft.location;
  return s;
}

test('arrival lands the craft IDLE at a landmark final anchor (system, then outpost)', () => {
  for (const anchor of [{ landmarkKind: 'system', landmarkId: 'sys_0006' }, { landmarkKind: 'outpost', landmarkId: 'out_01' }]) {
    const landed = craftOf(ticks(inTransitTo(anchor, { arrivalTick: 1 }), 1));
    assert.equal(landed.status, 'idle');
    assert.equal(landed.trip, undefined, 'the trip is dropped on arrival');
    assert.deepEqual(landed.location, anchor, 'idle AT the final landmark');
  }
});

test('arrival lands the craft IDLE at a bare-hex final anchor (deep space)', () => {
  const landed = craftOf(ticks(inTransitTo({ q: 7, r: -2 }, { arrivalTick: 1 }), 1));
  assert.equal(landed.status, 'idle');
  assert.deepEqual(landed.location, { q: 7, r: -2 }, 'idle in deep space at the final hex');
  assert.equal(landed.trip, undefined);
});

test('arrival lands ONLY at trip.arrivalTick, never at an intermediate leg boundary', () => {
  // Two legs: leg 0 arrives at tick 5, the WHOLE trip at tick 10. The craft must NOT land at 5.
  const legs = [
    { from: { q: 0, r: 0 }, to: { q: 1, r: 0 }, isToll: false, departureTick: 0, arrivalTick: 5 },
    { from: { q: 1, r: 0 }, to: { q: 9, r: -2 }, isToll: false, departureTick: 5, arrivalTick: 10 },
  ];
  let s = inTransitTo(null, { legs });
  s = ticks(s, 6); // past leg 0's arrival (5), before the trip's (10)
  assert.equal(craftOf(s).status, 'inTransit', 'leg 0 arriving is NOT a landing — only the final leg is');
  s = ticks(s, 4); // reach tick 10
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { q: 9, r: -2 }, 'idle at the FINAL leg\'s anchor');
});

test('a real dispatch flies then lands idle at its final anchor (end to end)', () => {
  // {0,0} -> {1,0} (len 1) -> {1,1} (len 1); light craft, so each leg is 105 ticks (arr 105, 210).
  let s = accept(withIdleCraft(), dispatch([{ q: 1, r: 0 }, { q: 1, r: 1 }]));
  const arr = craftOf(s).trip.arrivalTick; // 210
  s = ticks(s, arr - 1);
  assert.equal(craftOf(s).status, 'inTransit', 'still flying the tick before arrival');
  s = ticks(s, 1);
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { q: 1, r: 1 }, 'idle at the final waypoint');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. refuse-whole gates + the ruled failure modes -------------------------------------------

test('a dispatch the hoard cannot cover is refused whole — craft stays idle, hoard unchanged', () => {
  // A route that needs 2 fuel, with only 1 in the hoard (and no contraband).
  const before = withIdleCraft({ fuelHoard: 1 });
  const reason = refuse(before, dispatch([{ q: 3, r: 0 }])); // len 3 -> legFuelBurn(3,0.5) = 2
  assert.match(reason, /refused whole/);
  // Nothing moved: the craft is still idle at its berth and the hoard is untouched.
  assert.equal(craftOf(before).status, 'idle');
  assert.equal(before.guilds[0].fuelHoard, 1);
});

test('the combined-availability gate counts contraband deuteriumFuel too', () => {
  // 1 legal + 1 contraband covers a 2-unit route; burnFuel spends the hoard first.
  const s = accept(withIdleCraft({ fuelHoard: 1, deuteriumFuel: 1 }), dispatch([{ q: 3, r: 0 }]));
  assert.equal(craftOf(s).status, 'inTransit');
  assert.equal(s.guilds[0].fuelHoard, 0, 'legal fuel spent first');
  assert.equal(s.guilds[0].deuteriumFuel, 0, 'the remainder came from contraband');
});

test('each ruled failure mode is rejected (zero-length leg, off-lattice, empty, non-idle)', () => {
  const s = withIdleCraft();
  // Zero-length: the first waypoint IS the craft's own hex {0,0}.
  assert.match(refuse(s, dispatch([{ q: 0, r: 0 }])), /zero-length/);
  // Zero-length mid-route: a back-to-back duplicate anchor.
  assert.match(refuse(s, dispatch([{ q: 3, r: 0 }, { q: 3, r: 0 }])), /zero-length/);
  // Off-lattice waypoint (out of the galaxy's hex bounds).
  assert.match(refuse(s, dispatch([{ q: 999999, r: 999999 }])), /does not resolve/);
  // An unresolvable landmark waypoint.
  assert.match(refuse(s, dispatch([{ landmarkKind: 'system', landmarkId: 'sys_not_real' }])), /does not resolve/);
  // Empty waypoints — a route needs at least one leg.
  assert.match(refuse(s, dispatch([])), /non-empty/);
  // A non-idle craft cannot be dispatched: send it flying, then try again.
  const flying = accept(s, dispatch([{ q: 3, r: 0 }]));
  assert.match(refuse(flying, dispatch([{ q: 5, r: 0 }])), /not idle/);
  // Unknown guild / craft.
  assert.match(refuse(s, createDispatchVehicleAction({ guildId: 'ghost', vehicleId: VID, waypoints: [{ q: 1, r: 0 }] })), /no guild/);
  assert.match(refuse(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: 'vehicle_g1_lightTransport_09', waypoints: [{ q: 1, r: 0 }] })), /owns no vehicle/);
});

// --- 5. the integrity invariant branches on status ---------------------------------------------

test('checkVehicleIntegrity: idle-with-location and inTransit-with-valid-trip pass; corruption fails', () => {
  const rulesOf = (s) => checkInvariants(s, s.tick).map((x) => x.rule);
  // A well-formed in-transit craft passes.
  assert.deepEqual(checkInvariants(inTransitTo({ q: 7, r: -2 }, { arrivalTick: 5 }), 0), []);

  // Build a corrupt in-transit craft by mutating a clean one.
  const corrupt = (mutate) => {
    const s = inTransitTo({ q: 7, r: -2 }, { arrivalTick: 5 });
    mutate(craftOf(s));
    return rulesOf(s);
  };
  // BOTH a location and a trip (both-set) — corruption.
  assert.ok(corrupt((v) => { v.location = { q: 0, r: 0 }; }).includes('vehicle-intransit-no-location'));
  // A non-contiguous trip.
  assert.ok(corrupt((v) => {
    v.trip.legs = [
      { from: { q: 0, r: 0 }, to: { q: 1, r: 0 }, isToll: false, departureTick: 0, arrivalTick: 5 },
      { from: { q: 1, r: 0 }, to: { q: 9, r: -2 }, isToll: false, departureTick: 6, arrivalTick: 10 }, // dep 6 != prior arr 5
    ];
    v.trip.arrivalTick = 10;
  }).includes('vehicle-trip-valid'));
  // trip.arrivalTick disagreeing with the last leg.
  assert.ok(corrupt((v) => { v.trip.arrivalTick += 1; }).includes('vehicle-trip-valid'));
  // A zero-length leg (arrivalTick not > departureTick) survives nowhere — the invariant rejects it.
  assert.ok(corrupt((v) => { v.trip.legs[0].arrivalTick = v.trip.legs[0].departureTick; }).includes('vehicle-trip-valid'));
});

test('checkVehicleIntegrity: an idle craft carrying a trip, or an inTransit craft with no trip, fail', () => {
  const rulesOf = (s) => checkInvariants(s, s.tick).map((x) => x.rule);
  // Idle craft that also carries a trip (both-set the other way).
  const idleWithTrip = withIdleCraft();
  craftOf(idleWithTrip).trip = { legs: [{ from: { q: 0, r: 0 }, to: { q: 1, r: 0 }, isToll: false, departureTick: 0, arrivalTick: 1 }], dispatchTick: 0, arrivalTick: 1 };
  assert.ok(rulesOf(idleWithTrip).includes('vehicle-idle-no-trip'));
  // An in-transit craft with NO trip (both-neither) — no trip to fly.
  const flyingNoTrip = inTransitTo({ q: 7, r: -2 }, { arrivalTick: 5 });
  delete craftOf(flyingNoTrip).trip;
  assert.ok(rulesOf(flyingNoTrip).includes('vehicle-trip-valid'));
});

// --- 6. determinism (invariant 9): replay + restart mid-route -----------------------------------

test('a dispatch→…→arrival run replays byte-identically', () => {
  const run = () => {
    let s = accept(withIdleCraft(), dispatch([{ q: 1, r: 0 }, { q: 1, r: 1 }]));
    return hashState(ticks(s, 210)); // past arrival (210)
  };
  assert.equal(run(), run(), 'same inputs, same next state');
});

test('a restart MID-ROUTE still lands on the right absolute tick (persistence IS the mid-flight story)', () => {
  const dispatched = accept(withIdleCraft(), dispatch([{ q: 1, r: 0 }, { q: 1, r: 1 }]));
  const arr = craftOf(dispatched).trip.arrivalTick; // 210

  // Continuous: fly the whole way in one process.
  const continuous = ticks(dispatched, arr);

  // Restarted: fly partway, round-trip through JSON (a save/reload), then fly the rest.
  const mid = ticks(dispatched, 100);
  const reloaded = JSON.parse(JSON.stringify(mid));
  const resumed = ticks(reloaded, arr - 100);

  assert.equal(craftOf(resumed).status, 'idle');
  assert.equal(craftOf(resumed).updatedAtTick, arr, 'landed on the frozen absolute arrival tick');
  assert.equal(hashState(resumed), hashState(continuous), 'the reload lands exactly where the continuous run did');
});

// --- 7. the snapshot surfaces the in-flight route ----------------------------------------------

test('the snapshot emits an in-transit craft\'s route: resolved leg coords, ticks, and credit fuel cost', () => {
  const s = accept(withIdleCraft(), dispatch([{ q: 3, r: 0 }, { q: 3, r: 4 }]));
  const row = buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);
  assert.equal(row.status, 'inTransit');
  assert.equal(row.location, undefined, 'no idle location on an in-transit row');
  assert.equal(row.trip.legs.length, 2);
  // Endpoints are RESOLVED coords (derived on read), not the raw anchors.
  assert.deepEqual(row.trip.legs[0].from, { q: 0, r: 0 });
  assert.deepEqual(row.trip.legs[1].to, { q: 3, r: 4 });
  assert.deepEqual(row.trip.legs.map((l) => [l.departureTick, l.arrivalTick]), [[0, 315], [315, 735]]);
  assert.equal(row.trip.arrivalTick, 735);
  // The credit fuel cost = fuelValue(Σ units, fuelPrice). Σ units = 2 + 2; price is the reference 10.
  const units = legFuelBurn(3, LIGHT.fuelCostToRun, false) + legFuelBurn(4, LIGHT.fuelCostToRun, false);
  assert.equal(row.trip.fuelCost, units * s.reserve.fuelPrice, 'credit-equivalent at the live fuel price');

  // An idle craft's row is unchanged (location, no trip).
  const idle = buildSnapshot(withIdleCraft()).guilds[0].vehicles.find((v) => v.id === VID);
  assert.deepEqual(idle.location, { q: 0, r: 0 });
  assert.equal(idle.trip, undefined);
});

// --- 8. the no-op: an idle craft rides ticks unchanged -----------------------------------------

test('an idle craft that dispatches nothing is inert across the arrival step (no-op)', () => {
  const s0 = withIdleCraft();
  const s1 = ticks(s0, 5);
  const craft = craftOf(s1);
  assert.equal(craft.status, 'idle', 'the arrival step never touches an idle craft');
  assert.deepEqual(craft.location, { q: 0, r: 0 });
  assert.equal(craft.trip, undefined);
});
