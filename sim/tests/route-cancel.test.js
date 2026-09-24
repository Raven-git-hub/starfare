'use strict';

// route-cancel.test.js — the transport AUTOMATION layer, slice 3b: CANCEL (transport-model.md §11.10 "Cancel",
// §2.3 / §2.4; roadmap 2.2 automation slice 3b). Cancel ends a craft's lane AT ONCE: a craft in flight SNAPS
// to the hex it is over (its position interpolated along the current leg from the tick clock, rounded to a
// hex) and goes idle there; a craft parked mid-lane just drops its route where it sits.
//
// This file grows with the slice, one section per commit:
//   1. the snap maths — `cubeRound` / `legHexAtTick` (sim/transport.js) pinned to hand-computed hexes:
//      mid-leg, the cube correction, the endpoints + clamp, an exact tie, and the refusals of a bad schedule.
//   2. `cancelRoute` (sim/actions.js) — a craft in flight (a routed lane AND a plain multi-leg dispatch)
//      snaps to the ACTIVE leg's hex and is an ordinary idle craft (no trip, no route, no flag, nothing
//      refunded); a parked lane (waiting for fuel / cadence, queued or loading at an Outpost stop) just
//      drops its route, the queue entry swept and a loading turnaround left to finish; refusals (no lane,
//      unknown craft / guild) change nothing; the toll stub refuses; a snap off the lattice's rim is
//      refused for that tick; replay and a mid-flight restart are byte-identical; the existing integrity
//      checks cover the snapped shape. Every multi-tick run goes through `advance`, which asserts every
//      invariant on every tick.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const {
  hexDistance, cubeRound, legHexAtTick, legTicks, legFuelBurn,
} = require('../transport.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const { outpostDockTurnaround } = require('../outposts.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { isWindowBoundary } = require('../windows.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction, intake, createSpawnVehicleAction, createDispatchRouteWithActionsAction,
  createDispatchVehicleAction, createSetWindowNAction, createAdjustFuelAction, createCancelRouteAction,
} = require('../actions.js');

// --- 1. the snap maths ----------------------------------------------------------------------------

// The worked leg every snap test below uses: from (0, 0) to (9, 7). Its hex length is
// (|9| + |7| + |9 + 7|) / 2 = 16, so a light craft (105 ticks per hex) flies it in 16 × 105 = 1,680 ticks.
const O = { q: 0, r: 0 };
const NINE_SEVEN = { q: 9, r: 7 };
const SPAN = 1680;

test('snap: the cube correction — the point (0.45, 0.35) is in hex (1, 0), not the (0, 0) that rounding q and r alone gives', () => {
  // By hand (sim/transport.js cubeRound): s = −0.45 − 0.35 = −0.8. Round all three: q 0.45 → 0 (moved 0.45),
  // r 0.35 → 0 (moved 0.35), s −0.8 → −1 (moved 0.2). They add to −1, not 0, so the one that moved furthest,
  // q, is rebuilt from the other two: q = −r − s = 0 + 1 = 1.
  assert.deepEqual(cubeRound(45, 35, 100), { q: 1, r: 0 });
  assert.deepEqual(cubeRound(9, 7, 20), { q: 1, r: 0 }, 'the same point over another denominator');
  // An exact hex centre is itself.
  assert.deepEqual(cubeRound(300, -200, 100), { q: 3, r: -2 });
  assert.deepEqual(cubeRound(-7, 14, 7), { q: -1, r: 2 });
});

test('snap: mid-leg — half-way from (0,0) to (9,7) is the edge between (5,3) and (4,4); the fixed tie rule picks (5,3)', () => {
  // Half-way in time is half-way in space (§2.3): tick 840 of 1,680 is the point (4.5, 3.5). By hand:
  // s = −8. q 4.5 → 5 (a half rounds up; moved 0.5), r 3.5 → 4 (moved 0.5), s −8 → −8 (moved 0). They add
  // to 1, not 0. q and r moved equally far; the fixed order (q only if it moved STRICTLY furthest, else r if
  // it moved further than s) rebuilds r: r = −q − s = −5 + 8 = 3. So (5, 3). The point really is on the
  // edge — (5,3) and (4,4) are exactly as close — and rounding q and r alone would give (5, 4), which is not.
  assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 0, SPAN, 840), { q: 5, r: 3 });
  // The same leg, departing at tick 1,000, cancelled 840 ticks in — the answer depends on the time flown,
  // not on the clock reading.
  assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 1000, 1000 + SPAN, 1840), { q: 5, r: 3 });
  // 1/20 of the way (84 of 1,680 ticks) is the point (0.45, 0.35) — the cube-correction case above.
  assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 0, SPAN, 84), { q: 1, r: 0 });
  // Moving the whole leg by a whole-hex offset moves the answer by the same offset.
  const P = { q: -88, r: 73 };
  assert.deepEqual(legHexAtTick(P, { q: P.q + 9, r: P.r + 7 }, 0, SPAN, 840), { q: P.q + 5, r: P.r + 3 });
  // Flown the other way, the SAME point is the SAME hex: it is where the craft is that decides, never
  // which way it is heading.
  assert.deepEqual(legHexAtTick(NINE_SEVEN, O, 0, SPAN, 840), { q: 5, r: 3 });
});

