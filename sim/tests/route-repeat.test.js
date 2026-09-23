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
//   2. the lap loop — an N-run runs exactly N cycles; a continuous lane keeps cycling on a fixed period;
//      the WN → W1 reposition is flown (and fuelled) each lap, or SKIPPED when WN is W1; each lap's fuel
//      leaves the hoard whole at the lap start; deterministic across replay and a mid-lap restart.
//   3. target-gone ENDS + the flag (§11.6) — a stop's Outpost torn down ends the lane: at WN if caught by
//      the lap-start re-check (nothing burned for the doomed lap), at the bare hex if mid-flight, and at
//      the Outpost's hex if the craft was docked there; `laneEnded` flags why, and the next dispatch clears it.
//   4. fuel-short WAITS + resumes (§11.6 / §11.3) — a lane that can't afford its next lap waits at WN,
//      burning nothing, and re-attempts at each fuel-cycle boundary (never between); lower ids go first
//      when fuel is short for some; a stop that vanishes while it waits ends it; a waiting craft cannot
//      take a manual transfer, and re-dispatching it drops the lane. (An unaffordable lap 1 is REFUSED at
//      launch, never left waiting — section 1.)
//   5. "Stop after this run" (`stopRouteAfterRun`, §11.10) — a repeating lane finishes the lap it is on
//      and ends idle at WN, whatever its mode; a waiting lane (already at WN) ends at once; refused on a
//      craft with no lane, a one-shot, or a lane already stopping.

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
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchRouteWithActionsAction,
  createDispatchVehicleAction, createRemoveOutpostAction, createTransferCargoAction,
  createSetWindowNAction, createAdjustFuelAction, createStopRouteAfterRunAction,
} = require('../actions.js');
const { isWindowBoundary } = require('../windows.js');

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
const LAP_FUEL = burn(HEX_B, A_COORDS) + burn(A_COORDS, HEX_B); // loop-back B → A + the cycle A → B
// The steady-state lap PERIOD of the canonical lane: fly B → A, load (instant at a system), fly A → B,
// then the Outpost turnaround for the unload — at whose completion the next lap departs. Derived from the
// ONE leg-time formula and the ruled class turnaround, never inlined.
const ticksOf = (from, to) => legTicks(hexDistance(from, to), LIGHT.speed, false);
const LAP_PERIOD = ticksOf(HEX_B, A_COORDS) + ticksOf(A_COORDS, HEX_B) + outpostDockTurnaround(LIGHT_TRANSPORT);

