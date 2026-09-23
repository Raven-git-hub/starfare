'use strict';

// saved-routes.test.js — the transport AUTOMATION layer, slice 2a: the per-guild SAVED-ROUTE store
// (transport-model.md §11.9; roadmap 2.2 automation slice 2a). A guild owns `savedRoutes` — named,
// origin-free `{ id, name, waypoints: [{ anchor, action? }] }` rows — written by two journalled actions:
// `saveRoute` (a NAME-BASED UPSERT) and `deleteRoute` (by id). The snapshot surfaces them for the later
// "Load Route" client, and `checkSavedRouteIntegrity` guards them every tick.
//
// The tripwires, one per ruling (the task's "Prove it" list; the zero-length skip lives in
// route-actions.test.js, beside the executor it changes):
//   1. create + upsert — a new name mints `route_<guild>_01`, the next `_02`; re-saving the FIRST name
//      updates it IN PLACE (same id, new waypoints, serial unchanged); the waypoints are deep-copied;
//   2. delete — removes by id; the serial never decrements (the next create is `_03`, never a reissue);
//      an emptied store drops the key (omit-when-empty);
//   3. validation — empty name / empty waypoints / malformed action / unresolvable anchor / unknown id
//      are refused WHOLE, with nothing written;
//   5. snapshot — a fresh, non-aliasing copy; a route-less guild carries no key;
//   6. integrity — duplicate id / serial below a live suffix / malformed stored waypoint fail loudly;
//   + the no-op (a route-less guild is byte-identical to pre-slice) and journal replay determinism.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState, createGuild } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { getStarterSystems, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  validateAction, applyAction, intake,
  createSaveRouteAction, createDeleteRouteAction,
} = require('../actions.js');

// Two real seed systems (DERIVED from the seed, so a regen carries the test) and one free, in-bounds,
// landmark-free hex — the three anchor kinds a saved route stores (§11.1: a system, or a bare hex).
const [SYS_A, SYS_B] = getStarterSystems().slice(0, 2).map((s) => s.id);
const A = { landmarkKind: 'system', landmarkId: SYS_A };
const B = { landmarkKind: 'system', landmarkId: SYS_B };
function firstFreeHex() {
  for (let q = 0; q <= 50; q += 1) {
    for (let r = 0; r <= 50; r += 1) {
      if (isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) return { q, r };
    }
  }
  throw new Error('saved-routes.test: no free hex on this seed');
}
const HEX = firstFreeHex();
const T1 = 'titanium';

const dock = (manifest) => ({ type: 'dock', manifest });
// The canonical lane — load at A, unload at a bare hex — and a second, different one for the upsert.
const ORE_RUN = [
  { anchor: A, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
  { anchor: HEX, action: dock([{ dir: 'unload', good: T1, qty: 400 }]) },
];
const ORE_RUN_V2 = [
  { anchor: B, action: dock([{ dir: 'load', good: T1, max: true }]) },
  { anchor: HEX }, // a pure turning point — no action key
  { anchor: A, action: dock([{ dir: 'unload', good: T1, max: true }]) },
];

// An invariant-clean galaxy with two guilds (g1 saves routes; g2 is the "someone else's route" case).
function baseState() {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }, { id: 'g2', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  const next = applyAction(state, action);
  assert.deepEqual(checkInvariants(next, next.tick), [], 'every accepted save/delete leaves the state invariant-clean');
  return next;
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected refused');
  return reason;
};
const save = (name, waypoints, guildId = 'g1') => createSaveRouteAction({ guildId, name, waypoints });
const del = (routeId, guildId = 'g1') => createDeleteRouteAction({ guildId, routeId });
const g1 = (s) => s.guilds.find((g) => g.id === 'g1');
// The rule names in a state's invariant violations — what the integrity tests assert on.
const rules = (s) => checkInvariants(s, s.tick).map((v) => v.rule);

// --- 1. create + upsert ---------------------------------------------------------------------------

test('saveRoute: a new name mints route_<guild>_01, a second new name _02', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN));
  assert.equal(g1(s).savedRouteSerial, 1);
  assert.deepEqual(g1(s).savedRoutes, [
    { id: 'route_g1_01', name: 'Ore run', waypoints: ORE_RUN, updatedAtTick: 0 },
  ]);

  s = accept(s, save('Fuel run', [{ anchor: B }]));
  assert.equal(g1(s).savedRouteSerial, 2);
  assert.deepEqual(g1(s).savedRoutes.map((r) => [r.id, r.name]), [
    ['route_g1_01', 'Ore run'],
    ['route_g1_02', 'Fuel run'],
  ]);
});