test('snap: the endpoints and the clamp — at departure it is on `from`, at arrival on `to`, and never beyond either', () => {
  const from = { q: 2, r: -3 };
  const to = { q: -4, r: 5 };
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 100), from, 'at departureTick: the start hex');
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 900), to, 'at arrivalTick: the end hex');
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 5), from, 'before departure: clamped to the start');
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 99999), to, 'after arrival: clamped to the end');
  // The shortest leg there is: one tick.
  assert.deepEqual(legHexAtTick(from, to, 10, 11, 10), from);
  assert.deepEqual(legHexAtTick(from, to, 10, 11, 11), to);
});

test('snap: tick by tick a craft moves hex to neighbouring hex — never a jump — from `from` to `to`', () => {
  let prev = legHexAtTick(O, NINE_SEVEN, 0, SPAN, 0);
  assert.deepEqual(prev, O);
  const seen = new Set([`${prev.q},${prev.r}`]);
  for (let t = 1; t <= SPAN; t += 1) {
    const hex = legHexAtTick(O, NINE_SEVEN, 0, SPAN, t);
    assert.ok(hexDistance(prev, hex) <= 1, `tick ${t}: ${JSON.stringify(prev)} → ${JSON.stringify(hex)} is a jump`);
    seen.add(`${hex.q},${hex.r}`);
    prev = hex;
  }
  assert.deepEqual(prev, NINE_SEVEN, 'it ends on the end hex');
  // A straight line 16 hexes long crosses at least 17 hexes.
  assert.ok(seen.size >= 17, `crossed ${seen.size} hexes`);
});

test('snap: an exact tie is settled by the fixed rule, never by floating point; no negative zero', () => {
  // The point (123366, 4876) / 659 ≈ (187.20, 7.40). By hand: q → 187 (moved 133/659), r → 7 (moved 263/659),
  // s = −128242/659 → −195 (moved 263/659). r and s tie EXACTLY at 263/659 — the point is on an edge — so the
  // fixed order rebuilds s (r did not move STRICTLY further than s), leaving (187, 7). The textbook decimal
  // version of this algorithm returns (187, 8) here: in floating point the two 263/659s come out a hair
  // apart and tip the tie. Whole-number maths has no hair to tip.
  assert.deepEqual(cubeRound(123366, 4876, 659), { q: 187, r: 7 });
  // Every call on the same point gives the same hex.
  for (let i = 0; i < 3; i += 1) assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 0, SPAN, 840), { q: 5, r: 3 });
  // (0.4, −0.3): q is rebuilt as −r − s = −0 − 0, which JavaScript evaluates to NEGATIVE zero. It must come
  // back as a plain 0 (deepEqual tells the two apart; so would a replay comparing states).
  const h = cubeRound(4, -3, 10);
  assert.ok(Object.is(h.q, 0) && Object.is(h.r, 0), `got ${JSON.stringify(h)} with q ${Object.is(h.q, -0) ? '-0' : h.q}`);
});

