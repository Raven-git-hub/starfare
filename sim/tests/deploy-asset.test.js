'use strict';

// deploy-asset.test.js — the deploy pipeline slice 1, roadmap 2.2 (docs/territory-model.md §5 — "haul
// a Tier-4 kit on a transport to a target, and place it on arrival"). The engine action under test:
//   - deployAsset — a craft idle at a bare hex places the Outpost its kit packs, consuming the kit.
//
// HOW A KIT GETS ABOARD (02-10-26, the asset-initiated redesign — design.md §4): the kit is first an idle
// asset in a system's inventory (grantKit), then loaded onto an empty heavy in that system (loadKit) —
// kit-fixtures.js `kitAboard`. Those two actions and all their gates are tested in kit-asset.test.js; the
// grantKit-straight-into-a-hold tests that used to open this file retired with that lever. The deploy
// itself is UNCHANGED, and these tests prove it still works end to end through the new model.
//
// The tripwires for a kit aboard a heavy:
//   - A FULL HOLD: a heavy holding a kit has no room left, so a load at its system moves nothing;
//   - NEVER A LANE: a kit-laden craft may fly a ONE-SHOT route (that is how a kit reaches its target)
//     but may not launch a REPEATING lane.
//
// The tripwires for deployAsset:
//   - HAPPY PATH: grant + load a kit, dispatch the heavy, fly it to a bare hex, deploy -> an Outpost at
//     that hex (the `outpost_<guild>_NN` id, anchored to the held system), the hold emptied, and no
//     credits / fuel / supply moved;
//   - RANGE: exactly OUTPOST_DEPLOY_RANGE (10) hexes from a held system deploys; one further is refused;
//     a guild holding no system is refused; only the guild's OWN held systems count;
//   - ANCHOR: the nearest held system anchors the Outpost; an exact tie goes to the lower system id;
//   - LOCATION + OCCUPANCY: a craft berthed at a system or waystation landmark, or on a hex already
//     holding a system or an Outpost, is refused; so is a craft in transit, in a dock slot, or on a lane;
//   - THE KIT: no kit, or a hold of anything but exactly one kit, is refused; so is another guild's craft;
//   - IDS: a second deploy mints `_02`; after a teardown the next deploy never reuses a number;
//   - DETERMINISM (invariant 9): grant -> load -> dispatch -> deploy run twice is byte-identical, and the
//     grant, load and dispatch journalled against a SAVED state replay to the same bytes on restore.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { usedSpace } = require('../manifest.js');
const { OUTPOST_KIT } = require('../resources.js');
const { hexDistance } = require('../transport.js');
const {
  getSystem, isHexInBounds, seedLandmarkAtHex, getStarterSystems, getTerranHomeworld,
} = require('../seed.js');
const { OUTPOST_DEPLOY_RANGE, OUTPOST_CAPACITY, OUTPOST_DOCK_SLOTS } = require('../outposts.js');
const seed = require('../../data/seed.json');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createGrantKitAction, createLoadKitAction, createTransferCargoAction,
  createDispatchRouteWithActionsAction, createDispatchVehicleAction, createDeployAssetAction,
  createSpawnOutpostAction, createRemoveOutpostAction,
} = require('../actions.js');

const HOME = starterHomeAtDistance(6); // a real starter system the guild holds
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;

// freeHexAtDistance(d, from) -> the first in-bounds hex EXACTLY `d` hexes from `from` that holds no seed
// landmark, in a fixed scan order. DERIVED from the seed (the outposts.test.js discipline), so a regen
// carries the tests instead of breaking them. `skip` lets a caller ask for a second, different one.
function freeHexAtDistance(d, from = HOME_HEX, skip = 0) {
  let seen = 0;
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      const hex = { q, r };
      if (hexDistance(hex, from) !== d || !isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      if (seen === skip) return hex;
      seen += 1;
    }
  }
  throw new Error(`no free hex at distance ${d} from ${JSON.stringify(from)} on this seed`);
}

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
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

