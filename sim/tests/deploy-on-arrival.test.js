'use strict';

// deploy-on-arrival.test.js — the deploy pipeline slice 2, roadmap 2.2 (docs/territory-model.md §5 —
// "haul a Tier-4 kit on a transport to a target, and place it on arrival").
//
// The tripwires for the RETREAT GEOMETRY (sim/transport.js `hexStepToward`) — the pure maths a failed
// on-arrival deploy uses to pull a craft back toward the nearest system its guild holds:
//   - HAND-COMPUTED hexes: a straight line, a diagonal, an exact edge tie, and a negative-coordinate line;
//   - NEVER OVERSHOOTS: a target n hexes away or closer answers `reached`, never a hex past it;
//   - EXACT DISTANCE: over a sweep of lines, the hex is exactly n from the start and d − n from the end;
//   - BAD INPUT throws instead of answering.
//
// The tripwires for the DEPLOY WAYPOINT ACTION — `{ type: 'deploy', kind }` on a dispatchRouteWithActions:
//   1. HAPPY PATH: a heavy carrying one kit, dispatched with a deploy action to a free in-range bare hex,
//      plants the Outpost on the arrival tick (the slice-1 id scheme, the right anchor), the kit consumed,
//      the craft idle at its new Outpost, no flag — and nothing else moved (a no-deploy twin matches it);
//   2. RETREAT ON OCCUPIED: the hex taken while the craft flies → it snaps DEPLOY_RETREAT_HEXES toward the
//      nearest held system (hand-computed on an axis line), kit aboard, `deployFailed: occupied`;
//   3. RETREAT ON OUT-OF-RANGE: the held system the target was in range of lost mid-flight → it retreats
//      toward the one left (home), `deployFailed: out-of-range`;
//   4. THE CLAMP: a target DEPLOY_RETREAT_HEXES or fewer from that system lands the craft AT the system
//      (a landmark location), never past it;
//   5. THE FLAG CLEARS on the craft's next dispatch — and the kit, still aboard, can be sent again;
//   6. THE DISPATCH GATES: not the final waypoint, a repeating lane, no matching kit, a landmark target, an
//      occupied or out-of-range target NOW, an unknown kind, a spycraft — each refused whole; a saved
//      route never carries a deploy;
//   7. DETERMINISM: the retreat replays byte-identically across a save/restore (mid-flight, and from the
//      journalled dispatch); two craft landing on one hex in one tick resolve by id, the same every run.
// Plus: act-in-place, the snapshot surface, the invariant shape checks, the off-the-lattice fallback,
// the loud halt on a failure the dispatch rules out, and the no-deploy no-op.
//
// HOW A KIT GETS ABOARD (02-10-26, the asset-initiated redesign — design.md §4): granted into a system's
// inventory as an idle asset, then loaded onto the empty heavy berthed there (kit-fixtures.js `kitAboard`).
// The deploy and the retreat are UNCHANGED; these tests prove they still work through the new model. And
// one more: a craft whose retreat parks it AT a held system can drop its kit back into that system's
// inventory with the standalone unloadKit, which also clears its `deployFailed` (RULED 02-10-26).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hexDistance, hexStepToward } = require('../transport.js');
const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { OUTPOST_KIT } = require('../resources.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  OUTPOST_DEPLOY_RANGE, DEPLOY_RETREAT_HEXES, DEPLOY_FAILED_REASONS,
} = require('../outposts.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT, SPYCRAFT } = require('../vehicles.js');
const seed = require('../../data/seed.json');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft, assertKitsMoved } = require('./kit-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createTransferCargoAction, createUnloadKitAction,
  createDispatchRouteWithActionsAction, createDispatchVehicleAction, createSaveRouteAction,
  createSpawnOutpostAction,
} = require('../actions.js');

// --- the retreat geometry: hexStepToward ---------------------------------------------------------

test('geometry: a straight line along the q axis steps exactly n hexes', () => {
  // (0,0) -> (10,0): d = 10. The point 3/10 of the way is (3, 0), already a hex centre.
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 10, r: 0 }, 3), { reached: false, hex: { q: 3, r: 0 } });
  assert.deepEqual(hexStepToward({ q: 10, r: 0 }, { q: 0, r: 0 }, 3), { reached: false, hex: { q: 7, r: 0 } }, 'and back');
});

test('geometry: a diagonal line rounds through cubeRound (hand-computed)', () => {
  // (0,0) -> (5,2): d = (5 + 2 + 7) / 2 = 7. Three hexes along: q = 15/7 ≈ 2.14, r = 6/7 ≈ 0.86, s = −3.
  // Round each: q → 2 (moved 1/7), r → 1 (moved 1/7), s → −3 (moved 0). They sum to 0 already… but the
  // rule still rebuilds the one that moved FURTHEST: q and r tie at 1/7, so the fixed order rebuilds r
  // from q and s: r = −2 + 3 = 1. The hex is (2, 1): 3 hexes from the start, 4 from the end.
  const step = hexStepToward({ q: 0, r: 0 }, { q: 5, r: 2 }, 3);
  assert.deepEqual(step, { reached: false, hex: { q: 2, r: 1 } });
  assert.equal(hexDistance({ q: 0, r: 0 }, step.hex), 3);
  assert.equal(hexDistance(step.hex, { q: 5, r: 2 }), 4);
});

