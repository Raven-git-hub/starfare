'use strict';

// deep-maintenance.test.js — roadmap 2.6 (maintenance), slice 4 of 6: spacecraft DEEP MAINTENANCE
// (docs/maintenance.md §4; sim/deep-maintenance.js).
//
// The tripwires, in the order of the slice's proof list:
//   A. THE NUMBERS: the four full times, the 20% threshold (derived in units), the 5 bays; the duration formula.
//   B. END TO END, per class: a craft at 0% mid-route passes a rival system and a deep-space waypoint, stops at its
//      first listed held system, runs that stop's action, goes in, its lane ends 'maintenance', and it comes back
//      idle at exactly 1 on exactly the computed ready tick.
//   C. RULE 1 AT AN OUTPOST DOCK: the turnaround completes first; the sweep never pulls the craft out of the dock.
//   D. THE SWEEP: a deploy, a plant, an operator spawn, a cancel; a craft at a rival / fallow system is left alone.
//   E. THE DISPATCH RULE: refused through a point (machine-readable quote), accepted ending at one; >0% unrestricted.
//   F. EARLY: allowed below 20%; refused at exactly 20%, above, docked, dock-queued, away from a point, full Outpost.
//   G. THE QUEUE: five take bays, the sixth queues and takes the first freed bay; ties by id.
//   H. THE LOCKED HOLD: every craft action refused in a bay and in the queue.
//   I. POINTS GOING AWAY: teardown refused; removeOutpost and eviction abort; removeVehicle frees the bay.
//   J. NOTICES: reached-0 once per crossing; entered (bay / queue / from the queue); finished; owner only.
//   K. INVARIANTS: each deep-maintenance tripwire fires on a corrupt state.
//   L. NEUTRAL: deep maintenance moves nothing but the craft.
//   M. NO-OP: a galaxy where no craft reaches 0% hashes as main did (the snapshot with the added keys removed).
//   N. DETERMINISM: two runs identical; save mid-maintenance (bays and queue) → restore → continue identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { advance } = require('../run.js');
const { computeGalacticSupply } = require('../supply.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { saveState, loadOrInit } = require('../persist.js');
const { hexDistance, legTicks } = require('../transport.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { outpostDockTurnaround } = require('../outposts.js');
const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT, VEHICLE_CLASSES, VEHICLE_SPECS,
} = require('../vehicles.js');
const { CRAFT_WEAR_SCALE, craftWearPerTick, conditionUnits } = require('../craft-maintenance.js');
const DM = require('../deep-maintenance.js');
const { LANE_END_REASONS } = require('../routes.js');
const {
  quoteDispatch,
  createSpawnVehicleAction, createRemoveVehicleAction, createSpawnOutpostAction, createRemoveOutpostAction,
  createDispatchVehicleAction, createDispatchRouteWithActionsAction, createTransferCargoAction,
  createDeployAssetAction, createLoadKitAction, createUnloadKitAction, createLoadAssetAction, createUnloadAssetAction,
  createReclaimOutpostAction, createCancelRouteAction, createStopRouteAfterRunAction, createGrantKitAction,
  createStartDeepMaintenanceAction, createAbandonPrefectureAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');

const K = P; // installation-kit-fixtures, re-exported by the Prefecture fixtures
const { accept, refuse } = K;
const seed = require('../../data/seed.json');

// ── the fixture galaxy ───────────────────────────────────────────────────────────────────────────────────

// HOME (g1's, held), and the two systems nearest it, derived from the seed so a regen carries the tests: RIVAL_SYS,
// which g2 is given a claim on, and FALLOW, which nobody holds. (The Prefecture fixtures' TARGET is used only in the
// tests that plant there, which never claim RIVAL_SYS.)
const H = K.HOME.id;
const AT_H = K.AT_HOME;
const NEAR = seed.systems.filter((x) => x.id !== H)
  .map((x) => ({ id: x.id, d: hexDistance(K.HOME_HEX, x.coords) }))
  .sort((a, b) => (a.d - b.d) || a.id.localeCompare(b.id));
const RIVAL_SYS = NEAR[0].id;
const FALLOW = NEAR[1].id;
const AT_RIVAL = { landmarkKind: 'system', landmarkId: RIVAL_SYS };
const AT_FALLOW = { landmarkKind: 'system', landmarkId: FALLOW };
// Bare hexes: X is where test craft start, D a deep-space waypoint, OH the Outpost's hex. All off every landmark.
function bareHexes(n) {
  const out = [];
  for (let ring = 2; out.length < n && ring < 12; ring += 1) {
    for (let q = -ring; q <= ring; q += 1) {
      for (let r = -ring; r <= ring; r += 1) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) !== ring) continue;
        const hex = { q: K.HOME_HEX.q + q, r: K.HOME_HEX.r + r };
        if (!isHexInBounds(hex.q, hex.r) || seedLandmarkAtHex(hex.q, hex.r)) continue;
        if (out.length < n) out.push(hex);
      }
    }
  }
  return out;
}
const [X, D, OH, X2] = bareHexes(4);
const OUTPOST = 'outpost_g1_01';
const FULL = { [LIGHT_TRANSPORT]: 720, [MEDIUM_TRANSPORT]: 720, [HEAVY_TRANSPORT]: 1440, [SPYCRAFT]: 2880 };

const claim = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});
// galaxy({ outpost }) -> g1 holding HOME (with titanium there and its one idle heavy, HEAVY), g2 holding RIVAL_SYS,
// and — when asked — g1's Outpost on OH holding titanium.
function galaxy({ outpost = false } = {}) {
  let s = K.kitGalaxy({ fuelHoard: 10_000_000, stock: { titanium: 1_000 } });
  s.claims.push(claim('g2', RIVAL_SYS));
  if (outpost) {
    s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: H, coords: { ...OH } }));
    s.outposts[0].stockpile = { titanium: 500 };
    s.galacticSupply = computeGalacticSupply(s); // the supply cache counts an Outpost's stockpile
  }
  return s;
}
const g1Of = (s) => s.guilds.find((g) => g.id === 'g1');
const craftOf = (s, id) => g1Of(s).vehicles.find((v) => v.id === id);
const units = (v) => conditionUnits(v.maintenanceCondition);
// spawn(s, cls, location, condition) -> { s, id }: one craft of g1's, minted through the operator spawn.
function spawn(s, cls, location, condition = 1) {
  const next = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: cls, location: { ...location }, condition }));
  return { s: next, id: g1Of(next).vehicles[g1Of(next).vehicles.length - 1].id };
}
// One tick of unmaintained wear away from 0 — the craft reaches 0% on its first tick of flight.
const oneTickLeft = (cls) => craftWearPerTick(cls, false) / CRAFT_WEAR_SCALE;
const run = (s, n) => { let x = s; for (let i = 0; i < n; i += 1) x = advance(x).state; return x; };
function runUntil(s, done, limit = 30_000) {
  let x = s;
  for (let i = 0; i < limit; i += 1) { if (done(x)) return x; x = advance(x).state; }
  throw new Error(`gave up at tick ${x.tick}`);
}
const eventsOf = (s, type) => (g1Of(s).events || []).filter((e) => e.type === type);
const dock = (manifest) => ({ type: 'dock', manifest });
const coordsOf = (anchor) => (anchor.landmarkKind ? getSystem(anchor.landmarkId).coords : anchor);
const legOf = (cls, a, b) => legTicks(hexDistance(coordsOf(a), coordsOf(b)), VEHICLE_SPECS[cls].speed, false);
// expectedTicks(units, cls) — the ruled formula, worked independently in BigInt: ceil(missing × full ÷ scale).
function expectedTicks(u, cls) {
  const num = BigInt(CRAFT_WEAR_SCALE - u) * BigInt(FULL[cls]);
  const den = BigInt(CRAFT_WEAR_SCALE);
  return Number((num + den - 1n) / den);
}