// routeState(...) -> an invariant-clean galaxy: guild g1 with one idle light craft at ORIGIN (or
// `craftAt`), 400 titanium per lap in its (g1, A) pool, and its Outpost `outpost_g1_01` on HEX_B.
function routeState({
  systemPool, fuelHoard = 1000000, craftAt = { ...ORIGIN }, outpostStock,
} = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard, outpostSerial: 1 };
  if (systemPool) guild.stockpiles = { [SYS_A]: { ...systemPool } };
  const outpost = {
    id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: SYS_A, coords: { ...HEX_B }, createdAtTick: 0,
    ...(outpostStock ? { stockpile: { ...outpostStock } } : {}),
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
const pool = (s) => ((s.guilds[0].stockpiles || {})[SYS_A] || {})[T1] || 0;
const stock = (s) => ((s.outposts[0] || {}).stockpile || {})[T1] || 0;
// step(s) — one full turn through the real driver, which ASSERTS EVERY INVARIANT on the result and throws
// with the tick number on any violation — so every lane below is invariant-checked on every tick.
const step = (s) => advance(s, []).state;
const tearDownB = (s) => accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
const fuelOf = (s) => ({ hoard: s.guilds[0].fuelHoard, consumed: s.audit.totalConsumed });
const stepUntil = (state, pred, cap = 20000) => {
  let s = state;
  let i = 0;
  while (!pred(s) && i < cap) { s = step(s); i += 1; }
  assert.ok(pred(s), `condition not met within ${cap} ticks`);
  return s;
};

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

// --- 2. the lap loop ------------------------------------------------------------------------------

test('nRun: an n=3 lane runs EXACTLY three cycles (400 moved each), lapsRemaining 3→2→1→0, then idles at WN', () => {
  // Enough titanium at A for FOUR laps, so a 4th cycle — if one ever ran — would have goods to move.
  let s = accept(routeState({ systemPool: { [T1]: 1600 } }), dispatch(LANE(), { mode: 'nRun', n: 3 }));
  const seen = [3];
  s = stepUntil(s, (st) => {
    const laps = craftOf(st).route ? craftOf(st).route.lapsRemaining : 0;
    if (laps !== seen[seen.length - 1]) seen.push(laps);
    return !craftOf(st).route;
  });
  assert.deepEqual(seen, [3, 2, 1, 0], 'one lap counted down per finished cycle, never skipping');
  assert.equal(stock(s), 1200, 'exactly three unloads of 400 reached the Outpost');
  assert.equal(pool(s), 400, 'the fourth lap\'s titanium is still at A');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at WN (the last waypoint)');
  assert.equal(craftOf(s).trip, undefined);
  // A 4th cycle never happens, however long the galaxy runs on.
  for (let i = 0; i < 3 * LAP_PERIOD; i += 1) s = step(s);
  assert.equal(stock(s), 1200, 'no 4th cycle');
  assert.equal(pool(s), 400);
  assert.deepEqual(craftOf(s).location, { ...HEX_B });
});

test('continuous: the lane keeps cycling — one 400 unload per lap on a fixed period, never twice in a tick', () => {
  let s = accept(routeState({ systemPool: { [T1]: 400 * 50 } }), dispatch(LANE(), { mode: 'continuous' }));
  const unloadTicks = [];
  let prev = stock(s);
  while (unloadTicks.length < 6) {
    s = step(s);
    const now = stock(s);
    if (now !== prev) {
      assert.equal(now - prev, 400, `exactly one lap's unload lands in tick ${s.tick} (never two)`);
      unloadTicks.push(s.tick);
    }
    prev = now;
  }
  // After lap 1 (which also flew the positioning leg), every lap takes exactly the same number of ticks.
  for (let i = 1; i < unloadTicks.length; i += 1) {
    assert.equal(unloadTicks[i] - unloadTicks[i - 1], LAP_PERIOD, `lap ${i + 1} took one lap period`);
  }
  assert.equal(craftOf(s).route.mode, 'continuous', 'still a live lane after six laps');
  assert.equal(pool(s), 400 * 50 - 400 * 6 - (craftOf(s).cargo ? craftOf(s).cargo[T1] : 0), 'goods conserved: pool + hold + stock');
});

test('reposition: WN ≠ W1 — each lap flies the WN → W1 loop-back leg, and the lap\'s fuel includes it', () => {
  let s = accept(routeState({ systemPool: { [T1]: 400 * 10 } }), dispatch(LANE(), { mode: 'continuous' }));
  // Lap 2 starts at B's first turnaround completion: the craft departs B for A on the loop-back leg.
  s = stepUntil(s, (st) => stock(st) === 400);
  const leg = craftOf(s).trip.legs[0];
  assert.deepEqual(leg.from, { ...HEX_B }, 'the reposition departs WN');
  assert.deepEqual(leg.to, { ...SYS_ANCHOR }, 'the reposition flies to W1');
  assert.equal(leg.departureTick, s.tick, 'it departs the tick the lap ended');
  assert.equal(craftOf(s).route.cursor, 0, 'heading for W1 again');
  assert.equal(LAP_FUEL, burn(HEX_B, A_COORDS) + burn(A_COORDS, HEX_B), 'lap bill = loop-back + cycle (§11.4)');
});

test('reposition: WN == W1 — the zero-length loop-back is SKIPPED; W1 resolves in place, no dead leg ever', () => {
  // The lane A(load) → B(unload) → A: it ends each lap back ON W1, so the reposition is zero-length.
  const ring = () => [...LANE(), { anchor: { ...SYS_ANCHOR } }];
  let s = accept(routeState({ systemPool: { [T1]: 1600 } }), dispatch(ring(), { mode: 'nRun', n: 3 }));
  const hoardAtStart = s.guilds[0].fuelHoard;
  const seenLegs = [];
  s = stepUntil(s, (st) => {
    const c = craftOf(st);
    if (c.trip) {
      const l = c.trip.legs[0];
      assert.notDeepEqual(l.from, l.to, `a zero-length leg was built at tick ${st.tick}`);
      assert.ok(l.arrivalTick > l.departureTick, 'every leg takes time');
      if (!seenLegs.some((x) => x.departureTick === l.departureTick)) seenLegs.push(l);
    }
    return !c.route;
  });
  // Three cycles: lap 1 = ORIGIN → A, A → B, B → A; laps 2–3 = A → B, B → A (no A → A reposition).
  assert.equal(seenLegs.length, 3 + 2 + 2, 'no reposition leg on laps 2 and 3');
  assert.equal(stock(s), 1200, 'three loads + unloads — W1\'s load ran in place each lap');
  assert.equal(pool(s), 400);
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR }, 'idle at WN (= W1)');
  const lap1 = burn(ORIGIN, A_COORDS) + burn(A_COORDS, HEX_B) + burn(HEX_B, A_COORDS);
  const cycle = burn(A_COORDS, HEX_B) + burn(HEX_B, A_COORDS);
  assert.equal(hoardAtStart - s.guilds[0].fuelHoard, 2 * cycle, 'laps 2–3 paid only the cycle — nothing for a skipped reposition');
  assert.equal(s.audit.totalConsumed, lap1 + 2 * cycle, 'invariant 1: every unit burned is recorded');
});

