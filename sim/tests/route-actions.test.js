'use strict';

// route-actions.test.js — the transport AUTOMATION layer, slice 1a: one-shot route-with-actions
// execution (transport-model.md §11; roadmap 2.2 automation slice 1a). A `dispatchRouteWithActions`
// sends an idle craft along a route of `{ anchor, action? }` waypoints; the craft flies leg by leg,
// and on ARRIVAL at each waypoint runs that stop's action — INSTANT at a system, QUEUE + TURNAROUND at
// an owned Outpost — then dispatches itself onto the next leg (the chained-legs model). The whole run's
// fuel is burned UP FRONT and refused whole if unaffordable; the run ends idle at the last waypoint.
//
// The tripwires, one per ruling (the task's "Prove it" list):
//   1. a full lane executes — load at a system on arrival, unload at an outpost at turnaround, the
//      outpost stockpile grows, the craft advances and ends idle at the last waypoint;
//   2. fuel up front — the whole run leaves the hoard at dispatch, later legs re-dispatch with NO
//      further burn, and an unaffordable run is refused whole (nothing dispatched, craft stays idle);
//   3. one-shot end — after the last waypoint the craft is idle at the last anchor, route cleared, no trip;
//   4. partial proceeds (§11.6) — a load from an empty pool and an unload into a near-full outpost each
//      move what they can and the lane still advances (never stalls);
//   5. safe halt on anchor-gone (§11.6) — an outpost removed mid-run leaves the craft idle at its
//      current berth, route cleared, no throw, no bad leg; goods conserved;
//   6. determinism + restart — the run replays byte-identically across a mid-run persist/restore, and
//      two routed craft landing the same tick resolve in fixed id order;
//   7. validation — a bad manifest / a zero-length leg / a non-idle craft / an unaffordable run / a
//      spycraft with an action are each refused WHOLE;
//   + the no-action route (a pure turning-point chain) and the omit-when-absent no-op.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const {
  hexDistance, legFuelBurn, legTicks,
} = require('../transport.js');
const { LIGHT_TRANSPORT, SPYCRAFT, VEHICLE_SPECS } = require('../vehicles.js');
const {
  getSystem, isHexInBounds, seedLandmarkAtHex,
} = require('../seed.js');
const { OUTPOST_CAPACITY } = require('../outposts.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createDispatchRouteWithActionsAction,
  createDispatchVehicleAction, createRemoveOutpostAction,
} = require('../actions.js');

const SYS_A = starterHomeAtDistance(6).id; // a real seed system — the LOAD stop
const A_COORDS = getSystem(SYS_A).coords;
const SYS_ANCHOR = { landmarkKind: 'system', landmarkId: SYS_A };
const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT]; // speed 105, capacity 10000, fuelCostToRun 0.5
const VID = 'vehicle_g1_lightTransport_01';
const VID2 = 'vehicle_g1_lightTransport_02';
const T1 = 'titanium'; // volumeOf === 1

// The in-bounds, landmark-free hexes NEAREST system A (DERIVED from the seed, the outposts.test.js
// discipline — a regen carries the test). Kept close to A so the legs are SHORT (a couple of hexes),
// which keeps the tick-through runs fast. ORIGIN is the craft's launch berth; HEX_B is the Outpost's
// tile (a guild Outpost is NOT a location landmark, §4, so the craft berths there by hex-coincidence).
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

// The whole-run fuel for the canonical lane ORIGIN → A → B (both legs open space, §11.3). Read from
// the ONE leg formula, never inlined — the same sum the dispatch burns.
const LEG_OA = hexDistance(ORIGIN, A_COORDS);
const LEG_AB = hexDistance(A_COORDS, HEX_B);
const RUN_FUEL = legFuelBurn(LEG_OA, LIGHT.fuelCostToRun, false) + legFuelBurn(LEG_AB, LIGHT.fuelCostToRun, false);

