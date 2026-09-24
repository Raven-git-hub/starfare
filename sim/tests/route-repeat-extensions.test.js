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
//   3. the PER-CYCLE hold — a perCycle lane flies lap 1 at once, then after each lap HOLDS at WN as a
//      `waiting` lane (reason 'cadence') until the next fuel-cycle boundary starts its next lap: one lap
//      per cycle. An immediate lane still runs back to back.
//   4. the WAIT-REASON split — a cadence hold that cannot pay at the boundary becomes a FUEL wait (and
//      runs once it can); the two reasons never wedge; a stop gone during a hold ends the lane.
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
const { hexDistance, legFuelBurn, legTicks } = require('../transport.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const { outpostDockTurnaround } = require('../outposts.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { isWindowBoundary } = require('../windows.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchRouteWithActionsAction,
  createSetWindowNAction, createAdjustFuelAction, createStopRouteAfterRunAction, createRemoveOutpostAction,
} = require('../actions.js');

const SYS_A = starterHomeAtDistance(6).id; // a real seed system — the LOAD stop (W1)
const A_COORDS = getSystem(SYS_A).coords;
const SYS_ANCHOR = { landmarkKind: 'system', landmarkId: SYS_A };
const VID = 'vehicle_g1_lightTransport_01';
const T1 = 'titanium'; // volumeOf === 1
const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT];

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

// Leg fuel and leg time from the ONE leg formulas, and the ruled class turnaround — never inlined. Lap 1 of
// the canonical lane = ORIGIN → A → B; every later lap = the loop-back B → A plus the cycle A → B (§11.4).
// A lap ENDS when its unload at B's Outpost completes (the turnaround), which is also when the next lap of
// an immediate lane departs.
const burn = (from, to) => legFuelBurn(hexDistance(from, to), LIGHT.fuelCostToRun, false);
const ticksOf = (from, to) => legTicks(hexDistance(from, to), LIGHT.speed, false);
const TURNAROUND = outpostDockTurnaround(LIGHT_TRANSPORT);
const LAP1_FUEL = burn(ORIGIN, A_COORDS) + burn(A_COORDS, HEX_B);
const LAP_FUEL = burn(HEX_B, A_COORDS) + burn(A_COORDS, HEX_B);
const LAP1_TICKS = ticksOf(ORIGIN, A_COORDS) + ticksOf(A_COORDS, HEX_B) + TURNAROUND; // launch → lap 1 done
const LAP_PERIOD = ticksOf(HEX_B, A_COORDS) + ticksOf(A_COORDS, HEX_B) + TURNAROUND; // a later lap, start → done

// routeState(...) -> an invariant-clean galaxy: guild g1 with one idle light craft at ORIGIN, titanium in
// its (g1, A) pool (and, if given, in its Outpost `outpost_g1_01` on HEX_B).
function routeState({ systemPool = { [T1]: 400 * 50 }, fuelHoard = 1000000, outpostStock } = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard, outpostSerial: 1, stockpiles: { [SYS_A]: { ...systemPool } } };
  const outpost = {
    id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: SYS_A, coords: { ...HEX_B }, createdAtTick: 0,
    ...(outpostStock ? { stockpile: { ...outpostStock } } : {}),
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
// The REVERSED lane: load 400 from the Outpost on HEX_B (W1), deliver it to system A (WN). Its last stop
// is a system, so the Outpost — a stop of its NEXT lap — can vanish while the craft holds at A.
const REVERSE = () => [
  { anchor: { ...HEX_B }, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
  { anchor: { ...SYS_ANCHOR }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
];
const dispatch = (waypoints, repeat) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: VID, waypoints, ...(repeat !== undefined ? { repeat } : {}),
});
const craftOf = (s) => s.guilds[0].vehicles.find((v) => v.id === VID);
const snapRow = (s) => buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);
const pool = (s) => ((s.guilds[0].stockpiles || {})[SYS_A] || {})[T1] || 0;
const stock = (s) => ((s.outposts[0] || {}).stockpile || {})[T1] || 0;
const hoard = (s) => s.guilds[0].fuelHoard;
const waitingOf = (s) => (craftOf(s).route ? craftOf(s).route.waiting : undefined);
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