test('fuel: each lap\'s WHOLE bill leaves the hoard at the lap start — never mid-lap', () => {
  let s = accept(routeState({ systemPool: { [T1]: 400 * 10 }, fuelHoard: 1000 }), dispatch(LANE(), { mode: 'continuous' }));
  assert.equal(s.guilds[0].fuelHoard, 1000 - LAP1_FUEL, 'lap 1 burned at launch');
  let lapStarts = 0;
  let prevHoard = s.guilds[0].fuelHoard;
  let prevConsumed = s.audit.totalConsumed;
  while (lapStarts < 4) {
    s = step(s);
    const hoard = s.guilds[0].fuelHoard;
    if (hoard !== prevHoard) {
      // The only ticks the hoard moves are lap starts: the craft has just left WN for W1.
      const leg = craftOf(s).trip.legs[0];
      assert.deepEqual(leg.from, { ...HEX_B }, `the burn at tick ${s.tick} is a lap start (departing WN)`);
      assert.equal(leg.departureTick, s.tick);
      assert.equal(prevHoard - hoard, LAP_FUEL, 'the whole lap, up front');
      assert.equal(s.audit.totalConsumed - prevConsumed, LAP_FUEL, 'totalConsumed rises to match (invariant 1)');
      lapStarts += 1;
    }
    prevHoard = hoard;
    prevConsumed = s.audit.totalConsumed;
  }
});

test('determinism: a repeating lane replays byte-identically, and a mid-lap restart lands on the same state', () => {
  const launch = () => accept(routeState({ systemPool: { [T1]: 400 * 20 } }), dispatch(LANE(), { mode: 'nRun', n: 4 }));
  const done = (st) => !craftOf(st).route;
  const whole = stepUntil(launch(), done);
  assert.equal(hashState(whole), hashState(stepUntil(launch(), done)), 'same inputs, same run');
  // Restart in the middle of lap 2 (flying the loop-back, 3 laps to go): a JSON save/reload, then the rest.
  const mid = stepUntil(launch(), (st) => craftOf(st).route && craftOf(st).route.lapsRemaining === 3
    && craftOf(st).status === 'inTransit' && craftOf(st).route.cursor === 0);
  const resumed = stepUntil(JSON.parse(JSON.stringify(mid)), done);
  assert.equal(hashState(resumed), hashState(whole), 'the reload lands exactly where the unbroken run did');
});

// --- 3. target-gone ENDS + the flag ----------------------------------------------------------------