test('geometry: a point exactly on an edge between two hexes is settled by the fixed check order', () => {
  // (0,0) -> (2,-1): d = 2. One hex along is (1, −0.5) — exactly on the edge of (1,0) and (1,−1).
  // Round: q 1 → 1 (moved 0), r −0.5 → 0 (half rounds up, moved 0.5), s −0.5 → 0 (moved 0.5). r and s tie,
  // so neither check fires and s is the one "rebuilt" (it is not returned). The hex is (1, 0) — every time.
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 2, r: -1 }, 1), { reached: false, hex: { q: 1, r: 0 } });
});

test('geometry: negative coordinates round exactly too (a line near the galaxy rim)', () => {
  // (−150,−30) -> (−156,−20): d = (6 + 10 + 4) / 2 = 10. Three hexes along: q = −151.8, r = −27 exactly,
  // s = 178.8. Round: q → −152 (moved 0.2), r → −27 (moved 0), s → 179 (moved 0.2). q and s tie at 0.2,
  // so neither check fires; the hex is (−152, −27).
  assert.deepEqual(
    hexStepToward({ q: -150, r: -30 }, { q: -156, r: -20 }, 3),
    { reached: false, hex: { q: -152, r: -27 } },
  );
});

test('geometry: never overshoots — a target n hexes away or closer is REACHED, not passed', () => {
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 3, r: 0 }, 3), { reached: true }, 'exactly n away');
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 1, r: 1 }, 3), { reached: true }, 'closer than n');
  assert.deepEqual(hexStepToward({ q: 4, r: 4 }, { q: 4, r: 4 }, 3), { reached: true }, 'already there');
  // One hex further than n is NOT reached: it steps n and stops one short.
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 4, r: 0 }, 3), { reached: false, hex: { q: 3, r: 0 } });
});

test('geometry: over a sweep of lines the hex is exactly n from the start and d − n from the end', () => {
  // Every target within 12 hexes of two different starts, every step count short of the target. This is
  // the property the retreat relies on: the snap is exactly the ruled number of hexes, never fewer or more.
  let checked = 0;
  for (const from of [{ q: 0, r: 0 }, { q: 7, r: -3 }]) {
    for (let dq = -12; dq <= 12; dq += 1) {
      for (let dr = -12; dr <= 12; dr += 1) {
        const to = { q: from.q + dq, r: from.r + dr };
        const d = hexDistance(from, to);
        if (d > 12) continue;
        for (let n = 0; n < d; n += 1) {
          const step = hexStepToward(from, to, n);
          assert.equal(step.reached, false);
          assert.equal(hexDistance(from, step.hex), n, `${JSON.stringify({ from, to, n })}: n from the start`);
          assert.equal(hexDistance(step.hex, to), d - n, `${JSON.stringify({ from, to, n })}: d - n from the end`);
          assert.deepEqual(hexStepToward(from, to, n), step, 'the same inputs give the same hex');
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 5000, `swept ${checked} steps`);
});

test('geometry: bad input throws rather than answering', () => {
  const o = { q: 0, r: 0 };
  const far = { q: 9, r: 0 };
  assert.throws(() => hexStepToward(o, far, -1), /n >= 0/);
  assert.throws(() => hexStepToward(o, far, 1.5), /whole-number/);
  assert.throws(() => hexStepToward({ q: 0.5, r: 0 }, far, 1), /whole-number/);
  assert.throws(() => hexStepToward(o, { q: 9, r: undefined }, 1), /whole-number/);
});

// --- the deploy action: fixtures -----------------------------------------------------------------

const HOME = starterHomeAtDistance(6); // a real starter system the guild holds
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;
const DEPLOY = { type: 'deploy', kind: 'outpost' };

// The six axial directions. A hex k steps along one of them is exactly k hexes away, and every hex
// between lies on the straight line — so the retreat's landing is HAND-COMPUTABLE there: a craft that
// fails at along(S, dir, k) lands at along(S, dir, k − DEPLOY_RETREAT_HEXES).
const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const along = (from, dir, k) => ({ q: from.q + k * dir.q, r: from.r + k * dir.r });
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);

// freeDirection(from, ks) -> the first of the six directions (fixed order) in which the hex `k` steps out
// is free for every k in `ks`. DERIVED from the seed (the outposts.test.js discipline), so a regen
// carries the tests instead of breaking them.
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

// A guild g1 that HOLDS its home system, with one idle craft of `vehicleClass` at `location` (fuelled for
// any trip here), and g2, a rival that holds nothing (it places the Outposts that take g1's target hexes).
// `extraClaims` adds further held systems. The ledger is balanced so the state opens clean.
function deployState({ vehicleClass = HEAVY_TRANSPORT, location = AT_HOME, extraClaims = [] } = {}) {
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
// The kit, the asset-initiated way: granted into the system the heavy is berthed at and loaded onto it.
const withKit = (s, i = 0) => kitAboard(s, 'g1', craftOf(s, i).id);

// A heavy idle at `location` with one outpost kit aboard: granted and loaded at home through the real
// actions, then PLACED at `location` — the stand-in for a flight (kit-fixtures.js). The trips under test
// all fly for real from there.
function kitAt(location, opts = {}) {
  const s = withKit(deployState(opts));
  return placeCraft(s, 'g1', craftOf(s).id, location);
}
const dispatch = (s, waypoints, over = {}) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: craftOf(s).id, waypoints, ...over,
});
const deployTo = (target) => [{ anchor: target, action: DEPLOY }];
// The rival places an Outpost on `hex` — the "someone got there first" of the retreat tests.
const occupy = (s, hex) => accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: hex }));