// The FUEL CYCLE is the engine's window — a setup-only knob, set at tick 0. Its boundaries are where a
// waiting lane (short of fuel, or holding for its cadence) gets its next try. Each test picks the cycle
// relative to the lap it flies, so the pacing shows. The guild has no holdings, so a boundary grants it
// no fuel: the only fuel it gets is its starting hoard and what a test hands it with adjustFuel.
const withCycle = (s, cycle) => accept(s, createSetWindowNAction({ windowN: cycle }));
const isBoundary = (tick, cycle) => isWindowBoundary(tick, cycle, 0);
const grantFuel = (s, units) => accept(s, createAdjustFuelAction({ guildId: 'g1', delta: units }));
const perCycle = (mode = 'continuous', n) => ({ mode, ...(n !== undefined ? { n } : {}), cadence: 'perCycle' });

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

// --- 3. the per-cycle hold -------------------------------------------------------------------------

// runLane(repeat, cycle, laps) -> the ticks each lap STARTED (the hoard drops — every lap is fuelled whole
// at its start, §11.3) and ENDED (its 400 unload lands at B), for the first `laps` laps of a lane.
function runLane(repeat, cycle, laps) {
  let s = withCycle(routeState(), cycle);
  s = accept(s, dispatch(LANE(), repeat));
  const starts = [s.tick]; // lap 1 starts on dispatch
  const ends = [];
  while (ends.length < laps) {
    const before = { hoard: hoard(s), stock: stock(s) };
    s = step(s);
    if (stock(s) > before.stock) ends.push(s.tick);
    if (hoard(s) < before.hoard) starts.push(s.tick);
  }
  return { starts, ends, s };
}
// The first fuel-cycle boundary at or after `tick`.
const boundaryFrom = (tick, cycle) => { let t = tick; while (!isBoundary(t, cycle)) t += 1; return t; };

test('perCycle: lap 1 launches at once on dispatch; the hold appears only after it completes', () => {
  const CYCLE = 2 * LAP_PERIOD; // long enough that every lap finishes well inside one cycle
  let s = withCycle(routeState({ fuelHoard: 1000 }), CYCLE);
  s = accept(s, dispatch(LANE(), perCycle()));
  // Lap 1 is the launch's own, exactly as an immediate lane's: flying now, its fuel burned, no hold.
  assert.equal(craftOf(s).status, 'inTransit', 'lap 1 departs on dispatch — not at a boundary');
  assert.equal(waitingOf(s), undefined);
  assert.equal(hoard(s), 1000 - LAP1_FUEL, 'lap 1 fuelled at launch');
  // Lap 1 completes mid-cycle (its unload lands at B) — and only now does the lane hold, right there.
  s = stepUntil(s, (st) => craftOf(st).route.lapsDone === 1);
  assert.equal(s.tick, LAP1_TICKS, 'lap 1 flew straight through — nothing held it');
  assert.equal(isBoundary(s.tick, CYCLE), false, 'it ended mid-cycle');
  assert.deepEqual(waitingOf(s), { reason: 'cadence', sinceTick: s.tick });
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'holding at WN');
  assert.equal(craftOf(s).trip, undefined);
  assert.equal(hoard(s), 1000 - LAP1_FUEL, 'lap 2 is not fuelled while it holds');
  assert.deepEqual(snapRow(s).route.waiting, { reason: 'cadence', sinceTick: s.tick }, 'surfaced for the client');
  // It holds, burning nothing, right up to the boundary — which starts lap 2.
  const heldFrom = s.tick;
  s = stepUntil(s, (st) => waitingOf(st) === undefined);
  assert.equal(s.tick, boundaryFrom(heldFrom, CYCLE), 'lap 2 starts ON the next fuel-cycle boundary');
  assert.equal(craftOf(s).status, 'inTransit');
  assert.deepEqual(craftOf(s).trip.legs[0].from, { ...HEX_B }, 'lap 2 opens with the loop-back from WN');
  assert.equal(hoard(s), 1000 - LAP1_FUEL - LAP_FUEL, 'lap 2 fuelled whole at its start');
});