// ── A. the numbers ───────────────────────────────────────────────────────────────────────────────────────

test('numbers: the ruled full times, the 20% threshold derived in whole units, five bays', () => {
  assert.deepEqual({ ...DM.DEEP_MAINTENANCE_FULL_TICKS }, FULL);
  assert.equal(DM.EARLY_DEEP_MAINTENANCE_BELOW_PERCENT, 20);
  assert.equal(DM.EARLY_DEEP_MAINTENANCE_BELOW_UNITS, 96_768);
  assert.equal(DM.EARLY_DEEP_MAINTENANCE_BELOW_UNITS * 5, CRAFT_WEAR_SCALE, 'exactly a fifth of the scale');
  assert.equal(DM.OUTPOST_MAINTENANCE_BAYS, 5);
  assert.ok(VEHICLE_CLASSES.every((c) => FULL[c] !== undefined));
  assert.ok(LANE_END_REASONS.includes('maintenance'));
});

test('numbers: the duration is the missing share of the full time, rounded up — from 0% the full time', () => {
  for (const cls of VEHICLE_CLASSES) {
    for (const u of [0, 1, 5, 6_048, 96_767, 96_768, 241_920, CRAFT_WEAR_SCALE - 1, CRAFT_WEAR_SCALE]) {
      const v = { class: cls, maintenanceCondition: u / CRAFT_WEAR_SCALE };
      assert.equal(DM.deepMaintenanceTicks(v), expectedTicks(u, cls), `${cls} at ${u} units`);
    }
    assert.equal(DM.deepMaintenanceTicks({ class: cls, maintenanceCondition: 0 }), FULL[cls]);
    assert.equal(DM.deepMaintenanceTicks({ class: cls, maintenanceCondition: 0.5 }), FULL[cls] / 2);
    assert.equal(DM.deepMaintenanceTicks({ class: cls, maintenanceCondition: 1 }), 0);
  }
});

// ── B. end to end, per class ─────────────────────────────────────────────────────────────────────────────

for (const cls of VEHICLE_CLASSES) {
  test(`end to end (${cls}): at 0% it flies past a rival system and deep space, acts at HOME, goes in, and is back at 1 on the ready tick`, () => {
    let s = galaxy();
    let id;
    ({ s, id } = spawn(s, cls, X, oneTickLeft(cls)));
    // A spycraft carries no cargo, so its HOME stop has no action; every other class loads titanium there.
    const homeStop = cls === SPYCRAFT ? { anchor: AT_H } : { anchor: AT_H, action: dock([{ dir: 'load', good: 'titanium', qty: 5 }]) };
    const t0 = s.tick;
    s = accept(s, createDispatchRouteWithActionsAction({
      guildId: 'g1', vehicleId: id, waypoints: [{ anchor: AT_RIVAL }, { anchor: { ...D } }, homeStop, { anchor: AT_FALLOW }],
    }));
    const arrivalHome = t0 + legOf(cls, X, AT_RIVAL) + legOf(cls, AT_RIVAL, D) + legOf(cls, D, AT_H);
    // Fly until it goes in, watching it pass the first two waypoints at 0% without stopping.
    const cursorsAtZero = new Set();
    while (craftOf(s, id).status !== 'maintenance') {
      const v = craftOf(s, id);
      if (v.status === 'inTransit' && units(v) === 0) cursorsAtZero.add(v.route.cursor);
      assert.notEqual(v.status, 'idle', `it never stops before HOME (tick ${s.tick})`);
      s = advance(s).state;
      assert.ok(s.tick <= arrivalHome, 'it went in no later than its arrival at HOME');
    }
    assert.deepEqual([...cursorsAtZero].sort(), [0, 1, 2], 'flying at 0% toward the rival system, deep space and HOME');
    assert.equal(eventsOf(s, 'craft_reached_zero')[0].tick, t0 + 1, 'it reached 0% on its first flight tick');
    const v = craftOf(s, id);
    assert.equal(s.tick, arrivalHome, 'it went in on the tick it reached HOME');
    assert.deepEqual(v.location, AT_H);
    assert.deepEqual(v.laneEnded, { reason: 'maintenance', tick: arrivalHome });
    assert.equal(v.route, undefined, 'the rest of the route (FALLOW) is dropped');
    assert.equal(v.trip, undefined);
    assert.deepEqual(v.deepMaintenance, { readyTick: arrivalHome + FULL[cls] });
    if (cls !== SPYCRAFT) assert.deepEqual(v.cargo, { titanium: 5 }, "the stop's action ran first");
    // One tick short of the ready tick it is still in; on it, idle at exactly 1, stamped, where it stood.
    s = run(s, FULL[cls] - 1);
    assert.equal(craftOf(s, id).status, 'maintenance');
    assert.equal(units(craftOf(s, id)), 0, 'no partial credit while in');
    s = advance(s).state;
    const done = craftOf(s, id);
    assert.equal(s.tick, arrivalHome + FULL[cls]);
    assert.equal(done.status, 'idle');
    assert.equal(done.maintenanceCondition, 1);
    assert.equal(done.updatedAtTick, arrivalHome + FULL[cls]);
    assert.equal(done.deepMaintenance, undefined);
    assert.deepEqual(done.location, AT_H);
    assert.deepEqual(eventsOf(s, 'deep_maintenance_finished').map((e) => e.tick), [arrivalHome + FULL[cls]]);
  });
}

test('end to end: a craft above 0% at the same stop simply flies on — rule 1 is for 0% only', () => {
  let s = galaxy();
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, 1));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: id, waypoints: [{ anchor: AT_H }, { anchor: AT_FALLOW }] }));
  s = runUntil(s, (x) => !craftOf(x, id).route);
  assert.equal(craftOf(s, id).status, 'idle');
  assert.deepEqual(craftOf(s, id).location, AT_FALLOW);
  assert.equal(craftOf(s, id).laneEnded, undefined);
});

test('end to end: a repeating lane at 0% ends at its maintenance point too (rule 1 at the lap boundary)', () => {
  let s = galaxy();
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: id, repeat: { mode: 'continuous' }, waypoints: [{ anchor: { ...D } }, { anchor: AT_H }],
  }));
  s = runUntil(s, (x) => craftOf(x, id).status === 'maintenance');
  assert.deepEqual(craftOf(s, id).location, AT_H);
  assert.equal(craftOf(s, id).laneEnded.reason, 'maintenance', 'the lane would have gone round again — so it is ended');
  assert.equal(craftOf(s, id).route, undefined);
});

test('end to end: a one-shot that ENDS at a point goes in by the sweep, with no lane-ended flag (it finished)', () => {
  let s = galaxy();
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: id, waypoints: [{ anchor: { ...D } }, { anchor: AT_H }] }));
  s = runUntil(s, (x) => craftOf(x, id).status === 'maintenance');
  assert.equal(craftOf(s, id).laneEnded, undefined);
  assert.equal(craftOf(s, id).deepMaintenance.readyTick, s.tick + FULL[LIGHT_TRANSPORT]);
});

// ── C. rule 1 at an Outpost dock ─────────────────────────────────────────────────────────────────────────

