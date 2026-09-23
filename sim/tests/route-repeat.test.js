'use strict';

// route-repeat.test.js — the transport AUTOMATION layer, slice 3a: REPETITION — the repeat loop
// (transport-model.md §11.10 / §11.4 / §11.6 / §11.3; roadmap 2.2 automation slice 3a). A
// `dispatchRouteWithActions` can now carry a LAUNCH MODE — once / continuous / nRun — and a repeating
// lane cycles its own waypoints: each lap ends at the last waypoint (WN), repositions to W1 and is
// re-fuelled up front, until it runs out of laps, is stopped, or ends.
//
// This file grows with the slice, one section per commit:
//   1. launch modes + the entity — the `repeat` grammar, the journalled repeat state (omit-when-once),
//      the integrity check and the snapshot surface.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { hexDistance, legFuelBurn } = require('../transport.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchRouteWithActionsAction,
} = require('../actions.js');

const SYS_A = starterHomeAtDistance(6).id; // a real seed system — the LOAD stop (W1)
const A_COORDS = getSystem(SYS_A).coords;
const SYS_ANCHOR = { landmarkKind: 'system', landmarkId: SYS_A };
const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT];
const VID = 'vehicle_g1_lightTransport_01';
const T1 = 'titanium'; // volumeOf === 1

// The in-bounds, landmark-free hexes nearest system A (derived from the seed, as route-actions.test.js
// does, so a seed regen carries the test). ORIGIN is the launch berth; HEX_B is the Outpost's tile.
function freeHexesNear(center, n) {
  const found = [];
  for (let q = -100; q <= 100; q += 1) {
    for (let r = -100; r <= 100; r += 1) {
      if (!isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      found.push({ q, r, d: hexDistance({ q, r }, center) });
    }
  }
  found.sort((a, b) => (a.d - b.d) || (a.q - b.q) || (a.r - b.r));
  assert.ok(found.length >= n, `need ${n} free hexes near ${JSON.stringify(center)}`);
  return found.slice(0, n).map(({ q, r }) => ({ q, r }));
}
const [ORIGIN, HEX_B] = freeHexesNear(A_COORDS, 2);

// Leg fuel from the ONE leg formula (never inlined). Lap 1 = ORIGIN → A → B; every later lap of the
// canonical lane = the loop-back B → A plus the cycle A → B (§11.4).
const burn = (from, to) => legFuelBurn(hexDistance(from, to), LIGHT.fuelCostToRun, false);
const LAP1_FUEL = burn(ORIGIN, A_COORDS) + burn(A_COORDS, HEX_B);

// routeState(...) -> an invariant-clean galaxy: guild g1 with one idle light craft at ORIGIN (or
// `craftAt`), 400 titanium per lap in its (g1, A) pool, and its Outpost `outpost_g1_01` on HEX_B.
function routeState({ systemPool, fuelHoard = 1000000, craftAt = { ...ORIGIN } } = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard, outpostSerial: 1 };
  if (systemPool) guild.stockpiles = { [SYS_A]: { ...systemPool } };
  const outpost = {
    id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: SYS_A, coords: { ...HEX_B }, createdAtTick: 0,
  };
  const s = createState({
    guilds: [guild], outposts: [outpost], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  return accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: craftAt }));
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
const dock = (manifest) => ({ type: 'dock', manifest });
// The canonical two-stop lane: load 400 at system A, unload 400 at the Outpost on HEX_B.
const LANE = () => [
  { anchor: { ...SYS_ANCHOR }, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
  { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
];
const dispatch = (waypoints, repeat) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: VID, waypoints, ...(repeat !== undefined ? { repeat } : {}),
});
const craftOf = (s) => s.guilds[0].vehicles.find((v) => v.id === VID);
const snapRow = (s) => buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);

// --- 1. launch modes + the entity --------------------------------------------------------------

test('launch modes: continuous / nRun journal their state on the route; once journals nothing', () => {
  const cont = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE(), { mode: 'continuous' }));
  assert.equal(craftOf(cont).route.mode, 'continuous');
  assert.equal('lapsRemaining' in craftOf(cont).route, false, 'a continuous lane has no lap count');

  const three = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE(), { mode: 'nRun', n: 3 }));
  assert.equal(craftOf(three).route.mode, 'nRun');
  assert.equal(craftOf(three).route.lapsRemaining, 3, 'lapsRemaining starts at n');

  // `once` — explicit or absent — stores NEITHER field (omit-when-default), so the route is exactly the
  // built one-shot's { waypoints, cursor }.
  const absent = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE()));
  const once = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE(), { mode: 'once' }));
  assert.deepEqual(Object.keys(craftOf(absent).route).sort(), ['cursor', 'waypoints']);
  assert.equal(hashState(once), hashState(absent), 'an explicit once is byte-identical to no repeat at all');
  for (const s of [cont, three, once]) assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('launch modes: the constructor carries `repeat` only when given (a one-shot journals as before)', () => {
  const plain = dispatch(LANE());
  assert.equal('repeat' in plain, false, 'no repeat key on a one-shot dispatch action');
  assert.deepEqual(dispatch(LANE(), { mode: 'nRun', n: 2 }).repeat, { mode: 'nRun', n: 2 });
});