// routeState(...) -> an invariant-clean galaxy: guild g1 owning one idle light craft at ORIGIN (or a
// given class/location), its (g1, SYS_A) pool seeded from `systemPool`, and one Outpost `outpost_g1_01`
// on HEX_B (optionally pre-stocked). createState folds every pool/hold/stockpile into galacticSupply,
// so the state opens consistency-green.
function routeState({
  systemPool, fuelHoard = 1000000, outpostStock, craftAt = { ...ORIGIN }, craftClass = LIGHT_TRANSPORT,
} = {}) {
  const guild = {
    id: 'g1', credits: 0, fuelHoard, outpostSerial: 1,
  };
  if (systemPool) guild.stockpiles = { [SYS_A]: { ...systemPool } };
  const outpost = {
    id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: SYS_A,
    coords: { ...HEX_B }, createdAtTick: 0,
    ...(outpostStock ? { stockpile: { ...outpostStock } } : {}),
  };
  let s = createState({
    guilds: [guild], outposts: [outpost],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: craftClass, location: craftAt }));
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
const dispatchRoute = (waypoints, vid = VID) => createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: vid, waypoints });
const dock = (manifest) => ({ type: 'dock', manifest });
const craftOf = (s, vid = VID) => s.guilds[0].vehicles.find((v) => v.id === vid);
const outpostOf = (s) => s.outposts[0];
const pool = (s, good) => ((s.guilds[0].stockpiles || {})[SYS_A] || {})[good] || 0;
const stock = (s, good) => (outpostOf(s).stockpile || {})[good] || 0;

const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};
// tickUntil(state, pred, cap) — advance until pred(state) or the cap trips (a guard against a stall).
const tickUntil = (state, pred, cap = 5000) => {
  let s = state;
  let i = 0;
  while (!pred(s) && i < cap) { s = tick(s, []); i += 1; }
  assert.ok(pred(s), `condition not met within ${cap} ticks`);
  return s;
};
// The total titanium anywhere (pools + holds + outpost stockpiles) — the conservation yardstick.
const totalTitanium = (s) => computeGalacticSupply(s).resources[T1];

// --- 1. a full lane executes: load at a system, unload at an outpost, end idle at the last waypoint ---