// The REVERSED lane: load 400 from the Outpost on HEX_B (W1), deliver it to system A (WN). Its last stop
// is a system, so a craft that finishes a lap sits at A while the Outpost — a stop of its NEXT lap — can
// vanish behind it: exactly the case the lap-start re-check exists for.
const REVERSE = () => [
  { anchor: { ...HEX_B }, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
  { anchor: { ...SYS_ANCHOR }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
];

test('target-gone at the LAP START: the lane ENDS idle at WN, flagged — and the doomed lap burns nothing', () => {
  let s = accept(routeState({ outpostStock: { [T1]: 4000 } }), dispatch(REVERSE(), { mode: 'continuous' }));
  // Lap 1: load at B, then fly to A. Tear B down while the craft is on the B → A leg.
  s = stepUntil(s, (st) => craftOf(st).route.cursor === 1 && craftOf(st).status === 'inTransit');
  s = tearDownB(s);
  const fuelBefore = fuelOf(s);
  // The craft reaches A, unloads — and the lap-start re-check finds lap 2's first stop gone.
  s = stepUntil(s, (st) => !craftOf(st).route);
  assert.equal(pool(s), 400, 'lap 1 finished properly: the 400 was delivered to A');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR }, 'idle at WN (the safe berth)');
  assert.equal(craftOf(s).trip, undefined, 'no leg was built toward the vanished stop');
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: s.tick }, 'flagged, with the tick it ended');
  assert.deepEqual(fuelOf(s), fuelBefore, 'the check precedes the burn — the aborted lap cost nothing (and nothing to refund)');
  assert.deepEqual(snapRow(s).laneEnded, { reason: 'target-gone', tick: s.tick }, 'surfaced in the snapshot');
  assert.equal(snapRow(s).route, undefined, 'an ordinary idle craft — no route to resume');
  // It stays that way: no resume-in-place (§11.6).
  for (let i = 0; i < LAP_PERIOD; i += 1) s = step(s);
  assert.equal(craftOf(s).route, undefined);
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR });
});

test('target-gone MID-FLIGHT: the craft arrives at the now-bare hex and the lane ENDS there, flagged', () => {
  let s = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => craftOf(st).route.cursor === 1 && craftOf(st).status === 'inTransit'); // A → B
  const fuelBefore = fuelOf(s);
  s = tearDownB(s);
  s = stepUntil(s, (st) => !craftOf(st).route);
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle in deep space at the bare hex');
  assert.deepEqual(craftOf(s).cargo, { [T1]: 400 }, 'still laden — the unload never resolved');
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: s.tick });
  assert.deepEqual(fuelOf(s), fuelBefore, 'the lap was paid at its start; nothing is refunded (§11.3)');
});

test('target-gone while DOCKED: an Outpost torn down under a routed craft ends its lane on the spot', () => {
  let s = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => craftOf(st).status === 'loading'); // in B's dock slot, mid-turnaround
  s = tearDownB(s);
  assert.equal(craftOf(s).status, 'idle', 'evicted into space (§4)');
  assert.equal(craftOf(s).route, undefined, 'the lane ended — its stop died with the Outpost');
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: s.tick }, 'flagged at the teardown tick');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // Before this slice the craft kept a route nothing could ever advance. Now it is simply idle.
  for (let i = 0; i < 2 * LAP_PERIOD; i += 1) s = step(s);
  assert.equal(craftOf(s).route, undefined);
  assert.deepEqual(craftOf(s).location, { ...HEX_B });
});

test('target-gone: a ONE-SHOT route that loses its stop is flagged too (the 1a safe halt, now the ruled END)', () => {
  let s = accept(routeState({ systemPool: { [T1]: 400 } }), dispatch(LANE()));
  s = stepUntil(s, (st) => craftOf(st).route.cursor === 1 && craftOf(st).status === 'inTransit');
  s = tearDownB(s);
  s = stepUntil(s, (st) => !craftOf(st).route);
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: s.tick });
});