test('launch modes: a repeating launch fuels ONLY lap 1 up front — the same bill as a one-shot', () => {
  const once = accept(routeState({ systemPool: { [T1]: 400 }, fuelHoard: 1000 }), dispatch(LANE()));
  const cont = accept(routeState({ systemPool: { [T1]: 400 }, fuelHoard: 1000 }), dispatch(LANE(), { mode: 'continuous' }));
  assert.equal(once.guilds[0].fuelHoard, 1000 - LAP1_FUEL);
  assert.equal(cont.guilds[0].fuelHoard, 1000 - LAP1_FUEL, 'lap 1 (positioning + cycle) is the launch bill');
  assert.equal(cont.audit.totalConsumed, LAP1_FUEL, 'the burn is recorded (invariant 1)');
  // …and an unaffordable lap 1 is REFUSED at launch, never left waiting (§11.3 / §11.6).
  const short = routeState({ systemPool: { [T1]: 400 }, fuelHoard: LAP1_FUEL - 1 });
  assert.match(refuse(short, dispatch(LANE(), { mode: 'continuous' })), /refused whole/);
  assert.equal(craftOf(short).route, undefined, 'nothing journalled on a refusal');
});

test('launch modes: a malformed repeat is refused whole, naming what is wrong', () => {
  const s = routeState({ systemPool: { [T1]: 400 } });
  assert.match(refuse(s, dispatch(LANE(), 'continuous')), /repeat must be \{ mode/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'forever' })), /repeat\.mode must be one of "once" \| "continuous" \| "nRun"/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'nRun' })), /nRun lane needs n, a whole number of laps >= 1/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'nRun', n: 0 })), /whole number of laps >= 1/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'nRun', n: 1.5 })), /whole number of laps >= 1/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'continuous', n: 3 })), /repeat\.n is only for mode "nRun"/);
  assert.equal(craftOf(s).route, undefined, 'nothing was journalled');
});

test('launch modes: a ONE-stop lane cannot repeat — its cycle has no leg (it would lap in place in one tick)', () => {
  const s = routeState({ systemPool: { [T1]: 400 } });
  const oneStop = [{ anchor: { ...SYS_ANCHOR }, action: dock([{ dir: 'load', good: T1, qty: 1 }]) }];
  assert.match(refuse(s, dispatch(oneStop, { mode: 'continuous' })), /repeating lane needs at least two waypoints/);
  assert.match(refuse(s, dispatch(oneStop, { mode: 'nRun', n: 2 })), /at least two waypoints/);
  // The same one stop, run ONCE, is still the built one-shot (unchanged).
  accept(s, dispatch(oneStop));
  accept(s, dispatch(oneStop, { mode: 'once' }));
});

test('integrity: a corrupt repeat state on a route fails loudly (routeViolation)', () => {
  const base = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE(), { mode: 'nRun', n: 2 }));
  const corrupt = (mutate) => {
    const s = structuredClone(base);
    mutate(craftOf(s).route);
    return checkInvariants(s, s.tick).filter((v) => v.rule === 'vehicle-route-valid');
  };
  assert.equal(corrupt(() => {}).length, 0, 'the clean nRun route passes');
  assert.equal(corrupt((r) => { r.mode = 'once'; delete r.lapsRemaining; }).length, 1, 'a stored "once" is non-canonical');
  assert.equal(corrupt((r) => { r.mode = 'forever'; delete r.lapsRemaining; }).length, 1, 'an unknown mode');
  assert.equal(corrupt((r) => { r.lapsRemaining = 0; }).length, 1, 'a live nRun with 0 laps left should have ended');
  assert.equal(corrupt((r) => { r.lapsRemaining = 1.5; }).length, 1, 'a fractional lap count');
  assert.equal(corrupt((r) => { r.mode = 'continuous'; }).length, 1, 'lapsRemaining on a continuous lane');
  assert.equal(corrupt((r) => { r.waypoints.pop(); r.cursor = 0; }).length, 1, 'a one-stop repeating route');
  assert.equal(corrupt((r) => { delete r.mode; }).length, 1, 'lapsRemaining with no mode (a one-shot)');
});

test('snapshot: a repeating lane surfaces mode + lapsRemaining (fresh); a one-shot row carries neither', () => {
  const s = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE(), { mode: 'nRun', n: 3 }));
  const row = snapRow(s);
  assert.equal(row.route.mode, 'nRun');
  assert.equal(row.route.lapsRemaining, 3);
  assert.equal(row.route.cursor, 0);
  row.route.waypoints[0].anchor.landmarkId = 'mutated';
  assert.equal(craftOf(s).route.waypoints[0].anchor.landmarkId, SYS_A, 'the row never aliases engine state');

  const once = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE()));
  assert.deepEqual(Object.keys(snapRow(once).route).sort(), ['cursor', 'waypoints'], 'one-shot row unchanged');
  const cont = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE(), { mode: 'continuous' }));
  assert.equal(snapRow(cont).route.mode, 'continuous');
  assert.equal('lapsRemaining' in snapRow(cont).route, false);
});