test('rule 1 at an Outpost dock: the 0% craft completes its turnaround, THEN goes in instead of departing', () => {
  let s = galaxy({ outpost: true });
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
  const t0 = s.tick;
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: id, waypoints: [{ anchor: { ...OH }, action: dock([{ dir: 'load', good: 'titanium', qty: 7 }]) }, { anchor: { ...D } }],
  }));
  const arrival = t0 + legOf(LIGHT_TRANSPORT, X, OH);
  const completion = arrival + outpostDockTurnaround(LIGHT_TRANSPORT);
  let sawDocked = 0;
  while (craftOf(s, id).status !== 'maintenance') {
    s = advance(s).state;
    const engaged = (s.outposts[0].queue || []).concat(s.outposts[0].slots || []).some((e) => e.vehicleId === id);
    if (engaged) {
      sawDocked += 1;
      assert.notEqual(craftOf(s, id).status, 'maintenance', `the sweep left it in the dock at tick ${s.tick}`);
      assert.equal(units(craftOf(s, id)), 0, 'it sits in the dock at 0%');
    }
    assert.ok(s.tick <= completion, 'runaway');
  }
  assert.ok(sawDocked > 0, 'it really docked at 0%');
  const v = craftOf(s, id);
  assert.equal(s.tick, completion, 'it went in on the tick its turnaround completed');
  assert.deepEqual(v.cargo, { titanium: 7 }, 'the turnaround ran');
  assert.deepEqual(v.laneEnded, { reason: 'maintenance', tick: completion });
  assert.deepEqual(v.deepMaintenance, { readyTick: completion + FULL[LIGHT_TRANSPORT] });
  assert.equal(s.outposts[0].slots, undefined, 'its dock slot is free');
  assert.deepEqual(DM.bayOccupants(s, g1Of(s), s.outposts[0]).map((c) => c.id), [id], 'it took a maintenance bay');
});

// ── D. the sweep ─────────────────────────────────────────────────────────────────────────────────────────

// ladenHeavyAtZero() -> the galaxy's heavy at HOME with an Outpost kit aboard, worn to one tick of flight from 0% —
// so it reaches 0% on its way to wherever the test sends it.
function ladenHeavyAtZero() {
  let s = galaxy();
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: H, kind: 'outpost' }));
  const kitId = g1Of(s).assets.find((a) => a.kind === 'outpost').id;
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: K.HEAVY, assetId: kitId }));
  craftOf(s, K.HEAVY).maintenanceCondition = oneTickLeft(HEAVY_TRANSPORT); // worn down, as a long flight would leave it
  return { s, kitId };
}

test('sweep: a 0% heavy that deploys an Outpost where it stands goes into maintenance AT that Outpost', () => {
  let { s } = ladenHeavyAtZero();
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: K.HEAVY, waypoints: [{ ...X }] }));
  s = runUntil(s, (x) => craftOf(x, K.HEAVY).status === 'idle');
  assert.equal(units(craftOf(s, K.HEAVY)), 0, 'it landed at 0% on open space and stays idle there');
  s = run(s, 3);
  assert.equal(craftOf(s, K.HEAVY).status, 'idle', 'open space is no maintenance point');
  s = accept(s, createDeployAssetAction({ guildId: 'g1', vehicleId: K.HEAVY }));
  const v = craftOf(s, K.HEAVY);
  assert.equal(v.status, 'maintenance', 'the after-action sweep sent it in at once');
  assert.deepEqual(v.deepMaintenance, { readyTick: s.tick + FULL[HEAVY_TRANSPORT] });
  assert.equal(DM.maintenancePointAt(s, 'g1', v.location).outpost.id, s.outposts[0].id);
});

test('sweep: a 0% heavy on a deploy ROUTE deploys on arrival, then goes in at its new Outpost (no lane flag — it finished)', () => {
  let { s } = ladenHeavyAtZero();
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: K.HEAVY, waypoints: [{ anchor: { ...X }, action: { type: 'deploy', kind: 'outpost' } }],
  }));
  s = runUntil(s, (x) => craftOf(x, K.HEAVY).status !== 'inTransit');
  const v = craftOf(s, K.HEAVY);
  assert.equal(s.outposts.length, 1, 'it deployed first');
  assert.equal(v.status, 'maintenance');
  assert.equal(v.laneEnded, undefined);
  assert.equal(v.cargo, undefined, 'the kit was placed');
});

test('sweep: a 0% craft idle in a fallow system goes in the moment its guild plants a Prefecture there', () => {
  let s = K.kitGalaxy({ fuelHoard: 1_000 });
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', P.TARGET));
  s = P.survey(s, 'g1', P.PLANET_A);
  let id;
  ({ s, id } = spawn(s, MEDIUM_TRANSPORT, P.AT_TARGET, 0));
  s = run(s, 5);
  assert.equal(craftOf(s, id).status, 'idle', 'a fallow system is no maintenance point');
  s = accept(s, P.plant('g1', kitId, P.SLOT_A1));
  assert.equal(craftOf(s, id).status, 'maintenance');
  assert.deepEqual(craftOf(s, id).deepMaintenance, { readyTick: s.tick + FULL[MEDIUM_TRANSPORT] });
});

test('sweep: a 0% craft idle at a rival system or a fallow one is left alone; an operator spawn at 0% at HOME goes straight in', () => {
  let s = galaxy();
  let atRival; let atFallow; let atHome;
  ({ s, id: atRival } = spawn(s, LIGHT_TRANSPORT, AT_RIVAL, 0));
  ({ s, id: atFallow } = spawn(s, LIGHT_TRANSPORT, AT_FALLOW, 0));
  s = run(s, 10);
  assert.equal(craftOf(s, atRival).status, 'idle');
  assert.equal(craftOf(s, atFallow).status, 'idle');
  assert.equal(eventsOf(s, 'deep_maintenance_entered').length, 0);
  ({ s, id: atHome } = spawn(s, LIGHT_TRANSPORT, AT_H, 0));
  assert.equal(craftOf(s, atHome).status, 'maintenance', 'docs/maintenance.md §9: the operator spawn at 0% at a point');
});

test('sweep: cancelling a 0% craft out of a dock queue leaves it idle at its own Outpost — so it goes in at once', () => {
  let s = galaxy({ outpost: true });
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
  const arrival = s.tick + legOf(LIGHT_TRANSPORT, X, OH);
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: id, waypoints: [{ anchor: { ...OH }, action: dock([{ dir: 'load', good: 'titanium', qty: 1 }]) }, { anchor: { ...D } }],
  }));
  // The tick before it lands, ten heavies queue at the dock (ready a tick earlier than it), so on its arrival tick they
  // take all ten slots and the 0% craft waits in the dock QUEUE.
  s = run(s, arrival - 1 - s.tick);
  for (let i = 0; i < 10; i += 1) {
    let h;
    ({ s, id: h } = spawn(s, HEAVY_TRANSPORT, OH, 1));
    s = accept(s, createTransferCargoAction({ guildId: 'g1', vehicleId: h, manifest: [{ dir: 'load', good: 'titanium', qty: 1 }] }));
  }
  s = advance(s).state;
  assert.equal(s.tick, arrival);
  assert.ok((s.outposts[0].queue || []).some((e) => e.vehicleId === id), 'it waits in the dock queue');
  assert.equal(craftOf(s, id).status, 'idle', 'queued at the dock at 0%, untouched by the sweep');
  assert.equal(units(craftOf(s, id)), 0);
  s = run(s, 2);
  assert.equal(craftOf(s, id).status, 'idle');
  s = accept(s, createCancelRouteAction({ guildId: 'g1', vehicleId: id }));
  assert.equal(craftOf(s, id).status, 'maintenance', 'out of the dock queue, at its own Outpost, at 0% — in it goes at once');
  assert.equal(craftOf(s, id).laneEnded, undefined, 'the player cancelled the lane; nothing ended it');
});

