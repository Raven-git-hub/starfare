'use strict';

// unload-on-arrival.test.js — the on-arrival UNLOAD route action, roadmap 2.2 deploy pipeline,
// asset-initiated slice 3a (docs/territory-model.md §5, the Return fork: "plan a route to any held system
// with an unload action auto-appended, dropping the kit back into that system's idle list").
//
// A `dispatchRouteWithActions` may end in `{ type: 'unload' }`: the heavy flies its kit to a system its
// guild holds, and on arrival the kit becomes a fresh idle kit asset there. It is the deploy action's
// mirror, and it reuses slice 1's ONE unload rule (unloadKitCheck) and ONE unload apply (kitIntoInventory),
// so the standalone unloadKit and this are one unload with two triggers.
//
// The tripwires:
//   1. HAPPY PATH: the craft lands idle at the system, the hold empty, a fresh idle kit minted there with a
//      NEW id from the stored serial (a returned kit never reissues one) — and nothing else moved; a twin
//      that flies with no action and unloads by hand ends with the same inventory (two triggers, one rule);
//   2. ANY HELD SYSTEM, at the end of a multi-stop route — the kit lands in THAT system's inventory;
//   3. THE RETURN FORK end to end: a failed deploy's retreated heavy flies home and unloads, flags gone;
//   4. ACT IN PLACE: a heavy already at the system unloads the moment it is dispatched, burning no fuel;
//   5. THE DISPATCH GATES: not the final waypoint, not a system, a system not held, not exactly one kit
//      aboard, a spycraft, a repeating lane, a deploy AND an unload, a saved route — each refused up front;
//   6. ARRIVAL RE-CHECK FAILURE (no path reaches it today): no crash, the kit never dropped — the craft idles
//      at its arrival berth and the lane ends flagged `laneEnded: target-gone`;
//   7. DETERMINISM: the minted id and the resolved state replay byte-identically across a save/restore;
//   8. INVARIANTS: clean on every tick of an unload run, and the route-shape rules fire on a misplaced unload.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hexDistance } = require('../transport.js');
const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { OUTPOST_KIT } = require('../resources.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT, SPYCRAFT } = require('../vehicles.js');
const seed = require('../../data/seed.json');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft, assertKitsMoved } = require('./kit-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createTransferCargoAction, createUnloadKitAction,
  createDispatchRouteWithActionsAction, createSaveRouteAction, createSpawnOutpostAction,
} = require('../actions.js');

// --- fixtures ------------------------------------------------------------------------------------

const sysRef = (id) => ({ landmarkKind: 'system', landmarkId: id });
const HOME = starterHomeAtDistance(6); // a real starter system the guild holds
const AT_HOME = sysRef(HOME.id);
const HOME_HEX = getSystem(HOME.id).coords;
const UNLOAD = { type: 'unload' };
const DEPLOY = { type: 'deploy', kind: 'outpost' };

// B — a SECOND system, the nearest to home (a tie → the lower id). DERIVED from the seed, so a regen carries
// the tests. A test that needs the guild to hold it adds a claim; one that needs it NOT held leaves it out.
const B = seed.systems
  .filter((sys) => sys.id !== HOME.id)
  .map((sys) => ({ id: sys.id, d: hexDistance(HOME_HEX, sys.coords) }))
  .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))[0].id;
const AT_B = sysRef(B);

// The six axial directions; a hex k steps along one is exactly k hexes away (deploy-on-arrival's helpers).
const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const along = (from, dir, k) => ({ q: from.q + k * dir.q, r: from.r + k * dir.r });
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
function freeDirection(from, ks) {
  const dir = DIRS.find((d) => ks.every((k) => isFree(along(from, d, k))));
  if (!dir) throw new Error(`no direction from ${JSON.stringify(from)} with free hexes at ${ks.join(', ')} on this seed`);
  return dir;
}

