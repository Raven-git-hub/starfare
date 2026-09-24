'use strict';

// route-lap-cost.test.js — what ONE LAP of a repeating lane costs (roadmap 2.2 automation, slice
// 3c-engine; transport-model.md §11.4 / §11.10 / §2.2, design.md §18). The client shows the player the
// per-lap fuel of a lane, and the client computes no game number, so the engine publishes it: on the
// dispatch quote (`perLapUnits` / `perLapCredits`, before launch) and on a repeating lane's snapshot route
// (after). Both come from `perLapCost`, which prices a lap exactly the way `startLap` charges one.
//
// A lap is the RECURRING cycle (§11.4): from the last waypoint WN, fly back to W1, then run W1 → … → WN.
// So its fuel is the WN → W1 flyback plus the cycle's legs. When WN == W1 the flyback is zero-length and
// skipped. Lap 1 also pays a one-time positioning leg (launch location → W1); the run quote's `totalUnits`
// carries that, the per-lap does not.
//
// The tripwires:
//   1. open loop — perLapUnits = flyback + cycle, hand-computed from the leg lengths; the run's totalUnits
//      differs from it by exactly (positioning − flyback), whichever of the two is bigger; and it does not
//      depend on where the craft launches from.
//   2. closed loop — WN == W1: the lap is just the cycle; a driven nRun lane burns totalUnits for lap 1 and
//      exactly perLapUnits for every later lap (the same drive for an open loop).
//   3. credits track the price — perLapCredits = fuelValue(perLapUnits, fuelPrice), and re-reads at a new
//      price (on the quote and on the snapshot).
//   4. the snapshot surface — a continuous / nRun lane's route carries the quote's figures, unchanged as the
//      craft flies; a `once` route (and a craft with no route) carries neither.
//   5. degenerate — a one-waypoint route quotes a 0 lap, never a throw; a list the dispatch would refuse
//      prices as null (visible), never a quiet 0.
//   6. a pure read — quoting leaves the galaxy byte-identical, and the answer is the same every time.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { hexDistance, legFuelBurn } = require('../transport.js');
const { fuelValue } = require('../fuel.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const {
  validateAction, applyAction, createSpawnVehicleAction, createDispatchRouteWithActionsAction,
  quoteDispatch, perLapCost,
} = require('../actions.js');

const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT]; // fuelCostToRun 0.5 — so ceil() matters on odd lengths
const VID = 'vehicle_g1_lightTransport_01';

// The hexes. The leg lengths between them are pinned by the first test, so every figure below can be
// checked by hand. (Light craft burn per leg: ceil(length × 0.5).)
const LAUNCH = { q: 0, r: 0 }; // 7 hexes from W1
const NEAR = { q: 7, r: 1 };   // 1 hex from W1
const W1 = { q: 7, r: 0 };
const W2 = { q: 7, r: 3 };     // W1 → W2: 3 hexes
const W3 = { q: 9, r: 1 };     // W2 → W3: 2 hexes; W3 → W1: 3 hexes
const OPEN = [W1, W2, W3];          // WN = W3, so every lap flies back W3 → W1
const CLOSED = [W1, W2, W3, W1];    // WN = W1 — the player closed the loop themselves
const f = (length) => legFuelBurn(length, LIGHT.fuelCostToRun, false); // one leg's burn, the one formula

// A bare guild with one idle light craft at `craftAt`, a big hoard and an optional fuel price. The routes
// here are pure turning points (no actions), so the only thing that moves is the craft and its fuel.
function laneState({ craftAt = LAUNCH, fuelHoard = 1000000, fuelPrice } = {}) {
  const reserve = { reserveLevel: 0, ...(fuelPrice !== undefined ? { fuelPrice } : {}) };
  const s = createState({ guilds: [{ id: 'g1', credits: 0, fuelHoard }], reserve, syndicate: { ledger: 0 } });
  return accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { ...craftAt } }));
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const quote = (state, anchors) => quoteDispatch(state, { guildId: 'g1', vehicleId: VID, waypoints: anchors });
const dispatch = (anchors, repeat) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: VID, waypoints: anchors.map((a) => ({ anchor: { ...a } })),
  ...(repeat !== undefined ? { repeat } : {}),
});
const craftOf = (s) => s.guilds[0].vehicles.find((v) => v.id === VID);
const snapRow = (s) => buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);
// One full turn through the real driver, which checks EVERY invariant and throws with the tick on a violation.
const step = (s) => advance(s, []).state;