// ── E. the dispatch rule ─────────────────────────────────────────────────────────────────────────────────

test('dispatch rule: a 0% route through a maintenance point is refused whole — the quote says so in code', () => {
  let s = galaxy({ outpost: true });
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, 0));
  const through = [{ ...AT_H }, { ...AT_FALLOW }];
  const quote = quoteDispatch(s, { guildId: 'g1', vehicleId: id, waypoints: through });
  assert.equal(quote.ok, false);
  assert.equal(quote.code, DM.ZERO_CONDITION_STOP_CODE);
  assert.equal(quote.code, 'zero-condition-maintenance-stop');
  assert.equal(quote.waypointIndex, 0);
  assert.match(refuse(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: through })), /0% condition/);
  assert.match(refuse(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: id, waypoints: through.map((a) => ({ anchor: a })) })), /maintenance point before/);
  // An own Outpost counts too, and so does a point anywhere before the end.
  const viaOutpost = quoteDispatch(s, { guildId: 'g1', vehicleId: id, waypoints: [{ ...D }, { ...OH }, { ...AT_FALLOW }] });
  assert.equal(viaOutpost.code, DM.ZERO_CONDITION_STOP_CODE);
  assert.equal(viaOutpost.waypointIndex, 1);
});

test('dispatch rule: a 0% route that ENDS at a point is accepted, as is one through rival and fallow ground; >0% is unrestricted', () => {
  let s = galaxy();
  let zero; let fresh;
  ({ s, id: zero } = spawn(s, LIGHT_TRANSPORT, X, 0));
  ({ s, id: fresh } = spawn(s, LIGHT_TRANSPORT, X2, 0.5));
  assert.equal(quoteDispatch(s, { guildId: 'g1', vehicleId: zero, waypoints: [{ ...D }, { ...AT_H }] }).ok, true);
  assert.equal(quoteDispatch(s, { guildId: 'g1', vehicleId: zero, waypoints: [{ ...AT_RIVAL }, { ...AT_FALLOW }, { ...D }] }).ok, true);
  assert.equal(quoteDispatch(s, { guildId: 'g1', vehicleId: fresh, waypoints: [{ ...AT_H }, { ...AT_FALLOW }] }).ok, true);
  accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: fresh, waypoints: [{ ...AT_H }, { ...AT_FALLOW }] }));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: zero, waypoints: [{ anchor: { ...D } }, { anchor: { ...AT_H } }] }));
  s = runUntil(s, (x) => craftOf(x, zero).status === 'maintenance');
  assert.deepEqual(craftOf(s, zero).location, AT_H, 'it went in on arrival at the end');
});

// ── F. going in early ────────────────────────────────────────────────────────────────────────────────────

const early = (id) => createStartDeepMaintenanceAction({ guildId: 'g1', vehicleId: id });
const snapRow = (s, id) => buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1').vehicles.find((v) => v.id === id);

test('early: below 20% at HOME it goes in now, for the proportional share of the full time, rounded up', () => {
  for (const cls of VEHICLE_CLASSES) {
    let s = galaxy();
    let id;
    const u = DM.EARLY_DEEP_MAINTENANCE_BELOW_UNITS - 1;
    ({ s, id } = spawn(s, cls, AT_H, u / CRAFT_WEAR_SCALE));
    assert.equal(snapRow(s, id).craftMaintenance.earlyMaintenanceAllowed, true);
    s = accept(s, early(id));
    const v = craftOf(s, id);
    assert.equal(v.status, 'maintenance');
    assert.deepEqual(v.deepMaintenance, { readyTick: s.tick + expectedTicks(u, cls) });
    assert.ok(expectedTicks(u, cls) > FULL[cls] * 0.8, `${cls}: just over 80% of the full time`);
    assert.equal(eventsOf(s, 'deep_maintenance_entered')[0].payload.early, true);
    assert.equal(snapRow(s, id).craftMaintenance.earlyMaintenanceAllowed, false, 'already in');
    s = run(s, expectedTicks(u, cls));
    assert.equal(craftOf(s, id).maintenanceCondition, 1);
  }
});

test('early: refused at exactly 20%, above it, away from a point, on a rival system — each with its own reason', () => {
  let s = galaxy();
  let at20; let at50; let away; let rival;
  ({ s, id: at20 } = spawn(s, LIGHT_TRANSPORT, AT_H, 0.2));
  ({ s, id: at50 } = spawn(s, LIGHT_TRANSPORT, AT_H, 0.5));
  ({ s, id: away } = spawn(s, LIGHT_TRANSPORT, D, 0.1));
  ({ s, id: rival } = spawn(s, LIGHT_TRANSPORT, AT_RIVAL, 0.1));
  assert.equal(units(craftOf(s, at20)), DM.EARLY_DEEP_MAINTENANCE_BELOW_UNITS);
  assert.match(refuse(s, early(at20)), /only below 20%/);
  assert.match(refuse(s, early(at50)), /only below 20%/);
  assert.match(refuse(s, early(away)), /not at a maintenance point/);
  assert.match(refuse(s, early(rival)), /not at a maintenance point/);
  for (const id of [at20, at50, away, rival]) assert.equal(snapRow(s, id).craftMaintenance.earlyMaintenanceAllowed, false);
  // In flight, and on a lane: refused too.
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: away, waypoints: [{ ...X }] }));
  assert.match(refuse(s, early(away)), /not idle/);
});

test('early: refused while dock-queued, while docked in a slot, and at a full Outpost (an early request never queues)', () => {
  let s = galaxy({ outpost: true });
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, OH, 0.1));
  assert.equal(snapRow(s, id).craftMaintenance.earlyMaintenanceAllowed, true, 'parked at its own Outpost, below 20%');
  s = accept(s, createTransferCargoAction({ guildId: 'g1', vehicleId: id, manifest: [{ dir: 'load', good: 'titanium', qty: 1 }] }));
  assert.match(refuse(s, early(id)), /queued at an Outpost dock/);
  s = advance(s).state;
  assert.equal(craftOf(s, id).status, 'loading');
  assert.match(refuse(s, early(id)), /not idle \(status "loading"\)/);
  s = runUntil(s, (x) => craftOf(x, id).status === 'idle');
  // Fill the five bays with 0% craft; the sixth (below 20%) is refused rather than queued.
  for (let i = 0; i < 5; i += 1) ({ s } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  assert.equal(DM.bayOccupants(s, g1Of(s), s.outposts[0]).length, 5);
  assert.match(refuse(s, early(id)), /all 5 maintenance bays .* are taken/);
  assert.equal(snapRow(s, id).craftMaintenance.earlyMaintenanceAllowed, false);
});

// ── G. the queue ─────────────────────────────────────────────────────────────────────────────────────────