test('perCycle: paces the lane to ONE lap per fuel cycle; an immediate lane still runs back to back', () => {
  const CYCLE = 2 * LAP_PERIOD;
  const per = runLane(perCycle(), CYCLE, 5);
  for (let i = 1; i < per.starts.length; i += 1) {
    assert.ok(isBoundary(per.starts[i], CYCLE), `lap ${i + 1} started on a boundary (tick ${per.starts[i]})`);
    if (i > 1) assert.equal(per.starts[i] - per.starts[i - 1], CYCLE, `lap ${i + 1} started one cycle after lap ${i}`);
    assert.equal(per.ends[i] - per.starts[i], LAP_PERIOD, `lap ${i + 1} flew in one lap period, then held`);
  }
  // The same lane, immediate: every lap departs the tick the last one ended — the 3a loop, unchanged.
  const imm = runLane({ mode: 'continuous' }, CYCLE, 5);
  for (let i = 1; i < imm.starts.length; i += 1) {
    assert.equal(imm.starts[i], imm.ends[i - 1], `immediate lap ${i + 1} departs as lap ${i} ends`);
  }
  assert.ok(imm.ends[4] < per.ends[4], 'back to back is faster than one lap per cycle');
});

test('perCycle: a lap LONGER than the cycle still waits for a boundary — never starts mid-cycle', () => {
  const CYCLE = Math.ceil(LAP_PERIOD / 2); // a lap spans more than one cycle
  const { starts, ends } = runLane(perCycle(), CYCLE, 4);
  for (let i = 1; i < starts.length; i += 1) {
    assert.equal(starts[i], boundaryFrom(ends[i - 1], CYCLE), `lap ${i + 1} starts on the first boundary after lap ${i} ended`);
  }
  // A boundary that passes while the craft is still FLYING a lap does nothing to it — only a lane waiting
  // at WN is re-attempted — so there is still never more than one lap start per cycle.
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= CYCLE);
});

test('perCycle: a lap that ends ON a boundary tick starts its next lap at that same boundary', () => {
  // The cycle is lap 1's own length, so lap 1 ends exactly on the first boundary. The hold is set in the
  // dock step and the boundary re-attempt runs later in the SAME tick (sim/tick.js step 6 (e)), so the
  // lane goes straight on — the boundary it holds for is the one firing now.
  const CYCLE = LAP1_TICKS;
  let s = withCycle(routeState(), CYCLE);
  s = accept(s, dispatch(LANE(), perCycle()));
  const fuel = hoard(s);
  s = stepUntil(s, (st) => craftOf(st).route.lapsDone === 1);
  assert.ok(isBoundary(s.tick, CYCLE), 'precondition: lap 1 ended on a boundary tick');
  assert.equal(waitingOf(s), undefined, 'no hold left standing at the end of the tick');
  assert.equal(craftOf(s).status, 'inTransit');
  assert.equal(craftOf(s).trip.legs[0].departureTick, s.tick, 'lap 2 departed this tick');
  assert.equal(fuel - hoard(s), LAP_FUEL, 'and was fuelled whole, once');
});

test('perCycle nRun: N laps, one per cycle — the LAST lap ends idle at WN at once, with no hold after it', () => {
  const CYCLE = 2 * LAP_PERIOD;
  let s = withCycle(routeState(), CYCLE);
  s = accept(s, dispatch(LANE(), perCycle('nRun', 2)));
  s = stepUntil(s, (st) => craftOf(st).route.lapsDone === 1);
  assert.deepEqual(
    [craftOf(s).route.lapsDone, craftOf(s).route.lapsRemaining, craftOf(s).route.N, waitingOf(s).reason],
    [1, 1, 2, 'cadence'],
    'holding between lap 1 and lap 2 of 2',
  );
  let lastEnd = null;
  s = stepUntil(s, (st) => {
    if (stock(st) === 800 && lastEnd === null) lastEnd = st.tick;
    return !craftOf(st).route;
  });
  assert.equal(s.tick, lastEnd, 'the lane ended on the tick its last lap completed — not at a later boundary');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at WN');
});