// A guild that HOLDS its home system (the claim row + home fields), with one idle craft of
// `vehicleClass` at `location` and `fuelHoard` fuel. The ledger is balanced so the state opens clean.
// `extraGuilds` / `extraClaims` add rivals and further held systems for the range and anchor tests.
function deployState({
  vehicleClass = HEAVY_TRANSPORT, location = AT_HOME, fuelHoard = 0, pool = {},
  extraGuilds = [], extraClaims = [],
} = {}) {
  const guild = {
    id: 'g1', credits: 0, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet,
  };
  if (Object.keys(pool).length) guild.stockpiles = { [HOME.id]: { ...pool } };
  let s = createState({
    guilds: [guild, ...extraGuilds],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [homeClaim('g1', HOME.id), ...extraClaims],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location }));
  return s;
}
const craftOf = (s) => s.guilds[0].vehicles[0];
// The kit, the asset-initiated way: granted into the home system's inventory and loaded onto the heavy
// berthed there (kit-fixtures.js). The heavy must be at home, idle and empty.
const withKit = (s) => kitAboard(s, 'g1', craftOf(s).id);

// --- a kit aboard: the hold is full ------------------------------------------------------------------

test('a heavy holding a kit has an otherwise-full hold — a load at its system moves nothing', () => {
  let s = withKit(deployState({ pool: { titanium: 50 } }));
  assert.equal(usedSpace(craftOf(s).cargo), craftOf(s).capacity, 'the kit alone fills the hold');
  // The transfer is ACCEPTED (well-formed) but clamps to zero: there is no room (partial-safe, §4).
  s = accept(s, createTransferCargoAction({
    guildId: 'g1', vehicleId: craftOf(s).id, manifest: [{ dir: 'load', good: 'titanium', max: true }],
  }));
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 }, 'nothing loaded beside the kit');
  assert.equal(s.guilds[0].stockpiles[HOME.id].titanium, 50, 'the pool kept everything');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- never a lane: a kit rides a one-shot route, never a repeating one -----------------------------

test('never a lane: a kit-laden heavy may fly a one-shot route but not launch a repeating lane', () => {
  const near = freeHexAtDistance(1);
  const s = withKit(deployState({ fuelHoard: 10_000 }));
  const route = (repeat) => createDispatchRouteWithActionsAction({
    guildId: 'g1',
    vehicleId: craftOf(s).id,
    waypoints: [{ anchor: near }, { anchor: AT_HOME }],
    ...(repeat ? { repeat } : {}),
  });
  for (const repeat of [{ mode: 'continuous' }, { mode: 'nRun', n: 2 }]) {
    assert.match(refuse(s, route(repeat)), /never rides a repeating lane/, `${repeat.mode}: refused`);
  }
  // The one-shot is fine: that is how a kit reaches the hex it deploys on.
  const flying = accept(s, route({ mode: 'once' }));
  assert.equal(craftOf(flying).status, 'inTransit');
  assert.deepEqual(craftOf(flying).cargo, { [OUTPOST_KIT]: 1 }, 'the kit rides along');
  // And without a kit the same lane launches — the gate is about the kit, not the lane.
  const empty = deployState({ fuelHoard: 10_000 });
  accept(empty, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: craftOf(empty).id,
    waypoints: [{ anchor: near }, { anchor: AT_HOME }], repeat: { mode: 'continuous' },
  }));
});

// --- deployAsset: fixtures -----------------------------------------------------------------------