test('the laneEnded flag is cleared by the next dispatch — plain or routed — and by nothing else', () => {
  // A craft whose lane ended at the torn-down Outpost's (now bare) hex.
  let ended = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  ended = stepUntil(ended, (st) => craftOf(st).status === 'loading');
  ended = tearDownB(ended);
  assert.ok(craftOf(ended).laneEnded);
  // A manual transfer is not a dispatch, so the flag stays. A transfer needs a store, so this uses a craft
  // whose lane ended AT a system: the reversed lane, caught by the lap-start re-check at A.
  let atA = accept(routeState({ outpostStock: { [T1]: 4000 } }), dispatch(REVERSE(), { mode: 'continuous' }));
  atA = stepUntil(atA, (st) => craftOf(st).route.cursor === 1 && craftOf(st).status === 'inTransit');
  atA = stepUntil(tearDownB(atA), (st) => !craftOf(st).route);
  const flag = craftOf(atA).laneEnded;
  atA = accept(atA, createTransferCargoAction({ guildId: 'g1', vehicleId: VID, manifest: [{ dir: 'load', good: T1, qty: 1 }] }));
  assert.deepEqual(craftOf(atA).laneEnded, flag, 'a transfer leaves the flag alone');
  // A plain dispatch clears it…
  const plain = accept(ended, createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints: [{ ...SYS_ANCHOR }] }));
  assert.equal(craftOf(plain).laneEnded, undefined, 'cleared by a plain dispatch');
  // …and so does a routed one.
  const routed = accept(ended, dispatch([{ anchor: { ...SYS_ANCHOR } }, { anchor: { ...ORIGIN } }]));
  assert.equal(craftOf(routed).laneEnded, undefined, 'cleared by a routed dispatch');
  assert.equal(snapRow(routed).laneEnded, undefined);
});

test('integrity: a malformed laneEnded, or one riding a live route, fails loudly', () => {
  let s = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => craftOf(st).status === 'loading');
  s = tearDownB(s);
  const rules = (mutate) => {
    const c = structuredClone(s);
    mutate(craftOf(c));
    return checkInvariants(c, c.tick).map((v) => v.rule).filter((r) => r.startsWith('vehicle-lane-ended'));
  };
  assert.deepEqual(rules(() => {}), [], 'the real flag is clean');
  assert.deepEqual(rules((c) => { c.laneEnded.reason = 'bored'; }), ['vehicle-lane-ended-valid']);
  assert.deepEqual(rules((c) => { c.laneEnded.tick = s.tick + 1; }), ['vehicle-lane-ended-valid'], 'a flag from the future');
  assert.deepEqual(rules((c) => { c.laneEnded.tick = 1.5; }), ['vehicle-lane-ended-valid']);
  assert.deepEqual(rules((c) => { c.route = { waypoints: LANE(), cursor: 0 }; }), ['vehicle-lane-ended-no-route']);
});

// --- 4. fuel-short WAITS, and resumes at the fuel-cycle boundary ---------------------------------

// A short fuel cycle (a setup-only knob, set at tick 0) so the boundaries — where the hoard grows and a
// waiting lane re-attempts — come every CYCLE ticks instead of once a day. The guild has no holdings, so
// the boundary grants it nothing: the only fuel it gets is what a test hands it with adjustFuel.
const CYCLE = 100;
const shortCycle = (s) => accept(s, createSetWindowNAction({ windowN: CYCLE }));
const isBoundary = (tick) => isWindowBoundary(tick, CYCLE, 0);
const grantFuel = (s, units) => accept(s, createAdjustFuelAction({ guildId: 'g1', delta: units }));
const waitingOf = (s, vid = VID) => {
  const c = s.guilds[0].vehicles.find((v) => v.id === vid);
  return c.route ? c.route.waiting : undefined;
};