// driveLane(state, anchors, repeat) -> launch the lane and fly it to the end, recording every burn.
// `launchBurn` is what the dispatch took; `lapBurns` is each LATER burn, in order. The burn record
// (`audit.totalConsumed`) and the hoard are read every tick, and each burn must take exactly its amount
// out of the hoard on the same tick — so the numbers below really are "the hoard's drop per lap".
// `shown` is the snapshot's perLapUnits read on each of those lap-start ticks.
function driveLane(state, anchors, repeat) {
  const hoardBefore = state.guilds[0].fuelHoard;
  let s = accept(state, dispatch(anchors, repeat));
  const launchBurn = hoardBefore - s.guilds[0].fuelHoard;
  assert.equal(s.audit.totalConsumed, launchBurn, 'the launch burn is recorded (invariant 1)');
  const lapBurns = [];
  const shown = [];
  let guard = 0;
  while (craftOf(s).route) {
    const prev = { hoard: s.guilds[0].fuelHoard, consumed: s.audit.totalConsumed };
    s = step(s);
    const burned = s.audit.totalConsumed - prev.consumed;
    if (burned > 0) {
      assert.equal(prev.hoard - s.guilds[0].fuelHoard, burned, `the lap's burn left the hoard at tick ${s.tick}`);
      lapBurns.push(burned);
      shown.push(snapRow(s).route.perLapUnits);
    }
    guard += 1;
    assert.ok(guard < 20000, 'the lane should have finished');
  }
  return { launchBurn, lapBurns, shown, totalConsumed: s.audit.totalConsumed };
}

// --- 1. per-lap = flyback + cycle (an OPEN loop, WN ≠ W1) ------------------------------------------

test('open loop: perLapUnits is the WN → W1 flyback plus the cycle, hand-computed from the leg lengths', () => {
  // The leg lengths every figure in this file rests on.
  assert.equal(hexDistance(LAUNCH, W1), 7, 'positioning, launch → W1');
  assert.equal(hexDistance(NEAR, W1), 1, 'positioning, near → W1');
  assert.equal(hexDistance(W1, W2), 3);
  assert.equal(hexDistance(W2, W3), 2);
  assert.equal(hexDistance(W3, W1), 3, 'the flyback, WN → W1');

  const q = quote(laneState(), OPEN);
  assert.equal(q.ok, true, q.reason);
  // A lap: fly back W3 → W1 (3), then W1 → W2 (3) and W2 → W3 (2). Light burns ceil(half the length).
  assert.equal(q.perLapUnits, f(3) + f(3) + f(2));
  assert.equal(q.perLapUnits, 2 + 2 + 1, 'by hand: 5 fuel a lap');
  // The run: position launch → W1 (7), then the same cycle — and no flyback.
  assert.equal(q.totalUnits, f(7) + f(3) + f(2));
  assert.equal(q.totalUnits, 4 + 2 + 1, 'by hand: 7 fuel for the run');
  // So the run pays the one-time positioning where the lap pays the recurring flyback — and nothing else.
  assert.equal(q.totalUnits - q.perLapUnits, f(7) - f(3), 'run − lap = positioning − flyback');
  assert.ok(q.perLapUnits < q.totalUnits, 'launched far from W1, a lap costs less than the first run');
});

test('open loop: the identity holds both ways — launched next to W1, a lap costs MORE than the run', () => {
  const q = quote(laneState({ craftAt: NEAR }), OPEN);
  assert.equal(q.totalUnits, f(1) + f(3) + f(2), 'a 1-hex positioning leg');
  assert.equal(q.totalUnits - q.perLapUnits, f(1) - f(3), 'run − lap = positioning − flyback, here negative');
  assert.ok(q.perLapUnits > q.totalUnits);
});

test('the per-lap does not depend on where the craft is — from far, from near, or already on W1', () => {
  const fromFar = quote(laneState({ craftAt: LAUNCH }), OPEN);
  const fromNear = quote(laneState({ craftAt: NEAR }), OPEN);
  const onW1 = quote(laneState({ craftAt: W1 }), OPEN); // the positioning leg is skipped (§11.4)
  assert.notEqual(fromFar.totalUnits, fromNear.totalUnits, 'the runs differ (different positioning)');
  assert.equal(fromNear.perLapUnits, fromFar.perLapUnits);
  assert.equal(onW1.perLapUnits, fromFar.perLapUnits);
  assert.equal(onW1.perLapCredits, fromFar.perLapCredits);
});