// Tick until every g1 craft is idle (bounded, so a craft that never lands fails instead of hanging).
function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds[0].vehicles.every((v) => v.status === 'idle')) return s;
    s = tick(s, []);
  }
  throw new Error('a craft never landed');
}

// --- 1. the happy path ---------------------------------------------------------------------------

test('happy path: dispatched with a deploy action, the heavy plants its Outpost on the arrival tick', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [3]), 3);
  const start = kitAt(AT_HOME);
  let s = accept(start, dispatch(start, deployTo(target)));
  assert.equal(craftOf(s).status, 'inTransit');
  assert.deepEqual(craftOf(s).route, { waypoints: [{ anchor: target, action: DEPLOY }], cursor: 0 }, 'the deploy rides the journalled route');
  assert.equal(s.guilds[0].fuelHoard, start.guilds[0].fuelHoard - 3 * craftOf(s).fuelCostToRun, 'the trip is fuelled up front, as any route');
  const arrivalTick = craftOf(s).trip.arrivalTick;

  s = tickToIdle(s);
  assert.equal(s.tick, arrivalTick);
  assert.equal(s.outposts.length, 1);
  const o = s.outposts[0];
  assert.equal(o.id, 'outpost_g1_01', 'the slice-1 outpost_<guild>_NN id');
  assert.equal(o.ownerGuildId, 'g1');
  assert.deepEqual(o.coords, target);
  assert.equal(o.anchorSystemId, HOME.id, 'anchored to the nearest held system');
  assert.equal(o.createdAtTick, arrivalTick, 'minted on the arrival tick (§15.2)');
  assert.equal(s.guilds[0].outpostSerial, 1);
  const craft = craftOf(s);
  assert.equal(craft.cargo, undefined, 'the kit is consumed');
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.location, target, 'idle on the new Outpost’s hex');
  assert.equal(craft.route, undefined, 'the one-shot run ended at its deploy stop');
  assert.equal(craft.deployFailed, undefined);
  assert.equal(craft.laneEnded, undefined);
  assert.equal(craft.updatedAtTick, arrivalTick);
  assert.deepEqual(buildSnapshot(s).guilds[0].vehicles[0].dockStatus, { state: 'parked', outpostId: 'outpost_g1_01' });
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // NOTHING ELSE MOVED: a twin that flies the same trip with no deploy action ends with the same
  // credits, fuel, ledger, reserve, prices and Galactic Supply — the deploy moved only the kit.
  const twin = tickToIdle(accept(start, dispatch(start, [{ anchor: target }])));
  assert.equal(twin.tick, s.tick);
  for (const key of ['syndicate', 'reserve', 'prices', 'galacticSupply', 'audit']) {
    assert.deepEqual(s[key], twin[key], `${key} unchanged by the deploy`);
  }
  assert.equal(s.guilds[0].credits, twin.guilds[0].credits);
  assert.equal(s.guilds[0].fuelHoard, twin.guilds[0].fuelHoard);
  assert.deepEqual(s.claims, twin.claims, 'no claim row is written');
  assert.deepEqual(craftOf(twin).cargo, { [OUTPOST_KIT]: 1 }, 'the twin still carries its kit');
});