test('queue: six 0% craft reach one Outpost together — five take bays by id, the sixth queues and takes the first freed bay', () => {
  let s = galaxy({ outpost: true });
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    let id;
    ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, 0));
    ids.push(id);
  }
  for (const id of ids) s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...OH }] }));
  const arrival = s.tick + legOf(LIGHT_TRANSPORT, X, OH);
  s = runUntil(s, (x) => craftOf(x, ids[0]).status !== 'inTransit');
  assert.equal(s.tick, arrival);
  const o = s.outposts[0];
  assert.deepEqual(DM.bayOccupants(s, g1Of(s), o).map((v) => v.id), ids.slice(0, 5), 'the five lowest ids take the bays');
  assert.deepEqual(DM.queuedAt(s, g1Of(s), o).map((v) => v.id), [ids[5]]);
  assert.deepEqual(craftOf(s, ids[5]).deepMaintenance, { queuedTick: arrival });
  const queued = eventsOf(s, 'deep_maintenance_entered').find((e) => e.payload.craftId === ids[5]).payload;
  assert.deepEqual({ bay: queued.bay, queuePosition: queued.queuePosition }, { bay: false, queuePosition: 1 });
  // The readout: the Outpost's bays and queue; the craft's queue position.
  const row = buildSnapshot(s, 'g1').outposts.find((x) => x.id === OUTPOST);
  assert.deepEqual(row.maintenance, {
    bays: 5,
    inBays: ids.slice(0, 5).map((vehicleId) => ({ vehicleId, readyTick: arrival + 720, eta: 720 })),
    queue: [{ vehicleId: ids[5], queuedTick: arrival }],
  });
  assert.deepEqual(snapRow(s, ids[5]).craftMaintenance.deepMaintenance, {
    point: { kind: 'outpost', outpostId: OUTPOST }, queuedTick: arrival, queuePosition: 1,
  });
  // On the tick the five finish, the sixth takes a bay: ready = that tick + its full time.
  s = run(s, 720 - 1);
  assert.equal(craftOf(s, ids[0]).status, 'maintenance');
  s = advance(s).state;
  assert.equal(s.tick, arrival + 720);
  for (const id of ids.slice(0, 5)) assert.equal(craftOf(s, id).status, 'idle');
  assert.deepEqual(craftOf(s, ids[5]).deepMaintenance, { readyTick: arrival + 720 + 720 });
  const promoted = eventsOf(s, 'deep_maintenance_entered').filter((e) => e.payload.craftId === ids[5]);
  assert.deepEqual(promoted[1].payload.fromQueue, true);
});

test('queue: two queued the same tick are served by id; a later arrival queues behind both', () => {
  let s = galaxy({ outpost: true });
  let first;
  ({ s, id: first } = spawn(s, LIGHT_TRANSPORT, OH, 0));             // a bay, ready at 720
  s = run(s, 10);
  for (let i = 0; i < 4; i += 1) ({ s } = spawn(s, LIGHT_TRANSPORT, OH, 0)); // bays, ready at 730
  // Two queue in the same tick (10), a third five ticks later.
  let a; let b;
  ({ s, id: a } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  ({ s, id: b } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  s = run(s, 5);
  let late;
  ({ s, id: late } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  assert.equal(craftOf(s, a).deepMaintenance.queuedTick, craftOf(s, b).deepMaintenance.queuedTick);
  // The guild's list is in mint order, so put `b` BEFORE `a` in it: the serving order must come from (queued tick,
  // id) alone, never from where a craft happens to sit in the array.
  const list = g1Of(s).vehicles;
  const ia = list.findIndex((v) => v.id === a);
  [list[ia], list[ia + 1]] = [list[ia + 1], list[ia]];
  assert.equal(list[ia].id, b);
  assert.deepEqual(DM.queuedAt(s, g1Of(s), s.outposts[0]).map((v) => v.id), [a, b, late]);
  s = runUntil(s, (x) => craftOf(x, first).status === 'idle');
  assert.equal(s.tick, 720);
  assert.deepEqual(craftOf(s, a).deepMaintenance, { readyTick: 720 + 720 }, 'the lower id takes the one freed bay');
  assert.deepEqual(craftOf(s, b).deepMaintenance, { queuedTick: 10 });
  s = run(s, 10);
  assert.equal(s.tick, 730);
  assert.deepEqual(craftOf(s, b).deepMaintenance, { readyTick: 730 + 720 });
  assert.deepEqual(craftOf(s, late).deepMaintenance, { readyTick: 730 + 720 }, 'four bays freed at 730: b and the late one');
});

// ── H. the locked hold ───────────────────────────────────────────────────────────────────────────────────

// lockedGalaxy() -> g1's heavy IN A BAY at HOME (0%, with titanium aboard), and a second 0% heavy QUEUED at the
// Outpost behind five 0% lights. A kit at HOME, a stranded machine in FALLOW and a dock manifest stand ready, so
// each action below would pass every gate but the one that the craft is in maintenance.
function lockedGalaxy() {
  let s = galaxy({ outpost: true });
  craftOf(s, K.HEAVY).cargo = { titanium: 3 };
  craftOf(s, K.HEAVY).maintenanceCondition = 0;
  s.galacticSupply = computeGalacticSupply(s); // a hold counts in supply
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: H, kind: 'outpost' })); // the sweep sends the heavy in
  for (let i = 0; i < 5; i += 1) ({ s } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  let queued;
  ({ s, id: queued } = spawn(s, HEAVY_TRANSPORT, OH, 0));
  assert.equal(craftOf(s, K.HEAVY).status, 'maintenance');
  assert.ok(craftOf(s, K.HEAVY).deepMaintenance.readyTick !== undefined, 'in a bay');
  assert.ok(craftOf(s, queued).deepMaintenance.queuedTick !== undefined, 'queued');
  return { s, inBay: K.HEAVY, queued, kitId: g1Of(s).assets.find((a) => a.kind === 'outpost').id };
}

test('locked hold: every action that names a craft is refused, in a bay and in the queue', () => {
  const { s, inBay, queued, kitId } = lockedGalaxy();
  // A stranded machine in FALLOW (for the salvage pickup) and a machine "aboard" (for the salvage delivery) — set
  // straight on a copy, since only the gates are asked.
  const x = structuredClone(s);
  g1Of(x).assets.push({ id: 'asset_g1_miner_99', kind: 'miner', systemId: FALLOW, stranded: { tick: 0 } });
  for (const id of [inBay, queued]) {
    const where = id === inBay ? 'in a bay' : 'in the queue';
    const reasons = {
      dispatchVehicle: refuse(x, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...D }] })),
      dispatchRouteWithActions: refuse(x, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: id, waypoints: [{ anchor: { ...D } }] })),
      quoteDispatch: quoteDispatch(x, { guildId: 'g1', vehicleId: id, waypoints: [{ ...D }] }).reason,
      transferCargo: refuse(x, createTransferCargoAction({ guildId: 'g1', vehicleId: id, manifest: [{ dir: 'unload', good: 'titanium', qty: 1 }] })),
      deployAsset: refuse(x, createDeployAssetAction({ guildId: 'g1', vehicleId: id })),
      loadKit: refuse(x, createLoadKitAction({ guildId: 'g1', vehicleId: id, assetId: kitId })),
      unloadKit: refuse(x, createUnloadKitAction({ guildId: 'g1', vehicleId: id })),
      loadAsset: refuse(x, createLoadAssetAction({ guildId: 'g1', vehicleId: id, assetId: 'asset_g1_miner_99' })),
      cancelRoute: refuse(x, createCancelRouteAction({ guildId: 'g1', vehicleId: id })),
      stopRouteAfterRun: refuse(x, createStopRouteAfterRunAction({ guildId: 'g1', vehicleId: id })),
      startDeepMaintenance: refuse(x, early(id)),
    };
    const y = structuredClone(x);
    craftOf(y, id).carryingAssetId = 'asset_g1_miner_99';
    reasons.unloadAsset = refuse(y, createUnloadAssetAction({ guildId: 'g1', vehicleId: id }));
    for (const [type, reason] of Object.entries(reasons)) {
      if (type === 'cancelRoute' || type === 'stopRouteAfterRun') {
        assert.match(reason, /not (on a lane|running a route)/, `${type} ${where}: a craft in maintenance has no lane`);
      } else {
        assert.match(reason, /maintenance/, `${type} ${where} refused because it is in maintenance: ${reason}`);
      }
    }
  }
  // The Outpost teardown, with the queued heavy the one parked craft that could carry the kit, is refused too.
  const emptied = structuredClone(s);
  delete emptied.outposts[0].stockpile; // so the teardown's only bar is the craft in maintenance
  assert.match(refuse(emptied, createReclaimOutpostAction({ guildId: 'g1', outpostId: OUTPOST })), /deep maintenance/);
  // And nothing moved: the hold is exactly what it was.
  assert.deepEqual(craftOf(s, inBay).cargo, { titanium: 3 });
});