test('snap: refuses a schedule it cannot trust — a fractional tick or coord, or a leg that takes no time', () => {
  assert.throws(() => legHexAtTick(O, NINE_SEVEN, 0, SPAN, 840.5), /whole-number coords and ticks/);
  assert.throws(() => legHexAtTick({ q: 0.5, r: 0 }, NINE_SEVEN, 0, SPAN, 840), /whole-number coords and ticks/);
  assert.throws(() => legHexAtTick(O, NINE_SEVEN, 50, 50, 50), /at least one tick/);
  assert.throws(() => legHexAtTick(O, NINE_SEVEN, 60, 50, 55), /at least one tick/);
});

// --- 2. cancelRoute --------------------------------------------------------------------------------

const SYS_A = starterHomeAtDistance(6).id; // a real seed system — a lane's LOAD stop
const A_COORDS = getSystem(SYS_A).coords;
const SYS_ANCHOR = { landmarkKind: 'system', landmarkId: SYS_A };
const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT];
const VID = 'vehicle_g1_lightTransport_01';
const T1 = 'titanium'; // volumeOf === 1

// The in-bounds, landmark-free hexes nearest system A (derived from the seed, as route-repeat.test.js does,
// so a seed regen carries the test). ORIGIN is the launch berth; HEX_B is the guild's Outpost tile.
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
const plus = (hex, dq, dr) => ({ q: hex.q + dq, r: hex.r + dr });
// Section 1's worked (9, 7) leg, laid down from ORIGIN: 16 hexes, 1,680 light-craft ticks.
const FAR = plus(ORIGIN, 9, 7);

// galaxy(...) -> an invariant-clean galaxy: guild g1 with one idle light craft at ORIGIN (or `craftAt`), an
// optional (g1, A) pool, and its Outpost `outpost_g1_01` on HEX_B.
function galaxy({
  fuelHoard = 1000000, craftAt = { ...ORIGIN }, systemPool, outpostStock,
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
const routed = (waypoints, repeat) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: VID, waypoints, ...(repeat !== undefined ? { repeat } : {}),
});
const plain = (waypoints) => createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints });
const cancel = (vid = VID, guildId = 'g1') => createCancelRouteAction({ guildId, vehicleId: vid });
const craftOf = (s) => s.guilds[0].vehicles.find((v) => v.id === VID);
const snapRow = (s) => buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);
const fuelOf = (s) => ({ hoard: s.guilds[0].fuelHoard, consumed: s.audit.totalConsumed });
const stock = (s) => ((s.outposts[0] || {}).stockpile || {})[T1] || 0;
// step(s) — one full turn through the real driver, which ASSERTS EVERY INVARIANT and throws with the tick
// number on any violation.
const step = (s) => advance(s, []).state;
const stepTo = (state, tick) => {
  let s = state;
  while (s.tick < tick) s = step(s);
  return s;
};
const stepUntil = (state, pred, cap = 20000) => {
  let s = state;
  let i = 0;
  while (!pred(s) && i < cap) { s = step(s); i += 1; }
  assert.ok(pred(s), `condition not met within ${cap} ticks`);
  return s;
};
// An ORDINARY idle craft at `hex`: a bare-hex location, idle, and none of a lane's fields.
const assertIdleAt = (s, hex, what) => {
  const c = craftOf(s);
  assert.equal(c.status, 'idle', `${what}: idle`);
  assert.deepEqual(c.location, hex, `${what}: at ${JSON.stringify(hex)}`);
  assert.equal(c.trip, undefined, `${what}: no trip`);
  assert.equal(c.route, undefined, `${what}: no route`);
  assert.equal(c.laneEnded, undefined, `${what}: no flag — a cancel is not a failure`);
};