// --- 2. a CLOSED loop (WN == W1), and the lap cost against a real driven burn -----------------------

test('closed loop: WN == W1 — the lap is just the cycle (the zero-length flyback adds nothing)', () => {
  const q = quote(laneState(), CLOSED);
  assert.equal(q.ok, true, q.reason);
  // The cycle W1 → W2 (3), W2 → W3 (2), W3 → W1 (3); the flyback W1 → W1 is skipped.
  assert.equal(q.perLapUnits, f(3) + f(2) + f(3));
  assert.equal(q.totalUnits, f(7) + q.perLapUnits, 'the run = positioning + one cycle');
  // Closing the loop by hand costs the same per lap as leaving it open: W3 → W1 is flown either way —
  // as the closing leg here, as the flyback there.
  assert.equal(q.perLapUnits, quote(laneState(), OPEN).perLapUnits);
});

test('closed loop, driven: an nRun:3 lane burns totalUnits for lap 1, then exactly perLapUnits per later lap', () => {
  const s = laneState();
  const q = quote(s, CLOSED);
  const run = driveLane(s, CLOSED, { mode: 'nRun', n: 3 });
  assert.equal(run.launchBurn, q.totalUnits, 'lap 1 (positioning + cycle) is the quoted run');
  assert.deepEqual(run.lapBurns, [q.perLapUnits, q.perLapUnits], 'laps 2 and 3 each burn the quoted lap');
  assert.deepEqual(run.shown, [q.perLapUnits, q.perLapUnits], 'the snapshot showed the number it burned');
  assert.equal(run.totalConsumed, q.totalUnits + 2 * q.perLapUnits, 'the whole run = run + (N − 1) laps');
});

test('open loop, driven: every lap after the first burns exactly the quoted perLapUnits (flyback included)', () => {
  const s = laneState();
  const q = quote(s, OPEN);
  const run = driveLane(s, OPEN, { mode: 'nRun', n: 4 });
  assert.equal(run.launchBurn, q.totalUnits);
  assert.deepEqual(run.lapBurns, [q.perLapUnits, q.perLapUnits, q.perLapUnits]);
  assert.deepEqual(run.shown, run.lapBurns, 'the displayed number is the number the lane burns');
  assert.equal(run.totalConsumed, q.totalUnits + 3 * q.perLapUnits);
});

// --- 3. credits track the live fuel price --------------------------------------------------------

test('perLapCredits is fuelValue(perLapUnits, fuelPrice) at the asked price, and re-reads at a new one', () => {
  const atRef = laneState();
  const q = quote(atRef, OPEN);
  assert.equal(q.perLapCredits, fuelValue(q.perLapUnits, atRef.reserve.fuelPrice));

  // The same galaxy at a different fuel price: the fuel is the same, the credit figure moves with it.
  const dearer = laneState({ fuelPrice: 13.7 });
  const q2 = quote(dearer, OPEN);
  assert.equal(q2.perLapUnits, q.perLapUnits, 'the fuel is geometry — the price does not change it');
  assert.equal(q2.perLapCredits, fuelValue(q2.perLapUnits, 13.7));
  assert.notEqual(q2.perLapCredits, q.perLapCredits);
  assert.ok(Number.isInteger(q2.perLapCredits), 'credits are whole (design.md §15.2)');

  // The snapshot's figure re-reads the price too: the same running lane, shown at two prices.
  const lane = accept(atRef, dispatch(OPEN, { mode: 'continuous' }));
  assert.equal(snapRow(lane).route.perLapCredits, q.perLapCredits);
  const repriced = JSON.parse(JSON.stringify(lane));
  repriced.reserve.fuelPrice = 13.7;
  assert.equal(snapRow(repriced).route.perLapUnits, q.perLapUnits);
  assert.equal(snapRow(repriced).route.perLapCredits, fuelValue(q.perLapUnits, 13.7));
});

// --- 4. the snapshot surface ---------------------------------------------------------------------