// ── I. when a point goes away ────────────────────────────────────────────────────────────────────────────

test('points going away: the teardown is refused; the operator removeOutpost aborts — idle on the hex, condition unchanged', () => {
  let s = galaxy({ outpost: true });
  let worn; let zero; let queuedId;
  ({ s, id: worn } = spawn(s, LIGHT_TRANSPORT, OH, 0.1));
  s = accept(s, early(worn));
  for (let i = 0; i < 4; i += 1) ({ s, id: zero } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  ({ s, id: queuedId } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  delete s.outposts[0].stockpile; // so the teardown's only bar is the craft in maintenance
  s.galacticSupply = computeGalacticSupply(s);
  assert.match(refuse(s, createReclaimOutpostAction({ guildId: 'g1', outpostId: OUTPOST })), /deep maintenance/);
  s = run(s, 30);
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: OUTPOST }));
  for (const id of [worn, zero, queuedId]) {
    const v = craftOf(s, id);
    assert.equal(v.status, 'idle', `${id} aborted`);
    assert.equal(v.deepMaintenance, undefined);
    assert.deepEqual(v.location, OH, 'idle in space on the hex where the Outpost stood');
    assert.equal(v.route, undefined);
    assert.equal(v.updatedAtTick, s.tick);
  }
  assert.equal(craftOf(s, worn).maintenanceCondition, 0.1, 'condition unchanged — nothing is credited before the ready tick');
  assert.equal(craftOf(s, zero).maintenanceCondition, 0);
  s = run(s, 5);
  assert.equal(craftOf(s, zero).status, 'idle', 'open space: no point, so it stays out');
  // An aborted 0% craft may now be dispatched (it ends at HOME, a point).
  accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: zero, waypoints: [{ ...AT_H }] }));
});

test('points going away: losing the system (eviction) aborts deep maintenance there — idle in place, condition unchanged', () => {
  let s = K.kitGalaxy({ fuelHoard: 1_000 });
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', P.TARGET));
  s = P.survey(s, 'g1', P.PLANET_A);
  s = accept(s, P.plant('g1', kitId, P.SLOT_A1));
  let zero; let worn;
  ({ s, id: zero } = spawn(s, LIGHT_TRANSPORT, P.AT_TARGET, 0));
  ({ s, id: worn } = spawn(s, LIGHT_TRANSPORT, P.AT_TARGET, 0.15));
  s = accept(s, early(worn));
  s = run(s, 50);
  assert.equal(craftOf(s, zero).status, 'maintenance');
  s = accept(s, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: s.prefectures[0].id }));
  for (const id of [zero, worn]) {
    assert.equal(craftOf(s, id).status, 'idle');
    assert.deepEqual(craftOf(s, id).location, P.AT_TARGET);
    assert.equal(craftOf(s, id).updatedAtTick, s.tick);
  }
  assert.equal(craftOf(s, zero).maintenanceCondition, 0);
  assert.equal(craftOf(s, worn).maintenanceCondition, 0.15);
  s = run(s, 3);
  assert.equal(craftOf(s, zero).status, 'idle', 'the system is fallow now: no point');
  assert.equal(quoteDispatch(s, { guildId: 'g1', vehicleId: zero, waypoints: [{ ...AT_H }] }).ok, true, 'it may fly on');
});

test('points going away: the operator removeVehicle may remove a craft in a bay, and the queue head takes it that tick', () => {
  let s = galaxy({ outpost: true });
  const ids = [];
  for (let i = 0; i < 6; i += 1) { let id; ({ s, id } = spawn(s, LIGHT_TRANSPORT, OH, 0)); ids.push(id); }
  s = run(s, 100);
  assert.deepEqual(craftOf(s, ids[5]).deepMaintenance, { queuedTick: 0 });
  s = accept(s, createRemoveVehicleAction({ guildId: 'g1', vehicleId: ids[2] }));
  assert.deepEqual(craftOf(s, ids[5]).deepMaintenance, { readyTick: 100 + 720 }, 'freed bay, taken at once');
  s = accept(s, createRemoveVehicleAction({ guildId: 'g1', vehicleId: ids[5] }));
  assert.equal(DM.bayOccupants(s, g1Of(s), s.outposts[0]).length, 4, 'a craft in maintenance can be removed outright');
});

// ── J. notices ───────────────────────────────────────────────────────────────────────────────────────────

test('notices: reached-0% once per crossing; entered and finished, owner only', () => {
  let s = galaxy();
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, AT_H, 1));
  craftOf(s, id).maintenanceCondition = oneTickLeft(LIGHT_TRANSPORT) * 2;
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...X }, { ...D }, { ...AT_H }] }));
  s = runUntil(s, (x) => craftOf(x, id).status === 'maintenance');
  const zeroes = eventsOf(s, 'craft_reached_zero');
  assert.deepEqual(zeroes.map((e) => [e.tick, e.payload]), [[2, { craftId: id, craftClass: LIGHT_TRANSPORT }]], 'once, though it flew on at 0% for many ticks');
  const entered = eventsOf(s, 'deep_maintenance_entered');
  assert.deepEqual(entered.map((e) => e.payload), [{
    craftId: id, craftClass: LIGHT_TRANSPORT, point: { kind: 'system', systemId: H }, bay: true, readyTick: s.tick + 720,
  }]);
  const enteredAt = s.tick;
  s = run(s, 720);
  assert.deepEqual(eventsOf(s, 'deep_maintenance_finished').map((e) => [e.tick, e.payload]), [[enteredAt + 720, {
    craftId: id, craftClass: LIGHT_TRANSPORT, point: { kind: 'system', systemId: H },
  }]]);
  // A second crossing is a second notice.
  craftOf(s, id).maintenanceCondition = oneTickLeft(LIGHT_TRANSPORT);
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...X }] }));
  s = run(s, 3);
  assert.equal(eventsOf(s, 'craft_reached_zero').length, 2);
  // Owner only: the rival's view carries no g1 event and no g1 vehicle.
  const rivalView = JSON.stringify(buildSnapshot(s, 'g2'));
  for (const t of ['craft_reached_zero', 'deep_maintenance_entered', 'deep_maintenance_finished', 'earlyMaintenanceAllowed']) {
    assert.equal(rivalView.includes(t), false, `${t} is fogged from a rival`);
  }
  assert.equal(JSON.stringify(buildSnapshot(galaxy({ outpost: true }), 'g2')).includes('inBays'), false, 'a rival Outpost row has no bays');
});

// ── K. invariants ────────────────────────────────────────────────────────────────────────────────────────

