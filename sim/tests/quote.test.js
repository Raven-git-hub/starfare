'use strict';

// quote.test.js — the read-only dispatch quote, roadmap 2.2 (b2b-1)
// (transport-model.md §4 "the polyline model" / §18 "the engine owns the game numbers"). The
// route-planner's small engine prerequisite: `quoteDispatch(state, { guildId, vehicleId, waypoints })`
// is the READ-ONLY PROJECTION of a `dispatchVehicle`, sharing `dispatchRoute` and the §2.2 leg math so a
// quote and the dispatch it previews can never disagree. It computes every game number the planner shows
// (§18) and MUTATES NOTHING.
//
// The tripwires, one per ruling:
//   - an OK quote's per-leg ticks/fuel SUM to totalTicks/totalUnits, credits == fuelValue(totalUnits,
//     reserve.fuelPrice), and arrivalTick == state.tick + totalTicks (at tick 0 and ticked-forward);
//   - `affordable` flips correctly around the hoard (+ contraband) covering totalUnits;
//   - the SHARE-THE-HELPER proof: the quote's totalUnits equals what a real dispatchVehicle actually
//     burns for the same route (quote and dispatch cannot drift);
//   - each ruled FAILURE MODE returns { ok: false } with a clear reason (empty / unresolvable waypoint /
//     zero-length leg / non-idle craft / unknown guild / unknown vehicle) — the SAME messages the
//     dispatch validate gives;
//   - READ-ONLY: quoting a route any number of times leaves the state byte-identical (no journal, no
//     tick, no snapshot);
//   - (slice 2a.1) the quote takes the SAME craft → W1 zero-length skip the actioned dispatch takes
//     (transport-model.md §11.4 / §11.9): a craft already on W1 quotes only the REAL onward legs — the
//     legs, fuel and arrival `dispatchRouteWithActions` then really flies — and a one-stop route at its own
//     berth quotes as acting in place (no legs, 0 ticks, 0 fuel, arrival now). An internal dead leg is
//     still refused.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { legTicks, legFuelBurn } = require('../transport.js');
const { fuelValue } = require('../fuel.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchVehicleAction, quoteDispatch,
  createDispatchRouteWithActionsAction,
} = require('../actions.js');

const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT]; // speed 105, fuelCostToRun 0.5
const VID = 'vehicle_g1_lightTransport_01';

// A bare guild with an idle light craft at the origin hex {0,0}, `fuelHoard`/`deuteriumFuel` overridable
// (mirrors dispatch.test.js's helper). Quoting touches no claims, so nothing needs seating.
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
const quote = (state, waypoints) => quoteDispatch(state, { guildId: 'g1', vehicleId: VID, waypoints });
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. an OK quote's sums, credit cost, and arrival ---------------------------------------------

test('an OK multi-leg quote: per-leg ticks/fuel sum to the totals, credits + arrival are authoritative', () => {
  // {0,0} -> {3,0} (len 3) -> {3,4} (len 4), a light craft (speed 105).
  const s = withIdleCraft();
  const q = quote(s, [{ q: 3, r: 0 }, { q: 3, r: 4 }]);
  assert.equal(q.ok, true);
  assert.equal(q.legs.length, 2);

  // Per-leg numbers are the §2.2 leg math on dispatchRoute's own lengths (3 and 4), isToll false.
  assert.deepEqual(q.legs.map((l) => l.length), [3, 4]);
  assert.deepEqual(q.legs.map((l) => l.ticks), [legTicks(3, LIGHT.speed, false), legTicks(4, LIGHT.speed, false)]);
  assert.deepEqual(q.legs.map((l) => l.fuel), [legFuelBurn(3, LIGHT.fuelCostToRun, false), legFuelBurn(4, LIGHT.fuelCostToRun, false)]);

  // The totals are the sums of the per-leg breakdown.
  assert.equal(q.totalTicks, q.legs.reduce((a, l) => a + l.ticks, 0));
  assert.equal(q.totalUnits, q.legs.reduce((a, l) => a + l.fuel, 0), 'totalUnits == Σ per-leg fuel');

  // The credit cost is the live-priced mark-to-market of the whole-route burn, exactly the snapshot's rule.
  assert.equal(q.credits, fuelValue(q.totalUnits, s.reserve.fuelPrice));
  // Arrival is the absolute tick the contiguous schedule lands on: state.tick + totalTicks.
  assert.equal(q.arrivalTick, s.tick + q.totalTicks);
  assert.equal(q.arrivalTick, q.totalTicks, 'at tick 0 the arrival is just the duration');
});

test('arrivalTick is measured from the CURRENT tick (ticked-forward state)', () => {
  const s = ticks(withIdleCraft(), 3); // advance the galaxy; an idle craft just rides ticks
  assert.equal(s.tick, 3);
  const q = quote(s, [{ q: 3, r: 0 }]);
  assert.equal(q.ok, true);
  assert.equal(q.arrivalTick, 3 + q.totalTicks, 'arrival = state.tick + totalTicks');
});