test('act in place: a heavy already on the target hex deploys the moment it is dispatched', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  let s = kitAt(target);
  s = accept(s, dispatch(s, deployTo(target)));
  assert.equal(s.outposts[0].id, 'outpost_g1_01');
  assert.equal(s.outposts[0].createdAtTick, s.tick);
  assert.equal(craftOf(s).cargo, undefined);
  assert.equal(craftOf(s).route, undefined);
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. retreat: the hex was taken ---------------------------------------------------------------

// A craft one hex short of a target `k` hexes out from home along one axis, holding a kit, dispatched to
// deploy there — and the rival then occupies the target before it lands.
function occupiedRun(k) {
  const dir = freeDirection(HOME_HEX, [k, k + 1, Math.max(k - DEPLOY_RETREAT_HEXES, 1)]);
  const target = along(HOME_HEX, dir, k);
  let s = kitAt(along(HOME_HEX, dir, k + 1));
  s = accept(s, dispatch(s, deployTo(target)));
  s = occupy(s, target);
  return { s, dir, target, arrivalTick: craftOf(s).trip.arrivalTick };
}

test('retreat on OCCUPIED: the craft snaps DEPLOY_RETREAT_HEXES toward home, kit aboard, flagged', () => {
  assert.equal(DEPLOY_RETREAT_HEXES, 3, 'the ruled [FIRST-CUT] (phase-1-tuning.md "Territory & deployment")');
  const { s: flying, dir, target, arrivalTick } = occupiedRun(8);
  const s = tickToIdle(flying);
  // Hand-computed: the target is 8 hexes out along one axis, so 3 back toward home is 5 out on that axis.
  const expected = along(HOME_HEX, dir, 5);
  const craft = craftOf(s);
  assert.deepEqual(craft.location, expected);
  assert.equal(hexDistance(target, expected), DEPLOY_RETREAT_HEXES);
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.cargo, { [OUTPOST_KIT]: 1 }, 'the kit is still aboard');
  assert.deepEqual(craft.deployFailed, { reason: 'occupied', tick: arrivalTick });
  assert.equal(craft.route, undefined, 'the run is over');
  assert.equal(craft.updatedAtTick, arrivalTick);
  // No Outpost of g1's; the rival's stands. No fuel for the snap: the hoard is where the dispatch left it.
  assert.deepEqual(s.outposts.map((o) => o.id), ['outpost_g2_01']);
  assert.equal(s.guilds[0].outpostSerial, undefined, 'no id was minted');
  assert.equal(s.guilds[0].fuelHoard, flying.guilds[0].fuelHoard, 'a snap, not travel — no fuel');
  assert.equal(s.guilds[0].credits, flying.guilds[0].credits, 'no toll, no fine');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // The snapshot surfaces the flag (the client's later "deploy failed — hex taken; craft pulled back").
  assert.deepEqual(buildSnapshot(s).guilds[0].vehicles[0].deployFailed, { reason: 'occupied', tick: arrivalTick });
});

test('retreat: two heavies landing on one hex in one tick — the lower id deploys, the other retreats', () => {
  const dir = freeDirection(HOME_HEX, [6, 7, 3]);
  const target = along(HOME_HEX, dir, 6);
  const run = () => {
    let s = deployState();
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
    s = withKit(withKit(s, 0), 1);
    for (const i of [0, 1]) placeCraft(s, 'g1', craftOf(s, i).id, along(HOME_HEX, dir, 7));
    for (const i of [1, 0]) { // dispatch order does not matter — the arrival step lands craft in id order
      s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: craftOf(s, i).id, waypoints: deployTo(target) }));
    }
    return tickToIdle(s);
  };
  const s = run();
  assert.equal(s.outposts.length, 1);
  assert.equal(craftOf(s, 0).cargo, undefined, 'vehicle _01 deployed');
  assert.deepEqual(craftOf(s, 0).location, target);
  assert.deepEqual(craftOf(s, 1).cargo, { [OUTPOST_KIT]: 1 }, 'vehicle _02 kept its kit');
  assert.deepEqual(craftOf(s, 1).location, along(HOME_HEX, dir, 3));
  assert.equal(craftOf(s, 1).deployFailed.reason, 'occupied');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assert.equal(hashState(run()), hashState(s), 'the same every run (invariant 9)');
});

// --- 3. retreat: the range was lost --------------------------------------------------------------

// A second system B, and a target T on an axis line from home that is OUT of home's deploy range but
// WITHIN B's — so the dispatch passes while the guild holds B, and fails on arrival once it does not.
function outOfRangeCase() {
  const others = seed.systems.filter((sys) => sys.id !== HOME.id).sort((a, b) => a.id.localeCompare(b.id));
  for (let k = OUTPOST_DEPLOY_RANGE + 1; k <= OUTPOST_DEPLOY_RANGE + 10; k += 1) {
    for (const dir of DIRS) {
      const target = along(HOME_HEX, dir, k);
      if (!isFree(target) || !isFree(along(HOME_HEX, dir, k - 1)) || !isFree(along(HOME_HEX, dir, k - DEPLOY_RETREAT_HEXES))) continue;
      const b = others.find((sys) => hexDistance(sys.coords, target) <= OUTPOST_DEPLOY_RANGE);
      if (b) return { b: b.id, dir, k, target };
    }
  }
  throw new Error('no out-of-range case on this seed');
}