const rules = (s) => checkInvariants(s, s.tick).map((v) => v.rule);
test('invariants: each deep-maintenance tripwire fires on a corrupt state', () => {
  const { s } = lockedGalaxy();
  assert.deepEqual(rules(s), []);
  const corrupt = (f) => { const x = structuredClone(s); f(x); return rules(x); };
  assert.ok(corrupt((x) => { delete craftOf(x, K.HEAVY).deepMaintenance; }).includes('deep-maintenance-status-and-record-together'));
  assert.ok(corrupt((x) => { craftOf(x, K.HEAVY).deepMaintenance = { readyTick: x.tick }; }).includes('deep-maintenance-record-shape (§15.2)'));
  assert.ok(corrupt((x) => { craftOf(x, K.HEAVY).deepMaintenance = { readyTick: x.tick + 5, queuedTick: 0 }; }).includes('deep-maintenance-record-shape (§15.2)'));
  assert.ok(corrupt((x) => { craftOf(x, K.HEAVY).location = { ...D }; }).includes('deep-maintenance-at-own-maintenance-point (§4.1)'));
  assert.ok(corrupt((x) => { craftOf(x, K.HEAVY).deepMaintenance = { queuedTick: 0 }; }).includes('deep-maintenance-queue-only-at-an-outpost (§4.7)'));
  assert.ok(corrupt((x) => { craftOf(x, K.HEAVY).route = { waypoints: [{ anchor: { ...D } }], cursor: 0 }; }).includes('deep-maintenance-no-trip-no-route'));
  assert.ok(corrupt((x) => {
    const q = g1Of(x).vehicles.find((v) => v.deepMaintenance && v.deepMaintenance.queuedTick !== undefined);
    q.deepMaintenance = { readyTick: x.tick + 10 };
  }).includes('deep-maintenance-bays-within-limit (§4.1)'));
  assert.ok(corrupt((x) => {
    const inBay = DM.bayOccupants(x, g1Of(x), x.outposts[0])[0];
    g1Of(x).vehicles = g1Of(x).vehicles.filter((v) => v.id !== inBay.id);
  }).includes('deep-maintenance-queue-only-when-bays-full (§4.7)'));
  assert.ok(corrupt((x) => {
    const v = craftOf(x, K.HEAVY);
    v.status = 'idle'; delete v.deepMaintenance;
  }).includes('deep-maintenance-no-idle-zero-craft-at-own-point (§4.4)'));
  assert.ok(corrupt((x) => {
    x.outposts[0].queue = [{ vehicleId: K.HEAVY, readyTick: 0, manifest: [{ dir: 'load', good: 'titanium', qty: 1 }] }];
  }).includes('deep-maintenance-not-docked'));
});

// ── L. neutral ───────────────────────────────────────────────────────────────────────────────────────────

test('neutral: deep maintenance moves no credit, good, fuel, GP, RP, licence or fee — only the craft', () => {
  // Twin galaxies: the same 0% light spawned at HOME (it goes in) and at FALLOW (it sits idle). Run both through the
  // whole maintenance; with the craft row and the notices set aside, they must be byte-identical.
  const twin = (at) => {
    let s = galaxy();
    ({ s } = spawn(s, LIGHT_TRANSPORT, at, 0));
    return run(s, 730);
  };
  const strip = (s) => {
    const x = structuredClone(s);
    for (const g of x.guilds) {
      g.vehicles = g.vehicles.filter((v) => v.class !== LIGHT_TRANSPORT);
      delete g.events; delete g.eventSeq;
    }
    return x;
  };
  const inHome = twin(AT_H);
  assert.equal(eventsOf(inHome, 'deep_maintenance_finished').length, 1, 'it really went through');
  assert.equal(hashState(strip(inHome)), hashState(strip(twin(AT_FALLOW))));
});

// ── M. no-op ─────────────────────────────────────────────────────────────────────────────────────────────

// The script below, run on main at e10146d (before this slice): g1's galaxy with an Outpost, a light flying a route
// that docks there and comes home, nobody near 0%. The STATE must not move by a byte. The SNAPSHOT gains only the
// additive keys (`craftMaintenance.earlyMaintenanceAllowed` on each vehicle row, `maintenance` on the owner's Outpost
// rows), so its pin is checked with exactly those keys removed.
const NOOP_GOLDEN = {
  state: '95a553f20681d4fef7e2039080e98ee544c442eb2e456d768f22ea4e27229f61',
  snapshot: 'f456457241dc527c97a6680fc708085cc5f42a54e6da7c36812f34a8a3c6e663',
};
function noopScript() {
  let s = galaxy({ outpost: true });
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, 0.5));
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: id, waypoints: [
      { anchor: { ...OH }, action: dock([{ dir: 'load', good: 'titanium', qty: 9 }]) }, { anchor: { ...AT_H }, action: dock([{ dir: 'unload', good: 'titanium', qty: 9 }]) },
    ],
  }));
  return run(s, 1500);
}
test('no-op: a galaxy where no craft reaches 0% hashes exactly as main did (the snapshot minus the added keys)', () => {
  const s = noopScript();
  const snap = buildSnapshot(s, 'g1');
  for (const g of snap.guilds) for (const v of g.vehicles || []) delete v.craftMaintenance.earlyMaintenanceAllowed;
  for (const o of snap.outposts || []) delete o.maintenance;
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.deepEqual({ state: hashState(s), snapshot: sha(snap) }, NOOP_GOLDEN);
});

// ── N. determinism ───────────────────────────────────────────────────────────────────────────────────────

function busyScript() {
  let s = galaxy({ outpost: true });
  const ids = [];
  for (let i = 0; i < 7; i += 1) { let id; ({ s, id } = spawn(s, i % 2 ? MEDIUM_TRANSPORT : LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT))); ids.push(id); }
  for (const id of ids) s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...OH }] }));
  return { s, ids };
}
test('determinism: two runs identical; save mid-maintenance (bays AND queue) → restore → continue identical', () => {
  const a = run(busyScript().s, 900);
  const b = run(busyScript().s, 900);
  assert.equal(hashState(a), hashState(b));
  let { s, ids } = busyScript();
  s = runUntil(s, (x) => DM.queuedAt(x, g1Of(x), x.outposts[0]).length > 0);
  s = run(s, 3);
  assert.equal(DM.bayOccupants(s, g1Of(s), s.outposts[0]).length, 5);
  assert.equal(DM.queuedAt(s, g1Of(s), s.outposts[0]).length, 2);
  const unbroken = run(s, 1600);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-maintenance-restore-'));
  try {
    saveState(s, dir);
    const restored = run(loadOrInit(dir, () => { throw new Error('should restore, not init'); }), 1600);
    assert.equal(hashState(restored), hashState(unbroken));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const id of ids) assert.equal(craftOf(unbroken, id).maintenanceCondition, 1, `${id} came all the way back`);
});

// ── O. a PLAIN trip at 0% stops at its first listed point too (amendment, RULED 10-11-26) ──────────────

// plainTrip(units) -> a light at X, `units` of wear left, sent on a plain dispatch RIVAL_SYS → HOME → D. Returns the
// galaxy just after the dispatch, the craft id, and the tick its leg into HOME ends.
function plainTrip(u) {
  let s = galaxy();
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, u / CRAFT_WEAR_SCALE));
  const t0 = s.tick;
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...AT_RIVAL }, { ...AT_H }, { ...D }] }));
  const atHome = t0 + legOf(LIGHT_TRANSPORT, X, AT_RIVAL) + legOf(LIGHT_TRANSPORT, AT_RIVAL, AT_H);
  const end = atHome + legOf(LIGHT_TRANSPORT, AT_H, D);
  return { s, id, t0, atHome, end };
}
const LIGHT_WEAR = craftWearPerTick(LIGHT_TRANSPORT, false);