test('saveRoute: re-saving an EXISTING name updates it in place — same id, new waypoints, serial unchanged', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN));
  s = accept(s, save('Fuel run', [{ anchor: B }]));
  s = tick(s, []); // a later tick, so the update's stamp is visibly its own
  s = accept(s, save('Ore run', ORE_RUN_V2));

  const [ore, fuel] = g1(s).savedRoutes;
  assert.equal(g1(s).savedRoutes.length, 2, 'an upsert adds no row');
  assert.equal(ore.id, 'route_g1_01', 'the id is kept');
  assert.deepEqual(ore.waypoints, ORE_RUN_V2, 'the waypoints are replaced');
  assert.equal(ore.updatedAtTick, 1, 'the update records the tick it happened on (§15.2)');
  assert.equal(fuel.updatedAtTick, 0, 'the other route is untouched');
  assert.equal(g1(s).savedRouteSerial, 2, 'no id minted, so the serial did not move');
});

test('saveRoute: the name is stored trimmed, so a padded name upserts the same route', () => {
  let s = baseState();
  s = accept(s, save('  Ore run ', ORE_RUN));
  assert.equal(g1(s).savedRoutes[0].name, 'Ore run');
  s = accept(s, save('Ore run', ORE_RUN_V2));
  assert.equal(g1(s).savedRoutes.length, 1, 'the trimmed names collide, so this is an update');
  assert.deepEqual(g1(s).savedRoutes[0].waypoints, ORE_RUN_V2);
  // Otherwise the match is exact: a different case is a different name (a new route).
  s = accept(s, save('ore run', [{ anchor: B }]));
  assert.equal(g1(s).savedRoutes.length, 2);
});

test('saveRoute: the stored waypoints are a deep copy — mutating the caller\'s array changes nothing', () => {
  const waypoints = [
    { anchor: { ...A }, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: { ...HEX } },
  ];
  let s = baseState();
  s = accept(s, save('Ore run', waypoints));
  waypoints[0].anchor.landmarkId = 'sys_mutated';
  waypoints[0].action.manifest[0].qty = 1;
  waypoints[1].anchor.q = 999;
  waypoints.push({ anchor: { ...B } });
  const stored = g1(s).savedRoutes[0].waypoints;
  assert.deepEqual(stored, [
    { anchor: A, action: dock([{ dir: 'load', good: T1, qty: 400 }]) },
    { anchor: HEX },
  ]);

  // The UPSERT path copies too — an update must not keep a reference to the caller's new array.
  const update = [{ anchor: { ...B }, action: dock([{ dir: 'unload', good: T1, qty: 5 }]) }];
  s = accept(s, save('Ore run', update));
  update[0].anchor.landmarkId = 'sys_mutated';
  update[0].action.manifest[0].qty = 1;
  update.push({ anchor: { ...A } });
  assert.deepEqual(g1(s).savedRoutes[0].waypoints, [{ anchor: B, action: dock([{ dir: 'unload', good: T1, qty: 5 }]) }]);
});

test('saveRoute: it is pure bookkeeping — no goods, fuel or credits move, and it needs no fuel', () => {
  // g1 holds 0 fuel: a saved route has no craft and no origin, so there is no fuel check (§11.9).
  const s0 = baseState();
  const s1 = accept(s0, save('Ore run', ORE_RUN));
  const strip = (s) => {
    const copy = structuredClone(s);
    for (const g of copy.guilds) { delete g.savedRoutes; delete g.savedRouteSerial; }
    return copy;
  };
  assert.equal(hashState(strip(s1)), hashState(s0), 'only savedRoutes / savedRouteSerial changed');
});