test('perCycle: "stop after this run" on a lane holding for its cadence ends it on the spot', () => {
  let s = withCycle(routeState(), 2 * LAP_PERIOD);
  s = accept(s, dispatch(LANE(), perCycle()));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined);
  const fuel = hoard(s);
  s = accept(s, createStopRouteAfterRunAction({ guildId: 'g1', vehicleId: VID }));
  assert.equal(craftOf(s).route, undefined, 'it was already at WN with its run finished');
  assert.deepEqual(craftOf(s).location, { ...HEX_B });
  assert.equal(craftOf(s).laneEnded, undefined, 'a player stop, not a failure');
  s = stepUntil(s, (st) => isBoundary(st.tick, 2 * LAP_PERIOD));
  assert.equal(craftOf(s).route, undefined, 'the boundary finds nothing to start');
  assert.equal(hoard(s), fuel, 'nothing burned');
});

test('perCycle: WN == W1 at an OUTPOST — the boundary re-attempt re-queues W1\'s load cleanly', () => {
  // B(load from the Outpost) → A(unload) → B: each lap ends back on W1's Outpost. The next lap starts at
  // the BOUNDARY (step 6), after this tick's dock step has run, so the skipped reposition queues W1's load
  // for the NEXT tick's dock step. Every tick runs through `advance`, so any queue/slot/status corruption
  // this caused would throw here.
  const ring = [...REVERSE(), { anchor: { ...HEX_B } }];
  const CYCLE = 4 * LAP_PERIOD;
  let s = withCycle(routeState({ systemPool: {}, outpostStock: { [T1]: 1600 } }), CYCLE);
  s = accept(s, dispatch(ring, perCycle('nRun', 3)));
  const loadsQueuedAt = [];
  s = stepUntil(s, (st) => {
    const q = st.outposts[0].queue || [];
    if (q.some((e) => e.vehicleId === VID) && loadsQueuedAt[loadsQueuedAt.length - 1] !== st.tick) loadsQueuedAt.push(st.tick);
    return !craftOf(st).route;
  });
  assert.equal(pool(s), 1200, 'three loads at the Outpost, three deliveries to A');
  assert.equal(stock(s), 400, 'the fourth lap\'s goods are still at the Outpost');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at WN (= W1, the Outpost)');
  assert.equal(s.outposts[0].queue, undefined, 'nothing left queued');
  assert.equal(s.outposts[0].slots, undefined, 'no slot left held');
  // Laps 2 and 3 each queued W1's load at a boundary (lap 1's was served straight into a slot on arrival).
  assert.deepEqual(loadsQueuedAt.map((t) => isBoundary(t, CYCLE)), [true, true]);
});

test('perCycle: deterministic — a replay, and a restart mid-hold, land on the same state', () => {
  const CYCLE = 2 * LAP_PERIOD;
  const launch = () => accept(withCycle(routeState(), CYCLE), dispatch(LANE(), perCycle('nRun', 3)));
  const done = (st) => !craftOf(st).route;
  const whole = stepUntil(launch(), done);
  assert.equal(hashState(whole), hashState(stepUntil(launch(), done)), 'same inputs, same run');
  const holding = stepUntil(launch(), (st) => craftOf(st).route && craftOf(st).route.lapsDone === 2 && waitingOf(st));
  const resumed = stepUntil(JSON.parse(JSON.stringify(holding)), done);
  assert.equal(hashState(resumed), hashState(whole), 'the reload resumes at the same boundary the unbroken run did');
});

// --- 4. the wait-reason split ----------------------------------------------------------------------