test('fuel WAITS at WN: nothing burned, route intact — through a boundary while short, then resumes ON the next one', () => {
  // Fuel for lap 1 and lap 2 only: lap 3 cannot be paid for up front.
  let s = shortCycle(routeState({ systemPool: { [T1]: 4000 }, fuelHoard: LAP1_FUEL + LAP_FUEL }));
  s = accept(s, dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined);
  const since = s.tick;
  assert.deepEqual(craftOf(s).route.waiting, { reason: 'fuel', sinceTick: since });
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'waiting at WN, the safe berth');
  assert.equal(craftOf(s).trip, undefined);
  assert.equal(craftOf(s).route.cursor, 1, 'route intact, at its last waypoint');
  assert.equal(craftOf(s).route.mode, 'continuous');
  assert.equal(stock(s), 800, 'two full laps delivered before the wait');
  assert.deepEqual(fuelOf(s), { hoard: 0, consumed: LAP1_FUEL + LAP_FUEL }, 'the unaffordable lap burned nothing');
  assert.deepEqual(snapRow(s).route.waiting, { reason: 'fuel', sinceTick: since }, 'surfaced in the snapshot');

  // A boundary passes while the hoard is still short: it keeps waiting, since-tick unchanged.
  s = stepUntil(s, (st) => isBoundary(st.tick) && st.tick > since);
  s = step(s);
  assert.deepEqual(craftOf(s).route.waiting, { reason: 'fuel', sinceTick: since });
  assert.equal(stock(s), 800);

  // Fuel arrives BETWEEN boundaries — the lane does not jump at it; it resumes on the next boundary.
  if (isBoundary(s.tick + 1)) s = step(s); // make sure the grant lands strictly between boundaries
  s = grantFuel(s, LAP_FUEL * 3);
  const grantTick = s.tick;
  let firstBoundary = grantTick + 1;
  while (!isBoundary(firstBoundary)) firstBoundary += 1;
  s = stepUntil(s, (st) => waitingOf(st) === undefined);
  assert.equal(s.tick, firstBoundary, 'resumed on the first fuel-cycle boundary after the grant, not before');
  assert.equal(craftOf(s).status, 'inTransit', 'on its way to W1 again');
  assert.deepEqual(craftOf(s).trip.legs[0].from, { ...HEX_B }, 'the lap starts with the loop-back from WN');
  assert.equal(s.guilds[0].fuelHoard, LAP_FUEL * 2, 'the resumed lap burned its whole bill up front');
  // …and cycles on.
  s = stepUntil(s, (st) => stock(st) === 1200);
  assert.equal(craftOf(s).route.mode, 'continuous');
});

test('fuel WAIT: when a boundary can pay for only one of two waiting lanes, the LOWER id resumes', () => {
  const run = () => {
    let s = shortCycle(routeState({ systemPool: { [T1]: 4000 }, fuelHoard: 2 * LAP1_FUEL }));
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { ...ORIGIN } }));
    const VID2 = 'vehicle_g1_lightTransport_02';
    s = accept(s, dispatch(LANE(), { mode: 'continuous' }));
    s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: VID2, waypoints: LANE(), repeat: { mode: 'continuous' } }));
    s = stepUntil(s, (st) => waitingOf(st) && waitingOf(st, VID2));
    if (isBoundary(s.tick + 1)) s = step(s);
    s = grantFuel(s, LAP_FUEL); // one lap's worth, for two waiting lanes
    s = stepUntil(s, (st) => !waitingOf(st) || !waitingOf(st, VID2));
    assert.equal(waitingOf(s), undefined, '_01 resumed (fixed id order)');
    assert.ok(waitingOf(s, VID2), '_02 still waits — the hoard ran dry on _01');
    assert.equal(s.guilds[0].fuelHoard, 0);
    return s;
  };
  assert.equal(hashState(run()), hashState(run()), 'the re-attempt is deterministic');
});

