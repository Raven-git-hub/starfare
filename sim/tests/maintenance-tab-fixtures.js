'use strict';

// maintenance-tab-fixtures.js — real engine states for the Maintenance tab's client tests (roadmap 2.6 maintenance,
// slice 5; docs/maintenance.md §7.1). Every state is reached through the engine's own actions and ticks (the operator
// spawn included), and every invariant is checked at each accepted action (the fixtures' `accept`). Nothing here is a
// hand-made snapshot.
//   fleet()   — g1 with an Outpost and every craft state the Fleet half draws: five craft in the Outpost's bays, a sixth
//               queued, an idle heavy at HOME, an idle medium at 10% (early maintenance allowed), and two craft flying
//               with a pool that can pay for only one of them — so one is covered and one is not (and the pool-dry
//               notice is written).
//   droids()  — g1 holding two systems with deployed droids (the Droids half), a reserve set through the action, and
//               one droid worn out (the droids_spent notice).
//   notices() — a craft that reaches 0% mid-trip and is cut short at HOME, one on a lane that ends 'maintenance', and
//               one sent in early; then run on until each has finished.

const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { getStarterSystems, getTerranHomeworld, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT } = require('../vehicles.js');
const { CRAFT_WEAR_SCALE, craftWearPerTick } = require('../craft-maintenance.js');
const { DROID_COMPONENTS } = require('../droids.js');
const {
  createSpawnVehicleAction, createSpawnOutpostAction, createDispatchVehicleAction, createDispatchRouteWithActionsAction,
  createSetCraftMaintenanceBudgetAction, createTopUpCraftMaintenancePoolAction, createStartDeepMaintenanceAction,
  createSetDroidComponentReserveAction,
} = require('../actions.js');
const K = require('./prefecture-fixtures.js');

const { accept } = K;
const H = K.HOME.id;
const AT_H = K.AT_HOME;

// Bare hexes near HOME, off every landmark: X and X2 where test craft start, D a deep-space destination, OH the Outpost.
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

const g1Of = (s) => s.guilds.find((g) => g.id === 'g1');
const craftOf = (s, id) => g1Of(s).vehicles.find((v) => v.id === id);
function spawn(s, cls, location, condition = 1) {
  const next = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: cls, location: { ...location }, condition }));
  return { s: next, id: g1Of(next).vehicles[g1Of(next).vehicles.length - 1].id };
}
// One tick of unmaintained wear away from 0 — the craft reaches 0% on its first tick of flight.
const oneTickLeft = (cls) => craftWearPerTick(cls, false) / CRAFT_WEAR_SCALE;
function runUntil(s, done, limit = 30_000) {
  let x = s;
  for (let i = 0; i < limit; i += 1) { if (done(x)) return x; x = advance(x).state; }
  throw new Error(`maintenance-tab fixture: gave up at tick ${x.tick}`);
}
const fly = (s, id, waypoints) => accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints }));

function fleet() {
  let s = K.kitGalaxy({ credits: 100_000, fuelHoard: 10_000_000 });
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: H, coords: { ...OH } }));
  // Six lights at 0% fly to the Outpost together: the five lowest ids take its bays, the sixth queues.
  const lights = [];
  for (let i = 0; i < 6; i += 1) {
    let id;
    ({ s, id } = spawn(s, LIGHT_TRANSPORT, X, 0));
    lights.push(id);
  }
  for (const id of lights) s = fly(s, id, [{ ...OH }]);
  s = runUntil(s, (x) => craftOf(x, lights[0]).status !== 'inTransit');
  // An idle medium at 10% at HOME: below 20% at a maintenance point, so early maintenance is allowed.
  let low; let slow; let worn;
  ({ s, id: low } = spawn(s, MEDIUM_TRANSPORT, AT_H, 0.1));
  // Two craft flying from HOME to D, and a pool of 3: the heavy (fewer units left, so first) costs 5 and is skipped;
  // the light costs 1 and is covered.
  ({ s, id: slow } = spawn(s, LIGHT_TRANSPORT, AT_H, 1));
  ({ s, id: worn } = spawn(s, HEAVY_TRANSPORT, AT_H, 0.5));
  s = accept(s, createSetCraftMaintenanceBudgetAction({ guildId: 'g1', budget: 500 }));
  s = accept(s, createTopUpCraftMaintenancePoolAction({ guildId: 'g1', amount: 3 }));
  s = fly(s, slow, [{ ...D }]);
  s = fly(s, worn, [{ ...D }]);
  s = advance(s).state;
  assert.deepEqual(checkInvariants(s, s.tick), []);
  return { s, bays: lights.slice(0, 5), queued: lights[5], low, slow, worn, idle: K.HEAVY };
}