// A heavy idle at `location` with one outpost kit aboard. The kit is granted and loaded at home through
// the real actions, then the laden craft is PLACED at `location` — the stand-in for a flight (a real one
// is 225 ticks a hex; `flyKitTo` below flies one). The deploy rule reads only where it sits and what it holds.
function kitAt(location, opts = {}) {
  const s = withKit(deployState(opts));
  return placeCraft(s, 'g1', craftOf(s).id, location);
}
const deploy = (s, over = {}) => createDeployAssetAction({ guildId: 'g1', vehicleId: craftOf(s).id, ...over });
const claimOf = (guildId, systemId, n) => ({
  claimId: `claim_${guildId}_${n}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

// The first free hex within deploy range of home that satisfies `pred`, in a fixed scan order.
function freeHexNearHomeWhere(pred) {
  const d = OUTPOST_DEPLOY_RANGE;
  for (let q = HOME_HEX.q - d; q <= HOME_HEX.q + d; q += 1) {
    for (let r = HOME_HEX.r - d; r <= HOME_HEX.r + d; r += 1) {
      const hex = { q, r };
      if (hexDistance(hex, HOME_HEX) > d || !isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      if (pred(hex)) return hex;
    }
  }
  throw new Error('no free hex near home matches');
}

// A heavy flown for real: a kit granted and loaded at home, dispatched to `target`, ticked until it lands idle.
function flyKitTo(target) {
  let s = withKit(deployState({ fuelHoard: 10_000 }));
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: craftOf(s).id, waypoints: [target] }));
  while (craftOf(s).status !== 'idle') s = tick(s, []);
  return s;
}

// --- deployAsset: the happy path -----------------------------------------------------------------

test('deploy happy path: grant + load, dispatch, arrive at a bare hex, deploy -> an Outpost there, the hold empty', () => {
  const target = freeHexAtDistance(1);
  let s = flyKitTo(target);
  assert.deepEqual(craftOf(s).location, target, 'arrived idle at the bare hex');
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 }, 'the kit rode along');

  const before = s;
  s = accept(s, deploy(s));
  assert.equal(s.outposts.length, 1);
  const o = s.outposts[0];
  assert.equal(o.id, 'outpost_g1_01', 'the outpost_<guild>_NN id spawnOutpost mints');
  assert.equal(o.ownerGuildId, 'g1');
  assert.deepEqual(o.coords, target);
  assert.equal(o.anchorSystemId, HOME.id, 'anchored to the system the guild holds');
  assert.equal(o.capacity, OUTPOST_CAPACITY);
  assert.equal(o.dockCapacity, OUTPOST_DOCK_SLOTS);
  assert.equal(o.createdAtTick, s.tick, 'records its tick (§15.2)');
  assert.equal(s.guilds[0].outpostSerial, 1);
  // The kit is consumed: the hold key is gone (omit-when-empty); the craft is idle where it stood.
  assert.equal(craftOf(s).cargo, undefined);
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, target);
  assert.equal(craftOf(s).updatedAtTick, s.tick);
  // Nothing else moved: the kit was off-market and off-supply, and an Outpost is not a good.
  assert.equal(s.guilds[0].credits, before.guilds[0].credits);
  assert.equal(s.guilds[0].fuelHoard, before.guilds[0].fuelHoard);
  assert.equal(s.syndicate.ledger, before.syndicate.ledger);
  assert.deepEqual(computeGalacticSupply(s), computeGalacticSupply(before));
  assert.deepEqual(s.galacticSupply, before.galacticSupply, 'the supply cache needed no refresh');
  assert.deepEqual(s.prices, before.prices);
  assert.deepEqual(s.claims, before.claims, 'no claim row is written (the control layer is a later slice)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // And the galaxy ticks on cleanly with the new Outpost in it.
  s = tick(s, []);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('deploy snapshot: the Outpost row appears; the craft reads as parked at it with an empty hold', () => {
  let s = kitAt(freeHexAtDistance(2));
  s = accept(s, deploy(s));
  const snap = buildSnapshot(s);
  assert.equal(snap.outposts.length, 1);
  assert.equal(snap.outposts[0].id, 'outpost_g1_01');
  assert.equal(snap.outposts[0].anchorSystemId, HOME.id);
  const row = snap.guilds[0].vehicles[0];
  assert.deepEqual(row.cargo, {});
  assert.equal(row.used, 0);
  assert.deepEqual(row.dockStatus, { state: 'parked', outpostId: 'outpost_g1_01' });
});

// --- deployAsset: the range ----------------------------------------------------------------------

test('range: exactly OUTPOST_DEPLOY_RANGE hexes from a held system deploys; one hex further is refused', () => {
  assert.equal(OUTPOST_DEPLOY_RANGE, 10, 'the ruled [FIRST-CUT] (phase-1-tuning.md "Territory & deployment")');
  let edge = kitAt(freeHexAtDistance(OUTPOST_DEPLOY_RANGE));
  edge = accept(edge, deploy(edge));
  assert.equal(edge.outposts[0].anchorSystemId, HOME.id);
  assert.deepEqual(checkInvariants(edge, edge.tick), []);

  const beyond = kitAt(freeHexAtDistance(OUTPOST_DEPLOY_RANGE + 1));
  const reason = refuse(beyond, deploy(beyond));
  assert.match(reason, new RegExp(`is ${OUTPOST_DEPLOY_RANGE + 1} hexes from the nearest system guild "g1" holds \\(${HOME.id}\\)`));
  assert.match(reason, new RegExp(`an Outpost deploys within ${OUTPOST_DEPLOY_RANGE}$`));
});

test('range: a guild that holds no system cannot deploy', () => {
  let s = createState({ guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  // The kit loads at the (unheld) home system — loading needs the same system, not a held one — then the
  // laden craft is placed on a bare hex beside it.
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  s = placeCraft(withKit(s), 'g1', craftOf(s).id, freeHexAtDistance(1));
  assert.match(refuse(s, deploy(s)), /holds no system/);
});

test("range: only the guild's OWN held systems count — a rival's system next door does not", () => {
  // A starter system well out of home's range, and a free hex right beside it.
  const rival = getStarterSystems().map((sys) => sys.id)
    .find((id) => hexDistance(getSystem(id).coords, HOME_HEX) > 2 * OUTPOST_DEPLOY_RANGE);
  const besideRival = freeHexAtDistance(1, getSystem(rival).coords);
  // g2 holds it: g1's craft beside it is out of g1's range.
  const g2 = { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: rival, homePlanetId: getTerranHomeworld(rival) };
  const held = kitAt(besideRival, { extraGuilds: [g2], extraClaims: [homeClaim('g2', rival)] });
  assert.match(refuse(held, deploy(held)), /hexes from the nearest system guild "g1" holds/);
  // Were g1 to hold that system itself, the same deploy goes through, anchored there.
  let own = kitAt(besideRival, { extraClaims: [claimOf('g1', rival, 2)] });
  own = accept(own, deploy(own));
  assert.equal(own.outposts[0].anchorSystemId, rival);
  assert.deepEqual(checkInvariants(own, own.tick), []);
});

// --- deployAsset: the anchor ---------------------------------------------------------------------

test('anchor: the nearest held system anchors the Outpost; an exact tie goes to the lower system id', () => {
  // A second real system a few hexes from home (derived from the seed), held by g1 too.
  const second = seed.systems
    .filter((sys) => sys.id !== HOME.id && hexDistance(sys.coords, HOME_HEX) >= 4)
    .sort((a, b) => hexDistance(a.coords, HOME_HEX) - hexDistance(b.coords, HOME_HEX) || a.id.localeCompare(b.id))[0];
  const both = { extraClaims: [claimOf('g1', second.id, 2)] };

  // Beside the second system: it is the nearer, so it anchors.
  const besideSecond = freeHexAtDistance(1, second.coords);
  assert.ok(hexDistance(besideSecond, HOME_HEX) > 1, 'the hex really is nearer the second system');
  let near = kitAt(besideSecond, both);
  near = accept(near, deploy(near));
  assert.equal(near.outposts[0].anchorSystemId, second.id);

  // Equidistant from both: the lower id wins, whichever of the two that is.
  const tie = freeHexNearHomeWhere((h) => hexDistance(h, HOME_HEX) === hexDistance(h, second.coords));
  let tied = kitAt(tie, both);
  tied = accept(tied, deploy(tied));
  assert.equal(tied.outposts[0].anchorSystemId, [HOME.id, second.id].sort()[0]);
  assert.deepEqual(checkInvariants(tied, tied.tick), []);
});

// --- deployAsset: location and occupancy ---------------------------------------------------------

test('location: a craft berthed at a system or a waystation landmark is refused — an Outpost goes on open ground', () => {
  const atSystem = kitAt(AT_HOME);
  assert.match(refuse(atSystem, deploy(atSystem)), /berthed at a landmark .* deploys on a bare hex/);
  const atWaystation = kitAt({ landmarkKind: 'outpost', landmarkId: HOME.waystation });
  assert.match(refuse(atWaystation, deploy(atWaystation)), /berthed at a landmark/);
});

test('occupancy: a bare-hex craft on a hex already holding a system or an Outpost is refused', () => {
  const onSystemHex = kitAt({ q: HOME_HEX.q, r: HOME_HEX.r });
  assert.match(refuse(onSystemHex, deploy(onSystemHex)), new RegExp(`occupied by system "${HOME.id}" — one structure per hex`));
  // A craft parked at a guild Outpost sits on that Outpost's hex.
  const hex = freeHexAtDistance(2);
  let parked = kitAt(hex);
  parked = accept(parked, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: hex }));
  assert.match(refuse(parked, deploy(parked)), /occupied by outpost "outpost_g1_01" — one structure per hex/);
});

test('status gates: a craft in transit, in a dock slot, or on a lane is refused', () => {
  let flying = withKit(deployState({ fuelHoard: 10_000 }));
  flying = accept(flying, createDispatchVehicleAction({ guildId: 'g1', vehicleId: craftOf(flying).id, waypoints: [freeHexAtDistance(1)] }));
  assert.match(refuse(flying, deploy(flying)), /is not idle \(status "inTransit"\)/);

  const loading = kitAt(freeHexAtDistance(1));
  craftOf(loading).status = 'loading';
  assert.match(refuse(loading, deploy(loading)), /is not idle \(status "loading"\)/);

  const laned = kitAt(freeHexAtDistance(1));
  craftOf(laned).route = { waypoints: [{ anchor: AT_HOME }], cursor: 0 };
  assert.match(refuse(laned, deploy(laned)), /running a lane/);
});

// --- deployAsset: the kit and the owner ----------------------------------------------------------

test('kit gates: no kit, or anything but exactly one kit, is refused; so is an unknown or rival guild', () => {
  const hex = freeHexAtDistance(1);
  const empty = deployState({ location: hex });
  assert.match(refuse(empty, deploy(empty)), /must carry exactly one outpost_kit and nothing else/);

  const titanium = deployState({ location: hex });
  craftOf(titanium).cargo = { titanium: 5 };
  assert.match(refuse(titanium, deploy(titanium)), /exactly one outpost_kit/);

  const mixed = kitAt(hex);
  craftOf(mixed).cargo.titanium = 1; // a corrupt (over-capacity) hold: the gate still refuses it
  assert.match(refuse(mixed, deploy(mixed)), /exactly one outpost_kit/);

  const s = kitAt(hex);
  assert.match(refuse(s, deploy(s, { guildId: 'nobody' })), /no guild with id/);
  assert.match(refuse(s, deploy(s, { vehicleId: 'vehicle_g1_heavyTransport_99' })), /owns no vehicle/);
  const withRival = kitAt(hex, { extraGuilds: [{ id: 'g2', credits: 0, fuelHoard: 0 }] });
  assert.match(refuse(withRival, deploy(withRival, { guildId: 'g2' })), /guild "g2" owns no vehicle/);
});

// --- deployAsset: stable ids ---------------------------------------------------------------------

test('ids: deploy and spawn share one per-guild serial, and a torn-down number is never reissued', () => {
  const hex = freeHexAtDistance(1);
  let s = kitAt(hex);
  s = accept(s, deploy(s));
  assert.equal(s.outposts[0].id, 'outpost_g1_01');
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.equal(s.outposts, undefined);
  // The craft still sits on the now-bare hex: re-kit it at home and deploy on the same hex again.
  const vid = craftOf(s).id;
  s = placeCraft(withKit(placeCraft(s, 'g1', vid, AT_HOME)), 'g1', vid, hex);
  s = accept(s, deploy(s));
  assert.equal(s.outposts[0].id, 'outpost_g1_02', 'the torn-down 01 is never reissued');
  // The operator's spawn draws from the SAME serial.
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: freeHexAtDistance(2) }));
  assert.equal(s.outposts[1].id, 'outpost_g1_03');
  assert.equal(s.guilds[0].outpostSerial, 3);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- deployAsset: determinism (invariant 9) ------------------------------------------------------

test('determinism: grant -> load -> dispatch -> deploy, run twice, is byte-identical', () => {
  const run = () => {
    const s = flyKitTo(freeHexAtDistance(1));
    return accept(s, deploy(s));
  };
  assert.equal(hashState(run()), hashState(run()));
});

test('determinism: the grant, load and dispatch, journalled against a SAVED state, replay to the same bytes', () => {
  const target = freeHexAtDistance(1);
  const start = deployState({ fuelHoard: 10_000 });
  const vid = craftOf(start).id;
  const actions = [
    createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'outpost' }),
    createLoadKitAction({ guildId: 'g1', vehicleId: vid, assetId: 'asset_g1_outpost_01' }),
    createDispatchVehicleAction({ guildId: 'g1', vehicleId: vid, waypoints: [target] }),
  ];
  let direct = start;
  for (const a of actions) direct = accept(direct, a);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-deploy-'));
  try {
    saveState(start, dir);
    for (const a of actions) appendJournal(start.tick, a, dir);
    let restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(direct));
    // Both fly the rest of the way and deploy on arrival at the same bytes.
    const land = (s) => { while (craftOf(s).status !== 'idle') s = tick(s, []); return accept(s, deploy(s)); };
    direct = land(direct);
    restored = land(restored);
    assert.equal(hashState(restored), hashState(direct));
    assert.equal(restored.outposts[0].id, 'outpost_g1_01');
    assert.equal(restored.guilds[0].vehicles[0].cargo, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
