'use strict';

// route-repeat-extensions.test.js — the transport AUTOMATION layer, slice 3a.1: the REPETITION
// EXTENSIONS ruled into transport-model.md §11.10 on 24-09-26 (roadmap 2.2 automation slice 3a.1).
// Slice 3a built the repeat loop (route-repeat.test.js); this slice rounds out its model:
//
//   1. the CADENCE launch option — `repeat.cadence` is 'immediate' (the default) or 'perCycle', for a
//      repeating mode only; journalled onto the route omit-when-immediate, so a lane launched without a
//      cadence is byte-identical to a 3a lane.
//   2. the lap COUNTERS — `lapsDone` (completed laps, every repeating lane) and an nRun's launched target
//      `N`; lapsDone counts up as lapsRemaining counts down, always adding back to N.
//
// The fixture below is the SAME galaxy route-repeat.test.js builds (guild g1, one light craft, system A
// as the load stop, its Outpost on the free hex B as the unload stop), copied rather than shared so each
// test file reads on its own — the pattern route-actions.test.js and route-repeat.test.js already follow.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { hexDistance } = require('../transport.js');
const { LIGHT_TRANSPORT } = require('../vehicles.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchRouteWithActionsAction,
} = require('../actions.js');

const SYS_A = starterHomeAtDistance(6).id; // a real seed system — the LOAD stop (W1)
const A_COORDS = getSystem(SYS_A).coords;
const SYS_ANCHOR = { landmarkKind: 'system', landmarkId: SYS_A };
const VID = 'vehicle_g1_lightTransport_01';
const T1 = 'titanium'; // volumeOf === 1

// The in-bounds, landmark-free hexes nearest system A, derived from the seed (so a seed regen carries
// the test). ORIGIN is the launch berth; HEX_B is the Outpost's tile.
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

// routeState(...) -> an invariant-clean galaxy: guild g1 with one idle light craft at ORIGIN, titanium in
// its (g1, A) pool, and its Outpost `outpost_g1_01` on HEX_B.
function routeState({ systemPool = { [T1]: 400 * 50 }, fuelHoard = 1000000 } = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard, outpostSerial: 1, stockpiles: { [SYS_A]: { ...systemPool } } };
  const outpost = {
    id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: SYS_A, coords: { ...HEX_B }, createdAtTick: 0,
  };
  const s = createState({
    guilds: [guild], outposts: [outpost], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  return accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { ...ORIGIN } }));
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
const pool = (s) => ((s.guilds[0].stockpiles || {})[SYS_A] || {})[T1] || 0;
const stock = (s) => ((s.outposts[0] || {}).stockpile || {})[T1] || 0;
// step(s) — one full turn through the real driver, which ASSERTS EVERY INVARIANT on the result and throws
// with the tick number on any violation — so every lane below is invariant-checked on every tick.
const step = (s) => advance(s, []).state;
const stepUntil = (state, pred, cap = 20000) => {
  let s = state;
  let i = 0;
  while (!pred(s) && i < cap) { s = step(s); i += 1; }
  assert.ok(pred(s), `condition not met within ${cap} ticks`);
  return s;
};

// --- 1. the cadence launch option ------------------------------------------------------------------

test('cadence: perCycle is journalled on a repeating lane; immediate (explicit or absent) stores nothing', () => {
  const perCycle = accept(routeState(), dispatch(LANE(), { mode: 'continuous', cadence: 'perCycle' }));
  assert.equal(craftOf(perCycle).route.cadence, 'perCycle');
  const nPerCycle = accept(routeState(), dispatch(LANE(), { mode: 'nRun', n: 2, cadence: 'perCycle' }));
  assert.equal(craftOf(nPerCycle).route.cadence, 'perCycle');

  // `immediate` is the default and is never written (omit-when-default): a lane launched with it, or with
  // no cadence at all, is byte-identical — so a 3a-style launch journals exactly as it did in 3a.
  const absent = accept(routeState(), dispatch(LANE(), { mode: 'continuous' }));
  const immediate = accept(routeState(), dispatch(LANE(), { mode: 'continuous', cadence: 'immediate' }));
  assert.equal('cadence' in craftOf(absent).route, false);
  assert.equal(hashState(immediate), hashState(absent), 'an explicit immediate is byte-identical to no cadence');
  for (const s of [perCycle, nPerCycle, immediate]) assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('cadence: refused on a once run (no next lap to pace) and when it is not a known cadence', () => {
  const s = routeState();
  assert.match(refuse(s, dispatch(LANE(), { mode: 'once', cadence: 'perCycle' })), /repeat\.cadence is only for a repeating lane/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'once', cadence: 'immediate' })), /only for a repeating lane/, 'even the default — once has no cadence');
  assert.match(refuse(s, dispatch(LANE(), { mode: 'continuous', cadence: 'daily' })), /repeat\.cadence must be one of "immediate" \| "perCycle"/);
  assert.match(refuse(s, dispatch(LANE(), { mode: 'nRun', n: 2, cadence: 'PerCycle' })), /must be one of/, 'case counts');
  assert.equal(craftOf(s).route, undefined, 'nothing was journalled');
});

test('cadence: the snapshot surfaces a perCycle cadence; an immediate lane\'s row carries none (as 3a)', () => {
  const perCycle = accept(routeState(), dispatch(LANE(), { mode: 'continuous', cadence: 'perCycle' }));
  assert.equal(snapRow(perCycle).route.cadence, 'perCycle');
  const immediate = accept(routeState(), dispatch(LANE(), { mode: 'continuous' }));
  assert.equal('cadence' in snapRow(immediate).route, false, 'absent means immediate');
});

