'use strict';

// deploy-asset.test.js — the deploy pipeline slice 1, roadmap 2.2 (docs/territory-model.md §5 — "haul
// a Tier-4 kit on a transport to a target, and place it on arrival"). Two engine actions:
//   - grantKit    — the operator mints one deployable kit straight into a craft's hold (the test seam;
//                   the real kit sources are later slices);
//   - deployAsset — a craft idle at a bare hex places the Outpost its kit packs, consuming the kit.
//
// The tripwires for grantKit, one per ruling:
//   - GRANT: one kit lands in an empty heavy's hold, tick-stamped, moving no credits / fuel / supply;
//   - HEAVY-ONLY + ONE-AT-A-TIME, BY VOLUME: a light, a medium and a spycraft are refused as over
//     capacity; a heavy already holding a kit (or anything) is refused; a heavy holding a kit has a
//     full hold, so a load there moves nothing;
//   - the GATES: unknown guild / craft / kind, a craft in transit or in a dock slot, and a craft on a
//     lane (a deployable good never rides one) all refuse whole;
//   - NEVER A LANE: a kit-laden craft may fly a ONE-SHOT route (that is how a kit reaches its target)
//     but may not launch a REPEATING lane.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { usedSpace } = require('../manifest.js');
const { OUTPOST_KIT } = require('../resources.js');
const { hexDistance } = require('../transport.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  HEAVY_TRANSPORT, MEDIUM_TRANSPORT, LIGHT_TRANSPORT, SPYCRAFT,
} = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createGrantKitAction, createTransferCargoAction,
  createDispatchRouteWithActionsAction,
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
function deployState({ vehicleClass = HEAVY_TRANSPORT, location = AT_HOME, fuelHoard = 0, pool = {} } = {}) {
  const guild = {
    id: 'g1', credits: 0, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet,
  };
  if (Object.keys(pool).length) guild.stockpiles = { [HOME.id]: { ...pool } };
  let s = createState({
    guilds: [guild],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [homeClaim('g1', HOME.id)],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location }));
  return s;
}
const craftOf = (s) => s.guilds[0].vehicles[0];
const grant = (s, over = {}) => createGrantKitAction({ guildId: 'g1', vehicleId: craftOf(s).id, kind: 'outpost', ...over });

// --- grantKit: the mint --------------------------------------------------------------------------

test('grant: one outpost_kit lands in an empty heavy hold, tick-stamped, moving nothing else', () => {
  const before = deployState();
  const s = accept(before, grant(before));
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 });
  assert.equal(craftOf(s).updatedAtTick, s.tick, 'every mutation records its tick (§15.2)');
  assert.equal(craftOf(s).status, 'idle');
  // No credits, fuel or supply moved: a kit is off-market and off-supply.
  assert.equal(s.guilds[0].credits, before.guilds[0].credits);
  assert.equal(s.guilds[0].fuelHoard, before.guilds[0].fuelHoard);
  assert.deepEqual(computeGalacticSupply(s), computeGalacticSupply(before));
  assert.deepEqual(s.galacticSupply, before.galacticSupply, 'the cache needed no refresh');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- grantKit: heavy-only and one-at-a-time, both from the kit's volume ----------------------------

test('heavy-only: a light, a medium and a spycraft are refused — their hold is smaller than one kit', () => {
  for (const vehicleClass of [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, SPYCRAFT]) {
    const s = deployState({ vehicleClass });
    const reason = refuse(s, grant(s));
    assert.match(reason, /cargo space free/, `${vehicleClass}: refused on capacity`);
    assert.match(reason, /only an EMPTY heavy transport can carry one/);
  }
});

test('one-at-a-time: a second kit onto a heavy already holding one is refused', () => {
  let s = deployState();
  s = accept(s, grant(s));
  const reason = refuse(s, grant(s));
  assert.match(reason, /has 0 cargo space free/);
});

test('one-at-a-time: a heavy holding ANY cargo has no room for a kit', () => {
  let s = deployState({ pool: { titanium: 1 } });
  s = accept(s, createTransferCargoAction({
    guildId: 'g1', vehicleId: craftOf(s).id, manifest: [{ dir: 'load', good: 'titanium', qty: 1 }],
  }));
  assert.deepEqual(craftOf(s).cargo, { titanium: 1 });
  assert.match(refuse(s, grant(s)), /cargo space free/);
});

test('a heavy holding a kit has an otherwise-full hold — a load at its system moves nothing', () => {
  let s = deployState({ pool: { titanium: 50 } });
  s = accept(s, grant(s));
  assert.equal(usedSpace(craftOf(s).cargo), craftOf(s).capacity, 'the kit alone fills the hold');
  // The transfer is ACCEPTED (well-formed) but clamps to zero: there is no room (partial-safe, §4).
  s = accept(s, createTransferCargoAction({
    guildId: 'g1', vehicleId: craftOf(s).id, manifest: [{ dir: 'load', good: 'titanium', max: true }],
  }));
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 }, 'nothing loaded beside the kit');
  assert.equal(s.guilds[0].stockpiles[HOME.id].titanium, 50, 'the pool kept everything');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- grantKit: the gates -------------------------------------------------------------------------

test('grant gates: unknown guild, unknown craft and unknown kind are refused', () => {
  const s = deployState();
  assert.match(refuse(s, grant(s, { guildId: 'nobody' })), /no guild with id/);
  assert.match(refuse(s, grant(s, { vehicleId: 'vehicle_g1_heavyTransport_99' })), /owns no vehicle/);
  assert.match(refuse(s, grant(s, { kind: 'tollGate' })), /not a deployable kind with a kit/);
  assert.match(refuse(s, grant(s, { kind: 'outpost_kit' })), /not a deployable kind/, 'the kind, not the good id');
});

test('grant gates: a craft in transit or in a dock slot is refused — idle craft only', () => {
  for (const status of ['inTransit', 'loading']) {
    const s = deployState();
    craftOf(s).status = status;
    assert.match(refuse(s, grant(s)), /is not idle/);
  }
});

test('grant gates: a craft on a lane is refused — a deployable kit never rides a lane', () => {
  const s = deployState();
  // An idle craft holding a route is a lane WAITING at its last stop (§11.6) — idle, but lane-driven.
  craftOf(s).route = {
    waypoints: [{ anchor: AT_HOME }, { anchor: AT_HOME }],
    cursor: 1,
    mode: 'continuous',
    lapsDone: 1,
    waiting: { reason: 'fuel', sinceTick: 0 },
  };
  assert.match(refuse(s, grant(s)), /running a lane — a deployable kit never rides one/);
});

// --- never a lane: a kit rides a one-shot route, never a repeating one -----------------------------

test('never a lane: a kit-laden heavy may fly a one-shot route but not launch a repeating lane', () => {
  const near = freeHexAtDistance(1);
  let s = deployState({ fuelHoard: 10_000 });
  s = accept(s, grant(s));
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