// Two starter systems g1 holds, each with a mine and deployed droids; a third is g2's home.
const [D_HOME, D_SECOND, D_RIVAL] = getStarterSystems().map((x) => x.id);
const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});
const droid = (n, systemId, ventureId, condition) => ({
  id: `asset_g1_droid_${String(n).padStart(2, '0')}`, systemId, source: 'guild', condition,
  assignedToVentureId: ventureId, deployedAtTick: 0, updatedAtTick: 0,
});
function droids() {
  let s = createState({
    guilds: [
      {
        id: 'g1', credits: 5_000, fuelHoard: 0, homeSystemId: D_HOME, homePlanetId: getTerranHomeworld(D_HOME),
        stockpiles: { [D_HOME]: { [DROID_COMPONENTS]: 7 } },
        ventures: [
          { id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: D_HOME, resourceType: 'titanium', productionRate: 5 },
          { id: 'm2', ownerGuildId: 'g1', type: 'mining', systemId: D_SECOND, resourceType: 'titanium', productionRate: 5 },
        ],
        // Droid 03 is three ticks of wear from the end: it wears out, and writes droids_spent.
        droids: [droid(1, D_HOME, 'm', 1), droid(2, D_HOME, 'm', 1), droid(3, D_HOME, 'm', 12 / 161_280), droid(4, D_SECOND, 'm2', 1)],
        droidSerial: 4,
      },
      { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: D_RIVAL, homePlanetId: getTerranHomeworld(D_RIVAL) },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', D_HOME), claimOf('g1', D_SECOND), claimOf('g2', D_RIVAL)],
  });
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the droid fixture is legal');
  s = accept(s, createSetDroidComponentReserveAction({ guildId: 'g1', systemId: D_HOME, reserve: 2 }));
  s = runUntil(s, (x) => (g1Of(x).events || []).some((e) => e.type === 'droids_spent'));
  return { s, home: D_HOME, second: D_SECOND };
}

function notices() {
  let s = K.kitGalaxy({ fuelHoard: 10_000_000 });
  let cut; let laned; let early;
  // A plain trip X → HOME → D, one tick from 0%: it reaches 0% at once and is cut short at HOME.
  ({ s, id: cut } = spawn(s, LIGHT_TRANSPORT, X, oneTickLeft(LIGHT_TRANSPORT)));
  s = fly(s, cut, [{ ...AT_H }, { ...D }]);
  // The same on a lane: it stops at HOME and its lane ends 'maintenance'.
  ({ s, id: laned } = spawn(s, LIGHT_TRANSPORT, X2, oneTickLeft(LIGHT_TRANSPORT)));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: laned, waypoints: [{ anchor: { ...AT_H } }, { anchor: { ...D } }] }));
  // A medium at 10% at HOME, sent in early.
  ({ s, id: early } = spawn(s, MEDIUM_TRANSPORT, AT_H, 0.1));
  s = accept(s, createStartDeepMaintenanceAction({ guildId: 'g1', vehicleId: early }));
  s = runUntil(s, (x) => craftOf(x, cut).status === 'maintenance' && craftOf(x, laned).status === 'maintenance');
  const entered = s;
  const finished = runUntil(s, (x) => [cut, laned, early].every((id) => craftOf(x, id).status === 'idle'));
  return { entered, finished, cut, laned, early };
}

// ---- slice 6 (docs/maintenance.md §7.2–§7.5) ----------------------------------------------------------------------

// buttons() — fleet()'s galaxy plus the craft the Deep maintenance button and the route builder are proved on:
//   low   — fleet's medium at 10%, idle at HOME: below 20% at a system g1 holds, so early maintenance is allowed;
//   at20  — a medium at exactly 20%, idle at HOME: refused (only strictly below 20%);
//   away  — a medium at 10%, idle on a bare hex: refused (not at a maintenance point);
//   full  — a medium at 10%, idle at the Outpost whose 5 bays are full: refused (an early request never queues);
//   zero  — a light at 0%, idle on a bare hex (not a point, so the sweep leaves it idle): its routes are limited;
//   above — a light at 50%, idle on the same hex: its routes are not.
function buttons() {
  const f = fleet();
  let { s } = f;
  let at20; let away; let full; let zero; let above;
  ({ s, id: at20 } = spawn(s, MEDIUM_TRANSPORT, AT_H, 0.2));
  ({ s, id: away } = spawn(s, MEDIUM_TRANSPORT, X, 0.1));
  ({ s, id: full } = spawn(s, MEDIUM_TRANSPORT, OH, 0.1));
  ({ s, id: zero } = spawn(s, LIGHT_TRANSPORT, X, 0));
  ({ s, id: above } = spawn(s, LIGHT_TRANSPORT, X, 0.5));
  assert.deepEqual(checkInvariants(s, s.tick), []);
  return { s, low: f.low, at20, away, full, zero, above, bays: f.bays, queued: f.queued };
}

// hangar() — an Outpost with its 5 bays full and THREE craft queued, the bays holding two classes so their ready times
// differ. Two waves, all at 0%: three lights and two heavies take the five bays (the heavies, slower, arrive later and
// need twice as long), then three more lights arrive and queue. `empty` is the same galaxy's Outpost before any craft
// arrives, for the Hangar's empty states.
function hangar() {
  let s = K.kitGalaxy({ credits: 100_000, fuelHoard: 10_000_000 });
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: H, coords: { ...OH } }));
  const empty = s;
  const wave = (classes) => {
    const ids = [];
    for (const cls of classes) {
      let id;
      ({ s, id } = spawn(s, cls, X, 0));
      ids.push(id);
    }
    for (const id of ids) s = fly(s, id, [{ ...OH }]);
    s = runUntil(s, (x) => ids.every((id) => craftOf(x, id).status === 'maintenance'));
    return ids;
  };
  const inBays = wave([LIGHT_TRANSPORT, LIGHT_TRANSPORT, LIGHT_TRANSPORT, HEAVY_TRANSPORT, HEAVY_TRANSPORT]);
  const queued = wave([LIGHT_TRANSPORT, LIGHT_TRANSPORT, LIGHT_TRANSPORT]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  return { s, empty, inBays, queued };
}

module.exports = { fleet, droids, notices, buttons, hangar, X, D, OH, OUTPOST, H, AT_H };