test('integrity: a stored cadence must be "perCycle", on a repeating lane', () => {
  const base = accept(routeState(), dispatch(LANE(), { mode: 'continuous', cadence: 'perCycle' }));
  const bad = (mutate) => {
    const s = structuredClone(base);
    mutate(craftOf(s).route);
    return checkInvariants(s, s.tick).filter((v) => v.rule === 'vehicle-route-valid').length;
  };
  assert.equal(bad(() => {}), 0, 'the clean perCycle lane passes');
  assert.equal(bad((r) => { r.cadence = 'immediate'; }), 1, 'a stored "immediate" is non-canonical (omit-when-default)');
  assert.equal(bad((r) => { r.cadence = 'daily'; }), 1, 'an unknown cadence');
  assert.equal(bad((r) => { delete r.mode; }), 1, 'a one-shot carries no cadence');
});

// --- 2. the lap counters: lapsDone + N ------------------------------------------------------------

test('counters: journalled at launch — lapsDone 0 on every repeating lane, N = n on an nRun; a once run has neither', () => {
  const three = accept(routeState(), dispatch(LANE(), { mode: 'nRun', n: 3 }));
  assert.equal(craftOf(three).route.N, 3, 'N is the launched target');
  assert.equal(craftOf(three).route.lapsRemaining, 3);
  assert.equal(craftOf(three).route.lapsDone, 0, 'no lap has completed yet');
  const cont = accept(routeState(), dispatch(LANE(), { mode: 'continuous' }));
  assert.equal(craftOf(cont).route.lapsDone, 0);
  assert.equal('N' in craftOf(cont).route, false, 'a continuous lane has no target');
  const once = accept(routeState(), dispatch(LANE()));
  assert.deepEqual(Object.keys(craftOf(once).route).sort(), ['cursor', 'waypoints'], 'a one-shot is the built route, unchanged');
});

test('counters: an nRun n=3 lane counts lapsDone 0→1→2 up as lapsRemaining 3→2→1 counts down, then ends idle at WN', () => {
  // Titanium for FOUR laps at A, so a 4th cycle — if one ever ran — would have goods to move.
  let s = accept(routeState({ systemPool: { [T1]: 1600 } }), dispatch(LANE(), { mode: 'nRun', n: 3 }));
  const seen = [];
  s = stepUntil(s, (st) => {
    const r = craftOf(st).route;
    if (!r) return true;
    const last = seen[seen.length - 1];
    if (!last || last.lapsDone !== r.lapsDone) {
      seen.push({ lapsDone: r.lapsDone, lapsRemaining: r.lapsRemaining, N: r.N });
      // The snapshot row reads the same counters the state holds.
      const row = snapRow(st).route;
      assert.deepEqual([row.lapsDone, row.lapsRemaining, row.N], [r.lapsDone, r.lapsRemaining, r.N]);
      // Each count moves on the tick the lap's last unload lands — never before.
      assert.equal(stock(st), 400 * r.lapsDone, `lapsDone ${r.lapsDone} at tick ${st.tick} matches the unloads delivered`);
    }
    return false;
  });
  assert.deepEqual(seen, [
    { lapsDone: 0, lapsRemaining: 3, N: 3 },
    { lapsDone: 1, lapsRemaining: 2, N: 3 },
    { lapsDone: 2, lapsRemaining: 1, N: 3 },
  ], 'one lap counted each way per finished cycle, N fixed; the 3rd completion ends the lane');
  assert.equal(stock(s), 1200, 'three laps delivered — the third lap finished, so lapsDone reached 3 as it ended');
  assert.equal(pool(s), 400, 'no 4th lap');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at WN');
});

test('counters: a continuous lane\'s lapsDone climbs by one per completed lap, with no N', () => {
  let s = accept(routeState(), dispatch(LANE(), { mode: 'continuous' }));
  for (let k = 1; k <= 5; k += 1) {
    s = stepUntil(s, (st) => stock(st) === 400 * k);
    assert.equal(craftOf(s).route.lapsDone, k, `lap ${k} completed on the tick its unload landed`);
    assert.equal('N' in craftOf(s).route, false);
    assert.equal(snapRow(s).route.lapsDone, k);
  }
});

test('integrity: the lap counters fail loudly when malformed, misplaced, or out of step', () => {
  const base = accept(routeState(), dispatch(LANE(), { mode: 'nRun', n: 3 }));
  const bad = (mutate) => {
    const s = structuredClone(base);
    mutate(craftOf(s).route);
    return checkInvariants(s, s.tick).filter((v) => v.rule === 'vehicle-route-valid').length;
  };
  assert.equal(bad(() => {}), 0, 'the clean nRun lane passes');
  assert.equal(bad((r) => { r.lapsDone = -1; }), 1, 'a negative lap count');
  assert.equal(bad((r) => { r.lapsDone = 0.5; }), 1, 'a fractional lap count');
  assert.equal(bad((r) => { delete r.lapsDone; }), 1, 'a repeating lane always counts its laps');
  assert.equal(bad((r) => { r.lapsDone = 1; }), 1, 'lapsDone + lapsRemaining drifted off N');
  assert.equal(bad((r) => { r.N = 4; }), 1, 'N no longer the sum');
  assert.equal(bad((r) => { r.N = 0; r.lapsRemaining = 1; r.lapsDone = -1; }), 1, 'N must be >= 1');
  assert.equal(bad((r) => { delete r.N; }), 1, 'an nRun keeps its target');
  assert.equal(bad((r) => { r.mode = 'continuous'; delete r.lapsRemaining; }), 1, 'N on a continuous lane');
  assert.equal(bad((r) => { delete r.mode; delete r.lapsRemaining; delete r.N; }), 1, 'lapsDone on a one-shot');
});