test('retreat on OUT-OF-RANGE: the held system it was in range of is lost mid-flight — back toward home', () => {
  const { b, dir, k, target } = outOfRangeCase();
  assert.ok(hexDistance(target, HOME_HEX) > OUTPOST_DEPLOY_RANGE, 'out of home’s range');
  let s = kitAt(along(HOME_HEX, dir, k - 1), { extraClaims: [claimOf('g1', b, 2)] });
  s = accept(s, dispatch(s, deployTo(target))); // legal now: B holds the hex in range
  const arrivalTick = craftOf(s).trip.arrivalTick;
  s.claims = s.claims.filter((c) => c.landmarkId !== b); // B is lost while the craft flies
  s = tickToIdle(s);
  const craft = craftOf(s);
  // Hand-computed: k out along one axis from home, the one system left; 3 back toward it is k − 3 out.
  assert.deepEqual(craft.location, along(HOME_HEX, dir, k - DEPLOY_RETREAT_HEXES));
  assert.deepEqual(craft.cargo, { [OUTPOST_KIT]: 1 });
  assert.deepEqual(craft.deployFailed, { reason: 'out-of-range', tick: arrivalTick });
  assert.equal(s.outposts, undefined, 'nothing was placed');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. the clamp: never past the system ---------------------------------------------------------

test('clamp: a failed deploy DEPLOY_RETREAT_HEXES or fewer from the held system lands AT the system', () => {
  for (const k of [DEPLOY_RETREAT_HEXES, DEPLOY_RETREAT_HEXES - 1, 1]) {
    const { s: flying, arrivalTick } = occupiedRun(k);
    const s = tickToIdle(flying);
    assert.deepEqual(craftOf(s).location, AT_HOME, `${k} hexes out: parked at home, as the system landmark`);
    assert.deepEqual(craftOf(s).deployFailed, { reason: 'occupied', tick: arrivalTick });
    assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 });
    assert.deepEqual(buildSnapshot(s).guilds[0].vehicles[0].location, AT_HOME);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  // One hex further than the retreat is NOT clamped: it stops one hex short of home, on open ground.
  const { s: flying, dir } = occupiedRun(DEPLOY_RETREAT_HEXES + 1);
  assert.deepEqual(craftOf(tickToIdle(flying)).location, along(HOME_HEX, dir, 1));
});

test('clamp + unload: a craft pulled back AT its held system drops the kit into that system’s inventory', () => {
  const { s: flying, arrivalTick } = occupiedRun(DEPLOY_RETREAT_HEXES);
  const parked = tickToIdle(flying);
  assert.deepEqual(craftOf(parked).location, AT_HOME, 'the clamp parked it at home, kit aboard');
  assert.deepEqual(craftOf(parked).deployFailed, { reason: 'occupied', tick: arrivalTick }, 'the retreat flagged it');
  const s = accept(parked, createUnloadKitAction({ guildId: 'g1', vehicleId: craftOf(parked).id }));
  assertKitsMoved(parked, s, 'g1', 0, 'unloadKit after a retreat');
  assert.equal(craftOf(s).cargo, undefined, 'the hold is empty');
  assert.deepEqual(s.guilds[0].assets, [{ id: 'asset_g1_outpost_02', kind: 'outpost', systemId: HOME.id, maintenanceCondition: 1 }],
    'a fresh idle kit at home — the loaded kit was _01, and ids never repeat');
  // The kit is back in an inventory, so the failed deploy is over: the unload clears the flag (RULED 02-10-26)
  // rather than leaving it stale on an empty, idle craft. The key is gone, not set to null (omit-when-absent).
  assert.equal('deployFailed' in craftOf(s), false, 'unloading the kit clears deployFailed');
  assert.equal(buildSnapshot(s).guilds[0].vehicles[0].deployFailed, undefined, 'and the snapshot row drops it');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. the flag clears on the next dispatch -----------------------------------------------------

test('deployFailed clears on the craft’s next dispatch — and the kit aboard can be sent again', () => {
  const first = occupiedRun(6);
  const failed = tickToIdle(first.s);
  assert.equal(craftOf(failed).deployFailed.reason, 'occupied');

  // A plain dispatch home clears it.
  const home = accept(failed, createDispatchVehicleAction({ guildId: 'g1', vehicleId: craftOf(failed).id, waypoints: [AT_HOME] }));
  assert.equal(craftOf(home).deployFailed, undefined);

  // So does an actioned dispatch — here, a fresh deploy to a free hex, which now succeeds with the same kit.
  const retry = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  let s = accept(failed, dispatch(failed, deployTo(retry)));
  assert.equal(craftOf(s).deployFailed, undefined);
  s = tickToIdle(s);
  assert.equal(craftOf(s).deployFailed, undefined);
  assert.equal(craftOf(s).cargo, undefined);
  assert.deepEqual(s.outposts.map((o) => [o.id, o.coords]), [['outpost_g2_01', first.target], ['outpost_g1_01', retry]]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 6. the dispatch gates -----------------------------------------------------------------------

test('dispatch gates: a deploy rides the FINAL waypoint only', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  const s = kitAt(AT_HOME);
  const reason = refuse(s, dispatch(s, [{ anchor: target, action: DEPLOY }, { anchor: AT_HOME }]));
  assert.match(reason, /waypoint 0 carries a deploy action, but a deploy rides the FINAL waypoint only/);
});

test('dispatch gates: never on a repeating lane (a kit never automates)', () => {
  const dir = freeDirection(HOME_HEX, [1, 2]);
  const s = kitAt(AT_HOME);
  for (const repeat of [{ mode: 'continuous' }, { mode: 'nRun', n: 2 }]) {
    const reason = refuse(s, dispatch(s, [{ anchor: along(HOME_HEX, dir, 1) }, { anchor: along(HOME_HEX, dir, 2), action: DEPLOY }], { repeat }));
    assert.match(reason, /never rides a repeating lane/, repeat.mode);
  }
});

test('dispatch gates: the craft must carry exactly the kit the kind names, and nothing else', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  const empty = deployState();
  assert.match(refuse(empty, dispatch(empty, deployTo(target))), /the deploy at waypoint 0 would fail now — .*must carry exactly one outpost_kit and nothing else/);
  let ore = deployState();
  ore.guilds[0].stockpiles = { [HOME.id]: { titanium: 5 } };
  ore = accept(ore, createTransferCargoAction({ guildId: 'g1', vehicleId: craftOf(ore).id, manifest: [{ dir: 'load', good: 'titanium', qty: 5 }] }));
  assert.match(refuse(ore, dispatch(ore, deployTo(target))), /must carry exactly one outpost_kit/);
  const light = deployState({ vehicleClass: LIGHT_TRANSPORT });
  assert.match(refuse(light, dispatch(light, deployTo(target))), /must carry exactly one outpost_kit/);
  const spy = deployState({ vehicleClass: SPYCRAFT });
  assert.match(refuse(spy, dispatch(spy, deployTo(target))), /carries no cargo \(capacity 0\)/);
  const s = kitAt(AT_HOME);
  assert.match(refuse(s, dispatch(s, [{ anchor: target, action: { type: 'deploy', kind: 'tollGate' } }])), /waypoint 0 deploy action: "tollGate" is not a deployable kind with a kit/);
  assert.match(refuse(s, dispatch(s, [{ anchor: target, action: { type: 'deploy' } }])), /not a deployable kind with a kit/);
});

// A free hex right beside home.
const freeHexNear = () => along(HOME_HEX, freeDirection(HOME_HEX, [1]), 1);

test('dispatch gates: the target must be a bare hex, not a landmark', () => {
  const s = kitAt(freeHexNear());
  assert.match(refuse(s, dispatch(s, deployTo(AT_HOME))), /the deploy waypoint 0 is a landmark .* an Outpost deploys on a bare hex/);
  assert.match(refuse(s, dispatch(s, deployTo({ landmarkKind: 'outpost', landmarkId: HOME.waystation }))), /is a landmark/);
});

test('dispatch gates: a target already occupied, or out of range, NOW is refused up front', () => {
  const s = kitAt(AT_HOME);
  // A bare hex on the home system's own tile is taken by the system.
  assert.match(refuse(s, dispatch(s, deployTo({ q: HOME_HEX.q, r: HOME_HEX.r }))), new RegExp(`would fail now — hex .* is already occupied by system "${HOME.id}"`));
  const taken = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  const withRival = occupy(s, taken);
  assert.match(refuse(withRival, dispatch(withRival, deployTo(taken))), /would fail now — .*occupied by outpost "outpost_g2_01"/);
  const far = along(HOME_HEX, freeDirection(HOME_HEX, [OUTPOST_DEPLOY_RANGE + 1]), OUTPOST_DEPLOY_RANGE + 1);
  assert.match(refuse(s, dispatch(s, deployTo(far))), new RegExp(`would fail now — .*is ${OUTPOST_DEPLOY_RANGE + 1} hexes from the nearest system guild "g1" holds`));
  // Exactly at the range is fine.
  const edge = along(HOME_HEX, freeDirection(HOME_HEX, [OUTPOST_DEPLOY_RANGE]), OUTPOST_DEPLOY_RANGE);
  accept(s, dispatch(s, deployTo(edge)));
});

test('a saved route never carries a deploy — saveRoute keeps its dock-only gate', () => {
  const s = deployState();
  const reason = refuse(s, createSaveRouteAction({ guildId: 'g1', name: 'Plant', waypoints: deployTo(freeHexNear()) }));
  assert.match(reason, /the only action type a saved route carries is "dock"/);
});

// --- 7. determinism -----------------------------------------------------------------------------

test('determinism: the retreat snap replays byte-identically across a save/restore', () => {
  const direct = tickToIdle(occupiedRun(7).s);

  // (a) Saved MID-FLIGHT and restored: the rest of the flight and the retreat land on the same bytes.
  let mid = occupiedRun(7).s;
  for (let i = 0; i < 100; i += 1) mid = tick(mid, []);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-deploy2-'));
  try {
    saveState(mid, dirA);
    const restored = loadOrInit(dirA, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(tickToIdle(restored)), hashState(direct));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
  }

  // (b) The dispatch and the rival's Outpost JOURNALLED against a saved start, replayed on restore.
  const dir = freeDirection(HOME_HEX, [7, 8, 4]);
  const target = along(HOME_HEX, dir, 7);
  const start = kitAt(along(HOME_HEX, dir, 8));
  const actions = [
    dispatch(start, deployTo(target)),
    createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: target }),
  ];
  let live = start;
  for (const a of actions) live = accept(live, a);
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-deploy2-'));
  try {
    saveState(start, dirB);
    for (const a of actions) appendJournal(start.tick, a, dirB);
    const restored = loadOrInit(dirB, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(live));
    const a = tickToIdle(live);
    const b = tickToIdle(restored);
    assert.equal(hashState(a), hashState(b));
    assert.deepEqual(craftOf(b).location, along(HOME_HEX, dir, 4));
    assert.equal(craftOf(b).deployFailed.reason, 'occupied');
  } finally {
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

// --- the off-the-lattice fallback (provisional — decision checklist) -------------------------------

// A held system S and a free, in-range target T for which the 3-hex step toward S lands OUTSIDE the
// galaxy — it happens only near the rim (e.g. the live seed's sys_0959, T (−150,−30): the raw step is
// (−152,−27), off the lattice). Found by a fixed-order scan, so a regen carries the test.
function offLatticeCase() {
  const systems = [...seed.systems].sort((a, b) => a.id.localeCompare(b.id));
  for (const sys of systems) {
    const S = sys.coords;
    for (let q = S.q - OUTPOST_DEPLOY_RANGE; q <= S.q + OUTPOST_DEPLOY_RANGE; q += 1) {
      for (let r = S.r - OUTPOST_DEPLOY_RANGE; r <= S.r + OUTPOST_DEPLOY_RANGE; r += 1) {
        const T = { q, r };
        const d = hexDistance(T, S);
        if (d <= DEPLOY_RETREAT_HEXES || d > OUTPOST_DEPLOY_RANGE || !isFree(T)) continue;
        const step = hexStepToward(T, S, DEPLOY_RETREAT_HEXES).hex;
        if (isHexInBounds(step.q, step.r)) continue;
        const from = DIRS.map((dir) => along(T, dir, 1)).find(isFree); // where the heavy starts, one hex off
        if (from) return { systemId: sys.id, S, T, from };
      }
    }
  }
  throw new Error('no off-lattice retreat case on this seed');
}

test('off the lattice: a retreat step outside the galaxy walks on along the same line to the first hex inside', () => {
  const { systemId, S, T, from } = offLatticeCase();
  // A guild holding only that rim system (no home claim needed for the rule itself).
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 10_000 }, { id: 'g2', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, claims: [claimOf('g1', systemId, 1)],
  });
  // The kit loads at the rim system itself (same-system), then the laden heavy is placed one hex off T.
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: { landmarkKind: 'system', landmarkId: systemId } }));
  s = placeCraft(withKit(s), 'g1', craftOf(s).id, from);
  s = accept(s, dispatch(s, deployTo(T)));
  s = accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: systemId, coords: T }));
  s = tickToIdle(s);
  const landed = craftOf(s).location;
  // The expected landing, walked by hand: step 3, 4, … along T → S until the hex is inside the galaxy.
  let n = DEPLOY_RETREAT_HEXES;
  while (!isHexInBounds(hexStepToward(T, S, n).hex.q, hexStepToward(T, S, n).hex.r)) n += 1;
  assert.ok(n > DEPLOY_RETREAT_HEXES && n < hexDistance(T, S), 'it stepped past the off-lattice hex and stopped short of S');
  assert.deepEqual(landed, hexStepToward(T, S, n).hex);
  assert.ok(isHexInBounds(landed.q, landed.r), 'the craft is inside the galaxy');
  assert.equal(hexDistance(T, landed) + hexDistance(landed, S), hexDistance(T, S), 'on the straight line, toward S');
  assert.equal(craftOf(s).deployFailed.reason, 'occupied');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- a failure the dispatch rules out halts loudly -------------------------------------------------