test('fuel WAIT: a stop that vanishes while the lane waits ENDS it at the boundary — flagged, nothing burned', () => {
  // The reversed lane waits at A (a system). Its lap-1 bill: ORIGIN → B, then B → A.
  const REV_LAP1 = burn(ORIGIN, HEX_B) + burn(HEX_B, A_COORDS);
  let s = shortCycle(routeState({ outpostStock: { [T1]: 4000 }, fuelHoard: REV_LAP1 }));
  s = accept(s, dispatch(REVERSE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined);
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR });
  s = tearDownB(s); // W1's Outpost goes while the lane waits…
  s = grantFuel(s, 1000); // …and the fuel it needed arrives
  const fuelBefore = fuelOf(s);
  s = stepUntil(s, (st) => !craftOf(st).route);
  assert.ok(isBoundary(s.tick), 'decided at the boundary re-attempt');
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: s.tick }, 'the target check runs first');
  assert.deepEqual(fuelOf(s), fuelBefore, 'nothing burned for the doomed lap');
  assert.deepEqual(craftOf(s).location, { ...SYS_ANCHOR }, 'idle at WN');
});

test('fuel WAIT: a waiting craft refuses a manual transfer; re-dispatching it drops the lane (plain or routed)', () => {
  let s = shortCycle(routeState({ systemPool: { [T1]: 4000 }, fuelHoard: LAP1_FUEL }));
  s = accept(s, dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined); // waiting, parked at its Outpost (WN)
  assert.match(
    refuse(s, createTransferCargoAction({ guildId: 'g1', vehicleId: VID, manifest: [{ dir: 'load', good: T1, qty: 1 }] })),
    /running a lane/,
  );
  s = grantFuel(s, 10);
  // A plain dispatch: the lane is dropped, the craft flies the plain trip and lands as an ordinary craft.
  let plain = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints: [{ ...ORIGIN }] }));
  assert.equal(craftOf(plain).route, undefined, 'the waiting lane is dropped');
  plain = stepUntil(plain, (st) => craftOf(st).status === 'idle');
  assert.deepEqual(craftOf(plain).location, { ...ORIGIN });
  assert.equal(craftOf(plain).route, undefined);
  // A routed re-dispatch replaces it with the new route (no `waiting` carried over).
  const routed = accept(s, dispatch([{ anchor: { ...SYS_ANCHOR } }, { anchor: { ...ORIGIN } }]));
  assert.deepEqual(Object.keys(craftOf(routed).route).sort(), ['cursor', 'waypoints']);
});

test('integrity: a malformed or misplaced fuel wait fails loudly', () => {
  let s = shortCycle(routeState({ systemPool: { [T1]: 4000 }, fuelHoard: LAP1_FUEL }));
  s = accept(s, dispatch(LANE(), { mode: 'nRun', n: 5 }));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined);
  const rules = (mutate) => {
    const c = structuredClone(s);
    mutate(craftOf(c));
    return checkInvariants(c, c.tick).map((v) => v.rule).filter((r) => r === 'vehicle-route-valid' || r === 'vehicle-waiting-lane-idle');
  };
  assert.deepEqual(rules(() => {}), [], 'the real wait is clean');
  assert.deepEqual(rules((c) => { c.route.waiting.reason = 'bored'; }), ['vehicle-route-valid']);
  assert.deepEqual(rules((c) => { c.route.waiting.sinceTick = 2.5; }), ['vehicle-route-valid']);
  assert.deepEqual(rules((c) => { c.route.cursor = 0; }), ['vehicle-route-valid'], 'a wait anywhere but WN');
  assert.deepEqual(rules((c) => { delete c.route.mode; delete c.route.lapsRemaining; }), ['vehicle-route-valid'], 'a one-shot never waits');
  assert.deepEqual(rules((c) => { c.route.waiting.sinceTick = s.tick + 1; }), ['vehicle-waiting-lane-idle'], 'a wait from the future');
  assert.deepEqual(rules((c) => { c.status = 'loading'; }), ['vehicle-waiting-lane-idle'], 'a waiting craft sits idle');
});

// --- 5. "Stop after this run" ---------------------------------------------------------------------

const stopAfterRun = (vid = VID) => createStopRouteAfterRunAction({ guildId: 'g1', vehicleId: vid });