test('cancel in flight — a routed lane: half-way along its leg it snaps to (5,3) from its start, and is an ordinary idle craft', () => {
  assert.equal(legTicks(hexDistance(ORIGIN, FAR), LIGHT.speed, false), SPAN, 'the worked leg takes 1,680 ticks');
  // A continuous lane ORIGIN → FAR → ORIGIN (no actions: pure turning points), launched at tick 0.
  let s = accept(galaxy(), routed([{ anchor: { ...FAR } }, { anchor: { ...ORIGIN } }], { mode: 'continuous' }));
  const fuelAtLaunch = fuelOf(s);
  s = stepTo(s, 840);
  assert.equal(craftOf(s).status, 'inTransit');
  s = accept(s, cancel());
  assertIdleAt(s, plus(ORIGIN, 5, 3), 'snapped half-way');
  assert.equal(craftOf(s).updatedAtTick, 840, 'the cancel records its tick (§15.2)');
  assert.deepEqual(fuelOf(s), fuelAtLaunch, 'nothing refunded (§11.3), nothing burned');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // The snapshot shows the plain idle craft: a location, and no trip / route / flag.
  const row = snapRow(s);
  assert.equal(row.status, 'idle');
  assert.deepEqual(row.location, plus(ORIGIN, 5, 3));
  assert.equal('trip' in row || 'route' in row || 'laneEnded' in row, false);
  // It stays put: the leg it was on never lands, and the lane never starts another lap.
  s = stepTo(s, 2 * SPAN);
  assertIdleAt(s, plus(ORIGIN, 5, 3), 'long after the old arrival tick');
  assert.deepEqual(fuelOf(s), fuelAtLaunch);
  // And it can be re-tasked like any idle craft.
  s = accept(s, plain([{ ...ORIGIN }]));
  assert.equal(craftOf(s).status, 'inTransit');
});

test('cancel in flight — a routed lane 1/20 of the way in snaps to (1,0) from its start: the cube correction, live', () => {
  let s = accept(galaxy(), routed([{ anchor: { ...FAR } }, { anchor: { ...ORIGIN } }], { mode: 'continuous' }));
  s = stepTo(s, 84);
  s = accept(s, cancel());
  assertIdleAt(s, plus(ORIGIN, 1, 0), '1/20 of the way');
});