test('halt, not guess: a kit lost in flight, or a guild holding no system at all, stops the tick loudly', () => {
  const dir = freeDirection(HOME_HEX, [2, 3]);
  const target = along(HOME_HEX, dir, 2);
  const launch = () => {
    const s = kitAt(along(HOME_HEX, dir, 3));
    return accept(s, dispatch(s, deployTo(target)));
  };
  const noKit = launch();
  delete craftOf(noKit).cargo; // corruption: the dispatch proved the kit, and nothing in flight removes it
  assert.throws(() => tickToIdle(noKit), /deploy on arrival, tick \d+: guild "g1" vehicle "vehicle_g1_heavyTransport_01" failed the "kit" check/);
  const noSystem = launch();
  noSystem.claims = []; // corruption: a guild never loses its home system
  assert.throws(() => tickToIdle(noSystem), /deploy on arrival, tick \d+: .* failed the "no-held-system" check/);
});

// --- the invariant shape checks ------------------------------------------------------------------

test('invariants: deployFailed must be { known reason, whole tick <= now } on a craft with no route', () => {
  const s = tickToIdle(occupiedRun(5).s);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const rules = (mutate) => {
    const bad = JSON.parse(JSON.stringify(s));
    mutate(bad.guilds[0].vehicles[0]);
    return checkInvariants(bad, bad.tick).map((v) => v.rule);
  };
  // 'not-attached' joined 2.5 (b1): the Deep Scan Array's retreatable placement failure.
  assert.deepEqual(DEPLOY_FAILED_REASONS, ['occupied', 'out-of-range', 'not-attached']);
  assert.ok(rules((v) => { v.deployFailed.reason = 'bad-luck'; }).includes('vehicle-deploy-failed-valid'));
  assert.ok(rules((v) => { v.deployFailed.tick = 1.5; }).includes('vehicle-deploy-failed-valid'));
  assert.ok(rules((v) => { v.deployFailed.tick = s.tick + 1; }).includes('vehicle-deploy-failed-valid'), 'not in the future');
  assert.ok(rules((v) => { v.route = { waypoints: [{ anchor: AT_HOME }], cursor: 0 }; }).includes('vehicle-deploy-failed-no-route'));
});