test('stop after run: a continuous lane finishes the lap it is on, lands idle at WN and ends — no more laps', () => {
  let s = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => stock(st) === 800); // two laps done; lap 3 under way
  s = stepUntil(s, (st) => craftOf(st).route.cursor === 1 && craftOf(st).status === 'inTransit'); // mid lap 3, A → B
  s = accept(s, stopAfterRun());
  assert.equal(craftOf(s).route.stopAfterRun, true);
  assert.equal(craftOf(s).updatedAtTick, s.tick, 'the stop records its tick (§15.2)');
  assert.equal(snapRow(s).route.stopAfterRun, true, 'surfaced in the snapshot');
  assert.equal(craftOf(s).status, 'inTransit', 'a clean stop — the lap carries on, nothing snaps');
  const fuelMidLap = fuelOf(s);
  s = stepUntil(s, (st) => !craftOf(st).route);
  assert.equal(stock(s), 1200, 'the lap it was on finished — its unload landed');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at WN');
  assert.equal(craftOf(s).laneEnded, undefined, 'a player stop is not a failure — no flag');
  assert.deepEqual(fuelOf(s), fuelMidLap, 'no next lap was fuelled');
  for (let i = 0; i < 2 * LAP_PERIOD; i += 1) s = step(s);
  assert.equal(stock(s), 1200, 'and no lap ever starts again');
});

test('stop after run: overrides an N-run\'s remaining laps; is deterministic on replay', () => {
  const run = () => {
    let s = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'nRun', n: 5 }));
    s = accept(s, stopAfterRun()); // straight away — lap 1 is the last
    return stepUntil(s, (st) => !craftOf(st).route);
  };
  const s = run();
  assert.equal(stock(s), 400, 'one lap, not five');
  assert.equal(hashState(s), hashState(run()));
});

test('stop after run: a lane WAITING for fuel is already at WN — it ends right there, now', () => {
  let s = shortCycle(routeState({ systemPool: { [T1]: 4000 }, fuelHoard: LAP1_FUEL }));
  s = accept(s, dispatch(LANE(), { mode: 'continuous' }));
  s = stepUntil(s, (st) => waitingOf(st) !== undefined);
  const fuel = fuelOf(s);
  s = accept(s, stopAfterRun());
  assert.equal(craftOf(s).route, undefined, 'the lane ended on the spot');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'an ordinary idle craft at WN');
  assert.deepEqual(fuelOf(s), fuel, 'nothing burned');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // A later boundary finds nothing to resume.
  s = grantFuel(s, 100);
  s = stepUntil(s, (st) => isBoundary(st.tick));
  assert.equal(craftOf(s).route, undefined);
});

test('stop after run: refused on a craft with no lane, on a one-shot, and on a lane already stopping', () => {
  const idle = routeState({ systemPool: { [T1]: 4000 } });
  assert.match(refuse(idle, stopAfterRun()), /not running a route/);
  const once = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE()));
  assert.match(refuse(once, stopAfterRun()), /one-shot route — it already ends after this run/);
  let lane = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  lane = accept(lane, stopAfterRun());
  assert.match(refuse(lane, stopAfterRun()), /already set to stop after this run/);
  assert.match(refuse(lane, createStopRouteAfterRunAction({ guildId: 'g1', vehicleId: 'vehicle_g1_nope' })), /owns no vehicle/);
  assert.match(refuse(lane, createStopRouteAfterRunAction({ guildId: 'g9', vehicleId: VID })), /no guild/);
});

test('integrity: stopAfterRun is `true` on a running repeating lane only', () => {
  let s = accept(routeState({ systemPool: { [T1]: 4000 } }), dispatch(LANE(), { mode: 'continuous' }));
  s = accept(s, stopAfterRun());
  const bad = (mutate) => {
    const c = structuredClone(s);
    mutate(craftOf(c).route);
    return checkInvariants(c, c.tick).filter((v) => v.rule === 'vehicle-route-valid').length;
  };
  assert.equal(bad(() => {}), 0);
  assert.equal(bad((r) => { r.stopAfterRun = 'yes'; }), 1);
  assert.equal(bad((r) => { delete r.mode; }), 1, 'a one-shot carries no stop');
  assert.equal(bad((r) => { r.waiting = { reason: 'fuel', sinceTick: 0 }; r.cursor = 1; }), 1, 'never beside a wait');
});