// --- 2. affordability flips around the hoard (+ contraband) covering totalUnits ------------------

test('`affordable` flips correctly around the combined hoard covering totalUnits', () => {
  // The route {0,0}->{3,0}->{3,4} burns legFuelBurn(3)+legFuelBurn(4) = 2 + 2 = 4 units.
  const wp = [{ q: 3, r: 0 }, { q: 3, r: 4 }];
  const need = legFuelBurn(3, LIGHT.fuelCostToRun, false) + legFuelBurn(4, LIGHT.fuelCostToRun, false);
  assert.equal(need, 4);

  // Exactly enough legal fuel → affordable.
  assert.equal(quote(withIdleCraft({ fuelHoard: need }), wp).affordable, true);
  // One short, no contraband → not affordable (but STILL a valid ok quote — quoteDispatch never gates fuel).
  const short = quote(withIdleCraft({ fuelHoard: need - 1 }), wp);
  assert.equal(short.ok, true, 'an unaffordable route is a valid quote, not a refusal');
  assert.equal(short.affordable, false);
  assert.equal(short.totalUnits, need, 'the cost is reported even when unaffordable');
  // Contraband deuteriumFuel counts toward the combined gate (the same availability the dispatch uses).
  assert.equal(quote(withIdleCraft({ fuelHoard: need - 1, deuteriumFuel: 1 }), wp).affordable, true);
});

// --- 3. share-the-helper proof: the quote's units == the real dispatch's burn --------------------

test('the quote\'s totalUnits equals what a real dispatchVehicle burns for the same route', () => {
  const wp = [{ q: 3, r: 0 }, { q: 3, r: 4 }];
  const before = withIdleCraft({ fuelHoard: 500 });
  const q = quote(before, wp);
  assert.equal(q.ok, true);

  // Dispatch the SAME route for real and measure the hoard drop.
  const after = accept(before, createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints: wp }));
  const burned = before.guilds[0].fuelHoard - after.guilds[0].fuelHoard;
  assert.equal(burned, q.totalUnits, 'quote and dispatch cannot drift — they share dispatchRoute');
  assert.equal(after.audit.totalConsumed, q.totalUnits);
  // The real trip's frozen arrivalTick matches the quote's projected one, too.
  assert.equal(after.guilds[0].vehicles.find((v) => v.id === VID).trip.arrivalTick, q.arrivalTick);
});

// --- 4. the ruled failure modes each return { ok: false } with a clear reason --------------------

test('each ruled failure mode returns { ok: false } with a clear reason', () => {
  const s = withIdleCraft();
  // Empty waypoints — a route needs at least one leg.
  const empty = quote(s, []);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /non-empty/);
  // Zero-length leg — two chosen waypoints on the same hex (a dead leg). (A first waypoint on the craft's
  // OWN hex is not a failure: that reposition is skipped, slice 2a.1 — see section 6 below.)
  assert.match(quote(s, [{ q: 3, r: 0 }, { q: 3, r: 0 }]).reason, /leg 1 is zero-length/);
  // Off-lattice waypoint (out of the galaxy's hex bounds).
  assert.match(quote(s, [{ q: 999999, r: 999999 }]).reason, /does not resolve/);
  // An unresolvable landmark waypoint.
  assert.match(quote(s, [{ landmarkKind: 'system', landmarkId: 'sys_not_real' }]).reason, /does not resolve/);
  // A non-idle craft cannot be quoted: send it flying, then quote again.
  const flying = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints: [{ q: 3, r: 0 }] }));
  const nonIdle = quote(flying, [{ q: 5, r: 0 }]);
  assert.equal(nonIdle.ok, false);
  assert.match(nonIdle.reason, /not idle/);
  // Unknown guild / unknown vehicle — the same messages the dispatch validate gives.
  assert.match(quoteDispatch(s, { guildId: 'ghost', vehicleId: VID, waypoints: [{ q: 1, r: 0 }] }).reason, /no guild/);
  assert.match(quoteDispatch(s, { guildId: 'g1', vehicleId: 'vehicle_g1_lightTransport_09', waypoints: [{ q: 1, r: 0 }] }).reason, /owns no vehicle/);
});

// --- 5. read-only: quoting mutates nothing -------------------------------------------------------

test('quoting a route any number of times leaves the state byte-identical', () => {
  const s = withIdleCraft();
  const before = hashState(s);
  // Quote an ok route, an unaffordable route, and a failing route — several times each.
  for (let i = 0; i < 5; i += 1) {
    quote(s, [{ q: 3, r: 0 }, { q: 3, r: 4 }]); // an ok, affordable route
    quote(s, [{ q: 9, r: -2 }]);                // a longer route
    quote(s, [{ q: 3, r: 0 }, { q: 3, r: 0 }]); // a zero-length (dead leg) failure
    quote(s, [{ q: 0, r: 0 }]);                 // an act-in-place quote (craft already at its one stop)
    quote(s, [{ q: 0, r: 0 }, { q: 3, r: 0 }]); // a skipped-reposition quote (craft already at W1)
    quote(s, []);                               // an empty failure
  }
  assert.equal(hashState(s), before, 'no journal, no tick, no snapshot — the galaxy is untouched');
});