test('invariants: a craft route’s deploy action must be last, on a bare hex, on a one-shot route', () => {
  const dir = freeDirection(HOME_HEX, [1, 2]);
  const hexA = along(HOME_HEX, dir, 1);
  const hexB = along(HOME_HEX, dir, 2);
  const parked = kitAt(AT_HOME);
  const flying = accept(parked, dispatch(parked, deployTo(hexB)));
  assert.deepEqual(checkInvariants(flying, flying.tick), []);
  const routeRule = (route) => {
    const bad = JSON.parse(JSON.stringify(flying));
    bad.guilds[0].vehicles[0].route = route;
    return checkInvariants(bad, bad.tick).filter((v) => v.rule === 'vehicle-route-valid').map((v) => v.detail.reason);
  };
  assert.match(routeRule({ waypoints: [{ anchor: hexA, action: DEPLOY }, { anchor: hexB }], cursor: 0 })[0], /final waypoint only/);
  assert.match(routeRule({ waypoints: [{ anchor: AT_HOME, action: DEPLOY }], cursor: 0 })[0], /must be a bare hex/);
  assert.match(routeRule({ waypoints: [{ anchor: hexA }, { anchor: hexB, action: DEPLOY }], cursor: 0, mode: 'continuous', lapsDone: 0 })[0], /one-shot route only/);
  assert.match(routeRule({ waypoints: [{ anchor: hexB, action: { type: 'deploy', kind: 'tollGate' } }], cursor: 0 })[0], /deployable kind/);
  // A SAVED route never carries a deploy — its integrity check keeps the dock-only shape.
  const saved = JSON.parse(JSON.stringify(flying));
  saved.guilds[0].savedRoutes = [{ id: 'route_g1_01', name: 'Plant', waypoints: deployTo(hexB), updatedAtTick: 0 }];
  saved.guilds[0].savedRouteSerial = 1;
  const savedRules = checkInvariants(saved, saved.tick).filter((v) => v.rule === 'saved-route-waypoints-valid (§11.1)');
  assert.equal(savedRules.length, 1, 'a saved deploy trips');
  assert.match(savedRules[0].detail.reason, /must be a \{ type: "dock", manifest \}/);
});