test('plain trip: at 0% during leg 1 it stops at the held system it lists — not refunded, the notice says it was cut short', () => {
  const { s: launched, id, atHome } = plainTrip(LIGHT_WEAR);
  const fuelAfterLaunch = g1Of(launched).fuelHoard;
  const consumedAfterLaunch = launched.audit.totalConsumed;
  const creditsAfterLaunch = g1Of(launched).credits;
  let s = runUntil(launched, (x) => craftOf(x, id).status !== 'inTransit');
  const v = craftOf(s, id);
  assert.equal(s.tick, atHome, 'it stopped on the tick its leg into HOME ended — past the rival system, short of D');
  assert.equal(v.status, 'maintenance');
  assert.deepEqual(v.location, AT_H);
  assert.equal(v.trip, undefined);
  assert.deepEqual(v.deepMaintenance, { readyTick: atHome + FULL[LIGHT_TRANSPORT] });
  assert.equal(v.laneEnded, undefined, 'a plain trip has no lane to flag');
  assert.deepEqual(eventsOf(s, 'deep_maintenance_entered').map((e) => e.payload), [{
    craftId: id, craftClass: LIGHT_TRANSPORT, point: { kind: 'system', systemId: H }, bay: true,
    readyTick: atHome + FULL[LIGHT_TRANSPORT], tripCutShort: true, tripDestination: { ...D },
  }]);
  assert.equal(g1Of(s).fuelHoard, fuelAfterLaunch, 'the unflown leg is not refunded');
  assert.equal(s.audit.totalConsumed, consumedAfterLaunch);
  assert.equal(g1Of(s).credits, creditsAfterLaunch);
  s = run(s, FULL[LIGHT_TRANSPORT]);
  assert.equal(craftOf(s, id).maintenanceCondition, 1);
  assert.deepEqual(craftOf(s, id).location, AT_H);
});

test('plain trip: above 0% it flies through to the hex; reaching 0% only after HOME it lands at the hex, idle at 0%', () => {
  const fresh = plainTrip(CRAFT_WEAR_SCALE);
  let s = runUntil(fresh.s, (x) => craftOf(x, fresh.id).status !== 'inTransit');
  assert.equal(s.tick, fresh.end);
  assert.equal(craftOf(s, fresh.id).status, 'idle');
  assert.deepEqual(craftOf(s, fresh.id).location, D);
  // Enough wear left to pass HOME and three ticks beyond it.
  const probe = plainTrip(1);
  const late = plainTrip(LIGHT_WEAR * (probe.atHome - probe.t0 + 3));
  s = runUntil(late.s, (x) => craftOf(x, late.id).status !== 'inTransit');
  assert.equal(s.tick, late.end);
  assert.deepEqual(craftOf(s, late.id).location, D);
  assert.equal(craftOf(s, late.id).status, 'idle', 'open space: no point, so it stays out');
  assert.equal(units(craftOf(s, late.id)), 0);
  assert.equal(eventsOf(s, 'craft_reached_zero')[0].tick, late.atHome + 3);
  assert.equal(eventsOf(s, 'deep_maintenance_entered').length, 0);
});

test('plain trip: reaching 0% on exactly the tick an intermediate leg ends at a point stops it there', () => {
  const probe = plainTrip(1);
  const trip = plainTrip(LIGHT_WEAR * (probe.atHome - probe.t0)); // its last unit wears off on the HOME arrival tick
  const s = runUntil(trip.s, (x) => craftOf(x, trip.id).status !== 'inTransit');
  assert.equal(eventsOf(s, 'craft_reached_zero')[0].tick, trip.atHome);
  assert.equal(s.tick, trip.atHome);
  assert.equal(craftOf(s, trip.id).status, 'maintenance');
  assert.deepEqual(craftOf(s, trip.id).location, AT_H);
});

test('plain trip: a Prefecture planted mid-flight in a waypoint\'s system makes that waypoint a stop', () => {
  const launch = () => {
    let s = K.kitGalaxy({ fuelHoard: 1_000 });
    let kitId;
    ({ s, kitId } = P.grantPrefectureKit(s, 'g1', P.TARGET));
    s = P.survey(s, 'g1', P.PLANET_A);
    let id;
    ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
    s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...P.AT_TARGET }, { ...D }] }));
    return { s: run(s, 2), id, kitId };
  };
  // Unplanted, TARGET is fallow: the 0% craft flies through it to D.
  const fallow = launch();
  let s = runUntil(fallow.s, (x) => craftOf(x, fallow.id).status !== 'inTransit');
  assert.deepEqual(craftOf(s, fallow.id).location, D);
  // Planted while the craft flies: TARGET is held when the leg ends there, so the craft stops.
  const planted = launch();
  s = accept(planted.s, P.plant('g1', planted.kitId, P.SLOT_A1));
  assert.equal(craftOf(s, planted.id).status, 'inTransit', 'still flying when the system becomes held');
  s = runUntil(s, (x) => craftOf(x, planted.id).status !== 'inTransit');
  assert.equal(craftOf(s, planted.id).status, 'maintenance');
  assert.deepEqual(craftOf(s, planted.id).location, P.AT_TARGET);
});

test('plain trip: cut short at its own Outpost with all five bays full, it queues', () => {
  let s = galaxy({ outpost: true });
  for (let i = 0; i < 5; i += 1) ({ s } = spawn(s, LIGHT_TRANSPORT, OH, 0));
  let id;
  ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [{ ...OH }, { ...D }] }));
  s = runUntil(s, (x) => craftOf(x, id).status !== 'inTransit');
  assert.deepEqual(craftOf(s, id).location, OH);
  assert.deepEqual(craftOf(s, id).deepMaintenance, { queuedTick: s.tick });
  const note = eventsOf(s, 'deep_maintenance_entered').find((e) => e.payload.craftId === id).payload;
  assert.deepEqual({ bay: note.bay, queuePosition: note.queuePosition, tripCutShort: note.tripCutShort, tripDestination: note.tripDestination },
    { bay: false, queuePosition: 1, tripCutShort: true, tripDestination: { ...D } });
});

test('plain trip: a laden heavy cut short keeps its kit aboard — nothing is deployed or unloaded at the stop', () => {
  let { s } = ladenHeavyAtZero();
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: K.HEAVY, waypoints: [{ ...D }, { ...AT_H }, { ...X }] }));
  s = runUntil(s, (x) => craftOf(x, K.HEAVY).status !== 'inTransit');
  const v = craftOf(s, K.HEAVY);
  assert.equal(v.status, 'maintenance');
  assert.deepEqual(v.location, AT_H);
  assert.deepEqual(v.cargo, { outpost_kit: 1 });
  assert.equal(s.outposts, undefined, 'no Outpost was deployed');
  assert.equal((g1Of(s).assets || []).some((a) => a.kind === 'outpost'), false, 'and the kit was not unloaded into HOME');
});

test('plain trip: two runs identical; save mid-trip at 0% → restore → continue identical', () => {
  const a = run(plainTrip(LIGHT_WEAR).s, 1200);
  const b = run(plainTrip(LIGHT_WEAR).s, 1200);
  assert.equal(hashState(a), hashState(b));
  let { s, id } = plainTrip(LIGHT_WEAR);
  s = run(s, 5);
  assert.equal(craftOf(s, id).status, 'inTransit');
  assert.equal(units(craftOf(s, id)), 0);
  const unbroken = run(s, 1200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-maintenance-plain-'));
  try {
    saveState(s, dir);
    const restored = run(loadOrInit(dir, () => { throw new Error('should restore, not init'); }), 1200);
    assert.equal(hashState(restored), hashState(unbroken));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(craftOf(unbroken, id).maintenanceCondition, 1, 'it was cut short, maintained and came back');
});