// --- 2. delete ------------------------------------------------------------------------------------

test('deleteRoute: removes by id; the serial never decrements, so the next create is _03, not a reissue', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN));
  s = accept(s, save('Fuel run', [{ anchor: B }]));
  s = accept(s, del('route_g1_01'));
  assert.deepEqual(g1(s).savedRoutes.map((r) => r.id), ['route_g1_02']);
  assert.equal(g1(s).savedRouteSerial, 2, 'delete does not touch the serial');

  // Re-saving the deleted route's NAME is a new route now — a fresh id, never the old one back.
  s = accept(s, save('Ore run', ORE_RUN));
  assert.deepEqual(g1(s).savedRoutes.map((r) => r.id), ['route_g1_02', 'route_g1_03']);
});

test('deleteRoute: deleting the last route drops the savedRoutes key (the serial stays)', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN));
  s = accept(s, del('route_g1_01'));
  assert.equal(Object.prototype.hasOwnProperty.call(g1(s), 'savedRoutes'), false, 'omit-when-empty');
  assert.equal(g1(s).savedRouteSerial, 1, 'the serial remembers the spent number');
  s = accept(s, save('Next', [{ anchor: A }]));
  assert.equal(g1(s).savedRoutes[0].id, 'route_g1_02');
});

// --- 3. validation: refuse WHOLE, nothing written -------------------------------------------------

test('saveRoute validation: empty name / empty waypoints / malformed action / unresolvable anchor are refused', () => {
  const s = baseState();
  assert.match(refuse(s, save('', ORE_RUN)), /name must be a non-empty string/);
  assert.match(refuse(s, save('   ', ORE_RUN)), /name must be a non-empty string/);
  assert.match(refuse(s, save(42, ORE_RUN)), /name must be a non-empty string/);
  assert.match(refuse(s, save('Ore run', [])), /non-empty ordered array/);
  assert.match(refuse(s, save('Ore run', 'sys:A')), /non-empty ordered array/);
  assert.match(refuse(s, save('Ore run', [null])), /waypoint 0 must be a \{ anchor, action\? \} object/);
  // Malformed actions — the SAME per-waypoint gate dispatchRouteWithActions uses.
  assert.match(
    refuse(s, save('Ore run', [{ anchor: A, action: { type: 'mission', manifest: [] } }])),
    /waypoint 0 action must be \{ type: "dock", manifest \}/,
  );
  assert.match(
    refuse(s, save('Ore run', [{ anchor: A }, { anchor: HEX, action: dock([{ dir: 'load', good: 'unobtainium', qty: 1 }]) }])),
    /waypoint 1 action: .*not a known stockpile good/,
  );
  assert.match(
    refuse(s, save('Ore run', [{ anchor: A, action: dock([{ dir: 'load', good: T1, qty: 1, max: true }]) }])),
    /waypoint 0 action: .*qty AND max/,
  );
  assert.match(refuse(s, save('Ore run', [{ anchor: A, action: dock([]) }])), /waypoint 0 action: manifest must be a non-empty array/);
  // Unresolvable anchors — a landmark that does not exist, an off-lattice hex, no anchor at all.
  assert.match(
    refuse(s, save('Ore run', [{ anchor: { landmarkKind: 'system', landmarkId: 'sys_nope' } }])),
    /waypoint 0 does not resolve to a valid anchor/,
  );
  assert.match(refuse(s, save('Ore run', [{ anchor: A }, { anchor: { q: 100000, r: 0 } }])), /waypoint 1 does not resolve/);
  assert.match(refuse(s, save('Ore run', [{ action: dock([{ dir: 'load', good: T1, qty: 1 }]) }])), /waypoint 0 does not resolve/);
  // An unknown guild.
  assert.match(refuse(s, save('Ore run', ORE_RUN, 'g_nope')), /no guild with id "g_nope"/);
});