test('cancel in flight — a plain multi-leg dispatch: the ACTIVE leg is the one interpolated', () => {
  // ORIGIN → P1 (3 hexes, 315 ticks) → P2 (the worked (9,7) leg, 1,680 ticks), frozen at tick 0.
  const P1 = plus(ORIGIN, 3, 0);
  const P2 = plus(P1, 9, 7);
  const LEG0 = legTicks(3, LIGHT.speed, false);
  const flying = accept(galaxy(), plain([{ ...P1 }, { ...P2 }]));
  assert.equal(craftOf(flying).trip.legs.length, 2);
  // Half-way along the SECOND leg → P1 + (5,3), the section-1 answer measured from that leg's own start.
  let s = accept(stepTo(flying, LEG0 + 840), cancel());
  assertIdleAt(s, plus(P1, 5, 3), 'mid leg 2');
  // Exactly the tick leg 1 lands and leg 2 departs → on the waypoint between them.
  s = accept(stepTo(flying, LEG0), cancel());
  assertIdleAt(s, P1, 'at the leg boundary');
  // On the FIRST leg, 150 of 315 ticks in: 150/315 × 3 ≈ 1.43 hexes along q → hex ORIGIN + (1,0).
  s = accept(stepTo(flying, 150), cancel());
  assertIdleAt(s, plus(ORIGIN, 1, 0), 'mid leg 1');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('cancel at the tick it departs: still on its start hex — stored as a BARE hex, even when it left a system', () => {
  // From a bare hex: back on that hex.
  let s = accept(accept(galaxy(), plain([{ ...FAR }])), cancel());
  assertIdleAt(s, ORIGIN, 'cancelled on the dispatch tick');
  // From a system landmark: on the system's hex, but as a bare hex { q, r } — the snap names the hex it is
  // over, never a landmark (transport-model.md §11.10; the consequence is on the decision checklist).
  s = accept(accept(galaxy({ craftAt: { ...SYS_ANCHOR } }), plain([{ ...FAR }])), cancel());
  assertIdleAt(s, { q: A_COORDS.q, r: A_COORDS.r }, 'left a system');
  assert.equal(craftOf(s).location.landmarkKind, undefined);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// A short fuel cycle (a setup-only knob, set at tick 0) so the boundaries — where a waiting lane re-attempts —
// come every CYCLE ticks. The guild has no holdings, so a boundary grants it nothing.
const CYCLE = 100;
const shortCycle = (s) => accept(s, createSetWindowNAction({ windowN: CYCLE }));
const isBoundary = (tick) => isWindowBoundary(tick, CYCLE, 0);
const burn = (from, to) => legFuelBurn(hexDistance(from, to), LIGHT.fuelCostToRun, false);
// The canonical two-stop lane: load 400 at system A, unload 400 at the Outpost on HEX_B.
const LANE = () => [
  { anchor: { ...SYS_ANCHOR }, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
  { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
];
const LAP1_FUEL = burn(ORIGIN, A_COORDS) + burn(A_COORDS, HEX_B);

test('cancel a WAITING lane (for fuel, or a per-cycle cadence hold): the route drops where it sits — nothing snaps, nothing burns', () => {
  const cases = [
    // Fuel for lap 1 only: after it, the lane waits at WN for fuel.
    { reason: 'fuel', repeat: { mode: 'continuous' }, fuelHoard: LAP1_FUEL },
    // Plenty of fuel, but a per-cycle lane holds at WN between laps.
    { reason: 'cadence', repeat: { mode: 'continuous', cadence: 'perCycle' }, fuelHoard: 1000000 },
  ];
  for (const { reason, repeat, fuelHoard } of cases) {
    let s = shortCycle(galaxy({ systemPool: { [T1]: 4000 }, fuelHoard }));
    s = accept(s, routed(LANE(), repeat));
    s = stepUntil(s, (st) => craftOf(st).route && craftOf(st).route.waiting);
    assert.equal(craftOf(s).route.waiting.reason, reason);
    const fuel = fuelOf(s);
    const delivered = stock(s);
    s = accept(s, cancel());
    assertIdleAt(s, HEX_B, `a ${reason} wait, cancelled`);
    assert.equal(craftOf(s).updatedAtTick, s.tick);
    assert.deepEqual(fuelOf(s), fuel, `${reason}: nothing burned`);
    // The next boundary finds nothing to resume, even with fuel to spare.
    s = accept(s, createAdjustFuelAction({ guildId: 'g1', delta: 100 }));
    s = stepUntil(step(s), (st) => isBoundary(st.tick));
    s = step(s);
    assertIdleAt(s, HEX_B, `${reason}: after a boundary`);
    assert.equal(stock(s), delivered, `${reason}: no lap ran`);
  }
});

// The REVERSED lane: load 400 from the Outpost on HEX_B (W1), deliver it to system A (WN). Launched from a
// craft already parked on HEX_B, it skips the zero-length reposition and queues W1's load at the Outpost
// straight away (§11.4) — a routed craft parked at an Outpost stop.
const REVERSE = () => [
  { anchor: { ...HEX_B }, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
  { anchor: { ...SYS_ANCHOR }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
];

test('cancel a lane QUEUED at its Outpost stop: the route drops AND the queue entry goes — nothing is loaded later', () => {
  let s = accept(galaxy({ craftAt: { ...HEX_B }, outpostStock: { [T1]: 400 } }), routed(REVERSE()));
  assert.deepEqual(s.outposts[0].queue.map((e) => e.vehicleId), [VID], 'queued at the Outpost');
  assert.equal(craftOf(s).status, 'idle');
  s = accept(s, cancel());
  assert.equal(s.outposts[0].queue, undefined, 'no stale queue entry');
  assertIdleAt(s, HEX_B, 'dropped at the Outpost');
  // A full turnaround later nothing has moved: the dock never served a cancelled manifest.
  s = stepTo(s, s.tick + outpostDockTurnaround(LIGHT_TRANSPORT) + 5);
  assertIdleAt(s, HEX_B, 'a turnaround later');
  assert.equal(stock(s), 400, 'the load never happened');
  assert.equal(craftOf(s).cargo, undefined);
});

test('cancel a lane LOADING in an Outpost dock slot: the route drops; that one transfer finishes (§4), and the craft stays there', () => {
  let s = accept(galaxy({ craftAt: { ...HEX_B }, outpostStock: { [T1]: 400 } }), routed(REVERSE()));
  s = step(s); // the dock step promotes the queued craft into a slot
  assert.equal(craftOf(s).status, 'loading');
  s = accept(s, cancel());
  assert.equal(craftOf(s).route, undefined, 'the lane is gone at once');
  assert.equal(craftOf(s).status, 'loading', 'a craft in a slot runs to completion (§4)');
  assert.deepEqual(s.outposts[0].slots.map((e) => e.vehicleId), [VID], 'its slot is untouched');
  assert.equal(craftOf(s).updatedAtTick, s.tick);
  s = stepUntil(s, (st) => craftOf(st).status === 'idle');
  assertIdleAt(s, HEX_B, 'after the turnaround');
  assert.deepEqual(craftOf(s).cargo, { [T1]: 400 }, 'the transfer in the slot completed');
  assert.equal(stock(s), 0);
  // With no route left, nothing sends it on to system A.
  s = stepTo(s, s.tick + 300);
  assertIdleAt(s, HEX_B, 'still there later');
});

test('cancel refusals — no lane, an unknown craft or guild — change nothing', () => {
  const idle = galaxy();
  assert.match(refuse(idle, cancel()), /not on a lane — it is idle with no route, so there is nothing to cancel/);
  assert.match(refuse(idle, cancel('vehicle_g1_nope')), /owns no vehicle/);
  assert.match(refuse(idle, cancel(VID, 'g9')), /no guild/);
  // Refused whole: through intake, the galaxy is byte-identical afterwards.
  const { state: after, results } = intake(idle, [cancel(), cancel('vehicle_g1_nope')]);
  assert.deepEqual(results.map((r) => r.accepted), [false, false]);
  assert.equal(hashState(after), hashState(idle));
  // Once cancelled, the craft is an ordinary idle craft, so a second cancel has nothing to cancel.
  const once = accept(stepTo(accept(galaxy(), plain([{ ...FAR }])), 10), cancel());
  assert.match(refuse(once, cancel()), /not on a lane/);
  // The constructor insists on both fields.
  assert.throws(() => createCancelRouteAction({ vehicleId: VID }), /guildId is required/);
  assert.throws(() => createCancelRouteAction({ guildId: 'g1' }), /vehicleId is required/);
});

test('the toll stub: every leg flown today is open space; a would-be toll leg is REFUSED, never snapped', () => {
  const P1 = plus(ORIGIN, 3, 0);
  const flying = stepTo(accept(galaxy(), plain([{ ...P1 }, { ...plus(P1, 9, 7) }])), 150);
  const lane = stepTo(accept(galaxy(), routed([{ anchor: { ...FAR } }, { anchor: { ...ORIGIN } }], { mode: 'continuous' })), 150);
  for (const s of [flying, lane]) {
    assert.ok(craftOf(s).trip.legs.every((leg) => leg.isToll === false), 'no toll leg exists before roadmap 2.3');
  }
  // Flip the ACTIVE leg to a toll leg (as roadmap 2.3 will): the cancel is refused, never snapped mid-passage…
  const toll = structuredClone(flying);
  craftOf(toll).trip.legs[0].isToll = true;
  assert.match(refuse(toll, cancel()), /toll leg — a toll cancel completes to the toll's exit, which is not built yet/);
  // …and the apply, called without its validate, throws rather than snap inside the toll.
  assert.throws(() => applyAction(toll, cancel()), /cancelRoute: .*toll leg/);
  // A toll flag on a LATER leg does not matter: the branch looks only at the leg being flown.
  const laterToll = structuredClone(flying);
  craftOf(laterToll).trip.legs[1].isToll = true;
  assertIdleAt(accept(laterToll, cancel()), plus(ORIGIN, 1, 0), 'toll ahead, open leg now');
});

// rimLegOverTheEdge() -> a leg between two in-bounds, landmark-free hexes on the galaxy's RIM whose straight
// line passes over a hex OUTSIDE the lattice, and the first tick a light craft flying it is over that hex.
// Derived from the seed (the lattice is a disc of hexes; a chord near its edge can cross a hex whose centre
// lies outside it), so a seed regen carries the test.
function rimLegOverTheEdge() {
  const NEIGHBOURS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const rim = [];
  for (let q = -300; q <= 300; q += 1) {
    for (let r = -300; r <= 300; r += 1) {
      if (!isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      if (NEIGHBOURS.some(([dq, dr]) => !isHexInBounds(q + dq, r + dr))) rim.push({ q, r });
    }
  }
  for (const a of rim) {
    for (const b of rim) {
      const d = hexDistance(a, b);
      if (d < 2 || d > 8) continue;
      const span = legTicks(d, LIGHT.speed, false);
      for (let t = 0; t <= span; t += 1) {
        const hex = legHexAtTick(a, b, 0, span, t);
        if (!isHexInBounds(hex.q, hex.r)) return { a, b, span, offTick: t, hex };
      }
    }
  }
  return null;
}

test('cancel over a hex OFF the lattice (a chord along the rim) is refused for that tick; a later cancel lands', () => {
  const edge = rimLegOverTheEdge();
  assert.ok(edge, 'the seed has a rim leg whose line leaves the lattice');
  let s = accept(galaxy({ craftAt: { ...edge.a } }), plain([{ ...edge.b }]));
  s = stepTo(s, edge.offTick);
  const before = hashState(s);
  const reason = refuse(s, cancel());
  assert.match(reason, /outside the galaxy's lattice — it cannot stop there/);
  assert.ok(reason.includes(JSON.stringify(edge.hex)), `names the hex: ${reason}`);
  assert.throws(() => applyAction(s, cancel()), /outside the galaxy's lattice/, 'the apply never places it off the lattice');
  assert.equal(hashState(s), before, 'refused whole — nothing changed');
  // The craft flies on; at the first tick it is back over the lattice, the cancel lands there.
  const hexAt = (tick) => legHexAtTick(edge.a, edge.b, 0, edge.span, tick);
  let t = edge.offTick;
  while (!isHexInBounds(hexAt(t).q, hexAt(t).r)) t += 1;
  s = accept(stepTo(s, t), cancel());
  assertIdleAt(s, hexAt(t), 'back over the lattice');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('determinism: a cancel replays byte-identically, and a restart mid-flight lands on the same hex and state', () => {
  const launch = () => accept(galaxy(), routed([{ anchor: { ...FAR } }, { anchor: { ...ORIGIN } }], { mode: 'continuous' }));
  const finish = (s) => stepTo(accept(stepTo(s, 840), cancel()), 1100);
  const a = finish(launch());
  const b = finish(launch());
  assert.equal(hashState(a), hashState(b), 'the same run twice');
  assert.deepEqual(craftOf(a).location, plus(ORIGIN, 5, 3));
  // Save mid-flight (tick 600), reload from the JSON, then cancel at 840 — the same hex, the same galaxy.
  const saved = JSON.parse(JSON.stringify(stepTo(launch(), 600)));
  const resumed = finish(saved);
  assert.equal(hashState(resumed), hashState(a), 'a restart replays the cancel byte-identically');
  assert.deepEqual(craftOf(resumed).location, plus(ORIGIN, 5, 3));
});

test('integrity: the EXISTING vehicle checks already cover a snapped craft — clean as built, loud when corrupted', () => {
  const s = accept(stepTo(accept(galaxy(), plain([{ ...FAR }])), 840), cancel());
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the snapped craft is clean');
  const rules = (mutate) => {
    const c = structuredClone(s);
    mutate(craftOf(c));
    return checkInvariants(c, c.tick).map((v) => v.rule).filter((r) => r.startsWith('vehicle-'));
  };
  // Idle ⇒ a location that resolves (an in-bounds hex) and no trip (design.md §15.4).
  assert.deepEqual(rules((c) => { c.location = { q: 5000, r: 5000 }; }), ['vehicle-location-resolves']);
  assert.deepEqual(rules((c) => { c.trip = structuredClone(craftOf(stepTo(accept(galaxy(), plain([{ ...FAR }])), 1)).trip); }), ['vehicle-idle-no-trip']);
  assert.deepEqual(rules((c) => { delete c.location; }), ['vehicle-location-resolves']);
});