test('a full lane executes: load @ system A, haul, unload @ outpost B, end idle at B', () => {
  // Craft at ORIGIN, pool at A holds 400 titanium; route: load 400 at A, then unload 400 at B.
  let s = routeState({ systemPool: { [T1]: 400 } });
  const before = totalTitanium(s);
  s = accept(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));

  // Dispatched: flying the FIRST leg (ORIGIN → A), route journalled at cursor 0.
  assert.equal(craftOf(s).status, 'inTransit');
  assert.equal(craftOf(s).route.cursor, 0);
  assert.equal(craftOf(s).route.waypoints.length, 2);
  assert.equal(craftOf(s).location, undefined, 'an in-transit craft carries no bare location (§15.4)');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the dispatched routed state is invariant-clean');

  // ARRIVE at A: the load resolves instantly (system half), and the craft is already flying leg 2 (A→B).
  s = tickUntil(s, (st) => craftOf(st).route && craftOf(st).route.cursor === 1);
  assert.deepEqual(craftOf(s).cargo, { [T1]: 400 }, 'loaded 400 at A on arrival (instant, system)');
  assert.equal(pool(s, T1), 0, 'A pool drained by exactly what loaded');
  assert.equal(craftOf(s).status, 'inTransit', 'straight onto leg 2 the same tick it arrived at A');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // ARRIVE at B: queued then promoted into a slot the same tick — carrying the hold, not yet resolved.
  s = tickUntil(s, (st) => craftOf(st).status === 'loading');
  assert.deepEqual(craftOf(s).cargo, { [T1]: 400 }, 'still laden — the unload resolves at turnaround, not arrival');
  assert.equal(stock(s, T1), 0, 'nothing in the outpost stockpile yet');
  assert.equal(craftOf(s).route.cursor, 1, 'route still live, paused at the turnaround');

  // COMPLETE the turnaround: the outpost stockpile grows by 400 and the run ENDS idle at B.
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(stock(s, T1), 400, 'the outpost stockpile grew by exactly 400 at turnaround');
  assert.equal(craftOf(s).cargo, undefined, 'the hold emptied (omit-when-empty)');
  assert.equal(craftOf(s).status, 'idle', 'one-shot end — idle at the last waypoint');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at B (the last anchor)');
  assert.equal(craftOf(s).trip, undefined, 'no trip after the run');
  assert.equal(totalTitanium(s), before, 'titanium conserved across the whole lane');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. fuel up front: whole run burns at dispatch, later legs free; refuse whole when short --------

test('fuel: the whole run burns UP FRONT at dispatch; later legs re-dispatch with no further burn', () => {
  let s = routeState({ systemPool: { [T1]: 400 }, fuelHoard: 1000 });
  s = accept(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  assert.equal(s.guilds[0].fuelHoard, 1000 - RUN_FUEL, 'the WHOLE run left the hoard at dispatch');
  assert.equal(s.audit.totalConsumed, RUN_FUEL, 'the burn is recorded so invariant 1 balances');

  // Fly the whole lane: the hoard never moves again (leg 2 re-dispatches free — fuelled up front).
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(s.guilds[0].fuelHoard, 1000 - RUN_FUEL, 'no further burn on the chained legs');
  assert.equal(s.audit.totalConsumed, RUN_FUEL, 'consumption unchanged across the run');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('fuel: an unaffordable run is refused WHOLE — nothing dispatched, the craft stays idle', () => {
  const s = routeState({ systemPool: { [T1]: 400 }, fuelHoard: RUN_FUEL - 1 });
  const reason = refuse(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  assert.match(reason, /refused whole/);
  assert.equal(craftOf(s).status, 'idle', 'the craft never left its berth');
  assert.equal(craftOf(s).route, undefined, 'no route journalled on a refusal');
  assert.equal(s.guilds[0].fuelHoard, RUN_FUEL - 1, 'the hoard is untouched');
});

// --- 3. one-shot end (also asserted in tripwire 1) — a single-waypoint run ends idle there ----------

test('one-shot end: a single-waypoint actioned run ends idle at that anchor, route cleared, no trip', () => {
  // A one-waypoint route: fly to A, load, done — the craft ends idle AT A (a system landmark).
  let s = routeState({ systemPool: { [T1]: 100 } });
  s = accept(s, dispatchRoute([{ anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 100 }]) }]));
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, SYS_ANCHOR, 'idle at the last (only) anchor');
  assert.equal(craftOf(s).trip, undefined);
  assert.deepEqual(craftOf(s).cargo, { [T1]: 100 }, 'the load happened on arrival');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. partial proceeds (§11.6): a lane never stalls on a partial ---------------------------------

test('partial: a load from an EMPTY pool moves what it can (nothing) and the lane still advances', () => {
  // Pool empty → the load moves 0, but the run does NOT stall: it flies on to B, unloads 0, ends idle.
  let s = routeState({ systemPool: undefined });
  const before = totalTitanium(s);
  s = accept(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(craftOf(s).cargo, undefined, 'nothing loaded from an empty pool');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'still reached the last waypoint — never stalled');
  assert.equal(totalTitanium(s), before, 'goods conserved (0 moved)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('partial: an unload into a NEAR-FULL outpost partials (hard cap) and the lane still advances', () => {
  // Outpost pre-stocked to leave room for only 50; load 400 at A, unload at B → only 50 fit, 350 stays.
  const room = 50;
  let s = routeState({ systemPool: { [T1]: 400 }, outpostStock: { [T1]: OUTPOST_CAPACITY - room } });
  const before = totalTitanium(s);
  s = accept(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(stock(s, T1), OUTPOST_CAPACITY, 'the outpost filled to exactly its hard cap');
  assert.deepEqual(craftOf(s).cargo, { [T1]: 350 }, 'the 350 that did not fit stayed in the hold');
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'the lane advanced to the end despite the partial');
  assert.equal(totalTitanium(s), before, 'goods conserved across the partial');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. safe halt on anchor-gone (§11.6): an outpost removed mid-run ------------------------------

test('safe halt: an outpost torn down mid-run leaves the craft idle at the bare hex, route cleared', () => {
  let s = routeState({ systemPool: { [T1]: 400 } });
  const before = totalTitanium(s);
  s = accept(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  // Fly to A and load; the craft is now heading for B (cursor 1). Tear down B out from under it.
  s = tickUntil(s, (st) => craftOf(st).route && craftOf(st).route.cursor === 1);
  assert.deepEqual(craftOf(s).cargo, { [T1]: 400 }, 'loaded at A before B vanished');
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.equal((s.outposts || []).length, 0, 'the outpost is gone');

  // Arrive at the now-bare hex: no store for the unload → HALT SAFELY (idle there, route cleared).
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(craftOf(s).status, 'idle', 'halted idle, not stranded or thrown');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'idle at the bare hex where it paused');
  assert.equal(craftOf(s).trip, undefined, 'no bad leg built past the vanished target');
  assert.deepEqual(craftOf(s).cargo, { [T1]: 400 }, 'still carrying the load (the unload never resolved)');
  assert.equal(totalTitanium(s), before, 'titanium conserved through the halt');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 6. determinism (invariant 9): replay + restart + two craft landing the same tick --------------

test('determinism: the whole lane replays byte-identically (same inputs, same next state)', () => {
  const run = () => {
    let s = routeState({ systemPool: { [T1]: 400 } });
    s = accept(s, dispatchRoute([
      { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
      { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
    ]));
    return hashState(tickUntil(s, (st) => !craftOf(st).route));
  };
  assert.equal(run(), run(), 'the routed run is deterministic');
});

test('restart: a mid-run persist/restore replays byte-identically (route + cursor are journalled state)', () => {
  let dispatched = routeState({ systemPool: { [T1]: 400 } });
  dispatched = accept(dispatched, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  // Continuous run to the end.
  const end = (st) => !craftOf(st).route;
  const continuous = tickUntil(dispatched, end);

  // Restart: fly until the craft is mid-flight on leg 2 (route live, cursor 1, in transit), round-trip
  // through JSON (a save/reload), then fly the rest.
  const mid = tickUntil(dispatched, (st) => craftOf(st).route && craftOf(st).route.cursor === 1 && craftOf(st).status === 'inTransit');
  const reloaded = JSON.parse(JSON.stringify(mid));
  const resumed = tickUntil(reloaded, end);
  assert.equal(hashState(resumed), hashState(continuous), 'the reload lands exactly where the continuous run did');
});

test('determinism: two routed craft landing the SAME tick resolve in fixed id order', () => {
  // Two identical craft at ORIGIN both loading from a 500-pool: leg lengths are equal, so they arrive
  // at A the same tick and draw from the same pool — the fixed vehicle-id order decides who gets what.
  const run = () => {
    let s = routeState({ systemPool: { [T1]: 500 } });
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { ...ORIGIN } })); // _02
    const wp = [
      { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
      { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
    ];
    s = accept(s, dispatchRoute(wp, VID));
    s = accept(s, dispatchRoute(wp, VID2));
    return tickUntil(s, (st) => !craftOf(st, VID).route && !craftOf(st, VID2).route);
  };
  const a = run();
  assert.equal(hashState(a), hashState(run()), 'two-craft same-tick landing is deterministic');
  // The pool had 500; the id-first craft loaded 400, the second only the remaining 100 — both delivered.
  assert.equal(stock(a, T1), 500, 'both craft delivered their partials to the outpost (400 + 100)');
  assert.deepEqual(checkInvariants(a, a.tick), []);
});

// --- 7. validation: refuse WHOLE on each ruled failure --------------------------------------------

test('validation: a bad manifest / zero-length leg / non-idle craft / spycraft-with-action are refused', () => {
  const base = () => routeState({ systemPool: { [T1]: 400 } });

  // A bad manifest line (unknown good) — refused, prefixed with the offending waypoint.
  assert.match(
    refuse(base(), dispatchRoute([{ anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: 'unobtainium', qty: 1 }]) }])),
    /waypoint 0 action: .*not a known stockpile good/,
  );
  // A malformed amount half (qty AND max) — refused via the shared manifestAmountError.
  assert.match(
    refuse(base(), dispatchRoute([{ anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 1, max: true }]) }])),
    /waypoint 0 action: .*qty AND max/,
  );
  // A wrong action type — refused (the only type is 'dock').
  assert.match(
    refuse(base(), dispatchRoute([{ anchor: SYS_ANCHOR, action: { type: 'mission', manifest: [] } }])),
    /must be \{ type: "dock", manifest \}/,
  );
  // A ZERO-LENGTH first leg — the craft's launch berth IS the first waypoint (§1: legs non-zero; the
  // zero-length-reposition SKIP is the §11.4 reposition rule, deferred to slice 3).
  assert.match(
    refuse(base(), dispatchRoute([{ anchor: { ...ORIGIN }, action: dock([{ dir: 'load', good: T1, qty: 1 }]) }])),
    /zero-length/,
  );
  // An empty waypoint list — refused (a run needs at least one waypoint).
  assert.match(refuse(base(), dispatchRoute([])), /non-empty ordered array/);
  // A SPYCRAFT (capacity 0) with an action — refused whole (it can never carry the cargo).
  const spy = routeState({ systemPool: { [T1]: 400 }, craftClass: SPYCRAFT });
  assert.match(
    refuse(spy, createDispatchRouteWithActionsAction({
      guildId: 'g1', vehicleId: 'vehicle_g1_spycraft_01',
      waypoints: [{ anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 1 }]) }],
    })),
    /carries no cargo/,
  );
  // A NON-IDLE craft — dispatch it plainly first, then a route is refused.
  let flying = base();
  flying = accept(flying, createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints: [{ ...HEX_B }] }));
  assert.match(refuse(flying, dispatchRoute([{ anchor: SYS_ANCHOR }])), /only an idle craft dispatches/);
});