test('snapshot: a continuous / nRun lane carries the quote\'s per-lap figures; a once route and an idle craft do not', () => {
  const s = laneState();
  for (const anchors of [OPEN, CLOSED]) {
    const q = quote(s, anchors);
    for (const repeat of [{ mode: 'continuous' }, { mode: 'nRun', n: 2 }, { mode: 'continuous', cadence: 'perCycle' }]) {
      const route = snapRow(accept(s, dispatch(anchors, repeat))).route;
      assert.equal(route.perLapUnits, q.perLapUnits, `${repeat.mode}: the same fuel as the quote`);
      assert.equal(route.perLapCredits, q.perLapCredits, `${repeat.mode}: the same credits as the quote`);
    }
  }
  // A one-shot has no next lap: its route row is exactly the built one — no per-lap keys at all.
  const once = snapRow(accept(s, dispatch(OPEN)));
  assert.deepEqual(Object.keys(once.route).sort(), ['cursor', 'waypoints'], 'a once route is unchanged');
  // An idle craft carries no route at all.
  assert.equal('route' in snapRow(s), false);
  // The per-lap is derived on read: nothing new is stored on the craft's route in engine state.
  const stored = craftOf(accept(s, dispatch(OPEN, { mode: 'continuous' }))).route;
  assert.equal('perLapUnits' in stored, false);
  assert.equal('perLapCredits' in stored, false);
});

test('snapshot: a lane\'s per-lap figure stays put as the craft flies — every tick of two laps', () => {
  const s = laneState();
  const q = quote(s, OPEN);
  let lane = accept(s, dispatch(OPEN, { mode: 'continuous' }));
  // Positioning (7 hexes) + two laps (8 hexes each), at the light craft's ticks per hex.
  const ticks = (7 + 8 + 8) * LIGHT.speed;
  for (let i = 0; i < ticks; i += 1) {
    const route = snapRow(lane).route;
    assert.equal(route.perLapUnits, q.perLapUnits, `tick ${lane.tick}, cursor ${route.cursor}`);
    lane = step(lane);
  }
  assert.ok(craftOf(lane).route.lapsDone >= 2, 'it really flew two laps');
});

// --- 5. the degenerate lap, and totality ---------------------------------------------------------

test('degenerate: a one-waypoint route quotes a 0 lap — from elsewhere and from its own stop — never a throw', () => {
  const fromAfar = quote(laneState(), [W1]);
  assert.equal(fromAfar.ok, true, fromAfar.reason);
  assert.equal(fromAfar.totalUnits, f(7), 'the run still flies to W1');
  assert.equal(fromAfar.perLapUnits, 0, 'but a lap has no leg: WN is W1');
  assert.equal(fromAfar.perLapCredits, 0);
  const inPlace = quote(laneState({ craftAt: W1 }), [W1]);
  assert.equal(inPlace.perLapUnits, 0);
  assert.equal(inPlace.perLapCredits, 0);
});

test('perLapCost is total: a list the dispatch would refuse prices as null — never a throw, never a quiet 0', () => {
  const craft = craftOf(laneState());
  const none = { perLapUnits: null, perLapCredits: null };
  assert.deepEqual(perLapCost(craft, [], 10), none, 'empty');
  assert.deepEqual(perLapCost(craft, undefined, 10), none, 'not a list');
  assert.deepEqual(perLapCost(craft, [{ q: 999999, r: 999999 }], 10), none, 'an anchor off the lattice');
  assert.deepEqual(perLapCost(craft, [W1, W2, W2], 10), none, 'two stops in a row on one hex (a dead leg)');
  // A well-formed list always prices — including the closing W1 → W1 flyback, which is skipped, not refused.
  assert.equal(perLapCost(craft, CLOSED, 10).perLapUnits, f(3) + f(2) + f(3));
});

// --- 6. a pure, deterministic read ---------------------------------------------------------------

test('the per-lap quote is a pure read and deterministic — the galaxy is untouched, the answer is stable', () => {
  const s = laneState();
  const before = hashState(s);
  const first = quote(s, OPEN);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(quote(s, OPEN), first);
    quote(s, CLOSED);
    quote(s, [W1]);
  }
  assert.equal(hashState(s), before, 'no journal, no tick, nothing moved');
  assert.deepEqual(quote(JSON.parse(JSON.stringify(s)), OPEN), first, 'a reloaded galaxy quotes the same');
});