// --- 6. the zero-length reposition skip (slice 2a.1, transport-model.md §11.4 / §11.9) ------------
// The quote must preview exactly what dispatch will do. The actioned dispatch SKIPS a craft → W1 leg of
// zero length (the craft is already there), so the quote skips it too.

test('skip: a craft already at W1 quotes only the real onward legs — identical to quoting from W1 onward', () => {
  const s = withIdleCraft(); // craft at {0,0}
  const withW1 = quote(s, [{ q: 0, r: 0 }, { q: 3, r: 0 }, { q: 3, r: 4 }]);
  assert.equal(withW1.ok, true, `expected ok, got: ${withW1.reason}`);
  assert.deepEqual(withW1.legs.map((l) => l.length), [3, 4], 'the zero-length craft → W1 leg is not in the quote');
  // Naming the berth as W1 changes nothing: the same quote as the route without it.
  assert.deepEqual(withW1, quote(s, [{ q: 3, r: 0 }, { q: 3, r: 4 }]));
});

test('skip: the quote agrees with what dispatchRouteWithActions really flies (legs, fuel, arrival)', () => {
  const before = withIdleCraft({ fuelHoard: 500 }); // craft at {0,0}
  const anchors = [{ q: 0, r: 0 }, { q: 3, r: 0 }, { q: 3, r: 4 }];
  const q = quote(before, anchors);
  assert.equal(q.ok, true);

  // Dispatch the SAME route for real (no actions — pure turning points, so the timing is exactly the flight).
  let s = accept(before, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: VID, waypoints: anchors.map((anchor) => ({ anchor })),
  }));
  const craft = (st) => st.guilds[0].vehicles.find((v) => v.id === VID);
  // Fuel: the up-front burn is exactly the quote's totalUnits (the skipped reposition cost nothing).
  assert.equal(before.guilds[0].fuelHoard - s.guilds[0].fuelHoard, q.totalUnits);
  // The first leg flown is the quote's first leg: {0,0} → {3,0}, landing when the quote says.
  assert.deepEqual(craft(s).trip.legs[0].to, { q: 3, r: 0 });
  assert.equal(craft(s).trip.arrivalTick, s.tick + q.legs[0].ticks);
  // Fly it out: the craft lands at the last waypoint on the quote's arrivalTick.
  while (craft(s).route) s = tick(s, []);
  assert.equal(s.tick, q.arrivalTick, 'the run ends on the quoted arrival tick');
  assert.deepEqual(craft(s).location, { q: 3, r: 4 });
});

test('act in place: a one-stop route at the craft\'s own berth quotes 0 legs / 0 ticks / 0 fuel, arriving now', () => {
  for (const s of [withIdleCraft(), ticks(withIdleCraft(), 3)]) { // at tick 0, and ticked forward
    const q = quote(s, [{ q: 0, r: 0 }]);
    assert.deepEqual(q, {
      ok: true,
      legs: [],
      totalTicks: 0,
      totalUnits: 0,
      credits: 0,
      affordable: true,
      arrivalTick: s.tick, // resolves in place, at the dispatch tick
    });
  }
  // It agrees with the dispatch: the act-in-place run burns exactly the quoted 0 fuel. (The action sits
  // at a bare hex, so it halts safely in place — what matters here is the fuel, which is none.)
  const before = withIdleCraft({ fuelHoard: 500 });
  const after = accept(before, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: VID,
    waypoints: [{ anchor: { q: 0, r: 0 }, action: { type: 'dock', manifest: [{ dir: 'load', good: 'titanium', qty: 1 }] } }],
  }));
  assert.equal(after.guilds[0].fuelHoard, before.guilds[0].fuelHoard);
  assert.equal(after.audit.totalConsumed, before.audit.totalConsumed);
});

test('skip: the skip never cascades — a dead leg right after the skipped W1 is still refused', () => {
  const s = withIdleCraft(); // craft at {0,0}
  assert.match(quote(s, [{ q: 0, r: 0 }, { q: 0, r: 0 }]).reason, /leg 1 is zero-length/);
});

test('skip: quoting is deterministic — the same route quotes identically every time', () => {
  const s = withIdleCraft();
  const wp = [{ q: 0, r: 0 }, { q: 3, r: 0 }];
  assert.deepEqual(quote(s, wp), quote(JSON.parse(JSON.stringify(s)), wp), 'a reloaded state quotes the same');
});