const claimOf = (guildId, systemId, n) => ({
  claimId: `claim_${guildId}_${n}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

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

// A guild g1 that HOLDS its home system (plus `extraClaims`), with one idle craft of `vehicleClass` at
// `location`, fuelled for any trip here; and g2, a rival that holds nothing (it places the Outpost that takes
// the failed deploy's hex in the Return-fork test). The ledger is balanced so the state opens clean.
function unloadState({ vehicleClass = HEAVY_TRANSPORT, location = AT_HOME, extraClaims = [] } = {}) {
  let s = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 10_000, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0 },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', HOME.id, 'home'), ...extraClaims],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location }));
  return s;
}
const craftOf = (s, i = 0) => s.guilds[0].vehicles[i];

// A heavy idle at `location` with one outpost kit aboard: granted at home and loaded there through the real
// actions (the kit is asset_g1_outpost_01), then PLACED at `location` — the stand-in for a flight
// (kit-fixtures.js). The trips under test all fly for real from there.
function kitAt(location, opts = {}) {
  const s = unloadState(opts);
  return placeCraft(kitAboard(s, 'g1', craftOf(s).id), 'g1', craftOf(s).id, location);
}
const dispatch = (s, waypoints, over = {}) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: craftOf(s).id, waypoints, ...over,
});
const unloadAt = (anchor) => [{ anchor, action: UNLOAD }];

// Tick until every g1 craft is idle (bounded, so a craft that never lands fails instead of hanging).
function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds[0].vehicles.every((v) => v.status === 'idle')) return s;
    s = tick(s, []);
  }
  throw new Error('a craft never landed');
}

// The fresh idle kit the unload mints — the row createAsset makes for a kit (no venture names it).
const idleKit = (n, systemId) => ({ id: `asset_g1_outpost_${String(n).padStart(2, '0')}`, kind: 'outpost', systemId, maintenanceCondition: 1 });

// --- 1. the happy path ---------------------------------------------------------------------------

test('happy path: flown home with an unload, the heavy lands idle, hold empty, a fresh idle kit minted', () => {
  const from = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  const start = kitAt(from);
  assert.equal(start.guilds[0].assets, undefined, 'the kit is aboard, so the inventory is empty');
  let s = accept(start, dispatch(start, unloadAt(AT_HOME)));
  assert.equal(craftOf(s).status, 'inTransit');
  assert.deepEqual(craftOf(s).route, { waypoints: [{ anchor: AT_HOME, action: UNLOAD }], cursor: 0 }, 'the unload rides the journalled route');
  assert.equal(s.guilds[0].fuelHoard, start.guilds[0].fuelHoard - 2 * craftOf(s).fuelCostToRun, 'the trip is fuelled up front, as any route');
  const arrivalTick = craftOf(s).trip.arrivalTick;

  s = tickToIdle(s);
  assert.equal(s.tick, arrivalTick);
  const craft = craftOf(s);
  assert.equal(craft.cargo, undefined, 'the hold is empty');
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.location, AT_HOME, 'idle at the system');
  assert.equal(craft.route, undefined, 'the one-shot run ended at its unload stop');
  assert.equal('laneEnded' in craft, false);
  assert.equal('deployFailed' in craft, false);
  assert.equal(craft.updatedAtTick, arrivalTick, 'the unload stamps the craft with the arrival tick (§15.2)');
  // IDS NEVER REPEAT (§15.4): the inventory was empty, so a live-max number would be _01 again — the id of the
  // kit that was loaded. The stored serial gives _02.
  assert.deepEqual(s.guilds[0].assets, [idleKit(2, HOME.id)]);
  assert.equal(s.guilds[0].kitAssetSerial, 2);
  assertKitsMoved(start, s, 'g1', 0, 'the route-arrival unload');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // The snapshot row is the one the client's idle-outpost list reads (__myIdleAssets('outpost')).
  const row = buildSnapshot(s).guilds[0].assets.find((a) => a.id === 'asset_g1_outpost_02');
  assert.equal(row.kind, 'outpost');
  assert.equal(row.systemId, HOME.id);
  assert.equal(row.deployedToVentureId, null);

  // NOTHING ELSE MOVED, AND ONE UNLOAD WITH TWO TRIGGERS: a twin flies the same trip with no action, then
  // unloads by hand (the standalone unloadKit). It ends with the same inventory, serial and hold — and the same
  // credits, fuel, ledger, reserve, prices and Galactic Supply.
  let twin = tickToIdle(accept(start, dispatch(start, [{ anchor: AT_HOME }])));
  assert.equal(twin.tick, s.tick);
  assert.deepEqual(craftOf(twin).cargo, { [OUTPOST_KIT]: 1 }, 'the twin still carries its kit');
  twin = accept(twin, createUnloadKitAction({ guildId: 'g1', vehicleId: craftOf(twin).id }));
  assert.deepEqual(twin.guilds[0].assets, s.guilds[0].assets, 'the two triggers mint the same kit');
  assert.equal(twin.guilds[0].kitAssetSerial, s.guilds[0].kitAssetSerial);
  assert.equal(craftOf(twin).cargo, undefined);
  for (const key of ['syndicate', 'reserve', 'prices', 'galacticSupply', 'audit', 'claims']) {
    assert.deepEqual(s[key], twin[key], `${key} unchanged by the unload`);
  }
  assert.equal(s.guilds[0].credits, twin.guilds[0].credits);
  assert.equal(s.guilds[0].fuelHoard, twin.guilds[0].fuelHoard);
});

// --- 2. any held system, at the end of a multi-stop route ------------------------------------------

test('any held system: a multi-stop route ending at a second held system drops the kit into THAT inventory', () => {
  const start = kitAt(AT_HOME, { extraClaims: [claimOf('g1', B, 2)] });
  const turn = along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1); // a plain turning point, no action
  let s = accept(start, dispatch(start, [{ anchor: turn }, { anchor: AT_B, action: UNLOAD }]));
  s = tickToIdle(s);
  assert.deepEqual(craftOf(s).location, AT_B);
  assert.equal(craftOf(s).cargo, undefined);
  assert.equal(craftOf(s).route, undefined);
  assert.deepEqual(s.guilds[0].assets, [idleKit(2, B)], 'the kit is in B’s inventory, not home’s');
  assertKitsMoved(start, s, 'g1', 0, 'the unload at B');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. the Return fork, end to end --------------------------------------------------------------

test('the Return fork: a failed deploy’s retreated heavy flies home with an unload — the kit is back, no flags', () => {
  // A deploy fails (a rival took the hex while the heavy flew) and the heavy retreats 3 hexes, kit aboard.
  const dir = freeDirection(HOME_HEX, [6, 7, 3]);
  const target = along(HOME_HEX, dir, 6);
  let s = kitAt(along(HOME_HEX, dir, 7));
  s = accept(s, dispatch(s, [{ anchor: target, action: DEPLOY }]));
  s = accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: target }));
  const retreated = tickToIdle(s);
  assert.deepEqual(craftOf(retreated).location, along(HOME_HEX, dir, 3));
  assert.deepEqual(craftOf(retreated).cargo, { [OUTPOST_KIT]: 1 });
  assert.equal(craftOf(retreated).deployFailed.reason, 'occupied');

  // Return: home, with the unload on the last stop.
  s = accept(retreated, dispatch(retreated, unloadAt(AT_HOME)));
  assert.equal('deployFailed' in craftOf(s), false, 'the dispatch clears the flag, as every dispatch does');
  s = tickToIdle(s);
  assert.deepEqual(craftOf(s).location, AT_HOME);
  assert.equal(craftOf(s).cargo, undefined);
  assert.equal('deployFailed' in craftOf(s), false);
  assert.equal('laneEnded' in craftOf(s), false);
  assert.deepEqual(s.guilds[0].assets, [idleKit(2, HOME.id)], 'an idle outpost again, under a new id');
  assertKitsMoved(retreated, s, 'g1', 0, 'the Return fork');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. act in place -----------------------------------------------------------------------------

test('act in place: a heavy already at the held system unloads the moment it is dispatched, burning nothing', () => {
  const start = kitAt(AT_HOME);
  const s = accept(start, dispatch(start, unloadAt(AT_HOME)));
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, AT_HOME);
  assert.equal(craftOf(s).cargo, undefined);
  assert.equal(craftOf(s).route, undefined);
  assert.equal(craftOf(s).updatedAtTick, s.tick);
  assert.deepEqual(s.guilds[0].assets, [idleKit(2, HOME.id)]);
  assert.equal(s.guilds[0].fuelHoard, start.guilds[0].fuelHoard, 'no leg, no fuel');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. the dispatch gates -----------------------------------------------------------------------

test('dispatch gates: an unload rides the FINAL waypoint only', () => {
  const s = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2));
  const after = along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1);
  assert.match(refuse(s, dispatch(s, [{ anchor: AT_HOME, action: UNLOAD }, { anchor: after }])),
    /waypoint 0 carries an unload action, but an unload rides the FINAL waypoint only — the craft unloads where its route ends \(waypoint 1\)/);
});

test('dispatch gates: the final waypoint must be a system — not a bare hex, not an Outpost', () => {
  const s = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2));
  const hex = along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1);
  assert.match(refuse(s, dispatch(s, unloadAt(hex))), /the unload waypoint 0 is \{"q":-?\d+,"r":-?\d+\}, not a system — a kit unloads into a held system's inventory/);
  // A seed outpost (the Syndicate waystation) as a landmark …
  assert.match(refuse(s, dispatch(s, unloadAt({ landmarkKind: 'outpost', landmarkId: HOME.waystation }))), /not a system/);
  // … and the guild's OWN Outpost, which a route reaches as its bare hex.
  const own = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: hex }));
  assert.match(refuse(own, dispatch(own, unloadAt(hex))), /not a system/);
});

test('dispatch gates: the system must be one the guild holds', () => {
  const s = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2)); // holds home only, not B
  assert.match(refuse(s, dispatch(s, unloadAt(AT_B))),
    new RegExp(`the unload at waypoint 0 would fail now — guild "g1" does not hold system "${B}" — a kit unloads only into a system its guild holds`));
});

test('dispatch gates: the craft must carry exactly one kit and nothing else', () => {
  const from = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  const empty = placeCraft(unloadState(), 'g1', 'vehicle_g1_heavyTransport_01', from);
  assert.match(refuse(empty, dispatch(empty, unloadAt(AT_HOME))), /the unload at waypoint 0 would fail now — .*must carry exactly one kit and nothing else to unload — its hold is \{\}/);
  let ore = unloadState();
  ore.guilds[0].stockpiles = { [HOME.id]: { titanium: 5 } };
  ore = accept(ore, createTransferCargoAction({ guildId: 'g1', vehicleId: craftOf(ore).id, manifest: [{ dir: 'load', good: 'titanium', qty: 5 }] }));
  placeCraft(ore, 'g1', craftOf(ore).id, from);
  assert.match(refuse(ore, dispatch(ore, unloadAt(AT_HOME))), /must carry exactly one kit and nothing else to unload — its hold is \{"titanium":5\}/);
  const light = unloadState({ vehicleClass: LIGHT_TRANSPORT, location: from });
  assert.match(refuse(light, dispatch(light, unloadAt(AT_HOME))), /must carry exactly one kit/);
  const spy = unloadState({ vehicleClass: SPYCRAFT, location: from });
  assert.match(refuse(spy, dispatch(spy, unloadAt(AT_HOME))), /carries no cargo \(capacity 0\)/);
});

test('dispatch gates: never on a repeating lane (a kit never automates)', () => {
  const s = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2));
  const turn = along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1);
  for (const repeat of [{ mode: 'continuous' }, { mode: 'nRun', n: 2 }]) {
    const reason = refuse(s, dispatch(s, [{ anchor: turn }, { anchor: AT_HOME, action: UNLOAD }], { repeat }));
    assert.match(reason, /never rides a repeating lane/, repeat.mode);
  }
});

test('dispatch gates: a deploy and an unload never ride one route', () => {
  const s = kitAt(AT_HOME);
  const hex = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2); // a hex the kit could deploy on
  // The unload first, the deploy last: the deploy alone would pass, so the both-gate is what refuses it.
  assert.match(refuse(s, dispatch(s, [{ anchor: AT_HOME, action: UNLOAD }, { anchor: hex, action: DEPLOY }])),
    /the route carries a deploy \(waypoint 1\) and an unload \(waypoint 0\) — a route ends in ONE kit action, a deploy or an unload, on its final waypoint/);
  // The deploy first, the unload last: the deploy's own final-waypoint gate refuses it first.
  const out = kitAt(hex);
  assert.match(refuse(out, dispatch(out, [{ anchor: hex, action: DEPLOY }, { anchor: AT_HOME, action: UNLOAD }])),
    /waypoint 0 carries a deploy action, but a deploy rides the FINAL waypoint only/);
});

test('a saved route never carries an unload — saveRoute keeps its dock-only gate', () => {
  const s = unloadState();
  assert.match(refuse(s, createSaveRouteAction({ guildId: 'g1', name: 'Return', waypoints: unloadAt(AT_HOME) })),
    /the only action type a saved route carries is "dock"/);
});

// --- 6. an arrival re-check that fails: no crash, the kit never dropped --------------------------------

test('arrival: the system lost mid-flight — no crash; idle at the berth, kit aboard, laneEnded target-gone', () => {
  let s = kitAt(AT_HOME, { extraClaims: [claimOf('g1', B, 2)] });
  s = accept(s, dispatch(s, unloadAt(AT_B))); // legal now: g1 holds B
  const arrivalTick = craftOf(s).trip.arrivalTick;
  s.claims = s.claims.filter((c) => c.landmarkId !== B); // B is lost while the craft flies — no play path does this today
  const flying = s;
  s = tickToIdle(s);
  const craft = craftOf(s);
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.location, AT_B, 'idle at its arrival berth');
  assert.deepEqual(craft.cargo, { [OUTPOST_KIT]: 1 }, 'the kit is still aboard — never dropped');
  assert.equal(craft.route, undefined, 'the run is over');
  assert.deepEqual(craft.laneEnded, { reason: 'target-gone', tick: arrivalTick });
  assert.equal('deployFailed' in craft, false);
  assert.equal(s.guilds[0].assets, undefined, 'no kit was minted');
  assert.equal(s.guilds[0].kitAssetSerial, 1, 'and no id was spent');
  assertKitsMoved(flying, s, 'g1', 0, 'a refused arrival unload');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assert.deepEqual(buildSnapshot(s).guilds[0].vehicles[0].laneEnded, { reason: 'target-gone', tick: arrivalTick });

  // The kit is safe aboard, so it can still be returned: the next dispatch clears the flag, and home is held.
  s = accept(s, dispatch(s, unloadAt(AT_HOME)));
  assert.equal('laneEnded' in craftOf(s), false);
  s = tickToIdle(s);
  assert.deepEqual(s.guilds[0].assets, [idleKit(2, HOME.id)]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('arrival: a kit gone from the hold in flight (corruption) — no crash, nothing minted, laneEnded target-gone', () => {
  let s = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1));
  s = accept(s, dispatch(s, unloadAt(AT_HOME)));
  const arrivalTick = craftOf(s).trip.arrivalTick;
  delete craftOf(s).cargo; // corruption: the dispatch proved the kit, and nothing in flight removes it
  s = tickToIdle(s);
  assert.deepEqual(craftOf(s).location, AT_HOME);
  assert.equal(craftOf(s).route, undefined);
  assert.deepEqual(craftOf(s).laneEnded, { reason: 'target-gone', tick: arrivalTick });
  assert.equal(s.guilds[0].assets, undefined, 'no kit is minted from an empty hold');
  assert.equal(s.guilds[0].kitAssetSerial, 1);
});

// --- 7. determinism ------------------------------------------------------------------------------

test('determinism: the minted kit id and the resolved state replay byte-identically across a save/restore', () => {
  const from = along(HOME_HEX, freeDirection(HOME_HEX, [3]), 3);
  const launch = () => {
    const s = kitAt(from);
    return accept(s, dispatch(s, unloadAt(AT_HOME)));
  };
  const direct = tickToIdle(launch());
  assert.deepEqual(direct.guilds[0].assets, [idleKit(2, HOME.id)]);
  assert.equal(hashState(tickToIdle(launch())), hashState(direct), 'the same every run (invariant 9)');

  // (a) Saved MID-FLIGHT and restored: the rest of the flight and the unload land on the same bytes.
  let mid = launch();
  for (let i = 0; i < 100; i += 1) mid = tick(mid, []);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-unload3a-'));
  try {
    saveState(mid, dirA);
    const restored = tickToIdle(loadOrInit(dirA, () => { throw new Error('expected the saved state to load'); }));
    assert.equal(hashState(restored), hashState(direct));
    assert.deepEqual(restored.guilds[0].assets, direct.guilds[0].assets, 'the same kit id');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
  }

  // (b) The dispatch JOURNALLED against a saved start, replayed on restore.
  const start = kitAt(from);
  const action = dispatch(start, unloadAt(AT_HOME));
  const live = accept(start, action);
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-unload3a-'));
  try {
    saveState(start, dirB);
    appendJournal(start.tick, action, dirB);
    const restored = loadOrInit(dirB, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(live));
    const a = tickToIdle(live);
    const b = tickToIdle(restored);
    assert.equal(hashState(a), hashState(b));
    assert.deepEqual(b.guilds[0].assets, [idleKit(2, HOME.id)]);
  } finally {
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

// --- 8. invariants -------------------------------------------------------------------------------

test('invariants: clean on every tick of an unload run, through the arrival and beyond', () => {
  const start = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1));
  let s = accept(start, dispatch(start, unloadAt(AT_HOME)));
  const arrivalTick = craftOf(s).trip.arrivalTick;
  assert.deepEqual(checkInvariants(s, s.tick), []);
  while (s.tick < arrivalTick + 5) {
    s = tick(s, []);
    assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
  }
  assert.deepEqual(s.guilds[0].assets, [idleKit(2, HOME.id)]);
});

test('invariants: a craft route’s unload must be last, on a system, on a one-shot route — and never saved', () => {
  const dir = freeDirection(HOME_HEX, [1, 2]);
  const hexA = along(HOME_HEX, dir, 1);
  const parked = kitAt(along(HOME_HEX, dir, 2));
  const flying = accept(parked, dispatch(parked, unloadAt(AT_HOME)));
  assert.deepEqual(checkInvariants(flying, flying.tick), []);
  const routeRule = (route) => {
    const bad = JSON.parse(JSON.stringify(flying));
    bad.guilds[0].vehicles[0].route = route;
    return checkInvariants(bad, bad.tick).filter((v) => v.rule === 'vehicle-route-valid').map((v) => v.detail.reason);
  };
  assert.match(routeRule({ waypoints: [{ anchor: AT_HOME, action: UNLOAD }, { anchor: hexA }], cursor: 0 })[0], /carries an unload action, which rides the final waypoint only/);
  assert.match(routeRule({ waypoints: [{ anchor: hexA, action: UNLOAD }], cursor: 0 })[0], /the unload waypoint 0's anchor must be a system/);
  assert.match(routeRule({ waypoints: [{ anchor: hexA }, { anchor: AT_HOME, action: UNLOAD }], cursor: 0, mode: 'continuous', lapsDone: 0 })[0], /an unload action rides a one-shot route only/);
  // A SAVED route never carries an unload — its integrity check keeps the dock-only shape.
  const saved = JSON.parse(JSON.stringify(flying));
  saved.guilds[0].savedRoutes = [{ id: 'route_g1_01', name: 'Return', waypoints: unloadAt(AT_HOME), updatedAtTick: 0 }];
  saved.guilds[0].savedRouteSerial = 1;
  const savedRules = checkInvariants(saved, saved.tick).filter((v) => v.rule === 'saved-route-waypoints-valid (§11.1)');
  assert.equal(savedRules.length, 1, 'a saved unload trips');
  assert.match(savedRules[0].detail.reason, /must be a \{ type: "dock", manifest \}/);
});

test('snapshot: a craft flying to unload shows the unload action on its route', () => {
  const parked = kitAt(along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2));
  const s = accept(parked, dispatch(parked, unloadAt(AT_HOME)));
  const row = buildSnapshot(s).guilds[0].vehicles[0];
  assert.deepEqual(row.route.waypoints, [{ anchor: AT_HOME, action: { type: 'unload' } }]);
  assert.equal(row.laneEnded, undefined);
});