test('saveRoute validation: a route with ONE bad waypoint writes nothing (refuse whole)', () => {
  const s = baseState();
  const bad = save('Ore run', [...ORE_RUN, { anchor: { landmarkKind: 'system', landmarkId: 'sys_nope' } }]);
  const { state, results } = intake(s, [bad]);
  assert.equal(results[0].accepted, false);
  assert.equal(hashState(state), hashState(s), 'state is byte-identical — no partial write');
  assert.equal(Object.prototype.hasOwnProperty.call(g1(state), 'savedRoutes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(g1(state), 'savedRouteSerial'), false, 'no serial bumped either');
});

test('deleteRoute validation: an unknown id, or another guild\'s route, is refused', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN, 'g2')); // route_g2_01 belongs to g2
  assert.match(refuse(s, del('route_g1_01')), /guild "g1" has no saved route "route_g1_01"/);
  assert.match(refuse(s, del('route_g2_01', 'g1')), /guild "g1" has no saved route "route_g2_01"/);
  assert.match(refuse(s, del('route_g2_01', 'g_nope')), /no guild with id "g_nope"/);
  // The owner can delete it.
  s = accept(s, del('route_g2_01', 'g2'));
  assert.equal(Object.prototype.hasOwnProperty.call(s.guilds[1], 'savedRoutes'), false);
});

test('the action constructors refuse a missing required field', () => {
  assert.throws(() => createSaveRouteAction({ name: 'x', waypoints: [] }), /guildId is required/);
  assert.throws(() => createSaveRouteAction({ guildId: 'g1', waypoints: [] }), /name is required/);
  assert.throws(() => createSaveRouteAction({ guildId: 'g1', name: 'x' }), /waypoints is required/);
  assert.throws(() => createDeleteRouteAction({ routeId: 'route_g1_01' }), /guildId is required/);
  assert.throws(() => createDeleteRouteAction({ guildId: 'g1' }), /routeId is required/);
});

// --- 5. the snapshot surface ----------------------------------------------------------------------

test('snapshot: a guild\'s saved routes surface as { id, name, waypoints } in stored order — a fresh copy', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN));
  s = accept(s, save('Fuel run', ORE_RUN_V2));
  const row = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  assert.deepEqual(row.savedRoutes, [
    { id: 'route_g1_01', name: 'Ore run', waypoints: ORE_RUN },
    { id: 'route_g1_02', name: 'Fuel run', waypoints: ORE_RUN_V2 },
  ]);
  // Mutating the snapshot cannot reach into engine state.
  row.savedRoutes[0].name = 'hacked';
  row.savedRoutes[0].waypoints[0].anchor.landmarkId = 'sys_mutated';
  row.savedRoutes[0].waypoints[0].action.manifest[0].qty = 1;
  assert.deepEqual(g1(s).savedRoutes[0], { id: 'route_g1_01', name: 'Ore run', waypoints: ORE_RUN, updatedAtTick: 0 });
});

test('snapshot / no-op: a route-less guild carries no savedRoutes key — in state or snapshot', () => {
  let s = baseState();
  s = accept(s, save('Ore run', ORE_RUN, 'g2'));
  const row = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'savedRoutes'), false, 'snapshot omit-when-empty');
  // A bare guild is byte-identical to pre-slice: neither new key is minted by default.
  const bare = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(bare, 'savedRoutes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(bare, 'savedRouteSerial'), false);
});

// --- determinism: the store is journalled state ----------------------------------------------------

test('determinism: the same saves/deletes replay byte-identically, and survive a save/reload + tick', () => {
  const run = () => {
    let s = baseState();
    s = accept(s, save('Ore run', ORE_RUN));
    s = accept(s, save('Fuel run', ORE_RUN_V2));
    s = tick(s, []);
    s = accept(s, save('Ore run', ORE_RUN_V2));
    s = accept(s, del('route_g1_02'));
    return s;
  };
  const a = run();
  assert.equal(hashState(a), hashState(run()), 'replay is deterministic');
  // A JSON round trip (the persist snapshot) then a tick lands exactly where the live state does.
  const reloaded = JSON.parse(JSON.stringify(a));
  assert.equal(hashState(tick(reloaded, [])), hashState(tick(a, [])));
});