// --- the no-action route (a pure turning-point chain) + the omit-when-absent no-op -----------------

test('a no-action route chains straight through each turning point and ends idle at the last', () => {
  // Two waypoints, NEITHER with an action — the craft flies A then B, resolving nothing, ends idle at B.
  let s = routeState({});
  s = accept(s, dispatchRoute([{ anchor: SYS_ANCHOR }, { anchor: { ...HEX_B } }]));
  // The route carries no action keys (a pure turning point).
  assert.equal(s.guilds[0].vehicles[0].route.waypoints.every((w) => w.action === undefined), true);
  s = tickUntil(s, (st) => !craftOf(st).route);
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, { ...HEX_B }, 'ended idle at the last turning point');
  assert.equal(craftOf(s).cargo, undefined, 'nothing loaded — no actions');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('no-op: a route-less craft carries no `route` key, and the snapshot omits it too', () => {
  const s = routeState({});
  const craft = craftOf(s);
  assert.equal(Object.prototype.hasOwnProperty.call(craft, 'route'), false, 'omit-when-absent on the vehicle');
  const snapRow = buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);
  assert.equal(Object.prototype.hasOwnProperty.call(snapRow, 'route'), false, 'and on the snapshot row');
});

test('the snapshot surfaces a routed craft\'s waypoints + cursor (fresh, non-aliasing)', () => {
  let s = routeState({ systemPool: { [T1]: 400 } });
  s = accept(s, dispatchRoute([
    { anchor: SYS_ANCHOR, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
  ]));
  const row = buildSnapshot(s).guilds[0].vehicles.find((v) => v.id === VID);
  assert.equal(row.route.cursor, 0);
  assert.equal(row.route.waypoints.length, 2);
  assert.deepEqual(row.route.waypoints[0].action, { type: 'dock', manifest: [{ dir: 'load', good: T1, qty: 400 }] });
  assert.deepEqual(row.route.waypoints[1].anchor, { ...HEX_B });
  // Fresh copy — mutating the snapshot cannot reach into engine state.
  row.route.waypoints[0].action.manifest[0].qty = 999;
  assert.equal(craftOf(s).route.waypoints[0].action.manifest[0].qty, 400, 'engine state unaliased');
});