test('snapshot: a craft flying to deploy shows the deploy action on its route', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [2]), 2);
  const parked = kitAt(AT_HOME);
  const s = accept(parked, dispatch(parked, deployTo(target)));
  const row = buildSnapshot(s).guilds[0].vehicles[0];
  assert.deepEqual(row.route.waypoints, [{ anchor: target, action: DEPLOY }]);
  assert.equal(row.deployFailed, undefined);
});

// --- the no-op: no deploy action, nothing new ------------------------------------------------------

test('no-op: routes with no deploy action never take the deploy branch — no flag, no Outpost', () => {
  const dir = freeDirection(HOME_HEX, [1, 2]);
  let s = deployState();
  s.guilds[0].stockpiles = { [HOME.id]: { titanium: 5 } };
  s = accept(s, dispatch(s, [
    { anchor: AT_HOME, action: { type: 'dock', manifest: [{ dir: 'load', good: 'titanium', qty: 5 }] } },
    { anchor: along(HOME_HEX, dir, 1) },
    { anchor: along(HOME_HEX, dir, 2) },
  ]));
  s = tickToIdle(s);
  assert.equal('deployFailed' in craftOf(s), false);
  assert.equal(s.outposts, undefined);
  assert.deepEqual(craftOf(s).cargo, { titanium: 5 });
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