// --- 6. integrity: checkSavedRouteIntegrity fails loudly ------------------------------------------

// A state whose g1 carries the given saved routes / serial, built through createState → createGuild →
// createSavedRoute, then corrupted by the test.
function stateWithRoutes(savedRoutes, savedRouteSerial) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, savedRoutes, savedRouteSerial }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const ROW = (id, name) => ({ id, name, waypoints: ORE_RUN, updatedAtTick: 0 });

test('integrity: a well-formed store is clean', () => {
  const s = stateWithRoutes([ROW('route_g1_01', 'Ore run'), ROW('route_g1_03', 'Fuel run')], 3);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('integrity: a duplicate id fails loudly', () => {
  const s = stateWithRoutes([ROW('route_g1_01', 'Ore run'), ROW('route_g1_01', 'Fuel run')], 1);
  assert.ok(rules(s).includes('saved-route-id-unique'));
});

test('integrity: a serial below a live suffix fails loudly (a future save could re-issue a live id)', () => {
  const s = stateWithRoutes([ROW('route_g1_01', 'Ore run'), ROW('route_g1_02', 'Fuel run')], 1);
  assert.ok(rules(s).includes('saved-route-serial-monotonic'));
  // A missing serial with live routes is the same fault (absent reads as 0).
  assert.ok(rules(stateWithRoutes([ROW('route_g1_01', 'Ore run')], 0)).includes('saved-route-serial-monotonic'));
});

test('integrity: a malformed stored waypoint fails loudly', () => {
  const badAnchor = stateWithRoutes([ROW('route_g1_01', 'Ore run')], 1);
  badAnchor.guilds[0].savedRoutes[0].waypoints[1].anchor = { q: 100000, r: 0 };
  assert.ok(rules(badAnchor).includes('saved-route-waypoints-valid (§11.1)'));

  const badAction = stateWithRoutes([ROW('route_g1_01', 'Ore run')], 1);
  badAction.guilds[0].savedRoutes[0].waypoints[0].action.manifest[0].good = 'unobtainium';
  assert.ok(rules(badAction).includes('saved-route-waypoints-valid (§11.1)'));

  const noWaypoints = stateWithRoutes([ROW('route_g1_01', 'Ore run')], 1);
  noWaypoints.guilds[0].savedRoutes[0].waypoints = [];
  assert.ok(rules(noWaypoints).includes('saved-route-has-waypoints (§11.9)'));
});

test('integrity: a wrong id form, a bad name, a bad tick, or a present-but-empty store fail loudly', () => {
  assert.ok(rules(stateWithRoutes([ROW('route_g2_01', 'Ore run')], 1)).includes('saved-route-id-form (route_<guild>_NN)'));
  assert.ok(rules(stateWithRoutes([ROW('vehicle_g1_01', 'Ore run')], 1)).includes('saved-route-id-form (route_<guild>_NN)'));
  assert.ok(rules(stateWithRoutes([ROW('route_g1_01', ' Ore run')], 1)).includes('saved-route-name-non-empty-trimmed (§11.9)'));
  assert.ok(rules(stateWithRoutes([ROW('route_g1_01', '')], 1)).includes('saved-route-name-non-empty-trimmed (§11.9)'));
  assert.ok(rules(stateWithRoutes([ROW('route_g1_01', 'Ore run'), ROW('route_g1_02', 'Ore run')], 2))
    .includes('saved-route-name-unique (§11.9 upsert key)'));

  const badTick = stateWithRoutes([ROW('route_g1_01', 'Ore run')], 1);
  badTick.guilds[0].savedRoutes[0].updatedAtTick = -1;
  assert.ok(rules(badTick).includes('saved-route-updatedAtTick-is-a-tick (§15.2)'));

  const empty = stateWithRoutes([ROW('route_g1_01', 'Ore run')], 1);
  empty.guilds[0].savedRoutes = [];
  assert.ok(rules(empty).includes('saved-routes-omit-when-empty (§11.9)'));
});