test('reason: a cadence hold that cannot pay at the boundary becomes a FUEL wait — and runs once it can', () => {
  const CYCLE = 2 * LAP_PERIOD;
  // Fuel for lap 1 and lap 2 exactly: lap 3 cannot be paid for.
  let s = withCycle(routeState({ fuelHoard: LAP1_FUEL + LAP_FUEL }), CYCLE);
  s = accept(s, dispatch(LANE(), perCycle()));
  s = stepUntil(s, (st) => craftOf(st).route.lapsDone === 2);
  assert.deepEqual(waitingOf(s), { reason: 'cadence', sinceTick: s.tick }, 'holding for its cadence after lap 2');
  assert.equal(hoard(s), 0);
  // The boundary comes, but lap 3 is unaffordable: the hold becomes a fuel wait, dated from this boundary.
  s = stepUntil(s, (st) => waitingOf(st).reason === 'fuel');
  const since = s.tick;
  assert.ok(isBoundary(since, CYCLE), 'the reason changed at the boundary re-attempt');
  assert.deepEqual(waitingOf(s), { reason: 'fuel', sinceTick: since });
  assert.deepEqual(snapRow(s).route.waiting, { reason: 'fuel', sinceTick: since });
  assert.equal(craftOf(s).status, 'idle');
  assert.equal(craftOf(s).route.lapsDone, 2, 'no lap ran');
  // The next boundary is still short: it keeps waiting FOR FUEL (not back to cadence), since unchanged.
  s = stepUntil(s, (st) => st.tick > since && isBoundary(st.tick, CYCLE));
  assert.deepEqual(waitingOf(s), { reason: 'fuel', sinceTick: since });
  // Fuel arrives between boundaries: the lane runs on the NEXT boundary, then holds for its cadence again.
  s = grantFuel(s, LAP_FUEL);
  s = stepUntil(s, (st) => waitingOf(st) === undefined);
  assert.equal(s.tick, since + 2 * CYCLE, 'lap 3 ran on the first boundary after the fuel arrived');
  assert.equal(hoard(s), 0, 'fuelled whole');
  s = stepUntil(s, (st) => craftOf(st).route.lapsDone === 3);
  assert.equal(waitingOf(s).reason, 'cadence', 'after lap 3 it is a per-cycle lane holding again — never wedged');
});

test('reason: a stop torn down while the lane holds for its cadence ENDS it at the boundary — flagged, nothing burned', () => {
  const CYCLE = 2 * LAP_PERIOD;
  let s = withCycle(routeState({ systemPool: {}, outpostStock: { [T1]: 4000 } }), CYCLE);
  s = accept(s, dispatch(REVERSE(), perCycle()));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined); // lap 1 done: holding at A (WN)
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR });
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' })); // W1 goes
  const fuel = hoard(s);
  s = stepUntil(s, (st) => !craftOf(st).route);
  assert.ok(isBoundary(s.tick, CYCLE), 'decided at the boundary re-attempt');
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: s.tick }, 'the target check runs first');
  assert.equal(hoard(s), fuel, 'nothing burned for the doomed lap');
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR }, 'idle at WN');
});

test('integrity: a wait is only ever after a completed lap, and only a perCycle lane holds for its cadence', () => {
  let s = withCycle(routeState(), 2 * LAP_PERIOD);
  s = accept(s, dispatch(LANE(), perCycle('nRun', 4)));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined);
  const rules = (mutate) => {
    const c = structuredClone(s);
    mutate(craftOf(c).route);
    return checkInvariants(c, c.tick).map((v) => v.rule).filter((r) => r === 'vehicle-route-valid');
  };
  assert.deepEqual(rules(() => {}), [], 'the real cadence hold is clean');
  assert.deepEqual(rules((r) => { r.waiting.reason = 'bored'; }), ['vehicle-route-valid']);
  assert.deepEqual(rules((r) => { delete r.cadence; }), ['vehicle-route-valid'], 'an immediate lane never holds for cadence');
  assert.deepEqual(rules((r) => { r.lapsDone = 0; r.lapsRemaining = 4; }), ['vehicle-route-valid'], 'a wait before any lap completed');
  assert.deepEqual(rules((r) => { r.stopAfterRun = true; }), ['vehicle-route-valid'], 'a stop never stands beside a wait');
  assert.deepEqual(rules((r) => { r.waiting.reason = 'fuel'; }), [], 'a perCycle lane can wait for fuel too');
});
